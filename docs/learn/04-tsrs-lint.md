# 04. `tsrs --lint` en CI

Nota de #31. Qué mostró correr el linter con tipos sobre `src/` y `test/`, y qué quedó en el workflow.

## El comando

`tsrs --lint` es el backend de tipos de Oxlint (`oxlint --type-aware`). zwt lo corre con el binario de Effect, que registra esas reglas sobre `tsrs --lint`. No hace falta instalar `tsrs` aparte, ni cambiar el TypeScript del repo: el linter lee el `tsconfig.json` actual (7.0.2).

```sh
bun run lint
# effect-tsgo --tsrs-lint oxlint --type-aware --deny-warnings src test
```

CI usa `@effect/tsgo` 0.67.4 y `oxlint` 1.91.0. Esa pareja publica el binario de linux y acepta `--tsrs-lint`. `@effect/tsgo` 0.67.5 no publica el paquete de plataforma, así que el pin se queda en 0.67.4 (su `tsrs` es 0.22, alineado con TypeScript 7.1 beta).

## Qué salió en este repo

Sobre los 28 archivos de `src/` y `test/`:

- El conjunto type-aware por defecto: 0 avisos, unas decenas de milisegundos.
- El preset `recommended` de `@effect/tsgo`: 256 avisos. 241 son `unstable-api-usage` en `effect/cli`, `FileSystem`, `@effect/platform-bun` y `@effect/vitest`. Esas son las APIs que zwt usa (decisión D1 en #16). El preset `correctness` repite ese aviso y agrega uno concreto: el campo `name` de `UnknownIdentity` tapa el `name` del error (`src/errors.ts`).

El paso de CI usa el conjunto por defecto y `--deny-warnings`, así un aviso nuevo falla el job. El preset de Effect queda para cuando `unstable-api-usage` deje de marcar toda la superficie de `effect/cli`.
