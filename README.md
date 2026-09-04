# ilmari-marketplace

The plugin catalog for [ilmari](https://github.com/wraithyy/ilmari). One JSON
file, `catalog.json`, listing community plugins that live in their own git
repositories (GitHub, GitLab, self-hosted). ilmari fetches this file, shows the
entries in its Plugins screen and `ilmari plugin search`, and installs a plugin
by cloning its repository at the newest `vX.Y.Z` tag.

Listing here is not a security review. ilmari statically inspects the plugin's
entry file and shows its capabilities before any of its code runs; the operator
decides whether to approve. Read a plugin's source before approving it.

## Adding a plugin

Open a pull request that appends one object to `plugins` in `catalog.json`:

```json
{
  "name": "ilmari-plugin-jira",
  "description": "Jira issues as triggers and tools",
  "repo": "https://gitlab.com/acme/ilmari-plugin-jira.git",
  "entry": "dist/index.js",
  "homepage": "https://gitlab.com/acme/ilmari-plugin-jira",
  "capabilities": ["net", "secrets"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique, lowercase; conventionally `ilmari-plugin-<thing>` |
| `description` | yes | One line shown in the catalog |
| `repo` | yes | Any url `git clone` accepts (`https://`, `ssh://`, `git@host:path`) |
| `entry` | no | Committed entry file, default `dist/index.js`, then `package.json` `main` |
| `homepage` | no | Docs or repository page |
| `capabilities` | no | Informational; the approved list comes from static inspect of `entry` |

Requirements for the plugin repository:

- The built entry file is committed. ilmari never builds or bundles.
- Releases are git tags `vX.Y.Z`. The newest tag is what installs; `ilmari
  plugin outdated` compares installed tags against the repository.
- Runtime dependencies, if any, are installed with
  `npm ci --ignore-scripts --omit=dev` after approval; lifecycle scripts never
  run. Commit a lockfile.
- The README documents every capability, config field and contribution.

CI runs `node scripts/validate.mjs`: schema checks plus `git ls-remote` on every
repository to confirm it is reachable and tagged.

## Plugins hosted here

A plugin may also live in this repository under `plugins/<name>/`, with a
catalog entry whose `repo` is this repository and whose `entry` is the
subdirectory path — see `plugins/jenkins`. ilmari clones the whole catalog in
that case and loads the one entry file.

The tag is then shared: every plugin hosted here installs at this
repository's newest `v*` tag, so releasing a fix to one of them means tagging
the catalog again, and `ilmari plugin outdated` cannot tell them apart. Keep
this for small plugins maintained alongside the catalog; anything that needs
its own release cadence belongs in its own repository.

## Using another catalog

Anyone can host a catalog with the same schema, for example an internal one on
GitLab. Add its raw url or an absolute local path to `catalogs` in
`~/.ilmari/plugins.json`. See the ilmari docs, *The Marketplace and catalogs*.
