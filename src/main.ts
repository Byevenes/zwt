#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { run } from "./cli.ts"
import { isZwtError, render } from "./errors.ts"

run.pipe(
  Effect.catchIf(isZwtError, (error) =>
    Console.error(render(error)).pipe(Effect.andThen(Effect.sync(() => {
      process.exitCode = 1
    })))),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
