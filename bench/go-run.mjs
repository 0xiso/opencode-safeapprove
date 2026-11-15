// Measure only the given models (the full survey is go-survey.mjs).
// usage: OPENCODE_GO_API_KEY=... node go-run.mjs <out-dir> <reps> <model[,model...]> [cases=base|hard|smoke] [concurrency=4]
// Results are appended to <out-dir>/<cases>/<model>.jsonl. API keys are never written to files.
import { mkdirSync } from "node:fs"
import { casesFor, fetchCatalog, runModel } from "./go-lib.mjs"

const key = process.env.OPENCODE_GO_API_KEY
if (!key) throw new Error("OPENCODE_GO_API_KEY is not set")
const [outDir, reps, models, set = "base", concurrency = "4"] = process.argv.slice(2)
const info = new Map((await fetchCatalog()).map((m) => [m.id, m]))
mkdirSync(`${outDir}/${set}`, { recursive: true })
await Promise.all(
  models.split(",").map(async (model) => {
    await runModel({ key, model, info: info.get(model), cases: casesFor(set), reps: Number(reps), concurrency: Number(concurrency), file: `${outDir}/${set}/${model}.jsonl` })
    console.error(`done ${model}`)
  }),
)
