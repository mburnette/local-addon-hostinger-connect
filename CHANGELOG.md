# Changelog

What changed in each release of ConnectLocal for Hostinger. Add new notes under **Unreleased**; `npm run release`
turns that section into the new version's entry and uses it as the GitHub release notes.

## Unreleased

- First release.
- Push a Local site's files, database, or both to a WordPress website on Hostinger web or cloud hosting (Premium plan or higher, with SSH turned on).
- Pull them back into an existing Local site, or into a brand-new Local site.
- Compare files on both sides and push or pull only the ones you pick.
- Find your WordPress websites, including subfolder installs, with a Hostinger API token, grouped by hosting account. The SSH server is worked out from the account's database host, since Hostinger's API doesn't list it. Or connect with the SSH details from hPanel's SSH Access page.
- Log in with Local's SSH key, or with the SSH password set in hPanel (stored encrypted).
- Run WP-CLI's database commands on servers that disable `proc_open`.
- Never touch other websites or subdomains kept in subfolders of the linked website, or Hostinger's own webroot files and must-use plugins.
- Clear Hostinger's server cache and CDN, the object cache and LiteSpeed's page cache after a push.
- Agency Plan websites are supported through the Agency API (untested).
- Update checks: the add-on looks for new releases on GitHub when Local starts and every 12 hours, and shows an
  **Update** button in its panel when one is out. **Check for updates** at the bottom of the panel checks right away.
