# Plan del chat de backend

## Estado vigente V34 — guardado de rectificaciones legacy

Al2026-10-25: [V34](contrato-api-v34.md) completa la revisión V33 con confirmación propia JEFE+CSRF, versiones encadenadas, reintentos ligados a actor/intención, comprobante y auditoría atómicos. Añade consulta paginada/detalle con padres exactos. La vista AssignmentEffective y sus consumidores usan la última versión; la asignación original y el comprobante V11 conservan sus valores originales. No cambia la custodia ni el estado actual del equipo.

Migración0032 aditiva preparada y cliente Prisma regenerado. Requiere instalar0032 antes de iniciar estas lecturas; si sigue aplicada0025, `pnpm db:migrate` instala0026–0032. Probada exclusivamente en PostgreSQL independiente, sin instalación operativa ni carga del workbook. Ver [verificación vigente](verificacion-backend-node24.md). Los apartados V33 y anteriores siguientes son históricos.

Verificación V34 final:826 pruebas aprobadas,0 fallos/omisiones/cancelaciones,214.219s;15 nuevas (3 unitarias/11 integración/1 migración). Build forzado/lint API/tests/Prisma validate/whitespace/enlaces correctos. PostgreSQL18.6 aislado, base descartable eliminada, cero restantes y servidor temporal detenido.

Admite orígenes legacy con mda-closed-assignment-plan-2. Revalida origen íntegro, cadena, fuentes/versiones, identidad, fechas, destinatario, advertencias, solapamientos y límite terminal. Las guardas SQL verifican contexto y auditoría en la misma transacción y protegen la captura incluso tras constraints adelantados/SAVEPOINT. Planificar sigue sin guardar; la aplicación usa literal y ruta propios, distintos de las rectificaciones agrupadas.

Siguiente backend: compatibilidad explícita de comprobantes con reglas1, rectificaciones documentales V30/V32 y política de fuentes consumidas no admitidas. Tintas necesita definir unidad/significado de stock. Siguen pendientes integración frontend y piloto real autorizado con respaldo/conciliación. No se modificó ni contactó frontend.

## Avance V33 conservado — revisión de rectificaciones legacy

Al2026-10-20: [V33](contrato-api-v33.md) añade un plan JEFE+CSRF propio desde un item V11, con origen completo (todos los periodos/asignaciones/usos/auditorías), fuentes/versiones vigentes y antes/propuesta/diferencias. Conserva equipo, custodia actual, original, archivo y consumo. Reutiliza las reglas temporales/identidad/fuente anteriores y las lecturas efectivas, sin eximir hermanas ni usar rutas agrupadas como atajo.

Esta fase es exclusivamente de revisión: no guarda rectificaciones ni cambia AssignmentEffective; correctionApplicationImplemented=false y no hay `/apply`. Admite el flujo legacy con mda-closed-assignment-plan-2; reglas1/otras se rechazan explícitamente sin inventar metadatos. No añade migración/dependencia ni cambia esquema/cliente. La última migración preparada sigue siendo0031 (usuario confirmó0025 en operativa), sin instalación operativa durante este bloque. Ver [informe vigente](verificacion-backend-node24.md); los resultados V32 e inferiores siguientes son históricos.

Verificación V33 final:811 pruebas aprobadas,0 fallos/omitidas/canceladas,190.859s;25 nuevas (12 unitarias/13 integración). Las12 unitarias pasaron también en10 repeticiones. Build forzado/lint API/tests/Prisma validate/whitespace correctos. Se corrigió la captura de hora de creación de revisiones usando UTC milisegundos de PostgreSQL, sin relajar guards ni migraciones. Base descartable eliminada, cero restantes y servidor temporal detenido.

Siguiente backend: confirmación/versionado/idempotencia/auditoría propios y lectura efectiva append-only de estas rectificaciones. Después, compatibilidad explícita con reglas1, rectificaciones documentales V30/V32, política de consumos no admitidos, Tintas e integración/piloto real autorizado. No se modificó/contactó frontend ni se cargó el workbook.

## Avance V32 conservado — constancia documental de bajas agrupadas

Al2026-10-20: [V32](contrato-api-v32.md) implementa plan/confirmación propios JEFE+CSRF, comprobante/auditoría atómicos y consulta paginada/detalle. Conserva íntegros equipo/fecha/updatedAt, archivo, historia, stock, reservas y consumos. No terminales continúan pendientes. Requiere revisión activa, última decisión LINK_EXISTING vigente y cobertura exacta. Para grupos consumidos por su propio V29 permite solo evidencia adicional no aplicada y una decisión nueva después del retiro; fuentes V21/ajenas/incompletas y revisiones canceladas no reciben autoridad nueva.

Migración0031 aditiva preparada y cliente Prisma regenerado; sin instalación operativa ni carga del Excel. V30/V32 impiden duplicar una versión documental entre ambos almacenes. V31 conserva su consulta sin escritura ni confirmación implícita. Recuperación exacta de V32 y consulta permanecen disponibles tras cancelar, sin crear un nuevo comprobante. Ver [informe vigente](verificacion-backend-node24.md) para resultados completos; los conteos V31 y anteriores de abajo son históricos.

Verificación V32 final:786 pruebas aprobadas,0 fallos/omitidas/canceladas,253.286s;20 nuevas (2 unitarias/17 integración/1 migración), build forzado/lint API/tests/Prisma validate/generate/whitespace correctos. PostgreSQL18.6 aislado, base descartable eliminada, cero restantes y servidor temporal detenido. No valida despliegue, integración frontend ni carga real.

Usuario confirmó0025 aplicada y Node24.22.0/pnpm11.19.0. Si sigue esa base, `pnpm db:migrate` instala0026–0031 antes de iniciar este backend. No se tocó ni contactó frontend: integrar mediante contratoV32, sin reutilizar bajas/CRUD. Siguiente trabajo separado: correcciones legacy/documentales, política de fuentes consumidas no admitidas aquí, unidad/significado de Tintas e integración/piloto real autorizado con respaldo y conciliación.

## Registro histórico hasta V31

Estado al2026-10-20: treinta y un bloques implementados, sin carga real. Usuario confirmó0025 aplicada, Node24.22.0 y pnpm11.19.0. [V31](contrato-api-v31.md) consulta conciliación de bajas internas de grupos activos/cancelados sin reactivar autoridad ni guardar documentos; distingue observación aplicada/fila consumida y reservas actuales/propuestas históricas. V30 conserva conciliación documental de fuentes independientes sobre terminales; V29 aplicación de bajas agrupadas verificadas.0026–0030 preparadas/probadas únicamente, sin instalación operativa durante estos bloques; V31 no añade migración. Leer [contexto compartido](contexto-compartido.md) y contratos V1–V31. Este chat trabaja backend; frontend permanece en otro chat. Estados anteriores de0025 pendiente/Node26 son históricos; ver [registro](migracion-local-2026-10-05.md).

Verificación vigente V31:766 pruebas aprobadas en Node24.22.0 Linux/PostgreSQL18.6 independiente,200.106s.20 nuevas (10 unitarias/10 integración), build API forzado, lint completo API/tests, Prisma validate y whitespace correctos; esquema/cliente Prisma sin cambios respecto de V30. Consultar [informe](verificacion-backend-node24.md), que conserva5 tests previos del extractor Windows. Verifica consulta de conciliación agrupada y compatibilidad anterior con fixtures, no confirmación documental de grupos, integración frontend/despliegue/carga del Excel. Sin escritura operativa; cero bases descartables restantes y clúster temporal detenido. Requiere migraciones anteriores hasta0030; si sigue0025, pnpm db:migrate instala0026–0030, no hay0031 en este bloque.

## Avance vigente V31 — consulta de conciliación dentro de grupos

- [ContratoV31](contrato-api-v31.md): consulta JEFE+CSRF propia por lote/revisión/grupo/activo/observación, con cuerpo/query estrictos y snapshot REPEATABLE READ. No guarda ni confirma documentos, no aplica bajas ni cambia archivo, estado/fecha, reservas o consumos.
- Distingue la observación usada por V29 de una fila consumida junto al grupo; muestra comprobantes V14/V29 y asociaciones documentales V30 con metadatos y padres verdaderos. Grupos físicos independientes siguen separados aunque compartan candidato original.
- Revisión activa o cancelada con procedencia íntegra. Se extrae validación histórica de huella/filas sin simular una revisión activa: el validador operativo anterior sigue rechazando canceladas y ninguna decisión anterior adquiere autoridad nueva.
- Original/actual/proyección diagnóstica/identidad histórica/fecha existente/captura/versiones permanecen separadas. Correcciones posteriores, identidad/custodia/fuente/consumo ajenos y reservas de otra revisión quedan visibles como diagnósticos, no se corrigen automáticamente.
- No hay migración ni dependencia nueva: requiere almacenamiento anterior hasta0030. Sin escritura operativa, frontend ni contacto al otro chat; no se carga el workbook.
- Siguiente backend: confirmación documental propia de grupos con autoridad/procedencia/revalidación/auditoría atómicas y sin cambiar fechas, estado, reservas o consumos. V31 solo resuelve la consulta previa. Correcciones legacy/documentales, reglas Tintas e integración/piloto real autorizado siguen pendientes.

## Avance V30 — conciliación documental de terminales existentes conservada

- [ContratoV30](contrato-api-v30.md): plan sin escritura y confirmación documental JEFE+CSRF propia, con comprobante y auditoría atómicos e inmutables. Conserva íntegros estado/fecha/updatedAt/metadatos del equipo, asignaciones, stock y archivo; no ejecuta otra baja ni completa fechas.
- Una observación sin fecha sobre un activo no terminal sigue archivada/pendiente, sin retiro automático. Un terminal previo puede conciliar evidencia adicional vinculada inequívocamente, incluso si su fecha actual es null. Conflictos de identidad/custodia/fuente/versiones quedan bloqueados.
- Comprobante de versión específica, una captura por evidencia/versión, reintentos ligados a actor/intención, recuperación exacta tras enmiendas, listado paginado y detalle por activo. No es consumo operativo ni fija para siempre el vínculo actual de evidencia; V12 admisible sigue separado.
- Reconoce procedencia V14/V29 sin modificar comprobantes antiguos. Fuentes internas reservadas/consumidas por grupos no entran por esta ruta: requieren conciliación propia. Una fuente independiente adicional sí puede documentarse sobre un equipo previamente retirado por V29.
- Migración0030 aditiva sin backfill: tabla, FKs/índices/huellas, verificación de contexto/terminal previo, actor y versión vigentes, captura/auditoría en la misma transacción, inmutabilidad y protección ante constraints adelantados/SAVEPOINT. No se instala sobre operativa durante este bloque.
- Siguiente backend: conciliación de fuentes internas de grupos y correcciones legacy/documentales; Tintas requiere definir unidad/significado de stock. Integración frontend y piloto del workbook real siguen pendientes, con autorización/respaldo/conciliación. No se modificó ni contactó frontend.

## Avance V29 — confirmación de bajas agrupadas conservada

- [ContratoV29](contrato-api-v29.md): confirmación JEFE+CSRF propia de V28, revalidación bajo locks y aplicación atómica de terminal, comprobante, consumo de todas las filas y auditoría. No crea equipo ni usa el piloto de metadatos como bypass.
- Claves ligadas a revisión/actor/intención,201 nuevo/200 recuperación, listado paginado y detalle con padres exactos, incluso después de cancelación administrativa. Fuentes consumidas no se liberan al cancelar ni cambiar de lote.
- Original/actual/proyección revisada/fecha efectiva/captura separados; archivo, identidad, metadatos, stock, movimientos e historia no se reescriben. Activo/timeline añaden procedencia agrupada propia sin atribuir el acontecimiento histórico al importador.
- Migración0029 aditiva: dos tablas, integridad/huellas/autor/captura/contexto, inmutabilidad, cobertura/auditoría atómicas y límites temporales efectivos. Guards contra SQL falsificado, snapshots viejos y cambios posteriores a constraints adelantados/SAVEPOINT. Grupos físicos independientes conservan aplicación parcial con nueva revisión de contexto.
- Instalar0029 y generar Prisma antes de iniciar esta versión, también por sus lecturas. Si sigue aplicada solo0025, `pnpm db:migrate` instala0026–0029. No se ejecutó en operativa ni se modificó/contactó frontend.
- Siguiente backend: política/conciliación de bajas sin fecha y terminales previos, correcciones legacy/documentales y reglas Tintas. Integración y piloto real autorizado con respaldo/conciliación siguen pendientes.

## Avance V28 — revisión de bajas agrupadas conservada

- [ContratoV28](contrato-api-v28.md): plan JEFE+CSRF desde una revisión activa y su última decisión LINK_EXISTING; equipo existente único, versiones/huellas y cobertura de archivo exactas. Sin escritura ni migración nueva.
- No depende de V21/V23: V20/V21 rechazan grupos con bajas incluso en metadatos, por lo que exigir aplicación previa crearía un prerrequisito imposible. Ese bloqueo permanece y las rutas legacy no reciben excepciones.
- Original, interpretación actual y proyección propuesta de identidad se muestran separados; esta última solo existe en memoria, marcada REVIEWED_IDENTITY_GROUP_PROPOSAL. No guarda vínculos ni consume filas/evidencia.
- Reutiliza reglas V13 de fecha/prueba independientes, recepción como límite, custodia cerrada, estado coherente, terminal previo, historia efectiva y fuente BLOCKING; avisos de grupo y archivo reconocidos por separado. Desconocidos/actores null conservados.
- Snapshot REPEATABLE READ con decisiones, fuente/archivo, activo/custodia e historia efectiva V27. Límites explícitos, sin truncamiento; permisos, corrupción, vigencia y carreras probados con fixtures.
- La confirmación transaccional propia se añadió en V29; V28 conserva su lectura sin aplicación implícita. Bajas sin fecha/terminales previos requieren conciliación/política propia. Correcciones legacy/documentales, Tintas, integración y piloto real siguen pendientes.

## Avance V27 — rectificaciones conservadas

- Confirmación JEFE+CSRF propia, eventos append-only secuenciales, motivo/respaldo, claves ligadas a actor/intención, consultas paginadas/detalle y auditoría atómica. Hasta1000 versiones por item; no sustituye libremente activo/extremos.
- El plan V26 compara contra la última versión efectiva y exige expectedCorrectionVersion; sus banderas conservadoras false permanecen. La escritura solo existe mediante confirmación explícita V27.
- Assignment y comprobantes originales no se reescriben; tampoco archivo, consumos, activo/custodia actuales ni metadatos. Lecturas habituales/timeline muestran hechos efectivos más originalAssignment/historyCorrection para filas rectificadas, sin atribuir acontecimientos históricos al corrector.
- Planes, nuevas entregas, importaciones posteriores y bajas consultan fechas efectivas. Guardas SQL revalidan origen, cadena, huellas, fuentes, notas, diferencias, snapshots, autor y auditoría. Protecciones contra escritura/truncado del comprobante, snapshots antiguos, constraints adelantados y SAVEPOINT.
- Migración0028 aditiva y cliente Prisma actualizado necesarios antes de iniciar esta versión, también por sus lecturas. Si sigue aplicada solo0025, `pnpm db:migrate` instala0026/0027/0028. No se ejecutó en operativa ni se cambió frontend/dependencias/Excel.
- Traspaso frontend en [V27](contrato-api-v27.md). V28 inicia la revisión de bajas agrupadas verificadas; su confirmación y las reglas pendientes de bajas inciertas/Tintas y correcciones legacy/documentales quedan para bloques propios. No se declara completa la importación del workbook.

## Avance V26 — planificación conservada

- Plan JEFE+CSRF de rectificación de un item V25: origen, antes/después, diferencias materiales, motivo y respaldos separados. Extremos/activo/periodo derivados del comprobante, nunca sustituidos por el cliente.
- Verifica comprobante completo V25, todos sus periodos/asignaciones/usos/auditoría y padres V21/V23; solo entonces reconoce consumo propio para diagnóstico. No relaja lectores/aplicadores ni guardas existentes.
- Snapshot REPEATABLE READ con metadatos completos y custodia actual. Excluye del solapamiento solo la asignación rectificada; hermanas/custodia actual siguen contando. Desconocidos y actor histórico null conservados.
- Fechas con respaldo, día conocido, destinatario/préstamo/retorno, advertencias exactas, futuro/baja/solapamientos y no-op se validan de nuevo. Cambio de motivo o formato del mismo instante no simula una corrección.
- Contrato/traspaso inicial en [V26](contrato-api-v26.md). El bloque original no añadió persistencia ni migración; V27 incorpora confirmación explícita, versiones y lecturas efectivas con0028, sin reescribir original ni liberar extremos.
- Correcciones legacy/documentales, bajas agrupadas/inciertas, Tintas, integración y piloto real siguen pendientes.

## Avance V25 — aplicación original conservada

- Confirmación JEFE+CSRF del plan agrupado vigente; aplicación atómica de1–25 periodos cerrados, comprobantes propios, dos extremos únicos por periodo y auditoría completa.
- Reintentos ligados a actor/intención, consultas paginadas/detalle, selección parcial y rechazo de planes obsoletos, extremos consumidos o bloqueantes. Cancelar revisión no libera usos ni revierte historia.
- Historial y asignaciones reconocen procedencia agrupada manteniendo source=IMPORTED_HISTORY compatible con el timeline, actores históricos null y captura/importador separados.
- Migración0027 aditiva: origen exclusivo, inmutabilidad, coincidencia exacta de fuentes/propuesta/asignación y protección del activo/custodia. Las guardas sobreviven constraints adelantados y SAVEPOINT; un recibo legacy posterior no añade segundo origen.
- Instalar0027 antes de usar el backend actualizado, incluidas sus lecturas. Si sigue aplicada solo0025, `pnpm db:migrate` instala0026 y0027. No se ejecutó contra la base operativa.
- Contrato/traspaso frontend en [V25](contrato-api-v25.md); sin modificaciones frontend/dependencias/Excel ni mensajes al otro chat. Siguiente backend: correcciones explícitas de historia aplicada y reglas pendientes de bajas agrupadas/inciertas/Tintas; después integración y piloto autorizado.

## Avance V24 — planificación conservada

- Plan de asignaciones históricas cerradas desde un item V21 y sus links V23 exactos, con versiones, comprobantes completos y evidencia física confirmada. No usa lectores legacy como bypass del consumo.
- Reutiliza reglas puras V10 para fechas exactas con respaldo, destinatario/retorno/préstamo explícitos, advertencias y ausencia de solapamientos. Original/proyección/periodo propuesto se muestran separados; desconocidos y actor histórico null se conservan.
- Snapshot REPEATABLE READ del activo, asignaciones, archivo/enmiendas, usos, comprobantes y revisiones. Límites explícitos sin truncamiento; omisiones y archivo aún sin vínculo diferenciados.
- Endpoint y traspaso frontend en [V24](contrato-api-v24.md), JEFE+CSRF. El bloque original no incluía `/apply`; incorporado después en V25. Sus flags conservadores permanecen false. V24 no añadió migración ni modificó frontend/Excel/dependencias.
- La aplicación transaccional prevista se completó en V25. Correcciones, reglas Tintas/bajas inciertas, integración y piloto real siguen pendientes; el código actualizado requiere0027 también en las lecturas.

## Avance V23

- Confirmación explícita del plan histórico actualizado a reglas2 con requestId/huella/versión exactos; una sola proyección inicial por evidenceId global.
- Comprobante, selección parcial, proyecciones y auditoría en una transacción; recuperación idempotente por actor/intención y consultas paginadas/detalle JEFE.
- Original, enmiendas y vista legacy permanecen intactos; desconocidos no se sustituyen por fecha/importador. No crea asignaciones/bajas, cambia custodia ni libera consumo V21.
- Migración0026 aditiva con FKs, unicidad, inmutabilidad, validación SQL de contexto/proyección y guard diferido de cobertura/auditoría. Impide usar enmiendas V12 posteriores como corrección implícita de vínculos confirmados, incluso con snapshot SQL antiguo.
- Contrato y traspaso frontend en [V23](contrato-api-v23.md): revisar plan/advertencias, confirmar «Guardar vínculos históricos», conservar claves al reintentar y recuperar comprobantes. Frontend no modificado ni contactado.
- Siguiente backend: aplicación histórica operativa propia compatible con esta procedencia, después correcciones de historia aplicada. Tintas/bajas inciertas, integración y piloto real siguen pendientes. Antes de usar V23 en la app, el usuario debe aplicar0026 con `pnpm db:migrate`.

## Avance del primer bloque

- Tipo/marca/modelo de producto y metadatos opcionales de activos; filtros y búsqueda ampliados.
- Auditoría de cambios antes/después, validación y permisos existentes conservados.
- Consulta paginada de disponibilidad ASSET por producto, con alertas según AVAILABLE; no interpreta condición/finalidad automáticamente.
- Migración 0013 aditiva, probada en base descartable; no aplicada a base operativa.
- Contrato V1 publicado para frontend. Asignaciones a oficina, historial importado e importador siguen pendientes.
- Prisma validado/generado, API compilada y lint acotado sin errores; suite completa de 161 pruebas aprobada en PostgreSQL 18.6 con bases temporales descartables.
- WSL tiene Node 26 frente al Node 24 exigido; registrar esa limitación y repetir verificación en runtime soportado antes del despliegue.

## Avance del segundo bloque

- [Contrato API V2](contrato-api-v2.md): entrega PERSON/OFFICE, STANDARD/LOAN, previsión de retorno y referencias independientes de salida/entrada.
- Fechas efectivas explícitas con zona para JEFE/COORDINADOR, sin futuro ni solapamiento; defaults previos conservados para SOPORTE y clientes anteriores.
- Devolución a AVAILABLE/UNDER_REVIEW/IN_REPAIR con auditoría atómica; la entrega original y las cerradas permanecen inmutables.
- Historial muestra destinatario y fecha de captura separados de fecha efectiva; captura histórica desconocida queda null.
- Migración 0014 probada en base aislada, no aplicada a la operativa. No se crean usuarios por oficinas ni saldos separados por préstamos.
- Corregido un test CSRF que contaba activos de todos los archivos concurrentes: ahora consulta solo su producto de fixture.
- Validación final V2: Prisma, TypeScript/build API y lint acotado correctos; 173 pruebas aprobadas en la suite completa. Bases temporales eliminadas y verificación Node 24 todavía pendiente.
- Siguiente bloque: diccionario ejecutable, staging/preview y reconciliación, antes de una carga real del Excel.

## Avance del tercer bloque

- [Contrato API V3](contrato-api-v3.md): diccionario ejecutable de las 17 hojas, extractor administrativo XLSX y preview JSON para JEFE con CSRF.
- Preserva fila/hoja, tipos, fórmulas/cache, valores originales, filas ocultas y exclusiones explícitas. Lectura dispersa, sin recorrer max_row ni cambiar fuente.
- Reconciliación por serie/tag entre hojas y contra activos existentes, sin fusionar identidades contradictorias ni deducir estado actual por última fila. Tintas/resumen manual separados.
- Preview stateless, solo lectura operativa, canApply=false. Huellas de fuente/payload/reglas/snapshot/fecha. Sin migración nueva, sin upload web, staging persistente ni endpoint de aplicación.
- Smoke realizado con workbook real: encabezados válidos para las 17 hojas, lectura y comparación read-only con la base local. Datos de soporte fuera del repositorio.
- Validación final del bloque: 193 pruebas API/unitarias aprobadas en PostgreSQL descartable y 5 pruebas Python del lector. Compilación API, lint acotado y diff-check correctos. Smoke del motor compilado en Node 24.19 Windows; suite completa en Node 26 WSL, todavía pendiente repetirla en Node 24 antes de despliegue.
- Siguiente bloque: decisiones de revisión persistidas y piloto de aplicación protegido por vigencia/idempotencia, después de resolver reglas pendientes. B4/B5/B6 no están terminados por disponer de preview.

## Avance del cuarto bloque

- [Contrato API V4](contrato-api-v4.md): persistencia de lote/origen/preview y decisiones humanas con motivo/autor/versiones; solo JEFE, CSRF en escrituras.
- Migración 0015 aditiva: ImportBatch/ImportReviewDecision, evidencia y eventos inmutables, targets válidos y cada incremento asociado a un evento. Solo probada en bases descartables; no aplicada a operativa.
- Lotes idempotentes por previewId; decisiones por requestId ligado a intención/autor. Reintentos recuperan resultados anteriores sin duplicar ni pisar revisión.
- Concurrencia serializada por lote, versiones optimistas, auditoría transaccional y rollback. Vigencia de base/reglas para propuestas de identidad, sin bloquear ni modificar inventario.
- Consulta de metadatos/resúmenes, snapshot separado y latest/history paginado. Tintas/resúmenes/no mapeados pueden quedar pendientes/excluidos, no convertirse en activos.
- canApply=false incluso con cobertura de decisiones completa. Sin carga, productos creados, estado actual inferido ni historia importada. Almacenamiento no instalado devuelve 503 claro.
- Validación final V4: 211 pruebas API/unitarias/migración aprobadas en PostgreSQL 18.6 descartable, incluido payload de origen mayor a 1 MiB. Prisma validado/generado, compilación API, lint acotado y diff-check correctos. Suite completa ejecutada en Node 26 WSL; repetir en Node 24 soportado antes de despliegue.
- Siguiente: decisiones operativas explícitas por producto/activo/evento y plan/piloto de carga, con reglas dudosas sin resolver bloqueadas y entorno autorizado.

## Avance del quinto bloque

- [Contrato API V5](contrato-api-v5.md): plan de piloto de 1–25 equipos, solo JEFE+CSRF, ligado a versión del lote y decisiones vigentes. Fuente/inventario/catálogo leídos consistentemente en RepeatableRead.
- Creación propuesta con producto ASSET existente, identidad exacta, disponibilidad explícita y confirmada; actualización de metadatos sin alterar identidad/producto/estado. Bajas/asignaciones/historia y consumibles fuera del primer piloto.
- Diferencias antes/después, procedencia por hoja/fila, huella determinista vinculada también al estado del catálogo y metadatos actuales. Conflictos bloqueantes no se ignoran; warnings requieren reconocimiento exacto.
- Plan parcial con targets omitidos explícitos. canApply=false y persisted=false siempre: no equivale a aprobación, no guarda auditoría ni modifica revisión o datos operativos. No introduce migración nueva.
- Validación V5: 226 pruebas aprobadas en PostgreSQL 18.6 descartable, API compilada, lint acotado y diff-check correctos. Smoke del motor compilado en Node 24.19 Windows aprobado; suite completa en Node 26, repetirla en Node 24 antes de despliegue.
- Siguiente: aplicación transaccional/idempotente del piloto con procedencia persistida y reevaluación bajo locks. Ejecutarlo requerirá base destino autorizada y migraciones previas; resolver historia/Tintas en bloques propios. No simular aplicación mediante varias llamadas CRUD desde frontend.

## Avance del sexto bloque

- [Contrato API V6](contrato-api-v6.md): aplicación explícita y atómica del piloto V5, solo JEFE+CSRF, comprobantes recuperables por consulta/reintento.
- Reevaluación bajo locks, planId/versión vinculados, reutilización de servicios de activos/auditoría. Todo o nada; no aplica historia, bajas, consumibles ni asignaciones.
- Comprobantes inmutables con fuente/hoja/fila, decisión, autor actual, antes/después y resultado. Idempotencia por solicitud/intención/actor y unicidad origen/candidato entre lotes.
- Migración 0016 aditiva probada en bases descartables; no aplicada a operativa. Plan/revisión mantienen canApply=false; la escritura exige endpoint/confirmación V6, no CRUD simulado.
- La suite concurrente detectó deadlock al esperar bloqueos de tabla. Corregido con NOWAIT/rollback y reintentos acotados, preservando operaciones anteriores; hay prueba de regresión Asset→FK.
- Validación V6: 239 pruebas aprobadas en PostgreSQL 18.6 descartable con Node 26 WSL, incluidas 13 nuevas. Prisma validado/generado, compilación API, lint acotado y diff-check correctos. Suite completa Node 24 pendiente.
- Siguiente: repetir suite completa en Node 24, autorizar destino/respaldo e instalar migraciones antes de ejecutar piloto real. Preparar resolución/historia/Tintas por separado; no ampliar a todo el Excel por disponer de este endpoint.

## Avance del séptimo bloque

- [Contrato API V7](contrato-api-v7.md): correcciones explícitas de tipo/marca/modelo/fecha de recepción, motivo/respaldo/autor y restauración exacta. Fuente y snapshot original inmutables; no altera identidades, estado, destinatario ni otras fechas.
- Revisiones propias, append-only, secuenciales y con claves de reintento/concurrencia. Auditoría atómica, valores original/anterior/posterior y protección de candidatos ya aplicados incluso entre lotes de la misma fuente.
- Preview efectivo separado y revisión de catálogo paginada con sugerencias conservadoras de productos existentes ASSET activos; no creación ni elección automática.
- Plan/aplicación exigen revisión de origen vigente, recalculan incidencias y conservan correcciones en comprobantes. Reglas piloto mda-pilot-2; V6 mantiene huella compatible para recuperación de solicitudes anteriores sin correcciones.
- Migración0017 aditiva solo probada en bases descartables. 254 pruebas aprobadas en PostgreSQL18.6 con Node26; compilación, Prisma, lint acotado y diff-check correctos. Suite completa Node24 pendiente.
- Pendientes: resolver identidades ambiguas, historia/bajas/asignaciones, Tintas, continuidad de lotes, frontend y piloto real autorizado. No se corrigió ni cargó el Excel real.

## Avance del octavo bloque

- [Contrato API V8](contrato-api-v8.md): identidad serie/tag verificada y restauración para un candidato original, confirmación humana de todas sus observaciones, evidencia e historial V7 compartido. No deduce dígitos, borra incertidumbre ni admite force.
- Conserva IDs originales para decisiones/comprobantes, recalcula coincidencias e incidencias y rechaza fusiones/separaciones/colisiones entre candidatos. Máximo12 observaciones por evento; no resuelve grupos que necesiten dividirse o fusionarse.
- Decisiones ligadas a sourceRevision y renovación obligatoria tras cambiar/restaurar identidad, incluidas nuevas propuestas y matches verificados. Fuente, estado e identidades operativas intactos; piloteo limitado V5/V6 conservado.
- Migración0018 añade una columna default0 compatible y amplía guardas de origen/decisión. Probada solo en base descartable; no aplicada a operativa. Reintentos históricos y bloqueo sourceHash/candidato entre lotes conservados.
- 272 pruebas aprobadas, incluidas18 nuevas; Prisma, compilación API, lint acotado y diff-check correctos. Smoke V8 en Node24.19 Windows con fuentes empaquetadas temporalmente; suite completa PostgreSQL ejecutada en Node26 y aún pendiente en Node24.
- Siguiente: definir importación histórica/bajas/asignaciones sin inferir fechas/responsables, dejando Tintas y las identidades que requieren reagrupación en workflows propios. No se corrigió ni cargó el Excel real.

## Avance del noveno bloque

- [Contrato API V9](contrato-api-v9.md): archivo de evidencia física de recepción/uso/préstamo/baja, separado del historial operativo y con consulta paginada por lote/comprobante/activo vinculado.
- Conserva original, interpretación, referencias distintas, incidencias y correcciones. Día conocido o fecha desconocida explícita; nunca usa Fecha de recepción/año de hoja como fecha de baja ni atribuye ejecutor histórico al capturador.
- Captura JEFE+CSRF, explícita de1–25 observaciones, atómica/idempotente, sin modificar activos/asignaciones/stock/usuarios. Vínculo opcional, solo mediante identidad revisada inequívoca o comprobante V6. No duplica observación de una misma fuente entre lotes.
- Guardar evidencia persiste documentación, no aplica inventario: scope HISTORICAL_EVIDENCE_ONLY, affectsCurrentState=false y canApply=false. No incrementa versiones de revisión/origen. Capturas inmutables; enmienda/vínculo posterior requiere workflow propio.
- Migración0019 aditiva probada solo en bases descartables; no aplicada a operativa. 296 pruebas aprobadas, incluidas24 nuevas; Prisma, compilación API, lint acotado y diff-check correctos. Smoke V9 Node24.19 Windows aprobado; suite completa Node26 WSL, validación completa Node24 pendiente.
- Sigue pendiente reconstruir y aplicar periodos/asignaciones/devoluciones/bajas confirmadas, Tintas, reagrupación de identidades y ejecución real autorizada con respaldo. No se corrigió ni cargó el Excel real.

## Avance del décimo bloque

- [Contrato API V10](contrato-api-v10.md): plan read-only de1–25 periodos de asignación histórica cerrada por activo, desde evidencia V9 capturada/vinculada, solo JEFE+CSRF. No nueva migración ni escritura de historia.
- Exige confirmación humana, destinatario/retorno explícitos y fecha/hora/zona con referencia documental para ambos extremos. Fechas desconocidas no se completan; ejecutores históricos null y sin cuentas ficticias. Uso/recepción no prueban devolución automáticamente.
- Verifica registros diferentes, vínculo/identidad, coherencia de días, orden/futuro, cambios de origen, solapamientos entre propuestas/historia operativa y límite de baja. No cierra asignación actual ni reactiva terminales. Tickets/OT salientes no se convierten automáticamente en referencias de devolución.
- Snapshot consistente, huella ligada a evidencia/proof/activo/producto/asignaciones/correcciones. Bloqueantes conservados; tres conflictos de estado contextual requieren acknowledgement exacto por tratarse de historia cerrada sin inferir estado actual. V5/V6 no cambian.
- 317 pruebas aprobadas, incluidas21 nuevas; compilación API, lint acotado y diff-check correctos. Las12 unitarias V10 pasaron también en Node24.19 Windows empaquetadas temporalmente; suite completa PostgreSQL Node24 pendiente.
- Siguiente: persistencia/aplicación atómica de periodos cerrados confirmados con procedencia, actor desconocido separado del capturador, locks/idempotencia y protección de historia existente. Bajas/Tintas/enmiendas/identidades reagrupadas y carga real siguen pendientes. No se modificó ni cargó el Excel.

## Avance del undécimo bloque

- [Contrato API V11](contrato-api-v11.md): aplicación real de1–25 periodos cerrados confirmados por activo, solo JEFE+CSRF y confirmación nueva. Plan V10 permanece read-only; revalidación bajo locks y comprobantes consultables, no CRUD encadenado.
- Asignaciones/comprobantes/propiedad de extremos/auditorías atómicos, idempotencia ligada a intención/actor y recuperación incluso tras cambios posteriores. Una evidencia puede usarse una sola vez globalmente en cualquier extremo; periodos y origen inmutables.
- Ejecutores históricos null, capturador actual separado. Lecturas Assignment añaden importedHistory/importHistory; historial distingue acontecimiento/captura. Asignación vigente/estado/metadatos/baja del equipo y fuente/stock/usuarios intactos. Asignaciones normales mantienen actores obligatorios, DTO estrictos y reglas previas.
- Migración0020 probada sobre tablas pobladas en schema temporal y en bases descartables. Guardas SQL contra periodo inválido, origen incompleto, propuesta/propiedad alteradas, solapamientos y modificación de estado en la transacción. No aplicada a base operativa ni carga real.
- 334 pruebas aprobadas, incluidas17 nuevas; Prisma validado/generado, compilación API, lint acotado y diff-check correctos. Las15 unitarias V10/V11 también pasaron empaquetadas en Node24.19 Windows; suite completa PostgreSQL Node24 sigue pendiente.
- Runner ajustado para serializar archivos que comparten locks globales, preservando pruebas de solicitudes concurrentes dentro de cada archivo. No se debilitaron expectativas de conflictos ni se modificaron manifests/lockfile/frontend.
- Siguiente: enmienda/vínculo posterior de evidencia y bajas históricas con incertidumbre, luego Tintas e identidades reagrupadas según reglas verificadas. Integración frontend y piloto real requieren coordinación, entorno autorizado, respaldo/migraciones/conciliación. No habilitar carga masiva por disponer de V11.

## Avance del duodécimo bloque

- [Contrato API V12](contrato-api-v12.md): enmienda de una observación V9 por solicitud, con refresco desde origen V7/V8 y vínculo/desvínculo explícito. Plan JEFE+CSRF read-only y confirmación AMEND_HISTORICAL_EVIDENCE_ONLY para guardar; no cambia inventario ni actores históricos.
- EvidenceId/origen/captura original intactos; eventos secuenciales inmutables con respaldo/autor/versiones. Revalidación bajo locks, idempotencia ligada a intención/actor y auditoría atómica con rollback/reintento. Evidencia aplicada o de item en construcción bloqueada también en SQL.
- Lecturas por activo usan vínculo/interpretación vigentes, con versiones y valores capturados separados; comprobantes V9 conservan originales. Historial de enmiendas paginado por metadatos y detalle acotado a observación. Índices para vínculos/versiones y búsqueda de extremos; no escaneo indiscriminado para seleccionar evidencia de otro equipo.
- Plan de asignación mda-closed-assignment-plan-2 liga versión/amendmentId/revisión efectiva de evidencia. V11 usa la proyección vigente y guarda versiones exactas; reserva global de evidencia y recuperación de aplicaciones previas conservadas. Refrescar no elimina conflictos reales, rellena fechas desconocidas ni afecta asignación vigente.
- Migración0021 con tabla/vista/guardas e índices probada en bases descartables y schema temporal poblado, sin reescritura/backfill de evidencia. No aplicada a operativa ni carga real. Revisión independiente reforzó el caso de enmienda durante construcción y la verificación SQL de versión exacta, con regresiones específicas.
- 354 pruebas aprobadas, incluidas20 nuevas V12 (3 unitarias y17 integración); Prisma validado/generado, compilación API, lint acotado y diff-check correctos. Las18 unitarias V10/V11/V12 también pasaron empaquetadas temporalmente en Node24.19 Windows; suite completa PostgreSQL Node24 pendiente antes de despliegue.
- Siguiente: bajas históricas preservando incertidumbre, Tintas/identidades reagrupadas según reglas confirmadas y corrección operativa de historia aplicada mediante flujo propio. Integración/piloto real requieren entorno autorizado, respaldo, migraciones y conciliación. No se tocó frontend/manifests/lockfile ni el Excel real.

## Avance del decimotercer bloque

- [Contrato API V13](contrato-api-v13.md): plan read-only de una baja por activo existente, JEFE+CSRF, desde observación V9 y proyección/enmienda V12 vigentes. Sin nueva migración ni escrituras de dominio/revisión/evidencia/auditoría.
- Fecha de recepción/año de hoja no se convierten en retiro. Día de baja fuente y ejecutor histórico siguen desconocidos; exige instante/respaldo externos explícitos para una propuesta completa. Sin fecha verificable permanece bloqueada y archivada, no se completa con hoy.
- Bloquea asignación vigente/estado inconsistente, periodos posteriores, baja ya existente y conflictos de origen, sin heredar la excepción contextual V10. No cierra entregas, reactiva terminales ni reemplaza fechas operativas. Plan/hash liga fuente/versiones/prueba/activo/producto/historia/revisiones; lectura consistente y límites sin truncar.
- 372 pruebas aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas18 nuevas (10 unitarias y8 integración); compilación API, lint acotado y diff-check correctos. Las10 unitarias nuevas también pasaron en Node24.19 Windows. Validación completa PostgreSQL Node24 sigue pendiente. No se modificó frontend/manifests/lockfile ni el Excel real.
- Siguiente: aplicar bajas históricas verificadas mediante flujo transaccional propio con procedencia/actor desconocido separado del capturador, idempotencia y guardas. Bajas de fecha incierta/conciliación de terminales, Tintas/reagrupación/corrección operativa e integración/piloto real siguen pendientes. No usar /decommission corriente para simular importación.

## Avance del decimocuarto bloque

- [Contrato API V14](contrato-api-v14.md): aplicación de una baja histórica verificada por activo, JEFE+CSRF y confirmación nueva, desde plan V13 revalidado. Retiro terminal/fecha exacta, comprobante/versiones/reserva y auditoría en una transacción; idempotencia ligada a actor/intención y recuperación previa incluso tras revisiones posteriores.
- Conserva identidad/metadatos, origen/captura, asignaciones y saldos. Fuente de baja continúa día/ejecutor desconocidos; importador actual separado mediante appliedById/appliedAt. Lecturas normales añaden importRetirement y el historial muestra fecha histórica vs captura, actor null, sin duplicar baja corriente.
- V12/V13 consultan consumo de retiro; evidencia aplicada no admite enmienda tampoco en SQL durante construcción. Guardas de estado/comprobante inmutables, exactitud de evidencia/prueba/origen, ausencia de periodos posteriores y updates limitados al retiro terminal. No se cambia la baja corriente ni se fuerza custodia activa.
- Migración0022 aditiva probada en bases descartables y schema temporal poblado, no operativa. Requiere despliegue coordinado también para lecturas de activos/historial y V12/V13; no desplegar la API nueva sin tabla/guardas. No se tocó frontend, manifests/lockfile ni el Excel real.
- 392 pruebas aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas20 nuevas (3 unitarias y17 integración); Prisma validado/generado, compilación API, lint acotado y diff-check correctos. Las3 unitarias nuevas también pasaron empaquetadas temporalmente en Node24.19 Windows. Concurrencia, versiones enmendadas, permisos vigentes, rollback, origen/metadatos intactos, comprobantes y SQL cubiertos. Suite completa PostgreSQL Node24 pendiente antes de despliegue.
- Pendientes: bajas sin fecha verificable y conciliación de terminales, Tintas según unidad/reglas confirmadas, identidades reagrupadas/corrección operativa de historia aplicada e integración/piloto real con entorno autorizado/respaldo/conciliación. No habilitar carga general por disponer de V14.

## Avance del decimoquinto bloque

- [Contrato API V15](contrato-api-v15.md): conciliación read-only de una observación de baja frente al activo, JEFE+CSRF. Clasifica incertidumbre, custodia, fuente/vínculo, terminal previo y comprobante V14 propio/otra observación; no propone ni ejecuta transición.
- Conserva fecha/ejecutor desconocidos del origen separados de recepción, baja actual e importador/captura. No reemplaza fechas terminales, adjunta evidencia a comprobantes, cierra entregas ni habilita Aplicar. Diagnósticos/advertencias visibles y próximos pasos explícitos; V13/V14 no se relajan.
- Lectura RepeatableRead consistente incluso durante aplicación concurrente, huella de estado/origen/historia/versiones/comprobantes, límites heredados sin truncar, storage ausente503. Sin migración/dependencia nueva; requiere almacenamiento previo hasta0022. No se tocó frontend/manifests/lockfile ni Excel/base operativa.
- 410 pruebas aprobadas en PostgreSQL18.6 descartable con Node26 WSL, incluidas18 nuevas (9 unitarias y9 integración); compilación API, lint acotado y diff-check correctos. Las9 unitarias nuevas también pasaron en Node24.19 Windows. Actualización transversal posterior: las410 también pasaron en Node24.19.0 Linux, bases descartables eliminadas; build forzado/lint completo API/Prisma validate correctos y5 tests Python del extractor aprobados en runtime incluido Windows. Ver informe de verificación.
- Pendientes reales: decidir/implementar la resolución operativa de bajas sin fecha verificable y conciliación de terminales; Tintas con unidad/reglas confirmadas, identidades reagrupadas/corrección operativa de historia aplicada e integración/piloto autorizado. V15 completa el diagnóstico, no estos flujos operativos.

## Avance del decimosexto bloque

- [Contrato API V16](contrato-api-v16.md): plan read-only de separación/fusión/redistribución o corrección de identidad sin cambiar grupos, JEFE+CSRF. Selección explícita de candidatos originales, cobertura completa/distinta de1–25 observaciones, identidad/respaldo por grupo, origen/interpretación/deltas/collisiones visibles.
- IDs simulados no habilitan revisión/aplicación V4–V14; V8 conserva sus límites y prohibición de reagrupar. Detecta intercambios que necesitan coordinación y candidatos de más de12 filas para no recomendar escrituras V8 incompatibles. No usa identidades temporales ficticias ni borra identificadores inciertos.
- Snapshot RepeatableRead, huella de origen/inventario/revisiones/decisiones/evidencia/usos; consumo V6 por candidato y V11/V14 por fila de cualquier lote de la misma fuente bloqueados. Capturas/versiones/vínculos V12 originales y actuales distinguibles; no reescribe ni enmienda por simular.
- Sin migración/dependencia nueva, almacenamiento previo hasta0022 requerido; no se tocó frontend/manifests/lockfile ni Excel/base operativa. Todas las advertencias/bloqueantes pertinentes de modelo/estado/fechas/fórmulas/coincidencias se conservan.
- 430 pruebas aprobadas en Node24.19.0 Linux/PostgreSQL18.6 descartable, incluidas20 nuevas (11 unitarias y9 integración); base eliminada. Build API forzado, lint completo API, Prisma validate y diff-check correctos. La revisión de código añadió regresiones para casos V8 incompatibles y procedencia de evidencia capturada desde otro lote.
- Al cierre V16, persistencia de agrupaciones seguía pendiente. V17 añade comprobantes/reservas administrativas, sin aplicación de grupos ni renovación automática de decisiones/evidencia. No habilitar Aplicar V16 ni fabricar otro lote como sustituto. Bajas sin fecha/Tintas/corrección operativa/integración y piloto autorizado siguen abiertos.

### Decimoséptimo bloque implementado — revisión persistida de grupos y reservas cancelables

- [Contrato API V17](contrato-api-v17.md): guardar/listar/consultar/cancelar revisiones JEFE, CSRF en escrituras. Recalcula V16 con versiones, planId y todos los bloqueantes; idempotencia vinculada a intención/actor, recuperación incluso después de cancelar.
- Migración0023 aditiva: comprobante/snapshot y procedencia original→grupo por fila; cobertura completa, auditoría, restricciones SQL y reservas globales hash+recordId. Revisión/snapshot/procedencia/evento de cancelación inmutables; solo isReserved true→false bajo cancelación atómica. Índice único parcial contra reservas activas duplicadas.
- Reserva bloquea planificación/aplicación del piloto anterior, correcciones de los candidatos reservados y aplicación de su evidencia en historia V11/V14, incluso desde otros lotes de la fuente. Origen ya aplicado no puede reagruparse. Cancelar abandona los grupos, libera las filas y permite volver a validar flujos originales sin borrar historial.
- Conserva workbook, candidatos originales de resolved-preview, decisiones y evidencias archivadas; no modifica activos/asignaciones/stock ni migra vínculos. Siempre canApply=false/affectsCurrentState=false/groupedPilotImplemented=false. Reserva guardada no es carga de inventario.
- 446 pruebas aprobadas en Node24.19.0 Linux/PostgreSQL18.6 descartable, incluidas16 nuevas (3 unitarias y13 integración); base eliminada. Build API forzado, lint API/tests completo, Prisma validate/generate y diff-check correctos. La revisión de código reforzó unicidad activa, guards de items anteriores y rechazo de escrituras importadoras con snapshot obsoleto; READ COMMITTED explícito en mutaciones V7/V8.
- Siguiente paso: proyección efectiva estable de grupos, decisiones nuevas/vínculos de evidencia explícitos y piloto propio deduplicado. Bajas sin fecha, Tintas, corrección operativa, integración frontend y piloto real autorizado siguen pendientes.0023 no aplicada a operativa.

## Avance del decimoctavo bloque

- [Contrato API V18](contrato-api-v18.md): GET efectivo de una revisión de grupos activa, solo JEFE, sin parámetros adicionales, escrituras ni CSRF. Snapshot RepeatableRead de origen interpretado, lote, reservas, decisiones, evidencia y activos actuales.
- groupKey estable por hash de fuente/revisión/grupo, distinto de candidatos originales o simulados; nueva revisión obtiene claves nuevas aunque repita grupos. Observaciones conservan hoja/fila/recordId y distinguen identidad original, revisada, actual y proyectada.
- Recalcula coincidencias, colisiones externas y bloqueantes; muestra cambios de contexto respecto al comprobante sin reescribirlo. Decisiones anteriores son antecedentes, evidencia conserva vínculo capturado/vigente y null explícito; no transfiere aprobaciones ni vínculos a grupos.
- Valida snapshot/huella, cobertura completa, reservas y celdas de identidad selladas. Cancelación responde409 sin borrar el comprobante V17; corrupción/almacenamiento ausente/límites fallan explícitamente. Sin truncamiento silencioso ni expansión de la selección.
- canApply=false/persisted=false/reviewPersisted=true/affectsCurrentState=false/groupedPilotImplemented=false; no cambia resolved-preview, Excel, stock, activos ni historial operativo. No añade migración/dependencia ni modifica frontend.
- Validación final:462 pruebas aprobadas,16 nuevas (8 unitarias/8 integración),84.751s; base descartable eliminada. Build API forzado, lint completo API/tests, Prisma validate y diff-check correctos. Incluye UUID en mayúsculas, lectura consistente ante cambios/cancelación concurrentes y ausencia de efectos.
- Siguiente: decisiones y vínculos de evidencia explícitos/versionados por groupKey; luego piloto dedicado compatible con reservas/deduplicación global. Bajas sin fecha, Tintas, corrección operativa, integración frontend y piloto real autorizado siguen pendientes.

## Avance del decimonoveno bloque

- [Contrato API V19](contrato-api-v19.md): decisiones administrativas explícitas HOLD/EXCLUDE/LINK_EXISTING/PROPOSE_NEW por groupKey, JEFE+CSRF; listados latest/history paginados y comprobante individual con proyección revisada. No reutiliza decisiones antiguas del candidato.
- Versionado propio por revisión, huella V18 exacta/versiones de lote/origen actuales, autor/motivo/respaldo, idempotencia y comprobantes inmutables. Decidir no incrementa versión del lote ni cambia su fuente. Cambios posteriores se muestran como projectionCurrent=false, sin renovar autoridad.
- Propuestas a un activo exigen coincidencia única, las nuevas exigen ausencia de coincidencias y ambas rechazan bloqueantes. Toda evidencia del grupo requiere revisión explícita de pertenencia o exclusión del futuro piloto, ligada a su versión vigente; no modifica archivo/vínculos/fechas/historia ni reemplaza null capturado/actual.
- Migración0024 aditiva con índices y guards SQL para revisión/reservas/JEFE/keys/pertenencia/versiones/procedencia/cobertura. READ COMMITTED y locks compatibles con flujos anteriores; validación de inventario bajo NOWAIT, decisiones/cancelaciones serializadas. Auditoría atómica con rollback.
- Historial y reintentos siguen recuperables tras cancelar, pero no permiten decisiones nuevas ni reactivan reservas. canApply=false/affectsCurrentState=false/groupedPilotImplemented=false/evidenceRelinked=false.
- 484 pruebas aprobadas,22 nuevas (8 unitarias/14 integración),87.455s; base descartable eliminada. Build API forzado, lint completo API/tests, Prisma validate/generate y diff-check correctos. Incluye cancelación concurrente, escritor de inventario ocupado/reintento, nulidad explícita de evidencia y migración sobre tablas pobladas.
- Próximo bloque: plan/piloto dedicado de grupos con decisiones latest vigentes, reglas operativas explícitas y deduplicación global por filas. Tintas/bajas sin fecha/terminales/corrección operativa/frontend/piloto real conservan pendientes.0024 no instalada en operativa; Excel, frontend y dependencias no modificados.

## Avance del vigésimo bloque

- [Contrato API V20](contrato-api-v20.md): plan read-only propio de grupos, JEFE+CSRF, selección1–25 grupos completos de una revisión activa. CREATE disponible/sin asignación y UPDATE de metadatos no terminales, producto explícito/compatible, sin aplicar historia/custodia/bajas/cantidades.
- Consulta latest V19, exige decisionId exacto, versión propia de revisión/huella V18 y versiones de lote/origen actuales. Verifica huellas/reglas/procedencia de comprobantes; HOLD/EXCLUDE, decisión obsoleta/faltante, identidad sustituida y bloqueantes no se convierten en autorización.
- Una sola lectura RepeatableRead de fuente/reservas/decisiones/inventario/catálogo; diferencias antes/después, advertencias con reconocimiento exacto, grupos omitidos explícitos y planId determinista. Sin escrituras ni auditoría por consultar.
- Cada grupo conserva todas sus observaciones; varias filas pueden proponer un solo equipo. Claves globales de fila por hash+recordId, independientes de revisión, preparadas para el futuro recibo; no son consumo ni garantía de deduplicación operativa instalada.
- Evidencia conserva captura/vínculo vigente/null explícito/disposición V19 y appliedByThisPlan=false; excluir archivo no elimina señales de uso/baja del Excel. Reglas de producto/uso compartidas con el piloto antiguo sin alterar sus contratos.
- canApply=false/persisted=false/affectsCurrentState=false/groupedPilotPlanImplemented=true/groupedPilotImplemented=false. Sin nueva migración/dependencia; no modifica frontend, Excel ni base operativa.
- 511 pruebas aprobadas,27 nuevas (14 unitarias/13 integración),98.303s; base descartable eliminada. Build API forzado, lint completo API/tests, Prisma validate y diff-check correctos. Verifica coherencia ante cancelación/decisión/catálogo concurrentes, multiobservación, keys estables y reservas del piloto anterior.
- Siguiente: aplicación transaccional de grupos con recibos inmutables, idempotencia/revalidación bajo locks y deduplicación global por fila compatible con consumidores previos. Tintas/bajas sin fecha/terminales/corrección operativa/frontend/piloto real conservan pendientes.

## Avance del vigésimo primer bloque

- [Contrato API V21](contrato-api-v21.md): aplicación propia de grupos JEFE+CSRF y confirmación específica; GET de comprobantes/detalle y metadata paginada. Revalida decisiones/versiones/plan V20 bajo locks, sin enviar grupos al CRUD o piloto antiguo.
- CREATE disponible/no asignado y UPDATE de metadatos no terminales conservan restricciones V20. Comprobante/grupos/procedencia global por fila/activos/auditoría en una transacción; rollback incluso ante fallo de auditoría final y recibo SQL incompleto. Idempotencia ligada a intención/actor, recuperación tras cambios/cancelación y planes parciales explícitos.
- Migración0025 aditiva: tres tablas con FK/índices, usos sourceHash+recordId inmutables y guardas de cobertura/resultado. Cancelar solo libera reservas; no revierte aplicación ni permite reutilizar candidatos/filas consumidos desde otro lote. API y SQL mantienen el bloqueo de consumidores legacy y reservas nuevas. Los grupos restantes de la revisión activa requieren refresco/decisiones vigentes, no aprobación automática.
- Archivo/evidencia/null/vínculos y asignaciones vigentes intactos. Historia ligada a agrupaciones mantiene su futura aplicación específica; no se habilita V11/V14 por cancelar reservas después de aplicar V21. Cantidades y bajas no se aplican por esta ruta.
- Node24.19.0 Linux descargado/verificado en runtime temporal después de desaparecer el anterior; sin cambiar runtime global/dependencias/frontend/Excel. Build forzado, lint API/tests y Prisma validate correctos; validación transversal final en el [informe](verificacion-backend-node24.md).
- 0013–0024 ya instaladas localmente según [registro de migración](migracion-local-2026-10-05.md).0025 probada en bases descartables y schema temporal poblado, todavía no instalada localmente. Los flujos legacy que consultan consumo también requieren0025: coordinar antes de usar la API nueva.
- Pendientes: despliegue local0025, runtime de desarrollo Node24, integración/recorridos/roles; Tintas/bajas sin fecha/terminales/historia de grupos/corrección operativa de historia aplicada y piloto real autorizado con conciliación.

## Avance del vigésimo segundo bloque

- [Contrato API V22](contrato-api-v22.md): plan read-only de vínculo/proyección histórica por item V21 aplicado, JEFE+CSRF. Selección explícita de1–25 evidencias y destino derivado del comprobante; no acepta assetId/fechas/force del cliente.
- Valida reglas/huellas de plan e intención V21, operación/decisión/identidad, cobertura completa y consumo global de todas las filas. Captura del mismo hash/fila/candidato original, enmienda latest/versión exacta y original completo preservado. Otra fila/grupo/comprobante, corrupción o contexto excesivo fallan explícitamente.
- Distingue capturado/vigente/propuesto y la revisión V19 existente al aplicar V21 como antecedente sin autoridad automática. Proyección de identidad pendiente requiere reconocimiento de advertencia; evidencia usada, vínculo a otro activo, origen revisado, destino incompatible y no-op permanecen bloqueados. Fechas/actores desconocidos conservados, sin eventos operativos.
- Un snapshot REPEATABLE READ conserva coherencia ante cambios concurrentes. Se puede consultar tras cancelación administrativa sin desbloquear consumo de los flujos anteriores. Siempre canApply/persisted/affectsCurrentState/evidenceRelinked/historyLinkApplicationImplemented=false; planValidationComplete evalúa solo seleccionados.
- Las pruebas detectaron fallos intermitentes del guard de fecha de cancelación V17. El servicio ahora captura hora de PostgreSQL truncada a milisegundos antes de insertar, sin relajar el guard ni modificar SQL/migraciones. Regresión y recorridos previos verificados; resultado transversal en el [informe](verificacion-backend-node24.md).
- No añade migración/dependencia ni modifica frontend/Excel/base operativa. Usuario informó0025 aplicada y Node24.22.0/pnpm11.19.0. Para pruebas se utiliza un clúster PostgreSQL temporal independiente en127.0.0.1:25432, no la base local de la app.
- Siguiente: guardar vínculo/proyección histórica con confirmación/versión/recibo/auditoría propios y luego aplicar historia con esa procedencia. Corrección operativa, Tintas/bajas inciertas, integración frontend y piloto real siguen pendientes.

## Propiedad y fuentes

- Editar `apps/api/**`, `prisma/**`, este documento, contexto compartido y futura especificación de contrato/importación. No tocar web, DESIGN.md ni UX-CONTRACT.md durante trabajo paralelo.
- Preservar modificaciones existentes en servicios/schemas/tests y migración 0012 sin seguimiento. Revisar diff antes de tocar solapamientos.
- Aplicar instrucciones locales y skills pertinentes de ingeniería/arquitectura/TypeScript/PostgreSQL/estilo/testing antes de implementación correspondiente.
- Fuentes: `prisma/schema.prisma`, `apps/api/src/app.ts`, catálogo, rutas/services/schemas assets/assignments/inventory/corrections, locks/cantidades y tests existentes.
- Revisar ADR y migraciones 0009/0010: categorías/ubicaciones se retiraron deliberadamente. Ampliar justificadamente, no revertir migraciones.

## B1. Diccionario y modelo mínimo

Entregable previo al importador: reglas por hoja/columna, modelo propuesto y decisiones confirmadas/inferidas/pendientes.

1. Clasificar dato/header interior/resumen/nota/excepción, conservar origen hoja/fila y valores originales.
2. Separar producto tipo/marca/modelo de identidad física serie/tag/códigos alternativos; no fusionar ni duplicar por coincidencias parciales sin revisión.
3. Definir estado operativo vs. condición vs. finalidad. No un estado por cada palabra del Excel ni No Disponible→ASSIGNED universal.
4. Definir ubicación/sector contextual y destino persona/oficina; no stock multibodega ni oficinas como personas ficticias por defecto.
5. Definir referencias entrantes/salientes ticket/OT/OC/guía, notas, IP, hostname, préstamo y obsolescencia según necesidad.
6. Distinguir fecha efectiva/captura e incertidumbre histórica. No completar fechas dudosas con hoy ni atribuir acciones antiguas al importador como ejecutor original.
7. Confirmar Tintas: impresora receptora, unidad de conteo y relación guías/colores/consumos. No cargar como cartuchos únicos por Serie.

No asumir entidad nueva/enum cerrado/campo obligatorio para todo. Publicar diseño mínimo con casos anonimizados.

## B2. Contrato para frontend

Publicar antes de integración: DTO/enums/catálogos, método/ruta, permisos, filtros/paginación, request/response, null/opcional, errores, fechas, transiciones y ejemplos/pruebas. Distinguir implementado de propuesto. Preferir cambios aditivos compatibles.

Prioridades: metadatos, destino oficina/préstamo/devolución, historia con procedencia, disponibilidad y preview. Definir importación administrativa vs. upload web antes de prometer endpoint de carga. Frontend no debe adivinar contratos desde Prisma.

Reference/effectiveAt QUANTITY ya existen; no bloquear su UI por el nuevo modelo. El filtro de bajas es corrección frontend compatible con API actual.

## B3. Persistencia y operaciones

- Migraciones nuevas no destructivas y compatibles con datos previos; verificar versión PostgreSQL/restricciones. Separar crear migración de aplicarla a bases con datos.
- Conservar Asset/QUANTITY, stock consolidado, movimiento inmutable, compensaciones, locks y transacciones; no representar cada activo con saldo QUANTITY.
- Un solo destino/asignación activa por activo, transiciones consistentes. Definir autorización retroactiva/importación sin bypass general de reglas.
- Reconciliación de identidad independiente de unicidad producto+serie: conflictos G9/G10 no pueden generar duplicados silenciosos.
- Bajas terminales consultables; no reactivar/borrar para cuadrar totales.
- Disponibilidad/umbrales ASSET, si corresponden, con semántica común de resumen/alertas. Total de activos no es disponible.
- Historia importada diferente de auditoría actual; extender navegación real si procede, frente al límite actual 200 por fuente.

## B4. Importador: primero preview sin escritura operativa

1. Todas las hojas con mapeos contextuales; no recorrer rango residual gigante, descartar filtros ni ejecutar fórmulas/enlaces. No editar fuente.
2. Snapshot/hash/versionado de reglas/lote y procedencia. Excel/datos personales fuera de git/logs públicos.
3. Normalización trazable de espacios/identificadores, N/A/vacío, series numéricas. Señalar posible precisión perdida; no inventar dígitos.
4. Conciliar contra app y entre hojas: productos, activos únicos, eventos/consumos, falta de identidad. No elegir última fila automáticamente.
5. Incidencias por serie/tag/modelo, fechas, disponibilidad/condición, columnas desplazadas y referencias incoherentes.
6. Preview: conteos por hoja/globales, operaciones propuestas, coincidencias, bloqueantes/advertencias y excluidos con razón. Revisión persistida separada del dominio operativo.
7. Idempotencia por lote/registro/evento; segunda carga no duplica. Archivo cambiado no sobrescribe silenciosamente operaciones posteriores de app.
8. Aplicación de preview revisado con vigencia/estado concurrente, transacciones y recuperación; consultar resultado tras timeout antes de reintentar.

No importar Disponible como movimientos, filas como activos o nombres como cuentas. Accesorios sin identificador requieren tratamiento justificado; no identidad ficticia para forzar ASSET.

## B5. Tests y piloto

- Unitarias: 17 mapeos, headers, sparse ranges/filtros, identificadores/fechas, precedencia/incidencias.
- API/DB: permisos/DTO, migración sobre datos previos, locks/concurrencia, unicidad/asignación activa, stock no negativo, auditoría/fechas históricas.
- Importación: preview no cambia dominio, segunda carga idempotente, fuente revisada/cambiada, fallos y recuperación, ambiguos bloqueados, operación concurrente después del preview.
- Piloto: nuevo, persona asignada, retorno/reuso, oficina/préstamo/kit, baja, conflicto G9/G10 y tintas solo con reglas confirmadas.
- Fixtures pequeñas anonimizadas; no workbook entero en tests.

Comandos existentes: `pnpm --filter @inventory-ti/api typecheck`, `pnpm --filter @inventory-ti/api prisma:validate`, `pnpm --filter @inventory-ti/api test`, `pnpm --filter @inventory-ti/api build`. Leer runner/guardas DB antes de suites; no asumir DATABASE_URL descartable. Lint acotado y reporte honesto de pruebas impedidas/fallidas.

## B6. Integración y carga final

Pruebas conjuntas de recorridos/roles/errores/fechas y persistencia, no fixtures solamente. Carga real posterior: respaldo verificable, snapshot origen, preview revisado, autorización del entorno destino, piloto validado, conciliación e inicio del corte Excel/app. No migrar producción ni cargar por terminar el código.

Toda omisión/conflicto conserva motivo/procedencia. Recuperación proporcional al impacto sin borrar datos fuente. Registrar avance diseñado/implementado/probado/integrado en documentación propia y contrato; no mensajes a otro chat sin autorización explícita.
