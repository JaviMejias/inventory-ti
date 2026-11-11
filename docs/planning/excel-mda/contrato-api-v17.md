# Contrato API V17 — revisión persistida de agrupaciones

Fecha: 2026-10-05. Implementado en backend; requiere migración aditiva0023, todavía **no aplicada a la base operativa**. Complementa V16 con almacenamiento administrativo y reservas; no integra los grupos nuevos al inventario ni a los pilotos V5/V6.

## Alcance y permisos

Todos los endpoints requieren JEFE; los POST también CSRF. V16 sigue generando un escenario read-only, con cobertura completa de1–25 observaciones físicas de candidatos originales, identidades verificadas y respaldo por grupo. V17 vuelve a calcular ese escenario y exige el mismo planId, versión de lote, revisión de fuente y ausencia de bloqueantes. No hay force ni aceptación de bloqueantes.

Guarda un comprobante con plan completo y procedencia por fila: hash de fuente, recordId, hoja/fila, candidato original, grupo propuesto y celdas originales/interpretadas. Conserva serie/tag verificados, respaldo, decisiones e impactos de evidencia en el snapshot del plan. No modifica workbook, decisiones, correcciones V7/V8, Asset, Assignment, stock ni historia capturada.

La reserva es global para esas filas/candidatos entre todos los lotes del mismo hash de fuente. Mientras esté activa, los planes/aplicaciones de pilotos anteriores, correcciones V7/V8 que afecten esos candidatos y aplicación de historia V11/V14 están bloqueados. No se bloquea el trabajo sobre candidatos ajenos a la selección.

V18 añade una [consulta efectiva de grupos](contrato-api-v18.md) por una ruta distinta: identificadores estables, procedencia y conflictos actuales, siempre read-only. No habilita decisiones/pilotos por grupo ni cambia estos comprobantes históricos.

## Guardar y recuperar

POST `/inventory/imports/batches/:id/identity-group-reviews`

```json
{
  "requestId": "UUID de reintento",
  "planId": "SHA-256 del escenario V16 revisado",
  "confirmation": "RESERVE_IDENTITY_GROUP_REVIEW_ONLY",
  "plan": {
    "expectedVersion": 1,
    "expectedSourceRevision": 0,
    "confirmation": "REVIEW_PHYSICAL_IDENTITY_GROUPS",
    "candidateIds": ["ID original de candidato"],
    "note": "Motivo de la revisión",
    "groups": [{
      "groupId": "UUID de grupo",
      "recordIds": ["ID original de fila"],
      "serialNumber": "Serie física verificada",
      "assetTag": null,
      "evidenceReference": "Documento o etiqueta verificados"
    }]
  }
}
```

Las leyendas UUID/SHA/ID del ejemplo deben reemplazarse por valores válidos. `plan` es la solicitud V16, **no** su respuesta. Mantiene límites y DTO estricto V16. requestId se normaliza a minúscula.

Respuesta201 nueva /200 recuperada:

```text
{
  scope: "IDENTITY_GROUP_REVIEW_ONLY",
  persisted: true,
  canApply: false,
  affectsCurrentState: false,
  groupedPilotImplemented: false,
  reused: boolean,
  review: {
    id, batchId, batchVersion, sourceRevision, sourceHash,
    requestId, requestDigest, planId, plan, reviewedById, createdAt,
    rows: [{reviewId, recordId, sourceHash, originalCandidateId,
            groupId, snapshot, isReserved}],
    release: null | {id, reviewId, requestId, requestDigest, note,
                     releasedById, createdAt}
  }
}
```

Idempotencia por lote+requestId vinculada a operador e intención normalizada: cambiar orden de grupos/candidatos/filas no crea otra revisión. Cambiar identidad, respaldo, motivo, planId o actor con la misma clave da409. La recuperación ocurre antes de volver a validar versiones; después de cancelar devuelve el mismo comprobante **cancelado**, sin volver a reservar.

GET `/inventory/imports/batches/:id/identity-group-reviews`: limit1–100(default25), offset≥0; respuesta con scope/flags, reviews, total, limit, offset, hasMore. Lista metadatos y release, sin plan/filas; incluye revisiones activas y canceladas.

GET `/inventory/imports/batches/:id/identity-group-reviews/:reviewId`: comprobante completo con flags, sin reused. Un reviewId de otro lote devuelve404.

Fechas createdAt son instantes ISO UTC de registro administrativo, no fechas históricas de movimientos. El escenario conserva asOf y zona America/Santiago.

## Cancelar sin borrar historial

POST `/inventory/imports/batches/:id/identity-group-reviews/:reviewId/release`

```json
{
  "requestId": "UUID de reintento",
  "confirmation": "RELEASE_IDENTITY_GROUP_REVIEW_ONLY",
  "note": "Motivo para abandonar la revisión"
}
```

Motivo no vacío, máximo2000 caracteres. Respuesta201 nueva /200 mismo actor+intención+requestId. Otra clave tras cancelación da409 IDENTITY_GROUP_ALREADY_RELEASED; misma clave con otro motivo/actor da409 IDEMPOTENCY_KEY_REUSED.

La cancelación añade un evento inmutable y libera todas las filas atómicamente. Snapshot/identidad/grupos/comprobante no se reescriben. Solo cambia isReserved true→false bajo el evento de cancelación; no puede alterarse directamente ni reactivarse. Un índice único parcial asegura una sola reserva activa por hash+recordId. Una revisión nueva requiere otro requestId y un escenario recalculado, conservando las anteriores.

Cancelar significa abandonar la propuesta: los flujos anteriores vuelven a interpretar la fuente original y las correcciones V7/V8 vigentes, **no** los grupos abandonados. Aun así deben superar todas sus validaciones y deduplicación propias. No usar cancelación como mecanismo de importación de grupos.

## Consistencia, historia y límites

Guardar/cancelar usa transacciones READ COMMITTED, lock del lote y lock global de fuente. Guardar además toma lock no esperante de Product/Asset para validar el snapshot frente a escritores antiguos; si está ocupado no escribe y responde409. Reintentar con la misma clave o consultar comprobante.

SQL valida cobertura completa de candidatos originales, pertenencia por grupo, origen físico, versiones, JEFE configurado, completitud diferida del comprobante y ausencia de usos previos. Protege también cabecera/items del piloto, revisiones de fuente, items de asignación importada y bajas importadas. Las escrituras de importación directas con aislamiento de snapshot se rechazan: necesitan READ COMMITTED para releer después del lock. Los planes read-only continúan en REPEATABLE READ.

Evidencia ya aplicada V11/V14 o candidatos ya aplicados V6 no pueden reservarse. Evidencia archivada sin consumir puede coexistir: su origen y vínculos no se trasladan al grupo automáticamente. Capturas/enmiendas administrativas pueden seguir registrándose; la revisión conserva el snapshot del momento y la aplicación de esa evidencia permanece bloqueada hasta cancelar o implementar el futuro flujo de grupos. Decisiones posteriores tampoco convierten esta reserva en una autorización de carga.

V16 no persiste al generar un plan y mantiene sus flags read-only históricos. Ahora da409 al seleccionar fuente ya reservada. resolved-preview permanece con candidatos originales y no se convierte en una vista de los grupos propuestos. IDs simulados y groupIds siguen siendo inválidos como targets de importadores anteriores.

## Errores relevantes

- 400 VALIDATION_ERROR / errores de cobertura V16.
- 401 no autenticado;403 rol/CSRF inválidos;404 lote/revisión no encontrados.
- 409 REVIEW_VERSION_CONFLICT / SOURCE_REVISION_CONFLICT.
- 409 IDENTITY_GROUP_PLAN_CHANGED / IDENTITY_GROUP_PLAN_BLOCKED.
- 409 IDENTITY_GROUP_SOURCE_RESERVED, con reviewId, batchId, recordId, candidateId de la reserva.
- 409 IDEMPOTENCY_KEY_REUSED / IDENTITY_GROUP_ALREADY_RELEASED.
- 409 IDENTITY_GROUP_REVIEW_BUSY / IDENTITY_GROUP_REVIEW_CONFLICT.
- 503 IMPORT_REVIEW_NOT_READY si falta el almacenamiento previsto.

No se añade endpoint de aplicación de grupos. Próximo trabajo: proyección efectiva con identidad estable de grupo/fila, renovación explícita de decisiones y vínculos de evidencia, y piloto específico con deduplicación compatible con comprobantes anteriores. Bajas sin fecha, Tintas, corrección de historia operativa, integración frontend y carga real autorizada siguen pendientes.
