# Contrato API V30: conciliación documental de terminales existentes

Extensión posterior [V32](contrato-api-v32.md): flujo propio para fuentes internas de grupos, sin relajar reservas/consumos de V30. Ambos almacenes impiden duplicar una misma evidencia/versión; el plan V30 informa RETIREMENT_DOCUMENT_ALREADY_RECONCILED también para un comprobante agrupado previo. El backend actualizado requiere0031 y cliente Prisma regenerado, incluidas estas lecturas; la migración0030 original no se modifica.

Estado al2026-10-20: implementación backend; no desplegada, sin carga del Excel ni cambios frontend. Migración0030 aditiva preparada para comprobantes documentales, sin backfill. Requiere las migraciones previas hasta0029 y cliente Prisma actualizado. No modifica los contratos de aplicación V14/V29 ni habilita bajas operativas sin fecha comprobable.

## Política y alcance

Reglas propuestas al usuario y aceptadas mediante «continúa»: una baja del Excel sin fecha comprobable se conserva como antecedente pendiente, sin retirar automáticamente un equipo no terminal. Si el equipo ya está dado de baja, puede registrarse una conciliación documental auditada que conserva íntegros su estado y su fecha, incluso cuando esta última sea null. Las discrepancias requieren revisión, no una fecha inventada ni una segunda baja.

El comprobante V30 asocia la versión concreta de una observación archivada con el estado terminal revisado en ese momento. No es un comprobante de ejecución de retiro. No cambia Asset, updatedAt, identidad, metadatos, fechas, asignaciones, movimientos, stock, origen, revisiones ni archivo. Solo escribe un comprobante propio y su auditoría en una transacción.

La evidencia debe ser RETIREMENT_OBSERVATION, tener vínculo vigente explícito al mismo activo e identidad compatible. Un vínculo ausente o incorrecto exige revisión independiente V12 cuando corresponda; V30 no lo establece automáticamente. Fuentes reservadas o consumidas por agrupación quedan bloqueadas por las reglas existentes. Conciliar las observaciones internas de esos grupos requiere un flujo propio; sí puede documentarse una fuente independiente adicional sobre un activo retirado previamente por V29.

## Planificación sin escritura

`POST /assets/:id/imported-retirement-document-plan`, JEFE+CSRF.

```json
{
  "evidenceId": "00000000-0000-4000-8000-000000000001",
  "note": "Se revisó este antecedente frente a la baja existente",
  "evidenceReference": "Referencia del documento archivado",
  "acknowledgedWarnings": []
}
```

DTO estricto: UUID normalizado, note1–2000 caracteres, evidenceReference1–500, hasta1000 huellas de advertencias únicas. No acepta fechas, estado, force, snapshots, actor ni confirmaciones de otros flujos. Las advertencias deben reconocerse exactamente; no anulan bloqueantes.

Respuesta200: scope=EXISTING_RETIREMENT_DOCUMENT_RECONCILIATION, mode=RETIREMENT_DOCUMENT_PLAN, planId, rulesVersion=mda-retirement-document-1, checkedAsOf, request normalizado, assetBefore completo, productBefore, source/versiones/procedencia/huella de snapshot, huellas de historia efectiva y revisiones, existingRetirement, sourceRetirement, warnings, blockers y planValidationComplete. canApply/persisted/affectsCurrentState/confirmsSourceDate/consumesOperationalEvidence/historicalActorKnown son false, incluso cuando el plan está completo.

existingRetirement conserva effectiveAt actual (incluido null), datePrecision UNKNOWN|INSTANT, dateOrigin CURRENT_ASSET|VERIFIED_IMPORT_RECEIPT|GROUP_VERIFIED_IMPORT_RECEIPT y referencias separadas legacyApplicationId/groupApplicationId; es null si el activo no es terminal. sourceRetirement sigue `{effectiveAt:null,datePrecision:"UNKNOWN",historicalActorId:null}`; es null si la observación no es de baja y se informa el bloqueante de tipo. La fecha existente jamás confirma la fecha de la observación Excel.

Exige terminal coherente DECOMMISSIONED/isActive=false y producto físico ASSET; fecha actual no futura ni anterior a1900 cuando existe; ausencia de custodia abierta, periodos inválidos o posteriores a una fecha terminal conocida; compatibilidad con comprobantes V14/V29; fuente vigente y sin BLOCKING; observación no utilizada para aplicar historia/retiro y versión todavía no conciliada. La fecha de recepción se conserva como tal y una recepción posterior a la fecha terminal conocida señala conflicto, no la corrige. No exige inventar fecha/prueba exacta para esta asociación exclusivamente documental.

Un activo no terminal obtiene EXISTING_TERMINAL_RETIREMENT_REQUIRED: su observación sigue archivada/pendiente, sin cambio de disponibilidad. Otros bloqueantes propios incluyen CURRENT_RETIREMENT_DATE_UNCONFIRMED, CURRENT_RETIREMENT_BEFORE_SOURCE_RECEIPT, CURRENT_CUSTODY_REQUIRES_REVIEW, IMPORTED_RETIREMENT_STATE_CONFLICT y RETIREMENT_DOCUMENT_ALREADY_RECONCILED. Permanecen las incidencias originales de identidad/fuente/versiones/advertencias.

Lectura REPEATABLE READ, límites previos10000 asignaciones/1000 revisiones, timeout15s; error explícito, sin truncamiento silencioso. Historia efectiva consulta V27, no fechas originales ya rectificadas.

## Confirmación explícita documental

`POST /assets/:id/imported-retirement-document-plan/confirm`, JEFE+CSRF.

```json
{
  "requestId": "00000000-0000-4000-8000-000000000002",
  "planId": "huella SHA-256 devuelta por el plan revisado",
  "confirmation": "RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY",
  "plan": {
    "evidenceId": "00000000-0000-4000-8000-000000000001",
    "note": "Se revisó este antecedente frente a la baja existente",
    "evidenceReference": "Referencia del documento archivado",
    "acknowledgedWarnings": []
  }
}
```

planId real son64 caracteres hexadecimales; el ejemplo explica su procedencia. Se envía la misma intención revisada, nunca la respuesta completa ni una fecha sustituta.

201 nuevo/200 reintento recuperado: mode=DOCUMENT_RECONCILED, persisted=true, reused, reconciliation. Todas las banderas de efecto/confirmación de fecha/consumo operativo siguen false. recordedAt/recordedById identifican captura y revisor, no retiro ni ejecutor histórico.

READ COMMITTED, bloqueo asesor de fuente y bloqueos EXCLUSIVE NOWAIT de contexto; revalida rol configurado y activo, contexto, advertencias y huella. Conflictos:409 RETIREMENT_DOCUMENT_BLOCKED, RETIREMENT_DOCUMENT_PLAN_CHANGED, RETIREMENT_DOCUMENT_CONFLICT o RETIREMENT_DOCUMENT_BUSY. Ante contención o respuesta incierta, conservar requestId/intención y recuperar. La misma clave con actor/intención distintos da409 IDEMPOTENCY_KEY_REUSED. Una versión de evidencia solo admite un comprobante documental global; cambiar requestId no duplica la asociación.

El comprobante y auditoría IMPORT_RETIREMENT_DOCUMENT_RECONCILED son atómicos e inmutables. Guards SQL comprueban rol, terminal previo sin escritura del activo en esa transacción, fuente/versiones/identidad/reservas/consumos, snapshots y procedencia exactos, contexto temporal/huellas, intención/advertencias y auditoría diferida. Los cambios del activo/contexto/auditoría después de adelantar constraints también se bloquean dentro de la transacción de captura. La migración no aplica retiros ni reescribe registros existentes.

## Consulta y conservación de versiones

- `GET /assets/:id/imported-retirement-documents?limit=25&offset=0`: JEFE, reconciliations con metadatos sin plan, total, limit, offset y hasMore. limit1–100, offset no negativo; parámetros estrictos.
- `GET /assets/:id/imported-retirement-documents/:reconciliationId`: JEFE, comprobante completo e inmutable, solo para su activo exacto;404 con padre incorrecto.

El registro no consume la observación como acontecimiento operativo ni bloquea para siempre sus enmiendas documentales V12 admisibles. Una enmienda explícita posterior conserva el comprobante de la versión anterior; no lo actualiza ni lo convierte en vínculo vigente. Una nueva versión requiere un nuevo plan/revisión/comprobante. Los reintentos originales siguen recuperando exactamente la captura original, aunque haya versiones o metadatos posteriores. Mostrar claramente versión capturada frente a versión actual; un comprobante histórico no prueba que el vínculo siga vigente hoy.

401/403 para autenticación/rol/CSRF,400 para DTO inválido,404 para referencias ausentes o padres incorrectos. Fuentes reservadas/consumidas conservan409 propios. Almacenamiento no instalado devuelve503 IMPORT_REVIEW_NOT_READY, no una consulta vacía exitosa.

## Verificación

746 pruebas aprobadas,0 fallos/omitidas/canceladas,193.421s en Node24.22.0 Linux/PostgreSQL18.6 independiente.20 nuevas (2 unitarias/17 integración/1 migración), suite completa repetida tras reforzar la auditoría SQL de la misma transacción. Build API forzado, lint completo API/tests, Prisma validate/generate y whitespace correctos. Base descartable eliminada, cero restantes y servidor temporal detenido. La migración se verificó también sobre un schema poblado, sin reescritura de filas. Detalles en [informe](verificacion-backend-node24.md); no equivale a despliegue ni carga real.

## Traspaso frontend y límites pendientes

No se modificó frontend ni se contactó al otro chat. Integración futura: presentar «Conciliar antecedente de baja existente», comparar estado/fecha actuales con fecha fuente desconocida, mostrar conflictos y advertencias, y confirmar con el literal documental propio. No usar V14/V29 ni `/decommission` para simularlo. No ofrecer una operación de baja sin fecha sobre activos no terminales; conservar el archivo pendiente. Consultar los comprobantes documentales por sus rutas propias, no como eventos de ejecución de retiro.

Instalar0030 y generar Prisma antes de usar estas rutas; `pnpm db:migrate` instala las migraciones pendientes, sin que este bloque lo ejecute sobre operativa. V15 conserva su diagnóstico original sin cambiar clasificaciones ni adquirir escritura implícita.

Extensión posterior [V31](contrato-api-v31.md): permite consultar la conciliación de fuentes internas de grupos activos o cancelados, conservando reservas/consumos/procedencia y sin nueva autoridad ni guardado. Sigue pendiente la confirmación documental propia de esos grupos, junto a correcciones legacy/documentales aplicadas, significado/unidad/stock de Tintas e integración/piloto del workbook real autorizado con respaldo y conciliación. No se declara completa la carga del Excel ni el backend global.
