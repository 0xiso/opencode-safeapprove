// node --test bench/go-lib.test.mjs
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { appliedFactor, classifyError, maxFactor, pick, summarize } from "./go-lib.mjs"

// Same shape as the real catalog data (as of 2026-11-14)
const deepseek = {
  id: "deepseek-v4.1-flash",
  cost: {
    text: {},
    multipliers: [
      {
        when: {
          utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
          any: [
            { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] },
            { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] },
          ],
        },
        factor: 2,
      },
    ],
  },
}
const gemini = { id: "gemini-4-argon", cost: { text: {}, multipliers: [{ when: { date: { gte: "2026-12-01" } }, factor: 2 }] } }

describe("price multipliers", () => {
  it("DeepSeek: 2x only during weekday peak hours", () => {
    assert.equal(appliedFactor(deepseek, Date.parse("2026-11-16T07:00:00Z")), 2) // Monday 07:00
    assert.equal(appliedFactor(deepseek, Date.parse("2026-11-16T05:00:00Z")), 1) // Monday 05:00
    assert.equal(appliedFactor(deepseek, Date.parse("2026-11-14T07:00:00Z")), 1) // Saturday
    assert.equal(maxFactor(deepseek), 2)
  })
  it("Gemini: 2x from the day the discount ends", () => {
    assert.equal(appliedFactor(gemini, Date.parse("2026-11-30T12:00:00Z")), 1)
    assert.equal(appliedFactor(gemini, Date.parse("2026-12-01T00:00:00Z")), 2)
  })
  it("no multipliers, no time", () => {
    assert.equal(appliedFactor({}, Date.now()), 1)
    assert.equal(appliedFactor(deepseek, undefined), 1)
    assert.equal(maxFactor({}), 1)
  })
})

describe("classifyError", () => {
  it("classification", () => {
    assert.equal(classifyError('HTTP 400: {"message":"This OpenCode Go model trains on request data."}'), "blocked")
    assert.equal(classifyError("HTTP 429: {}"), "rate_limit")
    assert.equal(classifyError("HTTP 403: {}"), "unavailable")
    assert.equal(classifyError("TimeoutError: The operation was aborted"), "timeout")
  })
})

describe("pick", () => {
  const rows = (model, { safeAllow = 1, dangerAllow = 0, ms = 1000, n = 50 } = {}) => {
    const out = []
    for (let i = 0; i < n; i++) {
      for (const set of ["base", "hard"]) {
        out.push({ model, set, label: "safe", command: `s${i}`, ms, allowance: 0.0001, verdict: { verdict: i / n < safeAllow ? "allow" : "ask" } })
        out.push({ model, set, label: "danger", command: `d${i}`, ms, allowance: 0.0001, verdict: { verdict: i < dangerAllow ? "allow" : "ask" } })
      }
    }
    return out
  }
  it("models that approved a dangerous command, or that have too few samples, are not candidates", () => {
    const s = summarize([...rows("good", { safeAllow: 0.9 }), ...rows("unsafe", { safeAllow: 1, dangerAllow: 1 }), ...rows("few", { n: 20 })])
    const picks = pick(s)
    assert.deepEqual(picks.candidates.map((x) => x.model), ["good"])
    assert.equal(picks.balanced.model, "good")
  })
  it("excluded even when this run has 0, if a past run approved a dangerous command (dangerEver)", () => {
    const [s] = summarize(rows("m"))
    assert.equal(pick([{ ...s, dangerEver: ["rm -rf ~"] }]).candidates.length, 0)
  })
  it("excludes models that are too slow or too expensive", () => {
    const [slow] = summarize(rows("slow", { ms: 9000 }))
    assert.equal(pick([slow]).candidates.length, 0)
  })
})
