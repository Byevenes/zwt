import { Data } from "effect"

export class BranchNotFound extends Data.TaggedError("BranchNotFound")<{
  readonly branch: string
  readonly repo: string
}> {
  override get message() {
    return `branch "${this.branch}" does not exist in ${this.repo}`
  }
  get fix() {
    return `git -C ${this.repo} fetch origin ${this.branch}`
  }
}

export class IdentityMismatch extends Data.TaggedError("IdentityMismatch")<{
  readonly repo: string
  readonly expected: string
  readonly actual: string
  readonly hint?: string | undefined
}> {
  override get message() {
    return `${this.repo} commits as ${this.actual}, expected ${this.expected}`
  }
  get fix() {
    const write = `git -C ${this.repo} config --worktree user.email ${this.expected}`
    return this.hint === undefined ? write : `${write}. ${this.hint}`
  }
}

export interface ConfigIssue {
  readonly path: string
  readonly message: string
  readonly line?: number | undefined
}

export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly file: string
  readonly issues: ReadonlyArray<ConfigIssue>
}> {
  override get message() {
    const lines = this.issues.map((issue) => {
      const at = issue.line === undefined ? "" : `:${issue.line}`
      return `  ${this.file}${at} ${issue.path}: ${issue.message}`
    })
    return [`invalid config ${this.file}`, ...lines].join("\n")
  }
  get fix() {
    return `edit ${this.file} and run: zwt config check`
  }
}

export class ConfigNotFound extends Data.TaggedError("ConfigNotFound")<{
  readonly file: string
}> {
  override get message() {
    return `config not found at ${this.file}`
  }
  get fix() {
    return `create ${this.file} (see examples/zwt.toml) or pass --config <path>`
  }
}

export class GitCommandFailed extends Data.TaggedError("GitCommandFailed")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
}> {
  override get message() {
    return `git ${this.args.join(" ")} failed (exit ${this.exitCode}): ${this.stderr.trim()}`
  }
  get fix() {
    return `run the command by hand to inspect it: git ${this.args.join(" ")}`
  }
}

export class IdentityUnresolved extends Data.TaggedError("IdentityUnresolved")<{
  readonly repo: string
  readonly file: string
  readonly reason: "non-interactive" | "empty"
}> {
  override get message() {
    return `no git identity for ${this.repo}: no [[project]] or [[profile]] in ${this.file} matches it`
  }
  get fix() {
    const add = `add a [[profile]] with match = "${this.repo}/**" to ${this.file}, or run: zwt identity set <name> ${this.repo}`
    return this.reason === "non-interactive" ? `selector skipped in non-interactive mode. ${add}` : add
  }
}

export class UnknownIdentity extends Data.TaggedError("UnknownIdentity")<{
  readonly name: string
  readonly file: string
}> {
  override get message() {
    return `unknown identity "${this.name}" in ${this.file}`
  }
  get fix() {
    return `zwt identity list --config ${this.file}`
  }
}

export class ConfirmationRequired extends Data.TaggedError("ConfirmationRequired")<{
  readonly action: string
}> {
  override get message() {
    return `${this.action} needs confirmation and the terminal is not interactive`
  }
  get fix() {
    return `run it in a terminal. Confirmation is skipped in non-interactive mode`
  }
}

export class OriginMissing extends Data.TaggedError("OriginMissing")<{
  readonly repo: string
  readonly expected: string
}> {
  override get message() {
    return `no origin in ${this.repo}; expected a URL containing "${this.expected}"`
  }
  get fix() {
    return `git -C ${this.repo} remote add origin <url containing ${this.expected}>`
  }
}

export class RemoteMismatch extends Data.TaggedError("RemoteMismatch")<{
  readonly repo: string
  readonly expected: string
  readonly actual: string
}> {
  override get message() {
    return `origin ${this.actual} in ${this.repo} does not contain "${this.expected}"`
  }
  get fix() {
    return `git -C ${this.repo} remote set-url origin <url containing ${this.expected}>`
  }
}

export class RemoteIdentityMismatch extends Data.TaggedError("RemoteIdentityMismatch")<{
  readonly repo: string
  readonly origin: string
  readonly pattern: string
  readonly required: string
  readonly actual: string
}> {
  override get message() {
    return `origin ${this.origin} matches "${this.pattern}", which requires identity "${this.required}", but ${this.repo} uses "${this.actual}"`
  }
  get fix() {
    return `zwt identity set ${this.required} ${this.repo}`
  }
}

export class NotARepository extends Data.TaggedError("NotARepository")<{
  readonly path: string
  readonly file: string
}> {
  override get message() {
    return `${this.path} is not a git repository`
  }
  get fix() {
    return `edit ${this.file}: [[project]] path ${this.path} is not a git repository`
  }
}

export class DoctorFailed extends Data.TaggedError("DoctorFailed")<{
  readonly failed: number
  readonly fixes: ReadonlyArray<string>
}> {
  override get message() {
    return `${this.failed} ${this.failed === 1 ? "check" : "checks"} failed`
  }
  get fix() {
    return this.fixes.join("\n  fix: ")
  }
}

export class SyncFailed extends Data.TaggedError("SyncFailed")<{
  readonly failed: number
  readonly fixes: ReadonlyArray<string>
}> {
  override get message() {
    return `${this.failed} ${this.failed === 1 ? "repo was" : "repos were"} not fast-forwarded`
  }
  get fix() {
    return this.fixes.join("\n  fix: ")
  }
}

export class OverwriteRefused extends Data.TaggedError("OverwriteRefused")<{
  readonly file: string
}> {
  override get message() {
    return `refusing to overwrite ${this.file}`
  }
  get fix() {
    return `run zwt init in a terminal and confirm overwrite, or re-run with --yes`
  }
}

export class InvalidSlug extends Data.TaggedError("InvalidSlug")<{
  readonly slug: string
}> {
  override get message() {
    return `invalid slug "${this.slug}": use letters, digits, ".", "_" or "-" (no "/" or leading ".")`
  }
  get fix() {
    return `zwt new ${this.slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "my-task"}`
  }
}

export class PruneNeedsMerged extends Data.TaggedError("PruneNeedsMerged")<{}> {
  override get message() {
    return "zwt prune removes nothing unless --merged is set"
  }
  get fix() {
    return "zwt prune --merged"
  }
}

export class WorktreeDirty extends Data.TaggedError("WorktreeDirty")<{
  readonly path: string
  readonly slug: string
}> {
  override get message() {
    return `refusing to remove dirty worktree ${this.path}`
  }
  get fix() {
    return `commit or stash the changes in ${this.path}, or run: zwt rm ${this.slug} --force`
  }
}

export class WorktreeUnmerged extends Data.TaggedError("WorktreeUnmerged")<{
  readonly path: string
  readonly branch: string
  readonly base: string
  readonly slug: string
}> {
  override get message() {
    return `refusing to remove ${this.path}: branch "${this.branch}" is not merged into ${this.base}`
  }
  get fix() {
    return `merge "${this.branch}" into ${this.base}, or run: zwt rm ${this.slug} --force`
  }
}

export class WorktreeLocked extends Data.TaggedError("WorktreeLocked")<{
  readonly path: string
}> {
  override get message() {
    return `refusing to remove locked worktree ${this.path}`
  }
  get fix() {
    return `git worktree unlock ${this.path}`
  }
}

export class WorktreeCurrent extends Data.TaggedError("WorktreeCurrent")<{
  readonly path: string
}> {
  override get message() {
    return `refusing to remove ${this.path} while it is the current directory`
  }
  get fix() {
    return "cd to the main checkout and run the command again"
  }
}

export class WorktreeMissing extends Data.TaggedError("WorktreeMissing")<{
  readonly path: string
}> {
  override get message() {
    return `refusing to remove ${this.path}: its directory is gone, so zwt cannot prove it is clean`
  }
  get fix() {
    return "git worktree prune"
  }
}

export class MainWorktree extends Data.TaggedError("MainWorktree")<{
  readonly path: string
}> {
  override get message() {
    return `refusing to remove the main worktree ${this.path}`
  }
  get fix() {
    return "zwt rm removes a linked worktree, not the main checkout"
  }
}

export class AmbiguousWorktree extends Data.TaggedError("AmbiguousWorktree")<{
  readonly slug: string
  readonly paths: ReadonlyArray<string>
}> {
  override get message() {
    return `slug "${this.slug}" matches more than one worktree: ${this.paths.join(", ")}`
  }
  get fix() {
    return "zwt list"
  }
}

export type ZwtError =
  | BranchNotFound
  | IdentityMismatch
  | ConfigInvalid
  | ConfigNotFound
  | GitCommandFailed
  | IdentityUnresolved
  | UnknownIdentity
  | ConfirmationRequired
  | OriginMissing
  | RemoteMismatch
  | RemoteIdentityMismatch
  | NotARepository
  | DoctorFailed
  | InvalidSlug
  | OverwriteRefused
  | SyncFailed
  | PruneNeedsMerged
  | WorktreeDirty
  | WorktreeUnmerged
  | WorktreeLocked
  | WorktreeCurrent
  | WorktreeMissing
  | MainWorktree
  | AmbiguousWorktree

const zwtTags = new Set<string>([
  "BranchNotFound",
  "IdentityMismatch",
  "ConfigInvalid",
  "ConfigNotFound",
  "GitCommandFailed",
  "IdentityUnresolved",
  "UnknownIdentity",
  "ConfirmationRequired",
  "OriginMissing",
  "RemoteMismatch",
  "RemoteIdentityMismatch",
  "NotARepository",
  "DoctorFailed",
  "InvalidSlug",
  "OverwriteRefused",
  "SyncFailed",
  "PruneNeedsMerged",
  "WorktreeDirty",
  "WorktreeUnmerged",
  "WorktreeLocked",
  "WorktreeCurrent",
  "WorktreeMissing",
  "MainWorktree",
  "AmbiguousWorktree"
])

export const isZwtError = <E>(u: E): u is Extract<E, ZwtError> =>
  typeof u === "object" && u !== null && "_tag" in u && zwtTags.has(String(u._tag))

export const render = (error: ZwtError): string => `error: ${error.message}\n  fix: ${error.fix}`
