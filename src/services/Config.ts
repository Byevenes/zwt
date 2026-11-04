import { Context, Effect, Exit, FileSystem, Layer, Schema } from "effect"
import * as SchemaIssue from "effect/SchemaIssue"
import { parse as parseToml, TomlError } from "smol-toml"
import { type ConfigIssue, ConfigInvalid, ConfigNotFound } from "../errors.ts"

const tokenPatterns: ReadonlyArray<RegExp> = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

export const looksLikeToken = (value: string): boolean => tokenPatterns.some((pattern) => pattern.test(value))

const Text = Schema.String.check(
  Schema.makeFilter((value: string) => looksLikeToken(value) ? "looks like a secret token; zwt config holds no secrets" : true)
)

const Email = Text.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: "must be an email address" }))

const Identity = Schema.Struct({ name: Text, email: Email })

const Profile = Schema.Struct({
  match: Text,
  identity: Text,
  base_branch: Schema.optionalKey(Text),
  branch_prefix: Schema.optionalKey(Text),
  expect_remote: Schema.optionalKey(Text),
  guards: Schema.optionalKey(Schema.Array(Schema.Literals(["pre-commit", "pre-push"])))
})

const Project = Schema.Struct({
  path: Text,
  identity: Schema.optionalKey(Text),
  base_branch: Schema.optionalKey(Text),
  email: Schema.optionalKey(Email)
})

export const ZwtConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  worktrees_dir: Schema.optionalKey(Text),
  scratch_dir: Schema.optionalKey(Text),
  identity: Schema.Record(Schema.String, Identity),
  profile: Schema.optionalKey(Schema.Array(Profile)),
  project: Schema.optionalKey(Schema.Array(Project))
})

export type ZwtConfig = typeof ZwtConfigSchema.Type

const decode = Schema.decodeUnknownExit(ZwtConfigSchema)

const formatPath = (path: ReadonlyArray<PropertyKey>) =>
  path.map((segment) => typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`).join("").replace(/^\./, "") || "(root)"

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const lineOf = (source: string, path: ReadonlyArray<PropertyKey>): number | undefined => {
  const lines = source.split("\n").map((line) => line.trim())
  const findFrom = (from: number, test: (line: string) => boolean) => {
    const index = lines.findIndex((line, l) => l >= from && test(line))
    return index >= 0 ? index : undefined
  }
  let from = 0
  let table = ""
  for (let i = 0; i < path.length; i++) {
    const segment = String(path[i])
    const next = path[i + 1]
    const candidate = table === "" ? segment : `${table}.${segment}`
    if (typeof next === "number") {
      let seen = -1
      const found = findFrom(from, (line) => line === `[[${candidate}]]` && ++seen === next)
      if (found === undefined) return undefined
      from = found
      table = candidate
      i++
      continue
    }
    const header = findFrom(from, (line) => line === `[${candidate}]`)
    if (header !== undefined) {
      from = header
      table = candidate
      continue
    }
    if (findFrom(from, (line) => line.startsWith(`[${candidate}.`) || line.startsWith(`[[${candidate}.`)) !== undefined) {
      table = candidate
      continue
    }
    const key = new RegExp(`^${escapeRegExp(segment)}\\s*=`)
    const keyLine = findFrom(from, (line) => key.test(line))
    return (keyLine ?? from) + 1
  }
  return from + 1
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

const unknownIdentityIssues = (config: ZwtConfig, source: string): ReadonlyArray<ConfigIssue> => {
  const references = [
    ...(config.profile ?? []).map((entry, index) => ["profile", index, entry.identity] as const),
    ...(config.project ?? []).map((entry, index) => ["project", index, entry.identity] as const)
  ]
  return references.flatMap(([table, index, identity]) =>
    identity === undefined || identity in config.identity
      ? []
      : [{
        path: `${table}[${index}].identity`,
        message: `unknown identity "${identity}"; define [identity.${identity}]`,
        line: lineOf(source, [table, index, "identity"])
      }]
  )
}

export const parseConfig = (file: string, source: string): Effect.Effect<ZwtConfig, ConfigInvalid> =>
  Effect.gen(function*() {
    const raw = yield* Effect.try({
      try: () => parseToml(source),
      catch: (error) =>
        new ConfigInvalid({
          file,
          issues: [{
            path: "(toml)",
            message: error instanceof TomlError ? error.message.split("\n")[0] ?? "invalid TOML" : String(error),
            ...(error instanceof TomlError ? { line: error.line } : {})
          }]
        })
    })
    const exit = decode(raw, { errors: "all", onExcessProperty: "error" })
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      const issues = failure?._tag === "Fail"
        ? formatter(failure.error.issue).issues.map((issue) => {
          const path = (issue.path ?? []).map((p) => typeof p === "object" ? p.key : p)
          return { path: formatPath(path), message: issue.message, line: lineOf(source, path) }
        })
        : [{ path: "(root)", message: "invalid config" }]
      return yield* new ConfigInvalid({ file, issues })
    }
    const crossIssues = unknownIdentityIssues(exit.value, source)
    if (crossIssues.length > 0) return yield* new ConfigInvalid({ file, issues: crossIssues })
    return exit.value
  })

export const defaultConfigPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const base = env.XDG_CONFIG_HOME || `${env.HOME ?? "~"}/.config`
  return `${base}/zwt/zwt.toml`
}

export class Config extends Context.Service<Config, {
  readonly load: (file: string) => Effect.Effect<ZwtConfig, ConfigInvalid | ConfigNotFound>
}>()("zwt/Config") {
  static readonly live = Layer.effect(
    Config,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return {
        load: (file) =>
          fs.readFileString(file).pipe(
            Effect.mapError(() => new ConfigNotFound({ file })),
            Effect.flatMap((source) => parseConfig(file, source))
          )
      }
    })
  )
}
