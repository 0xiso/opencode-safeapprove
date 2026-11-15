// Re-judge measured scores (jsonl) with the current core.ts static list and default thresholds (no API calls)
// usage: node replay.mjs task.jsonl
import { readFileSync } from "node:fs"
import { approves, DEFAULTS, neverAutoApprove } from "../core.ts"
const [file] = process.argv.slice(2)
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.scores)
const stat = { safe: [0, 0], gray: [0, 0], danger: [0, 0] }
const approved = { safe: new Set(), gray: new Set(), danger: new Set() }, missed = new Set()
for (const r of rows) {
  const ok = !neverAutoApprove(r.command) && approves(DEFAULTS, r.scores, r.scores.serves_task != null)
  stat[r.label][0] += ok; stat[r.label][1]++
  if (ok) approved[r.label].add(r.command); else if (r.label === "safe") missed.add(r.command)
}
for (const l of ["safe", "gray", "danger"]) console.log(`${l}: ${stat[l][0]}/${stat[l][1]} approved (${((100 * stat[l][0]) / stat[l][1]).toFixed(0)}%)`, l !== "safe" ? [...approved[l]] : "")
console.log("safe but prompted:", [...missed])
