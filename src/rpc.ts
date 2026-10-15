/**
 * The contract between the server plugin and the terminal plugin.
 *
 * The server side owns the budget and knows when a compaction is requested; the
 * terminal side renders it. Sharing the contract keeps the budget in one place
 * instead of duplicating a constant that can drift.
 */
import { Rpc } from "@opencode/plugin/rpc"

export const ContextCompaction = Rpc.define({
  id: "context-compaction",
  methods: {
    /** Current settings, so the terminal shows the numbers actually in use. */
    status: {
      // Deliberately an empty object schema rather than an omitted `input`:
      // this server version dereferences the input schema even for
      // argument-less methods, and a missing one throws internally.
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          dryRun: { type: "boolean" },
          maxTokens: { type: "number" },
          charsPerToken: { type: "number" },
          idleMs: { type: "number" },
          cooldownMs: { type: "number" },
          history: { type: "boolean" },
          historyRecords: { type: "number" },
          historyLastAt: { type: "number" },
        },
        required: [
          "enabled",
          "dryRun",
          "maxTokens",
          "charsPerToken",
          "idleMs",
          "cooldownMs",
          "history",
          "historyRecords",
          "historyLastAt",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {
    /** A decision worth telling the user about, per session. */
    decision: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          phase: { type: "string", enum: ["requested", "dry-run", "cooldown"] },
          estimated: { type: "number" },
          maxTokens: { type: "number" },
        },
        required: ["sessionID", "phase", "estimated", "maxTokens"],
        additionalProperties: false,
      },
    },
  },
})
