import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULTS,
  HISTORY_PREFIX,
  compactionEntry,
  countChars,
  decide,
  decisionEntry,
  estimateTokens,
  formatTokens,
  historyKey,
  resolveOptions,
  takeOrigin,
} from "../src/lib.ts"

const budget = { maxTokens: 100_000, cooldownMs: 600_000, now: 1_000_000 }
const over = 150_000
const under = 40_000

test("estimates tokens from system parts and messages", () => {
  const event = {
    system: [{ text: "a".repeat(400) }],
    messages: [{ role: "user", content: "b".repeat(400) }],
  }
  // 800 characters of text plus a little JSON overhead, over 4 chars/token.
  const estimated = estimateTokens(event, 4)
  assert.ok(estimated >= 200 && estimated <= 240, `expected ~200-240, got ${estimated}`)
})

test("an empty event estimates zero, not NaN", () => {
  assert.equal(estimateTokens(undefined, 4), 0)
  assert.equal(estimateTokens({}, 4), 0)
})

test("circular or unserializable parts do not throw", () => {
  const circular: any = { role: "user" }
  circular.self = circular
  assert.ok(Number.isFinite(estimateTokens({ messages: [circular] }, 4)))
})

test("skips a session under budget", () => {
  const decision = decide({ ...budget, estimated: under, enabled: true })
  assert.deepEqual(decision, { action: "skip", reason: "under-budget" })
})

test("requests compaction at or over budget", () => {
  assert.deepEqual(decide({ ...budget, estimated: over, enabled: true }), {
    action: "request",
    reason: "over-budget",
  })
  // The boundary counts as over: the budget is a ceiling, not a threshold to exceed.
  assert.deepEqual(decide({ ...budget, estimated: budget.maxTokens, enabled: true }), {
    action: "request",
    reason: "over-budget",
  })
})

test("never compacts a subagent session, however large", () => {
  assert.deepEqual(decide({ ...budget, estimated: over, enabled: true, isSubagent: true }), {
    action: "skip",
    reason: "subagent",
  })
})

test("respects the cooldown after a compaction", () => {
  const compactedAt = budget.now - 60_000 // one minute ago, inside 10 minutes
  assert.deepEqual(decide({ ...budget, estimated: over, enabled: true, compactedAt }), {
    action: "skip",
    reason: "cooldown",
  })
})

test("allows a compaction once the cooldown has elapsed", () => {
  const compactedAt = budget.now - budget.cooldownMs
  assert.deepEqual(decide({ ...budget, estimated: over, enabled: true, compactedAt }), {
    action: "request",
    reason: "over-budget",
  })
})

test("disabled wins over every other reason", () => {
  assert.deepEqual(decide({ ...budget, estimated: over, enabled: false, isSubagent: true }), {
    action: "skip",
    reason: "disabled",
  })
})

test("formats token counts for display", () => {
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(-5), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(15_234), "15k")
  assert.equal(formatTokens(150_000), "150k")
  assert.equal(formatTokens(1_500_000), "1.5M")
})

test("options override defaults without dropping the rest", () => {
  const resolved = resolveOptions({ maxTokens: 20_000 })
  assert.equal(resolved.maxTokens, 20_000)
  assert.equal(resolved.idleMs, DEFAULTS.idleMs)
  assert.equal(resolved.dryRun, false)
  assert.deepEqual(resolveOptions(undefined), DEFAULTS)
})

test("history is off unless it was asked for", () => {
  assert.equal(DEFAULTS.history, false)
  assert.equal(resolveOptions(undefined).history, false)
  assert.equal(resolveOptions({ history: true }).history, true)
})

test("counts characters once, for both the estimate and the record", () => {
  const event = { system: [{ text: "abcd" }], messages: [{ text: "efgh" }] }
  assert.equal(countChars(event), 8)
  assert.equal(estimateTokens(event, 4), 2)
  // The record keeps the raw count, so the estimate can be re-divided later
  // without re-reading a transcript that has already been rewritten.
  assert.equal(compactionEntry({ at: 0, sessionID: "s", origin: "rule", event, charsPerToken: 4 }).chars, 8)
})

test("history keys sort into the order they were written", () => {
  assert.ok(historyKey(1_000, 0) < historyKey(2_000, 0))
  assert.ok(historyKey(2_000, 0) < historyKey(2_000, 1))
  // Fixed width, so a shorter timestamp cannot sort after a longer one.
  assert.ok(historyKey(999, 0) < historyKey(1_000, 0))
  assert.ok(historyKey(1_000, 0).startsWith(HISTORY_PREFIX))
})

test("records a held decision with the reason it was held", () => {
  const entry = decisionEntry({
    at: 5_000,
    sessionID: "ses_x",
    decision: { action: "skip", reason: "cooldown" },
    estimated: 200_000,
    maxTokens: 150_000,
    dryRun: false,
    compactedAt: 4_000,
  })
  assert.deepEqual(entry, {
    kind: "decision",
    at: 5_000,
    sessionID: "ses_x",
    action: "skip",
    reason: "cooldown",
    estimated: 200_000,
    maxTokens: 150_000,
    dryRun: false,
    sinceCompactionMs: 1_000,
  })
})

test("a decision with no prior compaction reports no gap", () => {
  const entry = decisionEntry({
    at: 5_000,
    sessionID: "ses_x",
    decision: { action: "request", reason: "over-budget" },
    estimated: 200_000,
    maxTokens: 150_000,
    dryRun: false,
  })
  assert.equal(entry.sinceCompactionMs, 0)
})

test("records a compaction with the size of the transcript it summarized", () => {
  const event = {
    system: [{ text: "a".repeat(400) }],
    messages: [{ text: "b".repeat(400) }, { text: "c".repeat(400) }],
  }
  const entry = compactionEntry({
    at: 10,
    sessionID: "ses_y",
    origin: "rule",
    event,
    charsPerToken: 4,
    agent: "build",
    model: "deepseek-v4.1-flash",
    providerID: "opencode-go",
  })
  assert.equal(entry.chars, 1_200)
  assert.equal(entry.messages, 2)
  assert.equal(entry.estimated, 300)
  assert.equal(entry.origin, "rule")
  assert.equal(entry.model, "deepseek-v4.1-flash")
})

test("attributes a compaction to the request that caused it, once", () => {
  const pending = new Map<string, { at: number; origin: "rule" | "command" }>([
    ["ses_a", { at: 1_000, origin: "rule" }],
  ])
  assert.equal(takeOrigin(pending, "ses_a", 2_000), "rule")
  // One request explains one compaction; a second must not inherit it.
  assert.equal(takeOrigin(pending, "ses_a", 3_000), "external")
  assert.equal(takeOrigin(pending, "ses_b", 3_000), "external")
})

test("a compaction nobody asked for is external, not ours", () => {
  assert.equal(takeOrigin(new Map(), "ses_a", 1_000), "external")
})

test("an on-demand compaction is attributed to the command", () => {
  const pending = new Map<string, { at: number; origin: "rule" | "command" }>([
    ["ses_a", { at: 5_000, origin: "command" }],
  ])
  assert.equal(takeOrigin(pending, "ses_a", 6_000), "command")
})

test("a request that never landed does not claim a later compaction", () => {
  const pending = new Map<string, { at: number; origin: "rule" | "command" }>([
    ["ses_a", { at: 1_000, origin: "rule" }],
  ])
  // Well past the attribution window: OpenCode must have compacted on its own.
  assert.equal(takeOrigin(pending, "ses_a", 1_000 + 60 * 60_000), "external")
})
