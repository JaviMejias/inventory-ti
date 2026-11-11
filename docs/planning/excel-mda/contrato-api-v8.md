# Contrato API V8: identidad física verificada

Implementado en código al 2026-10-05; sin despliegue, migración operativa ni correcciones/carga del Excel real. Requiere0018_import_identity_review y migraciones anteriores. Extiende V7 con un endpoint separado para series/tags: `/source-revisions` V7 sigue admitiendo exclusivamente tipo/marca/modelo/fecha de recepción.

## Alcance y límites

- Verifica una pareja explícita serie/código de activo para un candidato original, con confirmación humana de que todas sus observaciones pertenecen al mismo equipo, motivo y referencia documental. No infiere dígitos de celdas numéricas ni ejecuta fórmulas.
- Corrige la interpretación de las columnas de identidad mapeadas de todas las observaciones del candidato; máximo12 observaciones y24 celdas por evento. No admite correcciones parciales de identidad por fila. Grupos mayores requieren otra estrategia antes de ampliar el límite.
- No cambia el XLSX ni el snapshot original, no fusiona/separa candidatos y no modifica series/tags de activos operativos. Tampoco elige un producto o equipo automáticamente.
- Conserva las incidencias ajenas: modelo, estado, baja, historial, columnas no mapeadas, fórmulas en otros campos, etc. Coincidencias operativas ambiguas siguen bloqueando el piloto aunque se pueda registrar la evidencia.
- La referencia y confirmación son responsabilidad del revisor JEFE. El servidor valida coherencia y límites; no acredita la autenticidad del documento ni la existencia física del equipo.

## POST /inventory/imports/batches/:id/identity-revisions

Solo JEFE+CSRF, body habitual máximo1MiB, objeto estricto:

```json
{
  "expectedRevision": 0,
  "expectedBatchVersion": 1,
  "requestId": "00000000-0000-4000-8000-000000000001",
  "candidateId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "action": "VERIFY",
  "confirmation": "VERIFIED_PHYSICAL_IDENTITY",
  "serialNumber": "00123456",
  "assetTag": null,
  "note": "Todas las observaciones corresponden al equipo cuya etiqueta fue revisada",
  "evidenceReference": "Fotografía de etiqueta y acta L-001"
}
```

expectedRevision0..999 y expectedBatchVersion1..2147483647 son enteros, sin coerción. requestId UUID estable; candidateId digest64 original. note trim1..2000 y evidenceReference trim1..500 obligatorios.

VERIFY requiere ambas propiedades serialNumber y assetTag: texto trim no vacío/placeholder, máximo160/100 respectivamente, o null. Al menos una debe ser texto. null solo es válido cuando ese campo no contiene identidad significativa ni incertidumbre de fórmula/error en la fuente original o interpretación actual. No sirve para borrar valores numéricos dudosos, tags contradictorios ni una identidad agregada por una revisión anterior. Para recuperar ausencia/valor anterior se restaura el original mediante RESTORE. No se añade una columna desconocida cuando el campo no existe en ninguna observación del candidato.

RESTORE requiere action `RESTORE`, confirmation `RESTORE_ORIGINAL_IDENTITY`, las mismas propiedades comunes y ninguna propiedad serialNumber/assetTag. Restaura todas las correcciones de identidad activas del candidato a sus celdas originales exactas, incluida ausencia/tipo/formato/fórmula. Es otro evento; no borra historial y puede volver a bloquear el candidato.

201 nuevo o200 reintento: `{ event, reused, canApply:false }`. Evento con valores original/anterior/posterior y origen por celda, usando ImportSourceRevision V7 y auditoría atómica IMPORT_SOURCE_CORRECTED. Un evento sin cambios reales se rechaza.

Comparte el contador sourceRevision, historial GET `/source-revisions`, idempotencia por lote/requestId/autor y locks V7. Correcciones descriptivas e identidad compiten por la misma revisión. Repetir una solicitud exitosa recupera el evento antiguo incluso después de aplicar; no indica que su revisión siga vigente. Otra intención/autor con la misma clave da409. Los motivos/referencias forman parte de la intención.

No acepta cambios que hagan que una fila migre a otro candidato, que fusionen/separen grupos originales o que los identificadores verificados se solapen con otro candidato. RESTORE puede recuperar un conflicto original, pero tampoco puede reagrupar con candidatos corregidos posteriormente. Estos casos necesitan un workflow separado, no un force/ignore.

## Preview, decisiones y plan

- GET `/resolved-preview` y `/catalog-review` usan la interpretación efectiva. Cada candidato conserva `id` original y recibe `effectiveCandidateId` (huella de la agrupación efectiva); todas las incidencias por candidato se remapean al id original. Usar exclusivamente el id original en decisiones, planes y comprobantes. Los IDs de filas no cambian.
- sourceContext añade `identityRevisions:[{candidateId,revision}]`: última revisión de identidad por candidato, incluidas restauraciones. corrections mantiene los REPLACE activos; puede estar vacío después de RESTORE sin que la decisión anterior vuelva a ser válida.
- `/preview` V4 sigue mostrando el snapshot original. En un preview efectivo, `records.originalCells` corresponde a la entrada ya interpretada por el motor V3; para la evidencia realmente original usar el snapshot V4 o `corrections.originalCell`. Mostrar ambos explícitamente. No guardar una interpretación corregida como si fuera otro Excel original ni simular una carga con CRUD.
- POST `/decisions` añade `expectedSourceRevision`0..1000, default0 para lotes sin revisiones. Aplica a todas las acciones. Se registra `decision.sourceRevision`. Omitirlo en un lote corregido da409 SOURCE_REVISION_CONFLICT; no asumirlo silenciosamente en frontend.
- LINK_EXISTING/PROPOSE_NEW se validan contra identidades y coincidencias efectivas, conservando vigencia de inventario/reglas. Permite proponer un candidato originalmente sin identidad usable cuando ya tiene identidad verificada y ningún equipo coincidente, o vincular una coincidencia nueva verificada. No permite elegir cualquier activo.
- Cambiar o restaurar identidad exige otra decisión explícita del candidato antes de aplicar: IDENTITY_REVIEW_DECISION_REQUIRED si su sourceRevision precede a la última revisión de identidad. Correcciones exclusivamente descriptivas mantienen la decisión de identidad previa, pero invalidan cualquier plan por el control global expectedSourceRevision V7.
- Planner pasa a `mda-pilot-3`; operaciones añaden identityRevision y decisionSourceRevision y conservan sourceCorrections. Requiere regenerar planes viejos. V6 reevalúa bajo locks y guarda la interpretación y aprobación utilizada en el comprobante.
- El piloto sigue limitado a CREATE_ASSET AVAILABLE o UPDATE_METADATA sin cambios de identidad/producto/estado. No importa asignaciones, bajas ni historia.

Los comprobantes y la unicidad sourceHash/candidateId siguen referidos al candidato original: verificar una serie no permite aplicar dos veces sus mismas filas desde otro lote. No se reinterpreta un candidato de una fuente que ya fue aplicado, aunque se intente desde otro lote. Usar las correcciones operativas existentes para cambios posteriores.

## Persistencia y compatibilidad

0018 añade ImportReviewDecision.sourceRevision con default0 compatible para registros existentes, sin atribuir retrospectivamente revisiones desconocidas. Amplía las guardas append-only de origen y decisiones, mantiene cadena de celdas/origen, revisiones, evidencia, locks y protección de candidatos aplicados. Las identidades SQL comprueban también su columna contextual y límites; una prueba contrasta ese mapeo con las17 hojas del diccionario.

No modifica tablas/filas de activos, productos, movimientos, asignaciones, fuente o comprobantes existentes. Los reintentos V4 anteriores sin revisión continúan recuperables; V6 conserva su huella de intención para revisión0. El nuevo endpoint verifica el almacenamiento V8 antes de persistir; ausencia de la migración devuelve503 IMPORT_REVIEW_NOT_READY. Desplegar/migrar backend antes de activar este flujo en frontend.

400 VALIDATION_ERROR, INVALID_SOURCE_TARGET, INVALID_SOURCE_FIELD, IDENTITY_CANNOT_DROP_SOURCE_VALUE y SOURCE_CORRECTION_LIMIT. 409 IDENTITY_REVIEW_SCOPE_LIMIT, IDENTITY_GROUP_CHANGE_REQUIRES_REVIEW, IDENTITY_CROSS_CANDIDATE_CONFLICT, SOURCE_FIELD_UNCHANGED, SOURCE_REVISION_CONFLICT, REVIEW_VERSION_CONFLICT, IDEMPOTENCY_KEY_REUSED, SOURCE_TARGET_ALREADY_APPLIED; decisiones/plan conservan sus errores previos. Permisos, recursos inexistentes, límites y errores saneados habituales.

## Verificación y pendientes

272 pruebas aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas18 nuevas de identidad, restauración, permisos, migración, reintentos, rollback, aprobación y deduplicación entre lotes. Prisma validado/generado, compilación API, lint acotado y diff-check correctos. Smoke de validadores/verificación/plan/restauración ejecutado con Node24.19 Windows mediante bundles temporales de las mismas fuentes; no sustituye la suite completa ni prueba integración DB en Node24. La importación directa desde Windows no resolvía symlinks pnpm Linux; no se cambiaron dependencias para realizar el smoke.

Quedan separar/fusionar identidades que afecten grupos, datos operativos históricos/bajas/asignaciones, Tintas, continuidad y escala de lotes, frontend y piloto real autorizado. Fuente real intacta y migraciones operativas pendientes.
