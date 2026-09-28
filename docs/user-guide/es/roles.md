# Roles y responsabilidades

Esta página explica los tres roles del sistema y qué puede hacer cada uno.

## Los tres roles

| Rol | Propósito |
| --- | --- |
| `JEFE` | Máxima autoridad administrativa sobre el sistema. |
| `COORDINADOR` | Gestión operativa: opera el inventario y solicita correcciones. |
| `SOPORTE` | Soporte operativo: ejecuta las acciones operativas del día a día. |

## Matriz de permisos

| Capacidad | `JEFE` | `COORDINADOR` | `SOPORTE` |
| --- | :-: | :-: | :-: |
| Gestionar usuarios | ✅ | ❌ | ❌ |
| Gestionar productos | ✅ | ❌ | ❌ |
| Ver inventario | ✅ | ✅ | ✅ |
| Operaciones de inventario (ENTRY/EXIT/RETURN) | ✅ | ✅ | ✅ |
| Stock inicial (`INITIAL`) | ✅ | ❌ | ❌ |
| Ajustes (`ADJUSTMENT`) | ✅ | ✅ | ❌ |
| Crear y editar activos | ✅ | ✅ | ❌ |
| Cambiar estado operativo de activos | ✅ | ✅ | Limitado |
| Desincorporar activos | ✅ | ❌ | ❌ |
| Solicitar correcciones | ✅ | ✅ | ✅ |
| Aprobar o rechazar correcciones | ✅ | ❌ | ❌ |
| Acceder a reportes | ✅ | ✅ | ❌ |
| Ver auditoría | ✅ | ❌ | ❌ |

## `JEFE`

Puede, sin restricción:

- Gestionar usuarios y roles.
- Gestionar productos.
- Ver el inventario y el panel de control.
- Realizar todas las operaciones de inventario.
- Gestionar activos y asignaciones.
- Solicitar y aprobar correcciones (sin poder aprobar las propias).
- Acceder a reportes y auditoría.

## `COORDINADOR`

- Realiza la administración operativa normal.
- Puede ver inventario, ejecutar movimientos operativos y ajustes autorizados.
- Puede crear y editar activos y cambiar sus estados.
- Puede solicitar correcciones y consultar sus propias solicitudes.
- **No** puede realizar administración de usuarios o roles ni gestionar productos (eso es exclusivo de `JEFE` en el MVP).

## `SOPORTE`

- Puede ver el inventario relevante.
- Puede ejecutar operaciones de inventario del día a día: recepción (`ENTRY`), entrega (`EXIT`) y devolución (`RETURN`).
- Puede cambiar el estado operativo de los activos dentro de un conjunto limitado: `AVAILABLE`, `RESERVED`, `UNDER_REVIEW`, `IN_REPAIR`. **No** puede establecer `LOST`, `IN_WARRANTY`, `DECOMMISSIONED` ni `ASSIGNED`.
- **No** puede editar cantidades de stock directamente ni realizar ajustes (`ADJUSTMENT`).
- **No** puede aprobar correcciones (ni las propias).
- **No** tiene acceso a reportes ni al panel de control en el MVP.

## Reglas transversales

1. **El backend es la autoridad.** Toda verificación de permisos se aplica en el servidor; las restricciones de la interfaz son solo para mejorar la experiencia de uso.
2. **Nadie aprueba sus propias correcciones**, incluido `JEFE`.
3. **Nadie edita cantidades directamente.** Todo cambio de inventario pasa por un `InventoryMovement` válido.
4. Los permisos descritos corresponden al MVP. Los roles son fijos; un mecanismo futuro de permisos granulares podría ampliarlos.
