# Mi cuenta

Esta vista reúne tu ficha personal y los controles para actualizar tus datos. Está disponible para todos los roles autenticados.

En escritorio, el lado izquierdo contiene las acciones/formulario y el derecho la identidad, rol, estado y contacto. En móvil se reorganiza en una columna.

## Información visible

Puedes consultar nombre, usuario de acceso, correo, teléfono, rol y estado. El teléfono usa el formato chileno cuando corresponde; la información faltante se identifica como no informada.

El **usuario de acceso es único**. En esta vista es de solo lectura. Tampoco puedes cambiar tu rol: únicamente JEFE lo administra desde Usuarios.

## Editar información personal

1. Pulsa **Editar** en Información personal.
2. Se habilitan los campos dentro de la misma vista, sin abrir otro modal.
3. Actualiza nombre, correo y teléfono.
4. Pulsa **Guardar cambios** para enviar la solicitud, o **Cancelar** para descartar.

Abrir la edición **no guarda** ni envía una actualización automática. Solo se confirma el cambio cuando responde el servidor. El nombre es obligatorio; los valores de contacto se validan si se informan y el teléfono se normaliza al enviarlo. Puedes vaciar correo o teléfono: Mi cuenta envía `null` y la API lo admite para datos de contacto. Esto no elimina la obligación de informarlos al crear una cuenta nueva.

Si falla la actualización, se conserva el borrador y aparecen el error en contexto y un toast en español. Mientras se guarda se evita repetir el envío.

## Cambiar contraseña

Pulsa **Cambiar** en Contraseña para abrir el modal compartido. Indica contraseña actual y nueva; puedes mostrar u ocultar cada campo.

La nueva contraseña requiere entre **12 y 128 caracteres**, al menos una letra A–Z/a–z y un número. **Guardar contraseña** solicita el cambio al servidor. La confirmación indica que las otras sesiones se cerraron; la sesión actual se mantiene. Si la contraseña actual es incorrecta, se informa el error dentro del modal; no debe interpretarse como sesión vencida.

No es el mismo flujo que restablecer administrativamente otra cuenta. Si olvidaste tu contraseña y no puedes iniciar sesión, solicita ayuda a JEFE mediante [Usuarios](users.md).

## Apariencia

La ficha, controles, modal y notificaciones siguen el tema claro, oscuro o sistema de toda la app. Cambiar el tema no modifica tus datos personales ni tu rol.
