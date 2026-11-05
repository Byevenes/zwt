# 03. Prompt y la config del worktree

Nota del slice 3 (#2, y el selector que pide #1). Cómo zwt pregunta una identidad y cómo la deja en el worktree sin tocar la config global de git.

## 1. `Prompt` es otro servicio

`src/services/Prompt.ts` declara `confirm` y `select`. El comando no lee stdin.

| Layer | Qué hace |
| --- | --- |
| `Prompt.live` | usa los prompts de `effect/cli` |
| `Prompt.scripted({ confirm, select })` | responde fijo, para tests |

`canPrompt` es la regla de cuándo preguntar: stdin es una TTY y `CI` no está definida. Si no, el selector no corre.

## 2. Sin identidad, dos caminos

`newWorktree` llama a `resolveIdentity`. Si el resultado es `Unresolved`:

- terminal interactiva: `Prompt.select` lista las claves de `[identity.*]`. Después `Prompt.confirm` pregunta si guardar un `[[project]]` para esa carpeta. Decir que no igual usa la identidad en este `zwt new`.
- sin terminal: error `IdentityUnresolved`. El `fix` dice que el selector se saltó en modo no interactivo y nombra `zwt identity set`.

## 3. Dónde queda el email

Git guarda config de worktree solo si el repo común tiene `extensions.worktreeConfig=true`. zwt lo escribe con `git config --local` (nunca `--global`) y después, dentro del worktree nuevo:

```sh
git config --worktree user.name "Jane Doe"
git config --worktree user.email jane@example.com
```

Eso vive en `.git/worktrees/<name>/config.worktree`.

Verificar con `git config --get` no alcanza. Un worktree enlazado hereda el `user.email` local del repo, así que el valor puede coincidir aunque la escritura haya fallado. zwt también lee `git config --show-origin`. El archivo tiene que ser `config.worktree`. Si no, el error es `IdentityMismatch`.

## 4. `--dry-run`

`configSet` pasa por el runner `write` de `Git`, igual que `worktree add`. En dry-run la escritura se anota y no se ejecuta. La lectura siguiente ve ese valor anotado, así el chequeo puede pasar sin crear el worktree. `identity set` anota el `write` del toml y no toca el archivo.

## Para practicar

1. Crea un worktree con `zwt new` y compara `git config --show-origin --get user.email` ahí y en el repo principal.
2. Corre `zwt identity check` en los dos directorios y mira qué línea cambia.
