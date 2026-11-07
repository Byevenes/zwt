import { resolve as resolvePath } from "node:path"
import { Console, Effect, Option } from "effect"
import { DoctorFailed, IdentityMismatch, IdentityUnresolved, NotARepository, OriginMissing, RemoteIdentityMismatch, RemoteMismatch, UnknownIdentity } from "../errors.ts"
import { includeIfHint } from "./identity.ts"
import { configuredRepos } from "../repos.ts"
import { expandHome, matchingRemote, remoteIdentityClash, resolveExpectRemote, resolveIdentity, resolveIdentityKey, type IdentityResolution } from "../resolve.ts"
import { Config, type ZwtConfig } from "../services/Config.ts"
import { Git } from "../services/Git.ts"

const trimSlash = (path: string) => path.replace(/\/+$/, "")

const blankFlags = { email: Option.none<string>(), identity: Option.none<string>() }

const normalizeFolder = (path: string, cwd: string, home: string) => trimSlash(resolvePath(cwd, expandHome(path, home)))

export type CheckStatus = "ok" | "warn" | "fail"

export interface Check {
  readonly name: "identity" | "expect_remote" | "remote_identity" | "hooksPath" | "repository"
  readonly status: CheckStatus
  readonly detail: string
  readonly fix?: string
}

export interface RepoReport {
  readonly repo: string
  readonly currentEmail: string
  readonly expectedEmail: string
  readonly status: CheckStatus
  readonly checks: ReadonlyArray<Check>
}

const overall = (checks: ReadonlyArray<Check>): CheckStatus =>
  checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "ok"

const fail = (name: Check["name"], detail: string, fix: string): Check => ({ name, status: "fail", detail, fix })

const identityCheck = (options: {
  readonly repo: string
  readonly file: string
  readonly resolution: IdentityResolution
  readonly actual: string
}): Check => {
  const { actual, file, repo, resolution } = options
  if (resolution._tag === "Resolved") {
    if (actual === resolution.identity.email) return { name: "identity", status: "ok", detail: `matches ${resolution.identity.email}` }
    const error = new IdentityMismatch({
      repo,
      expected: resolution.identity.email,
      actual: actual.length === 0 ? "(unset)" : actual,
      hint: includeIfHint
    })
    return fail("identity", error.message, error.fix)
  }
  if (resolution._tag === "Unknown") {
    const error = new UnknownIdentity({ name: resolution.name, file })
    return fail("identity", error.message, error.fix)
  }
  const error = new IdentityUnresolved({ repo, file, reason: "empty" })
  return fail("identity", error.message, error.fix)
}

const remoteCheck = (repo: string, expected: string | undefined, origin: Option.Option<string>): Check => {
  if (expected === undefined) return { name: "expect_remote", status: "ok", detail: "no expect_remote" }
  if (Option.isNone(origin)) {
    const error = new OriginMissing({ repo, expected })
    return fail("expect_remote", error.message, error.fix)
  }
  if (!origin.value.includes(expected)) {
    const error = new RemoteMismatch({ repo, expected, actual: origin.value })
    return fail("expect_remote", error.message, error.fix)
  }
  return { name: "expect_remote", status: "ok", detail: `origin contains ${expected}` }
}

const remoteIdentityCheck = (options: {
  readonly repo: string
  readonly config: ZwtConfig
  readonly origin: Option.Option<string>
  readonly identityKey: string | undefined
  readonly email: string | undefined
}): Check => {
  const rules = options.config.remote
  if (rules === undefined || rules.length === 0) return { name: "remote_identity", status: "ok", detail: "no [[remote]]" }
  if (Option.isNone(options.origin)) return { name: "remote_identity", status: "ok", detail: "no origin" }
  const matched = matchingRemote(rules, options.origin.value)
  if (matched === undefined) return { name: "remote_identity", status: "ok", detail: "no matching [[remote]]" }
  const clash = remoteIdentityClash({
    config: options.config,
    origin: options.origin.value,
    identityKey: options.identityKey,
    email: options.email
  })
  if (clash === undefined) return { name: "remote_identity", status: "ok", detail: `origin requires ${matched.identity}` }
  const error = new RemoteIdentityMismatch({
    repo: options.repo,
    origin: options.origin.value,
    pattern: clash.pattern,
    required: clash.required,
    actual: clash.actual
  })
  return fail("remote_identity", error.message, error.fix)
}

const hooksCheck = (hooksPath: Option.Option<string>): Check =>
  Option.match(hooksPath, {
    onNone: () => ({ name: "hooksPath", status: "ok", detail: "git default" }),
    onSome: (value) => ({ name: "hooksPath", status: "warn", detail: value })
  })

const auditRepo = (options: {
  readonly repo: string
  readonly config: ZwtConfig
  readonly configFile: string
  readonly home: string
}) =>
  Effect.gen(function*() {
    const { config, configFile, home, repo } = options
    const git = yield* Git
    const resolution = resolveIdentity({ config, repoRoot: repo, home, flags: blankFlags })
    const actual = Option.getOrElse(yield* git.configGet("user.email", repo), () => "")
    const expectedRemote = resolveExpectRemote({ config, repoRoot: repo, home })
    const hasRemoteRules = (config.remote?.length ?? 0) > 0
    const origin = expectedRemote === undefined && !hasRemoteRules ? Option.none<string>() : yield* git.originUrl(repo)
    const hooksPath = yield* git.configGet("core.hooksPath", repo)
    const identityKey = resolution._tag === "Resolved"
      ? resolveIdentityKey({ config, repoRoot: repo, home, flags: blankFlags })
      : undefined
    const checks = [
      identityCheck({ repo, file: configFile, resolution, actual }),
      remoteCheck(repo, expectedRemote, origin),
      remoteIdentityCheck({
        repo,
        config,
        origin,
        identityKey,
        email: resolution._tag === "Resolved" ? resolution.identity.email : undefined
      }),
      hooksCheck(hooksPath)
    ]
    return {
      repo,
      currentEmail: actual.length === 0 ? "(unset)" : actual,
      expectedEmail: resolution._tag === "Resolved" ? resolution.identity.email : "(unresolved)",
      status: overall(checks),
      checks
    } satisfies RepoReport
  })

const missingRepo = (path: string, file: string): RepoReport => {
  const error = new NotARepository({ path, file })
  const checks = [fail("repository", error.message, error.fix)]
  return { repo: path, currentEmail: "(unset)", expectedEmail: "(unresolved)", status: "fail", checks }
}

const collectRepos = (config: ZwtConfig, home: string, file: string) =>
  Effect.gen(function*() {
    const located = yield* configuredRepos(config, home)
    const reports: Array<RepoReport> = []
    for (const entry of located) {
      if (entry._tag === "Absent") {
        reports.push(missingRepo(entry.path, file))
        continue
      }
      reports.push(yield* auditRepo({ repo: entry.repo, config, configFile: file, home }))
    }
    return reports
  })

const renderCheck = (check: Check) => {
  const line = `${check.name} ${check.status} ${check.detail}`
  return check.fix === undefined ? line : `${line}\n  fix: ${check.fix}`
}

const renderTable = (reports: ReadonlyArray<RepoReport>) => {
  const header = "repo | current email | expected email | status"
  const rows = reports.map((report) => {
    const line = `${report.repo} | ${report.currentEmail} | ${report.expectedEmail} | ${report.status}`
    const fixes = report.checks.flatMap((check) => check.fix === undefined ? [] : [`  fix: ${check.fix}`])
    return fixes.length === 0 ? line : [line, ...fixes].join("\n")
  })
  return [header, ...rows].join("\n")
}

const checkJson = (check: Check) =>
  check.fix === undefined
    ? { name: check.name, status: check.status, detail: check.detail }
    : { name: check.name, status: check.status, detail: check.detail, fix: check.fix }

const repoJson = (report: RepoReport) => ({
  repo: report.repo,
  currentEmail: report.currentEmail,
  expectedEmail: report.expectedEmail,
  status: report.status,
  checks: report.checks.map(checkJson)
})

const renderReports = (reports: ReadonlyArray<RepoReport>, output: "text" | "json", all: boolean): string => {
  if (all) return output === "json" ? JSON.stringify({ repos: reports.map(repoJson) }, null, 2) : renderTable(reports)
  const report = reports[0]
  if (report === undefined) return ""
  return output === "json" ? JSON.stringify(repoJson(report), null, 2) : report.checks.map(renderCheck).join("\n")
}

const publish = (reports: ReadonlyArray<RepoReport>, output: "text" | "json", all: boolean) =>
  Effect.gen(function*() {
    yield* Console.log(renderReports(reports, output, all))
    const fixes = reports.flatMap((report) => report.checks.flatMap((check) => check.fix === undefined ? [] : [check.fix]))
    if (fixes.length > 0) return yield* new DoctorFailed({ failed: fixes.length, fixes })
  })

export const runDoctor = (options: {
  readonly all: boolean
  readonly output: "text" | "json"
  readonly path: Option.Option<string>
  readonly cwd: string
  readonly home: string
  readonly configFile: string
}) =>
  Effect.gen(function*() {
    const { configFile, cwd, home, output } = options
    const config = yield* Config
    if (options.all) {
      const loaded = yield* config.load(configFile)
      const reports = yield* collectRepos(loaded, home, configFile)
      return yield* publish(reports, output, true)
    }
    const git = yield* Git
    const start = Option.match(options.path, {
      onNone: () => cwd,
      onSome: (path) => normalizeFolder(path, cwd, home)
    })
    const repo = trimSlash(yield* git.repoRoot(start))
    const loaded = yield* config.load(configFile)
    const report = yield* auditRepo({ repo, config: loaded, configFile, home })
    return yield* publish([report], output, false)
  })
