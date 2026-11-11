# Contrato API V34: confirmación y versiones de rectificaciones legacy

Estado al2026-10-25: implementación backend del guardado de los planes V33. Migración0032 preparada, sin instalación en la base operativa ni carga del workbook. No modifica frontend, dependencias ni contratos de rectificación agrupada V26/V27. Requiere0032 y cliente Prisma regenerado antes de iniciar esta versión, también para leer.

## Alcance

Guarda una versión append-only de un periodo cerrado importado por V11 con reglas mda-closed-assignment-plan-2. Conserva íntegros Assignment original, comprobante/items/usos originales, archivo/enmiendas, activo/updatedAt/metadatos, custodia abierta, stock y movimientos. La corrección cambia la interpretación efectiva del periodo, no el estado actual del equipo ni la autoría histórica.

No corrige comprobantes con reglas1, fuentes documentales V30/V32, bajas terminales, historia abierta ni identidades de extremos. Tampoco libera o vuelve a consumir evidencia. Esas políticas siguen separadas; no se usan rutas agrupadas, PATCH/DELETE ni una nueva importación para sustituir este flujo.

## Plan V33 extendido

Base `L=/assets/:id/imported-assignment-applications/:applicationId/items/:assignmentItemId`.

`POST L/correction-plan`, JEFE+CSRF y query vacía, conserva el cuerpo V33. expectedCorrectionVersion ahora acepta0..1000 (0 por defecto). Para una segunda rectificación hay que leer la última versión y enviar1, etc.; una versión vieja devuelve409 ASSIGNMENT_CORRECTION_VERSION_CONFLICT, no aplica cambios contra el original silenciosamente.

before refleja la última propuesta guardada o el original si no hay versiones; currentCorrectionVersion/currentCorrectionId y correctionChainDigest vinculan la cadena. originalPeriod/originalAssignment conservan el origen inicial. Se validan nuevamente el comprobante completo, sus hermanas/usos/auditoría, versiones de archivo, cadena, custodia actual e historia efectiva de los demás periodos.

La respuesta de planificación mantiene mode=CORRECTION_REVIEW_ONLY y canApply/persisted/affectsCurrentState/evidenceRelinked/operationalHistoryApplied/correctionApplicationImplemented=false. planValidationComplete=true solo significa que la propuesta de revisión no tiene bloqueantes. La confirmación explícita siguiente es un contrato independiente, no una deducción a partir de esas banderas.

## Confirmar

`POST L/correction-plan/apply`, JEFE autenticado+CSRF, parámetros/cuerpo estrictos y query vacía:

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "correctionPlanId": "huella real del plan de rectificación revisado",
  "confirmation": "APPLY_LEGACY_ASSIGNMENT_CORRECTION",
  "plan": {
    "expectedOriginPlanId": "huella real del comprobante V11",
    "expectedCorrectionVersion": 0,
    "reason": "Rectificar la transcripción frente a documentos verificados",
    "supportingReference": "Respaldo de la rectificación",
    "correction": {
      "start": { "confirmedAt": "2001-01-01T09:00:00-03:00", "dateEvidenceReference": "Entrega verificada con zona" },
      "end": { "confirmedAt": "2002-01-01T10:00:00-03:00", "dateEvidenceReference": "Devolución verificada con zona" },
      "recipient": { "type": "OFFICE", "name": "Oficina central" },
      "assignmentType": "STANDARD",
      "returnStatus": "UNDER_REVIEW",
      "note": "Nota efectiva rectificada",
      "evidenceReference": "Respaldo del periodo",
      "acknowledgedWarnings": []
    }
  }
}
```

Las huellas del ejemplo son explicativas: usar los valores reales hexadecimales minúsculos de64 caracteres. plan es el cuerpo de entrada normalizado de la revisión, no su respuesta. Conservar requestId/cuerpo ante una respuesta incierta. UUID normalizados a minúsculas; reconocimientos de advertencias se comparan sin depender de su orden. No acepta actor/fecha de captura/snapshots/estado del equipo/IDs alternativos ni confirmaciones V11/V27.

201 nuevo comprobante;200 recuperación exacta del mismo item/requestId, actor e intención, aunque posteriormente haya otra versión o cambie la custodia/metadatos actuales. Reutilizar la clave para otro actor, motivo, propuesta, versión o huella devuelve409 IDEMPOTENCY_KEY_REUSED. Los reintentos no generan otra auditoría ni corrigen otra vez.

Respuesta: scope=LEGACY_CLOSED_ASSIGNMENT_CORRECTION, persisted=true, reused, correction; affectsCurrentState/evidenceRelinked/canApply=false y operationalHistoryApplied=true. Esta última indica que la versión histórica queda disponible para lecturas efectivas, no que se haya ejecutado una entrega/devolución actual.

correction contiene id/itemId/version/previousId, requestId/requestDigest/correctionPlanId, rulesVersion=mda-legacy-assignment-correction-application-1, plan completo, reason/supportingReference, assetSnapshot/custodySnapshot, correctedById/correctedAt y marcador de transacción. correctedAt es hora de captura UTC milisegundos de PostgreSQL, no fecha del acontecimiento histórico; el corrector no sustituye a sus actores desconocidos null.

## Consistencia y almacenamiento

Revalidación READ COMMITTED bajo locks de fuentes ordenadas y contexto, timeout15s. Compara origen, cadena, versión, propuesta, advertencias, referencias, historia/custodia y metadatos vigentes. Plan viejo o bloqueado no escribe. En una transacción crea únicamente ImportAssignmentCorrection y AuditLog IMPORT_LEGACY_ASSIGNMENT_CORRECTED, con actor/contexto/padres/versión exactos. Un fallo de auditoría revierte el comprobante.

0032 añade tabla/FKs/índices, unicidad item+versión/item+requestId/huella y enlace al predecesor. No hace backfill ni reescribe inventario, archivo o periodos. SQL verifica secuencia, huellas/intención, todos los periodos/asignaciones/usos/auditorías del origen, fuentes y versiones, original/antes/propuesta, diferencias, fechas/destinatario/préstamo/retorno/advertencias, solapamientos y límite terminal. Exige JEFE activo/configurado y captura/auditoría en la misma transacción.

Comprobantes y auditorías de corrección/origen quedan inmutables; contexto protegido también tras constraints adelantados/SAVEPOINT. No se permite fabricar/actualizar el activo en la transacción de captura ni alterar después custodia/producto/fuentes/estado/stock. Una auditoría prefabricada en otra transacción no completa un comprobante nuevo. Las reglas SQL de reserva/consumo anteriores no se relajan.

## Lecturas efectivas

AssignmentEffective amplía su capa de lectura para elegir la última rectificación legacy o agrupada según el origen exclusivo de cada asignación. Sin versiones devuelve los valores originales, conservando compatibilidad. No hay una segunda Assignment ni se actualiza la original.

Detalle/listados/timeline muestran valores efectivos, originalAssignment y historyCorrection con id/version/correctedById/correctedAt. importHistory identifica el origen legacy y groupImportHistory el agrupado; no inferir el tipo de comprobante solo a partir del UUID de la corrección. source=IMPORTED_HISTORY sigue compatible; fechas/importador de captura y actores históricos permanecen separados de la rectificación.

Los planes posteriores, nuevas entregas, historia importada y límites de baja consultan esas fechas efectivas. Así, extender un periodo cerrado impide una nueva entrega que ahora se solape o una baja anterior a la devolución corregida. El comprobante V11 sigue mostrando su original, no se reescribe con la última interpretación.

## Consultar versiones

- `GET L/corrections?limit=25&offset=0`, solo JEFE, rectificaciones en orden de versión descendente, metadatos sin plan pesado: corrections,total,limit,offset,hasMore. limit1..100, por defecto25; offset no negativo.
- `GET L/corrections/:correctionId`, solo JEFE, query vacía, detalle completo bajo activo/comprobante/item exactos. Recursos ajenos devuelven404.

## Errores y recuperación

401/403 autenticación/JEFE/CSRF;400 validación;404 padres/items/comprobantes inexistentes o ajenos;503 IMPORT_REVIEW_NOT_READY si falta0032 o almacenamiento previo.409 propios:

- ASSIGNMENT_CORRECTION_VERSION_CONFLICT: refrescar última versión y volver a revisar.
- ASSIGNMENT_CORRECTION_PLAN_BLOCKED, details.blockers: resolver conflictos, no forzar.
- ASSIGNMENT_CORRECTION_PLAN_CHANGED: regenerar y revisar contexto/huella actualizados.
- IDEMPOTENCY_KEY_REUSED: clave usada para otra intención/actor.
- ASSIGNMENT_CORRECTION_BUSY: contención transitoria; reintentar la misma clave/cuerpo. Si el resultado previo es incierto, recuperar con la misma solicitud antes de proponer otra versión.
- ASSIGNMENT_CORRECTION_CONFLICT: consultar comprobantes y reevaluar versión.
- INVALID_ASSIGNMENT_CORRECTION_CHAIN: cadena guardada inconsistente, no continuar como una importación nueva.

Se conservan errores y bloqueantes de V33, incluidos origen/reglas no admitidas, custodia, identidad, fuente, cronología y no-op. Límite1000 versiones por item; los contextos previos siguen acotados, sin aprobación por truncamiento.

## Despliegue y traspaso

Instalar0032 y regenerar Prisma antes de iniciar este backend, incluidas sus lecturas. Si sigue aplicada solo0025, `pnpm db:migrate` instala0026–0032 según el procedimiento de respaldo/configuración existente. No se ejecutó contra la base operativa durante este bloque.

Frontend: después de revisar V33, ofrecer «Guardar rectificación histórica» mediante este literal/ruta propios, mantener requestId/cuerpo y refrescar listado, detalle, timeline y versión al recibir201/200. Mostrar original/última versión/propuesta y separar fechas históricas/captura/rectificación. No usar CRUD ni cambiar estado/retorno actual del equipo para simular la corrección.

Pendientes separados: compatibilidad explícita de comprobantes con reglas1, rectificaciones documentales V30/V32, política de fuentes consumidas no admitidas, significado/unidad de Tintas e integración/piloto real autorizado con respaldo/conciliación. No equivale a carga del Excel ni cierre de todo el backend.

Verificación final:826 pruebas aprobadas,0 fallos/omisiones/cancelaciones;15 nuevas (3 unitarias/11 integración/1 migración). Build API forzado, lint API/tests, Prisma validate, whitespace y enlaces locales correctos. PostgreSQL18.6 descartable, sin bases temporales restantes y servidor detenido. Ver [informe de verificación](verificacion-backend-node24.md).
