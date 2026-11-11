# Contrato API V28 — revisión de bajas de grupos físicos

Fecha:2026-10-20. Plan de baja histórica verificada para un equipo existente seleccionado mediante revisión de identidad V17/V18 y decisión V19. Solo lectura: no retira equipos, guarda vínculos, consume filas ni crea comprobantes operativos. Sin migración ni dependencia nueva. La versión actual del backend sigue requiriendo0028, incluida la vista efectiva V27.

Validación final:706 pruebas aprobadas,0 fallos/omitidas/canceladas, Node24.22.0/PostgreSQL18.6,174.783s;20 nuevas (11 unitarias/9 integración). Build API forzado, lint API/tests completo, Prisma validate y whitespace correctos. [Informe Node24](verificacion-backend-node24.md). No acredita despliegue, integración ni carga del Excel.

## Por qué este flujo parte de una revisión, no de V21/V23

Actualización V29: [V29](contrato-api-v29.md) añade confirmación explícita, comprobantes y consumo permanente con migración0029. V28 conserva su planificación de lectura y todas sus banderas false. Las afirmaciones siguientes de ausencia de `/apply` describen el alcance original V28, no la capacidad posterior V29; instalar0029 antes de iniciar el backend actualizado, incluidas sus lecturas.

V20/V21 rechazan expresamente cualquier grupo con observaciones de baja: RETIREMENT_REQUIRES_SEPARATE_WORKFLOW, incluso al actualizar metadatos. Por tanto, exigir una aplicación V21 y vínculos V23 para esas filas crearía un prerrequisito imposible. V28 mantiene ese bloqueo y parte de la revisión activa y su última decisión LINK_EXISTING.

La revisión debe sugerir inequívocamente un equipo existente. No crea un equipo dado de baja, ni selecciona uno libremente por assetId, ni reutiliza una propuesta PROPOSE_NEW/HOLD/EXCLUDE como autoridad. El archivo se conserva aunque la identidad revisada sea distinta de la capturada.

V28 no modifica V13/V14/V15 ni amplía su autoridad: los lectores/aplicadores legacy continúan rechazando fuentes reservadas por grupos. No existe `/retirement-plan/apply` para este flujo agrupado.

## Ruta y solicitud

Solo JEFE autenticado, con CSRF. Parámetros UUID normalizados y cuerpo/query estrictos:

```text
POST /inventory/imports/batches/:id/identity-group-reviews/:reviewId/retirement-plan

{
  expectedBatchVersion: entero1..2147483647,
  expectedSourceRevision: entero0..1000,
  expectedDecisionVersion: entero1..2147483647,
  projectionId: SHA256 de effective-preview vigente,
  groupKey: clave estable del grupo dentro de esta revisión,
  decisionId: UUID de su última decisión LINK_EXISTING,
  expectedEvidenceVersion: entero0..1000,
  acknowledgedGroupWarnings:[SHA256,...],
  plan:{
    evidenceId: UUID de una RETIREMENT_OBSERVATION archivada de este grupo,
    confirmation:"VERIFIED_HISTORICAL_RETIREMENT",
    confirmedAt: instante exacto con zona|null,
    dateEvidenceReference: prueba temporal independiente|null,
    note: texto1..2000,
    evidenceReference: texto1..500,
    acknowledgedWarnings:[SHA256,...]
  }
}
```

`acknowledgedGroupWarnings` admite hasta500 IDs únicos y su omisión equivale a[]. Sus avisos pertenecen a la proyección de identidad. `plan.acknowledgedWarnings` pertenece al antecedente histórico V13, hasta1000 IDs únicos; no intercambiar ambas listas ni reutilizar automáticamente los reconocimientos de otro plan.

confirmedAt y dateEvidenceReference pueden omitirse/null para diagnosticar faltantes: no producen una propuesta válida. Mantienen los formatos y límites V13, incluidos instantes desde1900, precisión máxima de milisegundos y prueba temporal de1..500 caracteres. El literal de revisión no es confirmación de escritura.

No admite requestId, assetId, applicationId/itemId V21, linkId V23, snapshots, actor, estado final libre, force ni fechas inferidas. El equipo se deriva de la decisión validada.

## Revalidación y propuesta

Snapshot REPEATABLE READ de fuente/revisión/reservas, proyección actual, últimas decisiones, archivo completo del grupo y última enmienda, equipo/producto, asignaciones efectivas, revisiones de fuente y consumos. Verifica huella e intención de las decisiones guardadas, padres y grupo, versión global, decisión exacta y cobertura explícita de sus antecedentes; una decisión sobre otra proyección requiere revisión nueva.

Cada antecedente conserva sourceHash, captura/lote, recordId/candidateId originales, hoja/fila, snapshot original y versión efectiva. Se valida también la evidencia omitida del grupo; no se concede autoridad por enviar solamente un UUID válido. Un antecedente ajeno devuelve404. Una observación de recepción/uso no es una baja y genera RETIREMENT_EVIDENCE_KIND_REQUIRED.

La identidad propuesta solo se proyecta en memoria con `linkBasis.type=REVIEWED_IDENTITY_GROUP_PROPOSAL`, reviewId y groupId. No es un vínculo V23 ni un grupo aplicado. Un vínculo efectivo previo a otro equipo, un vínculo agrupado ya guardado, filas consumidas o cualquier uso de asignación/baja siguen bloqueados.

Reutiliza las reglas V13: fecha independiente pasada con respaldo, recepción únicamente como límite cronológico, custodia actual cerrada, estado coherente, ausencia de baja existente, historia efectiva no posterior y ninguna incidencia fuente BLOCKING. No convierte conflictos de estado en avisos ni permite force. Los avisos deben reconocerse exactamente y no eliminan bloqueantes.

El día/hora real de baja del Excel sigue UNKNOWN/null. Ni una recepción conocida, ni «Baja2026», ni la fecha del importador prueban la fecha de retiro. Los actores históricos desconocidos siguen null. Un terminal previo, con o sin fecha, requiere conciliación separada; no se reemplaza ni se reactiva.

## Respuesta200

```text
{
  rulesVersion:"mda-group-retirement-plan-1",
  scope:"GROUP_HISTORICAL_RETIREMENT_PLAN",mode:"GROUP_RETIREMENT_REVIEW_ONLY",
  planId,batchId,reviewId,sourceHash,projectionId,groupKey,groupId,
  decisionId,decisionVersion,decisionProofDigest,request,
  checkedAsOf,timeZone:"America/Santiago",assetBefore,sourceRows,
  originalEvidence,currentEvidence,proposedEvidenceProjection,
  source,sourceRetirement:{effectiveAt:null,datePrecision:"UNKNOWN",historicalActorId:null},
  proposedRetirement:{assetId,status:"DECOMMISSIONED",isActive:false,decommissionedAt,historicalActorId:null},
  currentAssignmentsDigest,sourceRevisionsDigest,consumedSourceRows,
  warnings,groupWarnings,blockers,omittedEvidence,summary,
  planValidationComplete,
  persisted:false,canApply:false,affectsCurrentState:false,evidenceRelinked:false,
  operationalHistoryApplied:false,retirementApplicationImplemented:false
}
```

sourceRetirement es null si la observación seleccionada no es de baja; ese plan queda bloqueado. proposedRetirement.decommissionedAt puede ser null si no se aportó fecha exacta. La proyección propuesta nunca sustituye originalEvidence/currentEvidence ni se guarda.

Las banderas siguen false incluso cuando planValidationComplete=true. assetBefore conserva equipo y fechas actuales; no hay auditoría ni mutaciones por solicitar el plan. Cambios en contexto, prueba, motivo/nota o fecha cambian la huella; reordenar avisos reconocidos no cambia la intención.

Límites explícitos:25 últimas decisiones distintas,100 antecedentes,10000 asignaciones y1000 revisiones de fuente. Exceso o corrupción produce conflicto, no una lectura truncada. Las guardas de proyección pueden rechazar antes con sus códigos existentes.

## Errores y traspaso frontend

- 400 VALIDATION_ERROR;401/403 autenticación/JEFE/CSRF;404 lote/revisión/grupo/evidencia/equipo ajenos o ausentes.
- 409 REVIEW_VERSION_CONFLICT, SOURCE_REVISION_CONFLICT, IDENTITY_GROUP_PROJECTION_CHANGED, IDENTITY_GROUP_DECISION_VERSION_CONFLICT: recargar contexto, no forzar.
- 409 GROUP_DECISION_NOT_LATEST o GROUP_DECISION_STALE: revisar/seleccionar una decisión vigente.
- 409 GROUP_RETIREMENT_EXISTING_ASSET_REQUIRED: requiere LINK_EXISTING explícito y equipo único, no creación de terminales.
- 409 INVALID_IDENTITY_GROUP_DECISION, INVALID_HISTORICAL_EVIDENCE, GROUP_RETIREMENT_PLAN_LIMIT: datos inconsistentes o límite excedido; no aplicar mediante rutas alternativas.
- 409 IDENTITY_GROUP_ALREADY_RELEASED y validaciones de revisión/decisión existentes permanecen.
- 503 IMPORT_REVIEW_NOT_READY si falta almacenamiento requerido.

Frontend: entrar desde una revisión activa, consultar effective-preview y última decisión, revisar identidad y toda la evidencia, elegir una observación de baja y aportar fecha/prueba independientes. Mostrar original/interpretación/proyección propuesta, custodia actual, fuente sin fecha, avisos separados y bloqueantes. Titular «Revisar baja histórica», no «Aplicar». No habilitar escritura ni simularla mediante decommission, V14, PATCH o un piloto de metadatos. Este bloque no modifica ni contacta frontend.

Siguiente backend: confirmación transaccional propia para estas bajas agrupadas, con consumo de origen, comprobante, auditoría e idempotencia; después conciliación de terminales/bajas sin fecha conforme a política explícita. Correcciones legacy/documentales, Tintas, integración y piloto real autorizado siguen pendientes. No se ha cargado el Excel ni migrado la base operativa.
