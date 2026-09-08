# Asentra Backend

Production backend for **Asentra Facility & Housekeeping Management**.

Web (`asentra-web`) and Flutter mobile consume this REST API. The backend is
the authority for persistence, security authorization, workflow, business
rules, data scope, and available actions.

```text
ONE BACKEND PLATFORM
+ MULTI CLIENT
+ MULTI PROPERTY
+ MULTI BUILDING
+ DYNAMIC ORGANIZATION
+ DYNAMIC ROLE / PERMISSION
+ MODULE ENTITLEMENT
+ CONFIGURATION
```

## Technology

- Node.js 20+
- TypeScript (strict)
- PostgreSQL (local)
- Versioned REST API `/api/v1`

See [docs/GOVERNANCE.md](docs/GOVERNANCE.md) and
[docs/backend-foundation.md](docs/backend-foundation.md).

## Install

```bash
npm install
cp .env.example .env
```

Put your local PostgreSQL credentials in `.env`. Never commit `.env`.

## Local PostgreSQL

| Item | Development | Tests (`npm test`) |
|---|---|---|
| Host | `localhost` | `localhost` |
| Port | `5432` | `5432` |
| Database | `asentra` | `asentra_test` |

```sql
CREATE DATABASE asentra;
CREATE DATABASE asentra_test;
```

Leave `DB_PASSWORD` empty when the local role accepts trust/peer auth.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PORT` | `3000` | HTTP listen port |
| `API_PREFIX` | `/api/v1` | Versioned API prefix |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `asentra` (`asentra_test` when `NODE_ENV=test`) | Database name |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | _(empty)_ | Set locally; never commit |
| `DB_SSL` | `false` | `true` or `false` |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:5173` (empty in production) | Browser origins |
| `JSON_BODY_LIMIT` | `1mb` | Max JSON body size |
| `SESSION_TTL_MINUTES` | `480` | Session lifetime in minutes |
| `SESSION_TOKEN_BYTES` | `32` | Random bytes per opaque session token |
| `SESSION_LAST_USED_THROTTLE_MS` | `300000` | Min interval between `last_used_at` updates |
| `INVITATION_TTL_HOURS` | `72` | Invitation token lifetime in hours |
| `AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES` | `15` | Login throttle window in minutes |
| `AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Max failed login attempts per IP within the window |

## Migrations

Schema changes must go through version-controlled migrations.

```bash
npm run db:migrate
npm run db:migrate:status
npm run db:migrate:down
npm run db:seed
```

`db:seed` applies idempotent bootstrap data: the six foundation permission
codes and the `PLATFORM_ADMIN` role (with all six permissions). It never
seeds users, credentials, or passwords.

`db:migrate:down` rolls back only the latest migration. Do not use it casually
against important data. `npm test` never rolls back `asentra`.

## Commands

```bash
npm run dev          # TypeScript watch runtime
npm run typecheck    # Strict TypeScript check
npm test             # BE-00 infrastructure tests
npm run test:watch
npm run test:coverage
npm run build        # Compile src/ to dist/
npm start            # node dist/server.js
npm run db:seed      # Apply idempotent RBAC bootstrap data
```

## REST API

> **Authoritative contract:** `docs/api/openapi.yaml` is the single source of
> truth for the Web (`asentra-web`) and Mobile (Flutter) API contract —
> envelope, error codes, security scheme, and documented endpoints. The
> endpoint list below is a quick-reference summary only; when they disagree,
> the OpenAPI document and the backend routes win.
>
> OpenAPI coverage is being introduced incrementally (CR-BE-API-01 PART 01
> establishes the foundation with health, authentication/session, and
> effective-context endpoints). Absence of a path in the OpenAPI document does
> not mean the endpoint does not exist — the backend router remains the
> registration authority until coverage completes.

```text
GET  /api/v1/health
GET  /api/v1/health/database
POST /api/v1/users
GET  /api/v1/users/:id
POST /api/v1/auth/login
GET  /api/v1/auth/me
POST /api/v1/auth/logout
POST /api/v1/roles
GET  /api/v1/roles
GET  /api/v1/roles/:id
POST /api/v1/users/:userId/roles
GET  /api/v1/users/:userId/roles
POST /api/v1/permissions
GET  /api/v1/permissions
GET  /api/v1/permissions/:id
POST /api/v1/roles/:roleId/permissions
GET  /api/v1/roles/:roleId/permissions
POST /api/v1/invitations
POST /api/v1/invitations/accept
POST /api/v1/invitations/:id/revoke
POST /api/v1/users/:id/deactivate
POST /api/v1/users/:id/suspend
POST /api/v1/users/:id/reactivate
GET  /api/v1/auth/audit-events
GET  /api/v1/auth/me/buildings
```

Both web and mobile use this API. Management endpoints are protected by
backend RBAC (default-deny). Authenticated endpoints accept an opaque session
token via `Authorization: Bearer <token>`; protected management endpoints also
require the listed permission.

| Endpoint | Required permission |
|---|---|
| `GET /api/v1/users/:id` | `user.read` |
| `POST /api/v1/users` | `user.manage` |
| `GET /api/v1/roles`, `GET /api/v1/roles/:id`, `GET /api/v1/users/:userId/roles` | `role.read` |
| `POST /api/v1/roles`, `POST /api/v1/users/:userId/roles` | `role.manage` |
| `GET /api/v1/permissions`, `GET /api/v1/permissions/:id`, `GET /api/v1/roles/:roleId/permissions` | `permission.read` |
| `POST /api/v1/permissions`, `POST /api/v1/roles/:roleId/permissions` | `permission.manage` |
| `POST /api/v1/invitations`, `POST /api/v1/invitations/:id/revoke` | `user.manage` |
| `POST /api/v1/users/:id/deactivate`, `POST /api/v1/users/:id/suspend`, `POST /api/v1/users/:id/reactivate` | `user.manage` |
| `GET /api/v1/auth/audit-events` | `auth.audit.read` |

`POST /api/v1/auth/login` and `POST /api/v1/invitations/accept` are
unauthenticated (acceptance is authorized by the one-time invitation token);
`GET /api/v1/auth/me` and `POST /api/v1/auth/logout` require authentication
only.

## Effective User Context

`GET /api/v1/auth/me` returns the backend's authoritative context for the
authenticated user:

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "displayName": "Example User",
    "status": "ACTIVE",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "access": {
    "roles": [{ "id": "uuid", "code": "PLATFORM_ADMIN", "name": "Platform Administrator" }],
    "permissions": ["user.read", "user.manage", "role.read"]
  }
}
```

`access.roles` lists only effective ACTIVE roles; `access.permissions` is the
same deduplicated effective set that `requirePermission(...)` enforces (a
single source of truth).

The context also carries (additive, BE-02H + BE-25B):

- `context.clients` — reachable Client → Property → Building hierarchy,
- `context.workforce` — workforce profile identity linked to the user
  (BE-25B mobile effective context),
- `scope` — flat accessible `buildingIds` / `clientIds` (BE-25B),
- `entitlements` — effective module entitlements (BE-02H).

**Deferred to later Waves:** Organization, Position, Operational Data Scope,
Available Workspace, and Configuration dimensions in the context read model.

## Current scope — BE-01I (complete identity/auth/access wave)

Runtime foundation (BE-00), User identity (BE-01A), Credential & password
(BE-01B), Login / Session (BE-01C), Role (BE-01D), Permission (BE-01E), RBAC
enforcement (BE-01F), Invitation & Account Lifecycle (BE-01G), Authentication
Audit & Security (BE-01H), and Effective User Context (BE-01I:
`GET /auth/me` returns user + active roles + effective permissions).
Passwords, raw session tokens, and raw invitation tokens are never stored in
plaintext or returned by any API.

Deferred: Client, Subscription/Entitlement, Property, Building, Organization,
Position, Data Scope, Available Workspace, Configuration, and all operational
domains.
