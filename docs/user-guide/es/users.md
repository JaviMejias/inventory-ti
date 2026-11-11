# Usuarios

La vista **Usuarios** y la administración de cuentas están disponibles solo para JEFE. No existe registro público de usuarios.

## Consultar y buscar

La tabla compacta presenta identidad (nombre y usuario), rol, estado y acciones. Los roles y estados tienen colores propios; no dependen únicamente del color para identificarse.

Busca por nombre, usuario o correo y filtra todos, activos o inactivos. La consulta remota espera 300 ms, descarta respuestas antiguas y carga **25 registros por página**. Continúa al hacer scroll o con el control para cargar más. Los totales visibles no implican que toda la base esté cargada.

En pantallas estrechas cada usuario pasa a una tarjeta con las mismas acciones. Los datos largos se pueden consultar completos mediante el tooltip en escritorio. Correo y teléfono se revisan en el editor; no ocupan columnas permanentes de esta tabla compacta.

## Crear una cuenta

1. Pulsa **Nuevo usuario**; está disponible aunque la tabla tenga registros o filtros.
2. Completa nombre, usuario de acceso, correo, teléfono y rol.
3. Guarda. Si el servidor confirma, se cierra el editor y aparece el modal con el código de activación.
4. Usa **Copiar** y entrega el código a la persona por un canal adecuado.
5. La persona configura su contraseña mediante [activación](authentication.md).

Ejemplo de nombre: **Juan Pérez**. El usuario de acceso es único, tiene entre 3 y 100 caracteres y admite letras, números, puntos, guiones y guiones bajos. Un usuario/correo que entre en conflicto con otro identificador de acceso produce un error; no reemplaza otra cuenta.

JEFE no establece la contraseña personal en este formulario. La cuenta nueva queda administrativamente activa, pero **pendiente de configurar contraseña**. El código es de un solo uso, vence a las **24 horas** y no vuelve a aparecer en consultas posteriores. Es sensible: no debe publicarse ni añadirse a documentación o capturas compartidas. Si se pierde, utiliza el flujo de restablecer acceso para emitir uno nuevo.

Los filtros permanecen al actualizar la tabla: una cuenta recién creada podría no aparecer en la consulta activa.

## Editar y activar/inactivar

**Editar** abre el modal de datos, incluido el rol. Solo JEFE administra roles. La persona puede actualizar sus datos de contacto en Mi cuenta, pero no cambiar su rol allí.

El switch tiene ancho estable y exige confirmación para activar/inactivar. No cambia visualmente antes de que el servidor confirme. Controla `isActive`, no `isActivated`: activar administrativamente no configura una contraseña ni entrega otro código. Desactivar revoca las sesiones, sin borrar el historial.

El editor actual exige correo y teléfono incluso al editar cuentas antiguas. La API admite borrar esos campos con `null`, pero el editor administrativo todavía no permite dejarlos vacíos. No confundir esta limitación con una obligación del servidor para todos los perfiles existentes.

Los teléfonos chilenos se muestran con formato **+56 9 1234 5678** cuando corresponden. Este frontend envía solo los dígitos; la API también admite teléfonos con separadores de otros clientes. Es un dato de contacto, no un identificador de acceso, segundo factor ni canal de recuperación automático.

## Restablecer acceso

1. Pulsa **Restablecer** en la cuenta correspondiente.
2. Revisa la advertencia del modal de confirmación.
3. Confirma y espera la respuesta.
4. Copia el nuevo código del segundo modal; la persona deberá configurar nuevamente su contraseña.

El código se adapta al modal, permite copiarlo y muestra feedback de copiado. Restablecer invalida la contraseña, las sesiones y los códigos previos; no es editar el perfil. Tampoco reactiva una cuenta inactiva. Después de configurar la nueva contraseña, la persona debe iniciar sesión nuevamente.

No puedes restablecer administrativamente el acceso de **tu propia cuenta** desde esta tabla; utiliza Mi cuenta para cambiar tu contraseña. La API también puede rechazar cambios que dejarían al sistema sin otro Jefe operativo: sigue el mensaje recibido, sin eludir la protección.

Para reemplazar a un JEFE, la otra cuenta debe estar activa y haber configurado contraseña antes de retirar el acceso anterior. Crear un segundo Jefe pendiente no basta. Si ningún Jefe puede entrar, no hay un botón de recuperación administrativa ni se puede reutilizar el bootstrap sobre una base con usuarios; requiere el procedimiento autorizado descrito en [Usuarios y recuperación](../../deployment/users.md#preserve-administrative-access).

## Si ocurre un error

El editor o confirmación queda abierto y conserva los valores. Los errores asociados a campos se muestran junto a ellos; los fallos generales del editor se notifican por toast, sin una alerta interna general todavía. Las confirmaciones de activar/desactivar/restablecer sí conservan una alerta interna. No repitas una operación sin comprobar el resultado si hubo un fallo de conexión.
