# Inventario

Esta página explica cómo funciona el inventario del sistema.

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
- Un producto está en stock bajo cuando `stock actual <= umbral`.
- La visibilidad de stock bajo en el panel de control está planificada (aún no disponible).

## Qué puede hacer cada rol en inventario

| Operación | `JEFE` | `COORDINADOR` | `SOPORTE` |
| --- | :-: | :-: | :-: |
| Ver stock y movimientos | ✅ | ✅ | ✅ |
| `INITIAL` (stock inicial) | ✅ | ❌ | ❌ |
| `ENTRY` / `EXIT` / `RETURN` | ✅ | ✅ | ✅ |
| `ADJUSTMENT` | ✅ | ✅ | ❌ |

Todo lo que no está marcado con ✅ no está permitido. El sistema aplica estas restricciones en el backend; la interfaz solo las refleja.
