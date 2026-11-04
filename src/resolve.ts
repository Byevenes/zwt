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
}

export interface Identity {
  readonly name: string
  readonly email: string
}

export interface NewPlan {
  readonly branch: string
  readonly base: string
  readonly worktreePath: string
  readonly identity: Option.Option<Identity>
}

const pick = <A>(...candidates: ReadonlyArray<A | undefined>): A | undefined => candidates.find((c) => c !== undefined)

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
  const project = (config.project ?? []).find((p) => trimSlash(expandHome(p.path, home)) === repoRoot)
  const profile = (config.profile ?? [])
    .filter((p) => isUnder(repoRoot, profileRoot(p.match, home)))
    .sort((a, b) => profileRoot(b.match, home).length - profileRoot(a.match, home).length)[0]

  const base = pick(Option.getOrUndefined(flags.base), project?.base_branch, profile?.base_branch) ?? defaults.base_branch
  const prefix = pick(Option.getOrUndefined(flags.prefix), profile?.branch_prefix) ?? defaults.branch_prefix

  const identityName = pick(project?.identity, profile?.identity)
  const named = identityName === undefined ? undefined : config.identity[identityName]
  const identity = named === undefined
    ? Option.none<Identity>()
    : Option.some({ name: named.name, email: project?.email ?? named.email })

  const dir = expandHome(config.worktrees_dir ?? defaults.worktrees_dir, home)
  const parent = repoRoot.slice(0, repoRoot.lastIndexOf("/")) || "/"
  const repoName = repoRoot.slice(repoRoot.lastIndexOf("/") + 1)
  const root = dir.startsWith("/") ? trimSlash(dir) : `${parent === "/" ? "" : parent}/${trimSlash(dir)}`

  return { branch: `${prefix}${slug}`, base, worktreePath: `${root}/${repoName}/${slug}`, identity }
}

export const isValidSlug = (slug: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(slug) && !slug.includes("..")
