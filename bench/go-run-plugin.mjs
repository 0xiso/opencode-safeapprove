// Measure through the same path as the plugin (experimental.generate.text on the running opencode server).
// Use the OpenCode Go credentials already connected to opencode (no API key needed). If no variant is given, use the lightest one, as the plugin does.
// usage: node go-run-plugin.mjs <out-dir> <reps> <model[:variant],...> [cases=base|hard] [concurrency=4]
import { mkdirSync } from "node:fs"
import { casesFor, opencodeLightestVariant, runViaOpencode } from "./go-lib.mjs"

const [outDir, reps, models, set = "hard", concurrency = "4"] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
for (const spec of models.split(",")) {
  const [model, given] = spec.split(":")
  const variant = given ?? (await opencodeLightestVariant("opencode-go", model))
  await runViaOpencode({ model, variant, cases: casesFor(set), reps: Number(reps), concurrency: Number(concurrency), file: `${outDir}/${model}${variant ? `@${variant}` : ""}.jsonl` })
  console.error(`done ${spec}${variant && !given ? ` (variant ${variant})` : ""}`)
}
