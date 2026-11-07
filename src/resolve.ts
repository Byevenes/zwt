import { Option } from "effect"
import type { ZwtConfig } from "./services/Config.ts"

export const defaults = { base_branch: "main", branch_prefix: "", worktrees_dir: "worktrees", scratch_dir: ".scratch" } as const

/** Expands a leading `~` so the same zwt.toml works on any machine. */
export const expandHome = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path

const trimSlash = (path: string) => path.replace(/\/+$/, "")

/** `match` is a folder, optionally ending in `/**`; it matches that folder and everything under it. */
export const profileRoot = (match: string, home: string): string =>
  trimSlash(expandHome(match, home).replace(/\/\*\*$/, ""))

const isUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

export interface NewFlags {
  readonly base: Option.Option<string>
  readonly prefix: Option.Option<string>
  readonly email: Option.Option<string>
  readonly identity: Option.Option<string>
}

export interface Identity {
  readonly name: string
  readonly email: string
}

/** Resolved email, an unknown `--identity` name, or nothing to apply. */
export type IdentityResolution =
  | { readonly _tag: "Resolved"; readonly identity: Identity }
  | { readonly _tag: "Unresolved" }
  | { readonly _tag: "Unknown"; readonly name: string }

export type BranchNameError =
  | { readonly _tag: "TicketMissing"; readonly pattern: string }
  | { readonly _tag: "Empty" }

export interface NewPlan {
  readonly branch: string
  readonly branchError?: BranchNameError
  readonly base: string
  readonly worktreePath: string
  readonly scratchDir: string
  readonly identity: IdentityResolution
}

const pick = <A>(...candidates: ReadonlyArray<A | undefined>): A | undefined => candidates.find((c) => c !== undefined)

const mailboxName = (email: string): string => {
  const local = email.slice(0, email.indexOf("@"))
  return local.length > 0 ? local : email
}

const matchesFor = (config: ZwtConfig, repoRoot: string, home: string) => {
  const project = (config.project ?? []).find((p) => trimSlash(expandHome(p.path, home)) === repoRoot)
  const profile = (config.profile ?? [])
    .filter((p) => isUnder(repoRoot, profileRoot(p.match, home)))
    .sort((a, b) => profileRoot(b.match, home).length - profileRoot(a.match, home).length)[0]
  return { profile, project }
}

/** `--email` / `--identity` > `[[project]]` > deepest `[[profile]]`. */
export const resolveIdentity = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly home: string
  readonly flags: Pick<NewFlags, "email" | "identity">
}): IdentityResolution => {
  const { config, flags, home } = options
  const repoRoot = trimSlash(options.repoRoot)
  const { profile, project } = matchesFor(config, repoRoot, home)
  const flagIdentity = Option.getOrUndefined(flags.identity)
  const flagEmail = Option.getOrUndefined(flags.email)
  if (flagIdentity !== undefined && config.identity[flagIdentity] === undefined) {
    return { _tag: "Unknown", name: flagIdentity }
  }

  const identityKey = pick(flagIdentity, project?.identity, profile?.identity)
  const named = identityKey === undefined ? undefined : config.identity[identityKey]
  if (named !== undefined) {
    const email = flagIdentity !== undefined ? (flagEmail ?? named.email) : pick(flagEmail, project?.email, named.email)
    return { _tag: "Resolved", identity: { name: named.name, email: email ?? named.email } }
  }
  if (flagEmail !== undefined) return { _tag: "Resolved", identity: { name: mailboxName(flagEmail), email: flagEmail } }
  return { _tag: "Unresolved" }
}

/** Deepest matching profile's `expect_remote`, or nothing. The project table has no such key. */
export const resolveExpectRemote = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly home: string
}): string | undefined => matchesFor(options.config, trimSlash(options.repoRoot), options.home).profile?.expect_remote

/** Identity key from `--identity`, then `[[project]]`, then the deepest profile. An email-only resolution has none. */
export const resolveIdentityKey = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly home: string
  readonly flags: Pick<NewFlags, "identity">
}): string | undefined => {
  const { config, flags, home } = options
  const repoRoot = trimSlash(options.repoRoot)
  const flagIdentity = Option.getOrUndefined(flags.identity)
  if (flagIdentity !== undefined) return config.identity[flagIdentity] === undefined ? undefined : flagIdentity
  const { profile, project } = matchesFor(config, repoRoot, home)
  const identityKey = pick(project?.identity, profile?.identity)
  return identityKey !== undefined && config.identity[identityKey] !== undefined ? identityKey : undefined
}

export interface RemoteIdentityClash {
  readonly pattern: string
  readonly required: string
  readonly actual: string
}

/**
 * `pattern` is a case-sensitive substring of the origin URL, not a glob (`*` is literal).
 * `github.com/other-org/` matches `https://github.com/other-org/app.git` and does not match
 * `git@github.com:other-org/app.git` (the colon is a different character). The longest match
 * wins. Equal lengths keep the earlier `[[remote]]`.
 */
export const matchingRemote = (
  remotes: ZwtConfig["remote"],
  origin: string
): { readonly pattern: string; readonly identity: string } | undefined => {
  let best: { readonly pattern: string; readonly identity: string } | undefined
  for (const remote of remotes ?? []) {
    if (remote.pattern.length === 0 || !origin.includes(remote.pattern)) continue
    if (best === undefined || remote.pattern.length > best.pattern.length) best = remote
  }
  return best
}

/**
 * A clash is the winning `[[remote]]` requiring a different identity than the folder.
 * Named resolutions compare keys. Email-only resolutions compare that email with the
 * required identity's email. No origin, no rules, or no match is not a clash.
 */
export const remoteIdentityClash = (options: {
  readonly config: ZwtConfig
  readonly origin: string | undefined
  readonly identityKey: string | undefined
  readonly email: string | undefined
}): RemoteIdentityClash | undefined => {
  if (options.origin === undefined) return undefined
  const match = matchingRemote(options.config.remote, options.origin)
  if (match === undefined) return undefined
  if (options.identityKey !== undefined) {
    if (options.identityKey === match.identity) return undefined
    return { pattern: match.pattern, required: match.identity, actual: options.identityKey }
  }
  if (options.email !== undefined) {
    const requiredEmail = options.config.identity[match.identity]?.email
    if (requiredEmail === undefined || requiredEmail === options.email) return undefined
    return { pattern: match.pattern, required: match.identity, actual: options.email }
  }
  return { pattern: match.pattern, required: match.identity, actual: "(unresolved)" }
}

/** `[[project]]` > deepest `[[profile]]` > `main`. Same base `zwt new` uses when `--base` is absent. */
export const resolveBase = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly home: string
}): string => {
  const repoRoot = trimSlash(options.repoRoot)
  const { profile, project } = matchesFor(options.config, repoRoot, options.home)
  return pick(project?.base_branch, profile?.base_branch) ?? defaults.base_branch
}

/** Deepest matching profile's prefix, or none. The project table has no prefix. */
export const resolvePrefix = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly home: string
}): string => {
  const { profile } = matchesFor(options.config, trimSlash(options.repoRoot), options.home)
  return profile?.branch_prefix ?? defaults.branch_prefix
}

/** `<repo parent>/<worktrees_dir>/<repo>/<slug>`, the same folder `zwt new` creates. */
export const resolveWorktreePath = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly home: string
  readonly slug: string
}): string => {
  const repoRoot = trimSlash(options.repoRoot)
  const dir = expandHome(options.config.worktrees_dir ?? defaults.worktrees_dir, options.home)
  const parent = repoRoot.slice(0, repoRoot.lastIndexOf("/")) || "/"
  const repoName = repoRoot.slice(repoRoot.lastIndexOf("/") + 1)
  const root = dir.startsWith("/") ? trimSlash(dir) : `${parent === "/" ? "" : parent}/${trimSlash(dir)}`
  return `${root}/${repoName}/${options.slug}`
}

/**
 * Regular expression anchored at the start of the slug.
 * `*` is a quantifier here, not a glob. `[[remote]].pattern` stays a substring.
 * Undefined when `pattern` is not a valid RegExp.
 */
export const compileTicketPattern = (pattern: string): RegExp | undefined => {
  try {
    return new RegExp(`^(?:${pattern})`)
  } catch {
    return undefined
  }
}

const splitTicket = (slug: string, pattern: string): { readonly ticket: string; readonly rest: string } | undefined => {
  const compiled = compileTicketPattern(pattern)
  if (compiled === undefined) return undefined
  const match = compiled.exec(slug)
  if (match === null || match[0].length === 0) return undefined
  return { ticket: match[0], rest: slug.slice(match[0].length).replace(/^[-_]/, "") }
}

const isJoiner = (text: string) => text === "-" || text === "_" || text === "/"

type TemplatePiece =
  | { readonly _tag: "lit"; readonly text: string }
  | { readonly _tag: "ph"; readonly name: "ticket" | "slug" | "prefix" }

/** Drops an empty placeholder and one `-`, `_`, or `/` written next to it. */
const fillTemplate = (
  template: string,
  values: { readonly ticket: string; readonly slug: string; readonly prefix: string }
): string => {
  const pieces: Array<TemplatePiece> = []
  const pattern = /\{(ticket|slug|prefix)\}/g
  let last = 0
  for (const match of template.matchAll(pattern)) {
    const index = match.index
    if (index === undefined) continue
    if (index > last) pieces.push({ _tag: "lit", text: template.slice(last, index) })
    const name = match[1]
    if (name === "ticket" || name === "slug" || name === "prefix") pieces.push({ _tag: "ph", name })
    last = index + match[0].length
  }
  if (last < template.length) pieces.push({ _tag: "lit", text: template.slice(last) })

  const drop = new Set<number>()
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]
    if (piece === undefined || piece._tag !== "ph" || values[piece.name] !== "") continue
    drop.add(i)
    const prev = pieces[i - 1]
    const next = pieces[i + 1]
    if (prev?._tag === "lit" && isJoiner(prev.text)) drop.add(i - 1)
    else if (next?._tag === "lit" && isJoiner(next.text)) drop.add(i + 1)
  }

  let branch = ""
  for (let i = 0; i < pieces.length; i++) {
    if (drop.has(i)) continue
    const piece = pieces[i]
    if (piece === undefined) continue
    branch += piece._tag === "lit" ? piece.text : values[piece.name]
  }
  return branch
}

const nameBranch = (options: {
  readonly slug: string
  readonly prefix: string
  readonly template: string | undefined
  readonly pattern: string | undefined
}): { readonly _tag: "Ready"; readonly branch: string } | BranchNameError => {
  const { pattern, prefix, slug, template } = options
  if (template === undefined) return { _tag: "Ready", branch: `${prefix}${slug}` }
  if (!template.includes("{ticket}")) {
    const branch = fillTemplate(template, { ticket: "", slug, prefix })
    return branch.length === 0 ? { _tag: "Empty" } : { _tag: "Ready", branch }
  }
  if (pattern === undefined || pattern.length === 0) return { _tag: "TicketMissing", pattern: "" }
  const split = splitTicket(slug, pattern)
  if (split === undefined) return { _tag: "TicketMissing", pattern }
  const branch = fillTemplate(template, { ticket: split.ticket, slug: split.rest, prefix })
  return branch.length === 0 ? { _tag: "Empty" } : { _tag: "Ready", branch }
}

/** Pure resolution for `zwt new`: `--flag` > `[[project]]` > `[[profile]]` (deepest match) > defaults. */
export const resolveNew = (options: {
  readonly config: ZwtConfig
  readonly repoRoot: string
  readonly slug: string
  readonly home: string
  readonly flags: NewFlags
}): NewPlan => {
  const { config, flags, home, slug } = options
  const repoRoot = trimSlash(options.repoRoot)
  const { profile } = matchesFor(config, repoRoot, home)
  const flaggedBase = Option.getOrUndefined(flags.base)
  const flagPrefix = Option.getOrUndefined(flags.prefix)
  const base = flaggedBase !== undefined ? flaggedBase : resolveBase({ config, repoRoot, home })
  const prefix = flagPrefix !== undefined ? flagPrefix : resolvePrefix({ config, repoRoot, home })
  const identity = resolveIdentity({ config, repoRoot, home, flags })
  const named = nameBranch({
    slug,
    prefix,
    template: flagPrefix === undefined ? profile?.branch_template : undefined,
    pattern: profile?.ticket_pattern
  })

  return {
    branch: named._tag === "Ready" ? named.branch : "",
    ...(named._tag === "Ready" ? {} : { branchError: named }),
    base,
    worktreePath: resolveWorktreePath({ config, repoRoot, home, slug }),
    scratchDir: config.scratch_dir ?? defaults.scratch_dir,
    identity
  }
}

export const isValidSlug = (slug: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(slug) && !slug.includes("..")
