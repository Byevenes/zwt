# Retro del MVP

Cierre de #20 (decisión D5 en #16). Cubre del slice 1 (#30) a #48: 17 PRs fusionados entre el 4 y el 7 de noviembre de 2026.

## Qué se hizo

| Tramo | PRs | Cómo se trabajó |
| --- | --- | --- |
| Base y slices 1–3 | #30, #32, #33, #35–#39 | un PR por slice, en secuencia; cada PR con clasificación, diagrama y verificación en la descripción |
| Lote de comandos | #40–#48 | 9 PRs abiertos en paralelo en unos 20 minutos y fusionados el mismo día |

Resultado: `config check`, `new`, `identity`, `doctor`, `init`, `status`, `list`/`prune`/`rm`, `sync`, `open`, `log`, release con binarios e instalador, y lint con tipos en CI.

## Qué funcionó

- **Servicios y Layers desde el día uno.** `--dry-run`, los fakes de test y el registro de acciones (#44) entraron como Layers nuevos sin tocar los comandos (notas 01 y 07). La base de #30 aguantó los 16 PRs siguientes.
- **Errores con `fix`.** Cada error dice qué comando lo arregla. Eso fijó el tono de la CLI y los tests lo revisan (nota 06).
- **Dos niveles de test.** Los fakes prueban las reglas rápido y los integration tests prueban git de verdad (nota 08). Ningún PR del lote se revirtió.
- **Slices chicos en paralelo.** Con la base estable, 9 PRs independientes se pudieron revisar y fusionar en una tarde, con un solo arreglo de seguimiento (#41, pin de TypeScript).

## Qué faltó

- **El registro del flujo por slice quedó dispar.** Los slices 1–3 dejan la clasificación y la verificación en el PR. El lote #40–#48 deja "qué cambió, por qué, cómo se verificó", pero no las etapas (grill, spec, review). El criterio de #20 se cumplió solo en parte.
- **Las notas de aprendizaje llegaron tarde.** Después del slice 3 solo se escribió la 04; las 05–08 se escribieron al cerrar el MVP. Una nota escrita después explica el código, pero ya no sirve para entenderlo mientras se revisa el PR.
- **Sin revisión registrada en GitHub.** Los 17 PRs se fusionaron sin un review en el PR. La revisión pasó fuera de GitHub y no quedó rastro.
- **Fusión en bloque.** Los 9 PRs del lote se fusionaron en media hora. Funcionó porque tocaban archivos distintos, pero dependió de suerte más que de una regla.
- **Sesión guiada pendiente.** Sigue abierta (ver el índice de `docs/learn/`).

## Mejoras

Para zwt:

1. El PR de un slice no se fusiona sin su nota en `docs/learn/` (o la línea "sin concepto nuevo").
2. Una plantilla de PR con una sección corta de etapas: clasificación, preguntas que quedaron, cómo se verificó.
3. Antes de un lote paralelo, revisar qué archivos toca cada PR y fusionar en el orden que reduce conflictos.
4. Seguir con lo abierto: #49 (TypeScript 7.1), y las ideas post-MVP (#5, #6, #12–#15, #27–#29).

Para el flujo de trabajo con agentes:

1. Las notas de aprendizaje son parte de la definición de "listo", no un paso al final.
2. El registro de etapas se escribe en el PR mientras pasa, no se reconstruye después.
3. Un PR tiene al menos un comentario de revisión en GitHub, aunque sea propio, para que la decisión quede escrita.
