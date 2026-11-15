/**
 * safeapprove — OpenCode v2 server plugin
 *
 * Judges shell command permission prompts with an AI model, like Claude Code's auto mode,
 * and auto-approves only the commands it judges "safe and aligned with the task".
 * The judge model defaults to OpenCode Go's glm-5.3-flash (engine: "llm").
 * With engine: "jev", TypeSafe's Jev (jev-1.13-free on the OpenCode provider) is used instead.
 *
 * - Commands matching the static list (RISKY in core.ts) are never sent to the judge model and always prompt the user
 * - Commands the judge model does not approve, or that fail, time out, or hit the usage limit, also prompt the user
 * - Deny rules in the config file are applied by OpenCode first, so this plugin cannot override them
 * - With safetyNet enabled, dangerous commands that the rules let through are escalated to a prompt
 *
 * References:
 * - https://openrouter.ai/docs/cookbook/coding-agents/auto-approve-permission-prompts-with-jev
 * - https://opencode.ai/docs/build/plugins/server/  (permission.hook("evaluate"), experimental.generate.decisions)
 * - https://opencode.ai/docs/build/plugins/rpc/
 * - https://opencode.ai/docs/console/models/        (Jev / jev-1.13-free)
 * - https://opencode.ai/docs/permissions/
 */
import { appendFile } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"
import {
  approves,
  compileExtraRisky,
  expandHome,
  formatScores,
  buildLlmPrompt,
  isProbability,
  lightestVariant,
  llmScores,
  parseLlmVerdict,
  logKey,
  staticRiskReason,
  stripShellComments,
  QUESTIONS,
  questionsFor,
  rateLimitBackoffMs,
  readOptions,
  ScoreCache,
  taskFromUserMessages,
  type Decision,
  type DecisionSource,
  type LogEntry,
  type Options,
  type QuestionName,
  type Scores,
  type State,
} from "./core.ts"
import { SafeApproveRpc, type DecidedEvent } from "./rpc.ts"

type Ctx = Plugin.Context

/** A judgement: Jev returns scores only, the LLM returns scores and a verdict */
type Judgement = { scores: Scores; verdict?: "allow" | "ask"; reason?: string }

type Scored =
  | ({ kind: "scores"; source: "jev" | "llm" | "cache"; model: string; judgeMs: number } & Judgement)
  | { kind: "unknown"; source: "rate_limit" | "error"; reason: string }

export default {
  id: "safeapprove",
  async setup(ctx) {
    const opts = readOptions(ctx.options)
    const extra = compileExtraRisky(opts.extraRisky)
    // Folders treated like the project — user-trusted folders (static list and judge model) and temp folders (judge model only)
    const trusted = opts.trustedDirs.map((dir) => expandHome(dir))
    const workspaces = [
      ...new Set([
        "/tmp",
        "/private/tmp",
        "/var/folders",
        "/private/var/folders",
        ...(process.env.TMPDIR ? [expandHome(process.env.TMPDIR)] : []),
        ...trusted,
      ]),
    ]
    const cache = new ScoreCache<Judgement>(opts.cacheTtlMs)
    const primaryModel = opts.engine === "llm" ? `${opts.llmProviderID}/${opts.llmModel}` : opts.model
    // Rate limits outlive an OpenCode restart, so persist the end time
    const RATE_LIMIT_KEY = opts.engine === "llm" ? `rateLimitedUntil/llm/${primaryModel}` : `rateLimitedUntil/${opts.providerID}/${opts.model}`
    // Resolve the variant on the first judgement, so startup is never delayed. If model info is unavailable, retry next time
    let resolvedVariant: { value: string | undefined } | undefined =
      opts.engine !== "llm" || opts.llmVariant !== undefined ? { value: opts.llmVariant } : undefined
    const llmVariant = async () => {
      if (resolvedVariant === undefined) {
        const found = await lightestVariantOf(ctx, opts)
        if (found.known) resolvedVariant = { value: found.variant }
        return found.variant
      }
      return resolvedVariant.value
    }
    let rateLimitedUntil = Number(await ctx.storage.get(RATE_LIMIT_KEY).catch(() => 0)) || 0
    let seq = 0
    let writes = 0

    const rpc = await ctx.rpc.register(SafeApproveRpc, {
      recent: async (input) => {
        const limit = Math.max(1, Math.min(Math.max(1, opts.maxLogEntries), Number((input as { limit?: unknown }).limit ?? 20) || 20))
        const entries = await readLog(ctx)
        return {
          entries: entries.slice(-limit) as unknown as Record<string, unknown>[],
          ...(rateLimitedUntil > Date.now() ? { rateLimitedUntil } : {}),
        }
      },
    })

    const notify = (event: DecidedEvent) => {
      rpc.events.emit("decided", event).catch(() => {})
    }

    // Logs for ask / escalate decisions: keep them around to append the user's reply (permission.replied)
    const awaitingReply = new Map<string, { key: string; entry: LogEntry }>() // toolCallID -> log entry
    const requestToTool = new Map<string, string>() // permission request ID -> toolCallID

    const record = async (entry: LogEntry) => {
      const key = logKey(entry.time, seq++ % 1_000_000)
      if (entry.toolCallID && entry.decision !== "allow") {
        awaitingReply.set(entry.toolCallID, { key, entry })
        if (awaitingReply.size > 500) awaitingReply.delete(awaitingReply.keys().next().value!)
      }
      if (opts.logFile) await appendFile(opts.logFile, JSON.stringify(entry) + "\n").catch(() => {})
      if (opts.maxLogEntries <= 0) return
      try {
        await ctx.storage.set(key, entry as any)
        if (++writes % 50 === 0) await pruneLog(ctx, opts.maxLogEntries)
      } catch {
        // A logging failure must not stop the decision
      }
    }

    // Append the user's reply to the log for commands that ended up as ask (used to improve the judging logic)
    const events = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ types: ["permission.asked", "permission.replied"], signal: events.signal })) {
          if (ev.type === "permission.asked") {
            const tool = ev.data.source?.id
            if (tool && awaitingReply.has(tool)) {
              requestToTool.set(ev.data.id, tool)
              if (requestToTool.size > 500) requestToTool.delete(requestToTool.keys().next().value!)
            }
            continue
          }
          if (ev.type !== "permission.replied") continue
          const tool = requestToTool.get(ev.data.requestID)
          const pending = tool ? awaitingReply.get(tool) : undefined
          if (!tool || !pending) continue
          requestToTool.delete(ev.data.requestID)
          awaitingReply.delete(tool)
          const entry = { ...pending.entry, userReply: ev.data.reply }
          if (opts.logFile) await appendFile(opts.logFile, JSON.stringify({ ...entry, kind: "reply" }) + "\n").catch(() => {})
          if (opts.maxLogEntries > 0) await ctx.storage.set(pending.key, entry as any).catch(() => {})
        }
      } catch {
        // Give up recording on abort or when subscribing to events fails
      }
    })()

    // Get a judgement: cache → primary model → fallback while rate limited (fallback is jev-only)
    const score = async (state: State): Promise<Scored> => {
      const now = Date.now()
      const limited = now < rateLimitedUntil
      const fallback = opts.engine === "jev" ? opts.fallbackModel : undefined
      if (limited && fallback === undefined) {
        return { kind: "unknown", source: "rate_limit", reason: `rate limited until ${clock(rateLimitedUntil)}` }
      }
      const model = limited ? fallback! : primaryModel
      const variant = opts.engine === "llm" ? await llmVariant() : undefined
      const key = ScoreCache.key(`${model}@${variant ?? ""}`, state)
      const cached = cache.get(key, now)
      if (cached !== undefined) return { kind: "scores", ...cached, source: "cache", model, judgeMs: 0 }

      const started = Date.now()
      const result =
        opts.engine === "llm" ? await callLlm(ctx, opts, variant, state) : await callJev(ctx, opts, model, state)
      const judgeMs = Date.now() - started
      if (result.kind === "scores") {
        const { kind: _, ...judgement } = result
        cache.set(key, judgement)
        return { kind: "scores", ...judgement, source: opts.engine === "llm" ? "llm" : "jev", model, judgeMs }
      }
      if (result.backoffMs !== undefined && model === primaryModel) {
        rateLimitedUntil = Date.now() + result.backoffMs
        await ctx.storage.set(RATE_LIMIT_KEY, rateLimitedUntil).catch(() => {})
        notify({
          sessionID: "",
          commands: [...state.commands],
          decision: "ask",
          source: "rate_limit",
          summary: `${primaryModel} usage limit — ${fallback ? `using ${fallback}` : "auto-approval paused"} until ${clock(rateLimitedUntil)}`,
        })
        if (fallback !== undefined) return score(state)
        return { kind: "unknown", source: "rate_limit", reason: result.reason }
      }
      return {
        kind: "unknown",
        source: result.backoffMs !== undefined ? "rate_limit" : "error",
        reason: result.reason === "timeout" ? `timeout after ${judgeMs} ms` : result.reason,
      }
    }

    await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "shell" || event.resources.length === 0) return
      if (event.effect === "deny") return
      if (event.effect === "allow" && opts.safetyNet === "off") return

      const sessionID = event.sessionID
      const commands = event.resources
      const toolCallID = event.source?.id
      // The project and the session facts (task text, original pre-split command) are independent lookups, so fetch both in parallel
      const projectP = projectFor(ctx, sessionID)
      const factsP = sessionFacts(ctx, sessionID, toolCallID)
      const { command: fullCommand } = await factsP
      const base = { time: Date.now(), sessionID, commands, fullCommand, toolCallID } as const
      // Why the static list matched (first hit), from both the split parts and the original command. undefined means hand it to the judge model
      const risky = [...commands, ...(fullCommand ? [fullCommand] : [])]
        .map((command) => staticRiskReason(command, extra, trusted))
        .find((r) => r !== undefined)
      // Pass the original command to the judge model as a single entry: when the command is split, the bare head of `| head` causes bad judgements.
      // Comments are not executed, so leave them out (they could be used to steer the judgement)
      const judged = (fullCommand ? [fullCommand] : [...commands]).map(stripShellComments)

      const finish = async (decision: Decision, source: DecisionSource, extraFields: Partial<LogEntry>, summary: string) => {
        if (decision === "allow") event.effect = "allow"
        if (decision === "escalate") event.effect = "ask"
        // Show the model name only when the judge model decided (safeapprove when the static list or an error stopped it)
        const byModel = source === "llm" || source === "jev" || source === "cache" || (source === "safety_net" && "model" in extraFields)
        const label = byModel ? (opts.engine === "llm" ? opts.llmModel : "Jev") : "safeapprove"
        if (decision !== "allow" && opts.explain && event.message === undefined) event.message = `${label}: ${summary}`
        // Write the log in the background so it never holds up the decision (record swallows failures)
        void record({ ...base, project: await projectP, decision, source, ...extraFields })
        // The OpenCode 2.3.0 TUI does not render event.message in the permission prompt,
        // so also surface the reason in a toast when it was not auto-approved (ask)
        notify({ sessionID, commands: [...commands], decision, source, summary: decision === "ask" ? `${label}: ${summary}` : summary })
      }

      // --- Allowed by rules (safetyNet)
      if (event.effect === "allow") {
        if (risky) return finish("escalate", "safety_net", { reason: `static: ${risky}` }, `Matched the static list — needs confirmation (${risky})`)
        if (opts.safetyNet !== "ai") return
        const scored = await score({ commands: judged, project: await projectP, workspaces, agent: event.agent })
        if (scored.kind !== "scores") return
        const reversible = scored.scores.reversible
        const dangerous = scored.verdict === undefined || scored.verdict === "ask"
        if (dangerous && typeof reversible === "number" && reversible < opts.escalateBelow) {
          return finish(
            "escalate",
            "safety_net",
            { scores: scored.scores, verdict: scored.verdict, model: scored.model, judgeMs: scored.judgeMs },
            `Likely irreversible — needs confirmation (${describe(scored)})`,
          )
        }
        return
      }

      // --- Rules require a prompt
      if (risky) return finish("ask", "static", { reason: risky }, `Matched the static list — not auto-approved (${risky})`)

      const [project, { task }] = await Promise.all([projectP, factsP])
      const state: State = { commands: judged, project, workspaces, task, agent: event.agent }
      const scored = await score(state)
      if (scored.kind === "unknown") {
        return finish("ask", scored.source, { task: short(task), reason: scored.reason }, `Could not judge (${scored.reason})`)
      }
      // The llm engine follows the model's verdict. The jev engine decides using per-question thresholds
      const ok = scored.verdict !== undefined ? scored.verdict === "allow" : approves(opts, scored.scores, task !== undefined)
      return finish(
        ok ? "allow" : "ask",
        scored.source,
        { task: short(task), scores: scored.scores, verdict: scored.verdict, model: scored.model, reason: scored.reason, judgeMs: scored.judgeMs },
        ok ? `Auto-approved (${describe(scored)})` : `${scored.verdict ? "Needs confirmation" : "Below threshold"} (${describe(scored)})`,
      )
    })

    return () => {
      events.abort()
      return rpc.dispose()
    }
  },
} satisfies Plugin.Plugin

// ---------------------------------------------------------------------------

async function callJev(
  ctx: Ctx,
  opts: Options,
  model: string,
  state: State,
): Promise<{ kind: "scores"; scores: Scores } | { kind: "error"; reason: string; backoffMs?: number }> {
  const asked = questionsFor(state)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const result = await Promise.race([
      ctx.experimental.generate.decisions(
        {
          model: { providerID: opts.providerID, id: model },
          input: [{ type: "json", value: state as any }],
          questions: asked.map((key) => ({
            type: "predicate" as const,
            name: key,
            instructions: questionText(key),
          })),
        },
        { signal: controller.signal },
      ),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
      ),
    ])
    const scores: Scores = {}
    for (const key of asked) {
      const answer = result.answers.find((a) => a.name === key)
      if (answer === undefined) return { kind: "error", reason: `no answer for ${key}` }
      if (answer.type === "error") return { kind: "error", reason: `${key}: ${answer.reason}` }
      if (answer.type !== "predicate" || !isProbability(answer.probability)) {
        return { kind: "error", reason: `unexpected answer for ${key}` }
      }
      scores[key] = answer.probability
    }
    return { kind: "scores", scores }
  } catch (error) {
    const backoffMs = rateLimitBackoffMs(error)
    const reason = backoffMs !== undefined ? "rate limited" : error instanceof Error ? error.message : String(error)
    return { kind: "error", reason, ...(backoffMs !== undefined ? { backoffMs } : {}) }
  } finally {
    clearTimeout(timer)
  }
}

async function callLlm(
  ctx: Ctx,
  opts: Options,
  variant: string | undefined,
  state: State,
): Promise<({ kind: "scores" } & Judgement) | { kind: "error"; reason: string; backoffMs?: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const result = await Promise.race([
      ctx.experimental.generate.text(
        {
          prompt: buildLlmPrompt(state),
          model: { providerID: opts.llmProviderID, id: opts.llmModel, ...(variant ? { variant } : {}) },
        },
        { signal: controller.signal },
      ),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
      ),
    ])
    const verdict = parseLlmVerdict(result.text)
    if (verdict === undefined) return { kind: "error", reason: "unreadable answer" }
    return { kind: "scores", scores: llmScores(verdict), verdict: verdict.verdict, reason: verdict.reason }
  } catch (error) {
    const backoffMs = rateLimitBackoffMs(error)
    const reason = backoffMs !== undefined ? "rate limited" : error instanceof Error ? error.message : String(error)
    return { kind: "error", reason, ...(backoffMs !== undefined ? { backoffMs } : {}) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pick the lightest variant among the ones OpenCode knows for that model.
 * known: false means model info was unavailable (e.g. not connected yet), so try again next time
 */
async function lightestVariantOf(ctx: Ctx, opts: Options): Promise<{ known: boolean; variant?: string }> {
  try {
    const models = await ctx.model.list()
    const info = models.data.find((m) => m.providerID === opts.llmProviderID && m.modelID === opts.llmModel)
    return info ? { known: true, variant: lightestVariant(info.variants.map((v) => v.id)) } : { known: false }
  } catch {
    return { known: false }
  }
}

function describe(scored: Judgement): string {
  const scores = formatScores(scored.scores)
  return scored.reason ? `${scores}${scores ? "; " : ""}${scored.reason}` : scores
}

function questionText(key: QuestionName): string {
  return QUESTIONS[key].instructions
}

/** The session's own directory (not the one the plugin was loaded from). Falls back to the plugin location */
async function projectFor(ctx: Ctx, sessionID: string): Promise<string> {
  try {
    const session = await ctx.session.get({ sessionID })
    const directory = session.location?.directory
    if (typeof directory === "string" && directory.length > 0) return directory
  } catch {
    // fall through
  }
  return ctx.location.directory
}

/**
 * Read the session contents to get the task text (the user's messages) and the original command of the tool call
 * that triggered the permission check. undefined when unavailable (then judge without a task and judge the split command)
 */
async function sessionFacts(ctx: Ctx, sessionID: string, toolCallID: string | undefined): Promise<{ task?: string; command?: string }> {
  try {
    const messages = await ctx.session.context({ sessionID })
    const task = taskFromUserMessages(messages.flatMap((m) => (m.type === "user" ? [m.text] : [])))
    let command: string | undefined
    if (toolCallID) {
      for (const m of messages) {
        if (m.type !== "assistant") continue
        for (const part of m.content) {
          if (part.type !== "tool" || part.id !== toolCallID) continue
          const input = part.state.input
          if (typeof input === "object" && input !== null && typeof input.command === "string") command = input.command
        }
      }
    }
    return { task, command }
  } catch {
    return {}
  }
}

async function readLog(ctx: Ctx): Promise<LogEntry[]> {
  const entries: LogEntry[] = []
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: "log/", after, limit: 500 })
    for (const entry of page.entries) entries.push(entry.value as unknown as LogEntry)
    after = page.next
  } while (after !== undefined)
  return entries
}

async function pruneLog(ctx: Ctx, max: number): Promise<void> {
  const keys: string[] = []
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: "log/", after, limit: 500 })
    for (const entry of page.entries) keys.push(entry.key)
    after = page.next
  } while (after !== undefined)
  keys.sort()
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await ctx.storage.remove(key)
}

function clock(time: number): string {
  return new Date(time).toLocaleTimeString()
}

function short(text: string | undefined): string | undefined {
  return text === undefined ? undefined : text.length > 300 ? `${text.slice(0, 300)}…` : text
}
