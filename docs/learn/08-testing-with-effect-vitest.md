# 08. Tests con `@effect/vitest`: fakes, repos temporales y `effect/cli`

Nota transversal de todos los slices. Cómo están armados los tests de `test/`.

## 1. `it.effect`

`it.effect("...", () => Effect.gen(...))` corre un efecto como test. Un error tipado que nadie atrapa hace fallar el test con su `_tag` y su mensaje.

## 2. Dos niveles de test

| Archivo | Git | Para qué |
| --- | --- | --- |
| `*.test.ts` | `Git.fake({...})` con salidas fijas por comando | reglas: qué se lee, qué se escribe, qué error sale |
| `*.integration.test.ts` | git real en un directorio temporal | que el comando de git escrito de verdad hace lo que creemos |

El fake guarda en `calls` cada comando que recibió, lectura o escritura. Un comando sin respuesta registrada falla con `GitCommandFailed` (exit 128, `fake git: no response`). Un test puede afirmar "no corrió git" con `expect(fake.calls).toEqual([])`, algo que con git real costaría mucho más.

Los integration tests existen porque un fake solo repite lo que uno cree que hace git.

## 3. Archivos sin disco

```ts
const configLayer = Config.live.pipe(
  Layer.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(source) }))
)
```

`FileSystem.layerNoop` implementa el FileSystem de Effect sin disco: el test reemplaza solo los métodos que el código debería usar.

## 4. Los comandos de `effect/cli`

`src/cli.ts` arma cada comando con `Command.make(nombre, { flags y argumentos }, handler)` y los agrupa con `Command.withSubcommands`. Los flags se escriben una vez (`Flag.Boolean`, `Flag.String`, `Flag.optional`, `Flag.withDefault`) y `--help` sale de `withDescription`. El handler recibe los valores ya tipados, así que la lógica vive en `src/commands/` y se prueba sin pasar por la CLI.

## Para practicar

1. Elige un test de `worktrees.test.ts` y escríbelo como integration test. Compara cuánto código pide cada uno.
2. Quita una respuesta del fake de un test y lee el error `fake git: no response`.
