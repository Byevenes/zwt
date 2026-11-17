# Notas de aprendizaje

Una nota por slice del MVP (#20). Cada una explica la idea de Effect o de git que usó ese slice, apuntando al código real, y termina con ejercicios.

| Nota | Slice / PRs | Tema |
| --- | --- | --- |
| [01](01-services-and-layers.md) | slice 1 (#30) | servicios, Layers, `Effect.gen`, errores tipados, `--dry-run` |
| [02](02-schema-and-config.md) | slice 2 (#33) | Schema y `zwt.toml` portable |
| [03](03-prompt-and-worktree-config.md) | slice 3 (#35, #36) | Prompt y config por worktree |
| [04](04-tsrs-lint.md) | #40, #41 | linter con tipos en CI |
| [05](05-exit-codes-and-option.md) | #37, #38, #42, #48 | códigos de salida de git como `Option` |
| [06](06-refusals-as-errors.md) | #43, #46, #47 | guardas antes de borrar |
| [07](07-action-log-and-tap.md) | #44 | registro de acciones, `tap`, `provideMerge` |
| [08](08-testing-with-effect-vitest.md) | todos | tests con fakes y git real, `effect/cli` |

La retro del MVP está en [`../retro.md`](../retro.md).

## Sesión guiada

Pendiente (criterio de #20). Orden sugerido para recorrer el código: `src/main.ts` → `src/cli.ts` (nota 01) → `src/services/Git.ts` (notas 01, 05, 07) → `src/commands/new.ts` (notas 02, 03) → `src/commands/worktrees.ts` (nota 06) → un par de tests (nota 08). Cada parada termina con los ejercicios de su nota.
