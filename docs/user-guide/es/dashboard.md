# Inicio — Dashboard

Inicio es una vista de consulta: reúne información existente para decidir qué revisar. No crea productos ni modifica stock. No tiene un módulo de negocio o endpoint propio.

El acceso de SOPORTE está pendiente de definición: hoy la navegación lo muestra, pero la matriz de permisos lo excluye. Esta guía describe la vista sin modificar esa política; véase [la discrepancia documentada](../../technical/frontend.md#unresolved-dashboard-access-policy).

## Periodo de análisis

El rango inicial es **Mes actual**, desde el primer día del mes hasta hoy según el calendario de Chile. Puedes elegir Mes actual, Últimos 30 días, Mes anterior o Personalizado, y modificar Desde/Hasta.

Los selectores de mes/año cambian el calendario abierto; no seleccionan por sí solos el día ni deben cerrar todo el datepicker. El periodo debe tener inicio anterior o igual al término.

**Las fechas afectan los movimientos y sus gráficos, no el estado actual del inventario.** No reconstruyen el stock ni los estados de activos a una fecha pasada. Al recargar aparecen animaciones de cálculo, pero eso no convierte los KPI en indicadores históricos.

## Indicadores

| Indicador visible | Qué cuenta | ¿Lo afectan las fechas? |
| --- | --- | :-: |
| Productos activos | Registros activos del catálogo, de ambos modos de seguimiento. | No |
| Stock disponible | Suma de unidades del stock por cantidad. No son activos disponibles. | No |
| Equipos rastreables | Activos individuales activos, también asignados o en reparación. No son modelos de producto. | No |
| Alertas de stock | Productos activos por cantidad con mínimo mayor que cero y stock menor o igual a ese mínimo. | No |

## Gráficos de movimientos

**Flujo de inventario** muestra entradas y salidas por periodo. Hasta 31 días agrupa por día; de 32 a 217 días por semana; para rangos mayores por mes. Al pasar el puntero, el tooltip muestra el periodo y los volúmenes de cada serie.

**Movimientos registrados** compara entradas, salidas y ajustes. Aunque su título habla de movimientos, las barras miden **unidades**, no cantidad de registros. Un ingreso de 20 unidades aporta 20, no 1.

INITIAL, ENTRY y RETURN se suman como entradas. EXIT se suma como salida. Los ajustes se contabilizan en valor absoluto: la barra de ajustes mide volumen ajustado, no saldo neto. El gráfico de flujo dibuja entradas/salidas; los ajustes aparecen en el resumen de barras.

Los gráficos usan el registro inmutable de movimientos, **no el historial recalculado de cantidades corregidas**. Si se registró una salida de 5 y después se corrigió a 4, la salida auditada sigue aportando 5; el movimiento compensatorio de +1 aporta a ajustes en su propia fecha. No se debe esperar que la barra de salidas cambie retroactivamente a 4. El stock actual sí refleja la corrección aprobada.

Estos gráficos no tienen una acción de edición ni abren automáticamente el historial de cada movimiento.

## Distribución por estado de activos

La dona y el listado lateral representan los **activos individuales actualmente activos**, separados por estado. El total incluye estados no disponibles; no equivale al stock por cantidad ni al número de productos del catálogo.

Al pulsar un segmento o estado se abre un modal con los activos coincidentes: producto, etiqueta y número de serie cuando existen. **Ver producto** lleva al Catálogo con el nombre buscado. No abre el editor del activo ni lo asigna.

El modal muestra todos los activos del estado cargados en esta consulta, sin paginación de servidor.

## Atención requerida

La vista inicial muestra hasta cinco productos y el contador de todas las alertas. Cada registro presenta nombre, disponible, mínimo, cobertura y una barra visual que pasa hacia rojo al disminuir la cobertura.

La cobertura es disponible dividido por mínimo, expresado en porcentaje y limitado al 100%. Un producto justo en su mínimo también requiere atención. No hay alerta de mínimo para productos con umbral cero; la tabla de Inventario puede igualmente señalar que no tienen stock.

**Ver todas** abre el listado completo cuando existen más de cinco alertas. **Revisar**, tanto en el panel como en el modal, lleva a Inventario, busca el producto y lo destaca. El listado conserva el orden recibido de productos; no se garantiza un orden de urgencia.

## Correcciones pendientes

Muestra hasta cuatro solicitudes, producto, solicitante y contexto de la corrección. El contador comprende todas las páginas pendientes recibidas, no solo esas cuatro filas. Su alcance depende del rol y de lo que permita consultar la API.

**Ver bandeja** abre un modal; muestra 25 solicitudes inicialmente y permite revelar otras 25. **Revisar** para JEFE o **Ver solicitud** para los demás lleva a Correcciones, busca el producto y abre el detalle de esa solicitud. Al cerrar el detalle, la búsqueda y la fila referenciada permanecen accesibles en la tabla.

La aprobación/rechazo se realiza en Correcciones, no directamente en Inicio.

## Carga y errores

Durante las consultas aparecen indicadores de carga. Si falla una consulta se muestra un error con reintento; no debe interpretarse como cero stock o ausencia de alertas confirmada.

No hay actualización por WebSocket: los datos corresponden a la consulta realizada. Para registrar cambios usa [Inventario](inventory.md) o [Correcciones](corrections.md).
