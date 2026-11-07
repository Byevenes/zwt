import { Effect } from "effect"
import { expandHome, profileRoot } from "./resolve.ts"
import type { ZwtConfig } from "./services/Config.ts"
import { Git } from "./services/Git.ts"

const trimSlash = (path: string) => path.replace(/\/+$/, "")

export type ConfiguredRepo =
  | { readonly _tag: "Present"; readonly repo: string }
  | { readonly _tag: "Absent"; readonly path: string }

/**
 * Same roots as `zwt doctor --all`.
 * A `[[project]]` path is always a row: its git toplevel, or `Absent` when it is not a repository.
 * A profile match root is a row only when `rev-parse --show-toplevel` is that path itself.
 */
export const configuredRepos = (config: ZwtConfig, home: string) =>
  Effect.gen(function*() {
    const git = yield* Git
    const seen = new Set<string>()
    const repos: Array<ConfiguredRepo> = []
    const remember = (path: string) => {
      if (seen.has(path)) return false
      seen.add(path)
      return true
    }

    for (const project of config.project ?? []) {
      const path = trimSlash(expandHome(project.path, home))
      const located = yield* git.repoRoot(path).pipe(
        Effect.map((root) => trimSlash(root)),
        Effect.catchIf((error) => error.exitCode === 128, () => Effect.succeed(undefined))
      )
      if (located === undefined) {
        if (remember(path)) repos.push({ _tag: "Absent", path })
        continue
      }
      if (!remember(located)) continue
      repos.push({ _tag: "Present", repo: located })
    }

    for (const profile of config.profile ?? []) {
      const root = profileRoot(profile.match, home)
      if (seen.has(root)) continue
      const toplevel = yield* git.repoRoot(root).pipe(
        Effect.map((found) => trimSlash(found)),
        Effect.catchIf((error) => error.exitCode === 128, () => Effect.succeed(undefined))
      )
      if (toplevel !== root || !remember(root)) continue
      repos.push({ _tag: "Present", repo: root })
    }

    return repos
  })
