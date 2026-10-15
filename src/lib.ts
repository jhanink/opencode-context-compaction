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
  /** Keep a durable record of decisions and compactions, for later analysis. */
  history: boolean
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
  // Off by default: records land in OpenCode's own database, which is the
  // user's, so writing there is something they opt into rather than inherit.
  history: false,
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
 * Characters in the request about to be assembled: system parts plus messages.
 * Every size estimate is this number over a per-token constant, so the raw
 * count is worth keeping for the history — it can be re-divided later.
 */
export function countChars(
  event: { system?: readonly unknown[]; messages?: readonly unknown[] } | undefined,
): number {
  let chars = 0
  for (const part of event?.system ?? []) chars += lengthOf(part)
  for (const message of event?.messages ?? []) chars += lengthOf(message)
  return chars
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
  return Math.round(countChars(event) / charsPerToken)
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

/**
 * Optional history.
 *
 * Off unless asked for. It exists to answer what the trigger cannot answer
 * about itself: whether a given compaction was ours or OpenCode's, and how far
 * the `charsPerToken` estimate sits from the token count the provider actually
 * reported. Records hold sizes and counts only — never message content — and
 * they live in plugin storage, which is the user's database, so the list is
 * capped rather than left to grow.
 */
export type Origin = "rule" | "command" | "external"

export interface DecisionRecord {
  kind: "decision"
  at: number
  sessionID: string
  action: Decision["action"]
  reason: Decision["reason"]
  estimated: number
  maxTokens: number
  dryRun: boolean
  /** Milliseconds since this session last compacted; 0 if it never has. */
  sinceCompactionMs: number
}

export interface CompactionRecord {
  kind: "compaction"
  at: number
  sessionID: string
  origin: Origin
  /** The same estimator the trigger uses, over the transcript being summarized. */
  estimated: number
  chars: number
  messages: number
  agent?: string
  model?: string
  providerID?: string
}

export type HistoryEntry = DecisionRecord | CompactionRecord

/** Newest records kept; the oldest are pruned as new ones arrive. */
export const HISTORY_LIMIT = 2_000

/** Storage key prefix, so this never collides with a plugin's other keys. */
export const HISTORY_PREFIX = "history/"

/**
 * How long a requested compaction stays attributable to the plugin. OpenCode
 * admits the request and compacts at the next step boundary, so the gap is
 * normally seconds; a request that never lands must not go on to claim a
 * compaction OpenCode started on its own.
 */
export const PENDING_TTL_MS = 30 * 60_000

/**
 * Keys carry a zero-padded timestamp, so a prefix scan returns records in the
 * order they were written and pruning can drop from the front. The sequence
 * only breaks ties within the same millisecond.
 */
export function historyKey(at: number, seq: number): string {
  return `${HISTORY_PREFIX}${String(at).padStart(16, "0")}-${String(seq).padStart(6, "0")}`
}

export function decisionEntry(input: {
  at: number
  sessionID: string
  decision: Decision
  estimated: number
  maxTokens: number
  dryRun: boolean
  compactedAt?: number
}): DecisionRecord {
  return {
    kind: "decision",
    at: input.at,
    sessionID: input.sessionID,
    action: input.decision.action,
    reason: input.decision.reason,
    estimated: input.estimated,
    maxTokens: input.maxTokens,
    dryRun: input.dryRun,
    sinceCompactionMs: input.compactedAt ? Math.max(0, input.at - input.compactedAt) : 0,
  }
}

export function compactionEntry(input: {
  at: number
  sessionID: string
  origin: Origin
  event?: { system?: readonly unknown[]; messages?: readonly unknown[] }
  charsPerToken: number
  agent?: string
  model?: string
  providerID?: string
}): CompactionRecord {
  return {
    kind: "compaction",
    at: input.at,
    sessionID: input.sessionID,
    origin: input.origin,
    estimated: estimateTokens(input.event, input.charsPerToken),
    chars: countChars(input.event),
    messages: input.event?.messages?.length ?? 0,
    agent: input.agent,
    model: input.model,
    providerID: input.providerID,
  }
}

/**
 * Who a compaction that is starting now belongs to. Consumes the session's
 * pending marker, because one request can only explain one compaction.
 * Mutates `pending`.
 */
export function takeOrigin(
  pending: Map<string, { at: number; origin: "rule" | "command" }>,
  sessionID: string,
  now: number,
  ttlMs: number = PENDING_TTL_MS,
): Origin {
  const held = pending.get(sessionID)
  if (!held) return "external"
  pending.delete(sessionID)
  return now - held.at > ttlMs ? "external" : held.origin
}
