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
}> {
  override get message() {
    return `${this.repo} commits as ${this.actual}, expected ${this.expected}`
  }
  get fix() {
    return `git -C ${this.repo} config user.email ${this.expected}`
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
}> {
  override get message() {
    return `no git identity for ${this.repo}: no [[project]] or [[profile]] in ${this.file} matches it`
  }
  get fix() {
    return `add a [[profile]] with match = "${this.repo}/**" and an identity to ${this.file}, then run: zwt config check`
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

export type ZwtError =
  | BranchNotFound
  | IdentityMismatch
  | ConfigInvalid
  | ConfigNotFound
  | GitCommandFailed
  | IdentityUnresolved
  | InvalidSlug

const zwtTags = new Set<string>([
  "BranchNotFound",
  "IdentityMismatch",
  "ConfigInvalid",
  "ConfigNotFound",
  "GitCommandFailed",
  "IdentityUnresolved",
  "InvalidSlug"
])

export const isZwtError = <E>(u: E): u is Extract<E, ZwtError> =>
  typeof u === "object" && u !== null && "_tag" in u && zwtTags.has(String(u._tag))

export const render = (error: ZwtError): string => `error: ${error.message}\n  fix: ${error.fix}`
