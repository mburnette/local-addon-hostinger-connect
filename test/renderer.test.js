'use strict';

/**
 * Mounts the renderer half in jsdom with the real @getflywheel/local-components and React 16 (the version Local
 * ships), stubbing only Electron and Local's renderer API. Catches bad imports/props before Local ever loads it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="popup-container"></div></body></html>', {
	pretendToBeVisual: true,
});
// React's scheduler keeps a MessageChannel port open, and jsdom an animation-frame timer (pretendToBeVisual); both
// would keep the test process alive after the last test, so they are closed once the tests are done.
const channels = [];
global.MessageChannel = class TrackedMessageChannel extends MessageChannel {
	constructor() {
		super();
		channels.push(this);
	}
};
test.after(() => {
	channels.forEach((channel) => {
		channel.port1.close();
		channel.port2.close();
	});
	dom.window.close();
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.MutationObserver = dom.window.MutationObserver;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// Remaining DOM constructors (HTMLCollection, NodeList, …) that react-modal and friends expect as globals.
Object.getOwnPropertyNames(dom.window)
	.filter((key) => /^[A-Z]/.test(key) && !(key in global))
	.forEach((key) => { global[key] = dom.window[key]; });

const { IPC } = require('../lib/constants');

let mainState;
let compareResult;
let siteChoices;
let listError = null;
let testRemote = null;
const ipcCalls = [];
const listeners = {};

/** Site choices as main's toSiteChoices builds them: grouped by hosting account, one entry per WordPress install. */
const SHOP = {
	id: 'hosting:u222:shop.example.com:', platform: 'hosting', accountUsername: 'u222', orderId: 2, domain: 'shop.example.com', directory: '',
	url: 'https://shop.example.com/', siteTitle: 'Shop', websiteType: 'wordpress', installId: '12345678',
	rootDirectory: '/home/u222/domains/shop.example.com/public_html', isEnabled: true, linkable: true, reason: null, group: 'u222 · order 2',
};
const DEFAULT_CHOICES = [
	{
		id: 'hosting:u111:blog.example.com:', platform: 'hosting', accountUsername: 'u111', orderId: 1, domain: 'blog.example.com', directory: '',
		url: 'https://blog.example.com/', siteTitle: 'Blog', websiteType: 'wordpress', installId: '1',
		rootDirectory: '/home/u111/domains/blog.example.com/public_html', isEnabled: false, linkable: false, reason: 'disabled', group: 'u111 · order 1',
	},
	SHOP,
	{ ...SHOP, id: 'hosting:u222:shop.example.com:wp2', directory: 'wp2', url: 'https://shop.example.com/wp2/', siteTitle: 'Shop 2', installId: '2' },
	{
		id: 'agency:abc', platform: 'agency', accountUsername: null, orderId: null, domain: 'agency.example.com', directory: '', url: 'https://agency.example.com/',
		siteTitle: null, websiteType: 'wordpress', installId: null, rootDirectory: null, isEnabled: true, linkable: true, reason: null, group: 'Agency Plan',
	},
];

const stubs = {
	electron: {
		ipcRenderer: {
			on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
			removeListener: (ch, fn) => { listeners[ch] = (listeners[ch] || []).filter((f) => f !== fn); },
		},
		shell: { openExternal() {} },
	},
	'@getflywheel/local/renderer': {
		ipcAsync: async (channel, ...args) => {
			ipcCalls.push([channel, ...args]);
			if (channel === IPC.GET_STATE) return mainState;
			if (channel === IPC.LIST_SITES) {
				if (listError) throw listError;
				return siteChoices || DEFAULT_CHOICES;
			}
			if (channel === IPC.TEST_CONNECTION) return testRemote;
			if (channel === IPC.GET_PUBLIC_KEY) return 'ssh-rsa AAAAB3Nza test';
			if (channel === IPC.COMPARE) return compareResult;
			if (channel === IPC.NEW_SITE_LOCATION) return { domain: `${args[0].toLowerCase()}.local`, sitePath: `~/Local Sites/${args[0].toLowerCase()}` };
			if (channel === IPC.PULL_NEW_SITE) return { domain: 'shop.local', sitePath: '~/Local Sites/shop' };
			return null;
		},
		confirm: async () => true,
	},
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
	return originalLoad.call(this, request, ...rest);
};

const React = require('react');
const ReactDOM = require('react-dom');
const { act } = require('react-dom/test-utils');

const registered = { content: {}, filters: {} };
const hooks = {
	addContent: (name, cb) => { (registered.content[name] = registered.content[name] || []).push(cb); },
	addFilter: (name, cb) => { (registered.filters[name] = registered.filters[name] || []).push(cb); },
};
require('../lib/renderer')({ React, ReactRouter: require('react-router-dom'), hooks });

const site = { id: 'site1', name: 'Shop Local', domain: 'shop.local' };

async function mount(element) {
	const root = document.getElementById('root');
	await act(async () => {
		ReactDOM.render(element, root);
	});
	// let ipcAsync promises and effects settle
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	return root;
}

async function click(el) {
	await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text && b.getAttribute('role') !== 'tab');
const tab = (root, text) => [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === text);

function toolsPanel() {
	const items = registered.filters.siteInfoToolsItem[0]([], { routeChildrenProps: { site, siteStatus: 'running' } });
	assert.equal(items.length, 1);
	assert.equal(items[0].menuItem, 'Hostinger');
	return items[0].render();
}

test.after(() => dom.window.close());

test.afterEach(async () => {
	await act(async () => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); });
	document.getElementById('popup-container').innerHTML = '';
	siteChoices = null;
});

test('registers stylesheet, tools tab, header, create-site option and route hooks', () => {
	assert.equal(registered.content.stylesheets.length, 1);
	const options = registered.filters['CreateSite:RadioOptions'][0]({ 'add-site': { label: 'Create a new site' } });
	assert.deepEqual(Object.keys(options), ['add-site', 'hostinger-pull']);
	assert.equal(options['hostinger-pull'].label, 'Pull from Hostinger');
	const route = registered.content['routes[main]'][0]({});
	assert.equal(route.props.path, '/main/hostinger-pull');
	assert.equal(registered.filters.siteInfoToolsItem.length, 1);
	assert.equal(registered.content.SiteInfo_Top_TopRight.length, 1);
	const link = registered.content.stylesheets[0]();
	assert.match(link.props.href, /lib\/renderer\/styles\.css$/);
});

const typeInto = async (input, value) => act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
	input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const fieldInput = (root, label) => [...root.querySelectorAll('.HGConnect_Field')]
	.find((f) => f.querySelector('.HGConnect_FieldLabel').textContent === label)
	.querySelector('input');

const fieldNamed = (root, label) => [...root.querySelectorAll('.HGConnect_Field')]
	.find((f) => f.querySelector('.HGConnect_FieldLabel').textContent === label);
const selectValue = async (select, value) => act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
	select.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const LINKED_SHOP = {
	mode: 'account', platform: 'hosting', authType: 'password', label: 'Shop', domain: 'shop.example.com', directory: '',
	accountUsername: 'u222', host: 'srv123.hstgr.io', port: 65002, username: 'u222',
	remotePath: '/home/u222/domains/shop.example.com/public_html', nested: ['blog'], excludeDirs: ['blog', 'staging'], altDomains: [],
};

test('asks for a Hostinger API token when no account is connected', async () => {
	mainState = { account: null, link: null, publicKey: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.ok(tab(root, 'Hostinger API'));
	assert.ok(tab(root, 'SFTP/SSH details'));
	assert.match(root.textContent, /In hPanel, open API \(under Dev tools in the sidebar\), click New/);
	assert.doesNotMatch(root.textContent, /Company settings|API Keys/);
	assert.equal(fieldInput(root, 'API token').type, 'password', 'the token is masked');

	await typeInto(fieldInput(root, 'API token'), 'hostinger-token');
	ipcCalls.length = 0;
	await click(button(root, 'Connect account'));
	assert.deepEqual(ipcCalls.find(([ch]) => ch === IPC.CONNECT_ACCOUNT)[1], { apiKey: 'hostinger-token' });
});

test('lists websites grouped by hosting account, disables unlinkable ones and links the chosen one', async () => {
	mainState = { account: { connectedAt: '2026-10-31T00:00:00Z', websites: 4 }, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /Connected with a Hostinger API token · 4 websites/);
	assert.deepEqual([...root.querySelectorAll('select optgroup')].map((g) => g.label), ['u111 · order 1', 'u222 · order 2', 'Agency Plan']);
	const options = [...root.querySelectorAll('select option')];
	assert.deepEqual(options.map((o) => o.textContent), [
		'Blog — blog.example.com (disabled)',
		'Shop — shop.example.com',
		'Shop 2 — shop.example.com/wp2',
		'agency.example.com',
	]);
	assert.ok(options[0].disabled, 'an unlinkable website cannot be picked');
	assert.ok(options.slice(1).every((o) => !o.disabled));
	assert.equal(root.querySelector('select').value, SHOP.id, 'the first linkable website is preselected');
	assert.doesNotMatch(root.textContent, /environment|staging|live/i);
	assert.equal(root.querySelector('textarea').value, 'ssh-rsa AAAAB3Nza test', 'shows Local\'s key to add in hPanel');
	assert.match(fieldNamed(root, 'Local\'s SSH key').textContent, /hPanel → Websites → Manage → Advanced → SSH Access/);
	assert.equal(fieldInput(root, 'SSH password (optional)').type, 'password');

	// Without a typed password only the choice's id goes to main, which looks the website up again itself.
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_ACCOUNT_SITE)[1];
	assert.deepEqual(sent, { siteId: 'site1', id: SHOP.id });
	assert.match(progressId, /^link-/);

	// A subfolder install with a typed SSH password.
	await selectValue(root.querySelector('select'), 'hosting:u222:shop.example.com:wp2');
	await typeInto(fieldInput(root, 'SSH password (optional)'), 'ssh-pw');
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId: _id, ...second } = ipcCalls.find(([ch]) => ch === IPC.LINK_ACCOUNT_SITE)[1];
	assert.deepEqual(second, { siteId: 'site1', id: 'hosting:u222:shop.example.com:wp2', password: 'ssh-pw' });

	// Agency Plan websites keep their SSH login on the website's own Remote access page.
	await selectValue(root.querySelector('select'), 'agency:abc');
	assert.match(fieldNamed(root, 'Local\'s SSH key').textContent, /Remote access page/);
});

test('explains why a website cannot be linked and hides the password field where it is unsupported', async () => {
	siteChoices = [DEFAULT_CHOICES[0]];
	mainState = { account: { connectedAt: '2026-10-31T00:00:00Z', websites: 1 }, link: null, passwordAuthSupported: false };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /Connected with a Hostinger API token · 1 website(?!s)/);
	assert.match(root.textContent, /This website can't be linked: disabled\./);
	assert.equal(button(root, 'Link Shop Local').getAttribute('aria-disabled'), 'true');
	assert.equal(fieldNamed(root, 'SSH password (optional)'), undefined, 'Windows logs in with the key only');
});

test('says so when the token has no WordPress websites', async () => {
	siteChoices = [];
	mainState = { account: { connectedAt: '2026-10-31T00:00:00Z', websites: 0 }, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /No WordPress websites were found for this API token/);
	assert.equal(root.querySelector('select'), null);
});

test('a failed website listing shows the error and can be retried, without a spinner that never stops', async () => {
	listError = new Error('Hostinger rejected this API token.');
	mainState = { account: { connectedAt: '2026-10-31T00:00:00Z', websites: 2 }, link: null, passwordAuthSupported: true };
	try {
		const root = await mount(toolsPanel());
		assert.match(root.querySelector('[role="alert"]').textContent, /rejected this API token/);
		assert.doesNotMatch(root.textContent, /Loading your Hostinger websites/);
		listError = null;
		await click(button(root, 'Refresh list'));
		assert.equal(root.querySelectorAll('select option').length, DEFAULT_CHOICES.length);
		assert.equal(root.querySelector('[role="alert"]'), null);
	} finally {
		listError = null;
	}
});

test('SFTP/SSH tab takes the login from hPanel\'s SSH Access page, with Hostinger\'s port by default', async () => {
	mainState = { account: null, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	await click(tab(root, 'SFTP/SSH details'));
	assert.match(root.textContent, /Websites → Manage → Advanced → SSH Access/);
	assert.match(root.textContent, /Premium, Business and Cloud plans/);
	assert.equal(fieldInput(root, 'Port').value, '65002');
	assert.equal(fieldInput(root, 'Username').placeholder, 'u123456789');
	assert.equal(fieldInput(root, 'Remote path (optional)').placeholder, '/home/u123456789/domains/example.com/public_html');
	assert.match(fieldNamed(root, 'Website domain (optional)').textContent, /~\/domains\/<domain>\/public_html/);
	await typeInto(fieldInput(root, 'SSH IP'), '192.0.2.10');
	await typeInto(fieldInput(root, 'Username'), 'u123456789');
	await typeInto(fieldInput(root, 'Password'), 'pw');
	await typeInto(fieldInput(root, 'Website domain (optional)'), 'example.com');
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_MANUAL)[1];
	assert.deepEqual(sent, {
		siteId: 'site1', host: '192.0.2.10', port: '65002', username: 'u123456789', authType: 'password', password: 'pw', remotePath: '', domain: 'example.com',
	});
});

test('linked site shows website, hosting account and SSH login, and pushes with the chosen options', async () => {
	mainState = { account: null, passwordAuthSupported: true, link: LINKED_SHOP };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /WebsiteShop/);
	assert.match(root.textContent, /Domainshop\.example\.com/);
	assert.match(root.textContent, /Hosting accountu222/);
	assert.match(root.textContent, /SSH loginu222@srv123\.hstgr\.io:65002/);
	assert.match(root.textContent, /\/home\/u222\/domains\/shop\.example\.com\/public_html/);
	assert.match(root.textContent, /Other sites in subfolders: blog, staging/, 'nested installs and other websites, without duplicates');
	assert.match(root.textContent, /SSH password \(stored encrypted\)/);
	assert.match(root.textContent, /Clear Hostinger caches afterwards/);
	assert.doesNotMatch(root.textContent, /backup first|live environment|fetched from the Hostinger API/);

	const pushButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Push to Hostinger' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pushButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.ok(push, 'push IPC should be sent');
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { files: true, database: true, deleteRemote: true, purgeCache: true },
	});
});

test('agency and manual links describe their account and login', async () => {
	mainState = {
		account: null,
		link: { mode: 'account', platform: 'agency', agencyUid: 'abc', authType: 'key', label: 'agency.example.com', domain: 'agency.example.com', host: 'agency.hstgr.io', port: 22, username: 'agencyuser', remotePath: '/home/agencyuser/public_html' },
	};
	let root = await mount(toolsPanel());
	assert.match(root.textContent, /Hosting accountAgency Plan \(website abc\)/);
	assert.match(root.textContent, /SSH loginagencyuser@agency\.hstgr\.io(?!:)/, 'port 22 is not spelled out');
	assert.match(root.textContent, /AuthenticationLocal's SSH key/);
	assert.doesNotMatch(root.textContent, /Domain/, 'the domain is already the label');
	await act(async () => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); });

	mainState = { account: null, link: { mode: 'manual', platform: null, authType: 'key', host: '192.0.2.10', port: 65002, username: 'u123456789', remotePath: '/home/u123456789/domains/example.com/public_html', domain: 'example.com' } };
	root = await mount(toolsPanel());
	assert.doesNotMatch(root.textContent, /Hosting account/);
	assert.doesNotMatch(root.textContent, /Never synced/);
	assert.match(root.textContent, /Clear WordPress and LiteSpeed caches afterwards \(the server cache and CDN need an API link\)/,
		'a manual link has no API to clear the server cache and CDN with');
	assert.doesNotMatch(root.textContent, /server cache, CDN and LiteSpeed\)/);
});

test('an Agency Plan password link points at its own hPanel page, and Test connection is accurate about WP-CLI', async () => {
	mainState = {
		account: null,
		link: { mode: 'account', platform: 'agency', agencyUid: 'abc', authType: 'password', label: 'agency.example.com', domain: 'agency.example.com', host: 'agency.hstgr.io', port: 22, username: 'agencyuser' },
	};
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /SSH password \(stored encrypted\)\. Add Local's SSH key in the website's Remote access page in hPanel/);
	assert.doesNotMatch(root.textContent, /SSH Access/);

	testRemote = { remotePath: '/home/agencyuser/public_html', hasWpCli: false, hasPhp: true };
	await click(button(root, 'Test connection'));
	assert.match(root.textContent, /WP-CLI missing: the first database push or pull installs it/);
	assert.doesNotMatch(root.textContent, /database transfers will fail/, 'WP-CLI is installed when PHP is there');
	testRemote = { remotePath: '/home/agencyuser/public_html', hasWpCli: false, hasPhp: false };
	await click(button(root, 'Test connection'));
	assert.match(root.textContent, /WP-CLI and PHP missing: database transfers will fail/);
	testRemote = null;
});

test('pull tab sends a pull with its own options', async () => {
	mainState = {
		account: null,
		link: { mode: 'manual', authType: 'key', host: '1.2.3.4', port: 65002, username: 'u123', remotePath: '/home/u123/domains/shop.example.com/public_html', domain: 'shop.example.com' },
	};
	const root = await mount(toolsPanel());
	const pullTab = [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === 'Pull from Hostinger');
	await act(async () => { pullTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(root.textContent, /Back up the Local database first/);
	assert.match(root.textContent, /Delete Local files that are not on Hostinger/);
	assert.doesNotMatch(root.textContent, /Clear Hostinger caches|Hostinger backup/);

	const pullButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Pull from Hostinger' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pullButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const pull = ipcCalls.find(([ch]) => ch === IPC.PULL);
	assert.ok(pull, 'pull IPC should be sent');
	assert.deepEqual(pull[1], { siteId: 'site1', options: { files: true, database: true, backupLocal: true, deleteLocal: true } });
});

test('header buttons only appear for linked sites and open push/pull modals', async () => {
	mainState = { account: null, link: null };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'running'));
	assert.equal(root.textContent, '');

	// Linking elsewhere (e.g. in the Tools tab) broadcasts a state change; the header picks it up.
	mainState = { account: null, link: { mode: 'manual', authType: 'password', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	await act(async () => {
		listeners[IPC.STATE_CHANGED].forEach((fn) => fn({}, 'site1'));
		await new Promise((r) => setTimeout(r, 10));
	});
	const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
	assert.deepEqual(labels, ['Pull', 'Push']);

	await act(async () => { root.querySelectorAll('button')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(document.body.textContent, /This overwrites the files and database of Shop Local in Local with shop\.example\.com/);
});

test('push modal spells out what changes on Hostinger and how to roll back', async () => {
	mainState = { account: null, link: LINKED_SHOP };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'running'));
	await act(async () => { root.querySelectorAll('button')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	const text = document.body.textContent;
	assert.match(text, /This overwrites the files and database on Shop with Shop Local from Local\. Visitors see the change right away\./);
	assert.match(text, /private \.hostinger-connect folder in your Hostinger home folder/);
	assert.match(text, /must-use plugins, \.private, default\.php/);
	assert.match(text, /automatic backups in hPanel → Websites → Manage → Files → Backups/);
	assert.doesNotMatch(text, /Create a Hostinger backup first/);
});

test('header shows progress and disables both buttons while a pull runs', async () => {
	mainState = { account: null, activity: 'pull', link: { mode: 'manual', authType: 'key', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'pulling'));
	const buttons = [...root.querySelectorAll('button')];
	assert.deepEqual(buttons.map((b) => b.textContent), ['Pulling…', 'Push']);
	// Local's buttons mark disabled state with aria-disabled and swallow clicks.
	assert.ok(buttons.every((b) => b.getAttribute('aria-disabled') === 'true'));
	await act(async () => { buttons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.doesNotMatch(document.body.textContent, /This overwrites/, 'no modal while a transfer is running');
});

test('compare view groups differences and syncs only the selected files', async () => {
	mainState = {
		account: null,
		link: { mode: 'account', platform: 'hosting', authType: 'key', host: 'srv123.hstgr.io', port: 65002, username: 'u222', remotePath: '/home/u222/domains/shop.example.com/public_html', domain: 'shop.example.com' },
	};
	compareResult = {
		at: '2026-10-30T00:00:00Z',
		checksum: false,
		entries: [
			{ path: 'wp-content/themes/shop/style.css', type: 'file', status: 'changed', local: { size: 2048, mtime: 1790000000 }, remote: { size: 1900, mtime: 1780000000 }, newer: 'local' },
			{ path: 'wp-content/plugins/new/new.php', type: 'file', status: 'local-only', local: { size: 10, mtime: 1790000000 }, remote: null, newer: null },
			{ path: 'wp-content/uploads/2026/10/photo.jpg', type: 'file', status: 'remote-only', local: null, remote: { size: 3 * 1024 * 1024, mtime: 1790000000 }, newer: null },
		],
	};
	const root = await mount(toolsPanel());
	await click(tab(root, 'Compare & sync files'));
	ipcCalls.length = 0;
	await click(button(root, 'Compare with Hostinger'));
	assert.deepEqual(ipcCalls[0], [IPC.COMPARE, { siteId: 'site1', checksum: false }]);
	assert.match(root.textContent, /1 different on each side · 1 only in local · 1 only on hostinger/);
	assert.match(root.textContent, /Newer in Local/);
	assert.match(root.textContent, /3\.0 MB/);

	// Filter narrows the list
	const filter = root.querySelector('.HGConnect_Filter input');
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(filter, 'themes');
		filter.dispatchEvent(new window.Event('input', { bubbles: true }));
	});
	assert.equal(root.querySelectorAll('.HGConnect_FileRow').length, 1);
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(filter, '');
		filter.dispatchEvent(new window.Event('input', { bubbles: true }));
	});

	// Select the changed theme file and the remote-only upload, then push them
	const rows = [...root.querySelectorAll('.HGConnect_FileRow input')];
	await click(rows[0]);
	await click(rows[2]);
	assert.match(root.textContent, /2 selected/);
	ipcCalls.length = 0;
	await click(button(root, 'Push selected'));
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { fileList: ['wp-content/themes/shop/style.css', 'wp-content/uploads/2026/10/photo.jpg'], purgeCache: true },
	});
	assert.ok(ipcCalls.some(([ch]) => ch === IPC.COMPARE), 'compares again after syncing');
});

test('create-site page pulls a Hostinger website into a new Local site', async () => {
	mainState = { account: { connectedAt: '2026-10-31T00:00:00Z', websites: 4 }, link: null, passwordAuthSupported: true };
	const history = { pushed: [], push(p) { this.pushed.push(p); } };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history }));
	await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

	assert.match(root.textContent, /Pull from Hostinger/);
	const nameInput = root.querySelector('input');
	assert.equal(nameInput.value, 'Shop', 'defaults to the selected website\'s title');
	assert.match(root.textContent, /shop\.local · ~\/Local Sites\/shop/);

	ipcCalls.length = 0;
	await click(button(root, 'Create site & pull'));
	const { siteName, source } = ipcCalls.find(([ch]) => ch === IPC.PULL_NEW_SITE)[1];
	const { progressId, ...rest } = source;
	assert.equal(siteName, 'Shop');
	assert.deepEqual(rest, { kind: 'account', id: SHOP.id });
	assert.match(progressId, /^link-/, 'lets the main process stream progress back to this form');
	assert.match(root.textContent, /Creating Shop at shop\.local/);

	await click(button(root, '← Back'));
	assert.deepEqual(history.pushed, ['/main/create-site']);
});

test('create-site page names the Local site after the domain when the website has no title', async () => {
	siteChoices = [DEFAULT_CHOICES[3]];
	mainState = { account: { connectedAt: '2026-10-31T00:00:00Z', websites: 1 }, link: null, passwordAuthSupported: true };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history: { push() {} } }));
	assert.equal(root.querySelector('input').value, 'agency.example.com');
});

test('an Agency Plan website without a domain is labelled by its id and does not break the new-site name', async () => {
	siteChoices = [{
		id: 'agency:xyz', platform: 'agency', accountUsername: null, orderId: null, domain: null, directory: '', url: null,
		siteTitle: '', websiteType: 'wordpress', installId: null, rootDirectory: null, isEnabled: true, linkable: false, reason: 'no domain', group: 'Agency Plan',
	}];
	mainState = { account: { connectedAt: '2026-10-31T00:00:00Z', websites: 0 }, link: null, passwordAuthSupported: true };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history: { push() {} } }));
	assert.equal(root.querySelector('select option').textContent, 'agency:xyz (no domain)');
	assert.ok(root.querySelector('select option').disabled);
	assert.equal(root.querySelector('input').value, '', 'no title or domain leaves the name for the user to type');
	assert.match(root.textContent, /This website can't be linked: no domain\./);
	assert.equal(button(root, 'Create site & pull').getAttribute('aria-disabled'), 'true');
});

test('brand: Hostinger purple icon tile, add-on card colour and stylesheet accent', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const rootDir = path.join(__dirname, '..');
	const icon = fs.readFileSync(path.join(rootDir, 'icon.svg'), 'utf8');
	assert.match(icon, /<rect width="120" height="120" rx="24" fill="#673de6"\/>/);
	assert.match(icon, /<path fill="#fff" fill-rule="evenodd" d="m17\.8175\.798004v8\.729406/, 'Hostinger\'s H mark in white');
	assert.equal(require('../package.json').bgColor, '#673de6');
	const css = fs.readFileSync(path.join(rootDir, 'lib', 'renderer', 'styles.css'), 'utf8');
	assert.match(css, /--hg-accent: #673de6;/);
	assert.doesNotMatch(css, /#ff492c|orange/i, 'no leftover accent from the previous brand');
});

test('shows an available update and installs it through the main process', async () => {
	const update = { name: 'ConnectLocal for Hostinger', current: '0.1.0', latest: '0.2.0', releaseUrl: 'https://github.com/x/y/releases/tag/v0.2.0', devInstall: false, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update };
	ipcCalls.length = 0;
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for Hostinger 0\.2\.0 is available\. You have 0\.1\.0\./);
	await click(button(root, 'Update'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.INSTALL_UPDATE));

	mainState = { ...mainState, update: { ...update, installed: true } };
	await act(async () => { (listeners[IPC.STATE_CHANGED] || []).forEach((fn) => fn({}, null)); });
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	assert.match(root.textContent, /0\.2\.0 is installed\. Restart Local/);
	await click(button(root, 'Restart Local'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.RESTART_LOCAL));
});

test('a development copy shows the update but no Update button, and the footer can check manually', async () => {
	const update = { name: 'ConnectLocal for Hostinger', current: '0.1.0', latest: null, releaseUrl: null, devInstall: true, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update: { ...update, latest: '0.2.0' } };
	let root = await mount(toolsPanel());
	assert.match(root.textContent, /linked from a development folder/);
	assert.equal(button(root, 'Update'), undefined);
	await act(async () => { ReactDOM.unmountComponentAtNode(root); });

	mainState = { ...mainState, update };
	ipcCalls.length = 0;
	root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for Hostinger 0\.1\.0/);
	await click(button(root, 'Check for updates'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.CHECK_UPDATE));
	assert.match(root.textContent, /You have the latest version\./);
});
