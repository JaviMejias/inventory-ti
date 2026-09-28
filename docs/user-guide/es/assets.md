# Activos (`Asset`)

Esta página explica cómo se registran y gestionan los equipos individuales del sistema.

## Qué es un `Asset`

Un `Asset` representa un **equipo físico individual** que puede ser identificado y seguido durante su ciclo de vida.

```text
Asset
├── productId  → pertenece a un Product (producto de catálogo)
├── assetTag   → etiqueta de activo (única cuando existe)
├── serialNumber → número de serie (único por producto cuando existe)
└── status     → estado actual
```

Un `Asset` pertenece a un `Product` cuyo modo de control es `ASSET`.

## Estados de un `Asset`

| Estado | Significado | ¿Disponible? |
| --- | --- | --- |
| `AVAILABLE` | En estado utilizable y no asignado. | Sí |
| `ASSIGNED` | Actualmente asignado a una persona. | No |
| `RESERVED` | Reservado para un propósito futuro; no para uso general. | No |
| `UNDER_REVIEW` | Retenido para revisión (ej. investigación de discrepancias). | No |
| `IN_REPAIR` | En reparación; fuera de uso. | No |
| `IN_WARRANTY` | En proceso de garantía; fuera de uso. | No |
| `LOST` | Reportado como perdido. | No |
| `DECOMMISSIONED` | Ya no es inventario activo; no cuenta en inventario. | No |

> **Nota:** El estado `ASSIGNED` y el flujo de asignaciones/devoluciones corresponden a la Fase 6B y están disponibles desde el panel del activo.

## Qué puede hacer cada rol con los activos

| Operación | `JEFE` | `COORDINADOR` | `SOPORTE` |
| --- | :-: | :-: | :-: |
| Ver activos y detalle | ✅ | ✅ | ✅ |
| Crear activos | ✅ | ✅ | ❌ |
| Editar datos del activo (etiqueta/serie) | ✅ | ✅ | ❌ |
| Cambiar estado operativo | ✅ | ✅ | Limitado |
| Desincorporar (`DECOMMISSIONED`) | ✅ | ❌ | ❌ |

### Restricciones para `SOPORTE`

`SOPORTE` puede establecer los estados `AVAILABLE`, `RESERVED`, `UNDER_REVIEW` e `IN_REPAIR`. **No** puede establecer `LOST`, `IN_WARRANTY`, `DECOMMISSIONED` ni `ASSIGNED`.

## Cómo se registra un `Asset`

Solo está disponible para los roles `JEFE` y `COORDINADOR`. Al crear un activo:

1. Se elige un `Product` con modo de control `ASSET` y activo.
2. Se registran la etiqueta (`assetTag`) y el número de serie (`serialNumber`) cuando se conocen.
3. El activo se crea con estado `AVAILABLE`.

Reglas de identificación:

- `assetTag` es **único a nivel global** cuando existe.
- `serialNumber` es **único por producto** cuando existe.
- Los identificadores que solo contienen espacios se guardan como `null`.

## Cómo se cambia el estado operativo

Todos los roles pueden cambiar el estado de un activo según la matriz anterior.

1. Entra a **Inventario → Activos rastreables** y busca el activo.
2. Pulsa **Cambiar estado** en sus acciones.
3. Selecciona el nuevo estado y revisa el cambio mostrado en el modal.
4. Pulsa **Guardar estado**. El cambio se registra con fecha y usuario en **Historial**.

Para enviarlo a reparación, selecciona **En reparación**. Cuando vuelva a estar utilizable, repite el flujo y selecciona **Disponible**.

- Si está **Asignado**, abre **Ver asignación** y registra primero su devolución. La devolución cierra la asignación y lo deja **Disponible**; después puedes enviarlo a reparación.
- No se puede asignar el mismo estado al que ya tiene el activo.
- No se puede cambiar el estado de un activo desincorporado.

## Desincorporación (decommission)

Solo el rol `JEFE` puede desincorporar un activo. Es una acción **terminal**:

- Establece `status = DECOMMISSIONED`, `isActive = false` y registra la fecha.
- El activo desincorporado **no se puede editar ni devolver a un estado operativo**.
- La desincorporación se bloquea si el activo tiene una asignación activa.

## Asignaciones

Desde el panel de un activo `AVAILABLE` se puede asignar una persona activa. En un activo `ASSIGNED` se muestra la persona actual, la acción de devolución y el historial completo. Asignar o devolver no modifica el stock cuantitativo ni crea movimientos de inventario.

## Datos y registro de auditoría

Cada mutación de un activo crea una entrada en el **`AuditLog`** (registro de auditoría) en la misma operación. Las operaciones se registran de forma atómica: no puede quedar una parte hecha y otra pendiente.

## Lo que NO hace la gestión de activos en esta fase

- Los activos **no** crean ni actualizan `InventoryStock` (el stock de cantidad corresponde solo a productos `QUANTITY`).
- Las **asignaciones** (`ASSIGNED`) y su historial se gestionan desde el panel de cada activo.
- No existe un módulo de reparaciones: `IN_REPAIR` e `IN_WARRANTY` son solo estados.
