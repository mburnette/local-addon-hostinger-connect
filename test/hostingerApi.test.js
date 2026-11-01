'use strict';

/** The Hostinger API client against a fake fetch that answers with the response shapes in Hostinger's OpenAPI spec (2.6.1). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { HostingerApi, errorMessageFrom, hostnameFromPhpInfo } = require('../lib/main/HostingerApi');
const { HOSTINGER_API_BASE } = require('../lib/constants');

const logger = { info() {}, warn() {}, error() {} };

/** routes: { 'GET /path': (url, init) => [status, body] }. Records every request. */
function fakeFetch(routes) {
	const requests = [];
	const fetchImpl = async (url, init) => {
		const u = new URL(url);
		const key = `${init.method} ${u.pathname}`;
		requests.push({ key, url: u, init, body: init.body ? JSON.parse(init.body) : null });
		const route = routes[key];
		const [status, body, headers = {}] = route ? route(u, init) : [404, { message: 'Not found', correlation_id: 'c-1' }];
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body),
			headers: { get: (name) => headers[name.toLowerCase()] || null },
		};
	};
	return { fetchImpl, requests };
}

const website = (domain, extra = {}) => ({
	domain,
	vhost_type: 'main',
	is_enabled: true,
	username: 'u123456789',
	client_id: 1,
	order_id: 1000000001,
	created_at: '2026-10-01T00:00:00Z',
	root_directory: `/home/u123456789/domains/${domain}/public_html`,
	parent_domain: null,
	website_type: 'wordpress',
	...extra,
});

/** Serves `items` in pages, like GET /api/hosting/v1/websites. */
const paged = (items) => (u) => {
	const page = Number(u.searchParams.get('page')) || 1;
	const perPage = Number(u.searchParams.get('per_page')) || 25;
	return [200, { data: items.slice((page - 1) * perPage, page * perPage), meta: { current_page: page, per_page: perPage, total: items.length } }];
};

test('talks to developers.hostinger.com with a bearer token', async () => {
	assert.equal(HOSTINGER_API_BASE, 'https://developers.hostinger.com');
	const { fetchImpl, requests } = fakeFetch({ 'GET /api/hosting/v1/websites': paged([website('a.example')]) });
	await new HostingerApi({ apiKey: 't-123', fetchImpl, logger }).listWebsites();
	assert.equal(requests[0].url.origin, 'https://developers.hostinger.com');
	assert.equal(requests[0].init.headers.Authorization, 'Bearer t-123');
	assert.equal(requests[0].init.headers.Accept, 'application/json');
	assert.throws(() => new HostingerApi({ apiKey: '', fetchImpl, logger }), /API token is required/);
});

test('validates the token by counting websites from a one-item page', async () => {
	const items = [website('a.example'), website('b.example'), website('c.example')];
	const { fetchImpl, requests } = fakeFetch({ 'GET /api/hosting/v1/websites': paged(items) });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl, logger }).validate(), { websites: 3 });
	assert.equal(requests[0].url.searchParams.get('per_page'), '1');

	const noMeta = fakeFetch({ 'GET /api/hosting/v1/websites': () => [200, { data: [website('a.example')] }] });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: noMeta.fetchImpl, logger }).validate(), { websites: 1 });
});

test('explains a rejected token and one without access', async () => {
	const rejected = fakeFetch({ 'GET /api/hosting/v1/websites': () => [401, { message: 'Unauthenticated.', correlation_id: 'x' }] });
	await assert.rejects(
		new HostingerApi({ apiKey: 't', fetchImpl: rejected.fetchImpl, logger }).validate(),
		(e) => e.status === 401 && /rejected this API token.*hPanel → API \(under Dev tools in the sidebar\)/.test(e.message),
	);
	const forbidden = fakeFetch({ 'GET /api/hosting/v1/websites': () => [403, { message: 'Forbidden' }] });
	await assert.rejects(new HostingerApi({ apiKey: 't', fetchImpl: forbidden.fetchImpl, logger }).validate(), (e) => e.status === 403 && /isn't allowed/.test(e.message));
});

test('explains a network failure instead of passing on fetch\'s bare "fetch failed"', async () => {
	const fetchImpl = async () => {
		const err = new TypeError('fetch failed');
		err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND developers.hostinger.com'), { code: 'ENOTFOUND' });
		throw err;
	};
	const api = new HostingerApi({ apiKey: 't', fetchImpl, logger });
	await assert.rejects(api.validate(), (e) => e.name === 'HostingerApiError' && e.status === 0
		&& /^Could not reach Hostinger's API \(ENOTFOUND\)\. Check your internet connection and try again\.$/.test(e.message));
});

test('lists every page of websites, 100 at a time', async () => {
	const items = Array.from({ length: 230 }, (_, i) => website(`site${i}.example`));
	const { fetchImpl, requests } = fakeFetch({ 'GET /api/hosting/v1/websites': paged(items) });
	const all = await new HostingerApi({ apiKey: 't', fetchImpl, logger }).listWebsites();
	assert.equal(all.length, 230);
	assert.deepEqual(requests.map((r) => [r.url.searchParams.get('page'), r.url.searchParams.get('per_page')]), [['1', '100'], ['2', '100'], ['3', '100']]);
});

test('stops paging at an empty page even when the total is wrong', async () => {
	const { fetchImpl, requests } = fakeFetch({
		'GET /api/hosting/v1/websites': (u) => (u.searchParams.get('page') === '1'
			? [200, { data: [website('a.example')], meta: { current_page: 1, per_page: 100, total: 50 } }]
			: [200, { data: [], meta: { current_page: 2, per_page: 100, total: 50 } }]),
	});
	assert.equal((await new HostingerApi({ apiKey: 't', fetchImpl, logger }).listWebsites()).length, 1);
	assert.equal(requests.length, 2);
});

test('treats a null total as unknown and stops when the server ignores the page number', async () => {
	const nullTotal = fakeFetch({ 'GET /api/hosting/v1/websites': () => [200, { data: [website('a.example')], meta: { current_page: 1, per_page: 1, total: null } }] });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: nullTotal.fetchImpl, logger }).validate(), { websites: 1 });

	const items = Array.from({ length: 100 }, (_, i) => website(`site${i}.example`));
	const stuck = fakeFetch({ 'GET /api/hosting/v1/websites': () => [200, { data: items, meta: { current_page: 1, per_page: 100, total: null } }] });
	assert.equal((await new HostingerApi({ apiKey: 't', fetchImpl: stuck.fetchImpl, logger }).listWebsites()).length, 100);
	assert.equal(stuck.requests.length, 2, 'page 2 answered as page 1 ends the listing without repeating it');
});

test('lists WordPress installations from a bare array or a data envelope', async () => {
	const install = { id: '12345678', username: 'u123456789', domain: 'a.example', site_title: 'A', url: 'https://a.example/', directory: '', is_valid: true, validation_error: null };
	const bare = fakeFetch({ 'GET /api/hosting/v1/wordpress/installations': () => [200, [install]] });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: bare.fetchImpl, logger }).listWordPressInstallations(), [install]);
	const wrapped = fakeFetch({ 'GET /api/hosting/v1/wordpress/installations': () => [200, { data: [install] }] });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: wrapped.fetchImpl, logger }).listWordPressInstallations(), [install]);
});

test('lists Agency Plan WordPress websites, treating 403, 404 and an empty list as none', async () => {
	const items = [{ id: 'uid-1', order_id: 9, platform: 'h5g', state: 'active' }];
	const ok = fakeFetch({ 'GET /api/agency-hosting/v1/websites': paged(items) });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: ok.fetchImpl, logger }).listAgencyWebsites(), items);
	assert.equal(ok.requests[0].url.searchParams.get('website_types'), 'wordpress');

	for (const status of [403, 404]) {
		const none = fakeFetch({ 'GET /api/agency-hosting/v1/websites': () => [status, { message: 'No' }] });
		assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: none.fetchImpl, logger }).listAgencyWebsites(), []);
	}
	const empty = fakeFetch({ 'GET /api/agency-hosting/v1/websites': paged([]) });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: empty.fetchImpl, logger }).listAgencyWebsites(), []);

	const broken = fakeFetch({ 'GET /api/agency-hosting/v1/websites': () => [500, { message: 'Server error' }] });
	await assert.rejects(new HostingerApi({ apiKey: 't', fetchImpl: broken.fetchImpl, logger }).listAgencyWebsites(), /Server error/);
});

test('reads Agency Plan website details, unwrapping a data envelope', async () => {
	const details = { uid: 'uid-1', remote_access: { ssh: { username: 'u1', host: '1.2.3.4', port: 65002, is_enabled: true } } };
	const plain = fakeFetch({ 'GET /api/agency-hosting/v1/websites/uid-1': () => [200, details] });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: plain.fetchImpl, logger }).getAgencyWebsite('uid-1'), details);
	const wrapped = fakeFetch({ 'GET /api/agency-hosting/v1/websites/uid-1': () => [200, { data: details }] });
	assert.deepEqual(await new HostingerApi({ apiKey: 't', fetchImpl: wrapped.fetchImpl, logger }).getAgencyWebsite('uid-1'), details);
});

test('finds the SSH server through the account\'s database host', async () => {
	const { fetchImpl, requests } = fakeFetch({
		'GET /api/hosting/v1/accounts/u123456789/databases': () => [200, {
			data: [
				{ name: 'u123456789_old', user: 'u123456789_old', domain: null, host: '' },
				{ name: 'u123456789_wp', user: 'u123456789_wp', domain: 'a.example', host: 'SRV123.hstgr.io', port: 3306 },
			],
			meta: { current_page: 1, per_page: 100, total: 2 },
		}],
	});
	assert.equal(await new HostingerApi({ apiKey: 't', fetchImpl, logger }).getDatabaseHost('u123456789'), 'srv123.hstgr.io');
	assert.equal(requests[0].url.searchParams.get('per_page'), '100');

	const none = fakeFetch({ 'GET /api/hosting/v1/accounts/u1/databases': () => [200, { data: [] }] });
	assert.equal(await new HostingerApi({ apiKey: 't', fetchImpl: none.fetchImpl, logger }).getDatabaseHost('u1'), null);
});

const PHPINFO_HTML = '<!DOCTYPE html><html><head><style type="text/css">body {background-color: #fff;}</style><title>PHP 8.3.19 - phpinfo()</title></head>'
	+ '<body><div class="center"><table><tr class="h"><td><h1 class="p">PHP Version 8.3.19</h1></td></tr></table>'
	+ '<table>\n<tr><td class="e">System </td><td class="v">Linux us-imm-web123.main-hosting.eu 5.14.0-503.40.1.el9_5.x86_64 #1 SMP x86_64 </td></tr>\n'
	+ '<tr><td class="e">Build Date </td><td class="v">Mar 13 2025 00:00:00 </td></tr>\n</table></div></body></html>';

test('finds the SSH server in the phpinfo() System row', async () => {
	const { fetchImpl } = fakeFetch({
		'GET /api/hosting/v1/accounts/u123456789/websites/a.example/php/php-info': () => [200, { info: PHPINFO_HTML }],
	});
	assert.equal(await new HostingerApi({ apiKey: 't', fetchImpl, logger }).getServerHostname('u123456789', 'a.example'), 'us-imm-web123.main-hosting.eu');

	assert.equal(hostnameFromPhpInfo('System => Linux srv1.example.net 5.14 #1'), 'srv1.example.net');
	assert.equal(hostnameFromPhpInfo('<table><tr><td>Build Date</td><td>today</td></tr></table>'), null);
	assert.equal(hostnameFromPhpInfo('<td class="e">System </td><td class="v">Linux localhost 5.14</td>'), null, 'a hostname without a dot is not a server name');
	assert.equal(hostnameFromPhpInfo(null), null);

	const odd = fakeFetch({ 'GET /api/hosting/v1/accounts/u1/websites/a.example/php/php-info': () => [200, { info: 42 }] });
	assert.equal(await new HostingerApi({ apiKey: 't', fetchImpl: odd.fetchImpl, logger }).getServerHostname('u1', 'a.example'), null);
});

test('lists parked domains and subdomains, and gives up quietly when Hostinger can\'t', async () => {
	const { fetchImpl } = fakeFetch({
		'GET /api/hosting/v1/accounts/u1/websites/a.example/parked-domains': () => [200, [{ username: 'u1', domain: 'a.example.org', parent_domain: 'a.example', root_directory: '/home/u1/domains/a.example/public_html', type: 'domain' }]],
		'GET /api/hosting/v1/accounts/u1/websites/a.example/subdomains': () => [200, { data: [{ username: 'u1', domain: 'a.example', subdomain: 'shop', root_directory: '/home/u1/domains/a.example/public_html/shop' }] }],
	});
	const api = new HostingerApi({ apiKey: 't', fetchImpl, logger });
	assert.deepEqual((await api.listParkedDomains('u1', 'a.example')).map((p) => p.domain), ['a.example.org']);
	assert.deepEqual((await api.listSubdomains('u1', 'a.example')).map((s) => s.subdomain), ['shop']);

	const failing = fakeFetch({});
	const api2 = new HostingerApi({ apiKey: 't', fetchImpl: failing.fetchImpl, logger });
	assert.deepEqual(await api2.listParkedDomains('u1', 'a.example'), []);
	assert.deepEqual(await api2.listSubdomains('u1', 'a.example'), []);
});

test('clears a website\'s cache, scoped to a subfolder install only when there is one', async () => {
	const { fetchImpl, requests } = fakeFetch({
		'DELETE /api/hosting/v1/accounts/u1/websites/a.example/cache/clear': () => [200, { message: 'Request accepted' }],
		'DELETE /api/agency-hosting/v1/websites/uid-1/cache': () => [200, { message: 'Request accepted' }],
	});
	const api = new HostingerApi({ apiKey: 't', fetchImpl, logger });
	await api.clearWebsiteCache({ username: 'u1', domain: 'a.example', directory: '' });
	await api.clearWebsiteCache({ username: 'u1', domain: 'a.example', directory: '/blog/' });
	await api.clearAgencyCache('uid-1');
	assert.deepEqual(requests.map((r) => [r.key, r.url.search]), [
		['DELETE /api/hosting/v1/accounts/u1/websites/a.example/cache/clear', ''],
		['DELETE /api/hosting/v1/accounts/u1/websites/a.example/cache/clear', '?directory=blog'],
		['DELETE /api/agency-hosting/v1/websites/uid-1/cache', ''],
	]);
});

test('reads Hostinger\'s error bodies, including field validation errors', () => {
	assert.equal(errorMessageFrom({ message: 'Domain not found', correlation_id: 'x' }, 404), 'Domain not found');
	assert.equal(errorMessageFrom({ errors: { domain: ['The domain field is required.'], page: ['Bad page.'] } }, 422), 'The domain field is required. Bad page.');
	assert.equal(errorMessageFrom(null, 502), 'Hostinger API request failed (HTTP 502)');
});

test('retries after a rate limit and accepts an empty success body', async () => {
	let calls = 0;
	const { fetchImpl } = fakeFetch({
		'GET /api/hosting/v1/websites': () => {
			calls += 1;
			return calls === 1 ? [429, { message: 'Too many requests' }, { 'retry-after': '0.001' }] : [200, { data: [], meta: { total: 0 } }];
		},
		'DELETE /api/agency-hosting/v1/websites/uid-1/cache': () => [204, undefined],
	});
	const api = new HostingerApi({ apiKey: 't', fetchImpl, logger });
	assert.deepEqual(await api.validate(), { websites: 0 });
	assert.equal(calls, 2);
	await api.clearAgencyCache('uid-1');
});
