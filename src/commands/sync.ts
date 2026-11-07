import { Effect, Option } from "effect"
import { NotARepository, SyncFailed } from "../errors.ts"
import { configuredRepos } from "../repos.ts"
import { resolveBase } from "../resolve.ts"
import { Config } from "../services/Config.ts"
import { Git } from "../services/Git.ts"

export const syncStatuses = [
  "fast-forward",
  "up-to-date",
  "ahead",
  "diverged",
  "checked-out",
  "missing",
  "no-remote",
  "fetch-failed",
  "not-a-repo"
] as const

export type SyncStatus = (typeof syncStatuses)[number]

export interface SyncRow {
  readonly repo: string
  readonly base: string
  readonly status: SyncStatus
  readonly detail: string
  readonly fix?: string
}

const oneLine = (text: string) => text.trim().replace(/\s+/g, " ")

const short = (oid: string) => oid.slice(0, 7)

const row = (
  repo: string,
  base: string,
  status: SyncStatus,
  detail: string,
  fix?: string
): SyncRow => (fix === undefined ? { repo, base, status, detail } : { repo, base, status, detail, fix })

/** Statuses that mean the base ref was not brought in line with origin. */
export const isBlocking = (status: SyncStatus): boolean => {
  switch (status) {
    case "fast-forward":
    case "up-to-date":
    case "ahead":
    case "checked-out":
      return false
    case "diverged":
    case "missing":
    case "no-remote":
    case "fetch-failed":
    case "not-a-repo":
      return true
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

export const syncFailure = (rows: ReadonlyArray<SyncRow>): SyncFailed | undefined => {
  const problems = rows.filter((entry) => isBlocking(entry.status))
  if (problems.length === 0) return undefined
  return new SyncFailed({
    failed: problems.length,
    fixes: problems.map((entry) => entry.fix ?? `${entry.repo}: ${entry.detail}`)
  })
}

export const renderSyncTable = (rows: ReadonlyArray<SyncRow>): string => {
  const header = "repo | base | status | detail"
  const lines = rows.flatMap((entry) => {
    const line = `${entry.repo} | ${entry.base} | ${entry.status} | ${entry.detail}`
    return entry.fix === undefined ? [line] : [line, `  fix: ${entry.fix}`]
  })
  return [header, ...lines].join("\n")
}

const originRef = (base: string) => `refs/remotes/origin/${base}`

/**
 * Fetch `origin/<base>` and fast-forward the local base ref.
 * A checked-out base is left alone, so the working tree and local edits stay put.
 * Diverged and ahead refs are reported; nothing is merged or reset.
 */
export const syncRepos = (options: { readonly home: string; readonly configFile: string }) =>
  Effect.gen(function*() {
    const { configFile, home } = options
    const config = yield* (yield* Config).load(configFile)
    const located = yield* configuredRepos(config, home)
    const git = yield* Git
    const rows: Array<SyncRow> = []

    for (const entry of located) {
      if (entry._tag === "Absent") {
        const error = new NotARepository({ path: entry.path, file: configFile })
        rows.push(row(entry.path, "-", "not-a-repo", "not a git repository", error.fix))
        continue
      }

      const repo = entry.repo
      const base = resolveBase({ config, repoRoot: repo, home })
      if (!(yield* git.hasRemote("origin", repo))) {
        rows.push(row(repo, base, "no-remote", "no origin", `git -C ${repo} remote add origin <url>`))
        continue
      }

      const fetchError = yield* Effect.match(git.fetch("origin", base, repo), {
        onFailure: (error) => error,
        onSuccess: () => undefined
      })
      if (fetchError !== undefined) {
        const detail = oneLine(fetchError.stderr)
        rows.push(row(
          repo,
          base,
          "fetch-failed",
          detail.length === 0 ? `git fetch origin ${base} failed` : detail,
          `git -C ${repo} fetch origin ${base}`
        ))
        continue
      }

      const remote = yield* git.commitOf(originRef(base), repo)
      if (Option.isNone(remote)) {
        rows.push(row(
          repo,
          base,
          "missing",
          `origin/${base} does not exist`,
          `set base_branch for ${repo} in ${configFile} to a branch that exists on origin`
        ))
        continue
      }

      const local = yield* git.commitOf(`refs/heads/${base}`, repo)
      if (Option.isNone(local)) {
        rows.push(row(
          repo,
          base,
          "missing",
          `local ${base} does not exist`,
          `git -C ${repo} branch ${base} origin/${base}`
        ))
        continue
      }

      if (local.value === remote.value) {
        rows.push(row(repo, base, "up-to-date", short(local.value)))
        continue
      }

      if (yield* git.isAncestor(local.value, remote.value, repo)) {
        const checkout = yield* git.worktreeForBranch(base, repo)
        if (Option.isSome(checkout)) {
          rows.push(row(
            repo,
            base,
            "checked-out",
            `origin/${base} fetched; checked out at ${checkout.value}; local ${base} left unchanged`
          ))
          continue
        }
        const updateError = yield* Effect.match(git.fastForwardBranch(base, originRef(base), repo), {
          onFailure: (error) => error,
          onSuccess: () => undefined
        })
        if (updateError !== undefined) {
          const detail = oneLine(updateError.stderr)
          if (detail.includes("checked out")) {
            rows.push(row(repo, base, "checked-out", detail))
          } else {
            rows.push(row(
              repo,
              base,
              "fetch-failed",
              detail.length === 0 ? `fast-forward of ${base} failed` : detail,
              `git -C ${repo} fetch origin ${base}`
            ))
          }
          continue
        }
        rows.push(row(repo, base, "fast-forward", `${short(local.value)}..${short(remote.value)}`))
        continue
      }

      if (yield* git.isAncestor(remote.value, local.value, repo)) {
        rows.push(row(repo, base, "ahead", `local ${base} is ahead of origin/${base}`))
        continue
      }

      const compare = `git -C ${repo} log --oneline --left-right ${base}...origin/${base}`
      rows.push(row(
        repo,
        base,
        "diverged",
        `local ${base} and origin/${base} have diverged`,
        `reconcile ${base} in ${repo} by hand (${compare}); zwt does not merge or reset`
      ))
    }

    return rows
  })
