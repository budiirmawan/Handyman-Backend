# CR-HM-BE-CORS-PRODUCTION-01 — CORS deployment handoff (Vercel ↔ Railway)

**Scope:** Backend only. This document is the operator handoff for the browser
CORS policy that lets the Vercel frontend call the Railway API from a browser.

**Explicitly NOT done here:** no live Railway variable was written, no deploy
was triggered, no production migration was run, no database, role, scheduler,
volume or Docker runtime setting was touched, and no Frontend repository was
modified. This change only makes the Backend *capable* of the exact
configuration below and documents how to apply and verify it.

## 1. The exact Railway variable

Set this **one** variable on the Railway Backend service
(`handyman-backend-production`), in the service's variable/environment
configuration (not in the Frontend project, and not as a `DATABASE_URL`-style
compound value):

| Key | Value |
|---|---|
| `CORS_ORIGINS` | `https://handyman-frontend-alpha.vercel.app` |

Exact literal value, no quotes, no trailing slash, no whitespace, no scheme
prefix such as `Origin:` and no wildcard:

```
CORS_ORIGINS=https://handyman-frontend-alpha.vercel.app
```

Rules the parser enforces (a wrong value fails the boot instead of silently
half-applying):

- Comma-separated list of exact `http(s)://host[:port]` origins. Multiple
  origins are allowed, but every one of them must be exact.
- A wildcard is **rejected**: `*` and `https://*.vercel.app` both fail
  configuration. The WHATWG URL parser accepts `*` inside a host, so the
  Backend rejects it explicitly rather than producing a broken allowlist.
- A path, query, fragment or embedded credential (`https://user:pass@host`) is
  rejected.
- Host case is normalized: `https://Handyman-Frontend-Alpha.Vercel.App` is
  accepted and stored as `https://handyman-frontend-alpha.vercel.app`, which is
  the exact string a browser sends in the `Origin` header.
- In production, omitting `CORS_ORIGINS` yields an **empty** allowlist: every
  browser origin is then refused. That is the fail-closed default, not an
  error.

Restart/redeploy the service after setting the variable so the process
re-reads its environment. One API replica, one active instance — see
`docs/HANDYMAN_RAILWAY_STAGE1_DEPLOYMENT.md`.

## 2. What the policy allows once the variable is set

| Aspect | Value |
|---|---|
| Allowed origins | exactly `https://handyman-frontend-alpha.vercel.app` |
| Wildcard | never produced (`Access-Control-Allow-Origin: *` is impossible) |
| Allowed methods | `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS` |
| Allowed request headers | `Content-Type`, `Authorization`, `X-Request-ID`, `Idempotency-Key` |
| Exposed response headers | `X-Request-ID` |
| `Access-Control-Allow-Credentials` | never sent (credentials are `false`) |
| Preflight response | `204`, `Cache-Control` unchanged, `Vary: Origin` |
| Unknown/disallowed origin | answered **without** any allow-origin header, so the browser blocks it |

`Idempotency-Key` was added because it is a verified backend contract (the
duplicate-risky command routes, for example
`POST /api/v1/mobile/assets/{assetId}/unsafe-condition` and the Customer Care
communication intake) — a browser preflight must be able to carry it.
`If-Match` is deliberately **not** allowed: no registered backend route reads
an `If-Match` precondition, so permitting it would widen the browser surface
without a contract behind it.

Authentication and authorization are unchanged: the platform still uses an
opaque bearer session token in `Authorization`, so credentialed CORS stays off
and CORS is never an authentication mechanism. A disallowed origin reaching
the API still receives the normal API response — the browser is what blocks
it. No database value, credential or secret is ever written to a CORS header.

## 3. Reproducible HTTPS preflight verification

Run from any host with outbound HTTPS. The command below is the exact
production pair: the real Vercel frontend origin and the real Railway API
domain, with the request headers the browser actually sends.

### 3.1 Allowed origin — must succeed

```sh
curl --silent --show-error --include --request OPTIONS \
  'https://handyman-backend-production-8b01.up.railway.app/api/v1/auth/login' \
  --header 'Origin: https://handyman-frontend-alpha.vercel.app' \
  --header 'Access-Control-Request-Method: POST' \
  --header 'Access-Control-Request-Headers: authorization,content-type,x-request-id,idempotency-key'
```

Expected:

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://handyman-frontend-alpha.vercel.app
Access-Control-Allow-Methods: GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
Access-Control-Allow-Headers: Content-Type,Authorization,X-Request-ID,Idempotency-Key
Access-Control-Expose-Headers: X-Request-ID
Access-Control-Max-Age: 600
Vary: Origin
```

Checks:

- `access-control-allow-origin` is the **exact** Vercel origin (not `*`).
- `access-control-allow-headers` contains `Idempotency-Key` (case-insensitive).
- `access-control-allow-credentials` is **absent**.

### 3.2 Unapproved origin — must not be granted browser access

```sh
curl --silent --show-error --include --request OPTIONS \
  'https://handyman-backend-production-8b01.up.railway.app/api/v1/auth/login' \
  --header 'Origin: https://handyman-frontend-alpha-1a2b3c.vercel.app' \
  --header 'Access-Control-Request-Method: POST' \
  --header 'Access-Control-Request-Headers: authorization,content-type,x-request-id,idempotency-key'
```

Expected: **no** `access-control-allow-origin` header at all. The browser
blocks the response. Any `access-control-allow-origin: *` in the output is a
release blocker.

### 3.3 Simple (non-preflight) request from the allowed origin

```sh
curl --silent --show-error --include \
  'https://handyman-backend-production-8b01.up.railway.app/api/v1/health' \
  --header 'Origin: https://handyman-frontend-alpha.vercel.app'
```

Expected: `HTTP 200` with
`access-control-allow-origin: https://handyman-frontend-alpha.vercel.app`.

### 3.4 Authentication is still enforced for the allowed origin

```sh
curl --silent --show-error --include \
  'https://handyman-backend-production-8b01.up.railway.app/api/v1/auth/me' \
  --header 'Origin: https://handyman-frontend-alpha.vercel.app'
```

Expected: `HTTP 401` with the standard error envelope
(`AUTHENTICATION_REQUIRED`) and the allow-origin header. CORS permission never
grants access to a protected endpoint.

## 4. Frontend-side note (Frontend repository, not modified here)

The Frontend must send the browser request against
`https://handyman-backend-production-8b01.up.railway.app/api/v1` (or the
approved stable custom domain) and must not add a mode that sends cookies —
the API is bearer-token based and `Access-Control-Allow-Credentials` is
deliberately absent. A Vercel **preview** deployment host is a different
origin and is correctly refused; only the production host above is allowed.
No `Origin` header (server-to-server, mobile, curl) is unaffected by this
policy.

## 5. Rollback

Remove (or blank) the `CORS_ORIGINS` variable and restart the service. The
production default is the empty allowlist, so every browser origin is refused
and the API keeps serving non-browser clients exactly as before. No code
rollback, no migration, no database change and no Frontend change is needed.

## 6. Local verification already performed (this change)

Focused checks that back the policy, all against the disposable/none database
as described in the PR report:

- `tests/deployment-cors-production.test.ts` — production allowlist parsing,
  wildcard rejection, exact-origin preflight, `Idempotency-Key` preflight,
  refused unapproved/sibling origins, no wildcard emission, protected
  endpoints still protected, readiness endpoint unchanged, idempotency
  contract unchanged, migration registry unchanged (450 IDs).
- `tests/deployment-cors.test.ts`, `tests/config.test.ts`,
  `tests/security.test.ts`, `tests/app.test.ts` — existing CORS/config/security
  regression, unchanged and passing.
- `tests/openapi-contract.test.ts` — the four newly documented Customer Care
  discovery routes are registered and answer (not 404).
- `tests/request-idempotency.test.ts`,
  `tests/handyman-care-standalone-discovery-http.test.ts`,
  `tests/handyman-care-building-authority.test.ts`,
  `tests/handyman-care-communications-http.test.ts` — idempotency and Care
  HTTP behavior unchanged.
