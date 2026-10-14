/**
 * Pure decision logic for context-compaction.
 *
 * Nothing here imports OpenCode or Solid, so the rules can be unit-tested on
 * their own (see test/lib.test.ts) with a plain TypeScript runtime.
 */

export interface Options {
  /** Hold the trigger off entirely without removing the plugin. */
  enabled: boolean
  /** Compact when the estimated context is at or above this many tokens. */
  maxTokens: number
  /** Estimate for a text-heavy transcript; high estimates compact earlier. */
  charsPerToken: number
  /** How long a session must be quiet before a compaction is requested. */
  idleMs: number
  /** Minimum gap between compactions of the same session. */
  cooldownMs: number
  /** Log and notify instead of requesting compaction. */
  dryRun: boolean
}

export const DEFAULTS: Options = {
  enabled: true,
  // A budget, not a share of the window: 40% of a 1M-token window is 400k,
  // which real sessions never reach, so a percentage rule never fires.
  maxTokens: 150_000,
  charsPerToken: 4,
  idleMs: 45_000,
  cooldownMs: 10 * 60_000,
  dryRun: false,
}

export function resolveOptions(options: Partial<Options> | undefined): Options {
  return { ...DEFAULTS, ...(options ?? {}) }
}

function lengthOf(value: unknown): number {
  const text = (value as { text?: unknown } | undefined)?.text
  if (typeof text === "string") return text.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Rough size of the request about to be assembled: system parts plus messages,
 * serialized and divided by a characters-per-token constant. JSON overhead
 * makes the result skew slightly high, which is the safe direction for a
 * budget — compact a little early rather than too late.
 */
export function estimateTokens(
  event: { system?: readonly unknown[]; messages?: readonly unknown[] } | undefined,
  charsPerToken: number,
): number {
  let chars = 0
  for (const part of event?.system ?? []) chars += lengthOf(part)
  for (const message of event?.messages ?? []) chars += lengthOf(message)
  return Math.round(chars / charsPerToken)
}

export type Decision =
  | { action: "request"; reason: "over-budget" }
  | { action: "skip"; reason: "disabled" | "subagent" | "under-budget" | "cooldown" }

export interface DecisionInput {
  estimated: number
  maxTokens: number
  enabled: boolean
  /** Subagent sessions are short-lived; compacting them buys nothing. */
  isSubagent?: boolean
  /** When this session was last compacted, 0 if never. */
  compactedAt?: number
  now: number
  cooldownMs: number
}

export function decide(input: DecisionInput): Decision {
  if (!input.enabled) return { action: "skip", reason: "disabled" }
  if (input.isSubagent) return { action: "skip", reason: "subagent" }
  if (input.estimated < input.maxTokens) return { action: "skip", reason: "under-budget" }
  if (input.compactedAt && input.now - input.compactedAt < input.cooldownMs) {
    return { action: "skip", reason: "cooldown" }
  }
  return { action: "request", reason: "over-budget" }
}

/** 15234 -> "15k", 1500000 -> "1.5M" */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}
