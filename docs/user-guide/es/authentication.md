# Acceso y activación

El acceso es interno. No hay botón de registro público ni un flujo de recuperación por correo implementado.

## Iniciar sesión

1. Escribe tu usuario de acceso o correo.
2. Ingresa la contraseña; el icono permite mostrarla u ocultarla.
3. Pulsa **Iniciar sesión**.

Mientras se envía, el botón muestra carga y no admite envíos repetidos. Ante credenciales incorrectas se conserva el identificador y se marca el error. Actualmente la contraseña también permanece en el campo; su limpieza automática sigue pendiente respecto del contrato de experiencia. Los problemas de acceso/conexión se explican en español dentro del formulario.

## Activar o recuperar una cuenta

JEFE crea cuentas y emite códigos desde [Usuarios](users.md). Cuando el inicio de sesión recibe `ACCOUNT_PENDING` para una cuenta activa sin contraseña configurada, presenta **Configurar contraseña**. No debe confundirse ese estado con una cuenta administrativamente inactiva.

La entrada a activación todavía depende de esa respuesta de inicio de sesión: no hay un botón visible inicialmente ni una ruta pública independiente. Como el formulario de acceso exige contraseña, falta una entrada directa para una persona que tiene un código pero nunca configuró contraseña. No se debe tratar el código como contraseña ni inventar una contraseña temporal; es un pendiente de la interfaz.

En la pantalla de activación:

1. Confirma usuario o correo.
2. Introduce el código entregado por JEFE.
3. Escribe una contraseña de entre 12 y 128 caracteres, con al menos una letra A–Z/a–z y un número.
4. Repítela y pulsa **Configurar contraseña**.
5. Tras la confirmación, vuelve al inicio de sesión e ingresa con la nueva contraseña. Activar no inicia una sesión automáticamente.

El código es de un solo uso y vence a las **24 horas**. Solo se entrega al crear/restablecer acceso; no se puede recuperar desde la tabla o el perfil. Si está vencido, es inválido o lo perdiste, pide a JEFE un restablecimiento; no hay un autoservicio por correo disponible.

Una cuenta inactiva requiere además que JEFE la active administrativamente. Restablecer el acceso no reactiva por sí solo una cuenta inactiva. Véase [el ciclo de cuentas del backend](../../deployment/users.md).

## Tema y dispositivos

Los controles Claro/Oscuro/Sistema usan la misma preferencia que el resto de la app. El valor inicial sigue al sistema; una selección explícita permanece guardada en ese navegador.

En pantalla estrecha se oculta el panel ilustrado y se prioriza el formulario. Marca y selector de tema quedan en el flujo del encabezado, sin superponerse. En pantallas de poca altura se puede hacer scroll para llegar a los campos y botones.

## Sesión y cierre

Una sesión vencida lleva de vuelta al acceso. Usa **Cerrar sesión** para salir; si la solicitud falla se muestra el error y no se anuncia un cierre confirmado.

Una vez autenticado, las vistas y acciones dependen de tu rol. Consulta [Roles](roles.md) para distinguir las operaciones disponibles de las funciones todavía planificadas.
