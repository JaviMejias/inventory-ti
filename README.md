# Inventory TI

Sistema interno de gestión de inventario de TI para la oficina de soporte de **Chilexpress**.

Inventory TI reemplaza el seguimiento manual basado en hojas de cálculo por una aplicación web que centraliza productos, stock, activos individuales, asignaciones, correcciones y trazabilidad operativa.

## Estado actual

La aplicación se encuentra en desarrollo y actualmente incluye:

- autenticación por usuario o correo electrónico;
- sesiones persistidas en PostgreSQL;
- activación y recuperación administrativa de cuentas;
- catálogo de productos;
- inventario cuantitativo consolidado por producto;
- movimientos de inventario inmutables;
- gestión de activos individuales;
- asignación y devolución de activos;
- solicitudes y aprobación de correcciones de inventario;
- dashboard operativo con indicadores, gráficos, alertas de stock y correcciones pendientes;
- administración de usuarios y roles;
- registro de auditoría para operaciones relevantes;
- interfaz en español, tema claro/oscuro/sistema y diseño responsive.

Las siguientes capacidades están documentadas, pero todavía no forman parte de la implementación disponible:

- reportes exportables;
- WebSocket y actualizaciones realtime;
- service worker y capacidades PWA completas;
- almacenamiento de archivos;
- imágenes Docker y Docker Compose;
- CI/CD y backups automatizados.

## Funcionalidades

### Autenticación y usuarios

- Login mediante username o email.
- Logout con invalidación de sesión en el servidor.
- Sesiones con cookie `HttpOnly`, `SameSite=Lax` y `Secure` en producción.
- Contraseñas protegidas con `scrypt` y salt aleatorio.
- Activación de cuentas mediante código de un solo uso con expiración.
- Cambio de contraseña y restablecimiento administrativo de acceso.
- Protección CSRF para operaciones autenticadas que modifican datos.
- Rate limiting en login y activación.
- Roles disponibles: `JEFE`, `COORDINADOR` y `SOPORTE`.

### Catálogo

Cada producto tiene:

- nombre único global, sin distinguir mayúsculas/minúsculas;
- SKU opcional y único;
- modo de seguimiento `QUANTITY` o `ASSET`;
- umbral de stock bajo;
- estado activo/inactivo;
- fecha de creación y actualización.

Solo `JEFE` administra productos. La inactivación no elimina el historial ni los movimientos existentes.

### Inventario cuantitativo

El inventario por cantidad mantiene un stock materializado consolidado por producto. Los movimientos soportados son:

- `INITIAL`: stock inicial, solo una vez por producto;
- `ENTRY`: entrada de stock;
- `EXIT`: salida de stock;
- `RETURN`: devolución de stock;
- `ADJUSTMENT`: ajuste firmado con motivo obligatorio.

Cada operación de stock:

1. valida la entrada con Zod;
2. valida autenticación y permisos en el backend;
3. bloquea las filas de stock necesarias;
4. actualiza el stock y crea el movimiento en una misma transacción;
5. revierte todo si alguna parte falla.

Los movimientos son inmutables: no existe una ruta para modificarlos o eliminarlos.

### Activos individuales

Los productos con tracking `ASSET` pueden tener activos individuales con:

- etiqueta patrimonial;
- número de serie;
  - producto, identificadores y estado;
- estado operativo;
- historial de movimientos y auditoría.

Estados soportados: `AVAILABLE`, `ASSIGNED`, `RESERVED`, `UNDER_REVIEW`, `IN_REPAIR`, `IN_WARRANTY`, `LOST` y `DECOMMISSIONED`.

Los activos no modifican el stock cuantitativo. La asignación de un equipo cambia su estado, pero no reduce la cantidad física de activos registrados.

### Asignaciones

- Asignación de un activo disponible a una persona.
- La persona puede ser un usuario activo o un destinatario de texto libre, según el flujo utilizado.
- Solo puede existir una asignación activa por activo.
- Devolución con registro de fecha y usuario que realizó la operación.
- Historial completo de asignaciones, sin borrar registros anteriores.
- Protección transaccional contra asignaciones concurrentes.

### Correcciones

Una corrección permite solicitar un delta firmado sobre un movimiento cuantitativo sin modificar el movimiento original.

- Todos los roles operativos pueden solicitar correcciones.
- `JEFE` puede aprobar o rechazar.
- El solicitante no puede aprobar su propia solicitud.
- `COORDINADOR` y `SOPORTE` solo ven sus propias solicitudes.
- Una aprobación crea un movimiento compensatorio `ADJUSTMENT`.
- La aprobación actualiza stock y auditoría de forma atómica.
- Una solicitud solo puede procesarse una vez.

### Dashboard

La ruta principal (`/`) muestra un resumen operativo construido desde los endpoints existentes:

- productos activos;
- stock disponible;
- activos rastreables;
- alertas por stock bajo;
- flujo de entradas, salidas y ajustes;
- distribución de activos por estado;
- correcciones pendientes;
- filtros por período y rango de fechas.

Actualmente no existe un endpoint backend dedicado `/dashboard`; la vista compone los datos mediante varias consultas REST.

## Stack tecnológico

| Capa | Tecnología |
| --- | --- |
| Runtime | Node.js `>=24 <25` |
| Package manager | pnpm `11.19.0` |
| Backend | TypeScript, Fastify 5, Zod |
| ORM y migraciones | Prisma 6 |
| Base de datos | PostgreSQL 14+ |
| Frontend | React 19, TypeScript, Vite 6 |
| Estilos | Tailwind CSS 3 y CSS propio |
| Routing | React Router DOM 6 |
| Gráficos | Recharts |
| Fechas | date-fns y `es-CL` |
| Pruebas | Node.js built-in test runner (`node:test`) |
| Monorepo | pnpm workspaces |

Versiones exactas resueltas por el lockfile pueden cambiar dentro de los rangos declarados; se debe utilizar `pnpm-lock.yaml` como referencia reproducible.

## Arquitectura

Inventory TI es un **monolito modular**: un backend, un frontend y una base de datos PostgreSQL.

```text
Navegador
  │ React + Vite + Tailwind
  │ REST, cookies y CSRF
  ▼
API Fastify
  │ rutas → esquemas Zod → servicios de dominio
  │ autorización backend
  │ transacciones y bloqueos
  ▼
Prisma
  ▼
PostgreSQL
```

Principios principales:

1. PostgreSQL es la fuente autoritativa del estado.
2. La autorización del backend es la frontera de seguridad; las restricciones frontend son solo UX.
3. El stock materializado y los movimientos se actualizan atómicamente.
4. Los movimientos y el historial de asignaciones son inmutables.
5. Los activos individuales están separados del inventario cuantitativo.
6. Los servicios contienen reglas de negocio; las rutas manejan HTTP y serialización.
7. `packages/shared` solo debe contener conceptos seguros y realmente compartidos, no acceso a base de datos ni lógica de servidor.

No se utilizan microservicios, Kubernetes, Kafka, RabbitMQ, Redis, GraphQL, CQRS completo ni event sourcing.

## Estructura del repositorio

```text
inventory-ti/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── auth/          # sesiones, login, usuarios y autorización
│   │   │   ├── catalog/       # catálogo de productos
│   │   │   ├── config/        # entorno y conexión Prisma
│   │   │   ├── lib/           # errores y contraseñas
│   │   │   ├── routes/        # inventario, activos, asignaciones y correcciones
│   │   │   └── scripts/       # bootstrap del administrador inicial
│   │   ├── tests/             # pruebas de integración API y base de datos
│   │   └── package.json
│   └── web/
│       ├── src/
│       │   ├── features/      # auth, home, catálogo, inventario y administración
│       │   ├── ui/            # layout, primitivas, tablas, feedback y diálogos
│       │   ├── config/        # configuración Vite/frontend
│       │   ├── i18n/           # textos traducibles
│       │   ├── lib/            # API, permisos y formato
│       │   └── theme/          # inicialización y preferencias de tema
│       └── package.json
├── packages/
│   └── shared/                # tipos transportables compartidos
├── prisma/
│   ├── schema.prisma          # modelo PostgreSQL
│   └── migrations/            # migraciones versionadas
├── docs/                      # documentación técnica, producto y operación
├── package.json               # scripts y workspace raíz
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Requisitos

- Node.js `>=24.0.0 <25.0.0`.
- pnpm `>=11.0.0 <12.0.0`; el proyecto fija `pnpm@11.19.0`.
- PostgreSQL 14 o superior, ejecutándose y accesible.
- Una base de datos vacía para la instalación inicial.

Verificar versiones:

```bash
node --version
pnpm --version
psql --version
```

## Instalación local

### 1. Clonar e instalar dependencias

```bash
git clone <repo-url> inventory-ti
cd inventory-ti
pnpm install
```

### 2. Configurar el entorno

```bash
cp .env.example .env
```

Editar `.env` y ajustar, como mínimo, `DATABASE_URL`:

```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/inventory_ti"
```

La aplicación web usa `http://localhost:3000` por defecto. Si se necesita cambiarlo:

```bash
cp apps/web/.env.example apps/web/.env
```

Luego editar `VITE_API_URL`.

### 3. Crear la base de datos

Con PostgreSQL iniciado:

```bash
psql -U postgres -c "CREATE DATABASE inventory_ti;"
```

Si la base de datos o el usuario ya existen, omitir este paso y ajustar `DATABASE_URL`.

### 4. Aplicar migraciones

```bash
pnpm db:migrate
```

Este comando genera el cliente Prisma y ejecuta las migraciones pendientes con `prisma migrate deploy`.

### 5. Crear el administrador inicial

```bash
pnpm bootstrap:admin
```

El comando solicita username, nombre visible y contraseña. Solo funciona cuando no existen usuarios y nunca crea credenciales por defecto.

### 6. Iniciar el sistema

```bash
pnpm dev
```

Servicios locales:

| Servicio | URL |
| --- | --- |
| API | <http://localhost:3000> |
| Health check | <http://localhost:3000/health> |
| Aplicación web | <http://localhost:5173> |

La API y la aplicación web se ejecutan en paralelo mediante pnpm.

## Variables de entorno

### API

| Variable | Valor por defecto | Descripción |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/inventory_ti` | Conexión PostgreSQL. |
| `NODE_ENV` | `development` | `development`, `test` o `production`. |
| `API_HOST` | `0.0.0.0` | Dirección de escucha de Fastify. |
| `API_PORT` | `3000` | Puerto de la API. |
| `WEB_ORIGIN` | `http://localhost:5173` | Origen permitido por CORS. |
| `SESSION_SECRET` | fallback solo en desarrollo | Mínimo 32 caracteres; obligatorio en producción. |
| `SESSION_TTL_HOURS` | `8` | Duración absoluta de la sesión. |
| `COOKIE_SECURE` | `false` | Debe ser `true` en producción con HTTPS. |

### Frontend

| Variable | Valor por defecto | Descripción |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:3000` | URL de la API vista desde el navegador. |

No se deben incluir secretos reales en `.env.example`, el código, migraciones ni imágenes de despliegue. Los archivos `.env` están ignorados por Git.

## Scripts disponibles

Ejecutar desde la raíz del repositorio:

| Comando | Descripción |
| --- | --- |
| `pnpm dev` | Inicia API y web en paralelo. |
| `pnpm dev:api` | Inicia solo la API. |
| `pnpm dev:web` | Inicia solo la aplicación web. |
| `pnpm lint` | Ejecuta ESLint en el monorepo. |
| `pnpm typecheck` | Ejecuta TypeScript en todos los paquetes. |
| `pnpm build` | Compila todos los paquetes y aplicaciones. |
| `pnpm test` | Ejecuta las pruebas de la API. Requiere PostgreSQL. |
| `pnpm prisma:validate` | Valida el schema Prisma. |
| `pnpm db:generate` | Genera el cliente Prisma. |
| `pnpm db:migrate` | Genera el cliente y aplica migraciones pendientes. |
| `pnpm bootstrap:admin` | Crea el primer usuario `JEFE`. |

Comandos específicos:

```bash
pnpm --filter @inventory-ti/api test
pnpm --filter @inventory-ti/api typecheck
pnpm --filter @inventory-ti/web typecheck
pnpm --filter @inventory-ti/web build
```

## Base de datos y migraciones

El schema se encuentra en [prisma/schema.prisma](prisma/schema.prisma). Las migraciones actuales cubren:

1. schema inicial;
2. sesiones de autenticación;
3. metadatos de devolución de asignaciones;
4. integridad del historial de asignaciones;
5. delta firmado para correcciones;
6. color histórico de categorías;
7. snapshot del nombre de la persona asignada;
8. ciclo de activación de usuarios;
9. eliminación de categorías y unicidad global de productos.

Para crear una nueva migración durante el desarrollo:

```bash
pnpm --filter @inventory-ti/api exec prisma migrate dev \
  --schema ../../prisma/schema.prisma \
  --name <nombre_de_migracion>
```

En producción se debe utilizar `pnpm db:migrate` con `migrate deploy`. No utilizar `migrate reset` ni `db push --force-reset` contra una base de datos productiva.

## API

Todos los endpoints devuelven JSON. La documentación completa está en [docs/technical/backend.md](docs/technical/backend.md).

Grupos de endpoints implementados:

- `GET /health` — health check público.
- `/auth/*` — login, logout, sesión, CSRF, activación y cambio de contraseña.
- `/users/*` — administración de usuarios por `JEFE`.
- `/products/*` — catálogo y ciclo activo/inactivo.
- `/inventory/stock/*` — stock materializado.
- `/inventory/movements/*` — historial y operaciones de inventario.
- `/assets/*` — activos, estados, movimientos y baja.
- `/assignments/*` y `/assets/:id/assignments/*` — asignaciones y devoluciones.
- `/corrections/*` — solicitudes, aprobación y rechazo de correcciones.

Las mutaciones autenticadas requieren el header `X-CSRF-Token`, obtenido mediante `GET /auth/csrf`.

## Roles

| Capacidad | `JEFE` | `COORDINADOR` | `SOPORTE` |
| --- | :---: | :---: | :---: |
| Consultar información autenticada | Sí | Sí | Sí |
| Administrar usuarios | Sí | No | No |
| Administrar productos | Sí | No | No |
| Inicializar inventario | Sí | No | No |
| Entradas, salidas y devoluciones | Sí | Sí | Sí |
| Ajustes de inventario | Sí | Sí | No |
| Crear y editar activos | Sí | Sí | No |
| Operar estados de activos | Sí | Sí | Sí, con estados restringidos |
| Dar de baja activos | Sí | No | No |
| Asignar y devolver activos | Sí | Sí | Sí |
| Solicitar correcciones | Sí | Sí | Sí |
| Aprobar o rechazar correcciones | Sí | No | No |

La matriz completa está en [docs/product/roles.md](docs/product/roles.md). Las restricciones visibles en la interfaz no sustituyen la autorización del backend.

## Pruebas

Las pruebas usan el runner integrado de Node (`node:test`) y PostgreSQL. Cubren autenticación, autorización, CSRF, catálogo, stock, concurrencia, activos, asignaciones, correcciones, rollback transaccional e invariantes de base de datos.

```bash
pnpm test
```

Se recomienda ejecutar las pruebas contra una base de datos desechable o dedicada para testing. El comando carga el `.env` de la raíz y utiliza `DATABASE_URL` si está exportada explícitamente.

Validación recomendada antes de integrar cambios:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm prisma:validate
```

## Build y despliegue

Construir la aplicación:

```bash
pnpm build
```

El resultado queda en:

- `apps/api/dist` — backend compilado;
- `apps/web/dist` — archivos estáticos del frontend.

Iniciar la API compilada:

```bash
node apps/api/dist/server.js
```

En producción se espera:

1. PostgreSQL administrado y respaldado.
2. API Node.js ejecutándose detrás de un process manager.
3. Frontend estático servido mediante Nginx, Caddy, Traefik u otro servidor equivalente.
4. HTTPS terminado en el reverse proxy.
5. `WEB_ORIGIN` configurado exactamente al origen público del frontend.
6. `COOKIE_SECURE=true`.
7. `SESSION_SECRET` aleatorio de al menos 32 caracteres.
8. Migraciones aplicadas con `pnpm db:migrate` antes de iniciar la nueva versión.

Docker Compose, imágenes de contenedor, CI/CD y backups automatizados todavía no están incluidos en el repositorio.

## Seguridad

- Las contraseñas nunca se almacenan en texto plano.
- Las sesiones se almacenan server-side; la base de datos guarda el hash del token.
- Las mutaciones con cookie requieren CSRF.
- El backend valida roles y reglas de negocio.
- Los errores de API no exponen SQL, stack traces ni secretos.
- Los códigos de activación se almacenan como hash y expiran.
- La aplicación no utiliza JWT ni tokens en `localStorage`.
- Los secretos deben provenir del entorno y no del repositorio.

Más información en [docs/technical/security.md](docs/technical/security.md).

## Limitaciones conocidas

- No hay WebSocket; las vistas se actualizan mediante solicitudes REST.
- No existe soporte offline ni service worker productivo.
- No hay módulo de reparaciones; `IN_REPAIR` e `IN_WARRANTY` son estados de activos.
- No hay jerarquía de oficinas ni flujos multi-oficina complejos.
- No hay reportes exportables.
- No hay almacenamiento de archivos.
- El rate limiting es local al proceso y no distribuido.
- No hay garantía automática de mantener siempre un `JEFE` activo.

## Documentación

Índice completo: [docs/index.md](docs/index.md).

### Producto

- [Requisitos](docs/product/requirements.md)
- [Inventario](docs/product/inventory.md)
- [Activos](docs/product/assets.md)
- [Workflows](docs/product/workflows.md)
- [Roles](docs/product/roles.md)
- [Reportes](docs/product/reports.md)
- [Guía de usuario en español](docs/user-guide/es/README.md)

### Técnica

- [Arquitectura](docs/technical/architecture.md)
- [Estructura del repositorio](docs/technical/structure.md)
- [Backend](docs/technical/backend.md)
- [Frontend](docs/technical/frontend.md)
- [Base de datos](docs/technical/database.md)
- [Seguridad](docs/technical/security.md)
- [Testing](docs/technical/testing.md)
- [Decisiones arquitectónicas](docs/technical/decisions.md)
- [Realtime planificado](docs/technical/realtime.md)
- [PWA planificada](docs/technical/pwa.md)
- [Storage planificado](docs/technical/storage.md)

### Operación y despliegue

- [Desarrollo local](docs/deployment/development.md)
- [Configuración](docs/deployment/configuration.md)
- [Base de datos y migraciones](docs/deployment/database.md)
- [Producción](docs/deployment/production.md)
- [Backups](docs/deployment/backups.md)
- [Troubleshooting](docs/deployment/troubleshooting.md)
- [Docker planificado](docs/deployment/docker.md)

La documentación técnica y de producto está escrita principalmente en inglés. La guía operativa para usuarios está disponible en español. Los identificadores del dominio y del código permanecen en inglés.

## Convenciones de desarrollo

- Mantener el backend como monolito modular.
- Colocar las reglas de negocio en servicios, no directamente en handlers HTTP.
- Reutilizar componentes de `apps/web/src/ui` antes de crear variantes locales.
- Mantener compatibilidad con Node 24, pnpm 11 y las versiones del lockfile.
- No editar migraciones ya aplicadas; crear una nueva migración para cambios de schema.
- Validar autorización y CSRF en backend aunque la interfaz oculte acciones.
- Ejecutar lint, typecheck, pruebas y build antes de entregar cambios relevantes.

## Licencia

No se ha definido una licencia pública para este proyecto. Es un sistema interno de Chilexpress y su distribución debe tratarse como privada hasta que exista una decisión formal.
