# Asentra Backend — BE-00 Foundation

This document describes only the BE-00 runtime foundation. Identity,
authentication, RBAC, tenants, and operational domains are not implemented.

Web (`asentra-web`) and Flutter mobile consume the same REST API. The backend
is the authority for persistence, security authorization, workflow, business
rules, data scope, and available actions.

## Runtime path

```text
HTTP Client
     ↓
Security Middleware          helmet + CORS + JSON body limit
     ↓
Request ID / Logging         X-Request-ID + structured logs
     ↓
REST API v1                  /api/v1
     ↓
Application Foundation       Express app + AppError contract
     ↓
PostgreSQL Connection        pg pool, SELECT 1
     ↓
Local PostgreSQL             localhost:5432 / asentra
```

## Layout

```text
src/
├── app.ts                   Express application
├── server.ts                Process start / listen / shutdown
├── config/                  Validated environment
├── database/                Pool, migrations, seeds (empty)
├── middleware/              Security, CORS, request ID, logging, errors
├── routes/                  Health routes only
├── shared/                  Logger, API envelope, AppError
└── modules/                 Reserved for later Waves
```

## REST endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Process is alive |
| `GET` | `/api/v1/health/database` | `SELECT 1` against local PostgreSQL |

Unknown `/api/v1/*` routes return JSON `NOT_FOUND`.

## Response contract

Success:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Readable message"
  }
}
```

Foundation codes: `BAD_REQUEST`, `NOT_FOUND`, `VALIDATION_ERROR`,
`DATABASE_UNAVAILABLE`, `INTERNAL_SERVER_ERROR`.

Every response includes `X-Request-ID`. Stack traces and secrets are never
returned to API consumers.

## Local data stores

| Store | Purpose |
|---|---|
| `asentra` | Development / compiled runtime |
| `asentra_test` | Automated tests only (`NODE_ENV=test`) |

Schema changes go through `npm run db:migrate`. BE-00 creates only
`schema_migrations` and `schema_foundation`.

## Deferred

Identity, authentication, session, users, RBAC, permission, entitlement,
client / property / building / organization, operational domains, workflow,
and reporting.
