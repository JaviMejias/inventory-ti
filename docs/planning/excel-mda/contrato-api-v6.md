# Contrato API V6: aplicación transaccional del piloto

Implementado en código al 2026-10-05; no desplegado ni ejecutado contra inventario operativo. Requiere migraciones 0013–0016. La nueva 0016 es aditiva: comprobantes ImportApplication/ImportApplicationItem y sus restricciones; no cambia activos existentes, estados, stock ni revisiones. Crear/probar una migración no implica aplicarla a la base real.

V6 habilita un endpoint de aplicación exclusivamente para el alcance limitado V5. V3/V4/V5 conservan sus respuestas `canApply=false`: describen evidencia/revisión/plan, no una aprobación guardada. V6 tiene prioridad sobre sus afirmaciones históricas de que no existía endpoint de aplicación. Tintas, bajas, asignaciones y carga histórica siguen fuera del piloto.

## Flujo explícito

1. Generar preview V3 y guardar lote V4; registrar las decisiones de identidad.
2. Generar plan V5 con producto/valores/motivo elegidos y advertencias reconocidas. Mostrar cambios y origen al JEFE.
3. Solo un plan sin bloqueos permite solicitar aplicación explícita con su planId, misma intención y confirmación V6. No aplicar mediante llamadas CRUD individuales.
4. Recuperar el comprobante V6 después de confirmar o ante incertidumbre de red. Mantener requestId e intención para reintentar la misma solicitud.

Este endpoint hace escrituras reales en la base configurada si recibe una petición válida. Antes de ejecutarlo en una base con información real se debe autorizar destino, verificar respaldo/restauración, instalar las migraciones y repetir la suite completa en Node 24. Este chat solo lo ha probado con fixtures anónimos en bases descartables.

## POST /inventory/imports/batches/:id/apply

JEFE autenticado y CSRF, body habitual máximo 1 MiB. Objeto estricto:

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "planId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "confirmation": "APPLY_ASSET_PILOT",
  "plan": {
    "expectedVersion": 2,
    "operations": [{
      "type": "CREATE_ASSET",
      "candidateId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "confirmation": "AVAILABLE_UNASSIGNED",
      "note": "Identidad y disponibilidad verificadas",
      "acknowledgedWarnings": [],
      "values": {
        "productId": "00000000-0000-4000-8000-000000000002",
        "serialNumber": "SERIE-PILOTO-001"
      }
    }]
  }
}
```

`requestId` UUID identifica la intención/reintentos; `planId` SHA-256 debe ser el devuelto por V5; `plan` es exactamente el request de planificación V5, no su response. Confirmación literal obligatoria, no boolean ni force. Se mantienen límite 25 y reglas estrictas de identidad/metadatos/estado V5. Un planId conocido no concede permiso ni evita CSRF/revalidación.

### Revalidación, concurrencia y atomicidad

- Bloquea la fila del lote y verifica idempotencia antes de comprobar vigencia. No aumenta versión de revisión: aplicar no es otra decisión humana de identidad.
- Para una petición nueva adquiere EXCLUSIVE de Product y Asset con NOWAIT. Congela brevemente escrituras/row-locks en ambas tablas, incluso las de endpoints anteriores que no conocen el importador; consultas normales siguen disponibles. Es una protección global conservadora para pilotos pequeños, no un mecanismo para importaciones masivas continuas.
- Si una tabla está ocupada revierte el intento inmediatamente, incluidos bloqueos parciales. Hasta seis intentos con pausas de 25/50/75/100/125 ms; evita esperar reteniendo Product cuando un escritor Asset→FK Product está en curso. Agotado devuelve 409 IMPORT_APPLY_BUSY. Bloqueos del lote/otros locks tienen lock_timeout 3 s; cada transacción dura como máximo 15 s, adquisición de conexión 5 s.
- Después de adquirir ambas tablas recalcula el plan completo dentro de la transacción READ COMMITTED. Catálogo/activos quedan estables durante esas lecturas y hasta commit. Si cambió cualquier dato vinculado, fecha, versión, reglas o intención relevante, planId no coincide y no se escribe nada.
- Todos los equipos seleccionados deben ser válidos antes de la primera mutación. Una incidencia no se transforma en simple advertencia por pedir aplicación.
- Reutiliza los servicios de creación/actualización y sus invariantes/auditoría dentro de la misma transacción. Crear conserva AVAILABLE/isActive=true; actualizar metadatos conserva producto/identidad/estado. No genera stock QUANTITY, movimientos ni asignaciones ficticias.
- Activos, auditoría habitual, comprobante/ítems y auditoría IMPORT_PILOT_APPLIED se confirman juntos o se revierten juntos. No hay éxito parcial, estado PENDING ni carga en segundo plano.

### Idempotencia y procedencia

Un `batchId + requestId` se guarda una sola vez, vinculado a autor e intención normalizada. Mismo request/actor devuelve el comprobante original aunque después cambien inventario, revisión o fecha. Otra intención/actor con esa clave devuelve 409; no reaplica ni devuelve valores actuales como si fueran el resultado original.

planId es único y `(sourceHash, candidateId)` también es único entre todos los comprobantes, no solo dentro del lote. Generar otro lote del mismo archivo no permite volver a aplicar el mismo candidato, sea creación o metadatos. Archivos diferentes aún deben superar reconciliación global de identidad V3/V5. Estas reglas no hacen que el digest declarado sustituya una extracción confiable del archivo.

Comprobante conserva autor/fecha de aplicación actual, origen/plan completo, versión y decisión de revisión, operación con motivo/advertencias/cambios/hoja/fila, activo resultante y snapshot de su resultado. No atribuye eventos históricos del Excel al importador. Comprobantes/ítems son inmutables; FK restrictivas conservan relaciones, unicidad impide duplicados y un constraint diferido exige un ítem por operación del plan. Corregir después requiere workflows normales y nueva trazabilidad, no borrar el comprobante para repetir la carga.

Una aplicación parcial cambia el snapshot operativo y deja obsoleto el lote para otros candidatos, por la política global conservadora V4/V5. Para otro piloto se genera un preview/lote vigente y se revisa la nueva selección; la unicidad de origen conserva lo ya aplicado. No hay rebase automático ni aprobación heredada. Una futura carga masiva deberá resolver ese flujo y las reglas pendientes antes de ampliar límites.

### Response

201 primera aplicación; 200 reintento recuperado:

`{ mode: "APPLIED", persisted: true, reused: boolean, application: ImportApplicationReceipt }`.

Receipt: id, batchId, batchVersion, requestId, requestDigest, planId, sourceHash, plan (response V5 original), appliedById, createdAt, items. El plan guardado mantiene mode PILOT_PLAN/persisted=false/canApply=false porque es la evidencia evaluada antes de escribir; el contenedor V6 y sus ítems acreditan la aplicación efectiva.

Items ordenados por candidateId: id, applicationId, candidateId, sourceHash, decisionId, assetId, operation (operación V5 evaluada) y result (snapshot del activo devuelto por el servicio de dominio, incluido producto público V1). createdAt/fechas se serializan ISO. result es histórico y no se actualiza cuando el activo cambie después.

### Errores

- 400 VALIDATION_ERROR: DTO/confirmación/UUID/digest inválidos; INVALID_REVIEW_TARGET: candidato no físico o ajeno.
- 401 sin sesión, 403 rol/CSRF, 404 lote inexistente, 413 cuerpo excesivo.
- 409 REVIEW_VERSION_CONFLICT con currentVersion: cambió revisión; volver a mostrar/generar plan, no cambiar expectedVersion silenciosamente.
- 409 IMPORT_PLAN_CHANGED: planId no coincide con la reevaluación. Generar/mostrar nuevo plan y confirmar otra intención con nuevo requestId.
- 409 IMPORT_PLAN_BLOCKED con operations/candidateId/blockers: la intención actual tiene conflictos y nunca se aplicó.
- 409 IMPORT_TARGET_ALREADY_APPLIED con applicationId/candidateId/batchId del comprobante original: candidato del archivo ya aplicado, incluso desde otro lote; recuperar ese comprobante desde su lote.
- 409 IDEMPOTENCY_KEY_REUSED: clave ligada a otra intención/autor.
- 409 IMPORT_APPLICATION_CONFLICT: constraint de unicidad operativo/comprobante; ninguna escritura de ese intento persiste. Recuperar resultado conocido o generar plan actual.
- 409 IMPORT_APPLY_BUSY: contención/conflicto transaccional o timeout. Reintentar misma intención y requestId; si mientras tanto cambia el plan, aplicar la regla IMPORT_PLAN_CHANGED.
- 409 INVALID_REVIEW_SNAPSHOT/PREVIEW_DATABASE_LIMIT mantienen reglas V3–V5. 503 IMPORT_REVIEW_NOT_READY si faltan tablas de staging/aplicación; no activar este flujo antes de instalar sus migraciones.
- Otros fallos devuelven el error saneado habitual, sin exponer fuente ni detalles SQL. Si hubo incertidumbre de red, consultar/reintentar; no asumir que un timeout del cliente implica rollback.

## Consultar comprobantes

`GET /inventory/imports/batches/:id/applications`: JEFE, sin CSRF para lectura. Query estricta limit 1..100 default25, offset >=0 hasta2147483647. Response `{ applications, total, limit, offset, hasMore }`, orden createdAt/id descendente, conteo/página RepeatableRead. Solo metadatos id/batchId/batchVersion/requestId/planId/sourceHash/appliedById/createdAt; no duplica plan/ítems. 404 lote inexistente.

`GET /inventory/imports/batches/:id/applications/:applicationId`: JEFE. Response `{ mode:"APPLIED", persisted:true, application:<receipt completo> }`. 404 si no existe o pertenece a otro lote. Sin DELETE/PATCH ni reversión automática. Reintentar POST con su clave sigue siendo el mecanismo de recuperación cuando todavía no se conoce applicationId.

## Verificación y pendientes

Migración nueva probada tanto en el runner completo como sobre tablas legacy pobladas en esquema descartable. Se probaron permisos, DTO, lectura de comprobantes, audit-before/after, atomicidad/rollback, unicidad entre lotes, reintentos simultáneos, cambios posteriores, bloqueo de plan y contención con escritor Asset→FK. Base operativa intacta y sin carga del workbook real.

239 pruebas aprobadas en PostgreSQL 18.6 descartable con Node 26 WSL; 13 nuevas del bloque V6. Prisma validado/generado, API compilada, lint acotado y diff-check correctos.

Suite completa aún debe repetirse en Node 24 soportado antes de despliegue. No declarar completo el importador general: faltan reglas/resolución de conflictos, historia, Tintas y validación de un piloto real en destino autorizado.
