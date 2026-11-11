# Migración de la base local

Fecha local:2026-10-05 (America/Santiago). Ejecución autorizada por el usuario: «haz la migracion».

## Resultado

- Destino comprobado: `localhost:5432/inventory_ti`, esquema `public`, PostgreSQL18.6.
- Aplicadas las12 migraciones pendientes, `0013_inventory_metadata`–`0024_import_identity_group_decisions`, mediante `prisma migrate deploy`. Estado posterior:24 migraciones aplicadas correctamente y ninguna pendiente.
- Los archivos/checksums de las migraciones previamente aplicadas coincidían con el repositorio; no había errores de migración sin resolver. Se conservaron los registros históricos de intentos revertidos.
- API local pausada durante el respaldo y despliegue, sin otras conexiones activas; reanudada al finalizar. `/health` respondió HTTP200 con `service:api,status:ok`.
- Cliente Prisma6.19.3 regenerado. Lecturas posteriores correctas:134 productos,25 equipos,10 asignaciones,0 lotes importados y0 decisiones por grupos. No se cargó el Excel ni se ejecutó ningún piloto.
- Conteos y huellas SHA-256 de todas las columnas preexistentes de las10 tablas de aplicación coinciden antes/después. `_prisma_migrations` se comprobó separadamente porque su historial cambia con el despliegue. Las tablas nuevas de importación están vacías. No hay restricciones sin validar ni índices inválidos/no preparados.

## Respaldo y restauración comprobada

Directorio protegido y excluido por `.gitignore`: `/home/javier/inventory-ti/.env.migration-backups` (modo0700). Archivo de respaldo (modo0600):

```text
inventory_ti_before_0013-0024_2026-10-06T02-53-24.393Z_b0bf077b-280f-4193-b605-468544f48d3c.dump
```

El nombre usa UTC; corresponde a la noche del2026-10-05 en Santiago. Tamaño:144935 bytes. SHA-256:

```text
99592965e981a4fd1dba884ddd098b825b2137ce077c98cd7bf2be2bf84d4ac7
```

`pg_dump`/`pg_restore`18.6. Respaldo de formato custom restaurado con transacción única, salida ante errores y sin propietario/permisos en una base nueva aislada: `inventory_ti_restore_migration_87ed27be130d4d1fa63a831a5c3c7a93`. Sus conteos/huellas de datos y registros completos de migraciones coincidieron con el origen. Solo esa base temporal se eliminó al terminar; el respaldo y su reporte `.dump.verification.json` permanecen protegidos. Una recuperación real requiere restaurar en otra base y verificar propietarios/permisos antes de un cambio de destino; no se probó ni autorizó sobrescribir la base operativa.

## Alcance de la verificación

Se utilizó Node24.19.0 para migraciones, regeneración y consultas de comprobación. El proceso de desarrollo ya abierto utiliza Node26.7.0; no se cambió su runtime/configuración y sigue pendiente alinearlo con el requisito del proyecto (`>=24 <25`). HTTP200 no acredita todos los recorridos autenticados o integración frontend.

Las511 pruebas previas corresponden a bases descartables y están registradas en [verificación Node24](verificacion-backend-node24.md); no se repitió la suite para este despliegue sin cambios de código. Este registro acredita solamente la migración local, no despliegue remoto ni importación del Excel. Aplicación de planes por grupos, decisiones de negocio restantes y piloto real siguen pendientes.
