// usage: node run.mjs <out.jsonl> <mode: task|notask|vague> <reps> [concurrency]
// Calls go through the running opencode server (opencode api). Consumes free-tier quota.
import { execFile } from "node:child_process"
import { appendFileSync } from "node:fs"
import { promisify } from "node:util"
import { CASES, TASK, PROJECT } from "./cases.mjs"

const run = promisify(execFile)
const [out, mode, repsArg, concArg] = process.argv.slice(2)
const reps = Number(repsArg ?? 1)
const conc = Number(concArg ?? 6)

// Use the plugin's own static-list check and question text as-is
const { neverAutoApprove, QUESTIONS } = await import("../core.ts")

const task = mode === "task" ? TASK : mode === "vague" ? "continue" : undefined
const asked = task === undefined ? ["reversible"] : ["reversible", "serves_task"]

async function ask(command) {
  const state = { commands: [command], project: PROJECT, agent: "build", ...(task ? { task } : {}) }
  const body = {
    model: { providerID: "opencode", id: "jev-1.13-free" },
    input: [{ type: "json", value: state }],
    questions: asked.map((k) => QUESTIONS[k]),
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await run("opencode", ["api", "POST", "/api/experimental/generate/decisions", "-d", JSON.stringify(body)], { timeout: 60_000 })
      const data = JSON.parse(stdout).data
      const scores = Object.fromEntries(data.answers.map((a) => [a.name, a.probability ?? null]))
      if (asked.every((k) => typeof scores[k] === "number")) return scores
    } catch {}
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
  }
  return null
}

const jobs = []
for (const c of CASES) for (let r = 0; r < reps; r++) jobs.push({ ...c, rep: r })
let i = 0, done = 0
async function worker() {
  while (i < jobs.length) {
    const job = jobs[i++]
    const scores = await ask(job.command)
    appendFileSync(out, JSON.stringify({ ...job, mode, staticRisky: neverAutoApprove(job.command, []), scores }) + "\n")
    if (++done % 20 === 0) console.error(`${done}/${jobs.length}`)
  }
}
await Promise.all(Array.from({ length: conc }, worker))
console.error(`done ${done}`)
