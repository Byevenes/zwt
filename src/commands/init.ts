import { Effect, FileSystem, Option } from "effect"
import { OverwriteRefused } from "../errors.ts"
import {
  globalGitConfigCandidates,
  importIdentities,
  includePaths,
  renderZwtToml,
  starterDrafts,
  type IdentityDraft
} from "../include-if.ts"
import { parseConfig } from "../services/Config.ts"
import { Prompt } from "../services/Prompt.ts"

export type InitResult =
  | { readonly _tag: "Imported"; readonly file: string; readonly count: number }
  | { readonly _tag: "Starter"; readonly file: string }
  | { readonly _tag: "Declined"; readonly file: string }

const readOptional = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none<string>())
      )
    )
  })

const loadGitConfigs = (roots: ReadonlyArray<string>, home: string) =>
  Effect.gen(function*() {
    const files = new Map<string, string>()
    const pending = [...roots]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const file = pending.shift()
      if (file === undefined || seen.has(file)) continue
      seen.add(file)
      const text = yield* readOptional(file)
      if (Option.isNone(text)) continue
      files.set(file, text.value)
      for (const path of includePaths(text.value, file, home)) pending.push(path)
    }
    return files
  })

const draftsOf = (imported: ReadonlyArray<IdentityDraft>): { readonly drafts: ReadonlyArray<IdentityDraft>; readonly imported: boolean } =>
  imported.length > 0 ? { drafts: imported, imported: true } : { drafts: starterDrafts, imported: false }

/** Write `zwt.toml` from includeIf gitdir identities. Never edits git config. */
export const initConfig = (options: {
  readonly file: string
  readonly home: string
  readonly xdgConfigHome: string | undefined
  readonly yes: boolean
  readonly interactive: boolean
}) =>
  Effect.gen(function*() {
    const { file, home, interactive, xdgConfigHome, yes } = options
    const fs = yield* FileSystem.FileSystem
    const existing = yield* readOptional(file)
    if (Option.isSome(existing) && !yes) {
      const overwrite = interactive ? yield* (yield* Prompt).confirm(`Overwrite ${file}?`) : false
      if (!overwrite) return yield* new OverwriteRefused({ file })
    }

    const roots = globalGitConfigCandidates(home, xdgConfigHome)
    const imported = importIdentities(yield* loadGitConfigs(roots, home), roots, home)
    const chosen = draftsOf(imported)
    if (interactive && !yes) {
      const count = imported.length
      const message = chosen.imported
        ? `Import ${count} includeIf ${count === 1 ? "identity" : "identities"} into ${file}?`
        : `No includeIf identities found. Write a starter config to ${file}?`
      const accepted = yield* (yield* Prompt).confirm(message)
      if (!accepted) return { _tag: "Declined", file } satisfies InitResult
    }

    const source = renderZwtToml(chosen.drafts)
    yield* parseConfig(file, source)
    const slash = file.lastIndexOf("/")
    if (slash > 0) yield* fs.makeDirectory(file.slice(0, slash), { recursive: true })
    yield* fs.writeFileString(file, source)
    return chosen.imported
      ? { _tag: "Imported", file, count: chosen.drafts.length } satisfies InitResult
      : { _tag: "Starter", file } satisfies InitResult
  })
