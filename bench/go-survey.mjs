// Runs the full OpenCode Go model survey.
//
//   OPENCODE_GO_API_KEY=... node go-survey.mjs [options]
//
// 1. Fetch the Go model list and find new models by comparing with past results (go-results/*)
// 2. Use a pre-screen (4 cases) to drop models that are unusable, too expensive, or too slow
// 3. Measure the rest with the base set (85 cases) and the hard set (56 cases)
// 4. Combine with past results and write the ranking and recommendations to go-results/<date>/report.md
// 5. With --verify N, also check the top N recommendations through opencode (the same path as the plugin)
//
// options:
//   --models new|all|<id,id>  Models to measure (default new = models not measured before)
//   --out <dir>               Where to save results (default go-results/<today's date>)
//   --reps <n>                Repeats per case (default 2)
//   --concurrency <n>         Concurrent requests per model (default 4)
//   --pool <dollars>          Shared Go quota (default 60 = Go plan. Use 240 for Go Plus, etc.)
//   --max-cost <percent>      In the pre-screen, drop a model if its monthly quota usage (worst case) at 1,000 decisions/day exceeds this (default 100)
//   --max-p50 <ms>            Drop a model if the pre-screen median exceeds this (default 8000)
//   --verify <n>              Number of recommendations to check through opencode (default 0; connect Go to opencode first)
//   --dry-run                 Do not measure, just show the target models (no API key needed)
//
// The API key is read from the environment only, never written to a file.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { DEFAULTS } from "../core.ts"
import {
  casesFor,
  dangerHistory,
  DEFAULT_POOL,
  fetchCatalog,
  loadRows,
  opencodeLightestVariant,
  pick,
  renderReport,
  runModel,
  runViaOpencode,
  summarize,
} from "./go-lib.mjs"

const here = new URL(".", import.meta.url).pathname
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true])
    return acc
  }, []),
)
const today = new Date().toISOString().slice(0, 10)
const resultsRoot = `${here}go-results`
const out = args.out ?? `${resultsRoot}/${today}`
const reps = Number(args.reps ?? 2)
const concurrency = Number(args.concurrency ?? 4)
const pool = Number(args.pool ?? DEFAULT_POOL)
const maxCost = Number(args["max-cost"] ?? 100)
const maxP50 = Number(args["max-p50"] ?? 8000)
const verifyN = Number(args.verify ?? 0)
const log = (...xs) => console.error(...xs)

// --- 1. catalog and past results
const catalog = await fetchCatalog()
const ids = catalog.map((m) => m.id)
const info = new Map(catalog.map((m) => [m.id, m]))
const runDirs = existsSync(resultsRoot)
  ? readdirSync(resultsRoot)
      .map((d) => `${resultsRoot}/${d}`)
      .filter((d) => statSync(d).isDirectory())
      .sort()
  : []
// Even if the output dir is an existing results folder (e.g. re-running the same day), treat it as past results
const historyDirs = [...new Set([...runDirs, ...(existsSync(out) ? [out] : [])])]
const lastCatalog = historyDirs
  .map((d) => `${d}/catalog.json`)
  .filter(existsSync)
  .at(-1)
const previousIds = lastCatalog ? JSON.parse(readFileSync(lastCatalog, "utf8")).data.map((m) => m.id) : []
// Measured means the model has main-run results (base, hard) or was dropped for a permanent reason.
// Models dropped for temporary reasons such as rate limits or timeouts are retried next time
const PERMANENT = new Set([undefined, "blocked", "unavailable", "expensive", "slow"])
const known = new Set(loadRows(historyDirs).filter((r) => r.set !== "smoke").map((r) => r.model))
for (const d of historyDirs) {
  const f = `${d}/skipped.json`
  if (existsSync(f)) for (const s of JSON.parse(readFileSync(f, "utf8"))) if (PERMANENT.has(s.kind)) known.add(s.model)
}

const targets =
  args.models === "all" ? ids : args.models && args.models !== "new" ? String(args.models).split(",") : ids.filter((id) => !known.has(id))
const unknown = targets.filter((id) => !info.has(id))
if (unknown.length) throw new Error(`models not in catalog: ${unknown.join(", ")}`)

log(`Catalog: ${ids.length} models / measured before: ${[...known].filter((m) => info.has(m)).length} / targets this run: ${targets.length}`)
log(`Targets: ${targets.join(", ") || "none"}`)
if (args["dry-run"]) process.exit(0)

const key = process.env.OPENCODE_GO_API_KEY
if (!key && targets.length) throw new Error("set OPENCODE_GO_API_KEY")
for (const sub of ["smoke", "base", "hard", "plugin"]) mkdirSync(`${out}/${sub}`, { recursive: true })
// For models being re-measured into the same output dir, delete the old results before measuring
for (const model of targets) {
  for (const sub of ["smoke", "base", "hard"]) rmSync(`${out}/${sub}/${model}.jsonl`, { force: true })
  for (const f of readdirSync(`${out}/plugin`)) if (f.startsWith(`${model}@`) || f === `${model}.jsonl`) rmSync(`${out}/plugin/${f}`)
}
const previousSkipped = existsSync(`${out}/skipped.json`) ? JSON.parse(readFileSync(`${out}/skipped.json`, "utf8")).filter((s) => !targets.includes(s.model)) : []
writeFileSync(`${out}/catalog.json`, JSON.stringify({ data: catalog }, null, 1))
writeFileSync(`${here}go-models.json`, JSON.stringify({ data: catalog }, null, 1))

// --- 2. pre-screen
const skipped = []
const passed = []
await Promise.all(
  targets.map(async (model) => {
    const rows = await runModel({ key, model, info: info.get(model), cases: casesFor("smoke"), reps: 1, concurrency, file: `${out}/smoke/${model}.jsonl` })
    const ok = rows.filter((r) => !r.error)
    if (ok.length === 0) {
      const kinds = rows.map((r) => r.errorKind)
      const kind = kinds.sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0]
      const reasons = {
        blocked: "blocked by workspace privacy settings (training-enabled models or region restrictions)",
        rate_limit: "rate limited (429)",
        unavailable: "not available with this key (401/403)",
        timeout: "timeout",
      }
      skipped.push({ model, kind: kind ?? "error", reason: `${reasons[kind] ?? "error"}: ${rows[0].error.slice(0, 160)}` })
      return
    }
    const [s] = summarize(rows, { catalog, pool, sets: ["smoke"] })
    if (s.poolPctWorst > maxCost) {
      skipped.push({ model, kind: "expensive", reason: `too expensive (${s.poolPctWorst.toFixed(0)}% of monthly quota at 1,000 decisions/day, limit ${maxCost}%)` })
      return
    }
    if (s.p50 > maxP50) {
      skipped.push({ model, kind: "slow", reason: `too slow (median ${(s.p50 / 1000).toFixed(1)}s, limit ${maxP50 / 1000}s)` })
      return
    }
    passed.push(model)
  }),
)
writeFileSync(`${out}/skipped.json`, JSON.stringify([...previousSkipped, ...skipped], null, 1))
log(`pre-screen passed ${passed.length} / excluded ${skipped.length}`)
for (const s of skipped) log(`  excluded ${s.model}: ${s.reason}`)

// --- 3. main run
await Promise.all(
  passed.map(async (model) => {
    for (const set of ["base", "hard"]) {
      await runModel({ key, model, info: info.get(model), cases: casesFor(set), reps, concurrency, file: `${out}/${set}/${model}.jsonl` })
    }
    log(`  measured ${model}`)
  }),
)

// --- 4. aggregate (use the newest measurement per model; drop models no longer offered)
const allDirs = [...new Set([...historyDirs, out])]
// Read each folder only once
const rowsByDir = new Map(allDirs.map((dir) => [dir, loadRows([dir])]))
const latest = new Map()
for (const [dir, dirRows] of rowsByDir) for (const r of dirRows) if (r.set !== "smoke") latest.set(r.model, dir)
const rows = [...latest.entries()].flatMap(([model, dir]) => rowsByDir.get(dir).filter((r) => r.model === model))
// Do not let a re-measurement with fewer repeats overwrite safety evidence: danger approvals are collected from all past measurements (including those via opencode)
const ever = dangerHistory(loadRows(allDirs, { includePlugin: true }))
const summaries = summarize(rows, { catalog, pool })
  .filter((s) => info.has(s.model))
  .map((s) => ({ ...s, dangerEver: [...(ever.get(s.model) ?? [])] }))
let picks = pick(summaries)

// --- 5. verification via opencode
const verify = []
if (verifyN > 0 && picks.balanced) {
  const chosen = [...new Set([picks.balanced, picks.accurate, picks.fast, picks.frugal].map((s) => s.model))].slice(0, verifyN)
  for (const model of chosen) {
    const variant = await opencodeLightestVariant("opencode-go", model)
    const name = `${model}${variant ? `@${variant}` : ""}`
    const vrows = await runViaOpencode({ model, variant, cases: casesFor("hard"), file: `${out}/plugin/${name}.jsonl`, concurrency })
    const [s] = summarize(vrows.map((r) => ({ ...r, model: name })), { catalog: [], pool, sets: ["hard"] })
    verify.push(s)
    log(`  via opencode ${name}: safe ${(100 * s.safe).toFixed(0)}% / dangerous approvals by LLM ${s.dangerLLM.length}`)
    // If it approved danger via opencode, drop it from the candidates and pick again
    if (s.dangerLLM.length) {
      const target = summaries.find((x) => x.model === model)
      target.dangerEver = [...new Set([...target.dangerEver, ...s.dangerLLM])]
    }
  }
  picks = pick(summaries)
}

// --- 6. report
const allSkipped = [...skipped]
for (const d of historyDirs.filter((d) => d !== out)) {
  const f = `${d}/skipped.json`
  if (existsSync(f)) for (const s of JSON.parse(readFileSync(f, "utf8"))) if (info.has(s.model) && !latest.has(s.model) && !allSkipped.some((x) => x.model === s.model)) allSkipped.push({ ...s, reason: `${s.reason} (${d.split("/").at(-1)})` })
}
const report = renderReport({
  summaries,
  picks,
  meta: {
    date: today,
    catalogCount: ids.length,
    measured: passed,
    newModels: previousIds.length ? ids.filter((id) => !previousIds.includes(id)) : [],
    removedModels: previousIds.filter((id) => !info.has(id)),
    pool,
    skipped: allSkipped,
    verify,
  },
})
writeFileSync(`${out}/report.md`, report)
writeFileSync(`${out}/summary.json`, JSON.stringify({ date: today, pool, summaries, picks: Object.fromEntries(Object.entries(picks).filter(([k]) => k !== "candidates" && k !== "score").map(([k, v]) => [k, v?.model])) }, null, 1))
console.log(report)
if (picks.balanced && picks.balanced.model !== DEFAULTS.llmModel) {
  log(`\nWarning: the default (DEFAULTS.llmModel in core.ts) is ${DEFAULTS.llmModel}, while this run's balanced recommendation is ${picks.balanced.model}`)
}
log(`\nReport: ${out}/report.md`)
