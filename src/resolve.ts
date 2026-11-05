import { Option } from "effect"
import type { ZwtConfig } from "./services/Config.ts"

export const defaults = { base_branch: "main", branch_prefix: "", worktrees_dir: "worktrees" } as const

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

export interface NewPlan {
  readonly branch: string
  readonly base: string
  readonly worktreePath: string
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
  const { profile, project } = matchesFor(config, repoRoot, home)
  const base = pick(Option.getOrUndefined(flags.base), project?.base_branch, profile?.base_branch) ?? defaults.base_branch
  const prefix = pick(Option.getOrUndefined(flags.prefix), profile?.branch_prefix) ?? defaults.branch_prefix
  const identity = resolveIdentity({ config, repoRoot, home, flags })

  const dir = expandHome(config.worktrees_dir ?? defaults.worktrees_dir, home)
  const parent = repoRoot.slice(0, repoRoot.lastIndexOf("/")) || "/"
  const repoName = repoRoot.slice(repoRoot.lastIndexOf("/") + 1)
  const root = dir.startsWith("/") ? trimSlash(dir) : `${parent === "/" ? "" : parent}/${trimSlash(dir)}`

  return { branch: `${prefix}${slug}`, base, worktreePath: `${root}/${repoName}/${slug}`, identity }
}

export const isValidSlug = (slug: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(slug) && !slug.includes("..")
