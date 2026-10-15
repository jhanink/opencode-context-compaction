# Publishing

`opencode-context-compaction` 0.1.0 was published on 2026-10-15. This records how
it got there, because the obvious command does not work and the failure is
misleading.

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

A bypass-2FA granular token can *stage* but not publish directly:

```sh
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > /tmp/npmrc-publish
npm stage publish --userconfig=/tmp/npmrc-publish
```

Staging does two things worth knowing:

1. It reserves the name with a `0.0.0-stage` placeholder. Until approval,
   `npm view opencode-context-compaction version` reports `0.0.0-stage`, and an
   install would fetch that stub. That residual version stays in the packument
   afterwards; it is harmless because `latest` moves to the real version.
2. It defers proof-of-presence to a human. Approval is the 2FA step:

```sh
npm stage approve <stage-id>     # interactive; prints a browser URL for the key
```

or npmjs.com → the package → the staged version → **Approve**.

Observed timing for 0.1.0: staged 01:49:21, live 01:50:14, `latest` → `0.1.0`.

## Release checklist

1. Edit `src/`, then `node --test test/*.test.ts`. If behaviour changed, copy
   `src/*.ts` into the local plugin directory (`~/.config/opencode/plugins/context-compaction/`)
   and confirm it reloads without a `failed to load plugin` line in
   `~/.local/share/opencode/log/opencode.log`.
2. Bump `version` in `package.json`.
3. `npm publish --dry-run` to check the packed file list (7 files, ~9.6 kB).
4. Stage, then approve.
5. **Verify the published artifact by installing it somewhere disposable**, not
   by trusting the registry response: `npm i opencode-context-compaction@<version>`
   in a scratch directory, check the file list, and confirm `src/lib.ts` still
   behaves. This is what caught the 0.1.0 packaging bug below.
6. Revoke any token that was pasted into a transcript or shell history.

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

**Once, in the browser** — npmjs.com → Packages → `opencode-context-compaction`
→ Settings → Trusted publishing → Add trusted publisher → GitHub Actions:

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
