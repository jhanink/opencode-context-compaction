/**
 * context-compaction — server side.
 *
 * OpenCode's built-in trigger fires near the window ceiling (limit minus
 * `compaction.buffer`), which on a 1M-token model means roughly 900k. A long
 * session can sit at 150-250k all afternoon and never compact. This plugin
 * watches the context assembled for each model call and, once a session has
 * gone quiet and its context passes a budget, asks OpenCode to compact — the
 * same compaction the built-in trigger uses, requested at an idle moment
 * instead of mid-task at the ceiling.
 *
 * Cost shape: no model calls of its own. The compaction it requests costs one
 * summary call plus a prompt-cache miss on the next request, because the
 * conversation is rewritten. That cost exists because a compaction happened;
 * the plugin decides when, not whether.
 *
 * The terminal side lives in ./tui.ts and reads its numbers over RPC, so what
 * the TUI shows is what the trigger uses.
 */
import { Plugin } from "@opencode/plugin"
import {
  HISTORY_LIMIT,
  HISTORY_PREFIX,
  compactionEntry,
  decide,
  decisionEntry,
  estimateTokens,
  formatTokens,
  historyKey,
  resolveOptions,
  takeOrigin,
  type HistoryEntry,
} from "./lib.ts"
import { ContextCompaction } from "./rpc.ts"

type Seen = { estimated: number; compactedAt?: number }

export default Plugin.define({
  id: "context-compaction",

  async setup(ctx: any) {
    const opts = resolveOptions(ctx.options)
    const log = (...args: unknown[]) => console.log("[context-compaction]", ...args)

    const pending = new Map<string, any>() // sessionID -> debounce timer
    const seen = new Map<string, Seen>() // sessionID -> last observation

    // Compactions this plugin has asked for that have not landed yet. OpenCode
    // admits the request and compacts at the next step boundary, so the request
    // and the compaction are separated in time; this marker is what lets the
    // history say whether a compaction was ours or OpenCode's own.
    const requested = new Map<string, { at: number; origin: "rule" | "command" }>()

    // Optional history. Deliberately low volume — one record per decision, one
    // per compaction — because the per-request token counts an analysis of the
    // budget actually needs are already in OpenCode's own database, and are not
    // worth duplicating. See the "History" section of the README.
    let seq = 0
    let writes = 0
    const PRUNE_EVERY = 100

    const prune = async (): Promise<void> => {
      // Keys come back oldest-first, so anything over the cap is at the front.
      const keys: string[] = []
      let after: string | undefined
      do {
        const page: any = await ctx.storage.scan({ prefix: HISTORY_PREFIX, after, limit: 500 })
        for (const found of page?.entries ?? []) keys.push(found.key)
        after = page?.next
      } while (after)
      for (let index = 0; index < keys.length - HISTORY_LIMIT; index += 1) {
        await ctx.storage.remove(keys[index])
      }
    }

    // Fire and forget: a compaction must never wait on our bookkeeping.
    const write = (entry: HistoryEntry): void => {
      if (!opts.history) return
      const key = historyKey(entry.at, seq)
      seq += 1
      void (async () => {
        try {
          await ctx.storage.set(key, entry)
          if (writes++ % PRUNE_EVERY === 0) await prune()
        } catch (error) {
          log("history write failed:", error)
        }
      })()
    }

    // Observe every compaction, including the ones OpenCode starts on its own —
    // which is the comparison worth having. Strictly an observer: setting
    // `result` on this event would replace the summary OpenCode was going to
    // generate, so this hook never touches anything but its own record.
    if (opts.history) {
      try {
        await ctx.session.hook("compaction", (event: any) => {
          const at = Date.now()
          write(
            compactionEntry({
              at,
              sessionID: event.sessionID,
              origin: takeOrigin(requested, event.sessionID, at),
              event,
              charsPerToken: opts.charsPerToken,
              agent: event.agent,
              model: event.model?.id,
              providerID: event.model?.providerID,
            }),
          )
        })
      } catch (error) {
        log("history hook unavailable — compactions will not be attributed:", error)
      }
    }

    // Tell the terminal plugin what is happening. Registration can fail (an
    // older server, a conflicting id); the trigger must keep working either way.
    let emit: ((phase: string, sessionID: string, estimated: number) => void) | undefined
    try {
      const registration: any = await ctx.rpc.register(ContextCompaction, {
        status: async () => {
          // Counted from storage, not from memory. The plugin is instantiated
          // per location, so the instance answering this call is frequently
          // not the one whose hook wrote the records — an in-memory counter
          // reports zero there while records plainly exist. Storage is shared.
          let records = 0
          let lastWriteAt = 0
          if (opts.history) {
            try {
              let after: string | undefined
              do {
                const page: any = await ctx.storage.scan({ prefix: HISTORY_PREFIX, after, limit: 500 })
                for (const found of page?.entries ?? []) {
                  records += 1
                  // Keys lead with a zero-padded millisecond stamp.
                  const stamped = Number(
                    String(found.key).slice(HISTORY_PREFIX.length, HISTORY_PREFIX.length + 16),
                  )
                  if (Number.isFinite(stamped)) lastWriteAt = Math.max(lastWriteAt, stamped)
                }
                after = page?.next
              } while (after)
            } catch {
              // -1 rather than 0: an unreadable history must not be
              // indistinguishable from an empty one, which is the exact
              // failure this field exists to catch.
              records = -1
            }
          }
          return {
            enabled: opts.enabled,
            dryRun: opts.dryRun,
            maxTokens: opts.maxTokens,
            charsPerToken: opts.charsPerToken,
            idleMs: opts.idleMs,
            cooldownMs: opts.cooldownMs,
            history: opts.history,
            historyRecords: records,
            historyLastAt: lastWriteAt,
          }
        },
      })
      emit = (phase, sessionID, estimated) => {
        void Promise.resolve(
          registration.events.emit("decision", {
            sessionID,
            phase,
            estimated,
            maxTokens: opts.maxTokens,
          }),
        ).catch(() => {})
      }
    } catch (error) {
      log("RPC unavailable — the trigger still runs, the TUI just cannot show it:", error)
    }

    // The cooldown latch lives in plugin storage so a reload mid-session still
    // respects it rather than compacting twice in a row.
    const lastCompactedAt = async (sessionID: string): Promise<number> => {
      try {
        const value = await ctx.storage.get(`last:${sessionID}`)
        if (typeof value === "number") return value
      } catch {
        // fall through to the in-memory record
      }
      return seen.get(sessionID)?.compactedAt ?? 0
    }

    const markCompacted = async (sessionID: string, now: number) => {
      const record = seen.get(sessionID) ?? { estimated: 0 }
      record.compactedAt = now
      seen.set(sessionID, record)
      try {
        await ctx.storage.set(`last:${sessionID}`, now)
      } catch {
        // in-memory record above still guards the cooldown
      }
    }

    const act = async (sessionID: string) => {
      pending.delete(sessionID)
      const record = seen.get(sessionID)
      if (!record) return

      const now = Date.now()
      const info = await ctx.session.get({ sessionID })
      const compactedAt = await lastCompactedAt(sessionID)
      const decision = decide({
        estimated: record.estimated,
        maxTokens: opts.maxTokens,
        enabled: opts.enabled,
        isSubagent: Boolean(info.parentID),
        compactedAt,
        now,
        cooldownMs: opts.cooldownMs,
      })
      write(
        decisionEntry({
          at: now,
          sessionID,
          decision,
          estimated: record.estimated,
          maxTokens: opts.maxTokens,
          dryRun: opts.dryRun,
          compactedAt,
        }),
      )

      if (decision.action === "skip") {
        if (decision.reason === "cooldown") emit?.("cooldown", sessionID, record.estimated)
        return
      }

      const size = `~${formatTokens(record.estimated)} tokens over a ${formatTokens(opts.maxTokens)} budget`
      if (opts.dryRun) {
        log(`would compact ${sessionID}: ${size}`)
        emit?.("dry-run", sessionID, record.estimated)
        return
      }

      log(`compacting ${sessionID}: ${size}`)
      await markCompacted(sessionID, now)
      emit?.("requested", sessionID, record.estimated)
      requested.set(sessionID, { at: now, origin: "rule" })
      try {
        // "queue" keeps the request behind anything already waiting, so a prompt
        // sent in the meantime is not held up behind the summary.
        await ctx.session.compact({ sessionID, delivery: "queue" })
      } catch (error) {
        // The request never landed, so it must not claim a later compaction.
        requested.delete(sessionID)
        throw error
      }
    }

    if (opts.enabled) {
      await ctx.session.hook("context", (event: any) => {
        const record = seen.get(event.sessionID) ?? { estimated: 0 }
        record.estimated = estimateTokens(event, opts.charsPerToken)
        seen.set(event.sessionID, record)

        // Debounce: act once the session stops issuing model calls, not between
        // the calls of a single turn.
        const timer = pending.get(event.sessionID)
        if (timer) clearTimeout(timer)
        pending.set(
          event.sessionID,
          setTimeout(() => {
            act(event.sessionID).catch((error) => log("compaction request failed:", error))
          }, opts.idleMs),
        )
      })
    }

    // The on-demand counterpart, since the built-in trigger is window-based.
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "compact-now",
        description: "Compact this session now",
        execute: async ({ sessionID }: any) => {
          // Marked for the same reason the trigger marks its own request: the
          // history should record that a compaction was asked for, not infer it.
          requested.set(sessionID, { at: Date.now(), origin: "command" })
          try {
            await ctx.session.compact({ sessionID, delivery: "queue" })
          } catch (error) {
            requested.delete(sessionID)
            throw error
          }
        },
      })
    })

    log(
      `loaded — ${opts.enabled ? `compact above ~${formatTokens(opts.maxTokens)} tokens after ${opts.idleMs}ms quiet` : "trigger disabled"}` +
        `${opts.dryRun ? " (dry run)" : ""}` +
        `${opts.history ? " (history on)" : ""}`,
    )

    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      seen.clear()
      requested.clear()
    }
  },
})
