# 04. Motherload: el tipo sale del archivo

Nota de #34 (decisión D2 en #16). `zwt.toml` de un usuario se sigue validando en runtime con Effect Schema. Motherload, los content mappers de TypeScript 7.1 (beta), solo tipa el config de ejemplo que viene en el repo y los fixtures de test. Se puede quitar sin cambiar qué acepta `parseConfig`.

## 1. El checker no lee el TOML solo

`tsc` no entiende `.toml`. Con `contentMappers` en `tsconfig.json` y `tsc --noEmit --runExternalCode`, TypeScript le pasa cada `.toml` importado a Motherload y recibe un módulo virtual. El tipo es el del archivo, como si llevara `as const`: literales, objetos `readonly` y arrays como tuplas.

Ese proceso es Node (24 o más). El CLI sigue corriendo en Bun y no importa estos archivos. Vitest sí: `vitest.config.ts` usa el plugin de Motherload para que el import y `parseConfig` lean el TOML con el mismo parser.

## 2. Esa forma tiene que ser `ZwtConfig`

En `src/default-config.ts`:

```ts
export const defaultConfig: MatchesZwtConfig<typeof exampleToml> = exampleToml
```

`exampleToml` es `examples/zwt.toml`. `MatchesZwtConfig` pide dos cosas: que el tipo quepa en `ZwtConfig`, y que no haya claves que el Schema no declara (`onExcessProperty: "error"`). Si el archivo se desalinea, la anotación se vuelve `never` y `bun run typecheck` falla.

Los fixtures hacen lo mismo en `test/typed-config.test.ts`. `valid.toml` encaja. `unknown-key.toml` tiene `token` y no encaja. El test de runtime, además, comprueba que `parseConfig` devuelve el mismo valor que el import.

## 3. Lo que el tipo no ve

Los filtros del Schema no están en el tipo. `Email` es `string` para TypeScript; el patrón y el rechazo de tokens corren al decodificar.

`test/fixtures/invalid.toml` tiene `email = "not-an-email"`. Motherload lo tipea como string, y la forma cabe en `ZwtConfig`. `parseConfig` lo rechaza y marca la línea. Un `identity` que no existe se rechaza igual, en runtime, cuando el resto del documento ya pasó el Schema. El import tipado no reemplaza a `zwt config check`.

## 4. Quitarlo

Borrar `motherload`, la entrada `contentMappers`, `--runExternalCode`, el plugin en `vitest.config.ts`, `src/default-config.ts` y el test que importa los `.toml`. `parseConfig` no los usa.

## Para practicar

1. Agrega `token = "abc"` a `examples/zwt.toml` y corre `bun run typecheck`.
2. Cámbiale el email a `not-an-email`, corre el typecheck (pasa) y después `zwt config check --config examples/zwt.toml`.
