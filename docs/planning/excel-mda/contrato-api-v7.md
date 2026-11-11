# Contrato API V7: correcciones de origen y revisión de catálogo

Implementado en código al 2026-10-05; sin despliegue ni migración/carga operativa. Requiere 0017_import_source_revisions además de las migraciones previas. Nueva tabla aditiva ImportSourceRevision; no modifica fuente, preview original, activos, productos ni stock existentes.

V7 incorpora correcciones humanas de tipo, marca, modelo y fecha de recepción. No es un botón para ignorar incidencias: las validaciones se ejecutan otra vez sobre una interpretación corregida, y los conflictos independientes continúan bloqueando. Series/tags, estado/disponibilidad, destinatarios, fechas de uso/préstamo, columnas desconocidas, Tintas y estructura de hojas no se corrigen por este endpoint.

## Identidad, revisión y procedencia

El Excel original y el snapshot V4 permanecen inmutables. Cada corrección es un evento con autor actual, motivo, referencia de respaldo y valores original/anterior/posterior, identificados por recordId/hoja/fila/columna. Un valor suministrado requiere verificación humana: el servidor valida forma/coherencia, no comprueba que la referencia documental sea auténtica.

`ImportBatch.version` sigue contando exclusivamente decisiones V4; no se incrementa por estas correcciones. `sourceRevision` empieza en 0 y aumenta una unidad por evento. Esta separación conserva la invariancia de versión/decisión V4. Los IDs de candidatos y registros permanecen porque no se cambian identidades físicas ni agrupación por serie/tag.

Las correcciones se serializan por lote, con protección adicional por sourceHash compartida con V6. No se permite reinterpretar un candidato de esa fuente que ya tenga comprobante aplicado, aunque proceda de otro lote; usar los workflows operativos para modificaciones posteriores. Reintentos recuperan eventos anteriores sin volver a corregir ni revalidar su elegibilidad actual.

## POST /inventory/imports/batches/:id/source-revisions

Solo JEFE+CSRF; body habitual máximo 1 MiB. Objeto estricto:

```json
{
  "expectedRevision": 0,
  "expectedBatchVersion": 2,
  "requestId": "00000000-0000-4000-8000-000000000001",
  "note": "Modelo verificado en etiqueta física y fecha en recepción",
  "evidenceReference": "Acta de recepción R-001",
  "changes": [{
    "recordId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "field": "model",
    "action": "REPLACE",
    "value": "Modelo verificado"
  }]
}
```

- expectedRevision: entero 0..999; máximo 1000 eventos por lote. expectedBatchVersion: entero 1..2147483647. Sin coerción de strings.
- requestId UUID estable para reintentos. note: trim 1..2000; evidenceReference: trim 1..500. Motivo/referencia obligatorios, sin URLs consultadas automáticamente.
- changes: 1..25 campos distintos por recordId/field. Solo observaciones físicas mapeadas, incluidas observaciones de baja como evidencia; corregir evidencia de baja no habilita su carga mediante piloto.
- field: equipmentType, brand, model o receivedDate, y debe existir en el diccionario contextual de esa hoja. No encabezados/notas sueltas/resúmenes/consumibles/filas no mapeadas.
- REPLACE: value texto explícito, trim y no vacío/placeholder/null. Tipo/marca máximo100; modelo160. Fecha de recepción: YYYY-MM-DD calendario real, desde1900 y no futura al día evaluado en America/Santiago. No borrar una fecha dudosa para eliminar su bloqueo ni rellenarla automáticamente con hoy.
- RESTORE: sin value. Recupera exactamente la celda original, incluido tipo/formato/fórmula o ausencia. Es otro evento, no DELETE del anterior, y puede recuperar incidencias originales.
- No se guarda una revisión sin cambios reales. Si agregar una celda superara límites del envelope V3, se rechaza antes de persistir; no se crea una interpretación imposible de leer/restaurar.

201 evento nuevo, 200 reintento: `{ event, reused, canApply:false }`. Event contiene id/batchId/revision/expectedBatchVersion/requestId/requestDigest/note/evidenceReference/reviewedById/createdAt y changes enriquecidos: recordId, candidateId, sheet, row, column, field, action, value cuando REPLACE, originalCell, beforeCell y afterCell. Tipos de celda V3; null significa ausencia de celda, no una identidad inventada.

Evento y auditoría IMPORT_SOURCE_CORRECTED son atómicos. Historial inmutable en PostgreSQL, revisiones consecutivas, claves únicas por lote/revisión y lote/requestId, guardas de origen y cadena before/after. No genera auditoría ASSET_UPDATED, no cambia revisión V4 ni aplicación operativa.

La clave se liga a intención normalizada y autor. Orden distinto de changes no altera la intención. Repetir requestId con otro motivo/valor/autor da409. Recuperar un evento antiguo no significa que sea la revisión vigente: frontend debe refrescar el historial antes de sustituir su estado local.

## GET /inventory/imports/batches/:id/source-revisions

JEFE, sin CSRF para lectura. Query estricta limit1..100 default25 y offset0..2147483647. Response `{ events, revision, total, limit, offset, hasMore, canApply:false }`; eventos de revisión descendente, conteo/página RepeatableRead. revision es la revisión global vigente, no la de la primera fila paginada.

## GET /inventory/imports/batches/:id/resolved-preview

JEFE. Response `{ batchId, batchVersion, sourceContext, preview, originalPayloadDigest, effectivePayloadDigest, canApply:false }`.

sourceContext: `{ revision, corrections }`, con la última corrección REPLACE activa por recordId/field; cada entrada conserva valores/origen más revisionId/revision/reviewedById/note/evidenceReference. RESTORE elimina esa entrada de la vista activa, no del historial.

preview es V3 regenerado con las correcciones y comparación operativa actual, nunca ejecutando fórmulas. Tiene su propio payloadDigest/previewId para la interpretación efectiva; source.sha256 continúa identificando el archivo original, no un XLSX corregido. originalPayloadDigest identifica la fuente guardada; effectivePayloadDigest la interpretación actual. Original y efectiva deben mostrarse como cosas distintas.

Lecturas fuente/correcciones/inventario corresponden a RepeatableRead. Esta respuesta no constituye aprobación ni reserva de inventario. `/preview` V4 sigue devolviendo el snapshot original sin cambiarlo. `/freshness` V4 conserva su significado de fuente original/reglas/base; no informa la nueva revisión de origen. Para correcciones usar sourceContext y los controles V7 de planificación.

## GET /inventory/imports/batches/:id/catalog-review

JEFE, query paginada idéntica a source-revisions. Response `{ batchId, sourceRevision, candidates, total, limit, offset, hasMore, canApply:false }`.

Por candidato: candidateId, attributes (listas normalizadas de equipmentType/brand/model), conflict, hasEvidence, suggestedProducts, matchCount, hasMoreSuggestions, requiresExplicitChoice:true, source (recordId/hoja/fila).

Solo sugiere productos existentes, activos y ASSET con coincidencia exacta normalizada en todos los atributos presentes. No elige por nombre parecido, no considera QUANTITY/inactivos y no propone coincidencias si faltan todos los atributos o existe conflicto entre observaciones. Match vacío no es autorización para inventar producto/identidad. Productos incompletos pueden requerir elección/verificación manual en catálogo y plan.

Devuelve hasta10 sugerencias por candidato e informa matchCount/hasMoreSuggestions; catálogo limitado a5000 productos compatibles para esta revisión, con error explícito si se excede. Lista de candidatos tiene paginación real. Esta consulta es de catálogo, no reconciliación operativa de identidad; no acredita que el candidato sea nuevo ni aplicable.

No crea productos ni persiste un vínculo automático. Si no existe el producto correcto, se usa el CRUD de catálogo existente con permisos/validaciones normales y luego se elige productId explícitamente en V5. No importar un catálogo duplicado por cada hoja o corrección.

## Integración con V5/V6

- Request del plan V5 añade `expectedSourceRevision`, entero0..1000, default0 para clientes anteriores. Si hay eventos y el cliente omite el campo, recibe SOURCE_REVISION_CONFLICT; debe mostrar/revisar correcciones y reenviar la versión real, no asumirla silenciosamente.
- Planner vigente pasa a `planRulesVersion: mda-pilot-2`. Response añade sourceRevision y, en cada operación, sourceCorrections activas pertinentes. Cambios nuevos de código/reglas o correcciones invalidan planes anteriores; generar uno nuevo.
- Recalcula todas las incidencias de origen antes de validar producto/estado/identidad y advertencias del piloto. No hay lista force/ignore de bloqueantes. Campos ajenos e incidencias restantes se conservan.
- V6 recibe el mismo request de plan V5 dentro de `plan`, incluyendo expectedSourceRevision. Antes de escribir revalida revisión, datos y planId bajo sus locks; corrección posterior al plan impide su aplicación.
- Comprobante V6 conserva la revisión y correcciones utilizadas, con origen/motivo/autor/respaldo. Sigue atribuyendo la aplicación al actor actual, no al responsable histórico del Excel.
- La huella de intención de V6 omite expectedSourceRevision cuando es0, preservando recuperación de reintentos V6 anteriores sin correcciones. Los comprobantes previos permanecen inmutables.
- Fuente corregida no salta un estado desconocido, asignación/historia, identidad dudosa ni baja terminal. El piloto sigue limitado a creación AVAILABLE o actualización de metadatos.
- V7 requiere0017 para planificación y aplicación actuales, incluso cuando el lote tiene cero correcciones. Si falta almacenamiento, se devuelve503 IMPORT_REVIEW_NOT_READY. No activar frontend nuevo antes de desplegar/migrar backend.

## Errores y límites

400 VALIDATION_ERROR por shape/campos/fechas inválidos; INVALID_SOURCE_TARGET o INVALID_SOURCE_FIELD por origen no admitido; FUTURE_SOURCE_CORRECTION por fecha verificada futura; SOURCE_CORRECTION_LIMIT por límites de fuente propuesta. 401/403/404/413 habituales.

409 REVIEW_VERSION_CONFLICT con currentVersion; SOURCE_REVISION_CONFLICT con currentRevision; SOURCE_FIELD_UNCHANGED; IDEMPOTENCY_KEY_REUSED; SOURCE_TARGET_ALREADY_APPLIED; INVALID_SOURCE_REVISION; SOURCE_REVISION_LIMIT; IMPORT_CATALOG_LIMIT. Lote/origen inválidos mantienen INVALID_REVIEW_SNAPSHOT. Fallos de persistencia revierten todo y usan el manejo saneado habitual; reintentar conserva la misma clave/intención si el resultado era incierto.

## Verificación y próximos bloques

254 pruebas aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas15 nuevas de revisión/catálogo/migración. Cobertura: DTOs y límites, originales inmutables, restauración, concurrencia/idempotencia, auditoría/rollback, guards DB de valores/origen/revisión, plan/comprobante vinculados y otros conflictos conservados. Prisma validado/generado, API compilada, lint acotado y diff-check correctos. Suite completa Node24 pendiente antes del despliegue.

No se corrigieron registros del workbook real ni se ejecutaron migraciones operativas. Quedan identidades/series/tags ambiguos, importación histórica/bajas/asignaciones, Tintas, continuidad de lotes masivos, frontend de revisión y piloto real autorizado. Resolver una marca/modelo/fecha con evidencia no significa terminar todas las incidencias ni confirmar todo el inventario.
