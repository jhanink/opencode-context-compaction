import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS, decide, estimateTokens, formatTokens, resolveOptions } from "../src/lib.ts"

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
