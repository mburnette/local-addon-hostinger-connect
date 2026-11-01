'use strict';

const { HOSTINGER_API_BASE } = require('../constants');

class HostingerApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = 'HostingerApiError';
		this.status = status;
		this.body = body;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Largest page the paginated Hostinger endpoints accept. */
const PER_PAGE = 100;
/** Stops a misbehaving paginated listing from looping forever. */
const MAX_PAGES = 100;

const HOSTNAME_RE = /^[a-z0-9.-]+$/i;

/**
 * Pulls the most useful human-readable message out of a Hostinger error body. Hostinger answers
 * `{ message, errors: { field: [messages] }, correlation_id }`; validation errors are only in `errors`.
 */
function errorMessageFrom(body, status) {
	if (body && typeof body === 'object') {
		if (typeof body.message === 'string' && body.message) return body.message;
		if (typeof body.error === 'string' && body.error) return body.error;
		const errors = Array.isArray(body.errors) ? body.errors : body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : [];
		const messages = errors.flat().map((e) => (typeof e === 'string' ? e : e && (e.message || e.code))).filter(Boolean);
		if (messages.length) return messages.join(' ');
	}
	return `Hostinger API request failed (HTTP ${status})`;
}

/** `data` from a `{ data: [...] }` envelope, or the body itself when it is already an array. */
const listFrom = (body) => (Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : []);

/** A listing's `meta[key]` as a number, or null when it is missing, null or not numeric. */
const metaNumber = (body, key) => {
	const value = body && body.meta && body.meta[key];
	if (value === undefined || value === null || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

/**
 * Reads the server's hostname from phpinfo() output: the `System` row reads "Linux us-imm-web123.main-hosting.eu
 * 5.14.0 …", so the hostname is its second word. Works on the HTML and the plain-text form. Null when not found;
 * never throws.
 */
function hostnameFromPhpInfo(info) {
	if (typeof info !== 'string' || !info) return null;
	const text = info
		.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/=&gt;|=>/g, ' ');
	const match = /(?:^|\s)System\s+(\S+)\s+(\S+)/.exec(text);
	if (!match) return null;
	const hostname = match[2].toLowerCase();
	return HOSTNAME_RE.test(hostname) && hostname.includes('.') ? hostname : null;
}

/**
 * Thin client for the Hostinger public API (https://developers.hostinger.com, OpenAPI spec 2.6.1). An API token,
 * created in hPanel → API (under Dev tools in the sidebar), is sent as a bearer token on every request. The API lists the account's web
 * hosting websites and WordPress installations (and Agency Plan websites), their databases, parked domains and
 * subdomains, and clears caches. It has no SSH endpoints for web hosting: the SSH server is found through the
 * database host (the same machine) or the `System` line of phpinfo(), and SSH keys are added by hand in hPanel.
 * Files and the database move over SSH.
 */
class HostingerApi {
	constructor({ apiKey, fetchImpl = globalThis.fetch, base = HOSTINGER_API_BASE, logger = console }) {
		if (!apiKey) throw new HostingerApiError('A Hostinger API token is required.', 0);
		this._apiKey = apiKey;
		this._fetch = fetchImpl;
		this._base = base;
		this._logger = logger;
	}

	/** Checks the token (Hostinger has no dedicated endpoint for that) and counts its websites: { websites }. */
	async validate() {
		const { data } = await this.request('GET', '/api/hosting/v1/websites', { query: { page: 1, per_page: 1 } });
		const total = metaNumber(data, 'total');
		return { websites: total === null ? listFrom(data).length : total };
	}

	/**
	 * Every web hosting website of the token's account(s), all pages: { domain, vhost_type, is_enabled, username,
	 * order_id, root_directory, parent_domain, website_type }. `username` and `root_directory` are null for websites
	 * that don't run on a CloudLinux account (Website Builder, Horizons).
	 */
	listWebsites() {
		return this._paginate('/api/hosting/v1/websites');
	}

	/** WordPress installations of web hosting accounts (not Agency Plan): { id, username, domain, site_title, url, directory, is_valid }. */
	async listWordPressInstallations() {
		const { data } = await this.request('GET', '/api/hosting/v1/wordpress/installations');
		return listFrom(data);
	}

	/** Agency Plan WordPress websites, all pages. An account without an Agency Plan has none (403/404 included). */
	async listAgencyWebsites() {
		try {
			return await this._paginate('/api/agency-hosting/v1/websites', { website_types: 'wordpress' });
		} catch (e) {
			if (e.status === 403 || e.status === 404) return [];
			throw e;
		}
	}

	/** One Agency Plan website with its domains, preview domain and SSH login (`remote_access.ssh`). */
	async getAgencyWebsite(uid) {
		const { data } = await this.request('GET', `/api/agency-hosting/v1/websites/${encodeURIComponent(uid)}`);
		return data && data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
	}

	/**
	 * The MySQL host of the account's databases (e.g. srv123.hstgr.io). On shared and cloud hosting it is the same
	 * machine that serves SSH, so it doubles as the SSH host. Null when the account has no database with a host.
	 */
	async getDatabaseHost(username) {
		const { data } = await this.request('GET', `/api/hosting/v1/accounts/${encodeURIComponent(username)}/databases`, { query: { per_page: PER_PAGE } });
		const db = listFrom(data).find((d) => d && typeof d.host === 'string' && d.host.trim());
		return db ? db.host.trim().toLowerCase() : null;
	}

	/** The web server's hostname from the website's phpinfo() `System` row (also the SSH server), or null. */
	async getServerHostname(username, domain) {
		const { data } = await this.request('GET', `/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/php/php-info`);
		return hostnameFromPhpInfo(data && data.info);
	}

	/** Domains parked on (aliases of) a website: [{ domain, parent_domain, root_directory, type }]. [] on any error. */
	listParkedDomains(username, domain) {
		return this._bestEffortList(`/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/parked-domains`, 'parked domains');
	}

	/** A website's subdomains, each with its own folder: [{ domain, subdomain, root_directory }]. [] on any error. */
	listSubdomains(username, domain) {
		return this._bestEffortList(`/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/subdomains`, 'subdomains');
	}

	/** Clears the website's server cache and Hostinger CDN; `directory` limits it to a WordPress install in a subfolder. */
	async clearWebsiteCache({ username, domain, directory } = {}) {
		const dir = String(directory || '').replace(/^\/+|\/+$/g, '');
		await this.request('DELETE', `/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/cache/clear`, {
			query: dir ? { directory: dir } : undefined,
		});
	}

	/** Clears an Agency Plan website's cache. */
	async clearAgencyCache(uid) {
		await this.request('DELETE', `/api/agency-hosting/v1/websites/${encodeURIComponent(uid)}/cache`);
	}

	async _bestEffortList(path, what) {
		try {
			const { data } = await this.request('GET', path);
			return listFrom(data);
		} catch (e) {
			this._logger.warn(`Could not list Hostinger ${what}: ${e.message}`);
			return [];
		}
	}

	/**
	 * Collects every page of a `{ data, meta: { current_page, per_page, total } }` listing. Stops at an empty page, once
	 * `total` items are in (or, without a total, at a short page), and when the server answers with a page other than
	 * the one asked for (it ignored `page`, so asking again would only repeat it).
	 */
	async _paginate(path, query = {}) {
		const items = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const { data } = await this.request('GET', path, { query: { ...query, page, per_page: PER_PAGE } });
			const batch = listFrom(data);
			const current = metaNumber(data, 'current_page');
			if (!batch.length || (current !== null && current !== page)) break;
			items.push(...batch);
			const total = metaNumber(data, 'total');
			if (total !== null ? items.length >= total : batch.length < PER_PAGE) break;
		}
		return items;
	}

	async request(method, path, { query, json } = {}, attempt = 0) {
		const url = new URL(`${this._base}${path}`);
		if (query) {
			Object.entries(query).forEach(([k, v]) => {
				if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
			});
		}
		const headers = { Authorization: `Bearer ${this._apiKey}`, Accept: 'application/json' };
		let body;
		if (json) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(json);
		}
		let res;
		try {
			res = await this._fetch(url.toString(), { method, headers, body });
		} catch (e) {
			// fetch() only says "fetch failed" when the network is down or DNS fails; say what that means.
			const cause = e && e.cause && (e.cause.code || e.cause.message);
			throw new HostingerApiError(`Could not reach Hostinger's API (${cause || e.message}). Check your internet connection and try again.`, 0, null);
		}
		const data = await res.json().catch(() => null);
		if (res.status === 429 && attempt < 4) {
			const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2 ** attempt * 5;
			this._logger.warn(`Hostinger API rate limited; retrying in ${retryAfter}s`);
			await sleep(retryAfter * 1000);
			return this.request(method, path, { query, json }, attempt + 1);
		}
		if (res.status === 401) {
			throw new HostingerApiError('Hostinger rejected this API token. It may have expired or been revoked; create a new one in '
				+ 'hPanel → API (under Dev tools in the sidebar).', 401, data);
		}
		if (res.status === 403) {
			throw new HostingerApiError(`This API token isn't allowed to ${method} ${path}. Create a token in hPanel → API (under Dev tools) `
				+ 'from the account that owns the hosting plan.', 403, data);
		}
		if (!res.ok) throw new HostingerApiError(errorMessageFrom(data, res.status), res.status, data);
		return { status: res.status, data: data || {} };
	}
}

module.exports = { HostingerApi, HostingerApiError, errorMessageFrom, hostnameFromPhpInfo };
