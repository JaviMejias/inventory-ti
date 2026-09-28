# Asignaciones

El flujo de asignaciones y devoluciones de la Fase 6B está disponible desde la pantalla de Activos. El estado `ASSIGNED` se controla mediante este flujo y no desde el cambio general de estado.

## Qué es una asignación

Una **`Assignment`** es la relación entre un activo y una persona:

```text
Asset ↔ Persona
```

- Asignar un activo cambia su estado a `ASSIGNED`; **no** saca el activo del inventario físico.
- Devolver un activo cierra la asignación activa y libera el activo (normalmente vuelve a `AVAILABLE`, o según las reglas de negocio).
- Las asignaciones **no son** movimientos de inventario (`InventoryMovement`); son un concepto distinto.

## Asignar un activo

1. Se selecciona un activo habilitado (no inactivo) con estado `AVAILABLE`.
2. Se escribe el nombre y apellido de la persona que recibe el equipo. No es necesario crearle una cuenta.
3. La asignación se registra y el estado del activo pasa a `ASSIGNED`.
4. El conteo físico del inventario **no cambia**.

## Devolver un activo

1. Se selecciona un activo asignado.
2. Se registra la devolución.
3. La asignación activa se cierra con fecha y usuario de devolución, y el activo queda `AVAILABLE`.

## Historial de asignaciones

El sistema mantiene el historial completo de asignaciones y puede responder:

- quién tiene el activo actualmente;
- quién lo tuvo antes;
- cuándo se asignó;
- cuándo se devolvió.

El historial **no** se reemplaza por un único campo del tipo `asset.assignedTo`.

## Qué puede hacer cada rol

| Rol | Capacidad de asignación |
| --- | --- |
| `JEFE` | Administra asignaciones sin restricción. |
| `COORDINADOR` | Puede ver, asignar y devolver activos. |
| `SOPORTE` | Puede ver, asignar y devolver activos. |

## Reglas y situación actual

- El modelo de base de datos `Assignment` conserva el nombre de la persona (`personName`), junto con `startedAt`, `endedAt` y `endedById`. Las asignaciones antiguas pueden conservar además su referencia histórica a `personId`.
- Un activo admite como máximo una asignación activa y el nombre del destinatario es obligatorio.
- Asignar/devolver no cambia `InventoryStock` ni crea `InventoryMovement`.
- El historial se conserva; las asignaciones no se eliminan ni se editan como historial.
