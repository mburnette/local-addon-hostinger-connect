# ConnectLocal for Hostinger

A [Local](https://localwp.com) add-on that connects Local to WordPress websites on [Hostinger](https://www.hostinger.com) web and cloud hosting. It works the way Local Connect does for WP Engine and Flywheel. You can:

- **push** a site's files, database, or both to a Hostinger website;
- **pull** them back into an existing Local site;
- **pull a Hostinger website into a brand-new Local site**;
- **compare** files on both sides and push or pull only the ones you pick, like MagicSync.

Files move with rsync over SSH and the database with WP-CLI, the same tools Local Connect uses for WP Engine. The [Hostinger API](https://developers.hostinger.com) handles what it can around the transfer: listing your websites, finding the server they live on, and clearing Hostinger's cache.

| Step | WP Engine (built in) | ConnectLocal for Hostinger |
| --- | --- | --- |
| Auth | WP Engine account + Local's SSH key registered via CAPI | A Hostinger API token. Hostinger's API can't add SSH keys or turn SSH on, so you add Local's key once in hPanel (**Websites → Manage → Advanced → SSH Access**). If you'd rather use the SSH password set on that page, type it when linking; it is stored encrypted. |
| Finding the site | CAPI install list | `GET /api/hosting/v1/websites` and `GET /api/hosting/v1/wordpress/installations` list every WordPress website and subfolder install the token can see, grouped by hosting account. |
| SSH login | From CAPI | The API has no SSH details, so the add-on derives them: the host is the account's database server (`GET …/accounts/{username}/databases`, which is the same machine), the port is 65002 and the username is the hosting account (`u123456789`). |
| Backup | CAPI backup before push | Hostinger has no backup API for web hosting. Its automatic backups stay available in hPanel, and the add-on saves the current database on the server before replacing it. |
| Files | Local's bundled `rsync` over SSH, `--delete`, excludes `wp-config.php` | Same binaries, same flags. Also excludes Hostinger's own webroot files and must-use plugins, LiteSpeed's cache output, and any other website or WordPress install in a subfolder. |
| Database | `wp db export` backup → `wp db reset` → import → `search-replace //local //remote` → match table prefix | Same, run as `php -d disable_functions= wp …` because Hostinger disables `proc_open`. Plus collation fixes between MySQL and MariaDB, and automatic restore if an import fails. |
| Pull | rsync down, export remote DB, import, `search-replace //remote //local` | Same. It also replaces the website's other domains: parked domains, the `www`/non-`www` twin and, for Agency Plan websites, the other domains and the preview domain. |
| Cache | Purge CDN/object/page cache | `DELETE …/websites/{domain}/cache/clear` (server cache and Hostinger CDN), plus `wp cache flush` and `wp litespeed-purge all` over SSH |
| Pull to new site | "Create a site → Pull from WP Engine" | "Create a site → Pull from Hostinger". It checks the connection first, creates the site with Local's `addSite` service, links it, then pulls. |
| MagicSync | rsync dry run, itemized changes, file tree with checkboxes | rsync dry runs in both directions, merged into one list with both sides' size and date. Ticked files move with `--files-from`. |

## Requirements

- Local 6 or newer. Developed against **Local 10.1.2 on macOS**.
- A Hostinger plan with **SSH access**: Premium, Business or Cloud web hosting ([Hostinger's guide](https://www.hostinger.com/support/1583245-how-to-connect-to-a-hosting-plan-via-ssh/)). Single plans have no SSH, so they can't be used. Agency Plan websites are supported through the Agency API but haven't been tested.
- SSH turned on for the website: hPanel → **Websites → Manage → Advanced → SSH Access**. The same page lists the IP, port and username, lets you set the SSH password, and is where you add Local's SSH key ([adding a key](https://www.hostinger.com/support/5634532-how-to-generate-ssh-keys-and-add-them-to-hpanel/)).
- A **WordPress** website. Website Builder and Horizons sites have no files to sync and aren't listed.
- A Hostinger **API token** (recommended). In hPanel, open **API** (under Dev tools in the sidebar, or [hpanel.hostinger.com/profile/api](https://hpanel.hostinger.com/profile/api)), click **New**, name the token, pick an expiry date and click **Generate** ([Hostinger's guide](https://www.hostinger.com/support/10840865-what-is-hostinger-api/)). Copy it straight away: hPanel shows it only once.
  - A token has the same access as the hPanel login that creates it. Hostinger allows 90 requests per minute per user; the add-on makes a handful per link or transfer.
  - Without a token, you can still link a site with the SSH details from the SSH Access page.
- WP-CLI and rsync on the server. Hostinger installs both (`/usr/local/bin/wp`, rsync 3.2). If `wp` is missing, the add-on installs its own copy.

## Install

### From source (development)

```bash
npm install
```

```bash
npm run install-addon
```

This symlinks the folder into Local's add-ons directory (`~/Library/Application Support/Local/addons` on macOS) and enables it. **Restart Local** to load it. To remove it, run `npm run install-addon -- --remove`.

This add-on is separate from ConnectLocal for Cloudways, Bluehost and Kinsta, and can be installed next to them: package names, IPC channels, CSS classes, storage folders and ignore files are all distinct.

### From a release

Download the `.tgz` from the [latest release](../../releases/latest). In Local, go to **Add-ons → Install from disk**, choose the file, enable the add-on and restart Local.

### Updates

The add-on checks this repository's releases when Local starts and every 12 hours after that. You can also check right away from **Check for updates** at the bottom of the add-on's panel. When a new version is out, the panel shows an **Update** button. It installs the update through Local's own add-on installer, then offers to restart Local. Your linked sites and saved credentials are kept.

To build a package yourself, run `npm run package`, or use `npm run release -- patch --dry-run` (see [RELEASING.md](RELEASING.md)).

## Use

1. In hPanel, open **Websites → Manage → Advanced → SSH Access** for the website and turn SSH on. Add Local's SSH key there (step 3), or set an SSH password.
2. Open a site in Local and go to **Tools → Hostinger**. Connect in one of two ways:
   - **Hostinger API (recommended):** paste your API token, pick a website (grouped by hosting account, subfolder installs listed separately) and click **Link**. Websites that can't be linked, such as disabled ones, are shown greyed out with the reason. The add-on then:
     - finds the SSH server from the account's database host, or failing that from the server name in the website's PHP info;
     - logs in on port 65002 as the hosting account user with Local's SSH key, or with the SSH password if you typed one;
     - finds the WordPress folder (`~/domains/<domain>/public_html`, plus the subfolder for a subfolder install);
     - notes the other websites and subdomains kept inside that folder, so a push never touches them.
   - **SFTP/SSH details:** enter the IP, port (65002), username (`u123456789`) and password, or use Local's key, as shown on the SSH Access page. Add the website's domain so the add-on can find its folder (`~/domains/<domain>/public_html`; if WordPress isn't there, linking stops instead of picking another website of the account), or type the remote path yourself.
3. To log in with Local's own key, copy the public key shown in the panel and add it on the SSH Access page (**SSH keys → Add SSH key**). Then link the site again.
4. Push or pull from the panel's **Push to Hostinger** / **Pull from Hostinger** tabs. Once the site is linked, you can also use the **Hostinger: Pull / Push** buttons in the site header.
   - Push options: Files and/or Database; delete files on Hostinger that aren't in Local (on by default, like WP Engine); clear Hostinger caches afterwards.
   - Pull options: Files and/or Database; back up the Local database first; delete Local files that aren't on Hostinger (on by default).
   - Every pull moves the Local files it replaces or deletes into `app/hostinger-backups/pull-<time>/` instead of discarding them. The last 3 are kept.

Progress appears in Local's site overlay. When the transfer finishes, a banner reports success or the error.

### How the SSH server is found

Hostinger's hosting API returns no SSH details, and SSH keys can only be added in hPanel. When you link through the API, the add-on works out the login itself:

1. **Host:** the `host` of the account's databases (`srv123.hstgr.io`, say) is the same machine that serves SSH. If the account has no database listed, it reads the website's PHP info and takes the server name from its `System` line (`us-imm-web123.main-hosting.eu`). If neither works, the error asks you to link with SFTP/SSH details from the SSH Access page instead.
2. **Port and username:** 65002 and the hosting account user, as on every shared and cloud plan.
3. **Login:** Local's key first. If the server refuses it, the SSH password you typed (stored encrypted). Without one, the error tells you to add Local's key on the SSH Access page. A connection that times out or is refused usually means SSH is off for the website, or the plan doesn't include it.

Agency Plan websites list their SSH login in the Agency API, and the add-on uses it as given.

### Pull a Hostinger website into a new Local site

1. Click **+** (Create a site) in Local and choose **Pull from Hostinger**.
2. Pick the website, or enter SFTP/SSH details. Name the Local site; it defaults to the website's title.
3. Click **Create site & pull**. The connection is checked **first**, so a wrong login never leaves an empty site behind.

### Compare & sync files (selective sync)

Go to **Tools → Hostinger → Compare & sync files** and click **Compare with Hostinger**. Nothing changes until you choose files. Differing files are listed under **Different on each side**, **Only in Local** and **Only on Hostinger**. Tick files, then click **Push selected** or **Pull selected**. A ticked file that exists only on the receiving side is deleted there. The database is never touched.

### WP-CLI and `proc_open`

Hostinger's shared servers list `proc_open` in PHP's `disable_functions`. WP-CLI needs it for `wp db export`, `import`, `query` and `reset`, which otherwise fail with "Cannot do 'Process::run'". The add-on checks for it when it connects and, where it is disabled, runs WP-CLI as `php -d disable_functions= /usr/local/bin/wp …`, which lifts the restriction for that one command only. Nothing on the server is reconfigured.

### What a database push does

1. Exports the Local database and rewrites MySQL 8 `utf8mb4_0900_*` collations to ones MariaDB accepts.
2. On Hostinger, saves the current database to `local-backup-before-push.sql` in a private folder for this website, `~/.hostinger-connect/<website folder>` (mode 700, outside every webroot, one per website so websites of the same account never share it). It also reads the current `home` URL and `table_prefix`.
3. Uploads the dump to that folder, then runs `wp db reset` and `wp db import`. If the import fails, it restores the backup automatically. The uploaded dump is always deleted afterwards.
   - When the database also holds another site's tables (a different table prefix, such as a second WordPress in a subfolder), it drops only this site's tables instead of resetting the whole database, and the backup holds only those tables. If the Local site's table prefix would overwrite the other site's tables, the push stops before changing anything.
4. Sets `table_prefix` to match Local if the two differ.
5. Runs `wp search-replace` across all tables (only this site's prefix in a shared database; `--precise`, `guid` skipped) from `//site.local` to the Hostinger URL, including the JSON-escaped form, plus `http://` → `https://` when the Hostinger site uses HTTPS.

### What a database pull does

1. On Hostinger, exports the database with `--single-transaction` (the live site isn't locked), downloads it and deletes the export.
2. Makes the dump importable by Local's MySQL. It removes the MariaDB "sandbox mode" line and rewrites `uca1400` collations.
3. Saves the Local database to `app/sql/local-backup-before-pull.sql` (optional).
4. Imports through Local's own WP-CLI service. If the import fails, it restores the backup.
5. Matches Local's `table_prefix` to Hostinger's, then replaces the Hostinger URL and the website's other domains (parked domains, the `www`/non-`www` twin, and for Agency Plan websites their other domains and preview domain) with the Local URL.

### Backups

Hostinger's API has no backup endpoint for web hosting (only for VPS), so the add-on can't take a Hostinger backup before a push. Hostinger makes automatic backups of every website; restore one in hPanel under **Websites → Manage → Files → Backups**. On top of that, every database push keeps the previous database as `local-backup-before-push.sql` in the website's private folder (see above), and every pull keeps the Local files it replaced.

### Caches

After a push (option on by default), the add-on clears:

- Hostinger's server cache and CDN, through the API (`DELETE …/cache/clear`, with the subfolder for a subfolder install; Agency Plan websites use the Agency API's cache endpoint). Only for websites linked through the API; a site linked with SFTP/SSH details gets the two steps below;
- WordPress's object cache, with `wp cache flush`;
- the LiteSpeed Cache plugin's page cache, with `wp litespeed-purge all` (when the plugin is active).

A failed cache clear is reported as a warning; the push itself has already succeeded.

### What is never transferred

These are excluded in both directions, and excluded paths are also protected from `--delete`:

- Server config: `wp-config.php`, `.htaccess` (Hostinger's carries LiteSpeed rules), `.htaccess.bk`, `.user.ini`, `php.ini`, `wp-cli.yml`
- Hostinger's own webroot files: `.private/` (hPanel's config folder) and `default.php` (the placeholder page of a new website)
- Hostinger's must-use plugins: `wp-content/mu-plugins/hostinger-*.php` (auto-updates, preview domain). Its regular plugins (`hostinger`, `hostinger-easy-onboarding`, `hostinger-reach`, `litespeed-cache` and so on) are transferred like any other plugin.
- `llms.txt`: Hostinger generates it from the live site's content, so each side keeps its own
- Caches and drop-ins: `wp-content/litespeed/`, `object-cache.php`, `advanced-cache.php`, `wp-content/cache/`
- Server-specific state: `wp-content/jetpack-waf/`, `wp-content/upgrade/`, `wp-content/upgrade-temp-backup/`
- Migration-plugin backups: `wp-content/ai1wm-backups/`, `wp-content/updraft/`
- Other websites, subdomains and WordPress installs kept in subfolders of the webroot
- VCS and tool binaries, root-level `*.sql` dumps, Local's helper files

Must-use plugins that exist only on the receiving side are never deleted.

To skip more, add rsync patterns (one per line) to `app/public/.hostinger-push-ignore` or `.hostinger-pull-ignore`. These work like `.wpe-push-ignore` and `.wpe-pull-ignore`.

### Several websites in one hosting account

One Hostinger account usually hosts many websites, each in `~/domains/<domain>/public_html`, and a subdomain or a staging copy can live as a folder inside another website's `public_html`. The add-on keeps them apart:

- each link points at one website's folder (and subfolder, for a subfolder install);
- folders of other websites and subdomains inside that folder are excluded from every transfer and never deleted;
- the private folder for dumps is per website.

### Themes and plugins symlinked from elsewhere

A theme or plugin that you develop in another folder and symlink into the Local site (for example `wp-content/themes/mytheme → ~/code/mytheme`) is **pushed as real files**, because the server has no such folder to point to. It is **never pulled into**: a pull leaves the symlink and the folder it points to untouched. Symlinks within the site stay symlinks, and broken symlinks are skipped (and logged).

## Security notes

- **Secrets:** the API token and any typed SSH password are encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows). They are stored in `<Local data>/hostinger-connect/settings.json` and never sent to the renderer. A password goes to `ssh` through `SSH_ASKPASS` and an environment variable, never in argv or on disk.
- **SSH key and known hosts:** the add-on keeps its own RSA key in `<Local data>/hostinger-connect/ssh/`, separate from Local's WP Engine key and from the other ConnectLocal add-ons' keys. It also keeps its own `known_hosts` file, which pins each server's host key on first connect.
- **What the add-on changes on Hostinger:**
  - the website's files and database, when you push;
  - a private `~/.hostinger-connect/<website folder>` for dumps and the database backup;
  - only when the server has no WP-CLI, a downloaded `wp-cli.phar` in that folder;
  - Hostinger's caches, when you push with the cache option on.
  It never turns SSH on, adds keys, or changes PHP settings; those stay in hPanel.
- **Shared SSH connection:** on macOS and Linux, each push, pull or comparison logs in once and runs every command over that connection. Its control socket is `hgc-<hash>` in a temporary folder only your user can use.

## Verified on a live account

On 2026-10-31 and 11-01, against a Hostinger **Premium** shared plan with one WordPress website (PHP 8.3, MariaDB 11.8, WP-CLI 2.12, rsync 3.2.7):

- **API:** the websites list (paginated, with `username` and `root_directory`), the WordPress installations list, the account's databases, the PHP info endpoint and the cache-clear endpoint respond as described above. The token gives no SSH details.
- **SSH host:** the database host (`srv123.hstgr.io`) and the server name in PHP info both resolve to the SSH server, on port 65002, with the hosting account as the username.
- **Server layout:** home `/home/<user>`, the website at `~/domains/<domain>/public_html`, a `DO_NOT_UPLOAD_HERE` marker in `~/domains/<domain>/`, and Hostinger's own webroot files and must-use plugins as listed under "What is never transferred".
- **WP-CLI:** `wp db query` fails with `proc_open` disabled and works as `php -d disable_functions= /usr/local/bin/wp db query`; `mysqldump` works directly.

The add-on itself was then run against that website, with Local's own rsync 3.1.3 and ssh and only Local's side (site data, database dump, WP-CLI) stubbed:

- **Link through the API:** found the SSH server from the database host and linked with Local's key in about 2 seconds. With a key hPanel doesn't have and no password, linking stopped with the SSH Access instructions.
- **Pull** (files and database): about 6,000 files (160 MB) and the database in about 15 seconds. None of the excluded Hostinger files came down, the MariaDB dump imported after the collation fixes, and a comparison afterwards found no differences.
- **Push** (files and database, deleting extra files on Hostinger): the new site title was live on the first request after the cache clear, no Local URLs were left, a file that existed only on Hostinger was deleted, and `.private/`, `default.php`, `llms.txt`, LiteSpeed's folder, the must-use plugins, `wp-config.php` and `.htaccess` were left alone. The database backup was saved in the website's private folder.
- **Manual link** (IP, default port, username, Local's key, domain): found the same folder and private folder.
- **Compare and selective push:** listed a file only on Hostinger and a file only in Local, pushed the new one and deleted the other; a checksum comparison afterwards found no differences. One checksum comparison straight after a push was stopped by a signal (rsync exit 20) and three repeats passed, so on a busy shared server, compare again if that happens.

## Limitations and what is not verified

- **Not yet run inside Local itself.** Try the Tools panel, header buttons and "Pull from Hostinger" wizard in a running Local before relying on them.
- **Agency Plan:** built from Hostinger's API reference only; no Agency account was available to test with.
- **Cloud and Business plans** are expected to match Premium (same port and layout) but were not tested separately.
- **No pre-push backup:** Hostinger's API can't make one for web hosting. Rely on Hostinger's automatic backups and the database copy the add-on keeps.
- **Multisite:** the domain columns in `wp_blogs` and `wp_site` are not rewritten.
- **Windows:** password logins aren't supported (add Local's key in hPanel), and nothing has been tested on Windows.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run lint
```

- `npm test` runs the unit, main-process and renderer tests. They cover:
  - the API client against the OpenAPI spec's response shapes (websites with pagination, WordPress installations, databases, PHP info, domains, cache, Agency websites, errors and rate limiting);
  - the site choices and the linking flow (SSH host from the database host or PHP info, key first, then the typed password, then a clear error), with the API faked;
  - the remote discovery script on a Hostinger-like home folder: the `~/domains/<domain>/public_html` webroot, the per-website private folder, `proc_open` detection and other websites' folders;
  - dump normalization, URL replacement pairs, rsync itemize parsing and merging;
  - encrypted storage;
  - the React UI mounted in jsdom with the real `@getflywheel/local-components`.
- `npm run test:e2e` starts an unprivileged `sshd` on 127.0.0.1 with a fake `wp` and a Hostinger-like site folder. Through Local's bundled `rsync`/`ssh`, it runs:
  - a files + database push and cache clear (checking that it logs in only once);
  - a full pull;
  - a comparison, a selective push and a selective pull;
  - a checksum compare.

```
lib/
  main.js                 add-on main process: IPC handlers, account, site choices and linking flow
  main/HostingerApi.js    Hostinger API client (websites, WordPress installs, databases, PHP info, domains, cache, Agency)
  main/SyncService.js     push and pull orchestration (discovery, files, database, search-replace, cache)
  main/transport.js       rsync/ssh runner using Local's bundled binaries, key or password auth
  main/sshKey.js          RSA key pair in OpenSSH format
  main/store.js           settings + encrypted secrets
  main/updater.js         checks GitHub releases and installs updates through Local's add-on installer
  renderer.js             hooks: Tools → Hostinger tab, header pull/push buttons, create-site option, stylesheet
  renderer/components.js  React UI (plain React.createElement, no build step)
```

### Hostinger API endpoints used

| Purpose | Endpoint |
| --- | --- |
| Auth | `Authorization: Bearer <API token>` on every call. There is no validation endpoint; connecting reads the first page of websites. |
| Websites | `GET /api/hosting/v1/websites?page=&per_page=` (paginated) |
| WordPress installs | `GET /api/hosting/v1/wordpress/installations` |
| SSH host | `GET /api/hosting/v1/accounts/{username}/databases` (database `host`), falling back to `GET …/accounts/{username}/websites/{domain}/php/php-info` |
| Other domains and folders | `GET …/accounts/{username}/websites/{domain}/parked-domains` and `…/subdomains` (best effort) |
| Cache | `DELETE /api/hosting/v1/accounts/{username}/websites/{domain}/cache/clear[?directory=]` |
| Agency Plan | `GET /api/agency-hosting/v1/websites`, `GET …/websites/{uid}` (SSH login, domains), `DELETE …/websites/{uid}/cache` |

The base URL is `https://developers.hostinger.com`.

## Releasing

See [RELEASING.md](RELEASING.md). In short: commit to `main`, then run `npm run release -- patch` (or `minor`/`major`).
