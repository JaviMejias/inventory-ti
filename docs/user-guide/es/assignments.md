# Asignaciones

El flujo está integrado en **Inventario → Activos rastreables**. El estado `ASSIGNED` se controla mediante asignación/devolución, no desde el select general de estado.

## Qué es una asignación

Una **`Assignment`** es la relación entre un activo y una persona:

```text
Asset ↔ Persona
```

- Asignar un activo cambia su estado a `ASSIGNED`; **no** saca el activo del inventario físico.
- Devolver un activo cierra la asignación activa y lo deja `AVAILABLE` en el flujo actual.
- Las asignaciones **no son** movimientos de inventario (`InventoryMovement`); son un concepto distinto.

## Asignar un activo

1. Busca un activo habilitado con estado **Disponible** y pulsa **Asignar**.
2. En el modal escribe el nombre y apellido obligatorios de quien recibe el equipo; por ejemplo, Juan Pérez. El nombre completo admite hasta 150 caracteres y debe contener al menos dos partes. No necesitas crearle una cuenta.
3. Pulsa **Asignar activo**. Solo tras la confirmación se registra la entrega y el activo pasa a `ASSIGNED`.
4. El conteo físico del inventario **no cambia**.

## Devolver un activo

1. Busca el activo asignado y pulsa **Ver asignación**.
2. Consulta destinatario y fecha; pulsa **Registrar devolución**.
3. Revisa la advertencia y pulsa **Confirmar devolución**.
4. Tras la respuesta correcta se cierra la asignación con fecha/usuario y el activo queda **Disponible**.

Si vuelve dañado, registra la devolución y después usa **Cambiar estado → En reparación**. La devolución por sí sola no marca reparación.

## Historial de asignaciones

El sistema conserva el historial de asignaciones. El modal actual solicita hasta **50 registros**, sin control para pedir la siguiente página; no garantiza mostrar todas las entregas si supera ese límite. El historial consultado permite ver:

- quién tiene el activo actualmente;
- quién lo tuvo antes;
- cuándo se asignó;
- cuándo se devolvió.

El historial **no** se reemplaza por un único campo del tipo `asset.assignedTo`.

El modal usa iconos, fechas y un recorrido de entregas. Una consulta fallida ofrece reintento y no se interpreta como ausencia de asignación. Los fallos al asignar/devolver mantienen el contexto con error y toast en español; ante una conexión interrumpida comprueba el estado antes de repetir.

## Qué puede hacer cada rol

| Rol | Capacidad de asignación |
| --- | --- |
| `JEFE` | Administra asignaciones sin restricción. |
| `COORDINADOR` | Puede ver, asignar y devolver activos. |
| `SOPORTE` | Puede ver, asignar y devolver activos. |

## Reglas y situación actual

- El modelo de base de datos `Assignment` conserva el nombre de la persona (`personName`), junto con `startedAt`, `endedAt` y `endedById`. Las asignaciones antiguas pueden conservar además su referencia histórica a `personId`.
- Un activo admite como máximo una asignación activa y el nombre del destinatario es obligatorio.
- La solicitud del frontend contiene `personName`, no `personId`. La compatibilidad histórica con una cuenta registrada no obliga a crear usuarios para destinatarios externos al equipo.
- Asignar/devolver no cambia `InventoryStock` ni crea `InventoryMovement`.
- El historial se conserva; las asignaciones no se eliminan ni se editan como historial.
