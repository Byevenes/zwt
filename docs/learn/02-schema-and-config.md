# 02. Schema: validar `zwt.toml` en runtime

Nota del slice 2 (#8, #1). Explica cómo zwt usa `Schema` de Effect para que un `zwt.toml` mal escrito falle con la línea exacta, y cómo `zwt new` se apoya en esa config ya validada.

## 1. Un Schema describe la forma *y* la valida

En `src/services/Config.ts`:

```ts
const Identity = Schema.Struct({ name: Text, email: Email })
export const ZwtConfigSchema = Schema.Struct({ version: Schema.Literal(1), identity: Schema.Record(Schema.String, Identity), ... })
export type ZwtConfig = typeof ZwtConfigSchema.Type
```

El tipo `ZwtConfig` sale del Schema. No hay una interfaz aparte que se pueda desincronizar: si cambias el Schema, cambia el tipo y TypeScript te marca todo lo que se rompe (por ejemplo `src/resolve.ts`).

## 2. Filtros: reglas que el tipo no puede expresar

`Schema.String.check(Schema.makeFilter(...))` agrega una regla en runtime. zwt la usa para rechazar valores con forma de token (`ghp_…`, `glpat-…`, `AKIA…`): la config es portable porque **no puede** contener secretos.

## 3. Decodificar sin lanzar excepciones

```ts
const decode = Schema.decodeUnknownExit(ZwtConfigSchema)
decode(raw, { errors: "all", onExcessProperty: "error" })
```

- `Exit` en vez de `throw`: el resultado es un valor (éxito o fallo) que se inspecciona.
- `errors: "all"` junta todos los problemas, no solo el primero.
- `onExcessProperty: "error"` rechaza claves desconocidas (una clave `token = ...` falla).

Cada problema trae un `path` (`identity.personal.email`). `lineOf` recorre el TOML para traducir ese path a un número de línea, y todo termina en un `ConfigInvalid` tipado.

## 4. Lo validado se usa con funciones puras

`zwt new` (#1) no vuelve a validar nada. `resolveNew` en `src/resolve.ts` es una función pura: recibe la config ya decodificada y decide rama, base, carpeta e identidad con la prioridad `--flag` > `[[project]]` > `[[profile]]` > defaults. Al ser pura se prueba sin git ni disco (`test/resolve.test.ts`).

Lo que sí toca el mundo (fetch, `worktree add`) pasa por el servicio `Git`, así que `--dry-run` y los tests con `Git.fake` lo reemplazan sin cambiar el comando.

## 5. `~` y portabilidad

`expandHome` convierte `~/work` en la carpeta del usuario actual. Así el mismo archivo copiado a otra máquina funciona igual: es lo único que hay que llevar (`test/new.integration.test.ts` lo prueba con un `HOME` temporal que solo tiene `zwt.toml`).

## Para practicar

- Agrega un campo opcional al Schema y mira qué partes del código TypeScript te obliga a revisar.
- Escribe un `zwt.toml` con un email inválido y corre `zwt config check --config <archivo>`: compara la línea reportada con la del archivo.
