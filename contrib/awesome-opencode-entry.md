# Adding this to awesome-opencode

[awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) is a curated
list; there is no first-party OpenCode plugin registry, so this is where plugins get
discovered. It has no CONTRIBUTING guide — entries are added straight to the README.

## Entry

Insert into the **PLUGINS** section, in alphabetical order: after
`OpenCode Claude Memory` and before `OpenCode Ensemble`.

```html
<details>
  <summary><b>OpenCode Context Compaction</b> <img src="https://badgen.net/github/stars/jhanink/opencode-context-compaction" height="14"/> - <i>Compact on a token budget, at idle, with TUI status and toasts</i></summary>
  <blockquote>
    OpenCode compacted only near the model's context ceiling, which on a 1M-token model is roughly 900k — so a session could sit at 200k all afternoon, re-reading a large transcript, and never compact. This plugin watches the context assembled for each model call and requests a normal compaction once a session goes quiet for 45s and its context passes a budget (150k tokens by default). The budget is absolute rather than a share of the window, because a percentage of a 1M window is unreachable in practice. It adds no model calls of its own, leaves subagent sessions alone, and has a durable cooldown so it cannot compact the same session twice in a row. A terminal half shows a live <code>ctx 44k/150k 29%</code> status line, toasts when a compaction is requested and when the session actually shrinks, and adds <code>/compact-status</code> and <code>/compact-now</code>.
    <br><br>
    <a href="https://github.com/jhanink/opencode-context-compaction">🔗 <b>View Repository</b></a>
  </blockquote>
</details>
```

## Opening the pull request

`gh` is not installed on this machine, so this needs the GitHub web UI (or
`brew install gh && gh auth login`). Fork, add the entry, and open a PR titled
something like `Add OpenCode Context Compaction to plugins`. Keep the diff to the
single block — no reordering of unrelated entries, no whitespace churn.

## Before either step

- The repository URL in the entry, in `package.json`, and in the stars badge must
  match wherever the repo actually lives. Today they all assume
  `github.com/jhanink/opencode-context-compaction`.
- Fix the `author` field and the copyright line in `LICENSE` if they should name
  something other than `jhanink`.
- The repo should be pushed and public first, or the badge and link will 404.
