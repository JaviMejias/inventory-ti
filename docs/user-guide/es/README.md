# Guía de Usuario — Inventory TI (Español)

Esta guía explica el uso de la app de inventario TI para un equipo pequeño de Chilexpress, con un único contexto de stock.

**Disponible:** acceso y activación, Inicio/Dashboard, catálogo de productos, inventario por cantidad y activos, asignaciones/devoluciones, cambios de estado, correcciones, Usuarios para JEFE y Mi cuenta.

**No disponible todavía:** reportes/exportaciones, archivos adjuntos, actualización en tiempo real por WebSocket y trabajo offline/PWA. No hay categorías ni una vista de ubicaciones.

La documentación técnica canónica está en inglés. Esta guía operativa está en español; los identificadores técnicos se conservan cuando ayudan a reconocer el registro real.

## Contenido

- [Acceso y activación](authentication.md) — iniciar sesión, configurar contraseña y elegir tema.
- [Inicio — Dashboard](dashboard.md) — filtros, indicadores, gráficos y navegación desde los modales.
- [Catálogo](catalog.md) — productos, seguimiento, mínimo y gestión por JEFE.
- [Inventario](inventory.md) — stock actual, movimientos y las dos pestañas.
- [Activos](assets.md) — crear, editar y cambiar estados.
- [Asignaciones](assignments.md) — entregar un activo y registrar su devolución.
- [Correcciones](corrections.md) — cantidad final, solicitud, aplicación y revisión.
- [Usuarios](users.md) — creación, roles, activación y restablecimiento de acceso.
- [Mi cuenta](account.md) — edición personal y contraseña.
- [Roles y responsabilidades](roles.md) — acciones permitidas y la decisión pendiente de acceso de SOPORTE a Inicio.

## Comportamiento compartido

El tema inicial sigue al sistema. Claro/Oscuro/Sistema se conserva en el navegador y también se aplica al acceso. El amarillo es el color de marca; estados y advertencias tienen colores semánticos distintos.

Por debajo de 1024 píxeles de ancho del navegador, la navegación queda abajo con iconos y las tablas pasan a tarjetas. En escritorio, los textos recortados se pueden consultar completos al pasar el puntero o darles foco.

Las listas no cargan ni muestran todo de la misma manera. Catálogo, Usuarios y Correcciones consultan páginas de 25; Correcciones depende actualmente del scroll y no tiene el botón de siguiente bloque que sí ofrecen otras listas. Inventario carga el conjunto y revela bloques de 25. Los historiales de inventario revelan 12 eventos de una respuesta ya cargada. Consulta cada guía para conocer su alcance.

Abrir/cerrar un historial no debe reiniciar el scroll ni los registros cargados de la tabla. Los formularios bloquean envíos repetidos y solo confirman resultados informados por el servidor.

Un error de operación dentro de un modal debe seguir visible allí y mediante un toast en español; no queda escondido detrás. En cargas de tabla puede aparecer una acción de reintento. Un fallo de conexión no prueba que el servidor no haya aplicado la operación: comprueba el estado antes de repetir movimientos de stock.

## Conceptos

| Concepto | Significado |
| --- | --- |
| Product | Tipo de producto del catálogo, por ejemplo Notebook o Cable HDMI. |
| QUANTITY | Seguimiento por unidades consolidadas. |
| Asset / ASSET | Unidad física individual con estado, etiqueta y/o serie. |
| InventoryStock | Stock actual por cantidad. |
| InventoryMovement | Registro de una operación de inventario; no se sobrescribe desde la interfaz. |
| Assignment | Entrega de un activo a una persona identificada por nombre. No requiere crearle una cuenta. |
| CorrectionRequest | Corrección de la cantidad de un movimiento, con motivo y estado. |

Esta guía describe la interfaz actual; la autorización definitiva corresponde al servidor. No confundir un control visible con un permiso de negocio confirmado.

## Revisión cruzada con el backend

La [revisión de contratos API](../../technical/frontend.md#8-api-contract-reconciliation) distingue llamadas compatibles, límites de lectura y pendientes reales de la interfaz. Incluye activación directa, errores dentro de modales, bloqueo del seguimiento de productos y campos de contacto al editar usuarios.

Se mantiene explícita la discrepancia de acceso de SOPORTE a Inicio. También hay párrafos antiguos de Assets/Security que exigen un usuario registrado para entregar un activo; el flujo actual usa nombre y apellido en texto libre, compatible con la API. No se cambiaron permisos ni documentos backend para ocultar estas diferencias.
