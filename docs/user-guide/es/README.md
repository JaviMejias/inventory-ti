# Guía de Usuario — Inventory TI (Español)

Esta guía explica cómo usar el sistema de inventario de TI de la oficina de soporte de **Chilexpress**, desde el punto de vista de una persona que lo usa operativamente.

> **Estado:** Actualmente el sistema implementa **autenticación**, **catálogo de productos**, **inventario cuantitativo** (stock y movimientos), **gestión de activos** (Fase 6A) y **asignaciones** (Fase 6B). Las **correcciones**, los **reportes** y el **panel de control** están planificados pero todavía **no están disponibles**.

La documentación canónica del proyecto está en **inglés** en `docs/`. Esta guía es una explicación operativa en español; los identificadores técnicos (nombres de modelos, estados, roles) se conservan en inglés porque corresponden a los valores reales del sistema.

## Contenido

- [Roles y responsabilidades](roles.md) — qué puede hacer cada rol.
- [Inventario](inventory.md) — cómo funciona el inventario: productos por cantidad y activos.
- [Activos](assets.md) — cómo se registran y gestionan los equipos individuales (`Asset`).
- [Asignaciones](assignments.md) — cómo se asignan y devuelven los equipos.
- [Correcciones](corrections.md) — cómo se corrigen errores de inventario.

## Resumen rápido

| Concepto | Qué es |
| --- | --- |
| `Product` | Un ítem del catálogo o tipo (ej. Notebook, Mouse, Teclado). |
| Producto de consumo | Un producto que se controla **por cantidad** (ej. Teclado, stock 25). |
| `Asset` | Un equipo físico individual con seguimiento propio (ej. un notebook con serie ABC123). |
| `InventoryStock` | El stock actual consolidado de un producto. |
| `InventoryMovement` | El registro inmutable de una operación que cambia el inventario. |
| `JEFE` | Rol con máxima autoridad (administración completa). |
| `COORDINADOR` | Rol operativo de gestión (opera y solicita correcciones). |
| `SOPORTE` | Rol operativo de ejecución de tareas diarias. |
