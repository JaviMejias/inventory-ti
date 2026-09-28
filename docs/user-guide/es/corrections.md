# Correcciones

Las correcciones están disponibles para movimientos de inventario cuantitativo.

## Propósito

Las correcciones existen para **corregir un movimiento de inventario equivocado** sin reescribir la historia. El movimiento original nunca se modifica ni se elimina.

## Estados de una corrección

```text
PENDING    (pendiente)
APPROVED   (aprobada)
REJECTED   (rechazada)
```

## Cómo funciona (previsto)

1. El usuario identifica un `InventoryMovement` (movimiento de inventario) existente.
2. Solicita una **corrección** con una **razón**, referenciando el movimiento original.
3. Indica un **delta compensatorio** entero y distinto de cero. No es la cantidad final reemplazada.
4. Un revisor autorizado la revisa.
5. Una corrección **aprobada** crea un **movimiento compensatorio** `ADJUSTMENT` y actualiza el stock actual.
6. El movimiento original permanece **inmutable**.

Las correcciones rechazadas quedan registradas como rechazadas; no se crea ningún movimiento compensatorio.

## Reglas

- Quien solicita una corrección **no puede aprobar su propia solicitud** (ningún rol, incluido `JEFE`).
- Solo `JEFE` puede aprobar o rechazar. `COORDINADOR` y `SOPORTE` pueden solicitar correcciones y consultar sus propias solicitudes.
- `SOPORTE` **no** puede aprobar en ninguna circunstancia.
- `SOPORTE` solo ve solicitudes creadas por sí mismo.
- Un movimiento solo puede tener una solicitud de corrección.

## Ejemplo

```text
Movimiento #100
Tipo: EXIT
Cantidad: -5
```

Solicitud de corrección:

```text
Corrección #20
Estado: APPROVED
Movimiento original: #100
Razón: Solo se entregaron 4 unidades
```

Movimiento compensatorio:

```text
Movimiento #101
Tipo: ADJUSTMENT
Cantidad: +1
Corrige el movimiento: #100
```

- El movimiento #100 **nunca se sobrescribe**.
- La compensación es totalmente trazable: Corrección → Movimiento original → Movimiento compensatorio.
