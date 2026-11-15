// Aggregates the decision log and lists candidates for fixing the decision logic (the only API call is a local RPC to the opencode server).
//
//   node log-review.mjs              Take the log from a running opencode (RPC on /safeapprove)
//   node log-review.mjs <file.jsonl> Read JSONL written by the logFile option
//
// What to look for
// - Asked, and you allowed it (once / always): candidates that should have been let through. Useful material for loosening the static lists or decision criteria
// - Asked, and you rejected it: examples of correctly blocked calls
// - Auto-approved: check whether anything that should have been blocked slipped through
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const [file] = process.argv.slice(2)
let entries
if (file) {
  const byKey = new Map()
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    const e = JSON.parse(line)
    if (!Array.isArray(e.commands)) {
      console.error(`${file} does not look like a decision log: entry at ${e.time ?? "(no time)"} has no "commands" array.`)
      console.error("Pass the JSONL written by the logFile option, or omit the argument to read the log over RPC.")
      process.exit(1)
    }
    // Reply lines (kind: "reply") overwrite the entry for the same decision
    byKey.set(`${e.time}:${e.toolCallID ?? e.commands.join("\n")}`, e)
  }
  entries = [...byKey.values()]
} else {
  const out = execFileSync("opencode", ["api", "POST", "/api/rpc/safeapprove/recent", "-d", JSON.stringify({ input: { limit: 100000 } })], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const json = JSON.parse(out)
  const data = json.data ?? json
  entries = data.output?.entries ?? data.entries ?? []
}

const fmtTime = (t) => new Date(t).toLocaleString()
const cmd = (e) => (e.fullCommand ?? e.commands.join(" ⏎ ")).replace(/\n/g, " ⏎ ")
const short = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// Strip the details of a reason (commands in parentheses etc.) so reasons of the same kind group together
const reasonKind = (r = "") => r.replace(/\s*\(.*$/s, "").replace(/: .*$/s, "").trim() || "(no reason)"

console.log(`Decision log: ${entries.length} entries (${entries.length ? `${fmtTime(entries[0].time)} – ${fmtTime(entries.at(-1).time)}` : "none"})\n`)

const count = {}
for (const e of entries) count[`${e.decision} / ${e.source}`] = (count[`${e.decision} / ${e.source}`] ?? 0) + 1
console.log("Decisions by source:")
for (const [k, v] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`)

const asked = entries.filter((e) => e.decision !== "allow")
const approved = asked.filter((e) => e.userReply === "once" || e.userReply === "always")
const rejected = asked.filter((e) => e.userReply === "reject")
const unknown = asked.filter((e) => e.userReply === undefined)
console.log(`\nAsked: ${asked.length} entries (you allowed ${approved.length} / rejected ${rejected.length} / no reply recorded ${unknown.length})`)

const byReason = (list) => {
  const groups = new Map()
  for (const e of list) {
    const k = `${e.source}: ${reasonKind(e.reason)}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
}

if (approved.length) {
  console.log("\n■ Asked, but you allowed it (candidates for loosening the rules)")
  for (const [k, list] of byReason(approved)) {
    console.log(`  [${list.length}] ${k}`)
    for (const e of list.slice(0, 5)) console.log(`      ${short(cmd(e))}${e.reason ? `\n        └ ${short(e.reason, 100)}` : ""}`)
  }
}
if (rejected.length) {
  console.log("\n■ Asked, and you rejected it (correctly blocked)")
  for (const [k, list] of byReason(rejected)) console.log(`  [${list.length}] ${k}: ${short(cmd(list[0]), 80)}`)
}
if (unknown.length) {
  console.log("\n■ Asked (no reply recorded; only entries after the reply-recording feature was added)")
  for (const [k, list] of byReason(unknown)) {
    console.log(`  [${list.length}] ${k}`)
    for (const e of list.slice(0, 3)) console.log(`      ${short(cmd(e))}`)
  }
}

const allowed = entries.filter((e) => e.decision === "allow")
console.log(`\n■ Auto-approved: ${allowed.length} entries (last 15; check whether anything that should have been blocked slipped through)`)
for (const e of allowed.slice(-15)) console.log(`  ${fmtTime(e.time).padEnd(22)} ${short(cmd(e), 90)}`)
