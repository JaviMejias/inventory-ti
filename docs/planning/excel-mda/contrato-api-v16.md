# Contrato API V16: plan de agrupación de identidades físicas

Estado al2026-10-05: implementado en backend, solo simulación/lectura. Sin migración/dependencia nueva, despliegue ni carga real. Requiere almacenamiento previo hasta0022 para consultar consumo/procedencia. Complementa V8; no relaja sus guardas ni implementa persistencia de separaciones/fusiones.

Actualización posterior [V17](contrato-api-v17.md): agrega comprobantes administrativos, procedencia y reservas cancelables por rutas distintas, con migración0023. V16 ahora rechaza selecciones ya reservadas. La proyección efectiva de grupos y su aplicación siguen pendientes; los flags read-only de V16 no autorizan ninguna carga.

## Alcance

Permite proponer qué observaciones originales corresponden a cada equipo, con serie/tag verificados y respaldo por grupo. Simula cambios de interpretación y muestra separación, fusión, redistribución o corrección sin cambio de grupos; cruza con el inventario actual, decisiones y evidencia/comprobantes anteriores.

No cambia el XLSX, lote, interpretación V7/V8, candidatos, decisiones, evidencia/captura, activos/asignaciones, stock ni auditoría. No genera identidades operativas, productos ni permisos para cargar. No admite un force ni elige qué filas pertenecen a un equipo. El revisor propone esa pertenencia explícitamente; el servidor verifica coherencia/límites, no autenticidad de fotos/documentos.

Las identidades de candidato originales siguen siendo targets de V4–V14. Los IDs calculados en una simulación no son targets válidos nuevos. Persistir una separación/fusión requerirá un flujo distinto que conserve procedencia por fila y deduplicación global de fuente/observación; no recrear el lote con un workbook alterado como sustituto.

## POST /inventory/imports/batches/:id/identity-group-plan

Solo JEFE autenticado+CSRF. HTTP200 devuelve una propuesta evaluada, también con bloqueantes. Sin endpoint `/apply` de este plan.

Request estricto, ejemplo de separación de dos observaciones pertenecientes inicialmente al mismo candidato:

```json
{
  "expectedVersion": 1,
  "expectedSourceRevision": 0,
  "confirmation": "REVIEW_PHYSICAL_IDENTITY_GROUPS",
  "candidateIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "note": "Las etiquetas físicas distinguen dos equipos distintos",
  "groups": [
    {
      "groupId": "00000000-0000-4000-8000-000000000001",
      "recordIds": ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      "serialNumber": "VERIFICADA-001",
      "assetTag": null,
      "evidenceReference": "Fotografía de etiqueta y registro de recepción del equipo uno"
    },
    {
      "groupId": "00000000-0000-4000-8000-000000000002",
      "recordIds": ["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
      "serialNumber": "VERIFICADA-002",
      "assetTag": null,
      "evidenceReference": "Fotografía de etiqueta y registro de recepción del equipo dos"
    }
  ]
}
```

- `expectedVersion`: entero1..2147483647, revisión actual del lote; `expectedSourceRevision`: entero0..1000, obligatorio sin default. Consulta coherente con ambas, no incrementa ninguna.
- `candidateIds`:1–25 hashes64 hex minúscula, originales y distintos. Solo candidatos físicos ASSET_OBSERVATION/RETIREMENT_HISTORY, no encabezados, notas, Tintas, Disponible ni registros sin mapeo.
- `groups`:1–25; `groupId` UUID distinto normalizado a minúsculas, etiqueta del escenario, no identidad persistida. `recordIds`:1–25 por grupo, hashes originales distintos entre todos los grupos.
- Máximo25 observaciones en total, no25 por grupo. Deben cubrir todas las filas de todos los candidatos seleccionados exactamente una vez; no omitir filas incómodas ni añadir filas de candidatos no seleccionados. Un candidato original con más de25 filas da409 antes de simular; no se divide el alcance en peticiones parciales.
- `serialNumber`/`assetTag`: ambos obligatorios, texto trim explícitamente verificado máximo160/100 o null; al menos uno no null. Placeholders/N/A/texto vacío y valores numéricos no válidos como identidad propuesta. No deduce dígitos de series Excel numéricas.
- Null solo conserva ausencia/placeholder cuando el campo está ausente/no significativo tanto en origen como en interpretación actual de cada fila. No borra tags/series numéricos, fórmulas/errores ni valores añadidos por revisiones anteriores. Debe revisar ambos identificadores poblados.
- No se agrega un identificador cuya columna no esté mapeada en una observación del grupo. Por ejemplo NB Prestamo no tiene columna de assetTag; no convertir otra columna en ella.
- `note`: trim1..2000; `evidenceReference`: trim1..500 en cada grupo, obligatorios. No acepta requestId, fecha/actor histórico, cambios de estado, metadatos o acknowledgements.

## Respuesta

Siempre `scope=PHYSICAL_IDENTITY_GROUP_PLAN`, `rulesVersion=mda-identity-group-plan-1`, `canApply=false`, `persisted=false`, `affectsCurrentState=false`, `lineagePersistenceImplemented=false`. `proposalValidationComplete` solo indica ausencia de bloqueantes en este escenario de identidad; no acredita estado/fecha/destinatario, autenticidad documental ni elegibilidad del piloto/historia/baja.

`planId` SHA256 es una huella del escenario, no plan V5/V10/V13 ni aprobación V6/V11/V14. No enviarlo a esos endpoints como si fuese su plan. Vincula solicitud normalizada, datos/estado de inventario, origen efectivo, revisiones, decisiones, evidencia/usos y día de evaluación. Cambiar orden de candidatos/grupos/filas no cambia la huella; motivo/respaldo/identidad sí.

Campos:

- `asOf`, `timeZone=America/Santiago`: día de evaluación en esa zona, no fecha efectiva de operación. `batchId,batchVersion,sourceRevision,sourceHash`, `currentPreviewDigest,simulatedPreviewDigest,sourceContextDigest`: contexto/hashes para trazabilidad; no reemplazan una recarga tras cambios concurrentes.
- `request`: propuesta normalizada, listas ordenadas. `operationKind`: `IDENTITY_ONLY|SPLIT|MERGE|REPARTITION`, según pertenencia de filas antes/después, no según cantidad de cambios de texto.
- `originalCandidates:[{candidateId,recordIds}]`: cobertura/IDs originales preservados.
- `observations`: máximo25; `recordId,sheet,row,originalCandidateId,proposedGroupId,originalIdentityCells,currentIdentityCells`. Las celdas de serie/tag conservan tipos/formato/raw/fórmula cuando presentes; null distingue ausencia. No incluye filas ajenas ni las notas personales de toda la hoja.
- `proposedGroups`: propuesta/respaldo, `originalCandidateIds` y `simulatedCandidateIds`, más candidatos resultantes simulados. Cada candidato muestra `id,serials,tags,selectedRecordIds,outsideRecordCount,existingAssets,existingAssetCount,hasMoreExistingAssets`. Coincidencias existentes son sugerencias, no selección de activo/producto; muestra como máximo10 y cuenta total explícita, sin ocultar ambigüedad. `outsideRecordCount>0` significa absorción ajena bloqueada, no ampliación automática del alcance.
- `changes`: antes/después/original por celda, origen/columna/recordId/candidateId original y acción REPLACE. Hasta50 celdas (25×2). Son simuladas; no son un payload de `/source-revisions` ni un evento persistido. Otras columnas quedan intactas. Para celdas sin cambios usar observations.
- `issues`: incidencias del preview simulado relacionadas con filas/grupos/hojas seleccionados, con severidad/origen; `warnings`: solo WARNING. INFO sigue en issues, no se convierte en advertencia que autorice aplicar. Conserva bloqueantes de modelo, estados, fechas, columnas/fórmulas y coincidencias, sin ignorarlos por confirmar identidad.
- `blockers`: objetos `code` con `groupId/recordId/relatedId/issue` cuando corresponda.
- `impacts.pilotItems`: comprobantes V6 por sourceHash/candidato original de cualquier lote, metadatos `{id,candidateId,assetId,applicationId}`.
- `impacts.decisions`: última decisión de cada candidato en el lote seleccionado, con `id,targetType,targetId,action,linkedAssetId,batchVersion,sourceRevision`; no agrega historial completo ni decisiones de otros lotes.
- `impacts.evidence`: evidencia V9 de esas filas de la misma fuente, incluso capturada en otro lote. `{id,recordId,candidateId,captureId,captureBatchId,capturedAssetId,currentAssetId,capturedSourceRevision,sourceRevision,evidenceVersion,amendmentId,assignmentUse,retirementUse}`. Captura original y versión/vínculo actuales se distinguen; una enmienda null conserva desvinculación, no recupera el vínculo viejo. Las revisiones son del lote de captura indicado, no se equiparan automáticamente con las del lote del plan.
- `assignmentUse`: null o `{itemId,endpoint}` V11; `retirementUse`: null o `{id,assetId}` V14. No duplica planes/pruebas privadas ni expone credenciales/identidades de usuario.
- `requiresEvidenceLineageReview`: existe evidencia archivada que un futuro cambio de grupos debe conciliar, no actualiza esas capturas. `requiresDecisionRenewal`: hay decisiones que un flujo futuro debe revisar, no las borra/invalida en SQL. `requiresCoordinatedIdentityReview`: cambiar identidades entre candidatos seleccionados exige coordinación para no crear colisiones intermedias.
- `summary`: conteos de candidatos originales/grupos/observaciones/celdas cambiadas/bloqueos/warnings.

### nextWorkflow

| Valor | Tratamiento |
| --- | --- |
| LINEAGE_WORKFLOW_NOT_IMPLEMENTED | Separación/fusión/redistribución; persistencia nueva todavía no implementada. |
| IDENTITY_REVIEW_SCOPE_WORKFLOW_NOT_IMPLEMENTED | Se conserva agrupación pero algún candidato excede12 observaciones de V8. No remitirlo a una escritura incompatible. |
| COORDINATED_IDENTITY_WORKFLOW_NOT_IMPLEMENTED | Intercambio/solapamiento de identidades actuales entre candidatos; dos escrituras V8 independientes pueden colisionar. No usar series temporales ficticias para sortearlo. |
| V8_IDENTITY_REVIEW | Sin cambio de pertenencia, cada candidato dentro de12 y sin coordinación intermedia. Revisar el flujo V8 por candidato, con sus versiones/confirmación/respaldo/guardas propios; no ejecutar automáticamente este plan. Los demás conflictos todavía pueden impedirlo. |

## Bloqueantes y errores

Bloqueantes HTTP200:

- `IDENTITY_FIELD_NOT_MAPPED`, `IDENTITY_CANNOT_DROP_SOURCE_VALUE`.
- `PROPOSED_GROUP_NOT_REALIZABLE`: el motor no produce exactamente las filas del grupo, incluido mismo identificador propuesto para grupos distintos. No acepta una separación meramente visual del mismo identificador.
- `IDENTITY_OVERLAP_OUTSIDE_SCOPE`: identidad propuesta coincide con observaciones ajenas, aunque el tag no fusione grupos por sí solo. Debe ampliar/replantear alcance explícitamente, respetando25, no absorber automáticamente.
- `PROPOSED_IDENTITY_NOT_REALIZED`: el resultado no representa la identidad propuesta.
- `SOURCE_<code>`: toda incidencia BLOCKING pertinente del motor V3, sin excepción contextual por tratarse de identidad.
- `SOURCE_CANDIDATE_ALREADY_APPLIED`: candidato consumido V6 desde cualquier lote de la misma fuente.
- `SOURCE_OBSERVATION_ALREADY_APPLIED`: fila con evidencia consumida V11/V14. No reinterpretar sus antecedentes/comprobantes mediante un plan de agrupación.

HTTP400 `VALIDATION_ERROR`, `INVALID_SOURCE_TARGET`, `IDENTITY_GROUP_COVERAGE_REQUIRED`, `SOURCE_CORRECTION_LIMIT`;404 `NOT_FOUND`;409 `REVIEW_VERSION_CONFLICT`, `SOURCE_REVISION_CONFLICT`, `IDENTITY_GROUP_SCOPE_LIMIT`, `IDENTITY_GROUP_EVIDENCE_LIMIT`, `PREVIEW_DATABASE_LIMIT`, límites/errores de origen heredados;503 `IMPORT_REVIEW_NOT_READY` si falta almacenamiento. Auth/CSRF401/403 y envoltura de errores existentes. No sustituir errores/límites por una respuesta parcial aprobada.

## Consistencia, compatibilidad y verificación

Transacción RepeatableRead, timeout15s: fuente original/efectiva/revisiones, decisiones, usos, evidencia/enmienda actual e inventario pertenecen a un snapshot. Scope se valida antes de consultar impactos/global inventario; no hay locks de escritura ni eventos nuevos. Límites:25 observaciones,100 evidencias (guardado+1 para detectar exceso),1000 revisiones y25000 activos; no truncar para declarar éxito. Las coincidencias listadas pueden limitarse a10 únicamente con conteo/flag explícitos; el motor evalúa todas.

V4–V14 siguen usando IDs originales, deduplicación y guardas anteriores. V8 continúa prohibiendo cambios de grupos; V16 no altera tablas ni reintentos, no tiene aplicación y no cambia interpretación publicada por `/resolved-preview`. Instalación operativa previa de migraciones requerida, no realizada por este bloque.

20 pruebas nuevas:11 unitarias y9 integración, incluyendo cobertura/permisos/DTO, separación/fusión/redistribución, campos contextuales/numéricos, colisiones/grupos ajenos, versiones/antes-después, impactos de captura/enmienda, consumo V6/V11/V14 entre lotes, límites/storage, snapshot concurrente y rutas V8 incompatibles. Suite completa430 aprobadas en Node24.19.0 Linux/PostgreSQL18.6 descartable; base eliminada. Build API forzado, lint completo API, Prisma validate y diff-check correctos. Sin cambios frontend, manifests/lockfile, Excel real o base operativa.

Siguiente trabajo de agrupación: diseñar/persistir procedencia estable por fila y reservas globales compatibles con candidatos/comprobantes anteriores, renovación de decisiones y tratamiento explícito de evidencia ya archivada. No migrar/reescribir historia aplicada ni habilitar carga general porque una propuesta sea consistente. Bajas sin fecha, Tintas según unidad/reglas, corrección de historia aplicada e integración/piloto real siguen pendientes.
