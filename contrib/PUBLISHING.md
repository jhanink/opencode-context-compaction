# Publishing

Everything here is prepared but not executed: this machine has no npm session
(`npm whoami` → `ENEEDAUTH`) and no `gh` CLI, so the public steps need you.

The name is unclaimed on npm — `opencode-context-compaction` returns 404 from the
registry, and the scoped alternatives do too. `npm publish --dry-run` already packs
cleanly (7 files, 9.5 kB tarball).

## 1. Publish to npm

```sh
npm login                 # once, then:
npm publish               # from the repo root
```

Then anyone can:

```sh
opencode plugin add opencode-context-compaction
```

Before publishing: bump `version` on every subsequent change, and confirm the
`repository`, author and license fields point where you want.

## 2. Push the repository

```sh
git remote add origin git@github.com:jhanink/opencode-context-compaction.git
git push -u origin main
```

The repo is already committed locally (`git log` shows the initial commit).

## 3. Submit to awesome-opencode

See `contrib/awesome-opencode-entry.md`. Fork the list, paste the entry in
alphabetical order, open a PR.

## Notes

- The local install (`~/.config/opencode/plugins/context-compaction/`) is a copy of
  `src/`. After editing either, re-copy — or better, keep the repo canonical and
  re-copy from it, which is what the README recommends.
- Do not load the plugin from `opencode.json(c)` *and* leave the copy in the
  auto-discovered plugins directory: two instances would each request compaction.
