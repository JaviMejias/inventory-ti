# Solicitudes y errores de Inventory TI

Revisión del frontend: 28 de septiembre de 2026.

## Hallazgos

Los avisos enviados a `document.body` quedaban detrás de los modales nativos: estos usan la capa superior del navegador y no se resuelve aumentando el `z-index`. Varios formularios además reutilizaban el error de la página, por lo que el mensaje aparecía detrás del modal. Había tres clientes HTTP locales que omitían los códigos de error y exponían mensajes del backend en inglés. El historial de inventario ocultaba fallos mostrando una lista vacía.

## Criterio aplicado

| Contexto | Cómo se informa | Recuperación |
| --- | --- | --- |
| Carga de una vista o tabla | Aviso persistente en la vista, en español; no se confunde con una tabla vacía | Reintentar o volver a ejecutar la búsqueda |
| Carga incremental | Aviso de página; los registros ya obtenidos siguen visibles | Se pausa el scroll automático; Cargar más o Reintentar permiten recuperarse según la vista |
| Solicitud dentro de un modal | Aviso dentro del modal y toast de error por encima | Conservar los campos, liberar el botón y corregir o reintentar |
| Validación local | Mensaje dentro del formulario | Corregir los datos sin enviar otra solicitud |
| Carga de historial en un modal | Aviso interno y toast; nunca “sin registros” | Botón Reintentar |
| Sin conexión o respuesta ilegible | Mensaje de resultado no confirmado | Actualizar la información antes de repetir una operación |
| Sesión caducada | Mensaje en español y flujo de autenticación existente | Iniciar sesión nuevamente |

## Cobertura de las vistas activas

| Vista | Solicitudes revisadas | Presentación del fallo |
| --- | --- | --- |
| Inicio | Productos, stock, activos, movimientos y correcciones pendientes | Aviso con Reintentar; un fallo no se presenta como KPI en cero ni como gráfico vacío |
| Catálogo | Listado/búsqueda/carga incremental de productos | Aviso de página/tabla |
| Catálogo | Crear, editar, activar e inactivar producto | Aviso dentro del editor o confirmación y toast |
| Inventario | Productos, stock consolidado y activos | Aviso de carga en la vista |
| Inventario | Registrar movimiento; crear o editar activo | Aviso del formulario y toast; no se borra lo ingresado |
| Inventario | Consultar asignación, asignar y devolver activo | Aviso del modal y toast, con Reintentar al cargar; un fallo de carga no habilita una asignación nueva |
| Inventario | Historial de producto o activo | Aviso del modal, toast y Reintentar; se ignoran respuestas de un modal ya cerrado |
| Correcciones | Listado, filtros y carga incremental | Aviso de página/tabla |
| Correcciones | Abrir una corrección desde Inicio | Aviso de página y toast si falla |
| Correcciones | Cargar movimientos para la solicitud, solicitar, aprobar o rechazar | Aviso en el modal que realizó la solicitud y toast |
| Usuarios | Listado, búsqueda y carga incremental | Aviso de página/tabla, sin confundir un fallo con una lista vacía |
| Usuarios | Crear, editar, activar, desactivar y restablecer acceso | Aviso del editor o confirmación y toast |
| Mi cuenta | Guardar información personal | Aviso en el formulario y toast |
| Mi cuenta | Cambiar contraseña | Aviso del modal y toast; contraseña incorrecta no cierra la sesión |
| Acceso | Comprobar sesión, iniciar sesión y activar cuenta | Formularios en español; comprobación inicial fallida muestra toast, excepto el 401 esperado cuando aún no hay sesión |
| Navegación | Cerrar sesión | Aviso visible y toast si falla |

`AssetsPage.tsx` y `AssignmentPanel.tsx` no están conectados a las rutas actuales. También se migraron sus solicitudes y errores para que una futura reutilización no vuelva a exponer mensajes técnicos.

## Propiedad compartida

- `lib/api.ts`: cliente HTTP, códigos de error, traducción y fallos de conexión/respuesta.
- `ui/feedback/useRequestError.ts`: publicación de error y devolución del mensaje para el formulario.
- `ui/feedback/ToastProvider.tsx`: única cola de notificaciones, deduplicación, cierre y capa superior.
- `ui/overlays/ConfirmDialog.tsx`: aviso interno en confirmaciones fallidas.

Los errores no traducen texto arbitrario del servidor: se interpretan sus códigos. Un código desconocido recibe una explicación segura en español basada en el estado HTTP o en la operación. No se muestran trazas, errores de base de datos ni detalles internos.

## Verificación

- Siete pruebas del cliente HTTP, usando el ejecutor de pruebas de Node y el TypeScript existente: traducción de errores, desconexión, respuesta HTML de error, JSON inválido, respuesta vacía válida, expiración de sesión y cancelación intencional. Todas pasaron. Comando del proyecto: `pnpm --filter @inventory-ti/web test:errors`.
- TypeScript y ESLint pasaron en el frontend y los archivos modificados, respectivamente. El build de producción terminó correctamente; conserva el aviso de tamaño del bundle principal, que no se abordó en esta tarea.
- Chromium, con la API simulada: crear y cambiar estado de un producto; registrar un movimiento; añadir un activo; cargar, asignar y devolver activos; consultar y reintentar un historial; solicitar y revisar correcciones; restablecer y editar usuarios; editar perfil y cambiar contraseña.
- Se comprobó que el toast pertenece a la capa superior, que su botón de cierre es realmente alcanzable y que no cierra el modal. También se probó una confirmación sobre un segundo modal y una pantalla de 390 × 844 en tema oscuro con movimiento reducido.
- Se simularon errores de carga en Catálogo, Inventario, Usuarios, Correcciones e Inicio. No aparecen estados vacíos falsos; Inicio recupera sus indicadores al reintentar.
- Se simularon fallos de paginación en Catálogo y Usuarios: los 25 registros ya obtenidos permanecen visibles, no hay una cadena de reintentos automáticos y Cargar más recupera la página siguiente.
- Las comprobaciones de navegador no enviaron operaciones a la API real ni modificaron registros de la aplicación.

React Doctor no pudo ejecutarse: la revisión automática rechazó esa herramienta externa por su acceso al código privado y no se intentó eludir esa restricción. El análisis estático de diseño encontró observaciones existentes, incluidas coincidencias sobre los selects custom y componentes antiguos no montados; no equivale a un aprobado completo de diseño ni forma parte de las correcciones de solicitudes.

El alcance es el manejo de errores del frontend. La traducción y presentación de un 500 no reparan por sí mismas la causa del fallo en la API o en la base de datos.
