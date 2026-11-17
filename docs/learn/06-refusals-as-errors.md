# 06. Negarse antes de escribir: guardas como errores tipados

Nota de #43, #46 y #47 (`new` con ticket, `open`, `list`/`prune`/`rm`). Cómo un comando que borra decide no hacerlo.

## 1. Primero se lee, después se escribe

`removeWorktreeBySlug` (`src/commands/worktrees.ts`) junta todo lo que sabe del worktree antes de llamar a `git worktree remove`. Cada guarda corta con un error propio:

```ts
if (target.current) return yield* new WorktreeCurrent({ path: target.path })
if (target.locked) return yield* new WorktreeLocked({ path: target.path })
if (!force) {
  if (target.dirty) return yield* new WorktreeDirty({ path: target.path, slug })
  // ...WorktreeUnmerged si la rama no está en la base
}
yield* git.removeWorktree(repo, target.path, force)
```

`return yield* new X(...)` funciona porque un `Data.TaggedError` también es un efecto que falla. El `return` le dice a TypeScript que el flujo termina ahí.

## 2. El orden de las guardas es una decisión

`--force` salta "sucio" y "sin fusionar", pero no salta `MainWorktree`, `WorktreeCurrent` ni `WorktreeLocked`. Esas tres no tienen arreglo con fuerza: borrar el checkout principal o el directorio donde estás no tiene vuelta.

`WorktreeMissing` cubre otro caso: si el directorio ya no existe, zwt no puede probar que estaba limpio, así que no lo da por limpio y propone `git worktree prune`.

## 3. Por defecto, no borrar

`zwt prune` sin `--merged` falla con `PruneNeedsMerged`. El comando más corto no tiene que ser el que borra.

## 4. El `fix` es parte del contrato

Cada error trae el comando que lo arregla (`zwt rm <slug> --force`, `git worktree unlock <path>`). Los tests lo revisan:

```ts
const error = yield* Effect.flip(effect)
expect(error._tag).toBe("PruneNeedsMerged")
expect(fake.calls).toEqual([])
```

`Effect.flip` cambia éxito por error, así el test lee el error como un valor. `fake.calls` vacío prueba que no se escribió nada.

## Para practicar

1. Mueve la guarda de `target.locked` dentro del `if (!force)` y escribe el test que debería fallar.
2. Corre `zwt rm <slug> --dry-run` sobre un worktree sucio y compara la salida con la del mismo comando sin `--dry-run`.
