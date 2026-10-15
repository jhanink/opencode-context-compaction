# Publishing

`opencode-context-compaction` 0.1.0 was published on 2026-10-15. This records how
it got there, because the obvious command does not work and the failure is
misleading.

The package was later renamed to the scoped name **`@jhanink/opencode-context-compaction`**.
GitHub Packages only accepts scoped names whose scope is the account that owns the
repo, and publishing a mirror there is the only way to make the repository page
show a package box — see "GitHub Packages" below. The scoped name is now the only
distribution: the unscoped `opencode-context-compaction` was unpublished on
2026-10-15, inside npm's 72-hour window, so `opencode plugin add opencode-context-compaction`
now 404s rather than quietly installing the 0.1.0 tree.

That does leave the unscoped name free for anyone else to claim. It is not worth
defending — a squatter can only publish a package nobody is instructed to install —
but it is why every install instruction in this repo is scoped.

## Versions

| Version | Date | What changed |
| --- | --- | --- |
| 0.1.0 | 2026-10-15 | First publish, unscoped. `@opencode/plugin` was a normal dependency, pulling 424 packages into every install. |
| 0.1.1 | 2026-10-15 | Renamed to `@jhanink/opencode-context-compaction`; runtime modules became optional peers; `publishConfig.access: public`. |
| 0.1.2 | 2026-10-15 | Optional `history` (off by default) recording decisions and compactions, so the trigger can be evaluated against its own behaviour. |

## Why plain `npm publish` fails

```
npm error 403 Forbidden — Two-factor authentication or granular access token
with bypass 2fa enabled is required to publish packages.
```

npm requires **either** 2FA on the account **or** a granular access token with
*Bypass 2FA* enabled. npm's 2FA is a WebAuthn security key (Touch ID, passkey,
YubiKey) configured at npmjs.com → Account → Enable 2FA; it is not an
authenticator-app code in npm's setup flow, although the CLI prompt accepts an
app code if the account is configured that way. **A GitHub 2FA code is useless
here** — the secret is scoped to GitHub, and linking GitHub to npm only helps
account recovery, not publishing.

Note also: using a recovery code to authenticate triggers a **72-hour hold**
during which publishing is blocked.

## Staged publishing, which is what we actually did

A bypass-2FA granular token can *stage* but not publish directly. **The token
value never needs to change hands.** Put it in your own npm config once and let
npm read it from there:

```sh
# You run this. Writes ~/.npmrc (mode 600); the value never appears in a
# command, a transcript, or a log line.
npm config set //registry.npmjs.org/:_authToken "npm_…"

npm stage publish
```

To keep the publish credential out of `~/.npmrc` entirely, point npm at a file
you own rather than passing the value on a command line:

```sh
npm stage publish --userconfig="$HOME/.npmrc-publish"   # mode 600, not /tmp
```

Staging does two things worth knowing:

1. It reserves the name with a `0.0.0-stage` placeholder. Until approval,
   `npm view @jhanink/opencode-context-compaction version` reports `0.0.0-stage`,
   and an install would fetch that stub. That residual version stays in the
   packument afterwards; it is harmless because `latest` moves to the real version.
2. It defers proof-of-presence to a human. Approval is the 2FA step:

```sh
npm stage approve <stage-id>     # interactive; prints a browser URL for the key
```

or npmjs.com → the package → the staged version → **Approve**.

Observed timing for 0.1.0: staged 01:49:21, live 01:50:14, `latest` → `0.1.0`.

## GitHub Packages (the repository sidebar box)

The package box on a repository page lists **GitHub Packages** only. It cannot
list an npmjs.com package, however correct `repository` is. To get the box,
publish the same tree a second time to `npm.pkg.github.com`:

```sh
# ~/.npmrc-gh (mode 600), written by you:
#   @jhanink:registry=https://npm.pkg.github.com
#   //npm.pkg.github.com/:_authToken=npm_…
npm publish --userconfig="$HOME/.npmrc-gh"
```

The credential in that file is a **GitHub** personal access token (classic) with
`write:packages` — not the npm token. Requirements and caveats:

- The name must be scoped to the account that owns the repository, and
  `repository.url` must match the repo. Both are true here; this is why the
  rename to `@jhanink/opencode-context-compaction` happened.
- Do **not** put `"registry": "https://npm.pkg.github.com"` in `publishConfig`.
  It is applied to every publish, including the npmjs one, and would silently
  send your real releases to the wrong registry. Pass `--userconfig`/`--registry`
  per publish instead.
- GitHub Packages requires authentication to install even **public** packages
  (`E401` without a token in `.npmrc`), so this copy is a mirror for the sidebar,
  not an install path. Send users to npmjs.
- New packages default to private visibility; set the package to **Public** in
  the repository's Packages settings if it is not already.
- In CI, `GITHUB_TOKEN` with `packages: write` can publish this without any PAT.

## Release checklist

1. Edit `src/`, then `node --test test/*.test.ts`. If behaviour changed, copy
   `src/*.ts` into the local plugin directory (`~/.config/opencode/plugins/context-compaction/`)
   and confirm it reloads without a `failed to load plugin` line in
   `~/.local/share/opencode/log/opencode.log`.
2. Bump `version` in `package.json`.
3. `npm pack --dry-run` to check the packed file list — `src/`, `README.md` and
   `LICENSE`, and nothing else.
4. Stage, then approve.
5. **Verify the published artifact by installing it somewhere disposable**, not
   by trusting the registry response: `npm i @jhanink/opencode-context-compaction@<version>`
   in a scratch directory, check the file list, and confirm `src/lib.ts` still
   behaves. This is what caught the 0.1.0 packaging bug below.
6. **Confirm no credential entered the session.** A token belongs in a config
   file you own (`~/.npmrc`, mode 600) — never in a command line, a transcript,
   or a `/tmp` file. Anything that reaches a session is persisted, and a
   compacting session copies it forward into every later summary, so editing
   history afterwards does not undo the copies. Revoke the token instead.

## Packaging: why `@opencode/plugin` is an optional peer

0.1.0 followed the manifest example in the plugins documentation and declared
`"dependencies": {"@opencode/plugin": "latest"}`. Installing it then pulled
**424 packages** — `effect`, `@opencode/ai`, `@opencode/client`, `@opencode/schema`
and the rest — including a deprecated `glob@10.5.0` with known advisories. For a
plugin whose selling point is that it adds nothing, that is the wrong trade.

Nothing needs installing: OpenCode resolves `@opencode/plugin`,
`@opencode/plugin/tui`, `@opencode/plugin/rpc`, `@opentui/*` and `solid-js` at
runtime. The local plugin directory has no `node_modules` at all and loads fine,
which is the proof. So from 0.1.1 they are declared as **optional** peers: the
contract stays documented, and an install fetches nothing.

## Future releases: trusted publishing (no tokens at all)

npm recommends OIDC trusted publishing over tokens: short-lived credentials
scoped to a workflow, and automatic provenance attestations — the "Built and
signed on GitHub Actions" badge, which is worth having for a plugin people run
with filesystem access.

It cannot publish the *first* version, because trusted publishers are configured
on the package's own settings page. Hence the manual 0.1.x above. For 0.2.0
onward:

**Once, in the browser** — npmjs.com → Packages →
`@jhanink/opencode-context-compaction` → Settings → Trusted publishing → Add
trusted publisher → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `jhanink` |
| Repository | `opencode-context-compaction` |
| Workflow filename | `publish.yml` (exact, with the extension — not a path) |
| Environment name | optional |
| Allowed actions | `npm stage publish` is always allowed; add direct `npm publish` only if you want tags to go live without a review step |

Two gotchas from the docs: a new trusted-publisher configuration **expires if it
does not complete a publish within 2 days**, and it is **not validated when you
save it** — a typo surfaces only at publish time.

**Requirements already met:** npm CLI ≥ 11.5.1 (local: 11.20.0) and Node ≥ 22.14
(local: 26). Publishing from CI also requires a public repository and a
`repository.url` in `package.json` that matches it exactly — ours does, and the
docs call that out as a common failure.

**Workflow** — `.github/workflows/publish.yml`, on tag `v*`:

```yaml
name: Publish
on:
  push:
    tags: ["v*"]
permissions:
  id-token: write # required for OIDC
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false # never cache in release builds
      - run: node --test test/*.test.ts
      - run: npm stage publish
```

No `npm ci`: the tests import only Node builtins and `src/lib.ts`, so CI needs no
install step at all.

**Afterwards**, tighten it: package Settings → Publishing access → *Require
two-factor authentication and disallow tokens*, and revoke any tokens that are no
longer needed. That setting does not affect trusted publishers.
