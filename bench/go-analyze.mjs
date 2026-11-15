// Aggregate the measurements and print a report (no API calls).
// usage: node go-analyze.mjs <result-dir...> [--pool 60] [--write]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dangerHistory, DEFAULT_POOL, loadRows, pick, renderReport, summarize } from "./go-lib.mjs"

const argv = process.argv.slice(2)
const poolAt = argv.indexOf("--pool")
const pool = poolAt >= 0 ? Number(argv[poolAt + 1]) : DEFAULT_POOL
const write = argv.includes("--write")
const dirs = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--pool")
const catalogFile = dirs.map((d) => `${d}/catalog.json`).find(existsSync) ?? new URL("./go-models.json", import.meta.url).pathname
const catalog = JSON.parse(readFileSync(catalogFile, "utf8")).data
const ever = dangerHistory(loadRows(dirs, { includePlugin: true }))
const summaries = summarize(loadRows(dirs), { catalog, pool }).map((s) => ({ ...s, dangerEver: [...(ever.get(s.model) ?? [])] }))
const skipped = dirs.flatMap((d) => (existsSync(`${d}/skipped.json`) ? JSON.parse(readFileSync(`${d}/skipped.json`, "utf8")) : []))
// Same meta the survey writes: the folder name as the date, and the models it actually measured
const date = dirs.map((d) => d.replace(/\/+$/, "").split("/").at(-1)).join(", ")
const measured = [...new Set(dirs.flatMap((d) => ["base", "hard"].flatMap((set) =>
  existsSync(`${d}/${set}`) ? readdirSync(`${d}/${set}`).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, "")) : [],
)))]
const report = renderReport({ summaries, picks: pick(summaries), meta: { date, catalogCount: catalog.length, measured, pool, skipped } })
if (write) {
  for (const d of dirs) writeFileSync(`${d}/report.md`, report)
}
console.log(report)
