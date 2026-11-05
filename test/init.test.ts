import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { initConfig } from "../src/commands/init.ts"
import { OverwriteRefused } from "../src/errors.ts"
import { gitdirToMatch, identityKeyBase, importIdentities, renderZwtToml, starterDrafts } from "../src/include-if.ts"
import { parseConfig } from "../src/services/Config.ts"
import { DryRunLog } from "../src/services/DryRun.ts"
import { dryRunFileSystem } from "../src/services/FileSystem.ts"
import { Prompt } from "../src/services/Prompt.ts"

const home = "/home/jane"
const file = "/home/jane/.config/zwt/zwt.toml"
const personal = "/home/jane/.config/git/personal"
const work = "/home/jane/.config/git/work"
const gitconfig = "/home/jane/.gitconfig"
const xdg = "/home/jane/.config/git/config"

const gitconfigText = [
  "[user]",
  "\tname = Global Jane",
  "\temail = global@example.com",
  "[includeIf \"gitdir:~/personal/\"]",
  "\tpath = ~/.config/git/personal",
  "[includeIf \"gitdir/i:~/work/\"]",
  "\tpath = \"~/.config/git/work\" # office",
  "[include]",
  "\tpath = ~/.config/git/extra"
].join("\n")

const personalText = ["[user]", "\tname = Jane Doe", "\temail = jane@example.com"].join("\n")
const workText = ["[user]", "\tname = Jane Doe", "\temail = jane.doe@example.com"].join("\n")
const extraText = ["[includeIf \"gitdir:~/personal/notes/\"]", "\tpath = ~/.config/git/notes"].join("\n")
const notesText = ["[user]", "\tname = Jane Notes", "\temail = jane@example.com"].join("\n")

const tree = {
  [gitconfig]: gitconfigText,
  [personal]: personalText,
  [work]: workText,
  [`${home}/.config/git/extra`]: extraText,
  [`${home}/.config/git/notes`]: notesText
}

const memory = (initial: Readonly<Record<string, string>>) => {
  const files = new Map(Object.entries(initial))
  const writes: Array<{ readonly path: string; readonly data: string }> = []
  const layer = FileSystem.layerNoop({
    readFileString: (path) => {
      const text = files.get(path)
      return text === undefined
        ? Effect.fail(PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: path
        }))
        : Effect.succeed(text)
    },
    writeFileString: (path, data) => Effect.sync(() => {
      files.set(path, data)
      writes.push({ path, data })
    }),
    makeDirectory: () => Effect.void
  })
  return { files, writes, layer }
}

const run = (files: ReturnType<typeof memory>, prompt = Prompt.scripted({ confirm: true })) =>
  Layer.mergeAll(prompt, files.layer)

const init = (overrides?: { readonly yes?: boolean; readonly interactive?: boolean; readonly xdg?: string }) =>
  initConfig({
    file,
    home,
    xdgConfigHome: overrides?.xdg,
    yes: overrides?.yes ?? false,
    interactive: overrides?.interactive ?? false
  })

describe("includeIf import", () => {
  it("derives a stable key from the email local-part, then the gitdir basename", () => {
    expect(identityKeyBase("jane.doe@example.com", "~/work/")).toBe("jane-doe")
    expect(identityKeyBase("Jane+Alias@example.com", "~/work/")).toBe("jane-alias")
    expect(identityKeyBase("---@example.com", "~/personal/")).toBe("personal")
    expect(identityKeyBase("---@example.com", "~/")).toBe("identity")
  })

  it("maps a gitdir path onto a profile match", () => {
    expect(gitdirToMatch("~/personal/")).toBe("~/personal/**")
    expect(gitdirToMatch("~/personal/**")).toBe("~/personal/**")
    expect(gitdirToMatch("/home/jane/personal/repo/.git")).toBe("/home/jane/personal/repo/**")
    expect(gitdirToMatch("~/work")).toBe("~/work/**")
  })

  it("imports includeIf identities and ignores the bare global user", () => {
    const imported = importIdentities(new Map(Object.entries(tree)), [xdg, gitconfig], home)
    expect(imported.map((identity) => identity.email)).toEqual([
      "jane@example.com",
      "jane.doe@example.com"
    ])
    expect(imported.map((identity) => identity.key)).toEqual(["jane", "jane-doe"])
    expect(imported[0]?.matches).toEqual(["~/personal/**", "~/personal/notes/**"])
    expect(imported[1]?.matches).toEqual(["~/work/**"])
    expect(imported.some((identity) => identity.email === "global@example.com")).toBe(false)
  })

  it("suffixes colliding keys", () => {
    const same = new Map<string, string>([
      [gitconfig, "[includeIf \"gitdir:~/personal/\"]\n\tpath = ~/.config/git/personal\n[includeIf \"gitdir:~/work/\"]\n\tpath = ~/.config/git/work\n"],
      [personal, "[user]\n\temail = jane@example.com\n\tname = Jane Doe\n"],
      [work, "[user]\n\temail = jane@example.org\n\tname = Jane Doe\n"]
    ])
    const imported = importIdentities(same, [gitconfig], home)
    expect(imported.map((identity) => identity.key)).toEqual(["jane", "jane-2"])
  })

  it.effect("renders a file zwt config check accepts", () =>
    Effect.gen(function*() {
      const source = renderZwtToml(importIdentities(new Map(Object.entries(tree)), [gitconfig], home))
      const config = yield* parseConfig(file, source)
      expect(config.version).toBe(1)
      expect(config.identity.jane?.email).toBe("jane@example.com")
      expect(config.identity["jane-doe"]?.email).toBe("jane.doe@example.com")
      expect(config.profile?.map((profile) => profile.match)).toEqual(["~/personal/**", "~/personal/notes/**", "~/work/**"])
      const starter = yield* parseConfig(file, renderZwtToml(starterDrafts))
      expect(starter.identity.personal?.email).toBe("jane@example.com")
      expect(starter.profile?.[0]?.match).toBe("~/personal/**")
    }))
})

describe("zwt init", () => {
  it("does not branch on the dry-run flag", () => {
    const text = readFileSync(new URL("../src/commands/init.ts", import.meta.url), "utf8")
    expect(text.includes("DryRun")).toBe(false)
    expect(text.includes("dry-run")).toBe(false)
    expect(text.includes("dryRun")).toBe(false)
    expect(text.includes("--global")).toBe(false)
  })

  it.effect("writes imported identities without a prompt when non-interactive", () => {
    const files = memory(tree)
    return Effect.gen(function*() {
      const result = yield* init()
      expect(result).toEqual({ _tag: "Imported", file, count: 2 })
      expect(files.writes.map((write) => write.path)).toEqual([file])
      const config = yield* parseConfig(file, files.writes[0]?.data ?? "")
      expect(Object.keys(config.identity)).toEqual(["jane", "jane-doe"])
      expect(files.files.get(gitconfig)).toBe(gitconfigText)
    }).pipe(Effect.provide(run(files, Prompt.scripted({}))))
  })

  it.effect("writes the personal starter when no includeIf identity exists", () => {
    const files = memory({ [gitconfig]: "[user]\n\temail = global@example.com\n" })
    return Effect.gen(function*() {
      const result = yield* init()
      expect(result).toEqual({ _tag: "Starter", file })
      expect(files.writes[0]?.data).toBe(renderZwtToml(starterDrafts))
      expect(yield* parseConfig(file, files.writes[0]?.data ?? "")).toMatchObject({
        identity: { personal: { email: "jane@example.com" } }
      })
    }).pipe(Effect.provide(run(files)))
  })

  it.effect("refuses to overwrite when the scripted answer is no", () => {
    const files = memory({ ...tree, [file]: "version = 1\n" })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(init({ interactive: true }))
      if (!(error instanceof OverwriteRefused)) return yield* Effect.die(error)
      expect(error.fix).toContain("--yes")
      expect(files.writes).toEqual([])
      expect(files.files.get(file)).toBe("version = 1\n")
    }).pipe(Effect.provide(run(files, Prompt.scripted({}))))
  })

  it.effect("refuses to overwrite without a terminal", () => {
    const files = memory({ ...tree, [file]: "keep\n" })
    const prompt = Layer.succeed(Prompt, {
      confirm: () => Effect.die("prompted in non-interactive mode"),
      select: () => Effect.die("prompted in non-interactive mode")
    })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(init({ interactive: false }))
      if (!(error instanceof OverwriteRefused)) return yield* Effect.die(error)
      expect(error.message).toContain(file)
      expect(files.writes).toEqual([])
    }).pipe(Effect.provide(run(files, prompt)))
  })

  it.effect("does not write when the import is declined", () => {
    const files = memory(tree)
    return Effect.gen(function*() {
      const result = yield* init({ interactive: true })
      expect(result).toEqual({ _tag: "Declined", file })
      expect(files.writes).toEqual([])
    }).pipe(Effect.provide(run(files, Prompt.scripted({ confirm: false }))))
  })

  it.effect("--yes overwrites without prompting", () => {
    const files = memory({ ...tree, [file]: "old\n" })
    const prompt = Layer.succeed(Prompt, {
      confirm: () => Effect.die("prompted with --yes"),
      select: () => Effect.die("prompted with --yes")
    })
    return Effect.gen(function*() {
      const result = yield* init({ yes: true, interactive: true })
      expect(result._tag).toBe("Imported")
      expect(files.writes[0]?.data).toContain("jane@example.com")
      expect(files.files.get(gitconfig)).toBe(gitconfigText)
    }).pipe(Effect.provide(run(files, prompt)))
  })

  it.effect("dry-run records the zwt.toml write and leaves the file untouched", () => {
    const files = memory(tree)
    const layer = Layer.mergeAll(Prompt.scripted({}), dryRunFileSystem).pipe(
      Layer.provideMerge(DryRunLog.layer),
      Layer.provide(FileSystem.layerNoop({
        readFileString: (path) => {
          const text = files.files.get(path)
          return text === undefined
            ? Effect.fail(PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path
            }))
            : Effect.succeed(text)
        },
        writeFileString: () => Effect.die("real write during dry-run"),
        makeDirectory: () => Effect.die("real mkdir during dry-run")
      }))
    )
    return Effect.gen(function*() {
      const result = yield* init()
      expect(result).toEqual({ _tag: "Imported", file, count: 2 })
      expect(files.writes).toEqual([])
      expect(files.files.has(file)).toBe(false)
      const planned = yield* (yield* DryRunLog).planned
      expect(planned).toContainEqual({ kind: "fs", description: `mkdir ${file.slice(0, file.lastIndexOf("/"))}` })
      expect(planned).toContainEqual({ kind: "fs", description: `write ${file}` })
    }).pipe(Effect.provide(layer))
  })
})
