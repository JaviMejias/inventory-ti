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

JEFE aplica directamente las correcciones que crea; los otros roles envían solicitudes pendientes. Esta tabla no implica que existan pantallas de reportes, auditoría global o desincorporación: algunas reglas de dominio no tienen todavía un flujo en la interfaz actual.

## Vistas disponibles

| Vista | JEFE | COORDINADOR | SOPORTE |
| --- | --- | --- | --- |
| Inicio | Disponible | Disponible | Visible actualmente; política pendiente de decisión. |
| Catálogo | Consulta y gestión | Consulta | Consulta |
| Inventario | Operaciones según permisos | Operaciones según permisos | Operaciones limitadas |
| Correcciones | Aplicación y revisión | Solicitar/consultar propias | Solicitar/consultar propias |
| Usuarios | Administración | No disponible | No disponible |
| Mi cuenta | Datos personales y contraseña | Datos personales y contraseña | Datos personales y contraseña |

**Inicio para SOPORTE:** la navegación actual lo muestra, pero la matriz de producto niega ese acceso. Se debe decidir cuál es el comportamiento requerido; esta guía no concede un permiso nuevo. Véase [el pendiente de política](../../technical/frontend.md#unresolved-dashboard-access-policy).

Reportes, exportaciones y una vista de auditoría global no están implementados como pantallas disponibles. El historial de productos/activos sí se consulta desde Inventario.

## `JEFE`

Tiene las acciones de mayor autoridad, sujetas a las validaciones del servidor:

- Gestionar usuarios y roles.
- Gestionar productos.
- Ver el inventario y el panel de control.
- Realizar todas las operaciones de inventario.
- Gestionar activos y asignaciones.
- Aplicar directamente sus correcciones y revisar solicitudes pendientes ajenas. No puede aprobar explícitamente una solicitud pendiente propia.
- Consultar los historiales disponibles. No hay pantalla de reportes/exportación ni auditoría global implementada.

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
- Los reportes no están implementados; su acceso a Inicio requiere resolver la discrepancia descrita arriba.

## Reglas transversales

1. **El backend es la autoridad.** Toda verificación de permisos se aplica en el servidor; las restricciones de la interfaz son solo para mejorar la experiencia de uso.
2. **Nadie revisa su propia solicitud pendiente**, incluido `JEFE`. La aplicación directa al crear una corrección como JEFE es un flujo distinto.
3. **Nadie edita cantidades directamente.** Todo cambio de inventario pasa por un `InventoryMovement` válido.
4. Los permisos descritos corresponden al MVP. Los roles son fijos; un mecanismo futuro de permisos granulares podría ampliarlos.
