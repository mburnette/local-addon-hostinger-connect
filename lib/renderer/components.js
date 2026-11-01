'use strict';

const { ipcRenderer, shell } = require('electron');
const { ipcAsync, confirm } = require('@getflywheel/local/renderer');
const {
	Button,
	Checkbox,
	BasicInput,
	FlyModal,
	PrimaryButton,
	Spinner,
	TextButton,
	Title,
} = require('@getflywheel/local-components');

const { IPC } = require('../constants');

/** Hostinger's guides: creating an API token, connecting over SSH, and adding an SSH key in hPanel. */
const API_TOKEN_HELP_URL = 'https://www.hostinger.com/support/10840865-what-is-hostinger-api/';
const SSH_HELP_URL = 'https://www.hostinger.com/support/1583245-how-to-connect-to-a-hosting-plan-via-ssh/';
const SSH_KEY_HELP_URL = 'https://www.hostinger.com/support/5634532-how-to-generate-ssh-keys-and-add-them-to-hpanel/';

/** Where hPanel lists a website's SSH login and keys (shared and cloud plans). */
const SSH_ACCESS_PATH = 'Websites → Manage → Advanced → SSH Access';

/** Hostinger's SSH port on shared and cloud hosting. */
const DEFAULT_SSH_PORT = '65002';

const errorText = (e) => (e && (e.messageMain || e.message)) || String(e);

module.exports = function createComponents({ React }) {
	const h = React.createElement;
	const { useCallback, useEffect, useState } = React;

	/** Loads add-on state for a site and keeps it fresh when the main process reports changes. */
	function useHostingerState(siteId) {
		const [state, setState] = useState(null);
		const refresh = useCallback(() => ipcAsync(IPC.GET_STATE, siteId).then(setState).catch(() => {}), [siteId]);
		useEffect(() => {
			refresh();
			const onChange = (_event, changedSiteId) => {
				if (!changedSiteId || changedSiteId === siteId) refresh();
			};
			ipcRenderer.on(IPC.STATE_CHANGED, onChange);
			return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, onChange);
		}, [siteId, refresh]);
		return [state, refresh];
	}

	/** Wraps an async action with busy + error state. */
	function useAction() {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const run = useCallback(async (fn) => {
			setBusy(true);
			setError(null);
			try {
				return await fn();
			} catch (e) {
				setError(errorText(e));
				return undefined;
			} finally {
				setBusy(false);
			}
		}, []);
		return { busy, error, setError, run };
	}

	/** Step-by-step progress the main process reports while connecting or linking. `start()` returns a progressId. */
	function useLinkProgress() {
		const [progress, setProgress] = useState(null);
		const idRef = React.useRef(null);
		useEffect(() => {
			const onProgress = (_event, id, message) => {
				if (id && id === idRef.current) setProgress(message);
			};
			ipcRenderer.on(IPC.LINK_PROGRESS, onProgress);
			return () => ipcRenderer.removeListener(IPC.LINK_PROGRESS, onProgress);
		}, []);
		const start = () => {
			idRef.current = `link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setProgress(null);
			return idRef.current;
		};
		return { progress, start };
	}

	const isChecked = (value, previous) => (typeof value === 'boolean' ? value : !previous);

	const openLink = (url) => (e) => {
		e.preventDefault();
		shell.openExternal(url);
	};

	function Field({ label, help, children }) {
		return h('label', { className: 'HGConnect_Field' },
			h('span', { className: 'HGConnect_FieldLabel' }, label),
			children,
			help ? h('span', { className: 'HGConnect_Help' }, help) : null);
	}

	function TextInput({ value, onChange, type = 'text', placeholder, disabled }) {
		return h(BasicInput, {
			type,
			value: value || '',
			placeholder,
			disabled,
			onChange: (e) => onChange(e.target.value),
		});
	}

	function ErrorNote({ error }) {
		return error ? h('div', { className: 'HGConnect_Error', role: 'alert' }, error) : null;
	}

	function BusyNote({ busy, children }) {
		return busy ? h('div', { className: 'HGConnect_Busy' }, h(Spinner, null), h('span', null, children)) : null;
	}

	function Tabs({ value, onChange, tabs, className = 'HGConnect_Tabs' }) {
		return h('div', { className, role: 'tablist' },
			tabs.map(([key, label]) => h('button', {
				key,
				type: 'button',
				role: 'tab',
				'aria-selected': value === key,
				className: `HGConnect_Tab${value === key ? ' is-active' : ''}`,
				onClick: () => onChange(key),
			}, label)));
	}

	function PublicKeyBox() {
		const [publicKey, setPublicKey] = useState('');
		const [copied, setCopied] = useState(false);
		useEffect(() => {
			ipcAsync(IPC.GET_PUBLIC_KEY).then(setPublicKey).catch(() => {});
		}, []);
		const copy = () => {
			navigator.clipboard.writeText(publicKey).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		};
		return h('div', { className: 'HGConnect_KeyBox' },
			h('textarea', { readOnly: true, value: publicKey, rows: 4, className: 'HGConnect_KeyText' }),
			h(TextButton, { onClick: copy, disabled: !publicKey }, copied ? 'Copied' : 'Copy public key'));
	}

	/** Password or SSH key, as radio buttons. Password is offered only where the platform supports it. */
	function AuthChoice({ state, value, onChange }) {
		return h('div', { className: 'HGConnect_AuthChoice' },
			state.passwordAuthSupported
				? h('label', null, h('input', { type: 'radio', checked: value === 'password', onChange: () => onChange('password') }), ' Password')
				: null,
			h('label', null, h('input', { type: 'radio', checked: value === 'key', onChange: () => onChange('key') }), ' SSH key'));
	}

	/** Options, wording and channel for each direction. */
	const DIRECTIONS = {
		push: {
			channel: IPC.PUSH,
			verb: 'Push',
			gerund: 'Pushing',
			button: 'Push to Hostinger',
			defaults: () => ({ files: true, database: true, deleteRemote: true, purgeCache: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in app/public except wp-config.php)'],
				['database', 'Database (with URL search & replace)'],
				options.files && ['deleteRemote', 'Delete files on Hostinger that are not in Local'],
				// Hostinger's server cache and CDN can only be cleared through the API, so a manual link clears WordPress's own caches.
				['purgeCache', link.mode === 'account'
					? 'Clear Hostinger caches afterwards (server cache, CDN and LiteSpeed)'
					: 'Clear WordPress and LiteSpeed caches afterwards (the server cache and CDN need an API link)'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} on ${where} with ${site.name} from Local. Visitors see the change right away.`,
				options.database && 'The Hostinger database is replaced; the previous one is saved as local-backup-before-push.sql in a private .hostinger-connect folder in your Hostinger home folder, outside the website.',
				options.files && options.deleteRemote && 'Files on Hostinger that do not exist locally will be deleted. Hostinger\'s own files (must-use plugins, .private, default.php) and other websites in subfolders are never touched.',
				'This push does not make a Hostinger backup. To roll back, restore one of Hostinger\'s automatic backups in hPanel → Websites → Manage → Files → Backups.',
			],
		},
		pull: {
			channel: IPC.PULL,
			verb: 'Pull',
			gerund: 'Pulling',
			button: 'Pull from Hostinger',
			defaults: () => ({ files: true, database: true, backupLocal: true, deleteLocal: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in the webroot except wp-config.php, server config and caches)'],
				['database', 'Database (with URL search & replace)'],
				options.database && ['backupLocal', 'Back up the Local database first'],
				options.files && ['deleteLocal', 'Delete Local files that are not on Hostinger'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} of ${site.name} in Local with ${where}.`,
				options.database && (options.backupLocal
					? 'The Local database is replaced; the previous one is saved in app/sql/local-backup-before-pull.sql.'
					: 'The Local database is replaced without a backup.'),
				options.files && options.deleteLocal && 'Local files that do not exist on Hostinger will be deleted.',
				options.files && 'Local files the pull replaces or deletes are moved to app/hostinger-backups (the last 3 pulls are kept).',
			],
		},
	};

	const linkTarget = (link) => link.label || link.domain || link.host;

	/**
	 * Push or pull options, shared by the Tools panel and the header modal. Inside the modal the modal itself is the
	 * confirmation and it closes as soon as the transfer starts (progress shows in the site overlay, like Local Connect).
	 */
	function TransferForm({ direction, site, link, activity, inModal = false, onStarted }) {
		const config = DIRECTIONS[direction];
		const [options, setOptions] = useState(() => config.defaults(link));
		const { busy, error, run } = useAction();
		const toggle = (key) => (value) => setOptions((o) => ({ ...o, [key]: isChecked(value, o[key]) }));
		const nothingSelected = !options.files && !options.database;
		const where = linkTarget(link);
		const what = options.files && options.database ? 'files and database' : options.files ? 'files' : 'database';
		const consequences = config.consequences({ what, where, site, link, options }).filter(Boolean);
		const running = busy || activity === direction;

		const start = async () => {
			if (!inModal) {
				await confirm({
					title: `${config.verb} ${what} ${direction === 'push' ? 'to' : 'from'} Hostinger?`,
					message: h('div', null, consequences.map((text) => h('p', { key: text }, text))),
					buttonText: config.verb,
				});
			}
			const request = ipcAsync(config.channel, { siteId: site.id, options });
			if (onStarted) {
				onStarted();
				// Failures surface as a site banner, as with Local Connect.
				request.catch(() => {});
				return;
			}
			await run(() => request);
		};

		return h('div', { className: 'HGConnect_TransferForm' },
			h('div', { className: 'HGConnect_Options' },
				config.checkboxes(link, options).filter(Boolean).map(([key, label]) => h(Checkbox, {
					key,
					label,
					checked: options[key],
					onChange: toggle(key),
				}))),
			inModal ? h('ul', { className: 'HGConnect_Consequences' }, consequences.map((text) => h('li', { key: text }, text))) : null,
			h(ErrorNote, { error }),
			h('div', { className: 'HGConnect_Actions' },
				h(PrimaryButton, { onClick: start, disabled: running || Boolean(activity) || nothingSelected }, running ? `${config.gerund}…` : config.button)));
	}

	/** The hPanel page that holds a link's SSH settings: the SSH Access page, or an Agency Plan website's Remote access page. */
	const sshPageFor = (link) => (link && link.platform === 'agency' ? 'the website\'s Remote access page in hPanel' : `hPanel → ${SSH_ACCESS_PATH}`);

	const describeAuth = (link) => (link.authType === 'password'
		? `SSH password (stored encrypted). Add Local's SSH key in ${sshPageFor(link)} and link again to use the key instead.`
		: 'Local\'s SSH key');

	/** Hosting account a link belongs to: the hPanel username (u123456789), or the Agency Plan site. */
	const describeAccount = (link) => {
		if (link.platform === 'agency') return `Agency Plan${link.agencyUid ? ` (website ${link.agencyUid})` : ''}`;
		return link.accountUsername || null;
	};

	/** Folders inside the webroot that are never transferred: other WordPress installs and other websites. */
	const neverSynced = (link) => [...new Set([...(link.nested || []), ...(link.excludeDirs || [])])];

	const describeLast = (last) => `${new Date(last.at).toLocaleString()} (${[last.files && 'files', last.database && 'database'].filter(Boolean).join(' + ')}, ${last.seconds}s)`;

	function LinkedView({ site, state }) {
		const { link } = state;
		const test = useAction();
		const unlink = useAction();
		const [testResult, setTestResult] = useState(null);
		const [direction, setDirection] = useState('push');

		const skipped = neverSynced(link);
		const rows = [
			link.label && ['Website', link.label],
			link.domain && !String(link.label || '').includes(link.domain) && ['Domain', link.domain],
			describeAccount(link) && ['Hosting account', describeAccount(link)],
			['SSH login', `${link.username}@${link.host}${Number(link.port) !== 22 ? `:${link.port}` : ''}`],
			link.remotePath && ['Remote path', link.remotePath],
			skipped.length ? ['Never synced', `Other sites in subfolders: ${skipped.join(', ')}`] : null,
			['Authentication', describeAuth(link)],
			link.lastPush && ['Last push', describeLast(link.lastPush)],
			link.lastPull && ['Last pull', describeLast(link.lastPull)],
		].filter(Boolean);

		return h('div', null,
			h('table', { className: 'HGConnect_Table' },
				h('tbody', null, rows.map(([k, v]) => h('tr', { key: k }, h('th', null, k), h('td', null, v))))),
			h(Tabs, {
				value: direction,
				onChange: setDirection,
				tabs: [['push', 'Push to Hostinger'], ['pull', 'Pull from Hostinger'], ['compare', 'Compare & sync files']],
				className: 'HGConnect_Tabs HGConnect_Tabs--Transfer',
			}),
			direction === 'compare'
				? h(CompareView, { site, activity: state.activity })
				: h(TransferForm, { key: direction, direction, site, link, activity: state.activity }),
			h('div', { className: 'HGConnect_Secondary' },
				h(TextButton, {
					disabled: test.busy,
					onClick: () => test.run(async () => {
						setTestResult(null);
						const remote = await ipcAsync(IPC.TEST_CONNECTION, site.id);
						// A push or pull installs WP-CLI in a private folder when the server has PHP but no `wp`.
						const wpCli = remote.hasWpCli ? '' : remote.hasPhp
							? ' (WP-CLI missing: the first database push or pull installs it in a private folder)'
							: ' (WP-CLI and PHP missing: database transfers will fail)';
						setTestResult(`Connected. WordPress found at ${remote.remotePath}${wpCli}.`);
					}),
				}, test.busy ? 'Testing…' : 'Test connection'),
				h(TextButton, {
					intent: 'destructive',
					disabled: unlink.busy || Boolean(state.activity),
					onClick: () => unlink.run(() => ipcAsync(IPC.UNLINK_SITE, { siteId: site.id })),
				}, 'Unlink from Hostinger')),
			testResult ? h('div', { className: 'HGConnect_Success' }, testResult) : null,
			h(ErrorNote, { error: test.error || unlink.error }));
	}

	/** Connects a Hostinger API token, which lists the account's websites and where each one lives on the server. */
	function AccountConnectForm() {
		const [apiKey, setApiKey] = useState('');
		const action = useAction();

		return h('div', { className: 'HGConnect_Form' },
			h('p', { className: 'HGConnect_Intro' },
				'Connect with a Hostinger API token. Local then lists your WordPress websites, finds each one\'s SSH server and folder for you, and clears Hostinger\'s cache after a push. In hPanel, open ',
				h('strong', null, 'API'),
				' (under Dev tools in the sidebar), click ',
				h('strong', null, 'New'),
				', pick an expiry date and click Generate. ',
				h('a', { href: '#', onClick: openLink(API_TOKEN_HELP_URL) }, 'Hostinger\'s guide')),
			h(Field, { label: 'API token', help: 'The token has the same access as your hPanel login and is shown only once. It is stored encrypted with your system keychain.' },
				h(TextInput, { value: apiKey, onChange: setApiKey, type: 'password' })),
			h(BusyNote, { busy: action.busy }, 'Checking the token…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'HGConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !apiKey.trim(),
					onClick: () => action.run(() => ipcAsync(IPC.CONNECT_ACCOUNT, { apiKey })),
				}, action.busy ? 'Connecting…' : 'Connect account')));
	}

	/**
	 * "Blog — blog.example.com/shop (disabled)": title when it says more than the domain, folder for subfolder installs.
	 * An Agency Plan website without a domain falls back to its id so the option is never blank or "null".
	 */
	const choiceLabel = (choice) => {
		const address = `${choice.domain || choice.id}${choice.directory ? `/${choice.directory}` : ''}`;
		const title = choice.siteTitle && choice.siteTitle !== choice.domain ? `${choice.siteTitle} — ` : '';
		return `${title}${address}${choice.linkable === false ? ` (${choice.reason || 'unavailable'})` : ''}`;
	};
	const choiceName = (choice) => choice.siteTitle || choice.domain || '';
	const countWebsites = (n) => (typeof n === 'number' ? ` · ${n} website${n === 1 ? '' : 's'}` : '');

	/** Groups site choices under their `group` label (hosting account or Agency Plan), keeping the main process's order. */
	const groupChoices = (choices) => {
		const groups = new Map();
		choices.forEach((choice) => {
			const label = choice.group || 'Websites';
			if (!groups.has(label)) groups.set(label, []);
			groups.get(label).push(choice);
		});
		return [...groups.entries()];
	};

	/**
	 * Picks a WordPress website from the connected Hostinger account. `onSubmit({ kind: 'account', id, password? , … })`
	 * links it (or, on the new-site page, creates a site and pulls it). The main process looks the choice up again by
	 * `id`; the SSH password is only sent when the user typed one.
	 */
	function AccountSetup({ state, submitLabel, canSubmit = true, onSubmit, onSiteSelected }) {
		const [choices, setChoices] = useState(null);
		const [selected, setSelected] = useState('');
		const [password, setPassword] = useState('');
		const action = useAction();
		const { progress, start } = useLinkProgress();

		const loadSites = useCallback(() => action.run(async () => {
			const list = await ipcAsync(IPC.LIST_SITES);
			setChoices(list);
			const first = list.find((c) => c.linkable !== false) || list[0];
			if (first) setSelected(first.id);
		}), [action.run]);

		useEffect(() => {
			if (state.account && choices === null) loadSites();
		}, [state.account]);

		const choice = choices && choices.find((c) => c.id === selected);
		const usable = Boolean(choice) && choice.linkable !== false;

		useEffect(() => {
			if (choice && onSiteSelected) onSiteSelected(choice);
		}, [choice && choice.id]);

		if (!state.account) return h(AccountConnectForm);

		const { account } = state;
		const sshPage = sshPageFor(choice);
		return h('div', { className: 'HGConnect_Form' },
			h('div', { className: 'HGConnect_Account' },
				h('span', null, 'Connected with a ', h('strong', null, 'Hostinger API token'), countWebsites(account.websites)),
				h(TextButton, {
					onClick: () => action.run(async () => {
						await ipcAsync(IPC.DISCONNECT_ACCOUNT);
						setChoices(null);
					}),
				}, 'Disconnect')),
			choices === null
				// A failed listing shows its error (below) and the Refresh button instead of spinning forever.
				? h(BusyNote, { busy: !action.error }, 'Loading your Hostinger websites…')
				: choices.length === 0
					? h('p', null, 'No WordPress websites were found for this API token. Website Builder and Horizons sites can\'t be linked; for anything else, link with SFTP/SSH details instead.')
					: h(Field, { label: 'Website', help: choice && !usable ? `This website can't be linked: ${choice.reason || 'unavailable'}.` : null },
						h('select', { className: 'HGConnect_Select', value: selected, onChange: (e) => setSelected(e.target.value) },
							groupChoices(choices).map(([label, group]) => h('optgroup', { key: label, label },
								group.map((c) => h('option', { key: c.id, value: c.id, disabled: c.linkable === false }, choiceLabel(c))))))),
			choices && choices.length
				? h(React.Fragment, null,
					h(Field, {
						label: 'Local\'s SSH key',
						help: h(React.Fragment, null,
							`Turn SSH on and add this key in ${sshPage} (SSH keys → Add SSH key). Local then logs in with it. `,
							h('a', { href: '#', onClick: openLink(SSH_KEY_HELP_URL) }, 'How to add a key')),
					}, h(PublicKeyBox)),
					state.passwordAuthSupported
						? h(Field, {
							label: 'SSH password (optional)',
							help: `Only needed if you haven't added Local's key: the SSH password set in ${sshPage}. Stored encrypted with your system keychain.`,
						}, h(TextInput, { value: password, onChange: setPassword, type: 'password' }))
						: null)
				: null,
			h(BusyNote, { busy: action.busy && choices !== null }, progress || 'Linking…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'HGConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !usable || !canSubmit,
					onClick: () => action.run(() => onSubmit({
						kind: 'account',
						id: choice.id,
						...(password ? { password } : {}),
						progressId: start(),
					})),
				}, submitLabel),
				h(TextButton, { disabled: action.busy, onClick: loadSites }, 'Refresh list')));
	}

	/**
	 * SSH details copied from hPanel's SSH Access page, for users without an API token or websites the token can't see.
	 * `onSubmit({ kind: 'manual', host, port, username, authType, password, remotePath, domain, progressId })`.
	 */
	function ManualSetup({ state, submitLabel, canSubmit = true, onSubmit }) {
		const [form, setForm] = useState({ host: '', port: DEFAULT_SSH_PORT, username: '', authType: state.passwordAuthSupported ? 'password' : 'key', password: '', remotePath: '', domain: '' });
		const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
		const action = useAction();
		const { progress, start } = useLinkProgress();
		const complete = form.host.trim() && form.port.trim() && form.username.trim() && (form.authType === 'key' || form.password);

		return h('div', { className: 'HGConnect_Form' },
			h('p', { className: 'HGConnect_Intro' },
				'No API token? Copy the login from hPanel: open ',
				h('strong', null, SSH_ACCESS_PATH),
				' and turn SSH on if it is off. That page lists the IP, port and username. SSH is included with Premium, Business and Cloud plans. ',
				h('a', { href: '#', onClick: openLink(SSH_HELP_URL) }, 'Hostinger\'s guide')),
			h('div', { className: 'HGConnect_Row' },
				h(Field, { label: 'SSH IP', help: 'The IP address shown on the SSH Access page.' }, h(TextInput, { value: form.host, onChange: set('host'), placeholder: '203.0.113.10' })),
				h(Field, { label: 'Port' }, h(TextInput, { value: form.port, onChange: set('port'), placeholder: DEFAULT_SSH_PORT }))),
			h(Field, { label: 'Username' }, h(TextInput, { value: form.username, onChange: set('username'), placeholder: 'u123456789' })),
			h(AuthChoice, { state, value: form.authType, onChange: set('authType') }),
			form.authType === 'password'
				? h(Field, { label: 'Password', help: 'The SSH password set on the SSH Access page. Stored encrypted with your system keychain.' }, h(TextInput, { value: form.password, onChange: set('password'), type: 'password' }))
				: h(Field, { label: 'Public key', help: 'Add it on the SSH Access page first (SSH keys → Add SSH key).' }, h(PublicKeyBox)),
			h(Field, { label: 'Website domain (optional)', help: 'Used to find the website\'s folder (~/domains/<domain>/public_html), and as its URL if the database has no home URL yet.' },
				h(TextInput, { value: form.domain, onChange: set('domain'), placeholder: 'example.com' })),
			h(Field, { label: 'Remote path (optional)', help: 'The folder that holds wp-config.php. Detected automatically when left empty.' },
				h(TextInput, { value: form.remotePath, onChange: set('remotePath'), placeholder: '/home/u123456789/domains/example.com/public_html' })),
			h(BusyNote, { busy: action.busy }, progress || 'Connecting…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'HGConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !complete || !canSubmit,
					onClick: () => action.run(() => onSubmit({ kind: 'manual', ...form, progressId: start() })),
				}, action.busy ? 'Connecting…' : submitLabel)));
	}

	function SetupView(props) {
		const [mode, setMode] = useState('account');
		return h('div', null,
			h(Tabs, { value: mode, onChange: setMode, tabs: [['account', 'Hostinger API'], ['manual', 'SFTP/SSH details']] }),
			mode === 'account' ? h(AccountSetup, props) : h(ManualSetup, props));
	}

	// ---------------------------------------------------------------- updates

	/** Announces a newer release and installs it through Local's add-on installer. */
	function UpdateNotice({ update }) {
		const action = useAction();
		if (!update) return null;
		const error = action.error || update.error;
		if (update.installed) {
			return h('div', { className: 'HGConnect_Update', role: 'status' },
				h('span', null, `${update.name} ${update.latest} is installed. Restart Local to start using it.`),
				h('div', { className: 'HGConnect_UpdateActions' },
					h(PrimaryButton, { onClick: () => action.run(() => ipcAsync(IPC.RESTART_LOCAL)) }, 'Restart Local')));
		}
		if (!update.latest) return error && !update.checking ? h(ErrorNote, { error }) : null;
		const busy = action.busy || update.installing;
		return h('div', { className: 'HGConnect_Update', role: 'status' },
			h('span', null, `${update.name} ${update.latest} is available. You have ${update.current}.`),
			update.devInstall
				? h('span', { className: 'HGConnect_Help' }, 'This copy is linked from a development folder, so update that folder instead.')
				: null,
			h('div', { className: 'HGConnect_UpdateActions' },
				update.devInstall
					? null
					: h(PrimaryButton, { disabled: busy, onClick: () => action.run(() => ipcAsync(IPC.INSTALL_UPDATE)) }, busy ? 'Updating…' : 'Update'),
				update.releaseUrl ? h(TextButton, { onClick: () => shell.openExternal(update.releaseUrl) }, 'What\'s new') : null),
			error ? h(ErrorNote, { error }) : null);
	}

	/** Version line with a manual "Check for updates". */
	function VersionFooter({ update }) {
		const [checked, setChecked] = useState(false);
		if (!update) return null;
		const check = () => ipcAsync(IPC.CHECK_UPDATE).then(() => setChecked(true)).catch(() => {});
		const upToDate = checked && !update.checking && !update.latest && !update.error;
		return h('div', { className: 'HGConnect_Version' },
			h('span', null, `${update.name} ${update.current}`),
			update.checking
				? h('span', null, 'Checking for updates…')
				: upToDate
					? h('span', null, 'You have the latest version.')
					: update.latest ? null : h(TextButton, { onClick: check }, 'Check for updates'));
	}

	const linkSite = (siteId) => ({ kind, ...source }) => (kind === 'account'
		? ipcAsync(IPC.LINK_ACCOUNT_SITE, { siteId, ...source })
		: ipcAsync(IPC.LINK_MANUAL, { siteId, ...source }));

	function HostingerPanel({ site }) {
		const [state] = useHostingerState(site && site.id);
		if (!site) return null;
		return h('div', { className: 'HGConnect' },
			h(Title, { size: 'm', className: 'HGConnect_Title' }, 'Hostinger'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			!state
				? h(BusyNote, { busy: true }, 'Loading…')
				: state.link
					? h(LinkedView, { site, state })
					: h(SetupView, { state, submitLabel: `Link ${site.name}`, onSubmit: linkSite(site.id) }),
			state ? h(VersionFooter, { update: state.update }) : null);
	}

	// ---------------------------------------------------------------- compare & selective sync

	const formatSize = (bytes) => {
		if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	};
	const formatTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
	const describeSide = (side) => (side ? [formatSize(side.size), formatTime(side.mtime)].filter(Boolean).join(' · ') : '');

	const GROUPS = [
		['changed', 'Different on each side'],
		['local-only', 'Only in Local'],
		['remote-only', 'Only on Hostinger'],
	];
	const NEWER = { local: 'Newer in Local', remote: 'Newer on Hostinger', same: 'Same date' };
	const ROW_LIMIT = 200;

	function CompareRow({ entry, checked, onToggle }) {
		return h('label', { className: 'HGConnect_FileRow' },
			h('input', { type: 'checkbox', checked, onChange: onToggle }),
			h('span', { className: 'HGConnect_FilePath', title: entry.path }, entry.path, entry.type === 'symlink' ? ' (link)' : ''),
			entry.status === 'changed'
				? h('span', { className: 'HGConnect_FileMeta' },
					h('span', null, `Local: ${describeSide(entry.local)}`),
					h('span', null, `Hostinger: ${describeSide(entry.remote)}`),
					entry.newer ? h('span', { className: `HGConnect_Badge HGConnect_Badge--${entry.newer}` }, NEWER[entry.newer]) : null)
				: h('span', { className: 'HGConnect_FileMeta' }, describeSide(entry.status === 'local-only' ? entry.local : entry.remote)));
	}

	/**
	 * MagicSync-style comparison: lists files that differ between Local and Hostinger, lets you tick files, and
	 * pushes or pulls only those. A ticked file missing on the sending side is deleted on the receiving side.
	 */
	function CompareView({ site, activity }) {
		const [result, setResult] = useState(null);
		const [checksum, setChecksum] = useState(false);
		const [filter, setFilter] = useState('');
		const [selected, setSelected] = useState(() => new Set());
		const compareAction = useAction();
		const syncAction = useAction();

		const compare = () => compareAction.run(async () => {
			const res = await ipcAsync(IPC.COMPARE, { siteId: site.id, checksum });
			setResult(res);
			setSelected(new Set());
		});

		const entries = result ? result.entries : [];
		const needle = filter.trim().toLowerCase();
		const visible = needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)) : entries;
		const toggle = (p) => setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(p)) next.delete(p);
			else next.add(p);
			return next;
		});
		const setGroup = (list, on) => setSelected((prev) => {
			const next = new Set(prev);
			list.forEach((e) => (on ? next.add(e.path) : next.delete(e.path)));
			return next;
		});

		const chosen = entries.filter((e) => selected.has(e.path));
		const count = (statuses) => chosen.filter((e) => statuses.includes(e.status)).length;

		const sync = async (direction) => {
			const send = direction === 'push' ? count(['changed', 'local-only']) : count(['changed', 'remote-only']);
			const remove = direction === 'push' ? count(['remote-only']) : count(['local-only']);
			const there = direction === 'push' ? 'on Hostinger' : 'in Local';
			await confirm({
				title: `${direction === 'push' ? 'Push' : 'Pull'} ${chosen.length} selected file${chosen.length === 1 ? '' : 's'}?`,
				message: h('div', null,
					send ? h('p', null, `${send} file${send === 1 ? '' : 's'} will be ${direction === 'push' ? 'uploaded to Hostinger' : 'downloaded to Local'}, replacing the copy ${there}.`) : null,
					remove ? h('p', null, `${remove} file${remove === 1 ? '' : 's'} that only exist${remove === 1 ? 's' : ''} ${there} will be deleted ${there}.`) : null,
					h('p', null, 'The database is not changed.')),
				buttonText: direction === 'push' ? 'Push' : 'Pull',
			});
			await syncAction.run(async () => {
				const fileList = chosen.map((e) => e.path);
				const options = direction === 'push' ? { fileList, purgeCache: true } : { fileList };
				await ipcAsync(direction === 'push' ? IPC.PUSH : IPC.PULL, { siteId: site.id, options });
				await compare();
			});
		};

		const busy = compareAction.busy || syncAction.busy || Boolean(activity);

		return h('div', { className: 'HGConnect_Compare' },
			h('p', { className: 'HGConnect_Intro' },
				'See which files differ between Local and Hostinger, then push or pull only the ones you pick. Nothing changes until you choose.'),
			h('div', { className: 'HGConnect_Actions HGConnect_Actions--Top' },
				h(PrimaryButton, { onClick: compare, disabled: busy }, compareAction.busy || activity === 'compare' ? 'Comparing…' : result ? 'Compare again' : 'Compare with Hostinger'),
				h(Checkbox, { label: 'Compare file contents (slower)', checked: checksum, onChange: (v) => setChecksum((p) => isChecked(v, p)) })),
			h(ErrorNote, { error: compareAction.error || syncAction.error }),
			result
				? h('div', null,
					h('p', { className: 'HGConnect_Summary', role: 'status' },
						entries.length === 0
							? 'Local and Hostinger have the same files.'
							: GROUPS.map(([key, label]) => `${entries.filter((e) => e.status === key).length} ${label.toLowerCase()}`).join(' · ')),
					entries.length
						? h(React.Fragment, null,
							h('div', { className: 'HGConnect_Filter' },
								h(TextInput, { value: filter, onChange: setFilter, placeholder: 'Filter by path, e.g. wp-content/themes' })),
							GROUPS.map(([key, label]) => {
								const list = visible.filter((e) => e.status === key);
								if (!list.length) return null;
								const allOn = list.every((e) => selected.has(e.path));
								return h('section', { key, className: 'HGConnect_Group' },
									h('label', { className: 'HGConnect_GroupHeader' },
										h('input', { type: 'checkbox', checked: allOn, onChange: () => setGroup(list, !allOn) }),
										h('span', null, `${label} (${list.length})`)),
									list.slice(0, ROW_LIMIT).map((entry) => h(CompareRow, {
										key: entry.path,
										entry,
										checked: selected.has(entry.path),
										onToggle: () => toggle(entry.path),
									})),
									list.length > ROW_LIMIT
										? h('p', { className: 'HGConnect_Help' }, `${list.length - ROW_LIMIT} more not shown. Narrow the list with the filter; the group checkbox still selects all ${list.length}.`)
										: null);
							}),
							h('div', { className: 'HGConnect_Actions HGConnect_SyncBar' },
								h('span', null, `${chosen.length} selected`),
								h(Button, { disabled: busy || !chosen.length, onClick: () => sync('pull') }, syncAction.busy && activity === 'pull' ? 'Pulling…' : 'Pull selected'),
								h(PrimaryButton, { disabled: busy || !chosen.length, onClick: () => sync('push') }, syncAction.busy && activity === 'push' ? 'Pushing…' : 'Push selected')))
						: null)
				: null);
	}

	// ---------------------------------------------------------------- pull to a new site

	/** Page behind Local's "Create a site → Pull from Hostinger" option. */
	function NewSitePage({ history }) {
		const [state] = useHostingerState(null);
		const [siteName, setSiteName] = useState('');
		const [nameTouched, setNameTouched] = useState(false);
		const [location, setLocation] = useState(null);
		const [started, setStarted] = useState(null);

		useEffect(() => {
			const name = siteName.trim();
			if (!name) {
				setLocation(null);
				return undefined;
			}
			const timer = setTimeout(() => {
				ipcAsync(IPC.NEW_SITE_LOCATION, name).then(setLocation).catch(() => setLocation(null));
			}, 200);
			return () => clearTimeout(timer);
		}, [siteName]);

		const onSiteSelected = (choice) => {
			if (!nameTouched) setSiteName(choiceName(choice));
		};

		const submit = async (source) => {
			const res = await ipcAsync(IPC.PULL_NEW_SITE, { siteName: siteName.trim(), source });
			setStarted(res);
		};

		return h('div', { className: 'HGConnect HGConnect_NewSite' },
			h('div', { className: 'HGConnect_NewSiteHeader' },
				h(TextButton, { onClick: () => history.push('/main/create-site') }, '← Back'),
				h(Title, { size: 'l', className: 'HGConnect_Title' }, 'Pull from Hostinger')),
			h('p', { className: 'HGConnect_Intro' },
				'Creates a new Local site, then pulls the files and database of a Hostinger WordPress website into it. Your Hostinger website is not changed.'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			started
				? h('div', { className: 'HGConnect_Success', role: 'status' },
					`Creating ${siteName.trim()} at ${started.domain}. Progress continues in the site's overlay.`)
				: h(React.Fragment, null,
					h(Field, {
						label: 'Local site name',
						help: location ? `${location.domain} · ${location.sitePath}` : 'Defaults to the Hostinger website\'s title.',
					}, h(TextInput, { value: siteName, onChange: (v) => { setNameTouched(true); setSiteName(v); }, placeholder: 'My Hostinger site' })),
					!state
						? h(BusyNote, { busy: true }, 'Loading…')
						: h(SetupView, {
							state,
							submitLabel: 'Create site & pull',
							canSubmit: Boolean(siteName.trim()),
							onSubmit: submit,
							onSiteSelected,
						})));
	}

	function HeaderButtons({ site }) {
		const [state] = useHostingerState(site && site.id);
		const [open, setOpen] = useState(null);
		if (!site || !state || !state.link) return null;
		const { link, activity } = state;
		const button = (direction) => h(Button, {
			key: direction,
			className: 'HGConnect_HeaderButton',
			disabled: Boolean(activity),
			onClick: () => setOpen(direction),
			title: `${DIRECTIONS[direction].button} (${linkTarget(link)})`,
		}, activity === direction ? `${DIRECTIONS[direction].gerund}…` : DIRECTIONS[direction].verb);

		return h('span', { className: 'HGConnect_HeaderButtons' },
			h('span', { className: 'HGConnect_HeaderLabel' }, 'Hostinger'),
			button('pull'),
			button('push'),
			open
				? h(FlyModal, { isOpen: true, contentLabel: DIRECTIONS[open].button, onRequestClose: () => setOpen(null) },
					h('div', { className: 'HGConnect HGConnect_Modal' },
						h(Title, { size: 'l', className: 'HGConnect_Title' }, DIRECTIONS[open].button),
						h('p', { className: 'HGConnect_Intro' }, open === 'push'
							? `${site.name} → ${linkTarget(link)}`
							: `${linkTarget(link)} → ${site.name}`),
						h(TransferForm, { direction: open, site, link, activity, inModal: true, onStarted: () => setOpen(null) })))
				: null);
	}

	return { HostingerPanel, HeaderButtons, TransferForm, CompareView, NewSitePage };
};
