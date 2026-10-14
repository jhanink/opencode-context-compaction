/**
 * context-compaction — terminal side.
 *
 * Shows what the server-side trigger is doing, in the terminal:
 *
 *   - a status line under the composer: `ctx 44k/150k 29%`, turning
 *     attention-coloured once the session is past the budget;
 *   - a toast when a compaction is requested, and another when the session's
 *     history actually shrinks;
 *   - `/compact-status` (and a palette command) for the full numbers.
 *
 * It never decides anything: the budget and the decisions come from the server
 * plugin over RPC, so the TUI cannot disagree with the trigger.
 *
 * Built without JSX, matching the element tree a Solid transform would emit, so
 * the file loads under the plugin runtime as-is.
 */
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createComponent, createElement, createTextNode, effect, insertNode, setProp } from "@opentui/solid"
import { Plugin } from "@opencode/plugin/tui"
import { formatTokens } from "./lib.ts"
import { ContextCompaction } from "./rpc.ts"

// Events drive updates; this interval is only a low-frequency backstop.
const REFRESH_MS = 10_000

// What the status line last saw, so the command can report the same numbers.
const observed: { sessionID?: string; used: number } = { used: 0 }

function info(message: any) {
  return message?.info ?? message ?? {}
}

/** Tokens the session is carrying: the newest request's input and cache reads. */
function contextTokens(messages: any[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const tokens = info(messages[index]).tokens
    if (!tokens) continue
    const cache = tokens.cache ?? {}
    const total = (tokens.input ?? 0) + (cache.read ?? 0) + (cache.write ?? 0)
    if (total > 0) return total
  }
  return 0
}

function latestCompaction(messages: any[]): any {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = info(messages[index])
    if (message.type === "compaction") return message
  }
  return undefined
}

function StatusLine(props: any) {
  const ctx = props.ctx
  const [usage, setUsage] = createSignal(0)
  const adopted = new Set<string>()
  let lastCompaction: string | undefined

  // Read defensively: the cache can throw if the session is torn down mid-read,
  // and this runs inside event callbacks where an exception would be unhandled.
  const read = () => {
    const sessionID = props.sessionID
    if (!sessionID) return undefined
    try {
      const messages = ctx.data.session.message.list(sessionID) ?? []
      return { used: contextTokens(messages), compaction: latestCompaction(messages) }
    } catch {
      return undefined
    }
  }

  const refresh = () => {
    const current = read()
    if (!current) return
    observed.sessionID = props.sessionID
    observed.used = current.used
    setUsage(current.used)

    const compaction = current.compaction
    if (!compaction) return
    // A compaction already in history when we start watching is adopted, not
    // announced; only one that lands while watching is worth a toast.
    if (!adopted.has(props.sessionID)) {
      adopted.add(props.sessionID)
      lastCompaction = compaction.id
      return
    }
    if (compaction.id === lastCompaction) return
    lastCompaction = compaction.id
    ctx.ui.toast.show({
      title: "Context compacted",
      message: `session context is now ~${formatTokens(current.used)} tokens`,
      duration: 6000,
    })
  }

  const resync = () => {
    refresh()
    const sessionID = props.sessionID
    if (!sessionID) return
    try {
      void Promise.resolve(ctx.data.session.message.sync(sessionID)).then(refresh, refresh)
    } catch {
      // best effort: the interval backstop covers failures
    }
  }

  // The slot may stay mounted while the session changes underneath it.
  createEffect(() => {
    void props.sessionID
    refresh()
    const recovery = [setTimeout(refresh, 400), setTimeout(refresh, 1500), setTimeout(refresh, 4000)]
    onCleanup(() => {
      for (const timer of recovery) clearTimeout(timer)
    })
  })

  onMount(() => {
    resync()
    const stops = [
      ctx.data.on("message.updated", resync),
      ctx.data.on("message.removed", resync),
      ctx.data.on("session.updated", resync),
      ctx.data.on("session.idle", resync),
    ]
    const interval = setInterval(resync, REFRESH_MS)
    onCleanup(() => {
      for (const stop of stops) {
        try {
          stop()
        } catch {
          // ignore
        }
      }
      clearInterval(interval)
    })
  })

  const budget = () => props.budget

  const label = () => {
    const used = usage()
    if (!used) return ""
    const limit = budget()
    if (!limit) return `ctx ~${formatTokens(used)}`
    const share = Math.round((used / limit) * 100)
    const over = used >= limit ? " · compacts at idle" : ""
    return `ctx ${formatTokens(used)}/${formatTokens(limit)} ${share}%${over}`
  }

  const color = () => {
    const limit = budget()
    const theme = ctx.theme ?? {}
    if (limit && usage() >= limit) return theme.text?.warn ?? theme.text?.base
    return theme.text?.muted ?? theme.text?.base
  }

  const text = createElement("text")
  setProp(text, "wrapMode", "none")
  insert(text, () => label())
  effect((previous: any) => setProp(text, "fg", color(), previous))
  return text
}

export default Plugin.define({
  id: "opencode-context-compaction",

  async setup(context: any) {
    const [status, setStatus] = createSignal<any>(undefined)
    const compaction = context.client.rpc(ContextCompaction)

    // Ask the server plugin for the settings in use, rather than duplicating
    // them here where they would drift.
    const loadStatus = async () => {
      try {
        setStatus(await compaction.status())
      } catch {
        // Server plugin absent or still starting: show usage without a budget.
      }
    }
    await loadStatus()

    const stopDecisions = compaction.events.on("decision", (event: any) => {
      const data = event?.data ?? {}
      const estimated = formatTokens(data.estimated ?? 0)
      const limit = formatTokens(data.maxTokens ?? 0)
      if (data.phase === "requested") {
        context.ui.toast.show({
          title: "Context compaction",
          message: `~${estimated} tokens over a ${limit} budget — compacting now`,
          duration: 6000,
        })
      } else if (data.phase === "dry-run") {
        context.ui.toast.show({
          title: "Context compaction (dry run)",
          message: `would compact ~${estimated} tokens against a ${limit} budget`,
          duration: 6000,
        })
      } else if (data.phase === "cooldown") {
        context.ui.toast.show({
          title: "Context compaction",
          message: `~${estimated} tokens over budget, but inside the cooldown window`,
          duration: 5000,
        })
      }
    })

    const showStatus = async () => {
      const current = status()
      const used = observed.used
      const limit = current?.maxTokens
      const lines = [
        current?.enabled === false ? "trigger: disabled" : "trigger: armed",
        limit ? `budget: ~${formatTokens(limit)} tokens` : "budget: unknown (server plugin not answering)",
        used ? `this session: ~${formatTokens(used)} tokens${limit ? ` (${Math.round((used / limit) * 100)}%)` : ""}` : "this session: no request seen yet",
        current ? `idle before acting: ${Math.round(current.idleMs / 1000)}s` : "",
        current ? `cooldown: ${Math.round(current.cooldownMs / 60_000)} min` : "",
        current?.dryRun ? "dry run: on (nothing is compacted)" : "",
        "",
        "/compact-now compacts immediately.",
      ].filter(Boolean)
      await context.ui.dialog.alert({ title: "Context compaction", message: lines.join("\n") })
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "context-compaction.status",
          title: "Context budget: show status",
          group: "Context",
          palette: true,
          slash: { name: "compact-status" },
          run: () => showStatus(),
        },
      ],
      bindings: ["context-compaction.status"],
    }))

    const unregisterSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (props: any) =>
        createComponent(StatusLine, {
          ctx: context,
          get sessionID() {
            return props.sessionID
          },
          get budget() {
            return status()?.maxTokens
          },
        }),
    })

    return () => {
      try {
        stopDecisions?.()
      } catch {
        // ignore
      }
      try {
        unregisterSlot?.()
      } catch {
        // ignore
      }
    }
  },
})
