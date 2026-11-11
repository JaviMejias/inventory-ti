# Contrato API V10: plan de asignaciones históricas cerradas

Estado al 2026-10-05: implementado en código y probado con fixtures. Extensión aditiva sobre V9, sin migración nueva, sin cargar el Excel real ni alterar la base operativa. Requiere almacenamiento V4–V9 y cliente Prisma correspondientes. La aplicación transaccional de este plan aún no existe.

## Qué resuelve

Permite revisar periodos pasados de entrega/devolución de **un activo existente**, a partir de evidencia V9 ya capturada y vinculada. Muestra propuesta, procedencia, advertencias y bloqueos antes de implementar la escritura de historia.

Un día del Excel no es una hora confirmada; recepción/uso no prueban automáticamente que hubo una devolución. El revisor debe declarar que ha contrastado los documentos de entrega y retorno. La API valida estructura, coherencia y conflictos, pero no descarga ni certifica el contenido de las referencias documentales aportadas.

Siempre devuelve `canApply:false`, `persisted:false`, `affectsCurrentState:false`. Aunque `planValidationComplete:true`, no se guardó ninguna asignación ni se aprobó una carga. No modifica Asset, Assignment, stock, movimientos, usuarios, evidencia, revisiones ni auditorías. No introduce permisos retroactivos generales ni un bypass de las asignaciones V2.

## Ruta y acceso

`POST /assets/:id/imported-assignment-plan`, solo JEFE + CSRF. `:id` UUID de activo. Respuesta200 para un plan válido o con bloqueos de negocio. Request estricto, con límite HTTP estándar de la API. No existe `/apply` asociado ni GET de un plan persistido.

El frontend obtiene evidencia mediante `/assets/:id/imported-evidence` V9 y la revisión original mediante sus rutas JEFE. No debe usar el endpoint operativo de asignar y luego devolver para simular una carga: cambiaría el estado y atribuiría acciones históricas al operador actual.

## Request

Ejemplo con placeholders que deben sustituirse por IDs reales:

```json
{
  "periods": [
    {
      "periodId": "<uuid estable de esta propuesta>",
      "confirmation": "VERIFIED_CLOSED_ASSIGNMENT",
      "start": {
        "evidenceId": "<id de evidencia V9 de uso/préstamo>",
        "confirmedAt": "2001-01-01T09:00:00-03:00",
        "dateEvidenceReference": "Documento de entrega que confirma fecha, hora y zona"
      },
      "end": {
        "evidenceId": "<id de otra evidencia V9 de recepción/uso>",
        "confirmedAt": "2002-01-01T10:00:00-03:00",
        "dateEvidenceReference": "Documento de devolución que confirma fecha, hora y zona"
      },
      "recipient": { "type": "OFFICE", "name": "Oficina central" },
      "assignmentType": "STANDARD",
      "returnStatus": "UNDER_REVIEW",
      "note": "Periodo cerrado verificado, independiente de la custodia vigente",
      "evidenceReference": "Respaldo de destinatario, entrega y devolución",
      "acknowledgedWarnings": []
    }
  ]
}
```

- periods1–25. periodId UUID único por propuesta; todos los evidenceId de extremos deben ser distintos, incluso entre periodos. UUID normalizados a minúsculas. El ID de periodo sirve para vincular campos/bloqueos en UI, no es una clave de persistencia/idempotencia.
- confirmation literal obligatorio. assignmentType `STANDARD` o `LOAN`, obligatorio y explícito.
- start/end: evidenceId obligatorio; confirmedAt string ISO8601 con `Z`/offset, null u omitido (defaultnull). Instante válido desde1900, precisión máxima milisegundos; no fecha sin hora/zona. dateEvidenceReference texto trim1–500, null u omitido (defaultnull).
- recipient: `{type:"PERSON",name}` con nombre trim2–150 y al menos dos palabras, o `{type:"OFFICE",name}` trim1–160. Null u omitido (defaultnull) para mostrar qué falta. No admite personId ni crea cuentas. Placeholders no son destinatarios confirmados.
- returnStatus `AVAILABLE`, `UNDER_REVIEW`, `IN_REPAIR`, null u omitido (defaultnull). Se describe la condición de retorno histórico, no el estado actual. No default AVAILABLE ni DECOMMISSIONED.
- note trim1–2000 y evidenceReference trim1–500, ambos obligatorios. Referencias humanas, no archivos subidos ni instrucciones para acceder a rutas/URLs.
- acknowledgedWarnings array de SHA256 minúsculo64, sin repetidos, default[], máximo1000. Deben ser IDs exactos devueltos por ese periodo; no códigos de incidencia.

Una propuesta incompleta puede devolver200 con bloqueos: esto permite mostrar faltantes sin inventar defaults. Datos mal formados o campos no admitidos devuelven400. No acepta actores históricos, estado actual, force, fechas esperadas de retorno, operaciones abiertas ni datos originales/snapshots aportados por el cliente.

## Verificación por periodo

1. Evidencia V9 persistida; ambos extremos vinculados al mismo activo seleccionado, identidad resuelta y reglas de captura compatibles. No liga evidencia que se archivó con assetId=null.
2. Inicio USAGE_OBSERVATION o LOAN_OBSERVATION. Fin RECEIPT_OBSERVATION o USAGE_OBSERVATION. Baja no puede convertirse en entrega/devolución; recepción sola no demuestra inicio de asignación.
3. Dos registros originales distintos. Usar recepción y uso de la misma fila no prueba dos extremos. La declaración humana y el respaldo deben confirmar que el extremo elegido realmente fue la devolución; no basta con que su clase sea admisible.
4. Fecha/hora/zona y respaldo exacto para cada extremo, incluso si el Excel ya aporta un día. No completar a medianoche, hoy, createdAt ni con el año de hoja. Si effectiveDay es conocido, debe coincidir con el día local escrito en confirmedAt (antes de convertir a UTC). Una fecha fuente desconocida puede complementarse con un instante respaldado sin cambiar la evidencia archivada.
5. Fin estrictamente posterior a inicio; ninguno futuro. No superposición con asignaciones operativas abiertas/cerradas ni con otros periodos del request. Intervalos `[inicio,fin)` permiten extremos contiguos; una asignación abierta ocupa desde su inicio hacia adelante.
6. Nombre/tipo de destinatario explícito. Si el origen informa oficina/persona, el nombre debe coincidir tras normalización de espacios/case; officeText exige OFFICE. No transforma oficinas en personas ficticias, inventa apellidos ni resuelve alias. Si falta texto fuente, el destinatario proviene de la declaración respaldada del revisor.
7. LOAN obligatorio cuando el inicio contiene contexto de préstamo (tipo LOAN_OBSERVATION, hoja NB Prestamo, loanCode o loanDate). No eludirlo escogiendo otra observación de la misma fila.
8. Condición de devolución histórica explícita. No inferida de disponibilidad actual, de una hoja llamada Disponible ni del estado posterior de otro registro.
9. Si el activo ya está dado de baja, el periodo puede ser anterior sin reactivarlo; no puede terminar después de decommissionedAt. Si la fecha de baja terminal es desconocida, se bloquea esa coherencia en lugar de inventarla. Una asignación actual posterior al periodo no impide revisarlo, pero permanece abierta/intacta.
10. Correcciones/restauraciones posteriores a la captura en el candidato de origen bloquean esa evidencia como revisada después del archivo. No se sobreescribe ni recaptura para evadirlo: necesita el workflow de enmienda pendiente. Cambios en otros candidatos no invalidan por sí solos ese periodo.

También se comprueban identidad actual serie/tag contra la evidencia, tipo de producto ASSET y consistencia del estado ASSIGNED con exactamente una asignación activa. Producto/activo inactivo no se reactiva y no fuerza una operación corriente; el caso se evalúa como historia cerrada.

## Incidencias y referencias

Las incidencias bloqueantes de origen siguen bloqueando. No basta con introducir otro respaldo o reconocer un warning para levantar fórmula, identidad incierta, fecha inválida, conflicto de modelo u otra incidencia bloqueante.

Solo tres conflictos de **situación actual** se muestran como contexto histórico a reconocer: `EXISTING_TERMINAL_STATE_CONFLICT`, `CROSS_SHEET_STATE_CONFLICT`, `AVAILABILITY_ASSIGNMENT_CONFLICT`. Conservan la incidencia original y su severidad dentro de `warning.issue`, con `contextualOnly:true`. Este plan no está intentando poner el activo AVAILABLE ni elegir su estado actual; por eso no se aplica la misma elegibilidad del piloto V5. La declaración de periodo completo y las fechas/conflictos se verifican igualmente. Esta regla no cambia V5/V6.

Cada warning tiene `{id,evidenceId,issue,contextualOnly}`. La validación exige reconocer todos los IDs exactos; IDs ajenos bloquean. Los bloqueos derivados devuelven `{code,endpoint?,relatedId?}`. endpoint start/end cuando corresponde; relatedId puede identificar otro periodo/asignación o el campo de referencia demasiado largo.

Propuesta conserva ticket/OT de salida desde outgoingTicket/outgoingOt del inicio. Referencias de devolución se derivan **solo de incomingTicket/incomingOt cuando el fin es recepción**. Si el fin es evidencia de uso, sus outgoingTicket/outgoingOt quedan en sources.fields: no se convierten automáticamente en referencias de retorno. Textos mayores a160 bloquean; no se truncan. La evidencia completa continúa consultable en V9.

## Respuesta y vigencia

```json
{
  "planRulesVersion": "mda-closed-assignment-plan-1",
  "scope": "CLOSED_ASSIGNMENT_HISTORY_PLAN",
  "mode": "CLOSED_ASSIGNMENT_PLAN",
  "checkedAsOf": "2026-10-05",
  "assetBefore": {},
  "currentAssignmentsDigest": "<sha256>",
  "sourceRevisionsDigest": "<sha256>",
  "periods": [],
  "planId": "<sha256>",
  "canApply": false,
  "persisted": false,
  "affectsCurrentState": false,
  "planValidationComplete": false,
  "summary": { "periodCount": 1, "validCount": 0, "blockingCount": 1, "warningCount": 0 }
}
```

assetBefore es snapshot de id/producto, identidad, estado, activo/inactivo, fecha de baja, updatedAt y producto trackingMode/isActive/updatedAt. No se infiere resultingStatus ni se cambia.

Cada periodo devuelve request normalizado, `sources`, `proposedAssignment`, `warnings`, `blockers`, `valid`. Sources conserva endpoint/evidenceId/captureId/batchId/sourceHash/recordId/candidateId, hoja/fila, sourceRevision de captura, día/precisión, campos efectivos y snapshotDigest. No repite todas las celdas; el comprobante V9 es la fuente para el original completo.

proposedAssignment describe assetId, destinatario PERSON/OFFICE, nombre, assignmentType, instantes normalizados UTC (null si faltan), returnStatus y referencias separadas. `personId`, `assignedById`, `returnedById` permanecen null: no se atribuye el ejecutor antiguo al usuario capturador. **No es un DTO ejecutable de POST assignments**, ni incluye creadaPor/cerradaPor ficticios para satisfacer el schema operativo.

PlanId liga propuesta, confirmaciones/respaldo, origen inmutable, correcciones, estado actual del activo/producto, historial operativo seleccionado y reglas/fecha de comprobación. Reordenar periodos/acks conserva huella. Cambiar prueba, evidencia, activo, historia o correcciones puede cambiarla. Lectura consistente RepeatableRead, timeout15s; no guarda plan ni mantiene locks después de responder. Cualquier futura aplicación deberá revalidarlo bajo locks y agregar persistencia/idempotencia/procedencia propias.

## Errores y límites

- 400 VALIDATION_ERROR: DTO inválido, fechas sin zona/precisión no soportada, IDs/selecciones repetidos o fields extra.
- 401/403: sesión, JEFE o CSRF insuficiente.
- 404 NOT_FOUND: activo/evidencia inexistente. `/apply` no implementado devuelve404.
- 409 INVALID_HISTORICAL_EVIDENCE / INVALID_SOURCE_REVISION: almacenamiento no interpretable de forma segura; no generar un plan ficticio.
- 409 HISTORICAL_PLAN_LIMIT: más de10000 asignaciones del activo o más de1000 revisiones acumuladas en los lotes seleccionados. No truncar. Selección≤25periodos/50evidencias.
- 503 IMPORT_REVIEW_NOT_READY: almacenamiento de importación no instalado, conforme a V4/V9.

Bloqueos principales de la respuesta200: EXACT_DATE_REQUIRED/EXACT_DATE_PROOF_REQUIRED, SOURCE_DAY_MISMATCH, HISTORICAL_DATE_IN_FUTURE, HISTORICAL_PERIOD_ORDER_INVALID, CONFIRMED_RECIPIENT_REQUIRED, CONFIRMED_RETURN_STATUS_REQUIRED, OPERATIONAL_ASSIGNMENT_OVERLAP, PROPOSED_PERIOD_OVERLAP, EVIDENCE_ASSET_LINK_REQUIRED/MISMATCH, EVIDENCE_IDENTITY_UNRESOLVED, EVIDENCE_RULES_CHANGED, EVIDENCE_SOURCE_REVISED, CURRENT_ASSET_IDENTITY_CONFLICT, CURRENT_ASSIGNMENT_STATE_INCONSISTENT, DECOMMISSION_DATE_UNCONFIRMED, HISTORICAL_PERIOD_AFTER_DECOMMISSION, DISTINCT_ENDPOINT_RECORDS_REQUIRED, EVIDENCE_ENDPOINT_KIND_INVALID, SOURCE_RECIPIENT_MISMATCH/TYPE_MISMATCH, SOURCE_LOAN_TYPE_MISMATCH, SOURCE_REFERENCE_TOO_LONG, WARNINGS_NOT_ACKNOWLEDGED/UNKNOWN_WARNING_ACKNOWLEDGEMENT y SOURCE_ seguido de código bloqueante original. No presentar estos bloqueos como una excepción inesperada ni ofrecer force.

## Validación y siguiente paso

317 pruebas API/unitarias aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas21 nuevas V10 (12 unitarias y9 integración). Se cubren DTO/roles/CSRF, lectura sin cambios, fechas/prueba faltante, normalización de zona, destinatarios/préstamos, referencias separadas, solapamientos, asignación actual intacta, baja terminal, evidencia no vinculada/cruzada, cambio de origen, vigencia, almacenamiento ausente y límites sin truncar. Las12 pruebas unitarias V10 también pasaron empaquetadas temporalmente en Node24.19 Windows; suite completa PostgreSQL Node24 aún pendiente antes de despliegue. Compilación API, lint acotado y diff-check correctos.

Siguiente bloque: aplicación exclusivamente de periodos cerrados confirmados, con modelo que conserve ejecutor histórico desconocido separado del capturador, transacción/locks, comprobantes e idempotencia y protección contra duplicados/solapamientos. No reutilizar createAssignment/returnAssignment encadenados. Sigue pendiente enmienda/vínculo posterior de evidencia, bajas históricas con incertidumbre, Tintas, reagrupación de identidades y piloto real autorizado con respaldo/conciliación.
