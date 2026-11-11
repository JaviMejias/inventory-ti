# Contrato backend V1: metadatos y disponibilidad

Fecha: 2026-10-05. Implementado en código y probado en base aislada. **No desplegado ni migrado en la base operativa.** Requiere Prisma generado y migración `0013_inventory_metadata` aplicada al entorno antes de conectar frontend. No incluye importación ni entregas a oficinas.

## Decisiones de este bloque

- Product describe tipo/marca/modelo; Asset representa el equipo físico. Todos los nuevos campos son opcionales y anulables: no inventar datos para registros previos.
- Estado operativo permanece en `status`. Condición técnica y finalidad son textos independientes, no nuevos estados ni enums cerrados: aún no existe un vocabulario de negocio confirmado.
- `location` y `sector` son metadatos descriptivos, no una entidad Location, destino de asignación ni stock separado por bodega. Su edición no registra un traslado ni reemplaza entregas/devoluciones.
- `ipAddress` almacena una IP completa válida, no el prefijo de red de Fortigate. Hostname y código préstamo no tienen unicidad nueva inferida del Excel.
- No se cambian identidades, cantidades, asignaciones ni fechas históricas al editar metadatos. Name/sku existentes se conservan y tipo/marca/modelo no forman una clave automática de fusión.

## Productos

Rutas existentes `GET /products`, `GET /products/:id`, `POST /products`, `PATCH /products/:id`: añaden `equipmentType`, `brand`, `model` a request de creación/edición y al objeto product de respuesta. Se conserva el campo público `active`, no se renombra a isActive.

| Campo | Tipo | Máximo |
| --- | --- | --- |
| equipmentType | string / null | 100 |
| brand | string / null | 100 |
| model | string / null | 160 |

GET lista añade filtros equipmentType/brand/model; todos son contains sin distinguir mayúsculas. Search incluye esos campos además de name/sku. Pagina con limit/offset y conserva total/hasMore.

Mutaciones siguen siendo JEFE + CSRF. Ejemplo válido de ampliación:

```json
{
  "name": "Notebook HP EliteBook 840 G8",
  "trackingMode": "ASSET",
  "equipmentType": "Notebook",
  "brand": "HP",
  "model": "EliteBook 840 G8",
  "lowStockThreshold": 2
}
```

## Activos

POST `/assets` conserva productId obligatorio; PATCH `/assets/:id` no admite cambiar productId/estado/isActive. Ambos aceptan identificadores vigentes más estos campos:

| Campo | Tipo | Máximo |
| --- | --- | --- |
| technicalCondition | string / null | 100 |
| usagePurpose | string / null | 100 |
| location | string / null | 160 |
| sector | string / null | 100 |
| ipAddress | string IPv4 o IPv6 / null | 45 |
| hostname | string / null | 160 |
| loanCode | string / null | 100 |
| notes | string / null | 10.000 |

Solicitudes de creación/edición rechazan claves no reconocidas con VALIDATION_ERROR; antes algunas claves extra de Asset se descartaban. Los requests vigentes conocidos siguen siendo válidos. Un PATCH vacío es inválido. Estado y baja siguen sus rutas/roles existentes.

Respuesta conserva `{ asset }`, y GET lista `{ assets }`. Asset expone los campos nuevos; product anidado añade equipmentType/brand/model y conserva id/name/sku/trackingMode/isActive. También aparecen en activos anidados de asignaciones por reutilización de assetInclude.

GET `/assets` conserva filtros previos y añade technicalCondition/usagePurpose/location/sector/equipmentType/brand/model como contains sin distinguir mayúsculas. Search añade ubicación/sector/hostname/loanCode/IP y metadatos de producto. No incluye notes en búsqueda ni añade paginación servidor a esta ruta.

Creación/edición sigue JEFE o COORDINADOR + CSRF; SOPORTE no edita metadatos. Un activo retirado sigue siendo ineditable (`ASSET_DECOMMISSIONED`). No cambiar permisos ni ofrecer acciones nuevas en UI por el solo hecho de mostrar metadatos.

```json
{
  "technicalCondition": "Bueno",
  "usagePurpose": "Contingencia",
  "location": "Bodega 2",
  "sector": "A1",
  "hostname": "TRANSITO01NTB",
  "loanCode": "Prestamo MDA 17",
  "notes": "Pendiente de revisión documental"
}
```

## Omitido, vacío y null

Para campos nuevos e identificadores Asset: se recortan espacios; vacío se convierte en null. Omitir en PATCH conserva valor; null/vacío lo borra. Crear sin dato produce null persistido. N/A no tiene transformación automática en operaciones manuales: su significado se resolverá en el importador.

Los cambios de metadatos se auditan dentro de la misma transacción. PRODUCT_UPDATED y ASSET_UPDATED incluyen fields/before/after. Una falla de auditoría revierte el cambio. La auditoría actual registra el momento/operador reales de edición, no reconstruye acontecimientos del Excel.

## GET /assets/availability

Lectura para cualquier rol autenticado; sin CSRF. Ruta implementada, no API de inventario histórico.

Query estricta: productId opcional UUID; equipmentType/brand/model opcionales con mismos límites que producto y coincidencia contains sin distinguir mayúsculas; limit entre 1 y 100 (default 25), offset entero entre 0 y 2.147.483.647 (default 0). Otros parámetros se rechazan.

Devuelve una página de **productos ASSET activos**, incluso aquellos con cero equipos. Productos inactivos y QUANTITY quedan excluidos. Si un productId no existe/no corresponde al alcance, devuelve lista vacía, no 404. Orden name/id ascendente.

Por producto cuenta solo equipos isActive=true y status distinto de DECOMMISSIONED. AvailableCount cuenta exclusivamente AVAILABLE. No deduce disponibilidad desde technicalCondition o usagePurpose; si una condición impide operar debe registrarse el estado mediante su flujo correspondiente. No agrupa automáticamente Alta/Reposición/Usado ni reemplaza aún toda la hoja Disponible.

LowStock es true cuando lowStockThreshold >0 y availableCount <= lowStockThreshold. Umbral cero deshabilita alerta. Esta es una alerta ASSET separada del saldo QUANTITY.

```json
{
  "products": [
    {
      "product": {
        "id": "11111111-1111-4111-8111-111111111111",
        "name": "Notebook HP EliteBook 840 G8",
        "sku": null,
        "equipmentType": "Notebook",
        "brand": "HP",
        "model": "EliteBook 840 G8",
        "lowStockThreshold": 2
      },
      "activeCount": 3,
      "availableCount": 1,
      "statusCounts": {
        "AVAILABLE": 1,
        "ASSIGNED": 1,
        "RESERVED": 1,
        "UNDER_REVIEW": 0,
        "IN_REPAIR": 0,
        "IN_WARRANTY": 0,
        "LOST": 0,
        "DECOMMISSIONED": 0
      },
      "lowStock": true
    }
  ],
  "total": 1,
  "limit": 25,
  "offset": 0,
  "hasMore": false
}
```

Total representa productos coincidentes, no equipos. Los conteos son por producto de la página; frontend debe recorrer páginas si quiere agregar un total global. El backend obtiene productos/total/conteos en un snapshot transaccional Repeatable Read; páginas de peticiones distintas no forman un snapshot histórico compartido.

## Errores y despliegue

Se conservan UNAUTHENTICATED (401), FORBIDDEN/CSRF_INVALID (403), VALIDATION_ERROR (400), conflictos de identificador/inactividad (409) y NOT_FOUND (404) donde corresponden. Los errores de validación mantienen issues con path para feedback de campos. SQL o detalles internos no se exponen al usuario.

Migración 0013 solo añade columnas nullables en transacción, sin defaults/backfills ni tablas Location. Conserva restricciones anteriores. Aplicación requiere revisar TODAS las migraciones pendientes y backup antes del entorno con datos: no asumir que solo 0013 está pendiente. No arrancar la nueva versión de API sobre esquema viejo, porque Prisma incluye los nuevos campos en lecturas existentes.

Validación: schema Prisma, generación, TypeScript/build API, lint acotado y suite completa con **161 pruebas aprobadas**, incluida integración/migraciones en base descartable PostgreSQL 18.6. Las bases temporales se eliminaron después de los checks. WSL ofrece Node 26.7.0, aunque engines exige Node 24; validación en el runtime soportado sigue pendiente. No se ha actualizado Node ni aplicado migraciones operativas.

## Fuera de V1

Entregas a oficina/préstamo, referencias históricas entrantes/salientes, obsolescencia, eventos importados/procedencia, paginación completa de historia, preview/importación, reglas de tintas y conciliación integral de Disponible. Frontend puede diseñar componentes, pero no enviar estos campos/acciones a rutas aún inexistentes.
