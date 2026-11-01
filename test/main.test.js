'use strict';

/**
 * Loads the add-on's main entry with Local's main-process API mocked, then drives its IPC handlers. The Hostinger API is
 * a fake global fetch answering with the shapes seen on a live Premium shared plan; SSH is stubbed at
 * SyncService.transportFor (a fake transport) and at SyncService.discoverRemote / pull.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IPC } = require('../lib/constants');
const { SyncService } = require('../lib/main/SyncService');
const { TransportError } = require('../lib/main/transport');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-main-test-'));
test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

const calls = [];
const handlers = {};
const existingSites = {
	a1: { id: 'a1', name: 'Shop Copy', domain: 'shop-copy.local', path: '~/Local Sites/shop-copy' },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cradle = {
	localLogger: { child: () => logger },
	siteData: { getSites: () => existingSites, getSite: (id) => existingSites[id] },
	siteDatabase: {},
	siteProcessManager: {},
	wpCli: {},
	addSite: {
		addSite: async (args) => {
			calls.push(['addSite', args]);
			const site = { id: 'new1', name: args.newSiteInfo.siteName, domain: args.newSiteInfo.siteDomain };
			existingSites.new1 = site;
			return site;
		},
	},
};
const localMain = {
	getServiceContainer: () => ({ cradle }),
	addIpcAsyncListener: (channel, fn) => { handlers[channel] = fn; },
	sendIPCEvent: (...args) => calls.push(['ipc', ...args]),
	UserData: { get: () => ({}) },
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (request === '@getflywheel/local/main') return localMain;
	return originalLoad.call(this, request, ...rest);
};

const REMOTE = {
	remotePath: '/home/u123456789/domains/example-site-123456.hostingersite.com/public_html',
	privateDir: '/home/u123456789/.hostinger-connect/domains_example-site-123456.hostingersite.com_public_html',
	wp: 'php -d disable_functions= /usr/local/bin/wp',
	hasWpCli: true,
	hasRsync: true,
	hasPhp: true,
	nested: [],
	managed: [],
};

const U = 'u123456789';
const WHALE = 'example-site-123456.hostingersite.com';
const WHALE_ROOT = `/home/${U}/domains/${WHALE}/public_html`;

const website = (domain, extra = {}) => ({
	domain,
	vhost_type: 'main',
	is_enabled: true,
	username: U,
	order_id: 1000000001,
	root_directory: `/home/${U}/domains/${domain}/public_html`,
	parent_domain: null,
	website_type: 'wordpress',
	...extra,
});
const WEBSITES = [
	website(WHALE),
	website(`shop.${WHALE}`, { vhost_type: 'subdomain', parent_domain: WHALE, root_directory: `${WHALE_ROOT}/shop` }),
	website('builder.example', { username: null, root_directory: null, website_type: 'builder' }),
	website('old.example', { is_enabled: false }),
	website('static.example', { website_type: 'other' }),
	website('blog.example', { username: 'u999', order_id: 2, root_directory: '/home/u999/domains/blog.example/public_html' }),
];
const install = (id, username, domain, directory, title) => ({
	id, username, domain, site_title: title, url: `https://${domain}/${directory ? `${directory}/` : ''}`, directory, is_valid: true, validation_error: null,
});
const INSTALLATIONS = [
	install('12345678', U, WHALE, '', 'Whale'),
	install('31363983', U, WHALE, 'staging', 'Whale staging'),
	install('31363984', U, `shop.${WHALE}`, '', 'Shop'),
	install('31363985', 'u999', 'blog.example', 'wp', 'Blog'),
];
const AGENCY = [{
	id: 'ag-1',
	order_id: 7,
	platform: 'h5g',
	state: 'active',
	details: { uid: 'ag-1', username: 'u777', domains: [{ fqdn: 'agency.example' }], preview_domain: { fqdn: 'ag-1.preview.example' }, wordpress: { title: 'Agency site' } },
}];

const PHPINFO = '<table><tr><td class="e">System </td><td class="v">Linux us-imm-web12.main-hosting.eu 5.14.0 #1 SMP x86_64 </td></tr></table>';

/** Fake Hostinger API. The `api` flags steer it; every request is recorded in `calls`. */
const api = {};
const resetApi = () => Object.assign(api, { agencyStatus: 200, agencySsh: true, phpInfoStatus: 200, dbHost: 'srv123.hstgr.io' });
resetApi();
const pageOf = (u, items) => {
	const page = Number(u.searchParams.get('page')) || 1;
	const perPage = Number(u.searchParams.get('per_page')) || 25;
	return [200, { data: items.slice((page - 1) * perPage, page * perPage), meta: { current_page: page, per_page: perPage, total: items.length } }];
};
globalThis.fetch = async (url, init) => {
	const u = new URL(url);
	const key = `${init.method} ${u.pathname}`;
	calls.push(['api', key, u.search]);
	const routes = {
		'GET /api/hosting/v1/websites': () => (init.headers.Authorization === 'Bearer good-token'
			? pageOf(u, WEBSITES)
			: [401, { message: 'Unauthenticated.', correlation_id: 'c' }]),
		'GET /api/hosting/v1/wordpress/installations': () => [200, INSTALLATIONS],
		'GET /api/agency-hosting/v1/websites': () => (api.agencyStatus === 200 ? pageOf(u, AGENCY) : [api.agencyStatus, { message: 'No' }]),
		'GET /api/agency-hosting/v1/websites/ag-1': () => [200, {
			uid: 'ag-1',
			domains: [{ fqdn: 'agency.example' }, { fqdn: 'www.agency.example' }],
			preview_domain: { fqdn: 'ag-1.preview.example' },
			remote_access: { ssh: { username: 'u777', host: 'agency-srv.example', port: 65003, is_enabled: api.agencySsh, is_password_enabled: true } },
			server: { hostname: 'agency-srv.example' },
			user: { username: 'u777' },
			wordpress: { title: 'Agency site' },
		}],
		[`GET /api/hosting/v1/accounts/${U}/databases`]: () => [200, { data: [{ name: `${U}_wp`, user: `${U}_wp`, domain: WHALE, host: api.dbHost, port: 3306 }], meta: { total: 1 } }],
		'GET /api/hosting/v1/accounts/u999/databases': () => [200, { data: [], meta: { total: 0 } }],
		'GET /api/hosting/v1/accounts/u999/websites/blog.example/php/php-info': () => (api.phpInfoStatus === 200 ? [200, { info: PHPINFO }] : [api.phpInfoStatus, { message: 'Server error' }]),
		[`GET /api/hosting/v1/accounts/${U}/websites/${WHALE}/subdomains`]: () => [200, [
			{ username: U, domain: WHALE, subdomain: 'shop', root_directory: `${WHALE_ROOT}/shop` },
			{ username: U, domain: WHALE, subdomain: 'docs', root_directory: `${WHALE_ROOT}/docs/` },
			{ username: U, domain: WHALE, subdomain: 'far', root_directory: `/home/${U}/domains/far.example/public_html` },
		]],
		[`GET /api/hosting/v1/accounts/${U}/websites/${WHALE}/parked-domains`]: () => [200, [
			{ username: U, domain: 'Whale.example', parent_domain: WHALE, root_directory: WHALE_ROOT, type: 'domain' },
			{ username: U, domain: '192.0.2.10', parent_domain: WHALE, root_directory: WHALE_ROOT, type: 'ip' },
		]],
	};
	const [status, body] = routes[key] ? routes[key]() : [404, { message: 'Not found', correlation_id: 'c' }];
	return { status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: () => null } };
};

/** How SSH logins go: (transport) -> true to accept, or a TransportError to throw. */
let acceptLogin;

SyncService.prototype.transportFor = function transportFor(link) {
	return {
		username: link.username,
		host: link.host,
		port: link.port,
		password: link.authType === 'password' ? link.password : null,
		close: async () => {},
		exec: async () => ({ code: 0, stdout: '', stderr: '' }),
	};
};
let discoverBehaviour = async () => REMOTE;
SyncService.prototype.discoverRemote = async function discoverRemote(transport, hints) {
	calls.push(['discover', transport.username, transport.host, transport.port, transport.password, hints]);
	const outcome = acceptLogin(transport);
	if (outcome instanceof Error) throw outcome;
	if (!outcome) {
		throw new TransportError(`Hostinger refused the ${transport.password ? 'password' : 'SSH key'} for ${transport.username}@${transport.host}`, 255, 'Permission denied (publickey,password).');
	}
	return discoverBehaviour(transport, hints);
};
SyncService.prototype.pull = async function pull(siteId, options) {
	calls.push(['pull', siteId, options]);
	return { ok: true };
};

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (v) => Buffer.from(v),
	decryptString: (b) => b.toString(),
};
const addonMain = require('../lib/main');
addonMain({ electron: { safeStorage: fakeSafeStorage }, environment: { userDataPath } });

const waitFor = async (predicate, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timed out');
};
const names = () => calls.map((c) => c[0]);
const apiCalls = () => calls.filter((c) => c[0] === 'api').map((c) => c[1]);
const discovers = () => calls.filter((c) => c[0] === 'discover').map((c) => c.slice(1));
const settingsFile = () => fs.readFileSync(path.join(userDataPath, 'hostinger-connect', 'settings.json'), 'utf8');
const reset = () => {
	calls.length = 0;
	resetApi();
	acceptLogin = () => true;
	discoverBehaviour = async () => REMOTE;
};
const WHALE_ID = `hosting:${U}:${WHALE}:`;

test('suggests a non-clashing domain and folder from Local defaults', () => {
	assert.deepEqual(handlers[IPC.NEW_SITE_LOCATION]('Shop Copy!'), { domain: 'shop-copy-2.local', sitePath: path.join('~/Local Sites/', 'shop-copy-2') });
	assert.equal(handlers[IPC.NEW_SITE_LOCATION]('Brand New').domain, 'brand-new.local');
});

test('a rejected API token is reported and nothing is stored', async () => {
	reset();
	await assert.rejects(handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'bad-token' }), /rejected this API token/);
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
});

test('connecting validates the token, counts the websites and keeps the token out of the renderer', async () => {
	reset();
	const state = await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: ' good-\u200btoken\n' });
	assert.deepEqual(Object.keys(state.account).sort(), ['connectedAt', 'websites']);
	assert.equal(state.account.websites, WEBSITES.length);
	assert.ok(!Number.isNaN(Date.parse(state.account.connectedAt)));
	assert.ok(!settingsFile().includes('good-token'), 'the token is stored encrypted');
	assert.ok(!JSON.stringify(state).includes('good-token'));
});

test('lists one choice per WordPress install, plus WordPress websites without one, grouped by account', async () => {
	reset();
	const choices = await handlers[IPC.LIST_SITES]();
	assert.deepEqual(choices.map((c) => [c.group, c.domain, c.directory, c.linkable]), [
		['Agency Plan · order 7', 'agency.example', '', true],
		[`${U} · order 1000000001`, WHALE, '', true],
		[`${U} · order 1000000001`, WHALE, 'staging', true],
		[`${U} · order 1000000001`, 'old.example', '', false],
		[`${U} · order 1000000001`, `shop.${WHALE}`, '', true],
		['u999 · order 2', 'blog.example', 'wp', true],
	]);
	assert.deepEqual(choices[1], {
		id: WHALE_ID,
		platform: 'hosting',
		accountUsername: U,
		orderId: 1000000001,
		domain: WHALE,
		directory: '',
		url: `https://${WHALE}/`,
		siteTitle: 'Whale',
		websiteType: 'wordpress',
		installId: '12345678',
		rootDirectory: WHALE_ROOT,
		isEnabled: true,
		linkable: true,
		reason: null,
		group: `${U} · order 1000000001`,
	});
	assert.equal(choices[3].reason, 'disabled');
	assert.equal(choices[3].installId, null, 'a WordPress website without an installation entry is still offered');
	assert.equal(choices[0].id, 'agency:ag-1');
	assert.equal(choices[0].platform, 'agency');
	assert.equal(choices[0].siteTitle, 'Agency site');
	assert.ok(!choices.some((c) => c.domain === 'builder.example'), 'websites without an SSH account are left out');
	assert.ok(!choices.some((c) => c.domain === 'static.example'), 'non-WordPress websites are left out');
});

test('choices skip unsafe install folders and non-WordPress Agency platforms, and keep installs of unlisted websites', () => {
	const { toSiteChoices } = addonMain;
	const choices = toSiteChoices({
		websites: [website(WHALE), website('rel.example', { root_directory: 'domains/rel.example/public_html' })],
		installations: [
			install('1', U, WHALE, '../other', 'Escapes'),
			install('2', U, WHALE, `${WHALE_ROOT}/blog`, 'Absolute'),
			install('3', U, WHALE, `/home/${U}/domains/elsewhere.example/public_html`, 'Elsewhere'),
			install('4', U, 'unlisted.example', 'wp', 'Unlisted'),
			install('5', '-oops', 'bad.example', '', 'Bad user'),
		],
		agencyWebsites: [{ id: 'b-1', platform: 'builder', state: 'active', details: { vhost: 'b.example' } }],
	});
	assert.deepEqual(choices.map((c) => [c.domain, c.directory, c.rootDirectory]), [
		['unlisted.example', 'wp', null],
		[WHALE, 'blog', WHALE_ROOT],
	]);
});

test('an install whose website isn\'t listed is looked for in Hostinger\'s usual folder, and only there', async () => {
	reset();
	const { toSiteChoices } = addonMain;
	const choice = toSiteChoices({ installations: [install('4', U, 'unlisted.example', 'wp', 'Unlisted')] })[0];
	INSTALLATIONS.push(install('4', U, 'unlisted.example', 'wp', 'Unlisted'));
	try {
		const { link } = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a5', id: choice.id });
		assert.equal(link.rootDirectory, null);
		assert.equal(link.webRoot, `/home/${U}/domains/unlisted.example/public_html/wp`);
		assert.equal(discovers()[0][4].remotePath, link.webRoot);
	} finally {
		INSTALLATIONS.pop();
	}
});

test('an account without an Agency Plan lists only its hosting websites', async () => {
	for (const status of [403, 404]) {
		reset();
		api.agencyStatus = status;
		const choices = await handlers[IPC.LIST_SITES]();
		assert.ok(choices.length && choices.every((c) => c.platform === 'hosting'));
	}
});

test('links with Local\'s SSH key, finding the SSH server through the database host', async () => {
	reset();
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', id: WHALE_ID, progressId: 'p1', rootDirectory: '/tmp/evil', host: 'evil.example' });
	assert.deepEqual(discovers(), [[U, 'srv123.hstgr.io', 65002, null, {
		remotePath: WHALE_ROOT,
		webRoot: WHALE_ROOT,
		domain: WHALE,
		excludeDirs: ['docs', 'shop', 'staging'],
	}]]);
	const { link } = state;
	assert.equal(link.mode, 'account');
	assert.equal(link.platform, 'hosting');
	assert.equal(link.authType, 'key');
	assert.equal(link.hasPassword, false);
	assert.equal(link.host, 'srv123.hstgr.io');
	assert.equal(link.port, 65002);
	assert.equal(link.username, U);
	assert.equal(link.accountUsername, U);
	assert.equal(link.domain, WHALE);
	assert.equal(link.directory, '');
	assert.equal(link.installId, '12345678');
	assert.equal(link.agencyUid, null);
	assert.equal(link.rootDirectory, WHALE_ROOT);
	assert.equal(link.webRoot, WHALE_ROOT);
	assert.equal(link.siteTitle, 'Whale');
	assert.equal(link.label, 'Whale');
	assert.deepEqual(link.altDomains, ['whale.example', `www.${WHALE}`]);
	assert.deepEqual(link.excludeDirs, ['docs', 'shop', 'staging']);
	assert.equal(link.remotePath, REMOTE.remotePath);
	assert.equal(link.privateDir, REMOTE.privateDir);
	assert.ok(!apiCalls().some((k) => k.endsWith('/php/php-info')), 'phpinfo is only read when the database host is unknown');

	const progress = calls.filter((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS);
	assert.ok(progress.some((c) => c[3] === 'Connecting with Local\'s SSH key…'));
	assert.ok(progress.every((c) => c[2] === 'p1'), 'progress goes to the requesting form only');
});

test('a subfolder install gets its own webroot and leaves the parent website out of its excludes', async () => {
	reset();
	const { link } = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a2', id: `${WHALE_ID}staging` });
	assert.equal(discovers()[0][4].remotePath, `${WHALE_ROOT}/staging`, 'discovery looks only in the install\'s folder, never in the parent site');
	assert.equal(link.webRoot, `${WHALE_ROOT}/staging`);
	assert.equal(link.directory, 'staging');
	assert.equal(link.label, 'Whale staging');
	assert.deepEqual(link.excludeDirs, []);
});

test('falls back to the phpinfo() server name when the account has no database host', async () => {
	reset();
	const { link } = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a3', id: 'hosting:u999:blog.example:wp' });
	assert.equal(link.host, 'us-imm-web12.main-hosting.eu');
	assert.equal(link.username, 'u999');
	assert.equal(link.webRoot, '/home/u999/domains/blog.example/public_html/wp');
	assert.deepEqual(link.altDomains, ['www.blog.example'], 'parked domains are best-effort');
	assert.ok(apiCalls().includes('GET /api/hosting/v1/accounts/u999/websites/blog.example/php/php-info'));
});

test('a database host only reachable from the server (localhost) is not used as the SSH server', async () => {
	for (const dbHost of ['localhost', '127.0.0.1']) {
		reset();
		api.dbHost = dbHost;
		api.phpInfoStatus = 500;
		await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a3', id: WHALE_ID }), /didn't reveal the SSH server/);
		assert.deepEqual(discovers(), [], `never connects to ${dbHost}`);
	}
});

test('Agency Plan websites with missing or malformed fields are listed without crashing', () => {
	const { toSiteChoices } = addonMain;
	const choices = toSiteChoices({
		agencyWebsites: [
			null,
			{},
			{ id: 'n-1', details: null },
			{ id: 'n-2', details: { domains: 'agency.example', preview_domain: null, wordpress: null } },
			{ id: 'n-3', details: { domains: [null, 'x', { fqdn: null }], preview_domain: { fqdn: 'n-3.preview.example' } } },
		],
	});
	assert.deepEqual(choices.map((c) => [c.id, c.domain, c.linkable]), [
		['agency:n-1', null, false],
		['agency:n-2', null, false],
		['agency:n-3', 'n-3.preview.example', true],
	]);
});

test('asks for SFTP/SSH details when the API reveals no SSH server', async () => {
	reset();
	api.phpInfoStatus = 500;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b1', id: 'hosting:u999:blog.example:wp' }),
		/didn't reveal the SSH server.*SFTP\/SSH details.*Advanced → SSH Access lists the IP, port and username/,
	);
	assert.equal((await handlers[IPC.GET_STATE]('b1')).link, null);
	assert.ok(!names().includes('discover'));
});

test('uses the typed SSH password when hPanel doesn\'t have Local\'s key yet, and stores it encrypted', async () => {
	reset();
	acceptLogin = (t) => Boolean(t.password);
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a4', id: WHALE_ID, password: 'typed-ssh-pw' });
	assert.deepEqual(discovers().map((d) => d[3]), [null, 'typed-ssh-pw']);
	assert.equal(state.link.authType, 'password');
	assert.equal(state.link.hasPassword, true);
	assert.ok(!settingsFile().includes('typed-ssh-pw'));

	// Later connections reuse the stored password and the stored hints.
	calls.length = 0;
	await handlers[IPC.TEST_CONNECTION]('a4');
	const [d] = discovers();
	assert.equal(d[3], 'typed-ssh-pw');
	assert.deepEqual(d[4], { remotePath: REMOTE.remotePath, webRoot: WHALE_ROOT, domain: WHALE, excludeDirs: ['docs', 'shop', 'staging'] });
	assert.ok(!apiCalls().length, 'testing a link needs no API calls');
});

test('explains where to add Local\'s key when it is refused and no password was typed', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: WHALE_ID }),
		/refused Local's SSH key\. Make sure SSH is turned on in hPanel → Websites → Manage → Advanced → SSH Access and Local's public key .*is added there.*Or type the website's SSH password/,
	);
	assert.equal(discovers().length, 1);
	assert.equal((await handlers[IPC.GET_STATE]('b2')).link, null);
});

test('on Windows a refused key is not followed by advice to type a password it has no field for', async () => {
	reset();
	acceptLogin = () => false;
	const platform = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
	try {
		assert.equal((await handlers[IPC.GET_STATE]()).passwordAuthSupported, false);
		const err = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: WHALE_ID }).then(() => null, (e) => e);
		assert.match(err.message, /password authentication is not supported on Windows yet\. Make sure SSH is turned on/);
		assert.doesNotMatch(err.message, /type the website's SSH password/);
	} finally {
		Object.defineProperty(process, 'platform', platform);
	}
	assert.equal(discovers().length, 1);
});

test('explains what to check when both the key and the typed password are refused', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: WHALE_ID, password: 'wrong' }),
		/refused both Local's SSH key and the SSH password.*SSH Access/,
	);
	assert.equal((await handlers[IPC.GET_STATE]('b2')).link, null);
});

test('hints that SSH may be off when the server does not answer', async () => {
	reset();
	acceptLogin = (t) => new TransportError(`Could not reach ${t.username}@${t.host}:${t.port}: ssh: connect to host ${t.host} port ${t.port}: Connection timed out.`, 255, 'ssh: connect to host srv123.hstgr.io port 65002: Connection timed out');
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: WHALE_ID, password: 'pw' }),
		/Connection timed out\..*SSH may be turned off for this website, or not included in its hosting plan/,
	);
	assert.equal(discovers().length, 1, 'an unreachable server is not retried with the password');

	// The transport's own hint (shared-hosting page) is replaced, not repeated next to the add-on's.
	reset();
	acceptLogin = (t) => new TransportError(`Could not reach ${t.username}@${t.host}:${t.port}: ssh: connect to host ${t.host} port ${t.port}: Connection refused. `
		+ 'Check that SSH access is enabled in hPanel → Websites → Manage → Advanced → SSH Access (not every Hostinger plan includes it) and that the IP and port match the ones shown there (usually port 65002).',
	255, 'ssh: connect to host agency-srv.example port 65003: Connection refused');
	const err = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'g2', id: 'agency:ag-1' }).then(() => null, (e) => e);
	assert.match(err.message, /Connection refused\. SSH may be turned off for this website, or not included in its hosting plan: check the website's Remote access page in hPanel\.$/);
	assert.doesNotMatch(err.message, /SSH Access|Check that SSH access is enabled/, 'an Agency Plan website is not sent to the shared-hosting page');
});

test('a disabled or unknown website is not linked', async () => {
	reset();
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: `hosting:${U}:old.example:` }), /old\.example can't be linked \(disabled\)/);
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: `hosting:${U}:missing.example:` }), /could not be found/);
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2' }), /Choose a Hostinger website/);
	assert.ok(!names().includes('discover'));
});

test('links an Agency Plan website with the SSH login from its details', async () => {
	reset();
	const { link } = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'g1', id: 'agency:ag-1' });
	assert.deepEqual(discovers(), [['u777', 'agency-srv.example', 65003, null, { remotePath: null, webRoot: null, domain: 'agency.example', excludeDirs: [] }]]);
	assert.equal(link.platform, 'agency');
	assert.equal(link.agencyUid, 'ag-1');
	assert.equal(link.label, 'Agency site');
	assert.deepEqual(link.altDomains, ['www.agency.example', 'ag-1.preview.example']);
	assert.ok(!apiCalls().includes('GET /api/hosting/v1/websites'), 'an agency link does not list hosting websites');

	reset();
	api.agencySsh = false;
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'g2', id: 'agency:ag-1' }), /SSH access is turned off for agency\.example\. Turn it on in the website's Remote access page in hPanel/);
});

test('links with SSH details copied from hPanel, defaulting to port 65002', async () => {
	reset();
	discoverBehaviour = async () => ({ ...REMOTE, remotePath: `/home/${U}/domains/shop.example.com/public_html` });
	const state = await handlers[IPC.LINK_MANUAL]({
		siteId: 'm1', host: ' 192.0.2.10 ', port: '', username: U, authType: 'password', password: 'typed-pw', remotePath: '', domain: 'https://Shop.Example.com/',
	});
	assert.deepEqual(discovers(), [[U, '192.0.2.10', 65002, 'typed-pw', { remotePath: null, webRoot: null, domain: 'shop.example.com', excludeDirs: [] }]]);
	assert.equal(state.link.mode, 'manual');
	assert.equal(state.link.platform, null);
	assert.equal(state.link.label, 'shop.example.com');
	assert.deepEqual(state.link.altDomains, ['www.shop.example.com']);
	assert.equal(state.link.hasPassword, true);
	assert.ok(!settingsFile().includes('typed-pw'), 'a typed password is stored encrypted');

	reset();
	await handlers[IPC.LINK_MANUAL]({ siteId: 'm2', host: '192.0.2.10', port: '2222', username: U, authType: 'key', remotePath: ' /home/u1/domains/x/public_html ' });
	assert.deepEqual(discovers()[0].slice(2), [2222, null, { remotePath: '/home/u1/domains/x/public_html', webRoot: null, domain: null, excludeDirs: [] }]);
	assert.equal((await handlers[IPC.GET_STATE]('m2')).link.label, `${U}@192.0.2.10`);

	calls.length = 0;
	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm3', host: 'bad host!', username: U }), /Enter the SSH IP shown in hPanel → Websites → Manage → Advanced → SSH Access/);
	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm3', host: '1.2.3.4', username: ' ' }), /Enter the SSH username.*u123456789/);
	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm3', host: '-oProxyCommand', username: U }), /Enter the SSH IP/, 'a host is never an ssh option');
	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm3', host: '1.2.3.4', username: '-oProxyCommand=x' }), /Enter the SSH username/, 'nor is a username');
	assert.ok(!names().includes('discover'));
});

test('a manual link with a domain is not saved against another website found in ~/public_html', async () => {
	reset();
	// Discovery fell back past ~/domains/<typo>/public_html to the account's main website.
	const err = await handlers[IPC.LINK_MANUAL]({ siteId: 'm4', host: '192.0.2.10', username: U, authType: 'key', domain: 'shop.exmaple.com' }).then(() => null, (e) => e);
	assert.match(err.message, /found no WordPress in ~\/domains\/shop\.exmaple\.com\/public_html\. The WordPress found at .*example-site.* may be another website/);
	assert.equal((await handlers[IPC.GET_STATE]('m4')).link, null);

	// A typed remote path is the user's own choice and is kept.
	reset();
	const { link } = await handlers[IPC.LINK_MANUAL]({ siteId: 'm4', host: '192.0.2.10', username: U, authType: 'key', domain: 'shop.example.com', remotePath: REMOTE.remotePath });
	assert.equal(link.remotePath, REMOTE.remotePath);
});

test('a transfer also leaves alone subdomain folders created in hPanel after the site was linked', async () => {
	reset();
	await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', id: WHALE_ID });
	// A static (non-WordPress) subdomain added later: discovery can't spot it, and the stored excludes predate it.
	WEBSITES.push(website(`news.${WHALE}`, { vhost_type: 'subdomain', parent_domain: WHALE, root_directory: `${WHALE_ROOT}/news`, website_type: 'other' }));
	try {
		calls.length = 0;
		await handlers[IPC.COMPARE]({ siteId: 'a1' }).catch(() => {});
		assert.deepEqual(discovers()[0][4].excludeDirs, ['docs', 'news', 'shop', 'staging']);

		// Without the API (account disconnected) the stored list is still used.
		calls.length = 0;
		await handlers[IPC.DISCONNECT_ACCOUNT]();
		await handlers[IPC.COMPARE]({ siteId: 'a1' }).catch(() => {});
		assert.deepEqual(discovers()[0][4].excludeDirs, ['docs', 'shop', 'staging']);
	} finally {
		WEBSITES.pop();
		await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'good-token' });
	}
});

test('pull to new site verifies the connection, creates the site, links it, then pulls', async () => {
	reset();
	acceptLogin = (t) => Boolean(t.password);
	const res = await handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Shop Copy',
		source: { kind: 'account', id: WHALE_ID, password: 'typed-ssh-pw', progressId: 'p9' },
	});
	assert.equal(res.domain, 'shop-copy-2.local');
	assert.ok(names().includes('discover') && names().indexOf('discover') < names().indexOf('addSite'), 'connection is checked before anything is created');

	await waitFor(() => names().includes('pull'));
	const addSite = calls.find((c) => c[0] === 'addSite')[1];
	assert.deepEqual(addSite.newSiteInfo, {
		siteName: 'Shop Copy',
		siteDomain: 'shop-copy-2.local',
		sitePath: path.join('~/Local Sites/', 'shop-copy-2'),
		environment: 'flywheel',
		multiSite: '',
	});
	assert.equal(addSite.installWP, true);
	assert.equal(addSite.goToSite, true);
	assert.equal(addSite.wpCredentials.adminUsername, 'admin');
	assert.ok(addSite.wpCredentials.adminPassword.length >= 16);

	assert.deepEqual(calls.find((c) => c[0] === 'pull').slice(1), ['new1', { deleteLocal: true, backupLocal: false }]);
	assert.ok(names().indexOf('addSite') < names().indexOf('pull'));
	assert.ok(calls.some((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS && c[2] === 'p9'));

	const state = await handlers[IPC.GET_STATE]('new1');
	assert.equal(state.link.label, 'Whale');
	assert.equal(state.link.authType, 'password');
});

test('pull to new site creates nothing when the connection fails', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Broken',
		source: { kind: 'manual', host: '192.0.2.10', port: '65002', username: 'u', authType: 'password', password: 'nope' },
	}), /refused the password/);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!names().includes('addSite'));
});

test('disconnecting forgets the token; listing then asks to connect again', async () => {
	reset();
	await handlers[IPC.DISCONNECT_ACCOUNT]();
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
	assert.ok(!settingsFile().includes('"apiKey"') || JSON.parse(settingsFile()).account === null);
	await assert.rejects(handlers[IPC.LIST_SITES](), /Connect your Hostinger account first/);
	// Links keep working without the account: they log in over SSH only.
	await handlers[IPC.TEST_CONNECTION]('a4');
	await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'good-token' });
});
