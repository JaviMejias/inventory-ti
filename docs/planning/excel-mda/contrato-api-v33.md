# Contrato API V33: revisión de rectificaciones de periodos legacy

Extensión posterior [V34](contrato-api-v34.md),2026-10-25: añade confirmación explícita, versiones append-only y lecturas efectivas con migración0032. El plan conserva sus banderas false; expectedCorrectionVersion ahora admite0..1000 y before refleja la última versión. Las afirmaciones siguientes de ausencia de guardado/ruta y versión limitada a0 describen V33 original, no el alcance posterior V34. El backend actualizado requiere0032 antes de iniciar, también para sus lecturas.

Estado al2026-10-20: implementa la planificación de una rectificación de historia cerrada importada por V11, sin guardarla. No añade migración, tabla, dependencia ni cambio de esquema/cliente Prisma. Requiere el almacenamiento previo del backend actualizado hasta0031. Sin carga del workbook, escritura operativa ni cambios/contacto frontend.

## Alcance y límites de esta fase

Prepara original/propuesta/diferencias de un ImportAssignmentItem legacy concreto. Los periodos agrupados conservan sus rutas V26/V27: no se convierten en legacy ni reciben otra autoridad. Una asignación operativa sin comprobante V11 íntegro no es un origen válido.

Puede revisar fechas efectivas exactas, destinatario PERSON/OFFICE, STANDARD/LOAN, condición de retorno, notas y respaldos. Conserva activo, periodo e identidad de las dos evidencias, propiedad permanente de extremos, referencias ticket/OT derivadas y actores históricos null. Motivo/respaldo de la rectificación son distintos de nota/respaldo del periodo y de las pruebas temporales de sus extremos.

Solo admite comprobantes del flujo legacy con rulesVersion=mda-closed-assignment-plan-2, vigente desde V12. Comprobantes anteriores mda-closed-assignment-plan-1 u otras reglas reciben ASSIGNMENT_ORIGIN_RULES_UNSUPPORTED: no se inventan versiones de evidencia ni se reescribe su origen para hacerlos pasar. Su compatibilidad requiere revisión específica posterior.

No rectifica comprobantes documentales V30/V32, bajas terminales, préstamos abiertos ni observaciones originales. No guarda rectificaciones, no modifica lecturas efectivas, no crea asignaciones y no libera extremos. La confirmación/versionado append-only y su incorporación a AssignmentEffective quedan pendientes de un bloque propio.

## Endpoint y entrada

`POST /assets/:id/imported-assignment-applications/:applicationId/items/:assignmentItemId/correction-plan`, JEFE autenticado+CSRF, query vacía.

assignmentItemId es el item del comprobante legacy, no el assignmentId operativo ni un item agrupado. Los tres padres deben concordar. UUID normalizados a minúsculas, cuerpo y parámetros estrictos.

```json
{
  "expectedOriginPlanId": "huella real del comprobante legacy",
  "expectedCorrectionVersion": 0,
  "reason": "Corregir transcripción frente a documentos verificados",
  "supportingReference": "Respaldo independiente de la rectificación",
  "correction": {
    "start": {
      "confirmedAt": "2001-01-01T09:00:00-03:00",
      "dateEvidenceReference": "Hora y zona verificadas de entrega"
    },
    "end": {
      "confirmedAt": "2002-01-01T10:00:00-03:00",
      "dateEvidenceReference": "Hora y zona verificadas de devolución"
    },
    "recipient": { "type": "OFFICE", "name": "Oficina central" },
    "assignmentType": "STANDARD",
    "returnStatus": "UNDER_REVIEW",
    "note": "Nota rectificada del periodo",
    "evidenceReference": "Entrega, destinatario y devolución documentados",
    "acknowledgedWarnings": []
  }
}
```

expectedOriginPlanId debe ser la huella real de64 caracteres hexadecimales minúsculos; el texto del ejemplo es explicativo. expectedCorrectionVersion solo acepta0, valor por defecto, porque no hay almacenamiento de rectificaciones legacy todavía. reason1–2000/supportingReference1–500; nota1–2000/respaldo del periodo1–500; hasta1000 advertencias únicas. Mantiene límites y formatos de fechas/destinatarios V10, incluidos hasta milisegundos y zona explícita.

Los campos confirmados pueden ser null para mostrar los faltantes como bloqueantes. No acepta requestId, actor, assetId, assignmentId, periodId, evidenceId, vínculo, ticket/OT libres, force, snapshots ni confirmación de escritura. El servidor deriva los identificadores desde el origen validado.

## Validación del origen completo

Lee un snapshot REPEATABLE READ de comprobante y todos sus items, asignaciones originales, usos exactos, archivo vigente/enmiendas, revisiones de sus lotes, auditorías, equipo/producto e historia efectiva actual V27. No valida únicamente el item seleccionado.

Comprueba reglas y huellas de plan/intención, campos y cobertura del comprobante, snapshots originales, correspondencia con todas las asignaciones realmente persistidas, estado importado/cerrado, fechas/importador de captura, actores históricos null, dos usos exclusivos exactos por item y auditoría raíz/por asignación con metadatos concordantes. Archivo y enmiendas deben preceder a la aplicación. Reconstruye fuentes/propuesta/advertencias originales con la foto histórica del equipo, sin sustituirla por su estado actual ni inventar su antigua custodia abierta.

Las auditorías legacy no contienen el marcador transaccional de los comprobantes agrupados posteriores: aquí se verifica su cobertura/coherencia completa, no se añade retrospectivamente una prueba de transacción inexistente. El respaldo citado por el usuario sigue siendo una afirmación documental que debe verificarse fuera del algoritmo.

Solo tras validar todo ese origen se excluye localmente la asignación seleccionada de los solapamientos y se reconoce la propiedad de sus dos extremos. Las hermanas y la custodia actual permanecen en el cálculo; las rutas normales V10/V11 y sus guards SQL siguen bloqueando evidencia ya consumida. Fuentes reservadas o consumidas por grupos permanecen bloqueadas por los controles anteriores, sin excepción nueva.

Reutiliza validación V10/V12 de fecha/prueba, día conocido de fuente, destinatario informado, tipo de préstamo, condición de retorno, orden temporal, futuro, baja existente, conflictos de identidad/producto/fuente y advertencias exactas. El día de una fuente no se cambia desde aquí. Un día desconocido permanece UNKNOWN/null aunque se proponga un instante respaldado. Para inicializar el formulario, conservar los extremos de originalPeriod con su zona original; no reconstruir el día local del documento a partir de un UTC convertido.

Cambiar solo motivo o representación del mismo instante no constituye diferencia material; un cambio únicamente de respaldo del periodo sí se muestra. Cambios de custodia, devoluciones normales o metadatos posteriores a la importación no invalidan por sí solos el comprobante anterior: se evalúan separadamente como contexto vigente y posibles solapamientos.

## Respuesta200

rulesVersion=mda-legacy-assignment-correction-plan-1, scope=LEGACY_CLOSED_ASSIGNMENT_CORRECTION_PLAN y mode=CORRECTION_REVIEW_ONLY.

- correctionPlanId, assetId/applicationId/assignmentItemId/assignmentId, originPlanId, currentCorrectionVersion=0.
- originReceiptDigest/originAuditDigest, currentContextDigest y validationContextPlanId; checkedAsOf y timeZone=America/Santiago. Huellas opacas del servidor, ligadas a origen, día de evaluación y contexto completo, no solo a updatedAt.
- request normalizado, reason/supportingReference, before/proposed y changes=[{field,before,after}]. Comparación de instantes en UTC; respaldos temporales y del periodo separados.
- originalPeriod/originalAssignment conservados, currentAsset/currentCustody separados; proposedPeriod con validaciones, sources/currentEvidence y ownership de los dos extremos.
- acknowledgedWarnings/warnings/blockers y planValidationComplete.
- persisted/canApply/affectsCurrentState/evidenceRelinked/operationalHistoryApplied/correctionApplicationImplemented=false siempre.

validationContextPlanId no habilita otra importación. Incluso planValidationComplete=true significa únicamente que esta propuesta de revisión no tiene bloqueantes; no existe ruta `/apply` de V33 y enviar la respuesta a V11 u otra confirmación se rechaza.

## Errores y límites

401/403 autenticación/JEFE/CSRF;400 VALIDATION_ERROR para cuerpo/query;404 padres/items inexistentes o ajenos.409 principales:

- ASSIGNMENT_ORIGIN_CHANGED: seleccionar el planId del origen correcto.
- INVALID_ASSIGNMENT_APPLICATION: huellas, cobertura, asignaciones, versiones, propiedad o auditoría inconsistentes.
- ASSIGNMENT_ORIGIN_RULES_UNSUPPORTED: reglas históricas no admitidas, sin conversión silenciosa.
- ASSIGNMENT_CORRECTION_CURRENT_STATE_INVALID: no se puede establecer equipo/custodia/asignaciones originales en la historia actual.
- ASSIGNMENT_CORRECTION_LIMIT: contexto excesivo, sin resultado truncado.
- Se conservan INVALID_HISTORICAL_EVIDENCE/INVALID_SOURCE_REVISION y los conflictos de reserva/consumo anteriores.

200 con bloqueantes mantiene las reglas históricas anteriores y ASSIGNMENT_CORRECTION_UNCHANGED.503 IMPORT_REVIEW_NOT_READY cuando falta el almacenamiento o la vista efectiva requeridos.

Límites:1..25 periodos completos por comprobante, exactamente2 usos por item, hasta50 evidencias,10000 asignaciones actuales,1000 revisiones y26 auditorías raíz/items. Consultas con sentinelas y timeout15s; no carga todas las filas del Excel ni trunca un contexto para aprobarlo.

## Verificación

811 pruebas aprobadas,0 fallos/omitidas/canceladas,190.859s en Node24.22.0 Linux/PostgreSQL18.6 independiente;25 nuevas (12 unitarias/13 integración). Las12 unitarias pasaron también en10 repeticiones. Build API forzado/lint completo API/tests/Prisma validate/whitespace correctos. Incluye corrección de captura de hora en creación de revisiones de identidad: UTC milisegundos de PostgreSQL antes de INSERT, sin relajar el guard SQL ni añadir migración.

Base descartable eliminada, cero restantes y servidor temporal detenido. No equivale a confirmación persistente, despliegue, integración frontend ni carga real.

## Traspaso y siguiente paso

Frontend puede ofrecer «Revisar rectificación histórica» desde un item legacy. Mostrar original, propuesta y diferencias; fuente conocida/desconocida, captura/importador y custodia vigente separados. Pedir motivo y respaldos, mostrar bloqueantes y permitir regenerar el plan. No mostrar Guardar mientras correctionApplicationImplemented=false; no usar PATCH/DELETE, una nueva importación ni la ruta agrupada como atajo.

Siguiente backend: confirmación propia, versionado/idempotencia, auditoría e incorporación efectiva append-only de estas rectificaciones, conservando original y consumo. Siguen separados compatibilidad de comprobantes con reglas1, rectificaciones documentales V30/V32, política de fuentes consumidas no admitidas, reglas Tintas e integración/piloto real autorizado con respaldo/conciliación.

Ver alcance y resultados de pruebas en [verificación del backend](verificacion-backend-node24.md).
