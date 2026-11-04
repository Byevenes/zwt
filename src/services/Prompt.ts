import { Context, Effect, Layer } from "effect"
import { Prompt as CliPrompt } from "effect/cli"

export class Prompt extends Context.Service<Prompt, {
  readonly confirm: (message: string) => Effect.Effect<boolean>
  readonly select: (message: string, choices: ReadonlyArray<string>) => Effect.Effect<string>
}>()("zwt/Prompt") {
  static readonly live = Layer.effect(
    Prompt,
    Effect.gen(function*() {
      const environment = yield* Effect.context<CliPrompt.Environment>()
      const run = <A>(prompt: CliPrompt.Prompt<A>) =>
        CliPrompt.run(prompt).pipe(Effect.provideContext(environment), Effect.orDie)
      return {
        confirm: (message) => run(CliPrompt.Confirm({ message })),
        select: (message, choices) =>
          run(CliPrompt.Select({ message, choices: choices.map((value) => ({ title: value, value })) }))
      }
    })
  )

  static readonly scripted = (answers: { readonly confirm?: boolean; readonly select?: string }) =>
    Layer.succeed(Prompt, {
      confirm: () => Effect.succeed(answers.confirm ?? false),
      select: (_message, choices) => Effect.succeed(answers.select ?? choices[0] ?? "")
    })
}
