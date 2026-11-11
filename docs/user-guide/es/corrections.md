# Correcciones

Esta vista corrige errores de **movimientos de inventario por cantidad**, sin editar ni borrar el registro original. No sirve para cambiar el estado o destinatario de un activo.

## Consultar solicitudes

La tabla muestra producto, tipo de movimiento, cantidad vigente al solicitar (**Antes**), cantidad final propuesta/aplicada, diferencia de stock, solicitante, estado y fecha.

El estado puede ser **Pendiente**, **Aprobada** o **Rechazada**. Una diferencia positiva aparece verde y una negativa roja; esa diferencia no debe confundirse con el signo de la cantidad final del movimiento.

Busca por producto, SKU o solicitante; la consulta también puede localizar texto del motivo. Pulsa **Filtros** para desplegar estado, tipo de movimiento, Desde y Hasta. Se pueden cerrar sin perder las selecciones. **Limpiar filtros** restablece la búsqueda y todos esos campos.

Las fechas filtran la **fecha efectiva del movimiento original**, no la fecha en que alguien solicitó su corrección. La columna Fecha corresponde a la creación de la solicitud.

Se consultan **25 registros por página**. Al hacer scroll cerca del final se obtiene otra página, no todo el historial de una vez. A diferencia de Catálogo y Usuarios, esta vista todavía no muestra un botón explícito para cargar la siguiente página. Si la primera página cabe completa sin scroll, ese control de acceso a más registros está pendiente de mejora. Los contadores del encabezado reflejan el conjunto cargado/filtrado; no son necesariamente el total global de la base.

## Nueva corrección

1. Pulsa **Nueva corrección**.
2. En **Selecciona el producto**, elige el producto y movimiento correcto. Las opciones indican tipo y fecha; la búsqueda del select filtra las opciones ya disponibles.
3. En **Define la cantidad final**, indica cuántas unidades debe representar ese movimiento.
4. Revisa **Antes**, **Cantidad final** y **Diferencia de stock**.
5. Explica el **motivo** y envía.

El campo es la **cantidad final del movimiento**, no un delta adicional y tampoco el stock total deseado del producto. Antes y Cantidad final representan el **efecto firmado** sobre stock: un EXIT registrado con magnitud positiva 5 tiene efecto -5. No hay contradicción entre esa magnitud del registro normal y el signo negativo de su corrección.

En una salida se introduce la magnitud y el sistema la interpreta como descuento. Entradas, devoluciones y stock inicial mantienen dirección de ingreso. Solo para ADJUSTMENT hay un switch de suma/resta. Puedes usar cero para anular el efecto del movimiento; enviar la misma cantidad vigente no representa una corrección válida.

### Ejemplo

Una salida vigente de 5 cables debió ser de 4:

| Concepto | Valor |
| --- | --- |
| Antes | -5 |
| Cantidad introducida | 4 |
| Cantidad final interpretada | -4 |
| Diferencia sobre el stock | +1 |

No debes introducir +1 como cantidad final ni el stock consolidado que quieres obtener.

## Según el rol

- **JEFE:** el botón dice **Aplicar corrección**. La API la aplica directamente y la deja aprobada, si la operación es válida.
- **COORDINADOR y SOPORTE:** el botón dice **Solicitar corrección**. Queda pendiente y no altera stock hasta que JEFE la aprueba.
- Solo JEFE puede aprobar o rechazar solicitudes pendientes. La revisión explícita de una solicitud pendiente propia no está permitida. Esto es distinto de la aplicación directa autorizada al crearla como JEFE.
- COORDINADOR y SOPORTE consultan únicamente sus propias solicitudes, tanto en la lista como por enlace directo a un detalle; JEFE consulta la bandeja completa. Un enlace no amplía los permisos del destinatario.

Un movimiento admite **una solicitud pendiente a la vez**. Cuando la anterior ya fue procesada puede ser elegible nuevamente. Los movimientos compensatorios no se eligen para crear una nueva corrección. La lista de elegibles se actualiza al abrir el editor y sigue la información entregada por la API.

## Detalle y revisión

**Revisar** para JEFE o **Ver** abre el modal compartido. Presenta producto, solicitante con identidad visual, motivo, estado y una secuencia de cantidad anterior, diferencia y cantidad final. No es una edición del movimiento.

En una solicitud pendiente revisable, JEFE elige aprobar o rechazar y confirma la acción. Aprobar aplica la diferencia validada por el servidor; rechazar conserva la solicitud sin aplicar stock.

Para correcciones repetidas, Antes representa la cantidad vigente al pedir esa corrección, no necesariamente la cantidad original histórica. La compensación queda registrada, sin sobrescribir el movimiento original.

Desde Inicio, el enlace a una solicitud busca el producto en la tabla y abre su detalle. Si cierras accidentalmente el modal, la búsqueda y la fila siguen disponibles para volver a abrirlo.

## Errores e historial

Si fallan las opciones del formulario, aparece un error con reintento; no se presenta como que no existen movimientos. Si falla el envío/revisión, se conserva el modal y los valores con un toast en español. Los errores de campos se muestran junto al campo; el editor de creación todavía no conserva una alerta general interna para todos los fallos. En revisión sí se mantiene el error en la confirmación.

Si falla una página posterior, las filas cargadas permanecen y se detiene la carga automática. El botón de reintento de esta vista vuelve a consultar desde la primera página.

El historial de [Inventario](inventory.md) muestra los saldos corregidos y las compensaciones por separado para no contarlas dos veces. Una conexión interrumpida puede dejar el resultado sin confirmar: actualiza antes de repetir la solicitud.
