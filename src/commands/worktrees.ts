import { Effect } from "effect"
import {
  AmbiguousWorktree,
  BranchNotFound,
  InvalidSlug,
  MainWorktree,
  PruneNeedsMerged,
  WorktreeCurrent,
  WorktreeDirty,
  WorktreeLocked,
  WorktreeMissing,
  WorktreeUnmerged
} from "../errors.ts"
import { isValidSlug, resolveBase, resolvePrefix, resolveWorktreePath } from "../resolve.ts"
import { Config } from "../services/Config.ts"
import { Git, type GitShape, type WorktreeEntry, type WorktreeHead } from "../services/Git.ts"

const trimSlash = (path: string) => path.replace(/\/+$/, "")

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** Parent of `<repo>/.git`. A bare repo's common dir has no `/.git` suffix. */
export const mainWorktreePath = (commonDir: string): string | undefined => {
  const dir = commonDir.replace(/\/+$/, "")
  if (!dir.endsWith("/.git")) return undefined
  const parent = dir.slice(0, -"/.git".length)
  return parent.length === 0 ? "/" : parent
}

export interface WorktreeRow {
  readonly path: string
  readonly branch: string
  readonly merged: "yes" | "no"
  readonly dirty: "yes" | "no" | "missing"
}

export const keepReasons = ["current", "missing", "locked", "detached", "dirty", "unmerged"] as const
export type KeepReason = (typeof keepReasons)[number]

export type PruneItem =
  | {
    readonly _tag: "Removed"
    readonly path: string
    readonly branch: string
    readonly branchDeleted: boolean
    readonly branchKept: "base" | undefined
  }
  | {
    readonly _tag: "Kept"
    readonly path: string
    readonly branch: string
    readonly reason: KeepReason
  }

export type RmResult =
  | {
    readonly _tag: "Removed"
    readonly path: string
    readonly branch: string | undefined
    readonly branchDeleted: boolean
    readonly branchKept: "base" | "unmerged" | undefined
  }
  | { readonly _tag: "Absent"; readonly slug: string }

export interface RemovalVerbs {
  readonly removed: string
  readonly deleted: string
}

interface Inspected {
  readonly path: string
  readonly branch: string | undefined
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly missing: boolean
  readonly merged: boolean
  readonly dirty: boolean
  readonly current: boolean
  readonly main: boolean
}

const displayBranch = (worktree: Inspected): string => {
  if (worktree.bare) return "bare"
  if (worktree.detached || worktree.branch === undefined) return "detached"
  return worktree.branch
}

const toRow = (worktree: Inspected): WorktreeRow => ({
  path: worktree.path,
  branch: displayBranch(worktree),
  merged: worktree.merged ? "yes" : "no",
  dirty: worktree.missing ? "missing" : worktree.dirty ? "yes" : "no"
})

export const renderList = (rows: ReadonlyArray<WorktreeRow>): string => {
  const header = "path | branch | merged | dirty"
  if (rows.length === 0) return `${header}\nno worktrees`
  return [header, ...rows.map((row) => `${row.path} | ${row.branch} | ${row.merged} | ${row.dirty}`)].join("\n")
}

export const renderPrune = (items: ReadonlyArray<PruneItem>, verbs: RemovalVerbs): string => {
  const lines: Array<string> = []
  let removed = 0
  for (const item of items) {
    switch (item._tag) {
      case "Removed":
        removed++
        lines.push(`${verbs.removed} ${item.path} (branch ${item.branch})`)
        if (item.branchDeleted) lines.push(`${verbs.deleted} ${item.branch}`)
        if (item.branchKept === "base") lines.push(`kept branch ${item.branch} (base)`)
        break
      case "Kept":
        lines.push(`kept ${item.path} (${item.reason})`)
        break
      default: {
        const unreachable: never = item
        return unreachable
      }
    }
  }
  return (removed === 0 ? ["nothing to remove", ...lines] : lines).join("\n")
}

export const renderRemoval = (result: RmResult, verbs: RemovalVerbs): string => {
  switch (result._tag) {
    case "Absent":
      return `absent ${result.slug}`
    case "Removed": {
      const noun = result.branch === undefined ? "detached" : `branch ${result.branch}`
      const lines = [`${verbs.removed} ${result.path} (${noun})`]
      if (result.branchDeleted && result.branch !== undefined) lines.push(`${verbs.deleted} ${result.branch}`)
      if (result.branchKept === "unmerged" && result.branch !== undefined) lines.push(`kept branch ${result.branch} (unmerged)`)
      if (result.branchKept === "base" && result.branch !== undefined) lines.push(`kept branch ${result.branch} (base)`)
      return lines.join("\n")
    }
    default: {
      const unreachable: never = result
      return unreachable
    }
  }
}

const keepReason = (worktree: Inspected): KeepReason | undefined => {
  if (worktree.current) return "current"
  if (worktree.missing) return "missing"
  if (worktree.locked) return "locked"
  if (worktree.detached || worktree.branch === undefined) return "detached"
  if (worktree.dirty) return "dirty"
  if (!worktree.merged) return "unmerged"
  return undefined
}

const branchOf = (head: WorktreeHead): string | undefined => {
  switch (head._tag) {
    case "Branch":
      return head.name
    case "Detached":
    case "Bare":
      return undefined
    default: {
      const unreachable: never = head
      return unreachable
    }
  }
}

const inspectOne = (options: {
  readonly git: GitShape
  readonly worktree: WorktreeEntry
  readonly base: string
  readonly repo: string
  readonly current: string
}) =>
  Effect.gen(function*() {
    const { base, current, git, repo, worktree } = options
    const path = trimSlash(worktree.path)
    const branch = branchOf(worktree.head)
    const detached = worktree.head._tag === "Detached"
    const bare = worktree.head._tag === "Bare"
    const merged = branch === undefined ? false : yield* git.isAncestor(branch, base, repo)
    const missing = worktree.prunable
    const dirty = missing ? false : (yield* git.statusPorcelain(path)).length > 0
    return {
      path,
      branch,
      detached,
      bare,
      locked: worktree.locked,
      missing,
      merged,
      dirty,
      current: path === current,
      main: path === repo
    } satisfies Inspected
  })

/**
 * Profiles match the main checkout. A command started inside a linked worktree
 * still resolves the base from that checkout, not from the worktree path.
 */
const loadRepo = (options: { readonly cwd: string; readonly home: string; readonly configFile: string }) =>
  Effect.gen(function*() {
    const git = yield* Git
    const here = trimSlash(yield* git.repoRoot(options.cwd))
    const main = mainWorktreePath(yield* git.commonDir(here)) ?? here
    const config = yield* (yield* Config).load(options.configFile)
    const base = resolveBase({ config, repoRoot: main, home: options.home })
    if (!(yield* git.refExists(base, main))) return yield* new BranchNotFound({ branch: base, repo: main })
    const listed = yield* git.listWorktrees(main)
    const inspected: Array<Inspected> = []
    for (const worktree of listed) {
      inspected.push(yield* inspectOne({ git, worktree, base, repo: main, current: here }))
    }
    return {
      git,
      config,
      base,
      prefix: resolvePrefix({ config, repoRoot: main, home: options.home }),
      repo: main,
      inspected
    }
  })

const deleteIfAsked = (options: {
  readonly git: GitShape
  readonly repo: string
  readonly branch: string | undefined
  readonly base: string
  readonly merged: boolean
  readonly deleteBranch: boolean
}) =>
  Effect.gen(function*() {
    const { base, branch, deleteBranch, git, merged, repo } = options
    if (!deleteBranch || branch === undefined) return { branchDeleted: false, branchKept: undefined }
    if (branch === base) return { branchDeleted: false, branchKept: "base" as const }
    if (!merged) return { branchDeleted: false, branchKept: "unmerged" as const }
    // `-d` only looks at HEAD. A branch that is in the base but not in HEAD still has to go.
    const inHead = yield* git.isAncestor(branch, "HEAD", repo)
    yield* git.deleteLocalBranch(branch, repo, inHead ? "merged-head" : "merged-base")
    return { branchDeleted: true, branchKept: undefined }
  })

export const listWorktrees = (options: { readonly cwd: string; readonly home: string; readonly configFile: string }) =>
  Effect.gen(function*() {
    const loaded = yield* loadRepo(options)
    return loaded.inspected.map(toRow)
  })

export const pruneMerged = (options: {
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly merged: boolean
  readonly deleteBranch: boolean
}) =>
  Effect.gen(function*() {
    if (!options.merged) return yield* new PruneNeedsMerged()
    const loaded = yield* loadRepo(options)
    const { base, git, inspected, repo } = loaded
    const { deleteBranch } = options
    const items: Array<PruneItem> = []
    for (const worktree of inspected) {
      if (worktree.main || worktree.bare) continue
      const reason = keepReason(worktree)
      if (reason !== undefined || worktree.branch === undefined) {
        items.push({
          _tag: "Kept",
          path: worktree.path,
          branch: displayBranch(worktree),
          reason: reason ?? "detached"
        })
        continue
      }
      yield* git.removeWorktree(repo, worktree.path, false)
      const deleted = yield* deleteIfAsked({
        git,
        repo,
        branch: worktree.branch,
        base,
        merged: true,
        deleteBranch
      })
      items.push({
        _tag: "Removed",
        path: worktree.path,
        branch: worktree.branch,
        branchDeleted: deleted.branchDeleted,
        branchKept: deleted.branchKept === "base" ? "base" : undefined
      })
    }
    return items
  })

const matchesSlug = (worktree: Inspected, slug: string, expectedPath: string, expectedBranch: string): boolean =>
  !worktree.bare && (worktree.path === expectedPath || basename(worktree.path) === slug || worktree.branch === expectedBranch)

export const removeWorktreeBySlug = (options: {
  readonly slug: string
  readonly cwd: string
  readonly home: string
  readonly configFile: string
  readonly force: boolean
  readonly deleteBranch: boolean
}) =>
  Effect.gen(function*() {
    const { deleteBranch, force, slug } = options
    if (!isValidSlug(slug)) return yield* new InvalidSlug({ slug })
    const loaded = yield* loadRepo(options)
    const { base, config, git, inspected, prefix, repo } = loaded
    const expectedPath = resolveWorktreePath({ config, repoRoot: repo, home: options.home, slug })
    const expectedBranch = `${prefix}${slug}`
    const matches = inspected.filter((worktree) => matchesSlug(worktree, slug, expectedPath, expectedBranch))
    const linked = matches.filter((worktree) => !worktree.main)
    const exact = linked.find((worktree) => worktree.path === expectedPath)
    const only = linked.length === 1 ? linked[0] : undefined
    const target = exact ?? only
    if (target === undefined) {
      if (linked.length > 1) return yield* new AmbiguousWorktree({ slug, paths: linked.map((worktree) => worktree.path) })
      const mainHit = matches.find((worktree) => worktree.main)
      if (mainHit !== undefined) return yield* new MainWorktree({ path: mainHit.path })
      return { _tag: "Absent", slug } satisfies RmResult
    }
    if (target.current) return yield* new WorktreeCurrent({ path: target.path })
    if (target.locked) return yield* new WorktreeLocked({ path: target.path })
    if (!force) {
      if (target.missing) return yield* new WorktreeMissing({ path: target.path })
      if (target.dirty) return yield* new WorktreeDirty({ path: target.path, slug })
      if (target.detached || target.branch === undefined || !target.merged) {
        return yield* new WorktreeUnmerged({
          path: target.path,
          branch: target.branch ?? "detached",
          base,
          slug
        })
      }
    }
    yield* git.removeWorktree(repo, target.path, force)
    const deleted = yield* deleteIfAsked({
      git,
      repo,
      branch: target.branch,
      base,
      merged: target.merged && !target.detached,
      deleteBranch
    })
    return {
      _tag: "Removed",
      path: target.path,
      branch: target.detached ? undefined : target.branch,
      branchDeleted: deleted.branchDeleted,
      branchKept: deleted.branchKept
    } satisfies RmResult
  })
