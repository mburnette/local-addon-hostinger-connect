'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalMain = require('@getflywheel/local/main');

const { IPC, HOSTINGER_SSH_PORT } = require('./constants');
const { HostingerApi } = require('./main/HostingerApi');
const { SyncService } = require('./main/SyncService');
const { SshKeyStore } = require('./main/sshKey');
const { Store } = require('./main/store');
const { findBundledBinDir, TransportError } = require('./main/transport');
const { Updater } = require('./main/updater');
const pkg = require('../package.json');

/** A hostname or IPv4 address. It may not start with "-" or ".", so it can never be read as an ssh option. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
/** An SSH/system username (u123456789, u123456789_abcDeFg). Same rule: it may not start with "-". */
const USERNAME_RE = /^[a-z0-9_][a-z0-9._-]*$/i;
/** Read at call time, so tests can simulate Windows. */
const isWindows = () => process.platform === 'win32';

function randomString(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
	const bytes = crypto.randomBytes(length);
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "https://example.com/path" or "user@example.com" -> "example.com". */
const cleanHost = (host) => String(host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^[^@]*@/, '').split(/[/:]/)[0];

/** A hostname as Hostinger lists it, lowercased, or null when it isn't one. */
const cleanDomain = (domain) => {
	const d = String(domain || '').trim().toLowerCase().replace(/\.+$/, '');
	return d && HOSTNAME_RE.test(d) ? d : null;
};

/** An absolute server path without trailing slashes. */
const trimPath = (p) => String(p || '').trim().replace(/\/+$/, '');

/** An absolute server path from the API, trimmed, or null when it is relative or has "." / ".." segments. */
const safeRoot = (p) => {
	const root = trimPath(p);
	return root.startsWith('/') && !root.split('/').some((part) => part === '.' || part === '..') ? root : null;
};

/**
 * "/wp/" -> "wp": a WordPress install's folder below its website's webroot ('' for the webroot itself). An absolute
 * server path inside `root` is made relative to it. Null when the folder can't be used safely ("." or ".." segments,
 * or a server path under /home outside the webroot).
 */
const cleanDirectory = (dir, root = null) => {
	let d = String(dir || '').trim();
	const base = trimPath(root);
	if (base && (d === base || d.startsWith(`${base}/`))) d = d.slice(base.length);
	else if (/^\/home\d*\//.test(d)) return null;
	d = d.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
	return d.split('/').some((part) => part === '.' || part === '..') ? null : d;
};

/** A list field from the API, or [] when it is missing or not a list. */
const arrayOf = (value) => (Array.isArray(value) ? value : []);

/**
 * A host the add-on can SSH to from this computer: not "localhost" or a loopback address, which a database listing
 * may give for connections made from the hosting server itself.
 */
const isRemoteHost = (host) => Boolean(host) && HOSTNAME_RE.test(host) && host.includes('.')
	&& !/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/i.test(host);

/** The www/non-www twin of a domain: example.com <-> www.example.com. */
const wwwTwin = (domain) => (domain.startsWith('www.') ? domain.slice(4) : `www.${domain}`);

/** Hostinger's SSH Access page, where keys are added and the SSH IP, port, username and password are shown. */
const SSH_ACCESS_PAGE = 'hPanel → Websites → Manage → Advanced → SSH Access';
/** Where an Agency Plan website keeps its SSH settings (the renderer names the same page). */
const AGENCY_SSH_PAGE = 'the website\'s Remote access page in hPanel';

/** The hPanel page that holds a link's SSH settings: the SSH Access page, or an Agency Plan website's Remote access page. */
const sshPageFor = (link) => (link && link.platform === 'agency' ? AGENCY_SSH_PAGE : SSH_ACCESS_PAGE);

/** An SSH login the server turned down (as opposed to a network error or a missing WordPress). */
const isAuthRefusal = (e) => e instanceof TransportError && (/refused the (SSH key|password)/.test(e.message)
	|| /Permission denied \((publickey|password|keyboard-interactive)|Permission denied, please try again/i.test(e.stderr || ''));

/** An SSH connection that never reached a login prompt: the port is closed, filtered or not answering. */
const isUnreachable = (e) => e instanceof TransportError && !isAuthRefusal(e)
	&& /Connection refused|timed out|Connection reset|Connection closed|No route to host/i.test(`${e.message}\n${e.stderr || ''}`);

/**
 * Adds a hint to a connection that could not be made, since SSH can be off for a website or missing from its plan.
 * The transport's own hint (which always names the shared-hosting SSH Access page) is replaced, not repeated, so the
 * message names the right hPanel page once.
 */
const explainUnreachable = (e, sshPage = SSH_ACCESS_PAGE) => {
	if (!isUnreachable(e)) return e;
	const base = e.message.replace(/\s*Check that SSH access is enabled in [\s\S]*$/, '');
	const err = new Error(`${base} SSH may be turned off for this website, or not included in its hosting plan: check ${sshPage}.`);
	err.cause = e;
	return err;
};

/** The label a hosting account's websites are grouped under in the site picker: "u123456789 · order 1000000001". */
const accountGroup = (username, orderId) => (orderId ? `${username} · order ${orderId}` : username);

/**
 * Builds the site picker's choices (IPC.LIST_SITES): one per WordPress installation of a web hosting account, one per
 * WordPress website Hostinger hasn't listed an installation for, and one per Agency Plan WordPress website. Websites
 * with no CloudLinux account (Website Builder, Horizons) have no SSH and are left out; disabled ones are listed but
 * can't be linked.
 */
function toSiteChoices({ websites = [], installations = [], agencyWebsites = [] } = {}) {
	const choices = [];
	const websiteKey = (username, domain) => `${username}\n${domain}`;
	const byKey = new Map();
	websites.forEach((w) => {
		const domain = cleanDomain(w && w.domain);
		if (domain && w.username) byKey.set(websiteKey(w.username, domain), w);
	});
	const hostingChoice = ({ username, domain, directory, website, install }) => {
		const isEnabled = !website || website.is_enabled !== false;
		const orderId = website && website.order_id ? website.order_id : null;
		return {
			id: `hosting:${username}:${domain}:${directory}`,
			platform: 'hosting',
			accountUsername: username,
			orderId,
			domain,
			directory,
			url: (install && install.url) || `https://${domain}/${directory ? `${directory}/` : ''}`,
			siteTitle: (install && install.site_title) || '',
			websiteType: (website && website.website_type) || 'wordpress',
			installId: install && install.id ? String(install.id) : null,
			rootDirectory: website ? safeRoot(website.root_directory) : null,
			isEnabled,
			linkable: isEnabled,
			reason: isEnabled ? null : 'disabled',
			group: accountGroup(username, orderId),
		};
	};

	const installed = new Set();
	installations.forEach((install) => {
		const domain = cleanDomain(install && install.domain);
		if (!domain || !install.username || !USERNAME_RE.test(install.username)) return;
		const website = byKey.get(websiteKey(install.username, domain));
		// A website Hostinger lists without an account or folder isn't on a server reachable over SSH.
		if (website && !safeRoot(website.root_directory)) return;
		installed.add(websiteKey(install.username, domain));
		const directory = cleanDirectory(install.directory, website && website.root_directory);
		if (directory === null) return;
		choices.push(hostingChoice({ username: install.username, domain, directory, website, install }));
	});
	websites.forEach((website) => {
		const domain = cleanDomain(website && website.domain);
		if (!domain || !website.username || !USERNAME_RE.test(website.username) || !safeRoot(website.root_directory)) return;
		if (website.website_type !== 'wordpress' || website.vhost_type === 'parked') return;
		if (installed.has(websiteKey(website.username, domain))) return;
		choices.push(hostingChoice({ username: website.username, domain, directory: '', website }));
	});

	agencyWebsites.forEach((item) => {
		const details = (item && item.details) || {};
		const uid = item && (item.id || item.uid || details.uid);
		// Only Hostinger's own hosting platform (h5g) runs WordPress with SSH; Website Builder and Node.js apps have none.
		if (!uid || (item.platform && item.platform !== 'h5g')) return;
		const domains = arrayOf(details.domains || item.domains).map((d) => cleanDomain(d && (d.fqdn || d.domain))).filter(Boolean);
		const preview = cleanDomain((details.preview_domain || item.preview_domain || {}).fqdn);
		const domain = domains[0] || cleanDomain(item.domain) || preview;
		const state = item.state || details.state || null;
		const isEnabled = !state || state === 'active';
		const title = (details.wordpress && details.wordpress.title) || details.description || '';
		choices.push({
			id: `agency:${uid}`,
			platform: 'agency',
			accountUsername: details.username || null,
			orderId: item.order_id || null,
			domain,
			directory: '',
			url: domain ? `https://${domain}/` : null,
			siteTitle: title,
			websiteType: details.type || 'wordpress',
			installId: null,
			rootDirectory: null,
			isEnabled,
			linkable: isEnabled && Boolean(domain),
			reason: !isEnabled ? state : domain ? null : 'no domain',
			group: item.order_id ? `Agency Plan · order ${item.order_id}` : 'Agency Plan',
		});
	});

	return choices.sort((a, b) => a.group.localeCompare(b.group)
		|| String(a.domain || '').localeCompare(String(b.domain || ''))
		|| a.directory.localeCompare(b.directory));
}

/**
 * Folders, relative to `webRoot`, that belong to other websites, subdomains or WordPress installs of the same
 * account. Hostinger can put them inside a website's public_html; a push must never transfer or delete them.
 */
function nestedFolders(webRoot, paths) {
	const root = trimPath(webRoot);
	if (!root) return [];
	const dirs = new Set();
	paths.forEach((p) => {
		const full = trimPath(p);
		if (!full.startsWith(`${root}/`)) return;
		const rel = full.slice(root.length + 1).replace(/^\/+/, '');
		if (rel && !rel.split('/').includes('..')) dirs.add(rel);
	});
	return [...dirs].sort();
}

module.exports = function HostingerConnectMain(context) {
	const { electron } = context;
	const container = LocalMain.getServiceContainer().cradle;
	const logger = container.localLogger.child({ thread: 'main', addon: 'hostinger-connect' });
	const { sendIPCEvent } = LocalMain;

	const workDir = path.join(context.environment.userDataPath, 'hostinger-connect');
	const store = new Store(workDir, electron.safeStorage);
	const keys = new SshKeyStore(path.join(workDir, 'ssh'));

	let api = null;
	const getApi = () => {
		if (api) return api;
		const account = store.getAccount();
		if (!account) throw new Error('Connect your Hostinger account first.');
		api = new HostingerApi({ apiKey: account.apiKey, logger });
		return api;
	};

	/**
	 * Before a push, pull or comparison: adds the folders of websites and subdomains created in hPanel since the site was
	 * linked (Hostinger puts a new subdomain in public_html/<name>) to the link's excludeDirs. Discovery only spots
	 * nested WordPress installs, so without this a push with "delete" would wipe a newer static subdomain. Best-effort,
	 * and the list only grows.
	 */
	const refreshExcludeDirs = async (link) => {
		const username = link && (link.accountUsername || link.username);
		const roots = link ? [link.webRoot, link.remotePath].filter(Boolean) : [];
		if (!link || link.platform === 'agency' || !username || !link.domain || !roots.length || !store.getAccount()) return link;
		try {
			const hostinger = getApi();
			const [websites, subdomains] = await Promise.all([
				hostinger.listWebsites(),
				hostinger.listSubdomains(username, link.domain),
			]);
			const paths = [
				...websites.filter((w) => w && w.username === username).map((w) => w.root_directory),
				...subdomains.map((s) => s && s.root_directory),
			].filter(Boolean);
			const fresh = roots.flatMap((root) => nestedFolders(root, paths));
			return { ...link, excludeDirs: [...new Set([...(link.excludeDirs || []), ...fresh])].sort() };
		} catch (e) {
			logger.warn(`Could not refresh the other websites' folders for ${link.domain}: ${e.message}`);
			return link;
		}
	};

	const syncService = new SyncService({
		store,
		keys,
		workDir,
		getApi: () => (store.getAccount() ? getApi() : null),
		resolveLink: refreshExcludeDirs,
		services: {
			siteData: container.siteData,
			siteDatabase: container.siteDatabase,
			siteProcessManager: container.siteProcessManager,
			wpCli: container.wpCli,
		},
		sendIPCEvent,
		logger,
	});

	const updater = new Updater({
		pkg,
		addonDir: path.resolve(__dirname, '..'),
		addonsDir: path.join(context.environment.userDataPath, 'addons'),
		ipcMain: electron.ipcMain,
		app: electron.app,
		logger,
		onChange: () => broadcast(),
	});
	if (electron.app) updater.start();

	const keyComment = () => `local-hostinger-connect@${os.hostname()}`.replace(/\s+/g, '-');

	const getState = (siteId) => ({
		account: store.getPublicAccount(),
		link: siteId ? store.getPublicLink(siteId) : null,
		activity: siteId ? syncService.activity(siteId) : null,
		publicKey: keys.getPublicKey(),
		passwordAuthSupported: !isWindows(),
		update: updater.state(),
	});

	const broadcast = (siteId) => sendIPCEvent(IPC.STATE_CHANGED, siteId || null);

	/** Sends step-by-step linking progress to the form that started it (matched by its progressId). */
	const progressReporter = (progressId) => (message) => {
		logger.info(`Linking: ${message}`);
		if (progressId) sendIPCEvent(IPC.LINK_PROGRESS, progressId, message);
	};

	/** Broadcasts once a transfer has registered as active, and again when it settles. */
	const runAndBroadcast = async (siteId, transfer) => {
		broadcast(siteId);
		try {
			return await transfer;
		} finally {
			broadcast(siteId);
		}
	};

	/** Discovery hints for a link: where WordPress should be, and folders of other websites to leave alone. */
	const hintsFor = (link) => ({
		remotePath: link.remotePath || null,
		webRoot: link.webRoot || null,
		domain: link.domain || null,
		excludeDirs: link.excludeDirs || [],
	});

	/** Locates WordPress over an SSH login, installing WP-CLI if the server lacks it. */
	const locate = async (login, hints, onProgress) => {
		const transport = syncService.transportFor(login);
		try {
			let remote = await syncService.discoverRemote(transport, hints);
			if (!remote.hasWpCli && remote.hasPhp) {
				onProgress('WP-CLI is missing on the server; installing it in a private folder…');
				remote = await syncService.ensureWpCli(transport, remote);
			}
			return remote;
		} catch (e) {
			throw explainUnreachable(e, sshPageFor(login));
		} finally {
			await transport.close();
		}
	};

	const remoteFields = (remote) => ({
		remotePath: remote.remotePath,
		privateDir: remote.privateDir,
		nested: remote.nested,
		...(remote.managed ? { managed: remote.managed } : {}),
	});

	/**
	 * Logs in with Local's SSH key and finds WordPress. When the server refuses the key and the user typed the SSH
	 * password (set on the SSH Access page in hPanel), logs in with that instead and keeps it, encrypted, in the link.
	 * `hints` default to the link's own discovery hints.
	 */
	const connectWithKeyOrPassword = async (link, password, onProgress, hints = hintsFor(link)) => {
		const sshPage = sshPageFor(link);
		keys.ensure(keyComment());
		onProgress('Connecting with Local\'s SSH key…');
		try {
			return { ...link, authType: 'key', password: null, ...remoteFields(await locate(link, hints, onProgress)) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			logger.info(`Hostinger refused Local's SSH key for ${link.username}@${link.host}.`);
		}
		// The server answers the same way when SSH is turned off for the website, so the hint covers both.
		const addKeyHint = `Make sure SSH is turned on in ${sshPage} and Local's public key (shown on this page) is added there, then link again.`;
		// Windows has no password field (password logins aren't supported there), so it is checked first.
		if (isWindows()) {
			throw new Error(`Hostinger refused Local's SSH key, and password authentication is not supported on Windows yet. ${addKeyHint}`);
		}
		if (!password) {
			throw new Error(`Hostinger refused Local's SSH key. ${addKeyHint} Or type the website's SSH password `
				+ `(set in ${sshPage}) and link again.`);
		}
		onProgress('Local\'s SSH key isn\'t added in hPanel yet; connecting with the SSH password instead…');
		const withPassword = { ...link, authType: 'password', password };
		try {
			return { ...withPassword, ...remoteFields(await locate(withPassword, hints, onProgress)) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			throw new Error(`Hostinger refused both Local's SSH key and the SSH password. Check the password in ${sshPage} `
				+ `(you can change it there). ${addKeyHint}`);
		}
	};

	/**
	 * The website, subdomain and WordPress folders of the same account that sit inside this webroot. `siteRoot` is the
	 * website's own webroot, which subfolder installs are relative to.
	 */
	const findExcludeDirs = async (hostinger, choice, siteRoot, webRoot, websites, installations) => {
		const paths = websites
			.filter((w) => w && w.username === choice.accountUsername && w.root_directory)
			.map((w) => w.root_directory);
		(await hostinger.listSubdomains(choice.accountUsername, choice.domain)).forEach((sub) => {
			if (sub && sub.root_directory) paths.push(sub.root_directory);
		});
		installations
			.map((i) => (i && i.username === choice.accountUsername && cleanDomain(i.domain) === choice.domain
				? cleanDirectory(i.directory, siteRoot) : null))
			.filter(Boolean)
			.forEach((dir) => paths.push(`${siteRoot}/${dir}`));
		return nestedFolders(webRoot, paths);
	};

	/** Domains whose URLs a pull rewrites to the Local site: parked domains on the website and the www/non-www twin. */
	const findAltDomains = async (hostinger, choice) => {
		const domains = (await hostinger.listParkedDomains(choice.accountUsername, choice.domain))
			.filter((p) => p && p.type !== 'ip')
			.map((p) => cleanDomain(p.domain))
			.filter(Boolean);
		domains.push(wwwTwin(choice.domain));
		return [...new Set(domains)].filter((d) => d !== choice.domain);
	};

	/**
	 * Finds the SSH server of a web hosting account. The hosting API has no SSH details, but the account's database
	 * host (srvNNN.hstgr.io) is the same machine, and so is the hostname in the website's phpinfo() `System` row.
	 */
	const findSshHost = async (hostinger, choice, onProgress) => {
		onProgress('Finding the website\'s SSH server…');
		for (const lookup of [
			() => hostinger.getDatabaseHost(choice.accountUsername),
			() => hostinger.getServerHostname(choice.accountUsername, choice.domain),
		]) {
			try {
				const host = cleanHost(await lookup());
				if (isRemoteHost(host)) return host;
				if (host) logger.warn(`Ignoring ${host} as the SSH server of ${choice.accountUsername}: it is not reachable from here.`);
			} catch (e) {
				logger.warn(`Could not look up the SSH server of ${choice.accountUsername}: ${e.message}`);
			}
		}
		throw new Error(`Hostinger's API didn't reveal the SSH server for ${choice.domain}. Link it with SFTP/SSH details instead: `
			+ `${SSH_ACCESS_PAGE} lists the IP, port and username.`);
	};

	/**
	 * Links a web hosting website (shared or cloud plan) found through the API. Returns the link; nothing is saved yet.
	 * The webroot is the API's root_directory (or Hostinger's usual ~/domains/<domain>/public_html when the website
	 * wasn't listed) plus the install's folder, and discovery looks only there: the fallback folders (~/public_html is
	 * the account's main website) could hold a different WordPress, and a push would then overwrite the wrong site.
	 */
	const prepareHostingLink = async (hostinger, choice, catalog, password, onProgress) => {
		const host = await findSshHost(hostinger, choice, onProgress);
		const siteRoot = choice.rootDirectory || `/home/${choice.accountUsername}/domains/${choice.domain}/public_html`;
		const webRoot = `${siteRoot}${choice.directory ? `/${choice.directory}` : ''}`;
		onProgress('Reading the website\'s domains and folders from Hostinger…');
		const [excludeDirs, altDomains] = await Promise.all([
			findExcludeDirs(hostinger, choice, siteRoot, webRoot, catalog.websites, catalog.installations),
			findAltDomains(hostinger, choice),
		]);
		const link = {
			mode: 'account',
			platform: 'hosting',
			host,
			port: HOSTINGER_SSH_PORT,
			username: choice.accountUsername,
			accountUsername: choice.accountUsername,
			domain: choice.domain,
			directory: choice.directory,
			installId: choice.installId,
			agencyUid: null,
			rootDirectory: choice.rootDirectory,
			webRoot,
			siteTitle: choice.siteTitle || null,
			label: choice.siteTitle || `${choice.domain}${choice.directory ? `/${choice.directory}` : ''}`,
			altDomains,
			excludeDirs,
		};
		return connectWithKeyOrPassword(link, password, onProgress, { ...hintsFor(link), remotePath: webRoot });
	};

	/** Links an Agency Plan website, whose details include its SSH login. Returns the link; nothing is saved yet. */
	const prepareAgencyLink = async (hostinger, choice, password, onProgress) => {
		const uid = choice.id.slice('agency:'.length);
		onProgress('Reading the website\'s SSH details from Hostinger…');
		const details = (await hostinger.getAgencyWebsite(uid)) || {};
		const ssh = (details.remote_access && details.remote_access.ssh) || {};
		if (ssh.is_enabled === false) {
			throw new Error(`SSH access is turned off for ${choice.domain}. Turn it on in ${AGENCY_SSH_PAGE}, then link again.`);
		}
		const host = cleanHost(ssh.host || (details.server && details.server.hostname));
		const username = String(ssh.username || (details.user && details.user.username) || '').trim();
		if (!host || !HOSTNAME_RE.test(host) || !USERNAME_RE.test(username)) {
			throw new Error(`Hostinger did not return an SSH login for ${choice.domain}. Link it with SFTP/SSH details from ${AGENCY_SSH_PAGE} instead.`);
		}
		const fqdns = arrayOf(details.domains).map((d) => cleanDomain(d && d.fqdn)).filter(Boolean);
		const domain = fqdns[0] || choice.domain;
		const preview = cleanDomain(details.preview_domain && details.preview_domain.fqdn);
		const altDomains = [...new Set([...fqdns, preview].filter((d) => d && d !== domain))];
		const siteTitle = (details.wordpress && details.wordpress.title) || choice.siteTitle || null;
		return connectWithKeyOrPassword({
			mode: 'account',
			platform: 'agency',
			host,
			port: Number(ssh.port) || HOSTINGER_SSH_PORT,
			username,
			accountUsername: username,
			domain,
			directory: '',
			installId: null,
			agencyUid: uid,
			rootDirectory: null,
			webRoot: null,
			siteTitle,
			label: siteTitle || domain,
			altDomains,
			excludeDirs: [],
		}, password, onProgress);
	};

	/** Lists the account's websites and turns them into site choices, keeping the raw listings for linking. */
	const loadCatalog = async (hostinger, { hosting = true, agency = true } = {}) => {
		const bestEffort = (promise, what) => promise.catch((e) => {
			logger.warn(`Could not list Hostinger ${what}: ${e.message}`);
			return [];
		});
		const [websites, installations, agencyWebsites] = await Promise.all([
			hosting ? hostinger.listWebsites() : [],
			hosting ? bestEffort(hostinger.listWordPressInstallations(), 'WordPress installations') : [],
			agency ? bestEffort(hostinger.listAgencyWebsites(), 'Agency Plan websites') : [],
		]);
		return { websites, installations, agencyWebsites, choices: toSiteChoices({ websites, installations, agencyWebsites }) };
	};

	/**
	 * Links a website chosen from the account's list. The choice is looked up again by id from a fresh listing, never
	 * taken from the renderer. Returns the link to store; nothing is saved yet.
	 */
	const prepareAccountLink = async ({ id, password }, onProgress = () => {}) => {
		const hostinger = getApi();
		if (!id) throw new Error('Choose a Hostinger website from the list.');
		const isAgency = String(id).startsWith('agency:');
		onProgress('Reading the website from Hostinger…');
		const catalog = await loadCatalog(hostinger, { hosting: !isAgency, agency: isAgency });
		const choice = catalog.choices.find((c) => c.id === String(id));
		if (!choice) throw new Error('That Hostinger website could not be found. Refresh the list and try again.');
		if (!choice.linkable) throw new Error(`${choice.domain || 'This website'} can't be linked (${choice.reason}).`);
		const typed = password ? String(password) : null;
		return isAgency
			? prepareAgencyLink(hostinger, choice, typed, onProgress)
			: prepareHostingLink(hostinger, choice, catalog, typed, onProgress);
	};

	/** Builds and verifies a link from the SSH details on hPanel's SSH Access page. Nothing is saved yet. */
	const prepareManualLink = async ({ host, port, username, authType, password, remotePath, domain }, onProgress = () => {}) => {
		if (authType === 'password' && isWindows()) {
			throw new Error('Password authentication is not supported on Windows yet. Use the SSH key option instead.');
		}
		if (authType !== 'password') keys.ensure(keyComment());
		const link = {
			mode: 'manual',
			platform: null,
			authType: authType === 'password' ? 'password' : 'key',
			host: cleanHost(host),
			port: Number(port) || HOSTINGER_SSH_PORT,
			username: String(username || '').trim(),
			password: authType === 'password' ? password : null,
			domain: cleanDomain(cleanHost(domain)),
			altDomains: [],
			excludeDirs: [],
		};
		if (!link.host || !HOSTNAME_RE.test(link.host)) throw new Error(`Enter the SSH IP shown in ${SSH_ACCESS_PAGE}.`);
		if (!USERNAME_RE.test(link.username)) throw new Error(`Enter the SSH username shown in ${SSH_ACCESS_PAGE} (it looks like u123456789).`);
		link.label = link.domain || `${link.username}@${link.host}`;
		if (link.domain) link.altDomains = [wwwTwin(link.domain)];
		onProgress('Connecting over SSH…');
		const typedPath = remotePath ? String(remotePath).trim() : null;
		const remote = await locate(link, { ...hintsFor(link), remotePath: typedPath }, onProgress);
		// Without WordPress in the domain's own folder, discovery falls back to ~/public_html, which is the account's
		// main website: linking that under another domain's name would let a push overwrite the wrong website.
		const expected = link.domain ? `/domains/${link.domain}/public_html` : null;
		if (!typedPath && expected && !remote.remotePath.endsWith(expected)) {
			throw new Error(`Connected, but found no WordPress in ~${expected}. The WordPress found at ${remote.remotePath} may be `
				+ 'another website of this account. Check the domain, or type the remote path of the folder that holds wp-config.php.');
		}
		return { ...link, ...remoteFields(remote) };
	};

	const prepareLink = (source, onProgress) => (source && source.kind === 'manual'
		? prepareManualLink(source, onProgress)
		: prepareAccountLink(source || {}, onProgress));

	/** Name, domain and folder for a new Local site, following Local's new-site defaults and avoiding clashes. */
	const newSiteLocation = (siteName) => {
		const defaults = {
			sitesPath: '~/Local Sites/',
			tld: '.local',
			environment: 'flywheel',
			adminEmail: 'dev-email@wpengine.local',
			...(LocalMain.UserData ? LocalMain.UserData.get('settings-new-site-defaults', {}) : {}),
		};
		const slug = String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'hostinger-site';
		const sites = Object.values(container.siteData.getSites());
		const tld = `.${String(defaults.tld).replace(/^\.+/, '')}`;
		const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
		for (let i = 1; i < 1000; i += 1) {
			const candidate = i === 1 ? slug : `${slug}-${i}`;
			const domain = `${candidate}${tld}`;
			const sitePath = path.join(defaults.sitesPath, candidate);
			const taken = sites.some((s) => s.domain === domain || path.resolve(expand(s.path)) === path.resolve(expand(sitePath)));
			if (!taken && !fs.existsSync(expand(sitePath))) {
				return { siteName: String(siteName).trim(), domain, sitePath, defaults };
			}
		}
		throw new Error('Could not find a free folder for the new site.');
	};

	const handlers = {
		[IPC.GET_STATE]: (siteId) => getState(siteId),

		[IPC.GET_PUBLIC_KEY]: () => keys.ensure(keyComment()),

		[IPC.CHECK_UPDATE]: () => updater.check({ manual: true }),

		[IPC.INSTALL_UPDATE]: () => updater.install(),

		[IPC.RESTART_LOCAL]: () => updater.restart(),

		[IPC.CONNECT_ACCOUNT]: async ({ apiKey }) => {
			// Tokens contain no whitespace; copy-paste can bring along spaces, line breaks or zero-width characters.
			const cleanKey = String(apiKey || '').replace(/[\s​-‍⁠﻿]/g, '');
			if (!cleanKey) throw new Error('Paste a Hostinger API token.');
			const candidate = new HostingerApi({ apiKey: cleanKey, logger });
			const { websites } = await candidate.validate();
			store.setAccount({ apiKey: cleanKey, connectedAt: new Date().toISOString(), websites });
			api = candidate;
			broadcast();
			return getState();
		},

		[IPC.DISCONNECT_ACCOUNT]: () => {
			store.clearAccount();
			api = null;
			broadcast();
			return getState();
		},

		[IPC.LIST_SITES]: async () => (await loadCatalog(getApi())).choices,

		[IPC.LINK_ACCOUNT_SITE]: async ({ siteId, progressId, id, password }) => {
			store.setLink(siteId, await prepareAccountLink({ id, password }, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.LINK_MANUAL]: async ({ siteId, progressId, ...credentials }) => {
			store.setLink(siteId, await prepareManualLink(credentials, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.COMPARE]: ({ siteId, checksum }) => runAndBroadcast(siteId, syncService.compare(siteId, { checksum })),

		[IPC.NEW_SITE_LOCATION]: (siteName) => {
			const { domain, sitePath } = newSiteLocation(siteName);
			return { domain, sitePath };
		},

		/**
		 * "Pull to a new site": verifies the SSH connection to Hostinger first (so a bad login never leaves an empty site
		 * behind), then creates a regular Local site with Local's own add-site service, links it and pulls.
		 * Resolves once the connection is verified; creation and the pull report progress in Local's site overlay.
		 */
		[IPC.PULL_NEW_SITE]: async ({ siteName, source }) => {
			if (!siteName || !String(siteName).trim()) throw new Error('Enter a name for the new site.');
			const link = await prepareLink(source, progressReporter(source && source.progressId));
			const location = newSiteLocation(siteName);

			(async () => {
				let site;
				try {
					site = await container.addSite.addSite({
						newSiteInfo: {
							siteName: location.siteName,
							siteDomain: location.domain,
							sitePath: location.sitePath,
							environment: location.defaults.environment,
							multiSite: '',
						},
						wpCredentials: {
							adminUsername: 'admin',
							adminPassword: randomString(20),
							adminEmail: location.defaults.adminEmail,
						},
						goToSite: true,
						installWP: true,
					});
				} catch (e) {
					// Local shows its own error dialog for failed site creation.
					logger.error(`Could not create the Local site for a Hostinger pull: ${e.message}`);
					return;
				}
				store.setLink(site.id, link);
				broadcast(site.id);
				try {
					await runAndBroadcast(site.id, syncService.pull(site.id, { deleteLocal: true, backupLocal: false }));
				} catch (e) {
					// Reported through the site banner.
				}
			})();

			return { domain: location.domain, sitePath: location.sitePath };
		},

		[IPC.UNLINK_SITE]: ({ siteId }) => {
			store.removeLink(siteId);
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.TEST_CONNECTION]: async (siteId) => {
			const link = store.getLink(siteId);
			if (!link) throw new Error('This site is not linked to Hostinger yet.');
			const transport = syncService.transportFor(link);
			try {
				const remote = await syncService.discoverRemote(transport, hintsFor(link));
				store.updateLink(siteId, remoteFields(remote));
				broadcast(siteId);
				return remote;
			} catch (e) {
				throw explainUnreachable(e, sshPageFor(link));
			} finally {
				await transport.close();
			}
		},

		// Outcomes are reported through site banners like Local Connect; the IPC reply only signals completion.
		[IPC.PUSH]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.push(siteId, options)),

		[IPC.PULL]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.pull(siteId, options)),
	};

	Object.entries(handlers).forEach(([channel, handler]) => LocalMain.addIpcAsyncListener(channel, handler));

	logger.info(`ConnectLocal for Hostinger loaded (rsync/ssh from ${findBundledBinDir() || 'system PATH'})`);
};

module.exports.toSiteChoices = toSiteChoices;
module.exports.nestedFolders = nestedFolders;
