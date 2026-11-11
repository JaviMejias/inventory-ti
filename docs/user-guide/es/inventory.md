# Inventario

Inventario tiene dos pestañas: **Stock por cantidad** y **Activos rastreables**. No hay una pestaña de ubicaciones ni de trazabilidad global: el historial se abre desde cada producto o activo.

## Consultar y navegar

En Stock por cantidad busca por nombre o SKU. La tabla muestra Producto, SKU, Disponible, Mínimo, Estado e Historial. Sin unidades, el estado es rojo; con mínimo positivo y cantidad menor o igual a él, amarillo; por encima, verde. El mínimo configurado se distingue como advertencia, no como cantidad disponible.

En Activos rastreables busca producto, etiqueta o serie y filtra por estado mediante el select compartido. Cada fila permite consultar Historial y, según rol/estado, Editar, Cambiar estado, Asignar o Ver asignación.

La vista carga todas las páginas de productos requeridas y el conjunto de stock/activos. Después revela **25 registros a la vez** por pestaña al hacer scroll o cargar más; esto es presentación incremental local, no paginación remota de activos. Cambiar búsqueda/filtro reinicia el bloque visible, no cambia stock.

En móvil las filas son tarjetas con identidad, valores, estado y acciones. Abrir/cerrar un modal de historial conserva la posición y registros cargados de la tabla.

## Registrar un movimiento de cantidad

1. En Stock por cantidad pulsa **Registrar movimiento**.
2. Selecciona tipo y producto.
3. Ingresa cantidad y motivo cuando corresponda.
4. Pulsa **Guardar movimiento** y espera confirmación.

Para entregar cables utiliza EXIT con cantidad positiva y registra el destinatario/contexto en el motivo. Para recibirlos de vuelta utiliza RETURN. No existe un registro estructurado de préstamos por cantidad como la asignación de un activo.

INITIAL, ENTRY, EXIT y RETURN usan magnitud positiva: una salida de 5 se registra con cantidad 5 y tipo EXIT, no introduciendo -5. El formulario de ADJUSTMENT usa una cantidad firmada, distinta de cero, para sumar o restar y **requiere motivo** según la validación del servidor; no debe confundirse con Correcciones, que pide la cantidad final de un movimiento anterior. Las cantidades deben caber en el rango entero admitido por la API y el stock actual no puede quedar negativo.

El campo Motivo de este modal todavía no cambia su etiqueta a obligatorio al elegir ADJUSTMENT; la falta de motivo será rechazada por el servidor. No es un permiso para enviar ajustes sin explicación.

Si se produjo un error en un movimiento existente, utiliza [Correcciones](corrections.md). Para equipos individuales utiliza [Activos](assets.md) y [Asignaciones](assignments.md), no una salida de unidades de ese modelo.

## Historial

El botón de cada registro abre el modal compartido con una línea de tiempo de eventos, iconos y estados. En cantidad se presentan ingreso/salida/ajuste, fecha, usuario, motivo y balances antes/después; en activos se presentan sus eventos de ciclo de vida, incluidos cambios de estado registrados por el servidor.

El historial de cantidad usa la cantidad corregida vigente y separa los movimientos compensatorios en otro apartado para no duplicar el efecto. Señala saldos históricos negativos o diferencias entre saldo del historial y stock actual. No crea ni elimina eventos desde la interfaz.

Se carga la respuesta de historial recibida y se revelan **12 eventos a la vez** con scroll/control de carga; las compensaciones tienen su propio bloque de 12. En cantidad, la API ordena cronológicamente los movimientos originales (del más antiguo al más reciente) con los balances corregidos, usando fecha efectiva, fecha de creación e ID para desempatar. En activos, los eventos vienen del más reciente al más antiguo.

El historial de activos combina movimientos, asignaciones y auditorías, con un límite de **200 registros de cada fuente** en la lectura del servidor. Una asignación puede generar un evento de entrega y otro de devolución; por eso el límite no significa 200 eventos totales. Revelar más tarjetas no solicita fuentes más antiguas: no se garantiza una historia ilimitada. La carga fallida tiene reintento y no se confunde con un historial vacío.

## Cómo se modela el inventario

El sistema distingue dos formas de controlar el inventario, definidas a nivel de `Product` (producto del catálogo):

- **Un producto de consumo** (`QUANTITY`) se controla **por cantidad**. Ejemplo: *Teclado — stock actual 25*.
- **Un producto de activos** (`ASSET`) se controla a través de sus **`Asset`** individuales. Ejemplo: *Notebook Dell — serie ABC123*.

Un mismo producto usa un solo modo de control, de forma consistente.

## Stock materializado

El **stock actual** (`InventoryStock`) es el estado presente del inventario:

- para productos de consumo: una cantidad consolidada por producto;
- para productos de activos: el conjunto de `Asset` y sus estados.

El stock cambia **solo** a través de operaciones válidas y autorizadas. No existe edición directa de cantidades.

## Inventario físico vs. disponibilidad

Es importante distinguir:

- **Inventario físico** es todo lo que existe físicamente y está registrado en el sistema.
- **Disponibilidad** es lo que se puede asignar o usar en este momento.

Ejemplo con 10 notebooks:

```text
AVAILABLE    7
ASSIGNED     1
IN_REPAIR    1
LOST         1
----------------
FÍSICO      10
DISPONIBLE   7
```

- El inventario físico sigue siendo **10**.
- La disponibilidad es **7**.
- Asignar un activo **no** hace desaparecer el equipo del inventario físico; solo cambia su estado a `ASSIGNED`.

## Movimientos de inventario

Cada operación que cambia el inventario crea un **`InventoryMovement`** (histórico inmutable) y actualiza el stock actual en la misma operación atómica.

### Tipos de movimiento

| Tipo | Significado |
| --- | --- |
| `INITIAL` | Stock inicial al registrar por primera vez un producto. Solo uno por producto. Solo `JEFE`. |
| `ENTRY` | Recepción / ingreso de stock. |
| `EXIT` | Salida / entrega de stock. |
| `RETURN` | Devolución (se recibe de vuelta stock). |
| `ADJUSTMENT` | Ajuste del stock con una razón (delta firmado). Solo `JEFE` y `COORDINADOR`. |

Un movimiento registra, según corresponda: producto, activo, cantidad, tipo, usuario, fecha y motivo.

### Reglas

- Los movimientos **nunca se editan ni se eliminan** después de creados.
- Un `INITIAL` solo se permite una vez por producto.
- `ENTRY`, `EXIT` y `RETURN` usan cantidades positivas; `ADJUSTMENT` usa un delta distinto de cero y exige una razón.
- El stock nunca puede quedar negativo.

## Stock bajo (low stock)

- Cada producto tiene un **umbral de stock bajo** configurado a nivel de producto (campo `lowStockThreshold`).
- Para alertas de mínimo, un producto por cantidad está en stock bajo cuando tiene umbral positivo y `stock actual <= umbral`.
- [Inicio](dashboard.md) ya muestra estas alertas, sus cantidades y enlaces para buscar el producto en Inventario. Las fechas del Dashboard no alteran este stock actual.

## Qué puede hacer cada rol en inventario

| Operación | `JEFE` | `COORDINADOR` | `SOPORTE` |
| --- | :-: | :-: | :-: |
| Ver stock y movimientos | ✅ | ✅ | ✅ |
| `INITIAL` (stock inicial) | ✅ | ❌ | ❌ |
| `ENTRY` / `EXIT` / `RETURN` | ✅ | ✅ | ✅ |
| `ADJUSTMENT` | ✅ | ✅ | ❌ |

Todo lo que no está marcado con ✅ no está permitido. El sistema aplica estas restricciones en el backend; la interfaz solo las refleja.
