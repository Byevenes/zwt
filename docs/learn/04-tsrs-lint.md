# 04. oxlint con tipos (tsrs) en CI

Nota de #31. Qué mostró correr el linter con tipos sobre `src/` y `test/`, y qué quedó en el workflow.

## El comando

`oxlint --type-aware` usa `tsrs-lint` como backend de tipos. Oxlint 1.92.0 o más nuevo lo encuentra por sí solo cuando `tsrs` está instalado, y lo usa en vez de `oxlint-tsgolint`. `tsrs` está en `devDependencies` y es un port en Rust de TypeScript 7.1 beta. El `tsc` del repo sigue en 7.0.2.

```sh
bun run lint
# oxlint --type-aware --deny-warnings src test
```

Los pines son `oxlint` 1.94.0 y `tsrs` 7.1.0-beta.tsrs4.

`.oxlintrc.json` deja el conjunto correctness por defecto y pasa a error `typescript/no-floating-promises` y `typescript/no-misused-promises`. `options.typeAware` queda en `true`. Declara los tres `plugins` (`unicorn`, `typescript`, `oxc`) porque un `plugins` explícito reemplaza el conjunto base: con solo `typescript`, `oxlint --print-config` baja de 111 a 85 reglas. Con los tres quedan 112, las 111 de antes más `no-misused-promises`. `no-floating-promises` ya estaba en el conjunto por defecto como aviso y `--deny-warnings` ya lo hacía fallar; pasarlo a error cambia cómo se reporta, no si CI lo atrapa. La regla nueva es `no-misused-promises`.

Antes, el mismo paso usaba `effect-tsgo --tsrs-lint` con `@effect/tsgo` 0.67.4 y `oxlint` 1.91.0. Esa pareja publicaba el binario de linux y aceptaba `--tsrs-lint`. `@effect/tsgo` 0.67.5 no publicaba el paquete de plataforma, así que el pin se quedó en 0.67.4. Su `tsrs` era 0.22, alineado con TypeScript 7.1 beta.

## Qué salió en este repo

Cuando se escribió la nota (#31), con el setup anterior, sobre `src/` y `test/`:

- El conjunto type-aware por defecto dio 0 avisos.
- El preset `recommended` de `@effect/tsgo` dio 256 avisos. 241 son `unstable-api-usage` en `effect/cli`, `FileSystem`, `@effect/platform-bun` y `@effect/vitest`. Esas son las APIs que zwt usa (decisión D1 en #16). El preset `correctness` repite ese aviso y agrega uno concreto. El campo `name` de `UnknownIdentity` tapa el `name` del error en `src/errors.ts`.

CI usa el conjunto por defecto, con esas dos reglas de promesas en error, y `--deny-warnings`. Un aviso nuevo falla el job. El preset de Effect queda fuera. `unstable-api-usage` marcaba toda la superficie de `effect/cli`.

## Qué se pierde sin effect-tsgo

CI no pierde ningún chequeo que estuviera aplicando: los presets de Effect ya estaban fuera. Con el setup anterior, un `Effect.log(...)` suelto en `src/` pasaba `bun run lint` con exit 0.

Lo que se pierde es la opción de prenderlos sin volver a instalar `@effect/tsgo`: las reglas `effecttsgo`, como `floating-effect` (un Effect creado que nadie hace yield ni corre), y el resto de los presets. También sale del repo el language service de Effect que traía el paquete (`effect-tsgo diagnostics`, el `tsc` parchado), aunque `tsconfig.json` nunca lo configuró. `no-floating-promises` no atrapa un Effect suelto: un Effect no es una Promise.

## Por qué no `--type-check` todavía

Con las rutas `src test`, `--type-check` no mira `vitest.config.ts`. Ese archivo está fuera de esos directorios. Por eso no reemplaza `tsc --noEmit`. Además `tsrs` es TypeScript 7.1 beta y `tsc` es 7.0.2. Los dos pueden discrepar, y las reglas type-aware ya corren con la semántica de 7.1 beta. El README de `tsrs` (sección de Oxlint) lo dice: los archivos que Oxlint no lintea no se chequean, así que pide un chequeo de tipos aparte. `typecheck` y `lint` siguen como scripts separados.
