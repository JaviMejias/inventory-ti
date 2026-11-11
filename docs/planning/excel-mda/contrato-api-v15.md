# Contrato API V15: conciliación de bajas sin fecha y terminales existentes

Estado al 2026-10-05: implementado en backend, solo lectura. No acredita despliegue, instalación de migraciones operativas, integración frontend ni carga del Excel. V13/V14 conservan íntegros sus requisitos de aplicación. No introduce migración ni dependencia nueva; necesita el almacenamiento previo hasta0022.

## Propósito y límites

Ampliación posterior: [V30](contrato-api-v30.md) añade un flujo propio para asociar documentalmente una versión de evidencia a un terminal existente, con comprobante/auditoría y sin cambiar estado/fecha ni aplicar un retiro. V15 conserva íntegro este diagnóstico de solo lectura y sus banderas; las referencias siguientes a falta de resolución describen el alcance original de V15. La conciliación de fuentes internas reservadas/consumidas por grupos sigue necesitando su propio flujo.

La observación de una hoja de bajas puede archivarse aunque se desconozca el instante del retiro. V15 ayuda a decidir qué falta revisar frente al activo actual: identidad/origen, custodia, baja terminal previa y comprobantes de importación. No considera la fecha de recepción, el año de hoja, la fecha de captura ni la fecha actual como fecha de retiro.

No aplica una baja sin fecha, no cierra asignaciones, no completa fechas terminales, no adjunta evidencia nueva a comprobantes existentes, no reactiva y no modifica datos operativos/revisión/origen/evidencia/auditoría. La resolución operativa de terminales previos sigue pendiente de un flujo propio con respaldo. V15 no amplía la carga piloto ni introduce un botón Aplicar.

## Endpoint

`POST /assets/:id/imported-retirement-reconciliation`, solo JEFE autenticado + CSRF. El POST transporta criterios; no es escritura de dominio.

Request estricto:

```json
{ "evidenceId": "00000000-0000-4000-8000-000000000001" }
```

`id` y `evidenceId` son UUID; se normalizan a minúsculas. No acepta confirmaciones, fechas, estado, `force`, notas ni acknowledgements. Selecciona una observación existente, no crea ni busca automáticamente otra por serie o nombre.

HTTP200 devuelve el diagnóstico incluso cuando existen conflictos. HTTP401/403 para autenticación/rol/CSRF,400 `VALIDATION_ERROR` para DTO/parámetros inválidos,404 `NOT_FOUND` para activo/evidencia inexistentes. HTTP409 `INVALID_HISTORICAL_EVIDENCE`, `INVALID_SOURCE_REVISION` o `HISTORICAL_PLAN_LIMIT` si no puede interpretar el archivo seguro/completo;503 `IMPORT_REVIEW_NOT_READY` si falta almacenamiento de importación. Conserva la envoltura de errores existente.

## Respuesta

Campos superiores:

- `rulesVersion`: `mda-retirement-reconciliation-1`; `scope`: `HISTORICAL_RETIREMENT_RECONCILIATION`; `mode`: `READ_ONLY_RECONCILIATION`.
- `canApply=false`, `persisted=false`, `affectsCurrentState=false`, `operationalResolutionImplemented=false` siempre, incluso al consultar una baja anteriormente aplicada V14. Son propiedades de esta consulta; no niegan el efecto histórico de ese comprobante.
- `checkedAsOf`: día de evaluación en America/Santiago; `assessmentId`: SHA256 del contenido; `retirementPlanDigest`: huella interna del diagnóstico V13 con fecha/prueba externas nulas. Ninguna de estas huellas es aprobación ni sustituye `planId` V13/V14. No devuelve `planId`, `proposedRetirement` ni propuesta de escritura.
- `assetBefore`: misma proyección de activo/producto de V13, no el activo completo; `source`: procedencia/campos/versiones de V13 desde proyección vigente V12, con captura original distinguida de revisión efectiva.
- `sourceRetirement`: `{effectiveAt:null,datePrecision:"UNKNOWN",historicalActorId:null}` para RETIREMENT_OBSERVATION. Para una observación de otro tipo es null y se informa `RETIREMENT_EVIDENCE_KIND_REQUIRED`; no se relabela una recepción como baja.
- `existingRetirement`: null si el estado no es terminal `DECOMMISSIONED/isActive=false`; en terminal conserva `effectiveAt` de la app (ISO UTC o null), `datePrecision=INSTANT|UNKNOWN`, `dateOrigin=CURRENT_ASSET|VERIFIED_IMPORT_RECEIPT` y `confirmsSourceDate=false`. Una fecha existente no confirma el momento desconocido del Excel. Solo indica origen comprobante si el estado/fecha coinciden con ese comprobante.
- `existingApplication`: comprobante V14 del activo seleccionado o null; `evidenceApplication`: comprobante V14 que consumió la observación seleccionada o null. Pueden diferir y no se fusionan. Metadatos: `id,assetId,evidenceId,evidenceVersion,amendmentId,sourceRevision,decommissionedAt,appliedAt,appliedById`; no incluye plan, result, proof ni identidad/credenciales de usuario. `appliedById/appliedAt` son importador/captura, no ejecutor/fecha históricos.
- `warnings`: incidencias WARNING completas con ID/origen de V13; no se ocultan ni reconocen automáticamente para una futura aplicación.
- `diagnostics`: requisitos/conflictos de V13, incluyendo fecha/prueba faltantes y terminal existente. Solo omite `WARNINGS_NOT_ACKNOWLEDGED` porque esta consulta no acepta acknowledgements. Todos los BLOCKING de origen permanecen visibles. Añade `CURRENT_RETIREMENT_DATE_UNCONFIRMED` para fecha actual inválida/anterior a1900/futura y `IMPORTED_RETIREMENT_STATE_CONFLICT` si estado/fecha contradicen comprobante V14. Ninguna clasificación elimina estas incidencias ni relaja V13/V14.
- `nextSteps`: códigos descriptivos documentados abajo; `links.verifiedPlan` y `links.existingApplication`: ruta relativa o null, no instrucciones de ejecutar una operación.

### Clasificación

`classification` es diagnóstico, nunca elegibilidad de escritura. Precedencia: inconsistencia de estado → evidencia consumida en otro contexto → comprobante del activo → revisión de fuente → custodia → terminal previo → fecha faltante. Un comprobante recuperado puede coexistir con origen revisado después; revisar también `diagnostics/nextSteps`.

| classification | Significado |
| --- | --- |
| CURRENT_STATE_REVIEW_REQUIRED | Estado/periodos/fecha inconsistentes, o contradicción con comprobante. |
| EVIDENCE_ALREADY_USED | Observación usada por otra baja o por un extremo de asignación importada. No reutilizar. |
| ALREADY_IMPORTED_RETIREMENT | Existe comprobante V14 del mismo activo y observación; consultar, no volver a aplicar. |
| EXISTING_IMPORTED_RETIREMENT | El activo ya tiene comprobante V14 con otra observación. V15 no adjunta la seleccionada. |
| EVIDENCE_REVIEW_REQUIRED | Tipo/vínculo/identidad/reglas/vigencia/incidencias de origen requieren revisión. |
| CURRENT_CUSTODY_CONFLICT | Custodia activa coherente; no se cierra ni se retira mediante esta consulta. |
| EXISTING_UNDATED_RETIREMENT | Baja terminal previa sin fecha; no rellenar con fecha de recepción/año/hoy. |
| EXISTING_DATED_RETIREMENT | Baja terminal previa con fecha de app; no reemplazar ni atribuir a la observación. |
| RETIREMENT_DATE_UNCONFIRMED | Fuente vinculada y estado no terminal sin conflictos anteriores; obtener fecha exacta/prueba externa y solicitar un plan V13 nuevo. No asegura que ese futuro plan sea válido. |

`currentState`: `INCONSISTENT|ACTIVE_CUSTODY|TERMINAL_UNDATED|TERMINAL_DATED|NONTERMINAL`.

`evidenceState`: `USED_FOR_THIS_RETIREMENT|USED_FOR_OTHER_RETIREMENT|USED_BY_ASSIGNMENT|REVIEW_REQUIRED|ARCHIVED_ONLY`. Un uso ya persistido prevalece sobre revisión posterior; los problemas de fuente continúan en diagnósticos. `ARCHIVED_ONLY` no declara aprobación, retirada ni disponibilidad física.

### Próximos pasos descriptivos

`nextSteps` puede contener varios códigos:

- `REVIEW_EVIDENCE_LINK_AND_SOURCE`: revisar vínculo/origen; refresco/enmienda V12 solo cuando admisible, sin quitar conflictos.
- `REVIEW_CURRENT_STATE`: conciliar inconsistencia operativa fuera de V15.
- `REVIEW_CURRENT_CUSTODY`: investigar custodia real; no simular devolución para desbloquear carga.
- `REVIEW_EVIDENCE_CONSUMPTION`: consultar uso existente, no duplicarlo ni trasladarlo.
- `CONSULT_EXISTING_RETIREMENT_RECEIPT`: consultar comprobante V14 ya persistido.
- `RECONCILE_EXISTING_RETIREMENT_SEPARATELY`: requiere flujo operativo propio aún no implementado, no V14 sobre una baja previa.
- `PROVIDE_VERIFIED_DATE_AND_REQUEST_V13_PLAN`: fecha/hora/zona y respaldo externos; V13 reevalúa toda la cronología, advertencias y vigencia. No usar `/decommission` corriente como sustituto.
- `KEEP_UNDATED_SOURCE_EVIDENCE`: conservar incertidumbre original incluso si otro documento permite aplicar V14; no sobrescribir la observación.

`links.verifiedPlan` solo existe en RETIREMENT_DATE_UNCONFIRMED y apunta al POST V13; no habilita Aplicar. `links.existingApplication` solo apunta al comprobante del activo seleccionado. Si la evidencia fue consumida por otro activo, no se genera una ruta de comprobante con el activo equivocado.

## Consistencia y compatibilidad

Una transacción RepeatableRead lee activo/producto, versión efectiva V12, revisiones, asignaciones/consumo y comprobantes V14. Límites previos:10000 asignaciones/1000 revisiones, error explícito al exceder, sin truncar. Consulta de comprobantes por las dos claves únicas devuelve como máximo dos, sin escanear el archivo global. Timeout15s.

Huella cambia con estado/updatedAt/producto, historia de asignaciones, origen/versiones/incidencias, comprobantes y día de evaluación. No guarda aprobación ni clave de reintento. Consultar nuevamente tras enmienda/operación concurrente es necesario. API nueva necesita las migraciones previas instaladas; este bloque no las instala.

V13 sigue exigiendo fecha/prueba precisas y todas sus advertencias; V14 sigue revalidando bajo locks con confirmación independiente. Ni la clasificación de V15 ni el consentimiento de advertencias pueden anular conflictos de origen/custodia/terminal previo.

## Verificación y pendientes

18 pruebas nuevas:9 unitarias y9 de integración sobre permisos/DTO, incertidumbre, terminales existentes, custodia, vínculos/V12/revisión posterior, comprobantes V14 propios/ajenos, consultas sin efectos, límites/storage y snapshot consistente durante aplicación concurrente. Las9 unitarias también se ejecutaron empaquetadas temporalmente en Node24.19 Windows. Suite completa PostgreSQL18.6:410 aprobadas tanto en Node26 WSL como, posteriormente, en Node24.19.0 Linux soportado, con bases descartables eliminadas. Build API forzado, lint completo API, Prisma validate y diff-check correctos en la verificación Node24;5 tests del extractor aprobados en Python incluido Windows. Ver [informe transversal](verificacion-backend-node24.md); no equivale a despliegue ni carga real.

Queda pendiente la política/flujo operativo de bajas realmente sin fecha confirmable y conciliación de terminales, Tintas según reglas confirmadas, identidades que requieren reagrupar, corrección de historia aplicada e integración/piloto real con respaldo/autorización. Este bloque implementa diagnóstico, no declara resueltos esos flujos.
