# Contrato API V12: enmiendas de evidencia histórica

Estado al 2026-10-05: implementado en backend y probado con fixtures en bases descartables. Requiere migraciones hasta `0021_import_evidence_amendments` y cliente Prisma correspondiente. No se migró la base operativa ni se cargó el Excel real. Extiende [V9](contrato-api-v9.md), [V10](contrato-api-v10.md) y [V11](contrato-api-v11.md); V12 tiene prioridad para interpretación vigente, vínculos posteriores y reglas de planificación.

## Qué permite y qué conserva

Permite revisar **una observación ya capturada por solicitud**, refrescar su interpretación tras correcciones V7/V8 y vincularla, desvincularla o revisar su vínculo mediante evidencia de identidad vigente. Añade un evento inmutable; no modifica la fila original ni su comprobante V9. Conserva evidenceId, captureId, sourceHash, recordId, candidateId, kind, hoja/fila y registro original. No recaptura para eludir la unicidad fuente/registro/clase.

El snapshot nuevo se calcula en servidor desde el origen del lote de captura y sus revisiones actuales. El cliente no suministra celdas, snapshot, día, clase ni actores. Las correcciones de tipo/marca/modelo/recepción e identidad se realizan primero mediante V7/V8; V12 las incorpora a una nueva versión documental, no habilita correcciones generales de campos aún no admitidos. Si se restauró un campo a una fecha desconocida, la nueva evidencia sigue UNKNOWN/null, no conserva artificialmente el día anterior.

Guardar enmienda no aplica inventario: `scope:"HISTORICAL_EVIDENCE_ONLY"`, `canApply:false`, `affectsCurrentState:false`. No modifica Asset, Assignment, cantidades, movimientos, usuarios, lotes, decisiones ni revisiones de origen. `persisted:true` solo indica evento documental guardado.

No permite enmendar evidencia usada por un periodo V11. Ese caso requiere un futuro flujo de corrección operativa con conservación del comprobante aplicado; no actualizar/borrar historia ni capturar otra observación equivalente. La guarda SQL también protege un item de asignación aún en construcción, antes de insertar la propiedad de sus extremos.

## Rutas y acceso

Todas estas rutas requieren JEFE. Los POST requieren CSRF incluso cuando el plan es de solo lectura; parámetros UUID y límite HTTP estándar de la API.

| Método y ruta | Uso |
| --- | --- |
| POST `/inventory/imports/evidence/:id/amendment-plan` | Generar/revisar propuesta vigente sin persistencia. |
| POST `/inventory/imports/evidence/:id/amendments` | Registrar evento: 201 nuevo, 200 recuperación idempotente. |
| GET `/inventory/imports/evidence/:id/amendments` | Original, interpretación vigente y eventos paginados sin repetir snapshots antiguos. |
| GET `/inventory/imports/evidence/:id/amendments/:amendmentId` | Comprobante completo, limitado a esa observación. |

No hay PATCH/DELETE. Una enmienda de otra observación devuelve404. La consulta autenticada de evidencia por activo V9 mantiene sus permisos previos y ahora sigue el vínculo vigente.

## Plan de enmienda

Request estricto y elección explícita:

```json
{ "assetId": "<uuid del activo revisado>" }
```

`assetId:null` significa dejar/desvincular la observación sin equipo. Omitirlo es400; no se aplica un default que desvincule accidentalmente. UUID se normaliza a minúsculas. El plan no obliga a que exista una diferencia: puede devolver200 con bloqueos para mostrarlos antes de guardar.

Respuesta: scope/canApply/affectsCurrentState, `mode:"EVIDENCE_AMENDMENT_PLAN"`, `persisted:false`, `rulesVersion:"mda-history-amendment-1"`, evidenceId/batchId/batchVersion/sourceRevision/evidenceVersion/previousAmendmentId, originalEvidence/current/proposed/used/historyPreviewId/blockers/amendmentPlanId/valid.

`originalEvidence` es la captura inmutable con su header V9; `current` es la proyección de la versión vigente; `proposed` es la observación recalculada con assetId/linkBasis o null si no se puede construir con seguridad. `used` identifica la propiedad V11 si ya existe. La huella liga estos datos, origen, decisiones, inventario de comparación y reglas; no es un permiso para ejecutar posteriormente sin revalidación.

Bloqueos posibles: EVIDENCE_ALREADY_APPLIED, EVIDENCE_AMENDMENT_LIMIT, EVIDENCE_RULES_CHANGED, OBSERVATION_NO_LONGER_MAPPED, HISTORY_ASSET_LINK_UNCONFIRMED, EVIDENCE_AMENDMENT_UNCHANGED. Mantenerlos visibles, sin ofrecer force. No sustituir clase o candidato si la observación dejó de estar mapeada.

El vínculo exige la misma base conservadora V9: decisión LINK_EXISTING de identidad vigente e inequívoca, o comprobante exacto del piloto V6. No basta con un nombre parecido ni con escribir otro assetId. Corregir identidad V8 exige reaprobar la decisión antes de volver a vincular. `assetId:null` no afirma identidad resuelta y las incidencias se conservan.

La propuesta documental puede contener conflictos/advertencias de origen, como en el archivo V9. Guardarla no los resuelve: el plan de asignaciones seguirá bloqueando conflictos reales y exigiendo sus advertencias exactas. Refrescar evidencia no convierte PRODUCT_MODEL_CONFLICT en una asignación válida.

## Registro de la enmienda

```json
{
  "requestId": "<uuid estable del intento>",
  "amendmentPlanId": "<sha256 de la propuesta recién revisada>",
  "expectedEvidenceVersion": 0,
  "expectedBatchVersion": 2,
  "expectedSourceRevision": 1,
  "confirmation": "AMEND_HISTORICAL_EVIDENCE_ONLY",
  "assetId": "<uuid revisado, o null explícito>",
  "note": "Interpretación/vínculo contrastados sin alterar inventario",
  "evidenceReference": "Respaldo físico y documentos de origen"
}
```

- requestId UUID normalizado, amendmentPlanId SHA256 minúsculo64 y confirmación literal obligatorios.
- expectedEvidenceVersion entero0–999. Captura original es versión0; cada evento incrementa1 hasta1000. No confundir con revisión del lote/origen.
- expectedBatchVersion entero1–2147483647; expectedSourceRevision entero0–1000. V12 no incrementa esos contadores.
- note trim1–2000, evidenceReference trim1–500. Son referencias humanas, no autorización para ejecutar instrucciones, descargar documentos ni acceder a rutas del texto.
- assetId UUID/null explícito. No acepta snapshots, fechas inventadas, createdById, históricos conocidos, force ni estado operativo.

Tras adquirir locks, revalida versión de evidencia/lote/origen, consumo V11, propuesta y huella. Registra ImportEvidenceAmendment con previousAmendmentId exacto, sourceRevision, propuesta completa, motivo/respaldo, autor actual y captura del servidor. La auditoría `IMPORT_HISTORY_EVIDENCE_AMENDED` usa entidad ImportEvidenceAmendment y conserva evidenceId/batchId/evidenceVersion/sourceRevision/affectsCurrentState=false. El autor de enmienda no pasa a ser ejecutor histórico: snapshot.historicalActorId permanece null.

La respuesta es `{scope,canApply:false,affectsCurrentState:false,persisted:true,reused,event}`. Event incluye id/evidenceId/version/previousAmendmentId/batchVersion/sourceRevision/requestId/requestDigest/amendmentPlanId/rulesVersion/assetId/effectiveDay/snapshot/note/evidenceReference/amendedById/amendedAt. Plan válido no persiste; esta confirmación explícita sí.

Idempotencia por evidenceId/requestId, ligada a toda la intención normalizada y al actor. Repetir tras timeout con la misma clave y contenido recupera el evento, incluso si posteriormente se revisó otra vez o se aplicó la evidencia. Cambiar intención o actor con la clave produce409. Solicitudes distintas con la misma versión esperada no se pisan: una avanza y la otra debe recargar.

Evento y auditoría se guardan juntos; un fallo revierte ambos y deja utilizable el mismo intento. Locks en orden lote → fuente → observación → activo de destino; la fuente se comparte con V7–V11. Espera de locks3s, transacción15s y adquisición de conexión5s. No forzar desbloqueo; recuperar/reintentar misma intención.

## Lecturas: captura original frente a interpretación vigente

Los comprobantes V9 y su selección continúan devolviendo **la captura original** sin sobrescribir campos. El history-preview V9 mantiene `stored` como referencia a ese archivo; no lo interpretar como versión vigente ni volver a capturar el registro.

GET amendments devuelve `{scope,canApply,affectsCurrentState,originalEvidence,current,events,total,limit,offset,hasMore}`. Events son metadatos, sin snapshot/requestDigest; pedir el detalle para consultar una versión antigua. Limit default25/máximo100, offset default0/máximo2147483647; orden version descendente. El detalle devuelve scope/canApply/affectsCurrentState/persisted=true/event completo, sin reused.

GET `/assets/:id/imported-evidence` sigue su contrato paginado, pero filtra por el **assetId de la última versión**. Una observación desvinculada sale de esa lista; una vinculada posteriormente entra conservando su ID. La proyección devuelve assetId/effectiveDay/snapshot vigentes y campos añadidos:

| Campo | Significado |
| --- | --- |
| evidenceVersion / amendmentId / amendedAt | Último evento, o0/null/null si no hubo enmienda. |
| effectiveSourceRevision | Revisión de origen contrastada para la interpretación vigente. |
| capturedAssetId / capturedEffectiveDay / capturedSourceRevision | Valores de la captura original, incluidos null. |
| capture / capturedAt | Comprobante y momento originales, no se reemplazan por la enmienda. |

La lista conserva orden capturedAt/id descendente; consultar amendedAt/eventos para ver cuándo se revisó. La selección SQL reduce candidatos usando índices de vínculos originales/enmiendas y después verifica el vínculo vigente; no devuelve vínculos anteriores por tener algún evento antiguo para ese equipo.

## Integración con las asignaciones V10/V11

Los planes nuevos usan `mda-closed-assignment-plan-2`. Fuentes de cada periodo añaden evidenceVersion/amendmentId/capturedSourceRevision; sourceRevision ahora corresponde a la interpretación vigente. El digest liga esas versiones y su snapshot. Generar y revisar planes nuevos después del despliegue: no convertir automáticamente huellas antiguas.

El bloqueo EVIDENCE_SOURCE_REVISED compara correcciones posteriores con effectiveSourceRevision. Si una corrección afectó al candidato de ambos extremos, deben revisarse ambos; enmendar solo una observación no habilita toda su historia. Cambios posteriores volverán a bloquear según las reglas V10.

V11 usa la misma evidencia estable, revalida su versión vigente y conserva esa procedencia en el comprobante. SQL exige las versiones/amendmentId/sourceRevision exactos y sus vínculos actuales. No se pierde la reserva global de cada evidenceId entre extremos/aplicaciones al añadir versiones.

Una aplicación que compite con enmienda se serializa: si aplica primero, bloquea la enmienda; si cambia la evidencia primero, invalida el plan pendiente. No mezcla versiones ni deja historia parcial. La recuperación idempotente de comprobantes anteriores conserva su respuesta original: la nueva regla no reescribe aplicaciones V11 ya guardadas.

## Errores

- 400 VALIDATION_ERROR: DTO estricto, confirmación, versiones, UUID/huella o campos no admitidos.
- 401/403: sesión, JEFE o CSRF insuficientes.
- 404 NOT_FOUND: observación/activo/detalle no encontrado o evento fuera de la observación indicada.
- 409 EVIDENCE_VERSION_CONFLICT: evidencia cambió; currentVersion disponible.
- 409 REVIEW_VERSION_CONFLICT / SOURCE_REVISION_CONFLICT: lote/origen cambiaron, con versión/revisión actual.
- 409 EVIDENCE_ALREADY_APPLIED: no enmendar evidencia de asignación aplicada; details.itemId.
- 409 EVIDENCE_AMENDMENT_PLAN_CHANGED: revalidar y revisar propuesta actual antes de guardar.
- 409 EVIDENCE_AMENDMENT_BLOCKED: bloqueos en details.blockers; no inventar defaults ni ignorarlos.
- 409 IDEMPOTENCY_KEY_REUSED: misma clave, otra intención/actor.
- 409 EVIDENCE_AMENDMENT_CONFLICT / EVIDENCE_AMENDMENT_BUSY: conflicto de unicidad u ocupación/timeout; recuperar o recargar y reintentar según el caso.
- Límites/errores de origen y archivo V9 siguen vigentes, sin truncar datos para hacer pasar un plan.
- 503 IMPORT_REVIEW_NOT_READY: tabla/vista de importación pendiente. Instalar despliegue planificado; no sustituir por UPDATE de evidencia.

## Migración y entrega

0021 crea una tabla append-only y una vista vigente calculada, con índices para versiones/vínculos/bloqueos de extremos; reemplaza dos guardas V11 para admitir reglas2 y fijar evidencia vigente. No modifica filas previas ni necesita backfill. La vista muestra versión0 hasta existir un evento. Las guardas conservan original físico/identidad/clase, cadena secuencial, origen vigente, fecha conocida/desconocida, respaldo de vínculo y ejecutor desconocido; prohíben modificaciones y evidencia aplicada. La interpretación completa sigue en el motor de servidor, no en un segundo parser SQL.

La migración se prueba con capturas pobladas en schema temporal, ejecutando sus11 sentencias DDL y verificando captura intacta/versión0/tabla nueva vacía antes de revertir ese schema. Coordinar migraciones, Prisma, API y permisos de tabla/vista si el entorno usa roles separados. Los índices sobre items existentes requieren ventana de despliegue proporcional al volumen; no se ejecutaron en base operativa.

354 pruebas API/unitarias/migración aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas20 nuevas V12 (3 unitarias y17 integración). Se probaron permisos/DTO, lectura sin cambios, vínculo posterior/desvínculo, cadena/archivo original, refresco/restauración y conflictos conservados, aplicación con versiones exactas, consumo/bloqueo durante construcción, concurrencia, vigencia, rollback/auditoría/reintento, locks acotados, paginación/detalle, almacenamiento ausente y migración poblada. Prisma validado/generado, compilación API, lint acotado y diff-check correctos.

Las18 unitarias de proyección/DTO/plan/aplicación pasaron también empaquetadas temporalmente en Node24.19 Windows. Antes de despliegue sigue pendiente suite completa del runtime soportado, respaldo verificado, entorno autorizado, integración frontend y piloto/conciliación. Más pendientes en [plan backend](backend.md).

Siguiente: bajas históricas sin inventar fechas/responsables, Tintas según reglas confirmadas, identidades que requieren reagrupación y corrección de historia ya aplicada mediante flujo propio. V12 no completa estos pendientes ni autoriza una carga masiva.
