# Contrato backend V2: destinatarios, préstamos y devoluciones

Fecha: 2026-10-05. Extiende [V1](contrato-api-v1.md). Implementado y verificado en base aislada; **no desplegado ni migrado en la base operativa**. Requiere Prisma generado y migración `0014_assignment_destinations`, además de revisar las migraciones previas pendientes.

## Decisiones y compatibilidad

- Assignment continúa siendo una entrega y admite destinatario PERSON u OFFICE. Nunca se crea una cuenta de acceso para una oficina.
- STANDARD significa entrega sin marca explícita de préstamo, no una entrega irrevocable o permanente. LOAN distingue el préstamo; expectedReturnAt es opcional. El loanCode del activo V1 es un identificador del equipo, no el tipo de cada entrega.
- Solo una entrega activa por equipo, usando el lock y las restricciones existentes. Una entrega a oficina también pone status=ASSIGNED; la devolución cierra ese registro.
- No se crea otro inventario para préstamos, oficinas o kits. V2 no define composición ni membresía de kits.
- Asset.location/sector son metadatos V1: asignar a oficina no los cambia automáticamente. OfficeName es destino de custodia; un traslado físico requiere un flujo distinto si se necesita.
- Los requests existentes de PERSON sin recipientType/assignmentType conservan sus defaults. personName permanece igual en esas respuestas, pero es **null en OFFICE**: frontend debe manejar ambos casos explícitamente.
- Entrega/devolución tienen fecha efectiva distinta de captura. Esto no es un importador de acontecimientos antiguos ni autoriza sobrescribir historia.

## POST /assets/:id/assignments

Permisos: JEFE, COORDINADOR, SOPORTE, todos con CSRF. Conserva respuesta 201 `{ assignment, asset }`.

| Campo | Regla |
| --- | --- |
| recipientType | PERSON (default) u OFFICE. |
| personName | Para PERSON: nombre/apellido, 2–150 caracteres; puede omitirse si se envía personId. |
| personId | UUID opcional para PERSON, compatible con destinatarios que ya tienen cuenta. |
| officeName | Obligatorio para OFFICE, 1–160 caracteres, con trim. Prohibido en PERSON. |
| assignmentType | STANDARD (default) o LOAN. |
| expectedReturnAt | ISO con hora y zona u offset, opcional/null. Solo LOAN y estrictamente posterior a startedAt. Puede ser futura por ser una previsión. |
| effectiveAt | ISO con hora y zona u offset, opcional. Se guarda como startedAt. |
| ticketReference / otReference | Texto opcional/null, máximo 160 cada uno. Son referencias de SALIDA. |
| notes | Texto opcional/null, máximo 10.000. Notas de SALIDA. |

No mezclar persona y oficina. Una entrega PERSON requiere personName o personId; si hay ambos se conserva la conducta existente de usar personName como snapshot y personId como asociación. OFFICE prohíbe personName/personId, y la respuesta devuelve person=null/personName=null/personId=null.

Las referencias/notas se recortan; vacío se convierte en null. Claves desconocidas se rechazan con VALIDATION_ERROR, no se descartan. No se admiten id/assetId/estado/creador como campos del body.

```json
{
  "recipientType": "OFFICE",
  "officeName": "Pucon",
  "assignmentType": "LOAN",
  "expectedReturnAt": "2026-10-15T18:00:00-03:00",
  "ticketReference": "1258508",
  "otReference": "OT-20",
  "notes": "Equipo de contingencia"
}
```

Respuesta Assignment conserva los campos/relaciones previos y añade recipientType, officeName, assignmentType, expectedReturnAt, ticketReference, otReference, notes y campos de devolución descritos abajo. No hay PATCH de estos campos; la información de entrega se conserva al cerrar.

## Fechas y autorización

- Sin effectiveAt se usa el momento del servidor y se conserva el flujo operativo previo.
- JEFE/COORDINADOR pueden indicar fecha efectiva pasada o actual; SOPORTE no puede enviarla explícitamente y recibe FORBIDDEN (403). SOPORTE sí puede indicar expectedReturnAt para un préstamo.
- Rechazar fechas efectivas futuras; no aceptar números, booleanos, fecha sola ni hora sin zona. Ejemplo válido: `2026-01-01T10:00:00-03:00` → `2026-01-01T13:00:00.000Z`.
- Nueva entrega no puede comenzar antes del último endedAt registrado del equipo. Igualdad en el límite se permite; no insertar una entrega antigua entre las ya cerradas por esta API.
- Devolución tiene que ser estrictamente posterior a startedAt. Si no se indica fecha, se conserva el ajuste mínimo existente para cerrar incluso en el mismo milisegundo de una entrega.
- No guardar como hoy una fecha histórica desconocida. El importador futuro tendrá su propio mecanismo de preview/procedencia; este endpoint no reconstruye todo el Excel.

## POST /assets/:id/assignments/:assignmentId/return

Mismos roles y CSRF. Acepta ausencia de body o `{}` y conserva retorno AVAILABLE. Response 200 `{ assignment, asset }`.

| Body | Regla / persistencia |
| --- | --- |
| effectiveAt | Misma autorización/validación; se guarda como endedAt. |
| returnStatus | AVAILABLE (default), UNDER_REVIEW o IN_REPAIR. No acepta ASSIGNED, DECOMMISSIONED, RESERVED, LOST ni IN_WARRANTY. |
| ticketReference | Referencia de ENTRADA; se guarda como returnTicketReference. |
| otReference | OT de ENTRADA; se guarda como returnOtReference. |
| notes | Notas de ENTRADA; se guarda como returnNotes. |

```json
{
  "returnStatus": "UNDER_REVIEW",
  "ticketReference": "1260100",
  "otReference": "OT-RET-20",
  "notes": "Revisar antes de reasignar"
}
```

La devolución cierra la asignación, conserva el destinatario original y sus referencias, guarda endedById/returnRecordedAt/returnStatus y cambia el estado del equipo en una única transacción con auditoría. No altera cantidades ni technicalCondition automáticamente.

Un retorno UNDER_REVIEW/IN_REPAIR no deja el equipo asignable; para volver a AVAILABLE se debe usar el flujo de estado existente tras la evaluación. No confundir recibido con disponible.

Los registros cerrados anteriores a V2 tienen returnStatus y returnRecordedAt null: no se rellenan con suposiciones. Nuevas devoluciones por API siempre los guardan. No cambiar ni borrar una entrega cerrada para corregir referencias.

## Lectura y filtros

`GET /assignments` y `GET /assets/:id/assignments` añaden recipientType, assignmentType y officeName (contains sin distinguir mayúsculas), además de filtros previos personId/active/assetId. Limit 1–100 (default 50), offset 0–2.147.483.647 (default 0). Orden startedAt/id descendente.

Ambas listas añaden hasMore y conservan assignments/total/limit/offset. En la ruta por activo, el id del path manda sobre cualquier assetId del query. CurrentAssignment informa la entrega activa de ese activo aunque los filtros de la lista no la incluyan. GET `/assignments/:id` conserva `{ assignment }`. Lecturas para todos los roles autenticados, sin CSRF.

No se implementó filtro de vencimiento ni notificaciones automáticas de préstamos. Frontend no debe prometer monitoreo por disponer de expectedReturnAt.

## Historial del activo

GET `/assets/:id/history` conserva `{ events }`, ids/kind/action y orden por fecha efectiva. Eventos de asignación añaden:

- recipientType, recipientName, officeName y assignmentType.
- expectedReturnAt.
- recordedAt: createdAt de entrega o returnRecordedAt de devolución; null cuando se desconoce la captura antigua de retorno.
- ticketReference/otReference/notes de la etapa correspondiente.
- returnStatus en el evento de devolución; null para registros anteriores sin ese dato.

Person permanece como nombre de persona o null; recipientName permite mostrar ambos tipos. Actor es quien registró la operación en la app, no una inferencia sobre quién ejecutó un acontecimiento antiguo.

El endpoint conserva el límite previo de 200 por fuente: añadir campos no lo convierte en historia exhaustiva. Las listas de asignaciones sí tienen paginación real; navegar todas las páginas cuando se requiera cobertura completa.

## Integridad y errores

- Conserva ASSET_NOT_ASSIGNABLE, ASSET_ALREADY_ASSIGNED, USER_INACTIVE, ASSIGNMENT_ALREADY_CLOSED, ASSIGNMENT_REQUIRED y los errores/roles previos.
- Nuevo `ASSIGNMENT_DATE_CONFLICT` (409): fecha de retorno no posterior a entrega o entrega que se solapa con historia cerrada. Frontend debe traducirlo y conservar formulario para corregir fecha/actualizar historia.
- VALIDATION_ERROR (400), con paths de campos, para formato, fecha futura y previsión inválida; FORBIDDEN (403) para fecha explícita de SOPORTE; CSRF_INVALID (403) y UNAUTHENTICATED (401) sin cambios.
- La DB impide destinatarios mixtos, previsión en entregas STANDARD, metadatos de retorno en entregas activas y estados de retorno inválidos. El trigger conserva también personName, oficina, tipo y referencias originales durante cierre, y sigue prohibiendo modificar/borrar cerradas.
- El lock del activo serializa entregas, retornos y cambios de estado; una falla de auditoría revierte cierre/referencias/estado. La validación de fechas de no solapamiento es de la API; no se añadió una exclusión de intervalos a todos los registros históricos de la DB.

## Migración y verificación

0014 conserva asignaciones existentes como PERSON/STANDARD y sus nombres/fechas, sin cambiar filas de historia ni inventar metadatos de retorno. Añade enums/columnas/restricciones y amplía el trigger existente en transacción. No elimina datos, usuarios ni restricciones de una entrega activa por activo.

Revisar backup y todas las migraciones pendientes antes de un entorno con datos. Cambiar personName a nullable es necesario para OFFICE; clientes que solo renderizan personName deben actualizarse antes de habilitar entregas a oficinas. No arrancar Prisma V2 sobre esquema anterior.

Verificado con Prisma validado/generado, compilación API, lint acotado y **173 pruebas aprobadas** en la suite completa sobre PostgreSQL 18.6 aislado. Las bases temporales se eliminaron al terminar. WSL sigue en Node 26.7.0 frente a Node 24 requerido: repetir los checks en runtime soportado antes de despliegue. No se ha migrado la base operativa ni cargado el Excel.

Pendiente: staging/preview e importación idempotente con procedencia, incertidumbre histórica, obsolescencia, reconciliación de identidad, tintas y disponibilidad Alta/Reposición/Usado. V2 no reemplaza ese trabajo.
