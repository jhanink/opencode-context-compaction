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
import { decide, estimateTokens, formatTokens, resolveOptions } from "./lib.ts"
import { ContextCompaction } from "./rpc.ts"

type Seen = { estimated: number; compactedAt?: number }

export default Plugin.define({
  id: "context-compaction",

  async setup(ctx: any) {
    const opts = resolveOptions(ctx.options)
    const log = (...args: unknown[]) => console.log("[context-compaction]", ...args)

    const pending = new Map<string, any>() // sessionID -> debounce timer
    const seen = new Map<string, Seen>() // sessionID -> last observation

    // Tell the terminal plugin what is happening. Registration can fail (an
    // older server, a conflicting id); the trigger must keep working either way.
    let emit: ((phase: string, sessionID: string, estimated: number) => void) | undefined
    try {
      const registration: any = await ctx.rpc.register(ContextCompaction, {
        status: async () => ({
          enabled: opts.enabled,
          dryRun: opts.dryRun,
          maxTokens: opts.maxTokens,
          charsPerToken: opts.charsPerToken,
          idleMs: opts.idleMs,
          cooldownMs: opts.cooldownMs,
        }),
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
      const decision = decide({
        estimated: record.estimated,
        maxTokens: opts.maxTokens,
        enabled: opts.enabled,
        isSubagent: Boolean(info.parentID),
        compactedAt: await lastCompactedAt(sessionID),
        now,
        cooldownMs: opts.cooldownMs,
      })

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
      // "queue" keeps the request behind anything already waiting, so a prompt
      // sent in the meantime is not held up behind the summary.
      await ctx.session.compact({ sessionID, delivery: "queue" })
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
          await ctx.session.compact({ sessionID, delivery: "queue" })
        },
      })
    })

    log(
      `loaded — ${opts.enabled ? `compact above ~${formatTokens(opts.maxTokens)} tokens after ${opts.idleMs}ms quiet` : "trigger disabled"}` +
        `${opts.dryRun ? " (dry run)" : ""}`,
    )

    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      seen.clear()
    }
  },
})
