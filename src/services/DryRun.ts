import { Context, Effect, Layer, Ref } from "effect"

export interface PlannedWrite {
  readonly kind: "git" | "fs"
  readonly description: string
}

export class DryRunLog extends Context.Service<DryRunLog, {
  readonly record: (write: PlannedWrite) => Effect.Effect<void>
  readonly planned: Effect.Effect<ReadonlyArray<PlannedWrite>>
}>()("zwt/DryRunLog") {
  static readonly layer = Layer.effect(
    DryRunLog,
    Effect.gen(function*() {
      const ref = yield* Ref.make<ReadonlyArray<PlannedWrite>>([])
      return {
        record: (write) => Ref.update(ref, (all) => [...all, write]),
        planned: Ref.get(ref)
      }
    })
  )
}

export const renderPlan = (writes: ReadonlyArray<PlannedWrite>): string =>
  writes.length === 0
    ? "dry-run: nothing to write"
    : ["dry-run: planned writes", ...writes.map((w) => `  [${w.kind}] ${w.description}`)].join("\n")
