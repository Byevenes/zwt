# 05. Códigos de salida de git como `Option` y errores de dominio

Nota de #37, #38, #42 y #48 (`doctor`, `remote`, `status`, `sync`). Cómo zwt convierte un `git` que "falla" en un valor normal.

## 1. No todo exit distinto de 0 es un error

Muchos comandos de git usan el código de salida como respuesta:

| Comando | Exit | Significa |
| --- | --- | --- |
| `git config --get key` | 1 | la clave no existe |
| `git rev-parse --verify --quiet ref` | 1 | el ref no existe |
| `git merge-base --is-ancestor a b` | 1 | `a` no es ancestro de `b` |
| `git remote get-url origin` | 2 | no hay `origin` |
| `git rev-list ...`, `git log -1` | 128 | no hay commits o el ref no resuelve |

Si eso subiera como `GitCommandFailed`, cada comando tendría que repetir el mismo `if`.

## 2. `Effect.catchIf` traduce en un solo lugar

`fromRunner` en `src/services/Git.ts` atrapa solo el código que significa "no hay":

```ts
configGet: (key, cwd) =>
  read(["config", "--get", key], cwd).pipe(
    Effect.map(Option.some),
    Effect.catchIf((error) => error.exitCode === 1, () => Effect.succeed(Option.none()))
  ),
```

- El predicado mira el error. Si no calza, el error sigue igual por el canal de errores.
- El tipo de vuelta es `Effect<Option<string>, GitCommandFailed>`. Quien llama distingue "no hay valor" (`Option.none()`) de "git se cayó" (el error).

Hay tres formas de traducir, según lo que el llamador necesita:

- `Option.none()` cuando la ausencia es normal (`configGet`, `originUrl`, `commitOf`).
- `false` cuando la pregunta es sí o no (`refExists`, `isAncestor`).
- un error de dominio cuando la ausencia impide seguir: `requireBranch` cambia el exit 1 por `BranchNotFound`, que trae su `fix`.

## 3. `Option` en vez de `undefined`

`Option.match`, `Option.getOrElse` y `Option.isSome` obligan a tratar el caso vacío. `status` usa `aheadBehind` y `committerUnix`, que devuelven `Option`. Un worktree sin commits sale como fila con guion y no rompe la tabla.

## 4. Un `switch` exhaustivo para los estados

`src/commands/sync.ts` declara los estados como tupla `as const` y deriva el tipo:

```ts
export const syncStatuses = ["fast-forward", "up-to-date", "ahead", /* ... */] as const
export type SyncStatus = (typeof syncStatuses)[number]
```

`isBlocking` termina con `const exhaustive: never = status`. Si alguien agrega un estado y no decide si bloquea, TypeScript no compila.

## Para practicar

1. Cambia el `exitCode === 1` de `isAncestor` por `=== 2` y corre `bun run test`. Mira qué test de `worktrees` falla y por qué.
2. Agrega un estado a `syncStatuses` y lee el error de tipos en `isBlocking`.
