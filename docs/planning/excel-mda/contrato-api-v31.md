# Contrato API V31: consulta de conciliación de bajas dentro de grupos

Extensión posterior: [V32](contrato-api-v32.md) añade un plan y confirmación documentales propios con migración0031. Este endpoint V31 sigue siendo exclusivamente diagnóstico: assessmentId y sus banderas false no son una aprobación de escritura. Su documentAssociations conserva alcance V30; consultar GET de V32 para comprobantes agrupados. Las menciones a confirmación aún no implementada siguientes describen el alcance original V31, no el estado global posterior.

Estado al2026-10-20: diagnóstico backend de solo lectura, sin carga del workbook, despliegue ni cambios frontend. No añade migración ni dependencia: requiere el almacenamiento anterior hasta0030, incluida la consulta de asociaciones documentales V30. V31 es versión del contrato, no una migración0031.

## Alcance

V30 mantiene bloqueadas las fuentes reservadas/consumidas por agrupación. V31 permite consultarlas dentro de su revisión para comprender identidad, archivo, baja existente, reservas, consumos y comprobantes; no modifica esos bloqueos ni añade confirmación documental. No es un plan elegible para escritura, no aplica otra baja, no establece vínculos, no consume/libera filas y no altera estado/fecha/updatedAt/asignaciones/stock/auditoría.

Una revisión cancelada puede consultarse como antecedente histórico. Se validan su huella y procedencia por fila con reservas ya liberadas; el validador operativo anterior continúa rechazándola para proyección/aplicación. No se simula una revisión activa ni se transfieren decisiones anteriores. La selección de activo de esta consulta es diagnóstica, no una autorización de vínculo.

## Endpoint y entrada

`POST /inventory/imports/batches/:id/identity-group-reviews/:reviewId/retirement-reconciliation`, JEFE autenticado+CSRF. El POST solo transporta criterios; su consulta no persiste datos de dominio.

```json
{
  "groupKey": "huella estable de 64 caracteres hexadecimales del grupo",
  "assetId": "00000000-0000-4000-8000-000000000001",
  "evidenceId": "00000000-0000-4000-8000-000000000002"
}
```

groupKey debe ser el valor real de la revisión; el ejemplo explica su origen. Se conserva la fórmula de V18: SHA-256 canónico de `["IMPORT_IDENTITY_GROUP",sourceHash,reviewId,groupId]`. assetId/evidenceId son UUID normalizados. Cuerpo y query estrictos: no acepta fechas, force, confirmaciones, requestId, notas, planId ni reconocimientos de advertencias. La observación debe pertenecer al grupo físico seleccionado, no simplemente al mismo lote o revisión. El activo debe existir; no se busca ni asigna automáticamente por serie.

## Respuesta200

scope=GROUP_RETIREMENT_RECONCILIATION, mode=READ_ONLY_GROUP_RECONCILIATION, rulesVersion=mda-group-retirement-reconciliation-1 y assessmentId. Siempre canApply/persisted/affectsCurrentState/evidenceRelinked/confirmsSourceDate/currentLinkAuthorized/documentConfirmationImplemented/operationalResolutionImplemented=false. No devuelve planId ni planValidationComplete; assessmentId identifica el diagnóstico, no una aprobación recuperable ni una intención aplicable.

- Contexto: checkedAsOf/timeZone America/Santiago, batchId/reviewId/groupId/groupKey/sourceHash, versiones revisadas y actuales, reviewedPlanId, reviewState ACTIVE|RELEASED, latestDecision como metadatos no autorizantes.
- Identidad: reviewedIdentity con basis=HISTORICAL_GROUP_PROPOSAL_ONLY, sourceRows originales y listas identityRevisedRecordIds/reviewSourceRevisedRecordIds. Una corrección posterior relevante al grupo queda visible, incluso si el archivo procede de otro lote del mismo hash.
- Equipo: assetBefore/producto y estado actual. existingRetirement conserva su fecha real o null, precisión INSTANT|UNKNOWN, origen CURRENT_ASSET|VERIFIED_IMPORT_RECEIPT|GROUP_VERIFIED_IMPORT_RECEIPT y confirmsSourceDate=false. Es null cuando no hay terminal coherente DECOMMISSIONED/isActive=false. Nunca convierte la fecha existente en fecha del Excel.
- Archivo: originalEvidence/currentEvidence seleccionados, versiones/captura/procedencia separadas, source y groupArchive completo en el ámbito consultado con incidencias/versiones/vínculos/huellas. appliedByThisAssessment=false. diagnosticEvidenceProjection sirve exclusivamente para comparar la identidad propuesta; su linkBasis es DIAGNOSTIC_GROUP_PROPOSAL_ONLY y authorizationGranted=false. No es un vínculo guardado, ni siquiera si coincide con el activo.
- sourceRetirement mantiene effectiveAt=null/datePrecision=UNKNOWN/historicalActorId=null para una observación de baja. Una recepción seleccionada sigue siendo recepción: sourceRetirement=null y diagnóstico RETIREMENT_EVIDENCE_KIND_REQUIRED.
- sourceConsumption muestra por fila origen GROUP_ASSET_PILOT|GROUP_RETIREMENT y padres/activo/comprobante verdaderos; activeReservations muestra propietarios vigentes aunque sean otra revisión. sourceRowState=UNCONSUMED|PARTIALLY_CONSUMED|CONSUMED, solo dentro del grupo físico seleccionado. Una contradicción de consumo aparece en diagnósticos y clasificación, no se resuelve por mayoría.
- retirementReceipts contiene metadatos V14/V29, sin plan/result/pruebas; documentAssociations conserva las capturas de versión V30 de la observación seleccionada, que pueden describir vínculos históricos distintos del actual. links apunta a comprobantes con sus padres reales, no con el activo/revisión elegidos si son diferentes.
- warnings mantiene las advertencias de la observación seleccionada sin reconocimiento automático; las incidencias de las demás observaciones están en groupArchive. diagnostics mantiene requisitos y conflictos de fuente, versión, identidad, estado, custodia, cronología y consumo. No se omiten bloqueantes para aprobar una asociación: ninguna se guarda en V31.

currentLinkAuthorized=false significa que esta consulta no otorga autoridad nueva; currentEvidence.assetId muestra separadamente el vínculo que realmente exista. Una fila consumida y una observación utilizada son conceptos distintos. V29 consume todas las filas del grupo, pero solo la observación elegida sustenta la baja aplicada: una observación omitida puede tener evidenceState=SOURCE_ROW_CONSUMED sin ser un segundo evento de retiro.

## Clasificación y próximos pasos

currentState=INCONSISTENT|ACTIVE_CUSTODY|TERMINAL_DATED|TERMINAL_UNDATED|NONTERMINAL. evidenceState=USED_FOR_THIS_RETIREMENT|USED_FOR_OTHER_RETIREMENT|USED_BY_ASSIGNMENT|SOURCE_ROW_CONSUMED|REVIEW_REQUIRED|ARCHIVED_ONLY.

Clasificaciones principales: CURRENT_STATE_REVIEW_REQUIRED, GROUP_SOURCE_CONSUMPTION_REVIEW_REQUIRED, EVIDENCE_ALREADY_USED, ALREADY_GROUP_IMPORTED_RETIREMENT, EXISTING_GROUP_IMPORTED_RETIREMENT, EXISTING_IMPORTED_RETIREMENT, EVIDENCE_REVIEW_REQUIRED, CURRENT_CUSTODY_CONFLICT, EXISTING_DATED_RETIREMENT, EXISTING_UNDATED_RETIREMENT y RETIREMENT_DATE_UNCONFIRMED. Una clasificación de comprobante previo puede coexistir con discrepancias posteriores; revisar siempre diagnostics, no solo classification.

Ejemplos de diagnósticos propios: GROUP_REVIEW_RELEASED, GROUP_SOURCE_RESERVED_BY_ANOTHER_REVIEW, GROUP_SOURCE_CONSUMPTION_CONFLICT, GROUP_ASSET_IDENTITY_CHANGED, GROUP_DECISION_POINTS_TO_ANOTHER_ASSET, GROUP_SOURCE_IDENTITY_REVISED, GROUP_REVIEW_SOURCE_REVISED, GROUP_ARCHIVE_SOURCE_REVISED, GROUP_ARCHIVE_RULES_CHANGED, GROUP_ARCHIVE_LINKED_TO_ANOTHER_ASSET y GROUP_ARCHIVE_RECEIPT_AFTER_CURRENT_RETIREMENT. Se conservan las incidencias BLOCKING de todo el archivo del grupo. Requisitos de fecha/prueba exacta siguen visibles como faltantes del flujo de retiro, no como una fecha inventada para el documental.

nextSteps son descriptivos: conservar incertidumbre/origen/consumo, revisar estado/custodia/identidad/archivo, consultar comprobantes existentes y conservar revisiones canceladas como históricas. GROUP_DOCUMENT_CONFIRMATION_NOT_IMPLEMENTED deja explícito el siguiente bloque pendiente. DO_NOT_REUSE_LEGACY_APPLY_OR_DOCUMENT_CONFIRMATION evita presentar V14/V29/V30 o CRUD como atajos. Obtener respaldo de fecha sobre un activo no terminal no habilita por sí mismo aplicación, ni deshace consumos anteriores.

## Consistencia, errores y límites

Un snapshot REPEATABLE READ integra lote/revisión/filas, archivo vigente y revisiones de sus lotes, activo/producto, historia efectiva V27, propietarios de reservas, ambos tipos de consumo, últimos metadatos de decisión, comprobantes de retiro y asociaciones V30. Una baja concurrente no produce un diagnóstico mezclado antes/después. La huella cambia con esos datos o el día de evaluación y no se persiste.

Límites explícitos:25 filas por revisión/grupo,100 observaciones de archivo,10000 asignaciones,1000 revisiones de fuente,25 reservas,50 consumos entre los dos almacenes, hasta4 comprobantes de retiro por las dos claves únicas en ambos almacenes y1001 versiones documentales de la observación. Consultas usan sentinelas y fallan antes de devolver un diagnóstico truncado; timeout15s. Datos corruptos o procedencia no verificable fallan, no se normalizan silenciosamente.

401/403 para autenticación/rol/CSRF,400 para entrada/query inválida,404 para padres/activo/grupo/evidencia inexistentes o ajenos,409 GROUP_RECONCILIATION_LIMIT/SOURCE_REVISION_LIMIT/INVALID_IDENTITY_GROUP_REVIEW/INVALID_HISTORICAL_EVIDENCE/INVALID_SOURCE_REVISION según contexto,503 IMPORT_REVIEW_NOT_READY si falta almacenamiento. Una revisión cancelada íntegra no genera por sí sola409 aquí; el endpoint operativo V18 sigue devolviendo IDENTITY_GROUP_ALREADY_RELEASED.

## Verificación

766 pruebas aprobadas,0 fallos/omitidas/canceladas,200.106s en Node24.22.0 Linux/PostgreSQL18.6 independiente.20 nuevas (10 unitarias/10 integración), suite completa repetida tras reforzar el diagnóstico de estado inconsistente. Build API forzado, lint completo API/tests, Prisma validate y whitespace correctos; sin cambio de esquema/cliente. Base descartable eliminada, cero restantes y servidor temporal detenido. [Informe](verificacion-backend-node24.md) con alcance y límites; no equivale a despliegue, confirmación documental de grupos ni carga real.

## Traspaso y pendientes

Frontend: presentar «Consultar conciliación del grupo», separar identidad original/revisada/actual/proyección diagnóstica, archivo/fecha efectiva/captura, observación aplicada/fila consumida, reserva actual/revisión histórica y versión documental capturada/vigente. Mostrar conflictos y enlaces reales a comprobantes sin un botón de confirmar desde V31. No enviar su respuesta a aplicaciones V14/V29/V30 ni simular una baja/asociación mediante varias llamadas CRUD.

Siguiente backend: diseñar e implementar la confirmación documental propia de grupos, con revalidación de autoridad/procedencia y persistencia/auditoría atómicas, sin cambiar estado/fecha ni reservas/consumos. V31 solo resuelve el diagnóstico previo, no ese guardado. Correcciones legacy/documentales, significado/unidad de Tintas e integración/piloto real autorizado con respaldo siguen pendientes. No se modificó ni contactó frontend ni se migró/escribió en la base operativa.
