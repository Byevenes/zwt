import { dirname, resolve } from "node:path"
import { expandHome } from "./resolve.ts"

export interface IdentityDraft {
  readonly key: string
  readonly name: string
  readonly email: string
  readonly matches: ReadonlyArray<string>
}

/** One personal identity used when git has no includeIf identity to import. */
export const starterDrafts: ReadonlyArray<IdentityDraft> = [{
  key: "personal",
  name: "Jane Doe",
  email: "jane@example.com",
  matches: ["~/personal/**"]
}]

export const globalGitConfigCandidates = (home: string, xdgConfigHome: string | undefined): ReadonlyArray<string> => {
  const xdg = xdgConfigHome === undefined || xdgConfigHome.length === 0 ? `${home}/.config` : xdgConfigHome
  return [resolve(`${xdg}/git/config`), resolve(`${home}/.gitconfig`)]
}

interface GitInclude {
  readonly path: string
}

interface GitIncludeIf {
  readonly gitdir: string
  readonly path: string
}

interface GitConfigView {
  readonly includes: ReadonlyArray<GitInclude>
  readonly includeIfs: ReadonlyArray<GitIncludeIf>
  readonly userName: string | undefined
  readonly userEmail: string | undefined
}

const unescapeQuoted = (value: string) => value.replace(/\\(.)/g, (_match, char: string) => char)

const stripComment = (line: string): string => {
  let quote: "'" | "\"" | undefined
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote !== undefined) {
      if (char === "\\" && quote === "\"") {
        i++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === "\"" || char === "'") {
      quote = char
      continue
    }
    if (char === "#" || char === ";") return line.slice(0, i)
  }
  return line
}

const unquote = (raw: string): string => {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) return unescapeQuoted(value.slice(1, -1))
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

const gitdirOf = (subsection: string): string | undefined => {
  const lower = subsection.toLowerCase()
  const pattern = lower.startsWith("gitdir/i:")
    ? subsection.slice("gitdir/i:".length)
    : lower.startsWith("gitdir:")
      ? subsection.slice("gitdir:".length)
      : undefined
  if (pattern === undefined) return undefined
  const trimmed = pattern.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const parseGitConfig = (source: string): GitConfigView => {
  let section = ""
  let subsection: string | undefined
  let userName: string | undefined
  let userEmail: string | undefined
  const includes: Array<GitInclude> = []
  const includeIfs: Array<GitIncludeIf> = []

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (line.length === 0) continue
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:\\.|[^"\\])*)")?\]$/.exec(line)
    if (header !== null) {
      section = (header[1] ?? "").toLowerCase()
      subsection = header[2] === undefined ? undefined : unescapeQuoted(header[2])
      continue
    }
    const assignment = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line)
    if (assignment === null) continue
    const key = (assignment[1] ?? "").toLowerCase()
    const value = unquote(assignment[2] ?? "")
    if (value.length === 0) continue
    if (section === "user" && subsection === undefined) {
      if (key === "name") userName = value
      if (key === "email") userEmail = value
    }
    if (key !== "path") continue
    if (section === "include") includes.push({ path: value })
    if (section === "includeif" && subsection !== undefined) {
      const gitdir = gitdirOf(subsection)
      if (gitdir !== undefined) includeIfs.push({ gitdir, path: value })
    }
  }

  return { includes, includeIfs, userName, userEmail }
}

const resolveIncludePath = (includePath: string, fromFile: string, home: string): string => {
  const expanded = expandHome(includePath.trim(), home)
  return expanded.startsWith("/") ? resolve(expanded) : resolve(dirname(fromFile), expanded)
}

/** Paths named by `[include]` and `includeIf "gitdir:..."`, relative to the file that named them. */
export const includePaths = (source: string, fromFile: string, home: string): ReadonlyArray<string> => {
  const view = parseGitConfig(source)
  return [...view.includes, ...view.includeIfs].map((entry) => resolveIncludePath(entry.path, fromFile, home))
}

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

/**
 * Stable key for one imported identity.
 * Prefer the email local-part (text before `@`): lowercase, fold every run of
 * characters outside `[a-z0-9]` into a single `-`, and trim `-`.
 * When that slug is empty, use the same transform on the last gitdir segment
 * other than `~` or `**`. When that is empty too, the key is `identity`.
 * `importIdentities` keeps the first key as-is. Each later collision gets `-2`, then `-3`.
 */
export const identityKeyBase = (email: string, gitdir: string): string => {
  const at = email.indexOf("@")
  const local = at >= 0 ? email.slice(0, at) : email
  const fromEmail = slug(local)
  if (fromEmail.length > 0) return fromEmail
  const segment = gitdir.split("/").filter((part) => part.length > 0 && part !== "~" && part !== "**").pop() ?? ""
  const fromPath = slug(segment)
  return fromPath.length > 0 ? fromPath : "identity"
}

/**
 * `gitdir:~/personal/` becomes `~/personal/**` (git already treats a trailing slash as `/**`).
 * A pattern that ends in `/.git` maps to the work tree. Any other path gets `/**`
 * because a zwt profile matches that folder and everything under it.
 */
export const gitdirToMatch = (gitdir: string): string => {
  const folder = gitdir.endsWith("/.git") ? gitdir.slice(0, -"/.git".length) : gitdir
  if (folder.endsWith("/**")) return folder
  if (folder.endsWith("/")) return `${folder}**`
  return `${folder}/**`
}

const emailOk = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

const takeKey = (base: string, used: Set<string>): string => {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  let key = `${base}-${n}`
  while (used.has(key)) {
    n++
    key = `${base}-${n}`
  }
  used.add(key)
  return key
}

/** Identities discovered from includeIf gitdir blocks. A bare `[user]` in the global file is ignored. */
export const importIdentities = (
  files: ReadonlyMap<string, string>,
  roots: ReadonlyArray<string>,
  home: string
): ReadonlyArray<IdentityDraft> => {
  const seen = new Set<string>()
  const pending = [...roots]
  const found: Array<{ readonly email: string; readonly name: string; readonly match: string; readonly gitdir: string }> = []

  while (pending.length > 0) {
    const file = pending.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    const text = files.get(file)
    if (text === undefined) continue
    const view = parseGitConfig(text)
    for (const path of includePaths(text, file, home)) pending.push(path)
    for (const block of view.includeIfs) {
      const target = resolveIncludePath(block.path, file, home)
      const included = files.get(target)
      if (included === undefined) continue
      const identity = parseGitConfig(included)
      if (identity.userEmail === undefined || !emailOk(identity.userEmail)) continue
      const at = identity.userEmail.indexOf("@")
      const fallback = at > 0 ? identity.userEmail.slice(0, at) : identity.userEmail
      found.push({
        email: identity.userEmail,
        name: identity.userName === undefined || identity.userName.length === 0 ? fallback : identity.userName,
        match: gitdirToMatch(block.gitdir),
        gitdir: block.gitdir
      })
    }
  }

  const groups: Array<{ email: string; name: string; gitdir: string; matches: Array<string> }> = []
  for (const item of found) {
    const group = groups.find((candidate) => candidate.email === item.email)
    if (group === undefined) {
      groups.push({ email: item.email, name: item.name, gitdir: item.gitdir, matches: [item.match] })
      continue
    }
    if (!group.matches.includes(item.match)) group.matches.push(item.match)
  }

  const used = new Set<string>()
  return groups.map((group) => ({
    key: takeKey(identityKeyBase(group.email, group.gitdir), used),
    name: group.name,
    email: group.email,
    matches: group.matches
  }))
}

const tomlString = (value: string) => JSON.stringify(value)

const tomlKey = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)

export const renderZwtToml = (identities: ReadonlyArray<IdentityDraft>): string => {
  const lines: Array<string> = ["version = 1"]
  for (const identity of identities) {
    lines.push("", `[identity.${tomlKey(identity.key)}]`, `name = ${tomlString(identity.name)}`, `email = ${tomlString(identity.email)}`)
  }
  for (const identity of identities) {
    for (const match of identity.matches) {
      lines.push("", "[[profile]]", `match = ${tomlString(match)}`, `identity = ${tomlString(identity.key)}`)
    }
  }
  return `${lines.join("\n")}\n`
}
