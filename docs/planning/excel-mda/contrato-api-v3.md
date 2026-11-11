# Contrato API V3: preview y reconciliación del Excel

Estado: implementado en código, 2026-10-05. Extiende V1/V2 sin cambiar sus DTO. No requiere una nueva migración. Este bloque no importa ni persiste decisiones de revisión. La carga y el staging persistente siguen pendientes.

## Alcance para frontend

- `POST /inventory/imports/preview`: JEFE autenticado y CSRF vigente. COORDINADOR/SOPORTE reciben 403.
- Content-Type `application/json`. Recibe el JSON del extractor administrativo, **no** binario XLSX ni multipart. No existe upload web ni `/inventory/imports/apply`.
- Respuesta 200 con `mode="PREVIEW"`, `canApply=false`, `persisted=false`, `comparisonMode="DATABASE"`. No mostrar botón Aplicar ni revisión guardada.
- Conserva todos los registros de origen, incluidos ocultos por filtros, y separa títulos/headers repetidos. Datos inciertos quedan visibles con incidencias. Una observación o candidato no demuestra un activo único actual.
- Límite local de 16 MiB para esta ruta. El resto de la API conserva sus límites previos. Máximo 32 hojas, 15.000 filas con contenido y 150.000 celdas pobladas en el conjunto. Una fila permite 64 celdas; cada cadena de valor hasta 8.192 caracteres. No hay truncamiento silencioso.
- Base: máximo 25.000 activos; más devuelve 409 `PREVIEW_DATABASE_LIMIT`, sin omitir registros. Lee activos activos/inactivos y bajas, mediante columnas anteriores a V1.

## Envelope de entrada

```json
{
  "formatVersion": 1,
  "source": { "fileName": "Inventario.xlsx", "sha256": "64 caracteres hexadecimales en minúsculas" },
  "sheets": [{
    "name": "Recepción",
    "hidden": false,
    "filterRange": "A3:P100",
    "rows": [{
      "row": 4,
      "hidden": false,
      "cells": {
        "F": { "type": "text", "value": "SER-001", "numberFormat": "General" },
        "G": { "type": "number", "value": 12345, "rawValue": "12345" }
      }
    }]
  }]
}
```

Ejemplo parcial: una hoja real también debe contener su encabezado en la fila registrada en el diccionario. Objetos estrictos: no admitir propiedades adicionales. Nombres de archivo sin rutas/control characters, extensión `.xlsx`. Nombres de hojas y posiciones de filas no pueden repetirse. Celdas usan columna A1 sin número; la fila está en `row`.

`type`: text/number/date/formula/boolean/error. `value` debe ser string para text/date/formula/error, number finito para number, boolean para boolean. `numberFormat`, `rawValue`, `cachedValue`, `formulaAttributes` son opcionales. Fecha Excel conservada como ISO local sin inventar zona. Fórmulas comienzan por `=`; las compartidas sin texto conservan `value="="` y sus atributos. Los resultados guardados solo son evidencia y nunca se usan para normalizar campos.

`source.sha256` identifica los bytes que leyó el extractor. La API recibe un hash declarado: no verifica el archivo binario. `payloadDigest` sí calcula el hash del contenido recibido. Ninguno es una firma ni autorización de carga.

## Respuesta

Objeto con `source`, `rulesVersion="mda-preview-1"`, `asOf` YYYY-MM-DD del servidor en America/Santiago, `timeZone`, `payloadDigest`, `databaseSnapshotDigest`, `previewId`, `summary`, `sheets`, `records`, `candidates`, `issues`, `excluded`.

- `previewId`: digest de reglas, payload, snapshot de base, fecha de revisión y modo de comparación. Cambios en cualquiera invalidan la identidad del preview. No es un token utilizable para aplicar ni una promesa de que la base sigue igual.
- `databaseSnapshotDigest`: digest de los activos consultados y nombre del producto. No transmite activos ajenos a coincidencias. En CLI sin base es null y `comparisonMode="SOURCE_ONLY"`.
- `summary`: sheetCount, populatedRows, recordCount, excludedCount, candidateCount, matchedCandidateCount, consumableReviewCount, manualSummaryCount, sourceNoteCount, blockingIssueCount, warningCount, infoCount. Son conteos del análisis, **no stock disponible ni total confirmado de activos**.
- `sheets[]`: name, kind, headerValid, populatedRows, recordCount, excludedCount, hidden, filterRange. Header incorrecto no se adivina: datos quedan UNMAPPED.
- `records[]`: id, sheet, row, hidden, kind, fields, originalCells, serialKey, tagKey, statusEvidence. `fields` conserva normalización legible con contexto por hoja; no es un DTO de creación. `originalCells` retiene tipos, valores, formato y evidencia de fórmula.
- `excluded[]`: sheet, row, reason (HEADER_OR_TITLE/REPEATED_HEADER/EMPTY), originalCells. Para cada hoja, populatedRows = recordCount + excludedCount.
- `issues[]`: code, severity (BLOCKING/WARNING/INFO), sheet|null, row|null, cell|null y candidateId|null. `cell` es dirección A1 completa. Incidencias de candidato usan candidateId; incidencias de hoja/fila se relacionan por el origen de sus recordIds. Una incidencia de hoja puede afectar todos sus registros. Los conteos cuentan incidencias, no filas distintas.

Kinds: ASSET_OBSERVATION, RETIREMENT_HISTORY, CONSUMABLE_REVIEW, MANUAL_SUMMARY, SOURCE_NOTE, UNMAPPED. Tintas nunca agrupa `printerSerial` con la serie física. Disponible nunca crea movimientos/saldos. SOURCE_NOTE conserva notas aisladas sin convertirlas en activos; UNMAPPED se conserva para revisión.

### Candidatos

`id`, `identityKey`, `serials[]`, `tags[]`, `recordIds[]`, `reviewRequired=true`, `proposedStatus=null`, `proposal`, `existingAssets[]`.

- REVIEW_EXISTING: coincidencia exacta normalizada con un activo existente, todavía no autoriza actualizarlo.
- REVIEW_MATCH: hay varios activos existentes compatibles; no elegir uno.
- REVIEW_NEW: no hay coincidencia de identificadores en la base consultada; no autoriza crear.
- REVIEW_IDENTITY: falta identidad utilizable. No generar identidad ficticia.
- REVIEW_SOURCE_ONLY: CLI sin comparación con base; no afirmar que el activo no existe.

`existingAssets[]` contiene id, productId, serialNumber, assetTag, status, isActive, updatedAt ISO y product.name. Coincidencias de serie atraviesan productos: la unicidad producto+serie de Prisma no garantiza identidad física global. No se compara automáticamente un nombre de catálogo con marca/modelo del workbook ni se crea un producto por cada combinación.

Normalización de identidad: espacios/no separables, trim, espacios repetidos y mayúsculas. Conserva puntuación y acentos. Placeholders N/A/NA/N.A./S/N/SIN SERIE/SIN ACTIVO/guion/vacío no son identidad. Serie numérica queda fuera de coincidencia automática, sin completar dígitos/ceros. Tag numérico solo admite entero seguro de hasta 15 dígitos, sin formato ambiguo: General/0 o formato ausente. Formatos con ceros iniciales, científicos y demás quedan para revisión, no se completan ni eliminan dígitos para coincidir.

Agrupa por serie textual exacta. Un registro solo con tag puede unirse a una única serie que comparta ese tag. Un tag con varias series no las fusiona. No se elige última fila, fecha mayor, hoja de bodega ni estado Disponible como verdad actual.

`statusEvidence` solo AVAILABLE o DECOMMISSIONED|null como evidencia de esa observación. Fecha en una hoja Baja no se interpreta como fecha efectiva de retiro. No Disponible/Ocupado no equivalen a ASSIGNED. Condición, finalidad, ubicación y destinatario permanecen independientes. `proposedStatus` siempre null.

### Códigos de incidencias

| Código | Interpretación |
| --- | --- |
| MISSING_SHEET / UNKNOWN_SHEET | Falta una hoja esperada / hoja sin reglas conocidas. |
| HEADER_MISMATCH / UNMAPPED_COLUMN | Estructura distinta o columna sin interpretación, incluida posible fila desplazada. |
| FORMULA_REQUIRES_REVIEW / EXCEL_CELL_ERROR | No ejecutar fórmula ni confiar en su cache; error Excel preservado. |
| NUMERIC_SERIAL_REQUIRES_REVIEW / NUMERIC_TAG_PRECISION_RISK | Tipo/precisión no garantizan identidad original. |
| NUMERIC_TAG_FORMAT_REQUIRES_REVIEW | No interpretar ceros iniciales o formato de identificador automáticamente. |
| IDENTIFIER_TYPE_REQUIRES_REVIEW / SOURCE_NOTE_NOT_ASSET | Fecha/boolean no identifica activos; nota aislada se conserva fuera de candidatos. |
| MISSING_ASSET_IDENTITY / MISSING_PRODUCT_MODEL | Identidad insuficiente / producto incompleto. |
| DATE_REQUIRES_REVIEW / FUTURE_SOURCE_DATE / SOURCE_DATE_ORDER_CONFLICT | Fecha ambigua, futura o uso anterior a recepción. No reparar automáticamente. |
| RETIREMENT_DATE_UNCONFIRMED | La fecha observada en Baja no acredita fecha de retiro. |
| OPERATIONAL_STATE_UNRESOLVED | Texto de estado no determina transición operativa. |
| POSSIBLE_SHIFTED_STATE_COLUMN | Un lugar aparece en el campo de estado. |
| AVAILABILITY_ASSIGNMENT_CONFLICT | Disponible junto con referencia textual de envío/asignación/préstamo. |
| INVALID_IP_ADDRESS / NETWORK_PREFIX_IP_CONFLICT | IP no válida o distinta del prefijo. |
| PRODUCT_BRAND_CONFLICT / PRODUCT_MODEL_CONFLICT / PRODUCT_EQUIPMENTTYPE_CONFLICT | Observaciones de identidad agrupada discrepan en producto. |
| SERIAL_HAS_MULTIPLE_TAGS / TAG_HAS_MULTIPLE_SERIALS | Identificadores entre hojas contradictorios. |
| CROSS_SHEET_STATE_CONFLICT | Evidencias Disponible y Baja incompatibles sin historia revisada. |
| AMBIGUOUS_EXISTING_ASSET | Varios activos existentes coinciden. |
| EXISTING_SERIAL_CONFLICT / EXISTING_TAG_CONFLICT | La coincidencia por un identificador contradice el otro. |
| EXISTING_TERMINAL_STATE_CONFLICT | Fuente dice Disponible para activo inactivo/baja. No reactivar. |
| MULTIPLE_SOURCE_OBSERVATIONS | Repeticiones potencialmente históricas, no duplicados confirmados. |
| CONSUMABLE_UNIT_UNCONFIRMED / MANUAL_SUMMARY_NOT_STOCK | Tintas requiere reglas confirmadas; resumen manual no representa saldo. |

Bloqueantes son pistas para revisión; no implican que cada fila sea inválida. Advertencias también requieren decisión cuando afectan una carga. Aunque no hubiera incidencias, canApply sigue false.

## Flujo administrativo disponible

Extractor: `apps/api/scripts/extract_inventory_workbook.py`, Python con openpyxl (solo lectura/utilidades de formato y fecha). No hay dependencia XLSX nueva en el servidor ni cambio al lockfile. Lee XML/celdas pobladas directamente, no `max_row`; no ejecuta macros, fórmulas, enlaces ni acciones del contenido. Límites XLSX: 64 MiB comprimido/expandido y 4.096 entradas ZIP. Preserva valores de texto sin tratarlos como instrucciones.

```text
python apps/api/scripts/extract_inventory_workbook.py archivo.xlsx --output ruta-privada/extraido.json
```

Desde apps/api, con Node 24 y dependencias del repo:

```text
node --import tsx/esm src/scripts/preview-inventory-workbook.ts ruta-privada/extraido.json --summary
node --env-file-if-exists=../../.env --import tsx/esm src/scripts/preview-inventory-workbook.ts ruta-privada/extraido.json --database --summary --output ruta-privada/revision.json
```

`--as-of YYYY-MM-DD` fija fecha de revisión en CLI para reproducibilidad. Sin `--summary` produce detalle completo, que puede contener datos personales. `--output` crea exclusivamente un archivo nuevo y nunca sobrescribe. Guardar extracción/detalle fuera de Git y logs públicos, con permisos locales restringidos. No renderizar valores/fórmulas como HTML ejecutable en frontend. El resumen no incluye filas ni nombres personales.

Validación: tests unitarios de diccionario/identidad y API con base PostgreSQL descartable, límites/permisos/CSRF/no escritura operativa. Tests Python del extractor con XML mínimo anónimo. Smoke con las 17 hojas del archivo real y comparación read-only con base local; fuente sin modificar. Motor compilado probado también con Node 24.19 de Windows. La suite completa API/PostgreSQL se ejecuta en Node 26 WSL: repetirla en Node 24 antes de despliegue.

## Pendiente, no simular

Staging persistente, decisiones humanas por candidato/evento, confirmación de semántica Tintas y de fechas/estados históricos, comparación explícita de productos, verificación de concurrencia al aplicar, piloto, idempotencia real de carga, respaldo y aplicación de lote autorizado. No hay historia importada ni entidades operativas creadas por este bloque.
