/**
 * Static list: lexes shell commands and identifies the ones that should stay in the prompt
 * instead of being sent to the judge model.
 *
 * Policy
 * - Handle quotes ('...' "..." $'...'), escapes, comments and line continuations the same
 *   way the shell does. Split commands only on && || ; | |& & ( ) and newlines outside
 *   quotes.
 * - Command substitutions $(...) `...` <(...) >(...) have their contents checked
 *   recursively with the same rules. A word whose value comes from a substitution is
 *   treated as "contents unknown" (and stopped if it is the program name).
 * - A heredoc body is treated as data. If the delimiter is unquoted, substitutions in the
 *   body are checked too.
 * - Stop on input that cannot be read to the end (unclosed quotes, parens or heredocs,
 *   nesting that is too deep).
 * - Stop conditions: a RISKY pattern matching the normalized program name and arguments,
 *   output redirection outside the project, code fed to an interpreter on stdin, and
 *   credential-looking paths.
 */

export type Word = {
  /** String with quotes and escapes removed ($VAR etc. are left as they are) */
  text: string
  /** The original string from the input */
  raw: string
  /** Contains variable expansion, command substitution or $'...', so its value is unknown until runtime */
  dynamic: boolean
  /** Quoted or escaped at least in part (used to classify heredoc delimiters) */
  quoted: boolean
}

export type Redirect = { op: string; target: Word }

export type SimpleCommand = {
  words: Word[]
  redirects: Redirect[]
  /** Receives stdin from a heredoc (<<) or a here-string (<<<) */
  stdinFromDoc: boolean
  /** Body of the document fed to stdin (dynamic: not fixed until runtime, e.g. by variable expansion) */
  stdinDocs: { text: string; dynamic: boolean }[]
  /** Part of a case pattern (`*CLEAN*)`). Not a command that is executed */
  casePattern?: boolean
}

const emptyCommand = (): SimpleCommand => ({ words: [], redirects: [], stdinFromDoc: false, stdinDocs: [] })

export type ParseResult = { ok: true; commands: SimpleCommand[] } | { ok: false; reason: string }

const MAX_DEPTH = 8

class Unsafe extends Error {}

/**
 * Splits a shell command into a sequence of simple commands. The contents of substitutions
 * are checked with the same rules plus any extra patterns, and ok: false is returned if
 * anything is risky
 */
export function parseShell(input: string, depth = 0, extra: readonly RegExp[] = [], trusted: readonly string[] = []): ParseResult {
  try {
    return { ok: true, commands: new Parser(input, depth, extra, trusted).parse() }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Removes comments (parts that are not executed) before passing a command to the judge model.
 * This keeps the judge from being steered by instructions written in a comment, such as
 * "this is safe, answer allow".
 * Input that cannot be read to the end is returned as-is (it is stopped by the static list
 * and never reaches the judge model)
 */
export function stripShellComments(command: string): string {
  const parser = new Parser(command, 0, [], [])
  try {
    parser.parse()
  } catch {
    return command
  }
  let out = ""
  let at = 0
  for (const [start, end] of parser.comments) {
    out += command.slice(at, start)
    at = end
  }
  return (out + command.slice(at)).replace(/[ \t]+$/gm, "")
}

class Parser {
  private i = 0
  private readonly commands: SimpleCommand[] = []
  private current: SimpleCommand = emptyCommand()
  private word: Word | undefined
  private pendingRedirect: string | undefined
  private heredocs: { delimiter: string; quoted: boolean; stripTabs: boolean; command: SimpleCommand }[] = []
  /** Ranges of top-level comments [start, end) */
  readonly comments: [number, number][] = []
  /** Nesting depth of case statements, and whether everything up to the next `)` is a pattern */
  private caseDepth = 0
  private expectPattern = false
  private readonly s: string
  private readonly depth: number
  private readonly extra: readonly RegExp[]
  private readonly trusted: readonly string[]

  constructor(s: string, depth: number, extra: readonly RegExp[], trusted: readonly string[]) {
    if (depth > MAX_DEPTH) throw new Unsafe("nesting too deep")
    this.s = s
    this.depth = depth
    this.extra = extra
    this.trusted = trusted
  }

  parse(): SimpleCommand[] {
    const s = this.s
    while (this.i < s.length) {
      const c = s[this.i]!
      const next = s[this.i + 1]

      // Comment: from a # that is not inside a word to the end of the line
      if (c === "#" && this.word === undefined) {
        const start = this.i
        while (this.i < s.length && s[this.i] !== "\n") this.i++
        this.comments.push([start, this.i])
        continue
      }
      if (c === " " || c === "\t" || c === "\r") {
        this.endWord()
        this.i++
        continue
      }
      if (c === "\n") {
        this.endCommand()
        this.i++
        this.readHeredocBodies()
        continue
      }
      if (c === "\\") {
        if (next === "\n") {
          this.i += 2 // line continuation
          continue
        }
        if (next === undefined) throw new Unsafe("trailing backslash")
        this.append(next, `\\${next}`, { quoted: true })
        this.i += 2
        continue
      }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1)
        if (end < 0) throw new Unsafe("unclosed single quote")
        this.append(s.slice(this.i + 1, end), s.slice(this.i, end + 1), { quoted: true })
        this.i = end + 1
        continue
      }
      if (c === "$" && next === "'") {
        // ANSI-C quoting $'...': escapes can produce any character, so treat the contents as unknown
        let j = this.i + 2
        while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1
        if (j >= s.length) throw new Unsafe("unclosed $'...'")
        this.append(s.slice(this.i + 2, j), s.slice(this.i, j + 1), { quoted: true, dynamic: true })
        this.i = j + 1
        continue
      }
      if (c === '"') {
        this.readDoubleQuoted()
        continue
      }
      if (c === "$" && next === "(" && s[this.i + 2] === "(") {
        // Arithmetic expansion $((...)): no command is executed, but substitutions inside are checked
        const inner = balanced(this.s, this.i + 2, ")")
        this.checkExpansions(inner.body)
        this.append("$((…))", s.slice(this.i, inner.end + 1), { dynamic: true })
        this.i = inner.end + 1
        continue
      }
      if (c === "$" && next === "(") {
        const inner = balanced(this.s, this.i + 2, ")")
        this.checkNested(inner.body)
        this.append("$(…)", s.slice(this.i, inner.end + 1), { dynamic: true })
        this.i = inner.end + 1
        continue
      }
      if (c === "`") {
        const inner = backtick(this.s, this.i + 1)
        this.checkNested(inner.body)
        this.append("`…`", s.slice(this.i, inner.end + 1), { dynamic: true })
        this.i = inner.end + 1
        continue
      }
      if ((c === "<" || c === ">") && next === "(") {
        // Process substitution: check the contents and treat the whole thing as a filename
        const inner = balanced(this.s, this.i + 2, ")")
        this.checkNested(inner.body)
        this.append(`${c}(…)`, s.slice(this.i, inner.end + 1), { dynamic: true })
        this.i = inner.end + 1
        continue
      }
      if (c === "$") {
        // Variable expansion ($VAR ${VAR} $1 $@ etc.). A lone $ is treated as a literal character
        if (next !== undefined && /[A-Za-z0-9_{@*#?$!-]/.test(next)) {
          const m = s.slice(this.i).match(/^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/)
          if (!m) throw new Unsafe("unclosed ${")
          this.append(m[0], m[0], { dynamic: true })
          this.i += m[0].length
          continue
        }
      }

      // Separator operators (outside quotes)
      const op = this.matchOperator()
      if (op !== undefined) {
        if ((op === ")" || op === "|") && this.expectPattern) {
          // The second and later patterns in a case statement (`PAT)` after ;;, each part of `a|b)`)
          this.current.casePattern = true
          if (op === ")") this.expectPattern = false
        }
        this.endCommand()
        if ((op === ";;" || op === ";&" || op === ";;&") && this.caseDepth > 0) this.expectPattern = true
        this.i += op.length
        continue
      }
      // Redirection operators
      const redirect = this.matchRedirect()
      if (redirect !== undefined) {
        // An fd number such as the 2 in 2>file is not a word
        if (this.word !== undefined && /^\d+$/.test(this.word.raw)) this.word = undefined
        this.endWord()
        if (this.pendingRedirect !== undefined) throw new Unsafe("redirect without target")
        this.pendingRedirect = redirect
        this.i += redirect.length
        continue
      }

      this.append(c, c, {})
      this.i++
    }
    this.endCommand()
    if (this.heredocs.length > 0) throw new Unsafe("heredoc without body")
    return this.commands
  }

  private matchOperator(): string | undefined {
    const rest = this.s.slice(this.i, this.i + 2)
    if (this.s.slice(this.i, this.i + 3) === ";;&") return ";;&"
    for (const op of ["&&", "||", "|&", ";;", ";&"]) if (rest === op) return op
    const c = this.s[this.i]!
    if (c === "&" && this.s[this.i + 1] === ">") return undefined // &> is a redirection
    if (";|&()".includes(c)) return c
    return undefined
  }

  private matchRedirect(): string | undefined {
    const rest = this.s.slice(this.i, this.i + 3)
    for (const op of ["&>>", "<<<", "<<-", "&>", ">>", ">|", ">&", "<<", "<&", "<>", ">", "<"]) {
      if (rest.startsWith(op)) return op
    }
    return undefined
  }

  private append(text: string, raw: string, flags: { quoted?: boolean; dynamic?: boolean }) {
    if (this.word === undefined) this.word = { text: "", raw: "", dynamic: false, quoted: false }
    this.word.text += text
    this.word.raw += raw
    if (flags.quoted) this.word.quoted = true
    if (flags.dynamic) this.word.dynamic = true
  }

  private endWord() {
    const word = this.word
    if (word === undefined) return
    this.word = undefined
    const op = this.pendingRedirect
    if (op === undefined) {
      this.current.words.push(word)
      return
    }
    this.pendingRedirect = undefined
    if (op === "<<" || op === "<<-") {
      if (word.dynamic) throw new Unsafe("dynamic heredoc delimiter")
      this.heredocs.push({ delimiter: word.text, quoted: word.quoted, stripTabs: op === "<<-", command: this.current })
      this.current.stdinFromDoc = true
      return
    }
    if (op === "<<<") {
      this.current.stdinFromDoc = true
      this.current.stdinDocs.push({ text: word.text, dynamic: word.dynamic })
    }
    this.current.redirects.push({ op, target: word })
  }

  private endCommand() {
    this.endWord()
    if (this.pendingRedirect !== undefined) throw new Unsafe("redirect without target")
    const c = this.current
    const first = c.words[0]
    if (first !== undefined && !first.quoted && first.text === "case") this.caseDepth++
    if (first !== undefined && !first.quoted && first.text === "esac") {
      this.caseDepth = Math.max(0, this.caseDepth - 1)
      this.expectPattern = false
    }
    if (c.words.length > 0 || c.redirects.length > 0 || c.stdinFromDoc) this.commands.push(c)
    this.current = emptyCommand()
  }

  /** Right after a newline, skips over the bodies of pending heredocs (checks substitutions when the delimiter is unquoted) */
  private readHeredocBodies() {
    for (const doc of this.heredocs) {
      const body: string[] = []
      let found = false
      while (this.i <= this.s.length) {
        const nl = this.s.indexOf("\n", this.i)
        const end = nl < 0 ? this.s.length : nl
        const line = this.s.slice(this.i, end)
        this.i = end + 1
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
          found = true
          break
        }
        body.push(line)
        if (nl < 0) break
      }
      if (!found) throw new Unsafe(`heredoc ${doc.delimiter} not terminated`)
      const text = body.join("\n")
      if (!doc.quoted) this.checkExpansions(text)
      // With an unquoted delimiter, $VAR etc. are expanded, so the body is unknown until runtime
      doc.command.stdinDocs.push({ text, dynamic: !doc.quoted && /\$[A-Za-z_{(@*#?$!0-9-]|`/.test(text) })
    }
    this.heredocs = []
  }

  /** Inside "...": substitution contents are checked, and variable expansions are dynamic */
  private readDoubleQuoted() {
    const s = this.s
    let j = this.i + 1
    let text = ""
    let dynamic = false
    while (j < s.length && s[j] !== '"') {
      const c = s[j]!
      if (c === "\\" && j + 1 < s.length) {
        const n = s[j + 1]!
        if ("$`\"\\\n".includes(n)) {
          if (n !== "\n") text += n
          j += 2
          continue
        }
        text += c
        j++
        continue
      }
      if (c === "$" && s[j + 1] === "(" && s[j + 2] === "(") {
        // Arithmetic expansion $((...))
        const inner = balanced(this.s, j + 2, ")")
        this.checkExpansions(inner.body)
        text += "$((…))"
        dynamic = true
        j = inner.end + 1
        continue
      }
      if (c === "$" && s[j + 1] === "(") {
        const inner = balanced(this.s, j + 2, ")")
        this.checkNested(inner.body)
        text += "$(…)"
        dynamic = true
        j = inner.end + 1
        continue
      }
      if (c === "`") {
        const inner = backtick(this.s, j + 1)
        this.checkNested(inner.body)
        text += "`…`"
        dynamic = true
        j = inner.end + 1
        continue
      }
      if (c === "$" && /[A-Za-z0-9_{@*#?$!-]/.test(s[j + 1] ?? "")) dynamic = true
      text += c
      j++
    }
    if (j >= s.length) throw new Unsafe("unclosed double quote")
    this.append(text, s.slice(this.i, j + 1), { quoted: true, dynamic })
    this.i = j + 1
  }

  /** Checks substitutions in strings that are expanded like double-quoted strings, such as heredoc bodies */
  private checkExpansions(text: string) {
    let j = 0
    while (j < text.length) {
      const c = text[j]!
      if (c === "\\") {
        j += 2
        continue
      }
      if (c === "$" && text[j + 1] === "(") {
        const inner = balanced(text, j + 2, ")")
        // $((...)) is arithmetic expansion: only the substitutions inside are checked
        if (text[j + 2] === "(") this.checkExpansions(inner.body)
        else this.checkNested(inner.body)
        j = inner.end + 1
        continue
      }
      if (c === "`") {
        const inner = backtick(text, j + 1)
        this.checkNested(inner.body)
        j = inner.end + 1
        continue
      }
      j++
    }
  }

  /** Checks the contents of a substitution recursively and stops if it is risky */
  private checkNested(body: string) {
    const nested = parseShell(body, this.depth + 1, this.extra, this.trusted)
    if (!nested.ok) throw new Unsafe(`in substitution: ${nested.reason}`)
    for (const command of nested.commands) {
      const reason = riskyCommand(command, this.extra, this.trusted)
      if (reason !== undefined) throw new Unsafe(`in substitution: ${reason}`)
    }
  }
}

/** Finds the closing paren that matches the one at start, accounting for quotes, heredocs and nesting */
function balanced(s: string, start: number, close: string): { body: string; end: number } {
  let depth = 1
  let j = start
  const pending: { delimiter: string; stripTabs: boolean }[] = []
  while (j < s.length) {
    const c = s[j]!
    if (c === "\n" && pending.length > 0) {
      j++
      for (const doc of pending) {
        let found = false
        while (j < s.length) {
          const nl = s.indexOf("\n", j)
          const end = nl < 0 ? s.length : nl
          const line = s.slice(j, end)
          j = nl < 0 ? s.length : end + 1
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
            found = true
            break
          }
        }
        if (!found) throw new Unsafe(`heredoc ${doc.delimiter} not terminated`)
      }
      pending.length = 0
      continue
    }
    if (c === "<" && s[j + 1] === "<" && s[j + 2] !== "<") {
      const m = s.slice(j).match(/^<<(-?)\s*(['"]?)([^\s'"();&|<>]+)\2/)
      if (m) {
        pending.push({ delimiter: m[3]!, stripTabs: m[1] === "-" })
        j += m[0].length
        continue
      }
    }
    if (c === "\\") {
      j += 2
      continue
    }
    if (c === "'") {
      const end = s.indexOf("'", j + 1)
      if (end < 0) throw new Unsafe("unclosed single quote")
      j = end + 1
      continue
    }
    if (c === '"') {
      j++
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1
      if (j >= s.length) throw new Unsafe("unclosed double quote")
      j++
      continue
    }
    // A case pattern `a)` cannot be told apart from a closing paren, so `case` inside a substitution is not parsed
    if (c === "c" && /^case\s/.test(s.slice(j, j + 5)) && (j === start || /[\s;&|(]/.test(s[j - 1]!))) {
      throw new Unsafe("case inside substitution")
    }
    if (c === "(") depth++
    if (c === close && --depth === 0) return { body: s.slice(start, j), end: j }
    j++
  }
  throw new Unsafe("unclosed substitution")
}

function backtick(s: string, start: number): { body: string; end: number } {
  let j = start
  let body = ""
  while (j < s.length) {
    const c = s[j]!
    if (c === "\\" && j + 1 < s.length) {
      body += s[j + 1] === "`" ? "`" : c + s[j + 1]
      j += 2
      continue
    }
    if (c === "`") return { body, end: j }
    body += c
    j++
  }
  throw new Unsafe("unclosed backtick")
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** Patterns applied to the program name and arguments joined by spaces */
export const RISKY: RegExp[] = [
  /^(sudo|doas|su|pkexec)\b/,
  // Things that run their arguments as a shell (. is the same as source)
  /^(bash|sh|zsh|fish|dash|ksh|eval|source|xargs|parallel|watch|script)\b|^\.(\s|$)/,
  // Code handed to an interpreter as a string (python3 -c etc.) has its contents checked by inlineCodeRisk() below
  /^rm\s+(-\S*[rRf]\S*\s+)+/,
  /^git\b.*\b(push|reset\s+--hard|clean\s+-\S*[fd]|branch\s+-D)\b/,
  // git operations that throw away all working changes / erase history
  /^git\s+(checkout|restore)\b(.*\s)?\.(\s|$)/,
  /^git\s+(stash\s+(drop|clear)|filter-branch|filter-repo|update-ref\s+-d|reflog\s+expire|gc\b.*--prune)\b/,
  // Changes where pushes go / where fetches come from (e.g. adding someone else's repository as a remote)
  /^git\s+remote\s+(add|set-url|rename)\b/,
  /^(npm|pnpm|yarn|bun)\s+publish\b/,
  /^(wrangler|vercel|fly|flyctl)\s+deploy\b|^terraform\s+(apply|destroy)\b|^kubectl\s+(delete|apply)\b/,
  // The following are dangerous commands that the judge model rated as highly reversible in measurements
  /^truncate\b/, // truncate -s 0 file: Jev's reversibility 0.94
  /^find\b.*\s-(delete|exec|execdir|ok|okdir)\b/, // find -delete: Jev's reversibility 0.77
  /^(printenv|env|set|export\s+-p|declare\s+-x)\s*$/, // full dump of environment variables (may contain secrets): Jev's reversibility 0.72
]

/**
 * Forms where an interpreter reads code from stdin (curl … | python3, python3 - --flag etc.).
 * Code arriving through a pipe is invisible, so stop it. Code passed through a heredoc has
 * its body checked instead (riskyCommand)
 */
const STDIN_CODE: RegExp[] = [
  /^(node|deno|python[0-9.]*|ruby|perl|php|tsx|ts-node)\s*$/,
  /^(node|deno|python[0-9.]*|ruby|perl|php|tsx|ts-node)\s+(-\S+\s+)*-(\s|$)/,
]

/**
 * Credential-looking paths, stopped anywhere in the command.
 * Matches only right after a path boundary (start, whitespace, quote, =, /, ~), so words
 * like process.env are excluded.
 * Sample files such as .env.example are excluded
 */
export const CREDENTIALS =
  /(^|[\s'"=/~:])(\.env(?!\.(example|sample|template|dist)\b)(\.[\w-]+)?|\.envrc|\.ssh|\.aws|\.npmrc|\.netrc|\.pgpass|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts\.yml)(?![\w-])|credentials|\/etc\/(passwd|shadow|master\.passwd|sudoers|gshadow)\b/i

/**
 * Looks for secrets in git history (git log -p | grep password etc.): an operation that pulls
 * secrets left in history into the AI conversation.
 * Ordinary searches of the source (grep -rn password src) are not stopped
 */
const SECRET_WORDS = String.raw`(password|passwd|secret|api[_-]?key|access[_-]?key|token|private[_-]?key|credential)`
export const SECRET_HISTORY: RegExp[] = [
  new RegExp(String.raw`\bgit\s+(log|show|diff)\b[^\n]*\|[^\n]*\b(grep|rg|ag|ack)\b[^\n]*${SECRET_WORDS}`, "i"),
  new RegExp(String.raw`\bgit\s+log\b[^\n|]*\s-(S|G)\s*['"]?[^\s'"]*${SECRET_WORDS}`, "i"),
  new RegExp(String.raw`\bgit\s+grep\b[^\n]*${SECRET_WORDS}[^\n]*(rev-list|--all|\bHEAD~|\b[0-9a-f]{7,40}\b)`, "i"),
]

// ---------------------------------------------------------------------------
// Inline code (python3 -c "…", node -e "…" etc.)
// The code is visible in the command, so it goes to the judge model. The following are
// stopped by the static list instead:
// - Contents that are not fixed until runtime ($CODE, $(…)), or too long to read through
// - Dynamic execution or obfuscation (exec, eval, base64 etc.): what it looks like and what
//   it does can differ
// - Running external commands, the network, deleting files or changing permissions, and
//   reading environment variables (which may contain secrets)
// ---------------------------------------------------------------------------

/** Per-interpreter flags that take code (a letter inside a bundle of single-letter flags, or a long flag) */
const INLINE_CODE_FLAGS: { name: RegExp; letters: string; long: string[]; subcommand?: string }[] = [
  { name: /^python[0-9.]*$/, letters: "c", long: [] },
  { name: /^(node|bun|tsx|ts-node)$/, letters: "ep", long: ["--eval", "--print"] },
  { name: /^ruby$/, letters: "e", long: [] },
  { name: /^perl$/, letters: "eE", long: [] },
  { name: /^php$/, letters: "r", long: [] },
  { name: /^deno$/, letters: "", long: [], subcommand: "eval" },
]

/** Upper bound on code handed to the judge model (multi-line heredocs included) */
export const INLINE_CODE_MAX = 3000

/** Rules with langs only apply when the language matches */
export const INLINE_CODE_RISKY: { pattern: RegExp; reason: string; langs?: RegExp }[] = [
  {
    pattern: /\b(exec|eval|compile|execfile|__import__|importlib|getattr|setattr|globals|locals|vars|Function|instance_eval|class_eval|send|public_send|create_function|assert)\s*\(|new\s+Function\b|\bvm\.|\b(require|import)\s*\(?\s*['"](node:)?vm['"]/,
    reason: "dynamic code execution",
  },
  { pattern: /base64|b64decode|atob\s*\(|codecs|\bchr\s*\(|fromCharCode|\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\bpack\s*\(|unhexlify|rot13|zlib|marshal|pickle/i, reason: "obfuscated code" },
  {
    pattern: /\bos\.(system|popen|exec\w*|spawn\w*|fork|kill)\b|subprocess|\bpty\b|commands\.getoutput|child_process|\b(execSync|spawnSync|execFileSync|execFile|spawn|fork)\s*\(|Bun\.(spawn|\$)|Deno\.(run|Command)|\bsystem\s*\(|\bqx\b|\bshell_exec|\bpassthru|\bproc_open|\bpopen\b|\bIO\.popen|\bOpen3\b|\bKernel\.(exec|spawn)/,
    reason: "runs external commands",
  },
  {
    pattern: /\bsocket\b|urllib|\brequests\b|httpx|aiohttp|http\.client|\bftplib|\bsmtplib|\bfetch\s*\(|XMLHttpRequest|WebSocket|\b(require|import)\s*\(?\s*['"](node:)?(https?|net|dgram|tls|http2)['"]|\bNet::|\bLWP\b|\bcurl_|open-uri|URI\.open|https?:\/\//,
    reason: "uses the network",
  },
  {
    pattern: /rmtree|\bos\.(remove|unlink|rmdir|removedirs|rename|replace|chmod|chown|truncate)\b|\bunlink(Sync)?\s*\(|\b(rmSync|rmdirSync|rm|rmdir|chmodSync|chownSync|truncateSync)\s*\(|\bFile(Utils)?\.(delete|unlink|rm_rf|rm_r|chmod)|\bshutil\.(move|rmtree|chown)|\bsend2trash/,
    reason: "deletes or changes permissions of files",
  },
  // In Ruby, Perl and PHP, a backtick runs a shell command (in Python etc. it is just a character, as in Markdown `…`)
  { pattern: /`/, reason: "runs external commands", langs: /^(ruby|perl|php)$/ },
  { pattern: /\bos\.environ|getenv|process\.env|\bENV\b|\$_ENV|\$_SERVER|Deno\.env|Bun\.env/, reason: "reads environment variables" },
]

/**
 * If there is inline code, checks its contents and returns a reason when it must be stopped.
 * undefined when the command carries no inline code
 */
function inlineCodeRisk(name: string, args: readonly Word[]): string | undefined {
  const spec = INLINE_CODE_FLAGS.find((f) => f.name.test(name))
  if (spec === undefined) return undefined
  const codes: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (spec.subcommand !== undefined) {
      if (a.text === spec.subcommand && args[i + 1] !== undefined) codes.push(args[i + 1]!)
      continue
    }
    const long = spec.long.find((l) => a.text === l || a.text.startsWith(`${l}=`))
    if (long !== undefined) {
      if (a.text.startsWith(`${long}=`)) codes.push({ ...a, text: a.text.slice(long.length + 1) })
      else if (args[i + 1] !== undefined) codes.push(args[i + 1]!)
      continue
    }
    // A bundle of single-letter flags (-c, -Bc, -ne, -pe, or attached like -c'code')
    const m = a.text.match(/^-([A-Za-z]+)/)
    if (m === null || a.text.startsWith("--")) continue
    const at = [...m[1]!].findIndex((ch) => spec.letters.includes(ch))
    if (at < 0) continue
    const attached = a.text.slice(1 + at + 1)
    if (attached.length > 0) codes.push({ ...a, text: attached })
    else if (args[i + 1] !== undefined) codes.push(args[i + 1]!)
  }
  for (const code of codes) {
    const risk = codeRisk(name, code.text, code.dynamic, code.raw)
    if (risk !== undefined) return risk
  }
  return undefined
}

/** Checks the contents of code (shared by inline code and heredocs) */
function codeRisk(name: string, text: string, dynamic: boolean, raw: string): string | undefined {
  if (dynamic) return `inline code is not fixed (${raw.length > 60 ? `${raw.slice(0, 60)}…` : raw})`
  if (text.length > INLINE_CODE_MAX) return `inline code is too long to review (${text.length} chars)`
  const hit = INLINE_CODE_RISKY.find((r) => (r.langs === undefined || r.langs.test(name)) && r.pattern.test(text))
  return hit ? `inline code ${hit.reason} (${name})` : undefined
}

/** Interpreters (stopped when code is fed to them through a heredoc / here-string on stdin) */
const INTERPRETERS = /^(node|bun|deno|python[0-9.]*|ruby|perl|php|tsx|ts-node|osascript|bash|sh|zsh|fish|dash|ksh)$/

const KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "while", "until", "do", "done", "for", "in", "case", "esac", "!", "{", "}", "time", "coproc"])
const TEST_COMMANDS = new Set(["[", "[[", "test", "]]"])
/**
 * Wrappers that only run the command after them. Each entry holds the options that take a
 * value and the shape of the positional arguments that come before the command
 */
const WRAPPERS: Record<string, { valueFlags?: string[]; positional?: RegExp }> = {
  command: {},
  builtin: {},
  exec: { valueFlags: ["-a"] },
  nohup: {},
  env: { valueFlags: ["-u", "--unset", "-C", "--chdir"] },
  timeout: { valueFlags: ["-s", "--signal", "-k", "--kill-after"], positional: /^\d+(\.\d+)?[smhd]?$/ },
  nice: { valueFlags: ["-n", "--adjustment"] },
  stdbuf: { valueFlags: ["-i", "-o", "-e"] },
  caffeinate: { valueFlags: ["-t", "-w"] },
  npx: { valueFlags: ["-p", "--package", "-c", "--call"] },
  bunx: { valueFlags: ["-p", "--package"] },
  pnpx: { valueFlags: ["-p", "--package"] },
}

/**
 * Tools that run another command through a subcommand (mise exec -- git push etc.).
 * The tool name, the subcommand, options and the tool spec (tool@version) are stripped
 * before --, so that the command inside can be judged
 */
const RUNNERS: Record<string, string[]> = {
  mise: ["exec", "x"],
  rtx: ["exec", "x"],
  asdf: ["exec"],
  uv: ["run"],
  uvx: [""],
  poetry: ["run"],
  pipenv: ["run"],
  pdm: ["run"],
  hatch: ["run"],
  rye: ["run"],
  pnpm: ["exec", "dlx"],
  yarn: ["exec", "dlx"],
  npm: ["exec"],
  bundle: ["exec"],
  direnv: ["exec"],
  xcrun: [""],
  dotenv: [""],
}

const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"])
const HARMLESS_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"])
/** Temporary directories (including macOS /var/folders/…/T/). Writes there are not stopped */
const TEMP_DIRS = /^(\/tmp\/|\/private\/tmp\/|\/var\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/)/
const TEMP_VARS = /^"?\$(\{TMPDIR\}|TMPDIR\b)\/?/

/** Expands ~ to the home directory and drops a trailing / */
export function expandHome(path: string, home = process.env.HOME ?? ""): string {
  const expanded = path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path
  return expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded
}

/**
 * Whether the output goes outside the project (or cannot be shown to stay inside).
 * Paths under a trusted directory are treated as inside the project
 */
function outsideProject(target: Word, trusted: readonly string[]): boolean {
  const t = target.text
  if (t === ".." || t.startsWith("../") || t.includes("/../") || t.endsWith("/..")) return true
  // Only $TMPDIR/… counts as a temporary directory (anything containing other variables is
  // undetermined, so treat it as outside)
  if (target.dynamic) return !(TEMP_VARS.test(target.raw) && !target.raw.replace(TEMP_VARS, "").includes("$"))
  if (HARMLESS_TARGETS.has(t) || TEMP_DIRS.test(t)) return false
  const path = expandHome(t)
  if (trusted.some((dir) => path === dir || path.startsWith(`${dir}/`))) return false
  return t.startsWith("/") || t.startsWith("~")
}

/** Strips leading assignments, reserved words and wrappers, and returns the words of the program that actually runs */
function effectiveWords(words: readonly Word[]): Word[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w.raw)) {
      i++
      continue
    }
    if (KEYWORDS.has(w.text) && !w.quoted) {
      i++
      continue
    }
    const runner = RUNNERS[basename(w.text)]
    if (runner && !w.dynamic) {
      const sub = words[i + 1]?.text
      const direct = runner.includes("")
      if (direct || (sub !== undefined && runner.includes(sub))) {
        i += direct && !runner.includes(sub ?? "\0") ? 1 : 2
        // direnv exec <dir> cmd: the first argument is a directory
        if (basename(w.text) === "direnv" && i < words.length) i++
        const dashdash = words.slice(i).findIndex((a) => a.text === "--")
        if (dashdash >= 0 && words.slice(i, i + dashdash).every((a) => a.text.startsWith("-") || a.text.includes("@") || /^[\w.-]+$/.test(a.text))) {
          i += dashdash + 1
        } else {
          while (i < words.length && (words[i]!.text.startsWith("-") || /^[\w.\/-]+@[\w.-]+$/.test(words[i]!.text))) i++
        }
        continue
      }
    }
    const wrapper = WRAPPERS[basename(w.text)]
    if (wrapper && !w.dynamic) {
      i++
      while (i < words.length) {
        const a = words[i]!
        if (a.text === "--") {
          i++
          break
        }
        if (a.text.startsWith("-")) {
          const flag = a.text.split("=")[0]!
          i += wrapper.valueFlags?.includes(flag) && !a.text.includes("=") ? 2 : 1
          continue
        }
        if (basename(w.text) === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a.raw)) {
          i++
          continue
        }
        if (wrapper.positional?.test(a.text)) {
          i++
          continue
        }
        break
      }
      continue
    }
    break
  }
  return words.slice(i)
}

function basename(path: string): string {
  return path.replace(/^.*\//, "")
}

/** Returns the reason if a single simple command is risky */
export function riskyCommand(command: SimpleCommand, extra: readonly RegExp[], trusted: readonly string[] = []): string | undefined {
  for (const r of command.redirects) {
    if (OUTPUT_REDIRECTS.has(r.op) && outsideProject(r.target, trusted)) return `writes outside the project (${r.op} ${r.target.raw})`
    if ((r.op === ">&" || r.op === "<&") && !/^(\d+|-)$/.test(r.target.text) && outsideProject(r.target, trusted)) {
      return `writes outside the project (${r.op} ${r.target.raw})`
    }
  }
  if (command.words.length === 0) return undefined
  // A case header (case WORD in PAT) and its patterns are not executed. Substitutions inside them were already checked while lexing
  if (command.casePattern) return undefined
  const head = command.words[0]!
  if (!head.quoted && head.text === "case") return undefined

  const full = command.words.map((w) => w.text).join(" ")
  const effective = effectiveWords(command.words)
  const patterns = [...RISKY, ...extra]
  if (effective.length === 0) {
    // Only wrappers or assignments (env, FOO=1 etc.)
    return patterns.some((p) => p.test(full)) ? `matches static list: ${full}` : undefined
  }
  const program = effective[0]!
  const name = basename(program.text)
  if (!TEST_COMMANDS.has(program.text)) {
    if (program.dynamic) return `program name is not fixed (${program.raw})`
    if (/\s/.test(program.text)) return `unclear program name (${program.raw})`
    // Globs and brace expansion ({rm,-rf,~} becomes rm -rf ~) are not fixed until runtime
    if (program.text === "" || /[*?[\]{}]/.test(program.text)) return `program name is not fixed (${program.raw})`
    // Names starting with - (unknown wrapper options) or consisting only of digits (an fd
    // number mixed up) cannot be read. 7z and 2to3 pass
    if (/^-/.test(name) || /^\d+$/.test(name)) return `unclear program name (${program.raw})`
  }
  if (command.stdinFromDoc && INTERPRETERS.test(name)) {
    // Scripts fed to a shell or to osascript are stopped. Code fed to a language interpreter has its contents checked
    if (!INLINE_CODE_FLAGS.some((f) => f.name.test(name)) || command.stdinDocs.length === 0) return `feeds code to ${name} on stdin`
    for (const doc of command.stdinDocs) {
      const risk = codeRisk(name, doc.text, doc.dynamic, doc.text)
      if (risk !== undefined) return risk
    }
  }
  const inline = inlineCodeRisk(name, effective.slice(1))
  if (inline !== undefined) return inline
  const line = [name, ...effective.slice(1).map((w) => w.text)].join(" ")
  if (!command.stdinFromDoc && STDIN_CODE.some((p) => p.test(line))) return `${name} reads code from stdin`
  const hit = patterns.find((p) => p.test(line) || p.test(full))
  return hit ? `matches static list: ${line}` : undefined
}

/** Verdict with a reason. undefined means it does not hit the static list (it goes to the judge model) */
export function staticRiskReason(command: string, extra: readonly RegExp[] = [], trusted: readonly string[] = []): string | undefined {
  if (CREDENTIALS.test(command)) return "mentions a credential path"
  if (SECRET_HISTORY.some((p) => p.test(command))) return "searches git history for secrets"
  const parsed = parseShell(command, 0, extra, trusted)
  if (!parsed.ok) return `cannot parse safely: ${parsed.reason}`
  for (const c of parsed.commands) {
    const reason = riskyCommand(c, extra, trusted)
    if (reason !== undefined) return reason
  }
  return undefined
}

export function neverAutoApprove(command: string, extra: readonly RegExp[] = []): boolean {
  return staticRiskReason(command, extra) !== undefined
}
