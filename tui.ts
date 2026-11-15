/**
 * The TUI part of safeapprove.
 * - Toasts for auto-approvals, escalations to a prompt, cases that were not auto-approved (with the reason), and the usage limit
 * - The "SafeApprove: recent decisions" command (/safeapprove) shows the recent decision log
 */
import { Plugin } from "@opencode/plugin/tui"
import { SafeApproveRpc, type DecidedEvent } from "./rpc.ts"

export default Plugin.define({
  id: "safeapprove.tui",
  setup(context) {
    const notifyAllow = context.options.notifyAllow !== false
    const notifyAsk = context.options.notifyAsk !== false
    const rpc = context.client.rpc(SafeApproveRpc)

    const stop = rpc.events.on("decided", (event) => {
      const data = event.data as DecidedEvent
      // The usage limit notice (not tied to a session). Per-command asks while rate limited show as normal asks
      const limitNotice = data.source === "rate_limit" && data.sessionID === ""
      if (data.decision === "allow" && !notifyAllow) return
      if (data.decision === "ask" && !limitNotice && !notifyAsk) return
      const command = data.commands.join(" && ")
      context.ui.toast.show({
        title: limitNotice
          ? "Usage limit — auto-approval paused"
          : data.decision === "allow"
            ? "Auto-approved"
            : data.decision === "escalate"
              ? "Needs confirmation"
              : "Not auto-approved",
        message: limitNotice ? data.summary : `${truncate(command, 80)}\n${data.summary}`,
        variant: data.decision === "allow" ? "success" : "warning",
        duration: data.decision === "allow" ? 3_000 : 6_000,
        ...(data.sessionID ? { sessionID: data.sessionID } : {}),
      })
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "safeapprove.recent",
          title: "SafeApprove: recent decisions",
          group: "SafeApprove",
          palette: true,
          slash: { name: "safeapprove" },
          run: async () => {
            try {
              const result = (await rpc.recent({ limit: 15 })) as {
                entries: Array<Record<string, any>>
                rateLimitedUntil?: number
              }
              const lines = result.entries
                .slice()
                .reverse()
                .map((e) => {
                  const scores = e.scores
                    ? Object.entries(e.scores as Record<string, number>)
                        .map(([k, v]) => `${k === "reversible" ? "rev" : "task"} ${v.toFixed(2)}`)
                        .join(" ")
                    : (e.reason ?? "")
                  const time = new Date(e.time).toLocaleTimeString()
                  return `${time} ${String(e.decision).padEnd(8)} ${String(e.source).padEnd(10)} ${truncate(
                    (e.commands as string[]).join(" && "),
                    50,
                  )}  ${scores}`
                })
              const header = result.rateLimitedUntil
                ? `Rate limited until ${new Date(result.rateLimitedUntil).toLocaleTimeString()}\n\n`
                : ""
              await context.ui.dialog.alert({
                title: "SafeApprove: recent decisions",
                message: header + (lines.length > 0 ? lines.join("\n") : "No decisions yet"),
              })
            } catch (error) {
              context.ui.toast.show({ message: `SafeApprove: cannot read the log (${String(error)})`, variant: "error" })
            }
          },
        },
      ],
    }))

    return () => stop()
  },
})

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
