# 07. Registro de acciones: `tap`, `tapError` y Layers que dependen de Layers

Nota de #44 (`zwt log`). Cómo zwt anota cada escritura real sin tocar los comandos.

## 1. El registro va en el Layer, no en el comando

`Git.logging` (`src/services/Git.ts`) usa el mismo `exec` que `Git.live`, pero envuelve solo el runner de escritura:

```ts
const write: GitShape["run"] = (args, cwd) => {
  const command = `git -C ${cwd} ${args.join(" ")}`
  return exec(args, cwd).pipe(
    Effect.tap(() => actions.record({ command, result: "ok" })),
    Effect.tapError((error) => actions.record({ command, result: actionResult(error) }))
  )
}
return fromRunner(exec, write)
```

- `Effect.tap` corre algo con el resultado y devuelve el resultado original.
- `Effect.tapError` hace lo mismo con el error, y el error sigue su camino.
- Las lecturas pasan por `exec` sin envolver, así que `zwt log` muestra escrituras y no ruido.

`loggingFileSystem` hace lo mismo para archivos. Ningún comando sabe que existe un log.

## 2. Un fallo del log no tapa el error real

`ActionLog.record` termina en `Effect.catch` y escribe un aviso en stderr. Su tipo es `Effect<void>`, sin errores. Si el disco está lleno, el usuario igual ve el error de git y no uno del log.

`entries`, en cambio, sí falla con `ActionLogUnreadable`: `zwt log` existe para leer ese archivo, así que ahí el error importa.

## 3. Escritura atómica y tope de tamaño

`writeAtomic` escribe a un `.tmp` y hace `rename`. Si el proceso muere a la mitad, el log anterior queda entero. `appendCapped` (`src/action-log.ts`) descarta las entradas más viejas cuando se pasa de `maxActionLogBytes`.

## 4. `Layer.provideMerge`

`src/cli.ts` arma los servicios así:

```ts
const liveServices = Layer.mergeAll(Git.logging, Config.live, Prompt.live, Launch.live, DryRunLog.layer).pipe(
  Layer.provideMerge(loggingFileSystem),
  Layer.provideMerge(ActionLog.live)
)
```

`Git.logging` necesita `ActionLog`. `provideMerge` se lo entrega y además deja `ActionLog` disponible para `zwt log`. Con `Layer.provide` el servicio quedaría escondido.

En dry-run no hay escrituras reales, así que el log no recibe nada: las escrituras van a `DryRunLog` (nota 01).

## Para practicar

1. Cambia `provideMerge(ActionLog.live)` por `provide(ActionLog.live)` y lee qué comando deja de compilar.
2. Corre `zwt new demo`, después `zwt log`, y compara las líneas con lo que muestra `zwt new demo --dry-run`.
