'use strict';

/** IPC channels shared by the main and renderer halves of the add-on. */
const IPC = {
	GET_STATE: 'hostingerConnect:getState',
	CONNECT_ACCOUNT: 'hostingerConnect:connectAccount',
	DISCONNECT_ACCOUNT: 'hostingerConnect:disconnectAccount',
	LIST_SITES: 'hostingerConnect:listSites',
	LINK_ACCOUNT_SITE: 'hostingerConnect:linkAccountSite',
	LINK_MANUAL: 'hostingerConnect:linkManual',
	UNLINK_SITE: 'hostingerConnect:unlinkSite',
	TEST_CONNECTION: 'hostingerConnect:testConnection',
	PUSH: 'hostingerConnect:push',
	PULL: 'hostingerConnect:pull',
	COMPARE: 'hostingerConnect:compare',
	NEW_SITE_LOCATION: 'hostingerConnect:newSiteLocation',
	PULL_NEW_SITE: 'hostingerConnect:pullNewSite',
	/** main -> renderer: (progressId, message) while linking. */
	LINK_PROGRESS: 'hostingerConnect:linkProgress',
	GET_PUBLIC_KEY: 'hostingerConnect:getPublicKey',
	CHECK_UPDATE: 'hostingerConnect:checkUpdate',
	INSTALL_UPDATE: 'hostingerConnect:installUpdate',
	RESTART_LOCAL: 'hostingerConnect:restartLocal',
	/** main -> renderer broadcast whenever stored state changes. */
	STATE_CHANGED: 'hostingerConnect:stateChanged',
};

const HOSTINGER_API_BASE = 'https://developers.hostinger.com';

/** SSH port of Hostinger's shared and cloud hosting servers (Agency Plan websites report their own). */
const HOSTINGER_SSH_PORT = 65002;

/** Where the official WP-CLI build is downloaded from when a server has no `wp` command. */
const WP_CLI_PHAR_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

/**
 * Paths never synced in either direction. rsync --exclude also protects them from --delete, so each side keeps
 * its own server files: Hostinger keeps wp-config.php (its DB credentials), its .private/ config folder, placeholder
 * page and must-use plugins, and Local never receives LiteSpeed's cache output or drop-ins, which would break the
 * local site.
 */
const SYNC_EXCLUDES = [
	// Server-specific config (Hostinger's .htaccess carries LiteSpeed rules; .htaccess.bk is the server's backup copy)
	'/wp-config.php',
	'/.htaccess',
	'/.htaccess.bk',
	'/.user.ini',
	'/php.ini',
	'/wp-cli.yml',
	// Hostinger's own webroot files: hPanel config (Deny from all) and the placeholder page of a new website
	'/.private/',
	'/default.php',
	// llms.txt is generated from the live site's content by Hostinger's plugin; each side keeps its own
	'/llms.txt',
	// Hostinger's must-use plugins (auto-updates, preview domain), installed and updated by the platform
	'wp-content/mu-plugins/hostinger-*.php',
	// Server-specific state: Jetpack's firewall rules hold absolute server paths; upgrade/ is WordPress scratch space
	'wp-content/jetpack-waf/',
	'wp-content/upgrade/',
	'wp-content/upgrade-temp-backup/',
	// Caching drop-ins (LiteSpeed Cache's object and page cache) and cache output
	'wp-content/object-cache.php',
	'wp-content/advanced-cache.php',
	'wp-content/cache/',
	'wp-content/litespeed/',
	// Site backups made by migration plugins: often gigabytes, and never wanted on the other side
	'wp-content/ai1wm-backups/',
	'wp-content/updraft/',
	// VCS and tooling
	'.git/',
	'.svn/',
	'node_modules/.bin/',
	'vendor/bin/',
	'.DS_Store',
	// Stray dumps in the webroot and Local helpers
	'/*.sql',
	'/*.sql.gz',
	'wp-content/mysql.sql',
	'local-phpinfo.php',
	'local-xdebuginfo.php',
	'wp-content/mu-plugins/local-by-flywheel-demo-urls.php',
	'wp-content/mu-plugins/local-by-flywheel-live-link-helper.php',
	// Ignore files for other hosts and for this add-on
	'.wpe-push-ignore',
	'.wpe-pull-ignore',
	'.cloudways-push-ignore',
	'.cloudways-pull-ignore',
	'.bluehost-push-ignore',
	'.bluehost-pull-ignore',
	'.kinsta-push-ignore',
	'.kinsta-pull-ignore',
	'.hostinger-push-ignore',
	'.hostinger-pull-ignore',
];

/**
 * rsync filter rules added after the excludes. Must-use plugins that exist only on the receiving side are never
 * deleted: hosts install their own there, and a push from a Local site without them must not remove them.
 */
const SYNC_PROTECT = [
	'--filter=P wp-content/mu-plugins/*',
];

/** Optional per-site ignore files in the site's webroot, same idea as .wpe-push-ignore / .wpe-pull-ignore. */
const IGNORE_FILES = {
	push: '.hostinger-push-ignore',
	pull: '.hostinger-pull-ignore',
};

module.exports = {
	IPC,
	HOSTINGER_API_BASE,
	HOSTINGER_SSH_PORT,
	WP_CLI_PHAR_URL,
	SYNC_EXCLUDES,
	SYNC_PROTECT,
	IGNORE_FILES,
};
