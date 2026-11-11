# Contrato API V11: aplicación de asignaciones históricas cerradas

Estado al 2026-10-05: implementado en código y probado con fixtures en bases descartables. Extiende el plan [V10](contrato-api-v10.md) y la evidencia [V9](contrato-api-v9.md). Requiere migraciones hasta `0020_import_closed_assignments` y cliente Prisma correspondiente. No se aplicaron migraciones a la base operativa ni se cargó el Excel real.

V11 tiene prioridad sobre las afirmaciones históricas de V10 de que no existe aplicación. El plan sigue siendo read-only: `canApply:false`, `persisted:false`, `affectsCurrentState:false`. La escritura exige la ruta y confirmación nuevas; no encadenar asignar/devolver mediante CRUD.

## Alcance y condiciones

Aplica de 1 a 25 periodos históricos **cerrados de un solo activo existente**, desde dos observaciones V9 distintas, capturadas y vinculadas. Conserva todas las verificaciones V10: fechas exactas con zona y respaldo, destinatario y condición de retorno explícitos, origen compatible, advertencias reconocidas, identidad, revisiones, no futuro, no solapamiento y coherencia con baja terminal.

No reconstruye automáticamente un periodo a partir de dos filas. Las referencias documentales son declaraciones verificadas por el revisor: la API no descarga ni certifica documentos. Un día del Excel no autoriza inventar medianoche ni usar fecha/año de recepción como baja.

No modifica estado, activo/inactivo, metadatos, fecha de baja o asignación vigente del equipo. Tampoco modifica cantidades, movimientos, usuarios, lotes, revisiones o evidencia capturada. `returnStatus` describe el retorno antiguo; no vuelve a aplicarse al estado actual. La historia puede ser anterior a una asignación vigente o a una baja confirmada, sin cerrarlas ni reactivarlas.

## Rutas y permisos

| Método y ruta | Acceso | Resultado |
| --- | --- | --- |
| POST `/assets/:id/imported-assignment-plan` | JEFE + CSRF | Plan V10, ahora verifica evidencia ya consumida. |
| POST `/assets/:id/imported-assignment-plan/apply` | JEFE + CSRF | 201 nueva aplicación; 200 recuperación idempotente. |
| GET `/assets/:id/imported-assignment-applications` | JEFE | Metadatos paginados de comprobantes de ese activo. |
| GET `/assets/:id/imported-assignment-applications/:applicationId` | JEFE | Comprobante completo, estrictamente limitado al activo. |

Los parámetros son UUID. Las lecturas no requieren CSRF; la aplicación usa el límite HTTP estándar de la API. No hay PATCH/DELETE de comprobantes ni de asignaciones históricas cerradas.

## Request de aplicación

```json
{
  "requestId": "<uuid estable del intento>",
  "planId": "<sha256 del plan recién revisado>",
  "confirmation": "APPLY_CLOSED_ASSIGNMENT_HISTORY",
  "plan": {
    "periods": [
      {
        "periodId": "<uuid de propuesta>",
        "confirmation": "VERIFIED_CLOSED_ASSIGNMENT",
        "start": {
          "evidenceId": "<evidencia V9 de uso/préstamo>",
          "confirmedAt": "2001-01-01T09:00:00-03:00",
          "dateEvidenceReference": "Respaldo de fecha, hora y zona de entrega"
        },
        "end": {
          "evidenceId": "<otra evidencia V9 de recepción/uso>",
          "confirmedAt": "2002-01-01T10:00:00-03:00",
          "dateEvidenceReference": "Respaldo de fecha, hora y zona de devolución"
        },
        "recipient": { "type": "OFFICE", "name": "Oficina central" },
        "assignmentType": "STANDARD",
        "returnStatus": "UNDER_REVIEW",
        "note": "Periodo cerrado verificado",
        "evidenceReference": "Respaldo de destinatario, entrega y retorno",
        "acknowledgedWarnings": []
      }
    ]
  }
}
```

`plan` es el request V10 normalizado, **no su respuesta con snapshots**. Se mantienen los mismos límites, confirmación por periodo y UUID de propuesta. `requestId` UUID normalizado a minúsculas; `planId` SHA256 minúsculo de 64 caracteres. La confirmación exterior es distinta de la del periodo. Request estricto: no `force`, `importedHistory`, actores históricos, estado actual ni snapshots aportados por cliente.

Reintentar tras timeout con exactamente la misma intención y clave; no generar otro UUID ni reconstruir llamadas CRUD. Reordenar periodos y reconocimientos de advertencias no cambia intención. Cambiar respaldo, periodos o planId, o usar la clave con otro actor, devuelve conflicto. La clave se limita a activo/requestId y liga la intención y al usuario aplicador. Un resultado ya confirmado se recupera incluso si después cambian metadatos/origen; el reintento no aplica de nuevo la historia.

## Transacción, vigencia y duplicados

Reevalúa V10 bajo bloqueo de las fuentes seleccionadas, del activo y de su producto. Las rutas de corrección/identidad/evidencia/piloto comparten la llave de fuente; los hashes se bloquean en orden para evitar inversión entre varias fuentes. El producto se bloquea para impedir que cambie durante la comprobación. Las escrituras de asignaciones se serializan por activo también mediante guarda SQL.

Un único commit guarda encabezado, asignaciones cerradas, periodos con su propuesta exacta, propiedad de cada evidencia y auditorías. Un fallo de cualquier periodo/auditoría revierte todo; no quedan periodos parcialmente aplicados ni claves consumidas. Espera de locks limitada a 3s, transacción hasta 15s y adquisición de conexión hasta 5s. Un conflicto de ocupación requiere reintento seguro, no desbloqueo forzado.

Cada observación V9 puede ser extremo de **un solo periodo aplicado**, globalmente, aunque otro intento quiera usarla en el extremo opuesto. `ImportAssignmentEvidenceUse.evidenceId` es clave primaria; además hay unicidad item/endpoint. Comprobantes tienen planId único y activo/requestId único, e items aplicación/periodo y asignación únicos. No basta con separar unicidades de inicio y fin.

El plan incorpora `ENDPOINT_EVIDENCE_ALREADY_APPLIED`, con endpoint y relatedId del item propietario. La aplicación lo comprueba antes de revalidar el hash y devuelve `HISTORICAL_EVIDENCE_ALREADY_APPLIED` con `{evidenceId,item:{applicationId,assignmentId}}`. Periodos de fuentes no consumidas requieren un plan nuevo después de ampliar la historia.

La base también exige historia importada cerrada/pasada, sin actores/personId/retorno previsto, con comprobante completo y dos extremos válidos; propuesta y datos persistidos deben coincidir. Rechaza solapamientos y cambios al estado del equipo en la misma transacción. El motor V10 en el servicio realiza las verificaciones completas de origen, advertencias y respaldo; estas guardas SQL no son un segundo motor de interpretación del Excel.

## Respuesta y consultas

Aplicación/recuperación devuelven:

```json
{
  "scope": "CLOSED_ASSIGNMENT_HISTORY",
  "mode": "APPLIED",
  "affectsCurrentState": false,
  "persisted": true,
  "reused": false,
  "application": {
    "id": "<uuid>",
    "assetId": "<uuid>",
    "requestId": "<uuid>",
    "requestDigest": "<sha256>",
    "planId": "<sha256>",
    "rulesVersion": "mda-closed-assignment-plan-1",
    "plan": {},
    "appliedById": "<usuario actual que registra la historia>",
    "appliedAt": "<instante de captura del servidor>",
    "items": []
  }
}
```

`application.plan` conserva la respuesta completa del plan revalidado. Cada item contiene id/applicationId/periodId/assignmentId/startEvidenceId/endEvidenceId/snapshot y `assignment` persistida. Snapshot es el periodo exacto con su procedencia, respaldo y advertencias. Las celdas originales completas permanecen en el comprobante V9, accesible por sus IDs; no se alteran.

GET detalle tiene la misma envoltura sin `reused`. GET lista devuelve `{scope,affectsCurrentState,applications,total,limit,offset,hasMore}`; cada elemento solo id/assetId/requestId/planId/rulesVersion/appliedById/appliedAt, sin plan/items. `limit` default25, máximo100; `offset` default0, máximo2147483647 como en V9. Orden appliedAt descendente y luego id descendente. Un comprobante de otro activo devuelve404.

## Compatibilidad de lecturas e identidad del capturador

Assignment añade `importedHistory` (defaultfalse) y relación `importHistory` (null en operaciones comunes). Para historia importada, `createdById`, `createdBy`, `endedById`, `endedBy` y `personId` son null: el Excel no identifica al ejecutor antiguo. No crear cuentas ni atribuir entrega/devolución al revisor. `createdAt` y `returnRecordedAt` son la captura V11; `startedAt` y `endedAt` son los instantes históricos confirmados.

GET assignments —global, detalle y por activo— añade `importHistory:{id,applicationId,periodId,startEvidenceId,endEvidenceId,application:{appliedById,appliedAt}}` o null. Frontend debe admitir createdBy null y mostrar «ejecutor histórico desconocido» separado de «registrado por». La asignación vigente nunca es uno de estos periodos cerrados.

GET `/assets/:id/history` añade a ambos eventos importados `source:"IMPORTED_HISTORY"`, `importApplicationId` y `recordedById`; `actor:null`. Conserva `effectiveAt` histórico y `recordedAt` de captura. Las operaciones normales conservan actores conocidos y no llevan estos extras. El límite previo de 200 registros por fuente en esa vista no se amplía; usar listas paginadas de assignments y comprobantes para navegación completa.

Las asignaciones normales siguen exigiendo creadoPor y cerradoPor válidos al cerrar. Sus DTO rechazan importedHistory; no se abre un bypass de V2 por hacer nullable la columna para historia importada. Los periodos cerrados y sus comprobantes/propiedad son inmutables. Corregir una carga histórica exige diseñar enmienda trazable, no DELETE/UPDATE directo.

Auditoría por periodo: `IMPORT_CLOSED_ASSIGNMENT_ADDED`, entidad Assignment, con historicalActorsKnown=false y referencia al comprobante. Auditoría conjunta: `IMPORT_CLOSED_ASSIGNMENTS_APPLIED`, entidad ImportAssignmentApplication. El usuario de ambas es el aplicador real, no un supuesto ejecutor antiguo.

## Errores

- 400 VALIDATION_ERROR: DTO, UUID, confirmación, huella o campos no admitidos.
- 401/403: sesión, JEFE o CSRF insuficiente.
- 404 NOT_FOUND: activo/evidencia/comprobante inexistente o comprobante fuera del activo.
- 409 IDEMPOTENCY_KEY_REUSED: clave ya ligada a otra intención o actor.
- 409 HISTORICAL_EVIDENCE_ALREADY_APPLIED: uno de los extremos pertenece a un periodo aplicado.
- 409 HISTORICAL_PLAN_CHANGED: plan vigente difiere; regenerar y revisar, no reutilizar confirmación automáticamente.
- 409 HISTORICAL_PLAN_BLOCKED: huella vigente pero periodos bloqueados; details.periods contiene periodId/blockers.
- 409 HISTORICAL_APPLICATION_CONFLICT: conflicto de unicidad; consultar comprobante o regenerar plan.
- 409 HISTORICAL_APPLICATION_BUSY: lock/concurrencia/timeout; recuperar o reintentar misma clave/intención.
- Errores de evidencia/revisión/límites V10 siguen vigentes; no se trunca historia ni se eluden bloqueos.
- 503 IMPORT_REVIEW_NOT_READY: almacenamiento de importación pendiente; completar despliegue planificado, no persistir mediante CRUD alternativo.

## Migración y validación

0020 añade tres tablas y el marcador importedHistory=false, hace nullable createdById y sustituye su restricción por una que distingue operaciones normales de historia importada con comprobante. No cambia datos previos ni asigna ejecutores ficticios. La prueba de migración ejecuta sus 24 sentencias DDL sobre tablas pobladas en un schema temporal, verifica la fila previa/defaultfalse y almacenamiento vacío y revierte ese schema. No se aplicó esta migración a la base operativa.

334 pruebas API/unitarias/migración aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas17 nuevas V11 (3 unitarias y14 integración). Cubren permisos, comprobantes, actores desconocidos/capturador, estado actual intacto, solicitudes concurrentes iguales/distintas, uso de evidencia entre roles, vigencia, paginación, rollback y reintento, locks acotados, almacenamiento ausente, guardas SQL y migración poblada. Las15 unitarias de plan/aplicación V10/V11 pasaron también empaquetadas temporalmente en Node24.19 Windows. Prisma validado/generado, compilación API, lint acotado y diff-check correctos.

El runner serializa archivos que comparten una base y hacen pruebas de bloqueos globales; las pruebas de peticiones concurrentes de cada archivo se conservan. La primera ejecución paralela produjo un IMPORT_APPLY_BUSY legítimo en un test anterior mientras el test nuevo retenía un lock; no se relajó su expectativa ni se alteró el timeout productivo. La suite completa PostgreSQL sigue ejecutándose en Node26 WSL; las unitarias Node24 no sustituyen la verificación completa del runtime soportado antes de despliegue. Más pendientes en [plan backend](backend.md).

Sigue pendiente enmienda/vínculo posterior de evidencia, bajas históricas con fechas inciertas, Tintas, identidades que requieren reagrupación e integración frontend. Antes de una carga real: entorno autorizado, respaldo verificado, migraciones/cliente/API coordinados, pruebas completas Node24, piloto y conciliación. Disponer de V11 no autoriza cargar todas las hojas ni decidir precedencias de datos ambiguos.
