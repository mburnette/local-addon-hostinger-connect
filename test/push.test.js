'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	discoverRemoteScript, parseKeyValues, parseNested, parseManaged, findExternalLinks, normalizeDumpForImport, urlReplacements, parseItemized, mergeComparison,
	SyncService,
} = require('../lib/main/SyncService');
const { SshKeyStore, fingerprint } = require('../lib/main/sshKey');
const { Store } = require('../lib/main/store');
const { shellQuote, describeSshFailure } = require('../lib/main/transport');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-connect-test-'));
const posixOnly = { skip: process.platform === 'win32' };

/** A folder of fake commands to put first on PATH: { name: 'shell script body' }. */
const fakeBin = (scripts) => {
	const dir = tmp();
	Object.entries(scripts).forEach(([name, body]) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }));
	return dir;
};
const runSh = (script, { home, bin, env = {} } = {}) => execFileSync('sh', ['-c', script], {
	env: { ...process.env, ...env, HOME: home, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH },
	encoding: 'utf8',
});

test('generated public key is valid OpenSSH and fingerprints match ssh-keygen', posixOnly, () => {
	const dir = tmp();
	const store = new SshKeyStore(path.join(dir, 'ssh'));
	const pub = store.ensure('local-test@host');
	assert.match(pub, /^ssh-rsa AAAA[0-9A-Za-z+/=]+ local-test@host$/);

	const out = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', store.publicKeyPath], { encoding: 'utf8' });
	assert.ok(out.includes(fingerprint(pub)), `ssh-keygen printed ${out}`);

	// The private key must be readable by OpenSSH and correspond to the public key.
	const derived = execFileSync('ssh-keygen', ['-y', '-f', store.privateKeyPath], { encoding: 'utf8' }).trim();
	assert.equal(derived.split(' ').slice(0, 2).join(' '), pub.split(' ').slice(0, 2).join(' '));
	assert.equal(fs.statSync(store.privateKeyPath).mode & 0o777, 0o600);

	// Idempotent: a second call keeps the same key.
	assert.equal(store.ensure('other'), pub);
});

/**
 * A Hostinger-like account home: /home/u123456789 with each website at domains/<domain>/public_html and Hostinger's
 * DO_NOT_UPLOAD_HERE marker in domains/<domain>/.
 */
const hostingerHome = (domains = ['shop.example.com']) => {
	const home = path.join(tmp(), 'u123456789');
	domains.forEach((domain) => {
		fs.mkdirSync(path.join(home, 'domains', domain, 'public_html'), { recursive: true });
		fs.writeFileSync(path.join(home, 'domains', domain, 'DO_NOT_UPLOAD_HERE'), '');
		fs.writeFileSync(path.join(home, 'domains', domain, 'public_html', 'wp-config.php'), '<?php');
	});
	return home;
};
const webrootOf = (home, domain = 'shop.example.com') => fs.realpathSync(path.join(home, 'domains', domain, 'public_html'));

test('discover script finds the website from the domain hint and keeps dumps in a per-site folder in the home', posixOnly, () => {
	const home = hostingerHome();
	const info = parseKeyValues(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home }));
	assert.equal(info.webroot, webrootOf(home));
	assert.match(info.private, new RegExp(`^${fs.realpathSync(home)}/\\.hostinger-connect/domains_shop\\.example\\.com_public_html-\\d+$`));
	assert.equal(fs.statSync(info.private).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.dirname(info.private)).mode & 0o777, 0o700);
	assert.ok(['wp', 'phar', 'no'].includes(info.wpcli));
	assert.ok(['yes', 'no'].includes(info.rsync));
});

test('discover script gives each website of one account its own private folder', posixOnly, () => {
	const home = hostingerHome(['shop.example.com', 'blog.example.org']);
	const shop = parseKeyValues(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home }));
	const blog = parseKeyValues(runSh(discoverRemoteScript({ domain: 'blog.example.org' }), { home }));
	assert.equal(blog.webroot, webrootOf(home, 'blog.example.org'));
	assert.notEqual(shop.private, blog.private);
	assert.equal(path.dirname(shop.private), path.dirname(blog.private));
	// A WordPress installed in a subfolder of a website is a site of its own too.
	const sub = path.join(home, 'domains', 'shop.example.com', 'public_html', 'store');
	fs.mkdirSync(sub);
	fs.writeFileSync(path.join(sub, 'wp-config.php'), '<?php');
	const store = parseKeyValues(runSh(discoverRemoteScript({ webRoot: sub }), { home }));
	assert.equal(store.webroot, fs.realpathSync(sub));
	assert.match(path.basename(store.private), /^domains_shop\.example\.com_public_html_store-\d+$/);
	// Turning "/" into "_" alone would give "a/b_c" and "a_b/c" the same folder; the checksum keeps them apart.
	const clashA = path.join(home, 'domains', 'shop.example.com', 'public_html', 'x_y');
	const clashB = path.join(home, 'domains', 'shop.example.com', 'public_html', 'x', 'y');
	[clashA, clashB].forEach((d) => {
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'wp-config.php'), '<?php');
	});
	const a = parseKeyValues(runSh(discoverRemoteScript({ webRoot: clashA }), { home }));
	const b = parseKeyValues(runSh(discoverRemoteScript({ webRoot: clashB }), { home }));
	assert.notEqual(a.private, b.private);
});

test('discover script prefers the API webroot, and ignores an unsafe one', posixOnly, () => {
	const home = hostingerHome(['shop.example.com', 'other.example.com']);
	const other = webrootOf(home, 'other.example.com');
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ webRoot: other, domain: 'shop.example.com' }), { home })).webroot, other);
	assert.match(discoverRemoteScript({ webRoot: '/home/u1/domains/a.com/public_html/' }), /^for d in '\/home\/u1\/domains\/a\.com\/public_html' "\$HOME\/public_html"/);
	// Relative paths, "..", "/" and odd domains are never used as hints.
	['web', '/', '/home/u1/../etc', '/home/./u1'].forEach((webRoot) => {
		assert.match(discoverRemoteScript({ webRoot }), /^for d in "\$HOME\/public_html" "\$HOME\/htdocs" "\$HOME"; do/, webRoot);
	});
	['../x', 'a.com/x', 'a.com;rm', '-x.com', 'localhost'].forEach((domain) => {
		assert.match(discoverRemoteScript({ domain }), /^for d in "\$HOME\/public_html"/, domain);
	});
	// A hinted webroot that doesn't exist falls through to the domain's public_html.
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ webRoot: '/nowhere/public_html', domain: 'shop.example.com' }), { home })).webroot, webrootOf(home));
});

test('discover script falls back to public_html, htdocs and the home folder', posixOnly, () => {
	const home = path.join(tmp(), 'u1');
	['public_html', 'htdocs'].forEach((d) => fs.mkdirSync(path.join(home, d), { recursive: true }));
	fs.writeFileSync(path.join(home, 'htdocs', 'wp-load.php'), '<?php');
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ domain: 'missing.example.com' }), { home })).webroot, fs.realpathSync(path.join(home, 'htdocs')));
	fs.writeFileSync(path.join(home, 'public_html', 'wp-config.php'), '<?php');
	const info = parseKeyValues(runSh(discoverRemoteScript({}), { home }));
	assert.equal(info.webroot, fs.realpathSync(path.join(home, 'public_html')));
	assert.match(info.private, new RegExp(`^${fs.realpathSync(home)}/\\.hostinger-connect/public_html-\\d+$`));
});

test('discover script lists WordPress sites inside the webroot so transfers can exclude them', posixOnly, () => {
	const home = hostingerHome();
	const web = webrootOf(home);
	fs.mkdirSync(path.join(web, 'blog', 'old'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'plugins', 'bundled'), { recursive: true });
	fs.writeFileSync(path.join(web, 'blog', 'wp-load.php'), '<?php');
	fs.writeFileSync(path.join(web, 'blog', 'old', 'wp-load.php'), '<?php');
	// A plugin shipping its own WordPress copy is not a site.
	fs.writeFileSync(path.join(web, 'wp-content', 'plugins', 'bundled', 'wp-load.php'), '<?php');
	assert.deepEqual(parseNested(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home })), ['blog']);
});

test('discover script uses an explicit remote path as is, never falling back to another site', posixOnly, () => {
	const home = hostingerHome();
	const custom = path.join(home, "my 'site'", 'web');
	fs.mkdirSync(custom, { recursive: true });
	fs.writeFileSync(path.join(custom, 'wp-load.php'), '<?php');
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ remotePath: custom, domain: 'shop.example.com' }), { home })).webroot, fs.realpathSync(custom));
	assert.throws(
		() => runSh(discoverRemoteScript({ remotePath: path.join(home, 'gone'), domain: 'shop.example.com' }), { home }),
		(e) => e.status === 3,
	);
});

test('discover script exits 3 when no WordPress is found', posixOnly, () => {
	const home = tmp();
	assert.throws(
		() => execFileSync('sh', ['-c', discoverRemoteScript({})], { env: { ...process.env, HOME: home }, stdio: 'pipe' }),
		(e) => e.status === 3 && /home=/.test(e.stdout.toString()),
	);
});

test('never picks the webroot itself, or a folder inside it, for dumps', posixOnly, () => {
	// An SSH user whose home is the webroot: the folder above it is used, named by a checksum of the webroot.
	const parent = tmp();
	const home = path.join(parent, 'public_html');
	fs.mkdirSync(home);
	fs.writeFileSync(path.join(home, 'wp-config.php'), '<?php');
	const info = parseKeyValues(runSh(discoverRemoteScript({}), { home }));
	assert.equal(info.webroot, fs.realpathSync(home));
	assert.ok(info.private && !info.private.startsWith(`${info.webroot}/`) && info.private !== info.webroot);
	assert.match(info.private, new RegExp(`^${fs.realpathSync(parent)}/\\.hostinger-connect/site-\\d+$`));
});

test('never writes into a domains/<domain> folder Hostinger marks DO_NOT_UPLOAD_HERE', posixOnly, () => {
	const home = hostingerHome();
	const web = webrootOf(home);
	const tmpDir = tmp();
	// Logged in with the webroot as home, the next candidates are the marked folder above it, then TMPDIR.
	const info = parseKeyValues(runSh(discoverRemoteScript({}), { home: web, env: { TMPDIR: tmpDir } }));
	assert.equal(info.webroot, web);
	const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
	assert.match(info.private, new RegExp(`^${fs.realpathSync(tmpDir)}/\\.hostinger-connect-${uid}/site-\\d+$`));
	assert.deepEqual(fs.readdirSync(path.dirname(web)).sort(), ['DO_NOT_UPLOAD_HERE', 'public_html']);
});

test('never writes into the parent website\'s public_html for a WordPress installed in a subfolder', posixOnly, () => {
	const home = hostingerHome();
	const web = webrootOf(home);
	const sub = path.join(web, 'store');
	fs.mkdirSync(sub);
	fs.writeFileSync(path.join(sub, 'wp-config.php'), '<?php');
	// A home folder that can't take the private folder: the next candidate, the folder above the webroot, is the parent
	// website's public folder, which serves anything put there; TMPDIR is used instead.
	const lockedHome = path.join(tmp(), 'locked');
	fs.mkdirSync(lockedHome, { mode: 0o500 });
	const tmpDir = tmp();
	const info = parseKeyValues(runSh(discoverRemoteScript({ webRoot: sub }), { home: lockedHome, env: { TMPDIR: tmpDir } }));
	fs.chmodSync(lockedHome, 0o700);
	assert.equal(info.webroot, fs.realpathSync(sub));
	assert.ok(info.private.startsWith(`${fs.realpathSync(tmpDir)}/.hostinger-connect-`), info.private);
	assert.ok(!fs.existsSync(path.join(web, '.hostinger-connect')));

	// Two levels down (public_html/apps/store) the folder above is not called public_html, but is still served.
	const deep = path.join(web, 'apps', 'store');
	fs.mkdirSync(deep, { recursive: true });
	fs.writeFileSync(path.join(deep, 'wp-config.php'), '<?php');
	fs.chmodSync(lockedHome, 0o500);
	const deepInfo = parseKeyValues(runSh(discoverRemoteScript({ webRoot: deep }), { home: lockedHome, env: { TMPDIR: tmpDir } }));
	fs.chmodSync(lockedHome, 0o700);
	assert.ok(deepInfo.private.startsWith(`${fs.realpathSync(tmpDir)}/.hostinger-connect-`), deepInfo.private);
	assert.ok(!fs.existsSync(path.join(web, 'apps', '.hostinger-connect')));
});

test('finds symlinks that point outside the site, and broken ones, but not links within it', posixOnly, () => {
	const root = tmp();
	const web = path.join(root, 'public_html');
	fs.mkdirSync(path.join(web, 'wp-content', 'themes'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'uploads', '2026'), { recursive: true });
	fs.mkdirSync(path.join(root, 'dev', 'theme'), { recursive: true });
	fs.symlinkSync(path.join(root, 'dev', 'theme'), path.join(web, 'wp-content', 'themes', 'mine'));
	fs.symlinkSync('../../dev/theme', path.join(web, 'wp-content', 'relative-out'));
	fs.symlinkSync('2026', path.join(web, 'wp-content', 'uploads', 'latest'));
	fs.symlinkSync(path.join(root, 'nope'), path.join(web, 'wp-content', 'themes', 'gone'));
	const links = findExternalLinks(web);
	assert.deepEqual(links.external.sort(), ['wp-content/relative-out', 'wp-content/themes/mine']);
	assert.deepEqual(links.broken, ['wp-content/themes/gone']);
	assert.deepEqual(findExternalLinks(path.join(root, 'missing')), { external: [], broken: [] });
});

test('discover script reports links that resolve outside the site as server-managed', posixOnly, () => {
	const home = hostingerHome();
	const web = webrootOf(home);
	fs.mkdirSync(path.join(home, 'shared', 'object-cache'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'uploads', '2026'), { recursive: true });
	fs.writeFileSync(path.join(home, 'shared', 'object-cache', 'object-cache.php'), '<?php');
	fs.symlinkSync(path.join(home, 'shared', 'object-cache', 'object-cache.php'), path.join(web, 'wp-content', 'object-cache.php'));
	fs.symlinkSync('2026', path.join(web, 'wp-content', 'uploads', 'latest'));
	assert.deepEqual(parseManaged(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home })), ['wp-content/object-cache.php']);
});

test('discover script reports a disabled proc_open and where wp is', posixOnly, () => {
	const home = hostingerHome();
	// Hostinger: /usr/local/bin/wp is a symlink to the WP-CLI phar, and the CLI php has proc_open disabled.
	const bin = fakeBin({
		php: 'if [ "$1" = "-r" ]; then case "$2" in *proc_open*) printf no ;; esac; fi',
	});
	fs.writeFileSync(path.join(bin, 'wp-cli-2.12.0.phar'), '#!/usr/bin/env php\n<?php // phar\n', { mode: 0o755 });
	fs.symlinkSync('wp-cli-2.12.0.phar', path.join(bin, 'wp'));
	const info = parseKeyValues(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home, bin }));
	assert.equal(info.procopen, 'no');
	assert.equal(info.php, 'yes');
	assert.equal(info.wpcli, 'wp');
	assert.equal(info.wppath, path.join(bin, 'wp'));
	assert.equal(info.wpphp, 'yes');
	// A shell wrapper is not a PHP file, so it cannot be run through php.
	const wrapper = fakeBin({ wp: 'exec php /opt/wp-cli.phar "$@"', php: 'printf yes' });
	const wrapped = parseKeyValues(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home, bin: wrapper }));
	assert.equal(wrapped.wpphp, 'no');
	assert.equal(wrapped.procopen, 'yes');
	// Only the shebang's interpreter counts, not the word "php" elsewhere on the line.
	const commented = tmp();
	fs.writeFileSync(path.join(commented, 'wp'), '#!/bin/sh # runs php\nexec php /opt/wp-cli.phar "$@"\n', { mode: 0o755 });
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home, bin: commented })).wpphp, 'no');
	const altPhp = tmp();
	fs.writeFileSync(path.join(altPhp, 'wp'), '#!/opt/alt/php83/usr/bin/php -q\n<?php\n', { mode: 0o755 });
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ domain: 'shop.example.com' }), { home, bin: altPhp })).wpphp, 'yes');
});

const DISCOVERY = (extra = '') => `webroot=/home/u1/domains/shop.example.com/public_html\nprivate=/home/u1/.hostinger-connect/domains_shop.example.com_public_html\nphp=yes\nrsync=yes\n${extra}`;
const stubTransport = (stdout) => ({ commands: [], async exec(command) { this.commands.push(command); return { code: 0, stdout, stderr: '' }; } });

test('runs WP-CLI through php -d disable_functions= when proc_open is disabled', async () => {
	const service = new SyncService({ services: {}, logger: {} });
	const discover = (extra) => service.discoverRemote(stubTransport(DISCOVERY(extra)), {});
	const PRIVATE = '/home/u1/.hostinger-connect/domains_shop.example.com_public_html';

	assert.equal((await discover('wpcli=wp\nwppath=/usr/local/bin/wp\nwpphp=yes\nprocopen=no\n')).wp, "php -d disable_functions= '/usr/local/bin/wp'");
	// proc_open available, or a wp that php can't run: plain wp.
	assert.equal((await discover('wpcli=wp\nwppath=/usr/local/bin/wp\nwpphp=yes\nprocopen=yes\n')).wp, 'wp');
	assert.equal((await discover('wpcli=wp\nwppath=/usr/local/bin/wp\nwpphp=no\nprocopen=no\n')).wp, 'wp');
	assert.equal((await discover('wpcli=wp\nwppath=wp\nwpphp=yes\nprocopen=no\n')).wp, 'wp', 'only an absolute path is wrapped');
	// The WP-CLI build the add-on downloaded, with and without proc_open.
	const phar = await discover('wpcli=phar\nprocopen=no\n');
	assert.equal(phar.wp, `php -d disable_functions= '${PRIVATE}/wp-cli.phar'`);
	assert.equal(phar.hasWpCli, true);
	assert.equal(phar.procOpen, false);
	assert.deepEqual(phar.nested, []);
	assert.equal((await discover('wpcli=phar\nprocopen=yes\n')).wp, `php '${PRIVATE}/wp-cli.phar'`);
	assert.equal((await discover('wpcli=phar\n')).wp, `php '${PRIVATE}/wp-cli.phar'`, 'unknown counts as available');
	assert.equal((await discover('wpcli=no\n')).hasWpCli, false);
});

test('names the folder it searched when a stored or linked path holds no WordPress', async () => {
	const service = new SyncService({ services: {}, logger: {} });
	const missing = { commands: [], async exec() { return { code: 3, stdout: 'home=/home/u1\n', stderr: '' }; } };
	const webRoot = '/home/u1/domains/shop.example.com/public_html/blog';
	await assert.rejects(service.discoverRemote(missing, { remotePath: webRoot, domain: 'shop.example.com' }),
		(e) => e.message.includes(`no WordPress (wp-config.php) in ${webRoot}`) && !/Set the remote path/.test(e.message));
	await assert.rejects(service.discoverRemote(missing, { domain: 'shop.example.com' }), /under \/home\/u1\. Set the remote path/);
});

test('checks a downloaded WP-CLI with proc_open lifted, then uses it', async () => {
	const service = new SyncService({ services: {}, logger: {} });
	const transport = {
		commands: [],
		async exec(command) {
			this.commands.push(command);
			return { code: 0, stdout: command.startsWith('[ -f') ? 'ok\n' : '', stderr: '' };
		},
	};
	const remote = service._withWp({ privateDir: '/home/u1/.hostinger-connect/x', wpCli: 'no', hasPhp: true, procOpen: false });
	assert.equal(remote.hasWpCli, false);
	const updated = await service.ensureWpCli(transport, remote);
	assert.match(transport.commands[0], /php -d disable_functions= wp-cli\.phar\.tmp --info/);
	assert.equal(updated.wp, "php -d disable_functions= '/home/u1/.hostinger-connect/x/wp-cli.phar'");
});

test('adds the link\'s excludeDirs to the nested sites every transfer leaves alone', async () => {
	const service = new SyncService({ services: {}, logger: {} });
	const transport = stubTransport(DISCOVERY('wpcli=wp\nnested=blog\n'));
	const remote = await service.discoverRemote(transport, {
		webRoot: '/home/u1/domains/shop.example.com/public_html',
		domain: 'shop.example.com',
		excludeDirs: ['staging', '/sub.example.com/', 'blog/inner', '../escape', '/abs/../x', '', null],
	});
	assert.deepEqual(remote.nested, ['blog', 'staging', 'sub.example.com']);
	assert.match(transport.commands[0], /^for d in '\/home\/u1\/domains\/shop\.example\.com\/public_html' "\$HOME\/domains\/"'shop\.example\.com'"\/public_html"/);
	assert.deepEqual(SyncService.hintsFor({ remotePath: '/r', webRoot: '/w', domain: 'd.com', excludeDirs: ['x'], host: 'h' }), {
		remotePath: '/r', webRoot: '/w', domain: 'd.com', excludeDirs: ['x'],
	});
});

test('rsync sends remote paths through the protocol, so a folder with a space is not split by the server\'s shell', async () => {
	const { Transport } = require('../lib/main/transport');
	const transport = new Transport({ host: 'srv123.hstgr.io', port: 65002, username: 'u1', privateKeyPath: '/k', workDir: tmp(), logger: {} });
	const runs = [];
	transport._bin = () => '/fake/rsync-3.1.3';
	transport._spawn = async (cmd, args) => {
		if (args[0] === '--version') return { code: 0, stdout: 'rsync  version 3.1.3  protocol version 31\n', stderr: '' };
		runs.push(args);
		return { code: 0, stdout: '', stderr: '' };
	};
	await transport.rsyncUp({ source: '/local/', destination: '/home/u1/domains/x.com/public_html/old site/', extraArgs: ['--delete'] });
	await transport.rsyncDown({ source: '/home/u1/domains/x.com/public_html/old site/', destination: '/local/' });
	runs.forEach((args) => assert.ok(args.includes('--protect-args'), args.join(' ')));
	assert.equal(runs[0][runs[0].length - 1], 'u1@srv123.hstgr.io:/home/u1/domains/x.com/public_html/old site/');
});

test('an rsync without --protect-args (macOS openrsync) is asked once, and refuses remote paths the shell could split', async () => {
	const { Transport } = require('../lib/main/transport');
	const transport = new Transport({ host: 'srv123.hstgr.io', port: 65002, username: 'u1', privateKeyPath: '/k', workDir: tmp(), logger: {} });
	transport._bin = () => '/fake/openrsync';
	const runs = [];
	transport._spawn = async (cmd, args) => {
		runs.push(args);
		if (args[0] === '--version') return { code: 0, stdout: 'openrsync: protocol version 29\nrsync version 2.6.9 compatible\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	};
	await transport.rsyncUp({ source: '/local/', destination: '/home/u1/domains/x.com/public_html/', extraArgs: ['--delete'] });
	await transport.rsyncDown({ source: '/home/u1/domains/x.com/public_html/', destination: '/local/' });
	await assert.rejects(transport.rsyncUp({ source: '/local/', destination: '/home/u1/domains/x.com/public_html/old site/' }), /too old/);
	assert.equal(runs.filter((a) => a[0] === '--version').length, 1);
	runs.filter((a) => a[0] !== '--version').forEach((args) => assert.ok(!args.includes('--protect-args'), args.join(' ')));
	assert.equal(runs.length, 3);
});

test('shellQuote survives a round trip through sh', posixOnly, () => {
	const nasty = `it's "quoted" $HOME \`date\` ; echo nope`;
	assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(nasty)}`], { encoding: 'utf8' }), nasty);
});

test('normalizes dumps in both directions: MySQL 8 -> MariaDB and MariaDB 11 -> MySQL', async () => {
	const file = path.join(tmp(), 'dump.sql');
	fs.writeFileSync(file, [
		'/*M!999999\\- enable the sandbox mode */ ',
		'CREATE TABLE `wp_posts` (x int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
		'CREATE TABLE `wp_terms` (x int) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;',
		"INSERT INTO `wp_options` VALUES (1,'blogname','Hi','yes');",
		'`c` varchar(1) COLLATE utf8mb4_0900_as_cs NOT NULL,',
		'`d` varchar(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_uca1400_ai_ci NOT NULL',
	].join('\n'));
	await normalizeDumpForImport(file);
	const out = fs.readFileSync(file, 'utf8');
	assert.ok(!out.includes('sandbox mode'), 'MariaDB sandbox line breaks the MySQL client');
	assert.ok(!/0900|uca1400/.test(out));
	assert.equal((out.match(/utf8mb4_unicode_520_ci/g) || []).length, 3);
	assert.ok(out.includes('utf8mb3_unicode_ci'));
	assert.ok(out.startsWith('CREATE TABLE `wp_posts`'));
	assert.ok(out.includes("'blogname','Hi'"));
});

test('url replacements for push (Local -> https Hostinger)', () => {
	assert.deepEqual(urlReplacements(['//shop.local'], 'https://shop.example.com/'), [
		['//shop.local', '//shop.example.com'],
		['\\/\\/shop.local', '\\/\\/shop.example.com'],
		['http://shop.example.com', 'https://shop.example.com'],
	]);
});

test('url replacements for pull (Hostinger + temporary domain -> http Local)', () => {
	assert.deepEqual(urlReplacements(['https://shop.example.com', '//example-site-123456.hostingersite.com'], 'http://shop.local'), [
		['//shop.example.com', '//shop.local'],
		['\\/\\/shop.example.com', '\\/\\/shop.local'],
		['//example-site-123456.hostingersite.com', '//shop.local'],
		['\\/\\/example-site-123456.hostingersite.com', '\\/\\/shop.local'],
		['https://shop.local', 'http://shop.local'],
	]);
});

test('url replacements skip a source that already equals the destination, and repeated sources', () => {
	assert.deepEqual(urlReplacements(['https://shop.local'], 'https://shop.local'), [['http://shop.local', 'https://shop.local']]);
	assert.deepEqual(urlReplacements(['https://shop.example.com/', '//shop.example.com', 'http://shop.example.com'], 'http://shop.local'), [
		['//shop.example.com', '//shop.local'],
		['\\/\\/shop.example.com', '\\/\\/shop.local'],
		['https://shop.local', 'http://shop.local'],
	]);
});

test('store encrypts secrets and never exposes them to the renderer', () => {
	const dir = tmp();
	const fakeSafeStorage = {
		isEncryptionAvailable: () => true,
		encryptString: (s) => Buffer.from([...s].reverse().join('')),
		decryptString: (b) => [...b.toString()].reverse().join(''),
	};
	const store = new Store(dir, fakeSafeStorage);
	store.setAccount({ apiKey: 'account-secret', connectedAt: '2026-11-01T00:00:00.000Z', websites: 3 });
	store.setLink('site1', { mode: 'manual', host: '192.0.2.10', port: 65002, username: 'u123456789', authType: 'password', password: 'pw' });

	const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
	assert.ok(!raw.includes('account-secret'));
	assert.ok(!raw.includes('"pw"'));

	const reopened = new Store(dir, fakeSafeStorage);
	assert.equal(reopened.getAccount().apiKey, 'account-secret');
	assert.equal(reopened.getLink('site1').password, 'pw');
	assert.deepEqual(reopened.getPublicAccount(), { connectedAt: '2026-11-01T00:00:00.000Z', websites: 3 });
	const pub = reopened.getPublicLink('site1');
	assert.equal(pub.password, undefined);
	assert.equal(pub.hasPassword, true);
});

test('parses rsync itemized dry-run output, including odd file names', () => {
	const out = [
		'HG|*deleting  |0|1969/12/31-19:00:00|gone/f.txt',
		'HG|*deleting  |0|1969/12/31-19:00:00|gone/',
		'HG|<f.st......|14|2026/10/30-16:27:38|changed.txt',
		'HG|cL+++++++++|8|2026/10/30-16:27:38|link',
		'HG|<f+++++++++|4|2026/10/30-16:27:38|pipe|name.txt',
		'HG|cd+++++++++|0|2026/10/30-16:27:38|newdir/',
		'HG|.f...p.....|9|2026/10/30-16:27:38|perm-only.txt',
		'sending incremental file list',
	].join('\n');
	const items = parseItemized(out);
	assert.deepEqual(items.map((i) => [i.op, i.type, i.path]), [
		['delete', 'file', 'gone/f.txt'],
		['update', 'file', 'changed.txt'],
		['create', 'symlink', 'link'],
		['create', 'file', 'pipe|name.txt'],
	]);
	assert.equal(items[1].size, 14);
	assert.equal(items[1].mtime, Math.round(new Date(2026, 9, 30, 16, 27, 38).getTime() / 1000));
});

test('merges both dry runs into one comparison with sides and the newer copy', () => {
	const pushItems = [
		{ op: 'update', type: 'file', size: 10, mtime: 200, path: 'a.php' },
		{ op: 'update', type: 'file', size: 10, mtime: 100, path: 'b.php' },
		{ op: 'create', type: 'file', size: 5, mtime: 50, path: 'local.txt' },
		{ op: 'delete', type: 'file', size: null, mtime: null, path: 'remote.txt' },
	];
	const pullItems = [
		{ op: 'update', type: 'file', size: 12, mtime: 100, path: 'a.php' },
		{ op: 'update', type: 'file', size: 12, mtime: 300, path: 'b.php' },
		{ op: 'create', type: 'file', size: 7, mtime: 70, path: 'remote.txt' },
		{ op: 'delete', type: 'file', size: null, mtime: null, path: 'local.txt' },
	];
	const merged = mergeComparison(pushItems, pullItems);
	assert.deepEqual(merged.map((e) => [e.path, e.status, e.newer]), [
		['a.php', 'changed', 'local'],
		['b.php', 'changed', 'remote'],
		['local.txt', 'local-only', null],
		['remote.txt', 'remote-only', null],
	]);
	assert.deepEqual(merged[0].local, { size: 10, mtime: 200 });
	assert.deepEqual(merged[0].remote, { size: 12, mtime: 100 });
	assert.deepEqual(merged[2].local, { size: 5, mtime: 50 });
	assert.equal(merged[2].remote, null);
	assert.deepEqual(merged[3].remote, { size: 7, mtime: 70 });
});

test('only real SSH login failures are reported as a refused key', () => {
	const t = { username: 'u123456789', host: 'srv123.hstgr.io', port: 65002, password: null, knownHostsPath: '/k' };
	const refused = describeSshFailure(255, 'u123456789@srv123.hstgr.io: Permission denied (publickey,password).', t);
	assert.match(refused, /^Hostinger refused the SSH key for u123456789@srv123\.hstgr\.io:65002\. Add Local's public key in hPanel → Websites → Manage → Advanced → SSH Access/);
	assert.match(describeSshFailure(255, 'Permission denied, please try again.', { ...t, password: 'x' }), /refused the password .*SSH Access/);
	const remote = "mysqldump: Can't create/write to file '/home/u123456789/.hostinger-connect/domains_shop.example.com_public_html/local-backup-before-push.sql' (Errcode: 13 \"Permission denied\")";
	const msg = describeSshFailure(1, remote, t);
	assert.doesNotMatch(msg, /refused the SSH key/);
	assert.match(msg, /A command failed on the Hostinger server \(exit 1\).*Can't create\/write/);
});

test('explains an unreachable SSH port in Hostinger terms', () => {
	const t = { username: 'u123456789', host: '192.0.2.10', port: 65002, password: null, knownHostsPath: '/k' };
	const msg = describeSshFailure(255, 'ssh: connect to host 192.0.2.10 port 65002: Connection timed out', t);
	assert.match(msg, /^Could not reach u123456789@192\.0\.2\.10:65002/);
	assert.match(msg, /SSH access is enabled in hPanel → Websites → Manage → Advanced → SSH Access \(not every Hostinger plan includes it\)/);
	assert.doesNotMatch(msg, /environment|allowlist|User settings/);
	assert.doesNotMatch(describeSshFailure(255, 'ssh: Could not resolve hostname nope: nodename nor servname provided', t), /SSH Access/);
});

// ---------------------------------------------------------------- push and pull with a stand-in server

const WEBROOT = '/home/u123456789/domains/shop.example.com/public_html';
const PRIVATE = '/home/u123456789/.hostinger-connect/domains_shop.example.com_public_html';
const WP = "php -d disable_functions= '/usr/local/bin/wp'";

/** Records every ssh command and rsync call; `respond(command)` gives a command's stdout. */
function fakeTransport({ discovery = '', respond = () => '' } = {}) {
	const calls = [];
	return {
		calls,
		execs: () => calls.filter(([kind]) => kind === 'exec').map(([, c]) => c),
		async exec(command) {
			calls.push(['exec', command]);
			if (command.startsWith('for d in ')) {
				return { code: 0, stdout: `webroot=${WEBROOT}\nprivate=${PRIVATE}\nwpcli=wp\nwppath=/usr/local/bin/wp\nwpphp=yes\nphp=yes\nprocopen=no\nrsync=yes\n${discovery}`, stderr: '' };
			}
			return { code: 0, stdout: respond(command) || '', stderr: '' };
		},
		async rsyncUp(args) {
			calls.push(['up', args]);
			return '';
		},
		async rsyncDown(args) {
			calls.push(['down', args]);
			if (!args.source.endsWith('/')) fs.writeFileSync(args.destination, 'CREATE TABLE `wp_options` (x int) COLLATE=utf8mb4_uca1400_ai_ci;\n');
			return '';
		},
		async close() {},
	};
}

/** A SyncService wired to stand-ins for Local's services, a stored link and (optionally) a Hostinger API. */
function makeService({ link, api = null, transport }) {
	const webRoot = path.join(tmp(), 'app', 'public');
	fs.mkdirSync(path.join(webRoot, 'wp-includes'), { recursive: true });
	['wp-load.php', 'wp-settings.php', 'wp-includes/version.php'].forEach((f) => fs.writeFileSync(path.join(webRoot, f), '<?php'));
	const site = { id: 'site1', name: 'Shop', domain: 'shop.local', paths: { webRoot, sql: path.join(webRoot, '..', 'sql') } };
	let stored = { ...link };
	const events = [];
	const localWp = [];
	const service = new SyncService({
		store: { getLink: () => stored, updateLink: (id, patch) => { stored = { ...stored, ...patch }; } },
		keys: { privateKeyPath: '/nonexistent/key' },
		workDir: tmp(),
		getApi: () => api,
		services: {
			siteData: { getSite: () => site },
			siteDatabase: {
				dump: async (_site, dest) => fs.writeFileSync(dest, 'CREATE TABLE `wp_options` (x int) COLLATE=utf8mb4_0900_ai_ci;\n'),
				getTablePrefix: async () => 'wp_',
			},
			siteProcessManager: { getSiteStatus: () => 'running', start: async () => {} },
			wpCli: {
				run: async (_site, args) => {
					localWp.push(args.join(' '));
					return args.join(' ') === 'option get home' ? 'http://shop.local\n' : '';
				},
			},
		},
		sendIPCEvent: (...args) => events.push(args),
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	service.transportFor = () => transport;
	return { service, site, events, localWp, stored: () => stored };
}

const ACCOUNT_LINK = {
	mode: 'account',
	platform: 'hosting',
	host: 'srv123.hstgr.io',
	port: 65002,
	username: 'u123456789',
	authType: 'key',
	accountUsername: 'u123456789',
	domain: 'shop.example.com',
	directory: '',
	webRoot: WEBROOT,
	label: 'Shop',
	altDomains: ['www.shop.example.com'],
	excludeDirs: ['staging'],
};

test('push purges the object and LiteSpeed caches over SSH, then Hostinger\'s cache and CDN through the API', async () => {
	const apiCalls = [];
	const transport = fakeTransport({ discovery: 'nested=blog\n' });
	const api = {
		clearWebsiteCache: async (args) => {
			apiCalls.push(['clearWebsiteCache', args]);
			transport.calls.push(['api', 'clearWebsiteCache']);
		},
		clearAgencyCache: async (uid) => apiCalls.push(['clearAgencyCache', uid]),
		createBackup: async () => assert.fail('Hostinger has no backup API for web hosting'),
	};
	const { service, stored } = makeService({ link: ACCOUNT_LINK, api, transport });
	const result = await service.push('site1', { database: false, backup: true });
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(apiCalls, [['clearWebsiteCache', { username: 'u123456789', domain: 'shop.example.com', directory: '' }]]);

	// Discovery used the link's hints, and transfers leave the account's other websites and nested installs alone.
	assert.match(transport.execs()[0], /^for d in '\/home\/u123456789\/domains\/shop\.example\.com\/public_html' "\$HOME\/domains\/"'shop\.example\.com'/);
	const [, up] = transport.calls.find(([kind]) => kind === 'up');
	assert.equal(up.destination, `${WEBROOT}/`);
	assert.ok(up.extraArgs.includes('--exclude=/staging/') && up.extraArgs.includes('--exclude=/blog/') && up.extraArgs.includes('--delete'));
	assert.deepEqual(stored().nested, ['blog', 'staging']);
	assert.equal(stored().privateDir, PRIVATE);

	const purge = transport.execs().find((c) => /cache flush/.test(c));
	assert.equal(purge, `cd '${WEBROOT}' && (${WP} --skip-plugins --skip-themes cache flush; ${WP} litespeed-purge all --skip-themes) >/dev/null 2>&1; true`);
	// The origin's caches are purged before the CDN is told to refetch from it.
	const purgeAt = transport.calls.findIndex(([kind, c]) => kind === 'exec' && c === purge);
	const apiAt = transport.calls.findIndex(([kind]) => kind === 'api');
	assert.ok(purgeAt >= 0 && apiAt > purgeAt, `purge at ${purgeAt}, API clear at ${apiAt}`);
});

test('push clears an Agency Plan website\'s cache by its id, and a failed clear is only a warning', async () => {
	const apiCalls = [];
	const api = {
		clearWebsiteCache: async () => assert.fail('agency sites use the agency endpoint'),
		clearAgencyCache: async (uid) => {
			apiCalls.push(uid);
			throw new Error('Hostinger API error (500)');
		},
	};
	const link = { ...ACCOUNT_LINK, platform: 'agency', agencyUid: 'web-1', accountUsername: null };
	const { service, events } = makeService({ link, api, transport: fakeTransport() });
	const result = await service.push('site1', { database: false });
	assert.deepEqual(apiCalls, ['web-1']);
	assert.deepEqual(result.warnings, ['Hostinger\'s cache was not cleared: Hostinger API error (500)']);
	const banner = events.find(([name, b]) => name === 'showSiteBanner' && b.id === 'hostinger-site-pushed')[1];
	assert.equal(banner.variant, 'warning');
	assert.match(banner.message, /^Shop has been pushed to Hostinger \(Shop\)\. Hostinger's cache was not cleared/);
});

test('push without the account connected warns, and a subfolder install clears its own directory', async () => {
	const disconnected = makeService({ link: ACCOUNT_LINK, api: null, transport: fakeTransport() });
	assert.deepEqual((await disconnected.service.push('site1', { database: false })).warnings, [
		'The Hostinger account is disconnected, so Hostinger\'s server cache and CDN were not cleared.',
	]);
	const manual = makeService({ link: { ...ACCOUNT_LINK, mode: 'manual', platform: null }, api: null, transport: fakeTransport() });
	assert.deepEqual((await manual.service.push('site1', { database: false })).warnings, [], 'manual links have no API cache to clear');
	assert.deepEqual((await manual.service.push('site1', { database: false, purgeCache: false })).warnings, []);

	const apiCalls = [];
	const api = { clearWebsiteCache: async (args) => apiCalls.push(args) };
	const sub = makeService({ link: { ...ACCOUNT_LINK, directory: 'store', webRoot: `${WEBROOT}/store` }, api, transport: fakeTransport() });
	await sub.service.push('site1', { database: false });
	assert.deepEqual(apiCalls, [{ username: 'u123456789', domain: 'shop.example.com', directory: 'store' }]);
});

test('database push runs WP-CLI around the disabled proc_open and keeps its backup in the site\'s private folder', async () => {
	const transport = fakeTransport({
		respond: (c) => (/db export/.test(c) ? 'table_prefix=wp_\nhome=\n' : ''),
	});
	const { service } = makeService({ link: { ...ACCOUNT_LINK, directory: 'store' }, api: null, transport });
	await service.push('site1', { files: false, purgeCache: false });
	const execs = transport.execs();
	const exportCmd = execs.find((c) => /db export/.test(c));
	assert.ok(exportCmd.startsWith(`cd '${WEBROOT}' && umask 077 && { p="$(${WP} --skip-plugins --skip-themes config get table_prefix`), exportCmd);
	assert.ok(exportCmd.includes(`${WP} --skip-plugins --skip-themes db export '${PRIVATE}/local-backup-before-push.sql' \${o:+--tables="$o"}`), exportCmd);
	assert.ok(execs.some((c) => c.includes(`${WP} --skip-plugins --skip-themes db reset --yes && ${WP} --skip-plugins --skip-themes db import '${PRIVATE}/local-push-`)));
	// WordPress reported no home, so the link's domain and subfolder are used.
	assert.ok(execs.some((c) => c.includes("search-replace '//shop.local' '//shop.example.com/store' --all-tables ")));
	const [, dump] = transport.calls.find(([kind]) => kind === 'up');
	assert.match(dump.destination, new RegExp(`^${PRIVATE}/local-push-[0-9a-f]+\\.sql$`));
});

test('the push backup and the pull export hold only the site\'s own tables (run with sh and a stand-in wp)', posixOnly, async () => {
	const bin = fakeBin({
		wp: `case "$*" in *"config get table_prefix"*) echo blog_;; *"db query SHOW TABLES"*) printf 'wp_options\\nblog_options\\nblog_posts\\n';; *"db export"*) echo "$*" > "$OUT";; esac`,
	});
	const out = path.join(tmp(), 'export-args');
	for (const direction of ['push', 'pull']) {
		const transport = fakeTransport();
		const { service } = makeService({ link: ACCOUNT_LINK, api: null, transport });
		await service[direction]('site1', { files: false, purgeCache: false }).catch(() => {});
		// The real command, run in a scratch folder with the stand-in wp.
		const exportCmd = transport.execs().find((c) => /db export/.test(c)).replace(`cd '${WEBROOT}'`, 'cd /').split(WP).join('wp');
		const state = parseKeyValues(runSh(exportCmd, { home: tmp(), bin, env: { OUT: out } }));
		assert.equal(state.table_prefix, 'blog_');
		assert.match(fs.readFileSync(out, 'utf8'), / --tables=blog_options,blog_posts --no-tablespaces=true/);
		if (direction === 'push') assert.equal(state.tables, 'wp_options blog_options blog_posts');
	}
});

test('a database shared with another site: push replaces only its own tables, and never writes over the other site\'s', async () => {
	const state = (prefix) => `table_prefix=${prefix}\ntables=wp_options wp_posts blog_options blog_posts \nhome=https://shop.example.com/blog\n`;
	const run = async (remotePrefix, localPrefix) => {
		const transport = fakeTransport({ respond: (c) => (/db export/.test(c) ? state(remotePrefix) : '') });
		const { service } = makeService({ link: { ...ACCOUNT_LINK, directory: 'blog' }, api: null, transport });
		service._siteDatabase.getTablePrefix = async () => localPrefix;
		const result = await service.push('site1', { files: false, purgeCache: false }).then(() => null, (e) => e);
		return { error: result, execs: transport.execs(), uploads: transport.calls.filter(([kind]) => kind === 'up') };
	};

	// Same prefix as the remote site: its own tables are dropped instead of the whole database.
	const same = await run('blog_', 'blog_');
	assert.equal(same.error, null);
	const importCmd = same.execs.find((c) => /db import/.test(c));
	assert.ok(importCmd.includes(`db query 'DROP TABLE IF EXISTS \`blog_options\`, \`blog_posts\`' && ${WP} --skip-plugins --skip-themes db import`), importCmd);
	assert.ok(!same.execs.some((c) => /db reset/.test(c)), 'the other site\'s tables are never dropped');
	assert.ok(same.execs.filter((c) => /search-replace/.test(c)).every((c) => c.includes('--all-tables-with-prefix')));

	// Local's wp_ tables would overwrite the parent site's: nothing is uploaded or changed.
	const clash = await run('blog_', 'wp_');
	assert.match(clash.error.message, /also holds tables of another site \(wp_options, wp_posts\).*prefix \(wp_\) would overwrite wp_options, wp_posts.*Change the Local site's table prefix to blog_/);
	assert.equal(clash.uploads.length, 0);
	assert.ok(!clash.execs.some((c) => /db import|db reset|DROP TABLE/.test(c)));
});

test('database pull replaces the website\'s other addresses too', async () => {
	const transport = fakeTransport({
		respond: (c) => (/db export/.test(c) ? 'table_prefix=wp_\nhome=https://shop.example.com/store\nwp_version=6.8.3\n' : ''),
	});
	const link = { ...ACCOUNT_LINK, directory: 'store', altDomains: ['www.shop.example.com', 'example-site-123456.hostingersite.com', ''] };
	const { service, localWp } = makeService({ link, api: null, transport });
	await service.pull('site1', { files: false });
	const exportCmd = transport.execs().find((c) => /db export/.test(c));
	assert.match(exportCmd, new RegExp(`${WP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --skip-plugins --skip-themes db export '${PRIVATE}/local-pull-`));
	const replaced = localWp.filter((c) => c.startsWith('search-replace ')).map((c) => c.split(' ').slice(1, 3).join(' '));
	assert.deepEqual(replaced, [
		'//shop.example.com/store //shop.local',
		'\\/\\/shop.example.com\\/store \\/\\/shop.local',
		'//www.shop.example.com/store //shop.local',
		'\\/\\/www.shop.example.com\\/store \\/\\/shop.local',
		'//example-site-123456.hostingersite.com/store //shop.local',
		'\\/\\/example-site-123456.hostingersite.com\\/store \\/\\/shop.local',
		'https://shop.local http://shop.local',
	]);
});

test('a selective push never deletes through a server-managed link or inside another site\'s folder', async () => {
	const transport = fakeTransport({ discovery: 'nested=blog\nmanaged=wp-content/uploads\n' });
	const { service } = makeService({ link: ACCOUNT_LINK, api: null, transport });
	service._compared.set('site1', new Map([
		['wp-content/uploads/2026/other-site.jpg', 'remote-only'],
		['blog/index.php', 'remote-only'],
		['wp-content/old.php', 'remote-only'],
	]));
	const result = await service.push('site1', { fileList: ['wp-content/uploads/2026/other-site.jpg', 'blog/index.php', 'wp-content/old.php'], purgeCache: false });
	const rm = transport.execs().filter((c) => /rm -f --/.test(c));
	assert.deepEqual(rm, [`cd '${WEBROOT}' && rm -f -- 'wp-content/old.php'`]);
	assert.match(result.warnings.join(' '), /2 selected file\(s\) .* were not deleted on Hostinger/);
});

test('a selective pull never moves files out of a folder linked in from outside the site', posixOnly, async () => {
	const transport = fakeTransport();
	const { service, site } = makeService({ link: ACCOUNT_LINK, api: null, transport });
	const devTheme = tmp();
	fs.writeFileSync(path.join(devTheme, 'new.php'), '<?php');
	fs.mkdirSync(path.join(site.paths.webRoot, 'wp-content', 'themes'), { recursive: true });
	fs.symlinkSync(devTheme, path.join(site.paths.webRoot, 'wp-content', 'themes', 'mine'));
	fs.writeFileSync(path.join(site.paths.webRoot, 'wp-content', 'stale.php'), '<?php');
	service._compared.set('site1', new Map([['wp-content/themes/mine/new.php', 'local-only'], ['wp-content/stale.php', 'local-only']]));
	await service.pull('site1', { fileList: ['wp-content/themes/mine/new.php', 'wp-content/stale.php'] });
	assert.ok(fs.existsSync(path.join(devTheme, 'new.php')), 'the linked folder keeps its file');
	assert.ok(!fs.existsSync(path.join(site.paths.webRoot, 'wp-content', 'stale.php')));
});
