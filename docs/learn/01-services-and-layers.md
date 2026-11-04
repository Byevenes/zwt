# 01. Servicios, Layers y errores tipados

Nota del slice 1 (#17, #20). Explica las cuatro ideas de Effect que usa zwt, apuntando al código real.

## 1. Un servicio es una interfaz con nombre

`Context.Service` define *qué* sabe hacer algo, sin decir *cómo*. Mira `src/services/Git.ts`:

```ts
export class Git extends Context.Service<Git, GitShape>()("zwt/Git") {}
```

Un comando nunca llama a `git` directo. Pide el servicio:

```ts
const git = yield* Git
yield* git.requireBranch("main", repo)
```

El tipo del efecto anota que necesita `Git`. Si nadie lo entrega, TypeScript no compila.

## 2. Un Layer es una implementación del servicio

El mismo `Git` tiene tres Layers:

| Layer | Dónde | Qué hace |
| --- | --- | --- |
| `Git.live` | `src/services/Git.ts` | corre `git` de verdad, sin variables `GIT_*` heredadas |
| `Git.dryRun` | `src/services/Git.ts` | lee con git real, pero las escrituras solo se anotan |
| `Git.fake(...)` | `src/services/Git.ts` | respuestas fijas para tests, sin procesos |

Se elige con `Effect.provide(layer)`. El comando no cambia.

## 3. `Effect.gen` es async/await para Effect

`yield*` es como `await`: saca el valor de un efecto o corta con su error. Ejemplo en `parseConfig` (`src/services/Config.ts`): parsea el TOML, valida con Schema y, si algo falla, `return yield* new ConfigInvalid(...)` corta el flujo con un error tipado.

## 4. Errores tipados con `Data.TaggedError`

En `src/errors.ts` cada error es una clase con `_tag`, datos, `message` y `fix`:

```ts
export class BranchNotFound extends Data.TaggedError("BranchNotFound")<{ branch: string; repo: string }> {
  get fix() { return `git -C ${this.repo} fetch origin ${this.branch}` }
}
```

El tipo del efecto lista los errores posibles (`Effect<void, BranchNotFound | GitCommandFailed>`). `src/main.ts` los atrapa y los imprime como `error:` + `fix:`.

## Cómo `--dry-run` cambia un Layer

`src/cli.ts` declara `--dry-run` como `GlobalFlag.Setting`. Al correr un comando, `services` lee el flag y entrega uno de dos grupos de Layers:

```ts
export const services = Layer.unwrap(
  Effect.gen(function*() {
    return (yield* DryRun) ? dryRunServices : liveServices
  })
)
```

En `dryRunServices`, `Git.dryRun` y `dryRunFileSystem` (`src/services/FileSystem.ts`) anotan cada escritura en `DryRunLog` en vez de ejecutarla, y al final se imprime el plan. El test `test/dry-run.test.ts` lo demuestra: el FileSystem de abajo muere si alguien escribe de verdad, y el test pasa igual.

## Para practicar

1. Agrega un método `currentBranch` a `GitShape` y mira qué Layers dejan de compilar.
2. Escribe un test con `Git.fake` que devuelva `BranchNotFound` y revisa el `fix`.
