# Catálogo

Catálogo reúne los **tipos de producto**. Un notebook como modelo se registra aquí; cada notebook físico se registra después como activo en Inventario.

La pantalla actual contiene solo productos. No hay categorías, selector de bodega ni una segunda pestaña de categorías.

## Consultar productos

Todos los roles operativos pueden consultar el catálogo. Busca por nombre o SKU y elige productos activos, inactivos o todos. Inicialmente el filtro muestra activos.

La tabla presenta Producto, Seguimiento, SKU, Estado y Acciones. Los indicadores del encabezado resumen productos y modos de seguimiento; el total de la consulta no es necesariamente la cantidad de filas ya dibujadas.

Se solicitan **25 registros por página**. Al llegar al final se pide la siguiente página; el control de cargar más permite continuar o reintentar. La búsqueda espera 300 ms antes de consultar y no debe mostrar respuestas antiguas sobre una búsqueda nueva. Al limpiar el texto se conserva el filtro de estado.

En escritorio, los valores cortados con puntos muestran el contenido completo al pasar el puntero o darles foco. En móvil las filas se convierten en tarjetas y el texto se ajusta al espacio.

## Crear y editar

Solo JEFE ve los controles de gestión.

1. Pulsa **Nuevo** para abrir el modal Nuevo producto.
2. Ingresa nombre y, si corresponde, SKU.
3. Elige seguimiento por cantidad (QUANTITY) o por activos (ASSET).
4. Define el mínimo de stock cuando corresponda a seguimiento por cantidad.
5. Guarda y espera la confirmación.

Nombre y SKU no vacío son únicos a nivel global, sin distinguir mayúsculas/minúsculas y después de quitar espacios en los extremos. El SKU es opcional. El mínimo es un entero no negativo; en la presentación actual de Inicio, cero excluye al producto de las alertas de mínimo.

**Editar** abre el mismo modal de producto. El modo de seguimiento solo se puede cambiar mientras no exista ningún registro de stock, movimiento o activo para ese producto. **Un registro de stock con cantidad cero también lo bloquea**; no basta con no tener unidades disponibles.

El editor aún ofrece el selector de seguimiento para productos utilizados; el servidor rechaza ese cambio con `PRODUCT_TRACKING_MODE_LOCKED`. Actualmente ese código no tiene un mensaje específico de recuperación en el frontend y puede aparecer el mensaje general de fallo al guardar. La restricción no implica que el resto de datos del producto sea ineditable.

Crear un producto no incorpora unidades ni crea activos físicos. Eso se hace en [Inventario](inventory.md).

## Activar o inactivar

El switch solicita confirmación. El estado solo cambia tras una respuesta correcta del servidor. Inactivar no significa borrar el producto ni eliminar su historial.

Un producto recién creado o modificado puede no coincidir con los filtros de la consulta actual. Si falla el guardado, el modal conserva los datos y publica una notificación en español. Los conflictos/validaciones reconocidos se muestran junto al campo; los fallos generales todavía no tienen una alerta interna general en este editor.
