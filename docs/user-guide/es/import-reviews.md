# Revisión administrativa e historia importada

Estas herramientas están disponibles para **Jefe**, cuando su configuración ha sido habilitada y la API correspondiente está desplegada. Se accede desde **Inventario → Revisar importaciones**. Un lote de revisión conserva el origen y sus decisiones; no equivale a una importación aplicada.

## Crear un lote

1. Pulsa **Nuevo lote** y selecciona el `.json` completo generado por el extractor. Este formulario no recibe directamente un Excel `.xlsx`. El límite es16MiB; no elimines filas para hacerlo caber.
2. Pulsa **Generar previsualización**. Revisa registros, incidencias, hojas y filas excluidas con sus celdas originales. Los filtros de ese modal no cambian la búsqueda del listado de lotes.
3. Confirma que revisaste el análisis y pulsa **Guardar lote de revisión**. Guardar puede conservar advertencias/conflictos para examinarlos; no crea activos ni movimientos ni aprueba esas propuestas.
4. El comprobante muestra el archivo, ID, creador original y fecha de registro. **Revisar lote** abre su espacio de trabajo.

Si el resultado del guardado no se puede confirmar, utiliza **Recuperar mismo intento** sin cambiar el archivo ni generar otro análisis. El servidor puede devolver el lote ya creado. Si el análisis perdió vigencia, la aplicación exige generarlo y revisarlo nuevamente. Los errores aparecen en español dentro del modal y en una notificación visible.

## Periodos históricos cerrados

En **Inventario → Activos rastreables**, **Preparar periodo histórico** permite documentar de1 a25 periodos de un mismo activo. Elige una evidencia de inicio y otra de cierre para cada periodo, incluso desde páginas diferentes. Un extremo no puede repetirse en el conjunto. Añadir un periodo no copia datos del anterior; quitarlo pide confirmación.

Introduce solo fechas exactas, destinatarios y respaldos contrastados. No conocer una hora no autoriza inventarla: el plan muestra los bloqueos del servidor. **Generar plan** revisa todos los periodos sin guardarlos; puedes seleccionar cada resultado y revisar sus advertencias. Cualquier edición exige generar otro plan.

Con todos los periodos completos y la aplicación habilitada, **Revisar aplicación permanente** muestra el conjunto entero. Escribe la confirmación solicitada para aplicarlo en una sola operación. Si un periodo falla, el conjunto no se aplica parcialmente. Se guarda historia cerrada; no cambia el stock, el estado actual del activo ni su asignación vigente.

## Consultar comprobantes y procedencia

Desde el historial del activo puedes consultar los comprobantes de periodos y sus detalles. Los comprobantes antiguos compatibles se muestran como historia archivada; no ofrecen volver a aplicar el plan. El piloto también permite consultar sus comprobantes V6 originales sin inventar revisiones de origen posteriores.

Las entregas y la línea de tiempo distinguen hechos originales y efectivos cuando hubo rectificación. La fecha/autor de importación o rectificación corresponde al registro en la app; no identifica a quien realizó una entrega antigua. Los datos desconocidos siguen indicados como desconocidos.

Los borradores e intentos inciertos permanecen en memoria. Cerrar con cambios pide confirmación y recargar puede perderlos; salir no revierte una operación que el servidor ya haya confirmado. Si se perdió un intento incierto, consulta los comprobantes existentes antes de iniciar otro.

## Situación actual de una agrupación

Si esta consulta está habilitada, abre **Consultar revisiones de agrupación → Ver revisión → Consultar situación actual**. Aparece para Jefe en una reserva activa. El comprobante guardado se conserva; la nueva vista compara sus grupos con el origen, la evidencia y el inventario actuales.

Selecciona un grupo para revisar identidades, filas de origen, coincidencias y evidencia. La clave del grupo permanece estable dentro de esa revisión; sus candidatos simulados no son activos. Si se muestran10 de11 coincidencias, existe otra coincidencia fuera del resumen: no se presenta la lista como completa. Un vínculo actual vacío no se rellena con el vínculo que tenía la evidencia al capturarla.

**Actualizar consulta** vuelve a contrastar el contexto y conserva el grupo seleccionado. Las tablas muestran hasta25 registros por página. Un fallo conserva el resultado anterior, claramente sin vigencia confirmada, y permite reintentar. **Volver al comprobante** devuelve al botón de origen. Si otra sesión canceló la reserva, consulta el comprobante guardado para ver esa cancelación.

Esta vista no guarda cambios ni permite aplicar grupos. Incluso sin bloqueos, cada grupo necesita una decisión propia y su evidencia requiere revisión explícita antes de continuar por los futuros flujos habilitados.

## Decidir un grupo y revisar sus evidencias

Con V19 habilitado, desde **Consultar situación actual** selecciona el grupo y pulsa **Revisar decisión del grupo seleccionado**. La aplicación comprueba la proyección y la versión global de decisiones de toda esa revisión. No se elige una acción ni un activo por ti.

1. Elige **Dejar pendiente**, **Excluir del futuro piloto**, **Proponer vínculo con activo** o **Proponer activo nuevo**. Las propuestas requieren una consulta sin bloqueos y coincidencias compatibles. Solo se puede proponer el único activo sugerido; excluir no cancela la reserva.
2. Introduce motivo y respaldo. Para proponer un activo o vínculo, revisa cada evidencia del grupo: confirma su pertenencia o exclúyela del futuro piloto y añade su propio motivo y respaldo. El selector permite buscar entre las evidencias; ninguna disposición se marca automáticamente. Dejar pendiente/excluir permite dejar todas las evidencias pendientes; si decides revisarlas, debes revisar el conjunto completo. La evidencia ya utilizada en historia aplicada no admite una nueva autoridad de pertenencia.
3. Pulsa **Revisar decisión**, comprueba el resumen y las revisiones de evidencia, confirma el alcance y pulsa **Guardar decisión**. Pasar al resumen todavía no guarda nada.

Guardar registra una intención administrativa y conserva su comprobante. **No crea ni modifica activos, no aplica inventario, no libera la reserva ni traslada vínculos de evidencia.** La siguiente planificación/aplicación es otro flujo. Cada decisión nueva aumenta la versión global de toda la revisión, incluso si corresponde a otro grupo.

Si cambió esa versión, el origen o la evidencia, usa **Actualizar contexto** y vuelve a revisar y confirmar. Se conservan los textos del borrador, pero las disposiciones de evidencia deben revisarse nuevamente. Si se perdió la respuesta, **Recuperar mismo intento** conserva la misma clave y contenido; no modifica el borrador ni crea otra solicitud. Un comprobante recuperado tras cancelar la reserva no la reactiva.

## Últimas decisiones e historial

Desde **Ver revisión → Consultar decisiones**, **Últimas por grupo** muestra la intención más reciente de cada grupo. **Historial completo** conserva todas las versiones, de la más reciente a la más antigua. Puedes filtrar por grupos con decisiones; el listado solicita páginas de25. Si cambia el contexto entre páginas, actualiza desde el inicio.

**Ver decisión** muestra motivo, respaldo, registrador, revisiones de pertenencia y la proyección completa conservada al decidir. Esa proyección describe ese momento; no es una lectura del inventario actual. **Coincide con la actual** solo compara las proyecciones y no significa que un registro histórico sea la última decisión ni que esté autorizado para aplicarse.

Las decisiones de una reserva cancelada siguen disponibles en modo consulta. Volver al listado conserva página, desplazamiento y foco. Consultar decisiones funciona aunque esté deshabilitada la consulta actual V18; para preparar una decisión nueva sí se necesita V18. Estas herramientas no se habilitan para otros roles.
