/**
 * Contract between the server part (index.ts) and the TUI part (tui.ts).
 * - events.decided: tells the TUI about auto-approvals, escalations, cases that need a prompt, and usage limits
 * - methods.recent: returns the recent decision log
 */
import { Rpc } from "@opencode/plugin/rpc"

export const SafeApproveRpc = Rpc.define({
  id: "safeapprove",
  methods: {
    recent: {
      input: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          entries: { type: "array", items: { type: "object" } },
          rateLimitedUntil: { type: "number" },
        },
        required: ["entries"],
      },
    },
  },
  events: {
    decided: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          commands: { type: "array", items: { type: "string" } },
          decision: { type: "string", enum: ["allow", "ask", "escalate"] },
          source: { type: "string" },
          summary: { type: "string" },
        },
        required: ["sessionID", "commands", "decision", "source", "summary"],
        additionalProperties: false,
      },
    },
  },
})

export type DecidedEvent = {
  sessionID: string
  commands: string[]
  decision: "allow" | "ask" | "escalate"
  source: string
  summary: string
}
