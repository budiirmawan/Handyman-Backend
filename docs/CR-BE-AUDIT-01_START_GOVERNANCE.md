# CR-BE-AUDIT-01 — START GOVERNANCE

**Title:** Enterprise Audit + Request Correlation
**Status:** PART 01–05 implemented; governance closure recorded and FINAL REVIEW ready. No broad regression or CI run is included.
**Inspection date:** 2026-08-23 (UTC)
**Repository:** `budiirmawan/Asentra-Backend`
**Working branch:** `arena/01a02ea4-asentra-backend`
**Authority baseline:** `main` / `origin/main` at `912e7655879bde76fd764b07048c9fc77fbe0452`, merge commit for CR-BE-INTEG-01 (PR #59).

> This document records the smallest additive governance decision after the
> CR-BE-INTEG-01 merge. It deliberately reuses the current event, identity,
> isolation, scheduler, provider, history, and response authorities. It does
> not rebuild an audit/event platform.

---

## 0. Decision summary

| Decision | Governance position |
|---|---|
| Business-event authority | Keep BE-07 `operational_events` and `recordOperationalEvent` as the single business/operational event authority. `integration_outbox_events` remains only a prospective outbound marker. |
| Request/correlation identifier | Keep one canonical `requestId` value on `req.requestId`, the `X-Request-ID` response header, logs, and error envelopes. The value is a server-generated UUID at HTTP entry; a caller-supplied header is never authoritative. |
| Context propagation | Add a small `AsyncLocalStorage` execution context around the existing request-id middleware. Existing service call sites continue to call `recordOperationalEvent` unchanged. |
| Operational-event extension | Add only nullable `request_id` and nullable `source` to `operational_events`. Existing `client_id`, `building_id`, `actor_user_id`, `vendor_work_id`, entity identity, summary, and metadata remain authoritative; none are duplicated. |
| Sources | New events use `HTTP`, `SCHEDULER`, or `SYSTEM`. Historical rows remain `NULL` for the new fields; no backfill. A scheduler run uses a generated UUID in `request_id` with `source = SCHEDULER`, not a fabricated HTTP request. |
| Audit boundary | Audit state-changing, approval, security-sensitive, provider/integration, automated-job, and evidence/document-governance facts. Do not auto-audit every GET/read. Existing explicitly governed reads, such as configuration preview access, remain allowed. |
| Immutability | `operational_events` stays append-only at the application boundary: no normal update/delete API, no user-authored event payload, no manual event-injection endpoint, and no blockchain/signing scheme. Retention/deletion is deferred. |
| Scrubbing | Strengthen the existing operational-event write boundary by reusing the existing bounded recursive history-sanitization pattern; do not create a second audit scrubber. Existing integration/email/WhatsApp error sanitizers remain in their provider boundaries. |
| Enterprise audit read | Enhance the existing `GET /operational-events` read surface rather than adding a second audit store. It becomes a bounded, newest-first, Client/Building-isolated search surface with actor, event, entity, request, and date filters. |
| RBAC | Reuse `operational_event.read` for the enterprise operational audit surface. Keep `auth.audit.read` for the separate authentication audit table and existing domain permissions for specialized histories. Add no new audit permission unless later inspection proves a real separation requirement. |
| OpenAPI | Add a reusable request-correlation response-header component and extend the existing operational-event path/schema. Do not hand-rewrite every operation. |

---

## 1. Inspection baseline and existing authority map

### 1.1 Operational/business events

**Authority found:**

- `src/database/migrations/0080_create_operational_events.ts` creates the
  append-oriented `operational_events` table with mandatory `client_id`,
  optional `building_id` and `actor_user_id`, event/entity identity, summary,
  JSONB metadata, and `occurred_at`/`created_at`.
- `src/database/migrations/0165_add_vendor_work_history.ts` already adds the
  optional `vendor_work_id` link and index. CR-BE-AUDIT-01 must not add another
  relationship for Vendor Work.
- `src/modules/operational-events/index.ts` owns
  `recordOperationalEvent(input, executor)`. It scrubs a BE-07 sensitive-key
  list, inserts the event, and then calls the CR-BE-INTEG-01 outbox seam on the
  same executor.
- The helper is used across the operational domains (100+ source files mention
  it). Existing vocabularies include lifecycle, status, assignment,
  approval/rejection, verification, SLA, evidence, document, Vendor Work,
  notification, and integration events.
- `integration_outbox_events` is a thin unique-FK marker over an existing
  operational event. Its payload is a byte-stable snapshot for outbound
  delivery; it is not a competing event log.

**START-baseline exceptions:** two raw `INSERT INTO operational_events`
implementations were found outside the shared helper: the low-level Work Order
history repository and the Tenant Communication repository. PART 02 routes
both compatibility adapters through the shared writer; the repository-level
methods remain only to preserve their existing callers. No raw operational-event
insert remains outside `recordOperationalEvent` after PART 02.

**Decision:** preserve `operational_events` as the source of truth. Do not add a
new audit/event table, generic event-ingestion endpoint, event replay, or
history backfill.

### 1.2 Actor and user identity

- `src/modules/auth/session.service.ts` resolves an opaque bearer session to
  `AuthContext { userId, sessionId, user }`; raw session tokens are hashed and
  are not the actor identity.
- `src/modules/auth/authentication.middleware.ts` attaches the resolved
  context to `req.auth`.
- `requirePermission(...)` uses the same effective active-permission resolver
  as `/auth/me`; it is default-deny.
- Mutation controllers/services generally pass `req.auth.userId` into their
  domain service and then into `actorUserId`. Scheduler/system events already
  commonly use `actorUserId: null`.
- `authentication_audit_events` has separate `user_id`, `actor_user_id`, and
  `session_id` fields. It is the authority for login/session/account security
  history, not a replacement for business events. Its current `recordEvent`
  path is intentionally best-effort for authentication flows.

**Decision:** `actor_user_id` on `operational_events` remains the only business
event actor field. Do not copy `session_id`, IP address, user agent, or a full
user object into operational events. An inactive/deactivated user remains a
historical actor reference where the existing row permits it; no synthetic
"system user" is created for background work.

### 1.3 Client and Building context

**Authority found:**

- `src/modules/building-assignments/` and the BE-02F
  `resolveBuildingsForUser` resolver establish reachable active Building
  contexts.
- `src/modules/context-access/context-access.service.ts` is the reusable
  isolation authority: `getAccessibleBuildingIds`,
  `getAccessibleClientIds`, `canAccessBuilding`, `canAccessClient`, and the
  corresponding assertions.
- `docs/data-isolation.md` states that access is based on an explicit active
  Building assignment; access to one Building does not imply access to sibling
  Buildings or an entire Client.
- The effective context in `/auth/me` and the mobile `scope` are derived from
  that same resolver.

**Decision:** retain the existing event `client_id` and optional `building_id`
columns. The domain aggregate/service supplies these values after authoritative
context resolution; raw query/body/client-selected context never overrides
them. The new request context will not invent a Client or Building fallback.

### 1.4 HTTP request lifecycle

At the START baseline, `src/app.ts` order was approximately:

```text
security headers → CORS → requestIdMiddleware → mobile context
  → requestLogger → raw provider callback router → JSON parser
  → API routes → notFoundHandler → errorHandler
```

PART 01 now places `requestIdMiddleware` first in the request-handling chain,
before security/CORS, and wraps the downstream lifecycle in the request-local
context. Current authorities are:

- `src/middleware/request-id.ts`: sets `req.requestId` and the
  `X-Request-ID` response header.
- `src/middleware/request-logger.ts`: logs completed requests with the request
  ID, method, path, status, and duration; it does not log request bodies.
- `src/middleware/error-handler.ts`: passes `req.requestId` to
  `sendAppError(...)` and logs it on handled/unhandled errors.
- `src/shared/api-response.ts`: already supports `error.requestId` in the
  standard error envelope.

Before PART 01, the request-id middleware was not the first application
middleware, so an error thrown by an earlier security/CORS layer could lack the
ID, and there was no request context store. PART 01 closes both gaps while
preserving the existing response/header/error seams. Services now have a small
shared context helper; operational-event persistence consumes it in PART 02.

### 1.5 Transaction and executor boundaries

- `src/database/transaction.ts` owns `withTransaction(work)` with
  `BEGIN`/`COMMIT`/`ROLLBACK` and a released `PoolClient`.
- `recordOperationalEvent` accepts an optional executor and defaults to the
  pool. CR-BE-INTEG-01 already calls `maybeEnqueueIntegrationOutboxEvent` on
  the same executor, so event plus outbox can commit atomically when the caller
  supplies the transaction client.
- Many important lifecycle and approval paths use `withTransaction` and pass
  the executor through. Other older paths write the business row and event in
  separate pool operations. The helper's pool default remains valid but does
  not create a transaction by itself.

**Decision:** the correlation columns are written through the same event
executor and do not create a new transaction abstraction. The focused event
extension must preserve the existing executor signature. Transaction
co-location remains required for new state transitions and is a documented
residual risk for older pool-based paths; no broad transaction rewrite belongs
in START GOVERNANCE.

### 1.6 Scrubbing, redaction, and bounded data

The repository has several existing, scope-specific authorities:

- BE-07 `recordOperationalEvent` has a shallow `SENSITIVE_KEYS` denylist
  (`password`, credentials, tokens, authorization, session material, raw
  evidence, secrets, and API keys).
- `src/modules/asset-history/asset-history.metadata.ts` contains the strongest
  existing reusable history sanitizer: recursive key filtering, string/depth/
  array/key limits, and safe primitive normalization.
- Provider paths use bounded error sanitizers, including
  `sanitizeIntegrationWebhookError`, email/SMTP sanitizers, WhatsApp delivery
  sanitizers, and callback feedback sanitization. Integration errors are
  already limited to controlled status/timeout/network descriptions.
- `src/shared/logger.ts` redacts sensitive field names; the error middleware
  also uses `sanitizeDatabaseError`. These are log controls, not a persistence
  authority.

The current operational-event denylist is not recursive or size-bounded, and
direct writers have inconsistent lists. Authentication audit metadata also
relies on safe call sites rather than one central bounded sanitizer.

**Decision:** `recordOperationalEvent` remains the single persistence scrub
boundary for business events. A later implementation should reuse/extract the
existing `sanitizeHistoryMetadata` behavior rather than invent another audit
rule, preserving the current BE-07 denylist as compatibility coverage. The
common operational-event boundary should apply these bounds:

- object metadata only; no `Error` objects, stacks, raw request bodies, raw
  provider response bodies, or attachments;
- existing sanitizer limits of at most 512 characters per string, depth 4, 25
  array items, and 50 keys per object;
- a final serialized metadata budget of approximately 16 KiB, with an explicit
  deterministic truncation/drop policy;
- summaries and persisted error descriptions are bounded (provider-specific
  300/500-character limits remain in force before the common boundary).

This explicitly prevents passwords, tokens, signing secrets, Authorization
headers, provider credentials, session/invitation material, and raw sensitive
payloads from entering audit metadata or its outbound snapshots. Read
projections must remain secret-free as a second defense; they must never expose
outbox payload bodies or endpoint signing secrets.

### 1.7 Existing audit/history read models

The inspection found several legitimate read models, not one missing platform
that should be rebuilt:

| Read model | Current authority and boundary | Current permission / behavior |
|---|---|---|
| Authentication audit | `authentication_audit_events`, `src/modules/audit/`, `GET /auth/audit-events` | `auth.audit.read`; paginated `limit/offset`, newest first; security fields include session/request/IP/user-agent. Not Client/Building-scoped. |
| Generic operational timeline | `operational_events`, `src/modules/operational-events/operational-event.routes.ts`, `GET /operational-events` and `/:id` | `operational_event.read`; current Client/Building scope predicate; filters entity/event/building/date; pagination is opt-in and ordering is currently oldest first. |
| Configuration audit | Projection over `operational_events` in `src/modules/configuration-audit/` | Reuses `operational_event.read`; Client/Building-isolated; read-only; configuration/version/action filters; currently not paginated and oldest first. |
| Asset history | Dedicated `asset_history_events` table and `src/modules/asset-history/` | `asset_history.read`; read-only, Building-isolated, paginated and newest first; its table is not the enterprise audit store. |
| Finding / Work Order / Vendor Work histories | Projections over `operational_events` in their domain history modules | Reuse domain permissions (`finding.read`, `work_order.read`, `vendor.read`); resource-resolved Building checks; mostly resource-specific and chronological. |
| Notification history | Read-only `UNION ALL` over in-app/email/WhatsApp delivery records | Recipient-self-scoped; no second audit engine; provider credentials and sensitive payloads excluded. |
| Integration delivery history | `integration_webhook_deliveries` read projection | `integration_webhook.read`; Client-isolated, paginated, newest first; state/attempt/status/error only, never payload or signing secret. |
| Evidence/document history | Evidence/document lifecycle and retention state plus BE-07 events | Existing document/evidence permissions and retention authority; binary purge retains governed tombstones and does not delete operational events. |

**Decision:** the canonical cross-domain enterprise business audit search is an
extension of `GET /operational-events`. Specialized resources keep their
existing read models and permissions. The authentication table is not unioned
into the operational table because it has a different schema and security
boundary; `/auth/audit-events` remains the authentication-history authority.

### 1.8 Scheduler and background execution

The repository already has one scheduler path:

- `src/modules/due-job-scheduler/` owns a singleton in-process
  `setInterval`, overlap prevention, bounded shutdown drain, and test disablement.
- `src/modules/due-job-dispatcher/` owns
  `processDueOperationalJobs`, with isolated domains for reminders,
  notification escalations, SLA clocks/escalations, outbound notification
  delivery, evidence retention, and CR-BE-INTEG-01 webhook fan-out/delivery.
- The integration CR deliberately reused this dispatcher and did not create a
  second timer, worker, queue, or broker.

**Decision:** use one execution context per dispatcher tick/run. At the start
of `processDueOperationalJobs`, generate one UUID, set `source = SCHEDULER`,
and run all domains under that context. This correlates due-job scheduler,
notification delivery, SLA processing, evidence retention, and webhook
execution without pretending an HTTP request or user initiated them. Their
`actor_user_id` remains `NULL` unless a real authenticated actor is explicitly
part of the operation (which is not the normal due-job case).

HTTP provider callbacks remain `source = HTTP` and use their actual request
ID; they do not inherit a scheduler run. A standalone trusted system call can
use `source = SYSTEM` and a generated execution context when traceability is
needed, or remain valid with a null request ID when no execution context exists.

---

## 2. Request correlation decision

### 2.1 One identifier and trust boundary

The canonical identifier is **`requestId`**:

```text
HTTP entry
  → server generates UUID with node:crypto randomUUID()
  → req.requestId
  → AsyncLocalStorage context.requestId
  → services / recordOperationalEvent
  → X-Request-ID response header
  → error.requestId when an error envelope is returned
  → request completion/error logs
```

The current middleware validates a caller-supplied `X-Request-ID` and currently
preserves a safe value. That prevents header/log injection but still permits a
caller to choose a colliding correlation label. For enterprise audit authority,
the canonical value must be server-generated: a caller-supplied header is
ignored for `req.requestId`, event persistence, logs, and error responses. It
must not be treated as actor, tenant, authorization, or idempotency authority.
Invalid input does not need to fail the request; the server simply generates a
new UUID. No second persisted `parentRequestId` is introduced in this CR.

This is a narrow hardening of the existing request-id seam, not a new tracing
platform. The existing focused request contract test that expects a safe
supplied value to be echoed will need to be adjusted in PART 01; no broad test
or CI run is justified here.

`request_id` is a nullable UUID database value, not a new foreign key. New
server-created and governed internal values are UUIDs. The separate
`authentication_audit_events.request_id` column remains textual, but both
surfaces use the same UUID string representation at the application boundary.
Null is valid for legacy rows and genuinely standalone system calls.

### 2.2 Propagation pattern

No service-wide parameter rewrite is approved. PART 01 should add a small
shared execution-context module, for example:

```text
ExecutionContext {
  requestId: string;
  source: HTTP | SCHEDULER | SYSTEM;
  actorUserId?: string;
}

runWithExecutionContext(context, callback)
getExecutionContext()
setExecutionActor(userId)
```

The request-id middleware calls `runWithExecutionContext` around `next()`.
Authentication middleware sets the resolved `req.auth.userId` in the current
store after session resolution. `recordOperationalEvent` reads the current
context only for correlation/source/actor defaults; explicit domain
`clientId`, `buildingId`, and `actorUserId` values remain authoritative and
continue to win. The helper must never read a raw header/body value directly.

The store must be request/run-local and replaced, not shared mutable module
state. `AsyncLocalStorage.run(...)` must cover awaited service work and any
intentional detached callback must explicitly create or receive a new trusted
execution context.

### 2.3 Response and error behavior

- `X-Request-ID` is returned on successful and error HTTP responses, including
  404 and provider callback responses, after the entry middleware has run.
- `error.requestId` remains the additive body field already implemented by
  `sendAppError`/`sendError`. It is the same value as the response header.
- No request ID is added to success bodies by default; the header is the
  reusable transport contract. Existing response envelopes remain unchanged.
- The request ID is safe diagnostic metadata only. It must not be accepted as
  an authorization, tenant selector, event payload, or idempotency key.

---

## 3. Small additive operational-event correlation model

### 3.1 Fields

The future schema extension is deliberately limited to:

| Field | New/old | Decision |
|---|---|---|
| `client_id` | Existing | Keep mandatory; current event/business context authority. |
| `building_id` | Existing | Keep nullable; null means a Client-level event, subject to existing isolation rules. |
| `actor_user_id` | Existing | Keep nullable; populated from a real user actor, null for system/scheduler work. |
| `vendor_work_id` | Existing additive field | Keep and reuse; no duplicate Vendor Work link. |
| `request_id` | **New nullable `UUID`** | Server request UUID for HTTP, scheduler-run UUID for `SCHEDULER`, optional trusted execution UUID for `SYSTEM`; legacy rows remain null. |
| `source` | **New nullable `TEXT`** | New rows use `HTTP`, `SCHEDULER`, or `SYSTEM`; legacy rows remain null. Add an application/DB check for this vocabulary without rewriting old rows. |
| event/entity/summary/metadata/timestamps | Existing | Keep existing business meaning and the central write boundary. |

Do not add `user`, `session_id`, IP, user-agent, selected-context, or a second
correlation column. Authentication-specific session/IP/user-agent data remains
in `authentication_audit_events`; integration payloads remain linked by the
existing operational event ID and outbox reference.

### 3.2 Write behavior

The future helper behavior is:

1. Resolve `requestId` and `source` from the trusted execution context.
2. Resolve actor fallback from the authenticated context only when the current
   event call did not already provide an authoritative actor.
3. Scrub and bound metadata once at the shared event write boundary.
4. Insert the operational event using the caller's existing executor.
5. Call the existing CR-BE-INTEG-01 outbox enqueue seam on that same executor.

Existing calls such as `recordOperationalEvent({ clientId, buildingId,
entityType, entityId, eventType, actorUserId, summary, metadata }, tx)` remain
valid. No caller needs to pass a request ID. The two raw operational writers
must be brought behind the same internal write boundary so they do not silently
lose correlation, scrubbing, or the integration-outbox contract.

No generic Express middleware should emit an audit event for a route. Domain
services remain responsible for the exact business fact, which prevents a
single mutation from producing both a route-level event and a domain event.

### 3.3 Transaction rule

When a domain already uses `withTransaction`, the new columns, business state,
operational event, and any eligible outbox row commit or roll back together.
When a legacy caller uses the pool default, its event remains valid and gets
request/run context, but the existing partial-write risk remains documented;
this CR does not silently redesign every transaction boundary.

---

## 4. Enterprise audit boundary

### 4.1 Facts that must be auditable

The authoritative command/service for each category must emit one meaningful
operational fact (or use the existing authentication audit authority), normally
inside the same transaction as the state change:

| Category | Required audit facts | Existing evidence/authority to reuse |
|---|---|---|
| Configuration changes | Draft/create/update, validation result, publish/activate/supersede, preview governance; include prior/new status or version IDs, not configuration secrets. | `configuration-audit` projection and `recordConfigurationAuditEvent`; BE-27 event vocabulary. |
| Lifecycle/status changes | Creation where it establishes a governed record, status transitions, assignment/reassignment, cancellation/finalization/closure, and other material lifecycle decisions. | Existing domain `recordOperationalEvent` calls and resource history projections. |
| Approvals/rejections | Submission, approval, rejection, verification, rework, and closure decisions, including actor and target identity. | Permit, document, finding, Vendor Work, utility, procurement, review, and sign-off authorities. |
| Security-sensitive actions | Login/session/account events, permission/role/security-key/lost-found and other security decisions. | `authentication_audit_events` for authentication; existing security operational events for domain facts. Do not duplicate login events into `operational_events` merely for unification. |
| Provider/integration actions | Endpoint create/update/status/secret rotation, webhook queued/delivered/retry/permanent failure/exhausted, notification provider outcomes, and verified provider callback outcomes. | CR-BE-INTEG-01 `INTEGRATION_*` and CR-BE-NOTIFY-PROV-01 provider events; existing recursion blocklist stays in force. |
| Automated scheduler actions | SLA breach/escalation, notification delivery attempts/results, evidence retention due/held/purged/failed, webhook fan-out/delivery, and other due-job state transitions. | Existing dispatcher domains and their `recordOperationalEvent` calls, correlated by one scheduler run ID. |
| Evidence/document governance | Evidence upload/removal/integrity/retention/hold/purge facts; document version/approval/archive/restore/expiry facts; no file bytes or raw payloads. | BE-07 Evidence, document-control retention/tombstone, integrity, and document approval authorities. |

The event should record the decision and references needed to explain it:
entity type/id, Client/Building context, actor if real, source, request/run ID,
small bounded metadata, and a safe summary. It should not copy an entire
aggregate or file/provider payload.

### 4.2 Facts that are not automatically auditable

- Ordinary GET/list/detail reads, health checks, `/auth/me`, pagination, and
  generic reporting reads are not audit events by default.
- Request logging remains observability, not durable audit history.
- A route-level success/failure event is not added when the domain already
  records the state transition or provider outcome.
- Authentication reads stay governed by `auth.audit.read` only where the
  existing authentication audit domain defines them; no blanket HTTP read audit
  is introduced.

---

## 5. Immutability and write boundary

Inspection found no runtime `UPDATE operational_events`, `DELETE FROM
operational_events`, or normal event update/delete route. Existing operational,
asset-history, configuration-audit, Work Order, Finding, Vendor Work, and
integration history routes are read-only. `operational_events` has no
`updated_at` column, and the shared helper documents append-only behavior.

The current guarantee is an application/runtime guarantee, not a database-role
or trigger guarantee: a privileged SQL operator could still mutate a table.
That is outside this CR and must not be disguised as cryptographic integrity.

Governance rules:

1. `recordOperationalEvent` is internal; no user supplies event type/entity/
   actor/metadata through a generic audit POST.
2. No normal PATCH/PUT/DELETE event API and no manual event injection.
3. Existing delivery/outbox status updates are delivery lifecycle mutations,
   not edits to the audit event row.
4. No audit payload editing through configuration, webhook, or history APIs.
5. Retention/deletion of `operational_events` is deferred unless a separate
   retention authority is approved. Evidence retention does not authorize
   deleting operational events.
6. No blockchain, hash chain, signing, notarization, or other integrity scheme
   is introduced.

User lifecycle currently uses deactivate/suspend/reactivate rather than a
normal user-delete route. The existing operational-event actor FK deletion
policy is not a separately governed audit retention policy; actor deletion or
an eventual account-erasure requirement remains an explicit risk (see §10).

---

## 6. Background/system correlation model

| Work | Correlation | Actor | Source |
|---|---|---|---|
| Due-job scheduler tick | One UUID generated at tick/run start and shared through the dispatcher pass; stored in each resulting event's `request_id`. | `NULL` unless a real actor is explicitly in scope. | `SCHEDULER` |
| Notification delivery | Same scheduler run ID for reminder/escalation/outbound delivery events; provider attempt details stay bounded. | Normally `NULL`. | `SCHEDULER` (HTTP callback outcomes use HTTP). |
| SLA processing | Same run ID for breach and escalation materialization/delivery; existing per-clock transactions stay authoritative. | `NULL`. | `SCHEDULER` |
| Evidence retention | Same run ID for due/hold/purge/failure events; evidence storage/tombstone authority is unchanged. | `NULL`. | `SCHEDULER` |
| Webhook fan-out/delivery | Same run ID for `INTEGRATION_WEBHOOK_*`; existing outbox/delivery IDs remain entity/idempotency identity. | `NULL`. | `SCHEDULER` |
| Provider callback | Actual HTTP request ID from the entry middleware; no fabricated user/session. | `NULL` unless the callback is authenticated as a real user, which is not the current callback model. | `HTTP` |
| Non-request system command | Trusted explicit execution context when traceability is needed; otherwise valid with no request ID. | `NULL`. | `SYSTEM` |

One scheduler run is intentionally a correlation group, not a claim/ownership
key. `FOR UPDATE SKIP LOCKED`, guarded claims, idempotency constraints, and
per-domain transaction boundaries remain the existing job authorities. A future
multi-process scheduler will give each process/run its own UUID; no global
counter or fake initiating User is needed.

---

## 7. Enterprise audit read/search API decision

### 7.1 Canonical surface

Use the existing paths:

```text
GET /api/v1/operational-events
GET /api/v1/operational-events/:id
```

The list path is the enterprise operational audit search surface. The detail
path remains a read-only event lookup under the same isolation predicate. No
`/audit-events` table or manual audit query API is added.

Required list filters:

- `clientId` — explicit accessible Client filter;
- `buildingId` — explicit accessible Building filter;
- `actorUserId` — exact nullable/non-null actor filter;
- `eventType`;
- `entityType`;
- `entityId`;
- `requestId` — exact request/scheduler-run correlation filter;
- `from` and `to` — inclusive `occurred_at` range.

Validation must reject malformed UUID/date values and an out-of-scope
Client/Building filter without revealing inaccessible resource existence.
The caller's requested filters are always intersected with the resolved
accessible scope; a filter can never widen it.

### 7.2 Ordering and pagination

The enterprise surface must always be bounded and return newest first:

```sql
ORDER BY occurred_at DESC, id DESC
LIMIT pageSize OFFSET (page - 1) * pageSize
```

Use the existing `page`/`pageSize` and `buildPaginationMeta` conventions with a
bounded default (50) and existing maximum (200). If old clients omit paging,
resolve the default page rather than returning an unbounded estate-wide list;
this is a safety bound and an additive `meta` improvement. Specialized history
routes retain their current domain-specific ordering/shape unless separately
governed.

The response includes `meta.page`, `meta.pageSize`, `meta.total`, and
`meta.totalPages`. Add indexes only as justified by the query plan, likely
covering request/source and the existing Client/Building/event/entity/time
access patterns. Do not expose `SELECT *` as a public projection.

### 7.3 Safe event schema

The future public `OperationalEvent` projection is:

```text
id: UUID
clientId: UUID
buildingId: UUID | null
actorUserId: UUID | null
requestId: UUID-compatible string | null
source: HTTP | SCHEDULER | SYSTEM | null   # null only for historical/standalone rows
eventType: string
entityType: string
entityId: UUID
summary: bounded string
metadata: bounded, scrubbed object
occurredAt: date-time
createdAt: date-time
```

`sessionId`, IP, user-agent, endpoint signing secrets, outbox `payload`, raw
provider response bodies, and deleted/scrubbed metadata do not appear in this
projection. The existing `/auth/audit-events` schema remains separate and
continues to expose only its already-governed authentication fields.

---

## 8. RBAC and Client/Building isolation decision

The existing semantic permission for the enterprise operational event list is
`operational_event.read`, seeded in
`src/database/seeds/foundation-access.seed.ts` and already used by the generic
operational-event and configuration-audit routes. It is a better fit than
`auth.audit.read` (authentication-only) or any domain-specific read permission.

Rules for the future search implementation:

1. Authenticate first, then run `requirePermission('operational_event.read')`.
2. Resolve accessible Building and Client IDs through
   `contextAccessService`; never query assignments independently.
3. Apply the scope predicate in SQL before pagination/counting:
   - Building event: `building_id` must be in accessible Buildings;
   - Client-level event: `building_id IS NULL` and `client_id` must be an
     accessible Client.
4. An explicit `clientId` outside the accessible Client set or `buildingId`
   outside the accessible Building set is denied with the existing controlled
   access error; it is not used as a scope bypass.
5. Detail reads use the same resolved event context before returning the row.
6. Permission alone never grants cross-Client or sibling-Building visibility.

`auth.audit.read` remains the authority for `GET /auth/audit-events`, whose
records do not carry the operational Client/Building model. Asset,
configuration, Finding, Work Order, Vendor Work, notification, integration, and
utility history routes retain their existing semantically correct permissions
and isolation checks. No new generic audit permission is justified at START.

---

## 9. OpenAPI and response-correlation decision

The START baseline already had `ErrorEnvelope.error.requestId`, runtime
`X-Request-ID`, and the existing operational-event path, but lacked a reusable
response-header component and the final audit filter/pagination/event-field
contract. PART 05 now adds:

1. `components/headers/RequestId` with a server-generated UUID description;
2. reusable `X-Request-ID` references on common error responses and explicit
   references on the audit list/detail success responses;
3. the cross-cutting response-header/error-body equality rule in the API
   description;
4. the runtime-aligned operational audit filters and always-bounded page/
   pageSize pagination;
5. `OperationalEvent.requestId` and `.source` with nullable historical
   semantics and the governed source enum;
6. the newest-first, safe metadata projection and no-write audit boundary.

The reusable component does not make the header optional at runtime: every
response after HTTP entry carries it. The focused PART 05 contract test covers
the OpenAPI component, common error responses, audit list/detail schema, and
runtime/source alignment. No broad OpenAPI rewrite was made.

---

## 10. Risks and gaps recorded

| Risk/gap | Current evidence / consequence | Mitigation or disposition |
|---|---|---|
| Lost context across async boundaries | PART 01 now has `AsyncLocalStorage`, but detached timers/callbacks can still run outside the originating request store. | Use `AsyncLocalStorage.run` per request/run, pass explicit trusted context to intentional detached work, and add focused propagation tests. |
| Cross-request context leakage | A module-global mutable context would attach one request's actor/ID to another. | PART 01 uses request-local immutable stores; retain concurrent isolation tests and never add global current-context state. |
| Scheduler correlation | The scheduler remains an in-process singleton; a run context must not become a claim/ownership key or leak across overlapping async work. | PART 03 generates one UUID per full dispatcher tick/run, source `SCHEDULER`, actor null; existing claim/transaction authorities remain unchanged. |
| Duplicate audit events | Route middleware or generic command hooks could duplicate already-correct domain/provider events. | Keep audit emission in domain authorities; do not emit route-level audit events; use existing integration recursion blocklist and idempotent delivery identities. |
| Sensitive metadata leakage | BE-07 scrubbing is shallow/unbounded; raw writers and authentication metadata have different controls; outbox snapshots reuse event metadata. | Centralize at the existing operational-event boundary, reuse bounded history sanitizer behavior, provider-sanitize errors, cap size, and use secret-free read projections. |
| Oversized metadata | JSONB has no event-level application size budget; large metadata increases rows, outbox payloads, indexes, and responses. | Enforce bounded depth/keys/strings/serialized size; never include aggregate bodies, files, raw responses, or payload dumps. |
| Cross-tenant audit reads | The START route had a scope predicate, but requested Client/Building filters were not explicit and detail used a broad `SELECT *` before scope. | PART 04 applies the accessible Client/Building intersection in SQL for list/count/detail, validates explicit scope filters, and uses an explicit safe projection. |
| Actor deletion/history | `operational_events.actor_user_id` is nullable but its existing FK deletion behavior is not a dedicated audit policy; user lifecycle currently avoids normal deletion. | Keep actor nullable and event fact independent of a live user display; govern any future deletion/erasure separately. Do not add a synthetic actor or backfill. |
| Performance and index growth | The table is already cross-domain and high-volume; new request/source filters and newest-first pagination add access patterns. | Add only justified indexes, bound page size/date windows, use keyset pagination if offset becomes a measured bottleneck, and monitor growth. Retention remains deferred. |
| Correlation spoofing | The START implementation accepted a syntactically safe caller ID, allowing deliberate collision even though injection was blocked. | PART 01 now generates the canonical ID and ignores the caller header; retain the header response contract and treat IDs as diagnostics, not security. |
| Historical events without request IDs | All existing `operational_events` rows predate this field; authentication and specialized histories have different coverage. | PART 02 leaves both new columns nullable; expose null honestly; no historical replay/backfill or fabricated source. |
| Direct event writers | Work Order history and Tenant Communication had raw operational inserts that could miss context, common scrub, and the outbox seam. | PART 02 routes both through the shared writer. Repository-level compatibility methods remain only to preserve existing callers; no raw insert remains. |
| Transaction partial writes | Pool-default event calls can leave business/event/outbox writes at separate autocommit boundaries. | Preserve executor support, require same-transaction writes for new critical transitions, and leave a targeted legacy sweep for later. |
| Provider error/payload leakage | Provider callbacks and delivery ledgers carry errors/statuses; integration payloads are intentionally byte-stable. | Keep controlled provider error strings, never response bodies/headers/secrets, and keep audit reads away from outbox payload text. |
| CI/KI-003 | Existing CR-BE-CI-01/KI-003 test assertion drift remains deferred. | Do not reopen or alter CI/KI-003 in this CR. Only focused PART tests and contract checks are appropriate later. |

---

## 11. Small PART breakdown

The requested five-part decomposition is retained because it separates the
context seam, persistence extension, non-HTTP execution, read contract, and
closure without creating a large rewrite.

### PART 01 — Request Context + Correlation Foundation

- Harden the existing request-id entry middleware to issue one server UUID;
  preserve `req.requestId`, response header, error body, and logging seams.
- Place the entry boundary before middleware that can fail without an ID.
- Add the minimal `AsyncLocalStorage` execution context and authenticated actor
  enrichment.
- Add focused tests for success/error/header equality, generated-only IDs,
  async propagation, and cross-request isolation.
- Do not add database fields or audit search in this part.

### PART 02 — Operational Event Correlation Extension

- Add nullable `request_id` and `source` to `operational_events` with additive
  indexes/constraints only.
- Make `recordOperationalEvent` read the trusted execution context while
  preserving every existing input/call site and executor argument.
- Reuse the existing bounded history-sanitization behavior at the operational
  event boundary and route the two raw writers through it.
- Keep the CR-BE-INTEG-01 same-executor outbox seam and recursion behavior.
- No historical event backfill and no new audit table/API.

### PART 03 — Background/System Correlation

- Wrap one `processDueOperationalJobs` run in one generated
  `SCHEDULER` execution context.
- Verify correlation/source/actor behavior for due jobs, notification delivery,
  SLA processing, evidence retention, and webhook delivery, including provider
  callbacks as a separate HTTP case.
- Preserve existing scheduler singleton, bounded execution, claim guards,
  per-domain isolation, and transaction boundaries.
- Do not create a second scheduler, fake HTTP request, or synthetic user.

### PART 04 — Enterprise Audit Read/Search API

- Extend existing `GET /operational-events` list/detail projections with the
  required filters, bounded pagination, newest-first ordering, `requestId`, and
  `source`.
- Enforce SQL-level Client/Building isolation and `operational_event.read`.
- Keep authentication and specialized history read models intact; do not expose
  scrubbed metadata, outbox payloads, secrets, or raw provider data.
- Add focused isolation, filter, pagination, ordering, and privacy tests.

### PART 05 — OpenAPI + Cross-Module Validation + Governance Closure

- Add the reusable response-header component and audit/event schema/filter
  contract to `docs/api/openapi.yaml`.
- Validate route/RBAC/read-model alignment, provider/integration event coverage,
  scheduler source behavior, direct-writer inventory, transaction/executor
  behavior, metadata bounds, and no-write audit surfaces.
- Run only focused validation for the CR; leave CI/KI-003 deferred.
- Close the CR only after the additive/no-backfill/no-duplicate/no-secret
  boundaries are evidenced.

---

## 12. PART 01 readiness

**PART 01 result: IMPLEMENTED and validated.** The required seams already
existed: `requestIdMiddleware`, `req.requestId`, `X-Request-ID`,
`error.requestId`, `requestLogger`, `req.auth`, the session resolver, and the
shared event helper. PART 01 made the canonical ID server-generated rather than
echoing a caller-selected value and added the request-local context authority.
Operational-event schema and scheduler/system correlation were completed in
PART 02–03; enterprise audit search remains reserved for PART 04.

---

## 13. START GOVERNANCE closure boundary

The START baseline and its authority decisions remain unchanged. PART 01–05
are now implemented and the governance closure is recorded below. No further
runtime capability, unrelated cross-module work, broad regression, or CI is
included; do not reopen CI/KI-003, create a PR, or merge.

## 14. PART 01 implementation notes

**Status:** PART 01 implementation complete; later parts were implemented in
subsequent sections.

### Implementation

- Added `src/shared/request-context.ts` as the minimal
  `AsyncLocalStorage<RequestContext>` authority. It exposes
  `runWithRequestContext`, `getRequestContext`, and `getRequestId`; outside an
  HTTP context it returns `undefined` without throwing. PART 01 established
  `source: HTTP`; PART 03 added the governed scheduler/system helpers without
  changing the HTTP authority.
- Updated `src/middleware/request-id.ts` to generate a fresh `randomUUID()` for
  every request. The optional legacy argument to `resolveRequestId` is ignored,
  so a caller-supplied `X-Request-ID` cannot replace the server authority.
- The request-id middleware now runs before security/CORS middleware and wraps
  the downstream Express lifecycle in the request-local context. It continues
  to attach `req.requestId` and set `X-Request-ID`.
- Existing centralized error handling remains unchanged in shape. Because the
  request ID is established at entry, handled 4xx/5xx responses carry
  `error.requestId` equal to the response header.
- Added focused coverage for UUID generation, response/error correlation,
  caller-ID rejection, async retention, concurrent isolation, and safe
  outside-request behavior.

### Scope guard

No `operational_events` schema or write behavior was changed. No scheduler or
background execution path was changed. No OpenAPI file was changed. No
service signatures or existing operational-event call sites were changed.

### Validation

- `npm run typecheck` — PASS.
- Focused HTTP/context/error/security tests — **17/17 PASS**:
  `tests/request.test.ts`, `tests/request-context.test.ts`,
  `tests/app.test.ts`, `tests/error-contract.test.ts`, and
  `tests/security.test.ts`.
- `git diff --check` — PASS.
- Broad regression and CI were not run; CI/KI-003 remains deferred.

## 15. PART 02 implementation notes

**Status:** PART 02 implementation complete; later parts are documented below.

### Migration and persistence

- Added `src/database/migrations/0309_add_operational_event_correlation.ts`.
  It adds nullable `operational_events.request_id UUID` and nullable `source`
  with the `HTTP` / `SCHEDULER` / `SYSTEM` check constraint.
- Added only the partial exact-lookup index
  `operational_events_request_id_idx` on non-null `request_id`. Existing
  Client/Building/entity indexes remain unchanged; no low-cardinality `source`
  index was added.
- Registered migration `0309` at the end of the existing ordered migration
  list. Historical rows are untouched and remain `request_id = NULL,
  source = NULL`.

### Correlation and writer behavior

- Extended `OperationalEventRecord` and the generic operational-event public
  mapper with additive `requestId` and `source` fields.
- `recordOperationalEvent(...)` now reads the PART 01 AsyncLocalStorage
  context centrally and persists the authoritative HTTP request UUID and
  `source = HTTP`, without changing existing callers or requiring new input
  fields.
- Added a third, internal-use correlation argument restricted to validated
  UUIDs with `SCHEDULER` or `SYSTEM` sources. When an HTTP context exists it is
  ignored, so neither a caller header nor an internal override can replace the
  authoritative HTTP ID. No scheduler lifecycle was added.
- Preserved the caller executor, transaction behavior, metadata scrub, actor/
  Client/Building/entity semantics, append-only behavior, and existing
  integration-outbox enqueue seam.
- Reconciled the two START-baseline raw event writers. Work Order history now
  uses the shared writer with an optional executor; Tenant Communication keeps
  its repository-level compatibility method but delegates to the shared
  writer. No raw `INSERT INTO operational_events` remains outside the shared
  authority, and neither adapter creates duplicate events.

### Scope guard

No scheduler/system correlation lifecycle was implemented. No enterprise audit
search/filter expansion or OpenAPI closure was implemented. No historical event
backfill or synthetic correlation ID was performed. No broad refactoring was
made.

### Validation

- `npm run typecheck` — PASS.
- `tests/operational-event-correlation.test.ts` — **10/10 PASS** with embedded
  PostgreSQL.
- `tests/integration-outbox.test.ts` — **15/15 PASS** with embedded PostgreSQL.
- PART 01 and directly affected HTTP/error/security tests — **17/17 PASS**:
  `tests/request.test.ts`, `tests/request-context.test.ts`,
  `tests/app.test.ts`, `tests/error-contract.test.ts`, and
  `tests/security.test.ts`.
- `git diff --check` — PASS.
- Broad regression and CI were not run; CI/KI-003 remains deferred.

**Files changed by PART 02:**
`src/database/migrations/0309_add_operational_event_correlation.ts`,
`src/database/migrations/index.ts`, `src/modules/operational-events/index.ts`,
`src/modules/operational-events/operational-event.routes.ts`,
`src/modules/work-order-history/work-order-history.repository.ts`,
`src/modules/tenant-communications/tenant-communication.repository.ts`,
`tests/operational-event-correlation.test.ts`, and this governance document.

## 16. PART 03 implementation notes

**Status:** PART 03 implementation complete; later parts are documented below.

### Correlation lifecycle

- Extended `src/shared/request-context.ts` with the governed
  `SCHEDULER`/`SYSTEM` sources and server-generated UUID helpers:
  `runWithSchedulerContext` and `runWithSystemContext`.
- Existing HTTP context takes precedence. Nested scheduler work reuses the
  active scheduler context, system work preserves an active context, and
  separate top-level runs receive distinct UUIDs. No process-global context was
  introduced.
- Wrapped the complete `processDueOperationalJobs(...)` execution in one
  `runWithSchedulerContext` boundary. All events created by that dispatcher pass
  therefore share one request/correlation UUID and `source = SCHEDULER`.
- Scheduler/system helpers do not create or infer an actor. Existing scheduler
  event calls continue to persist `actor_user_id = NULL`.

### Scope guard

No new scheduler, timer, queue, dispatcher domain, ordering, retry behavior,
idempotency behavior, audit search/filter API, or OpenAPI change was added.
The existing due-job scheduler and dispatcher result contract are unchanged.

### Validation

- `npm run typecheck` — PASS.
- `tests/background-correlation.test.ts` — **5/5 PASS** with embedded
  PostgreSQL.
- Directly affected dispatcher behavior — **10/10 PASS**:
  `tests/cr-be-stab-01-due-job-dispatcher.test.ts` with embedded PostgreSQL.
- Directly affected scheduler lifecycle — **15/15 PASS**:
  `tests/cr-be-stab-01-due-job-scheduler.test.ts`.
- PART 02 operational-event correlation tests — **10/10 PASS** with embedded
  PostgreSQL.
- `git diff --check` — PASS.
- Broad regression and CI were not run; CI/KI-003 remains deferred.

**Files changed by PART 03:**
`src/shared/request-context.ts`,
`src/modules/due-job-dispatcher/due-job-dispatcher.service.ts`,
`tests/background-correlation.test.ts`, and this governance document.

## 17. PART 04 implementation notes

**Status:** PART 04 implementation complete; later parts are documented below.

### Read/search behavior

- Extended the existing `GET /api/v1/operational-events` list/detail surface;
  no second audit store or route was added.
- List filters now cover `clientId`, `buildingId`, `actorUserId`, `eventType`,
  `entityType`, `entityId`, `requestId`, `source`, and inclusive `from`/`to`
  date-time bounds.
- Pagination is always bounded with the existing `page`/`pageSize` convention,
  defaulting to 50 and capped at 200. Responses include the existing
  `page`/`pageSize`/`total`/`totalPages` metadata.
- Results are newest first using `occurred_at DESC, id DESC`.
- The projection is explicit and additive: `requestId` and `source` are
  included alongside the existing event fields. Metadata is passed through the
  existing bounded/sensitive-key history sanitizer; no outbox payload, secret,
  or raw provider data is exposed.

### Isolation and permission behavior

- `operational_event.read` remains the only permission required after
  authentication.
- List/count queries apply the resolved `contextAccessService` accessible
  Building/Client predicate in SQL before pagination.
- Explicit Client/Building filters outside the caller's scope return the
  existing controlled access error.
- Detail reads apply the same scope predicate in SQL and treat inaccessible
  rows as not found at this enterprise boundary.
- No POST/PATCH/PUT/DELETE event route or manual event injection was added.

### Scope guard

No scheduler behavior, operational-event write behavior, migration, OpenAPI
closure, new permission, or historical backfill was added in PART 04.

### Validation

- `npm run typecheck` — PASS.
- `tests/operational-event-audit-read.test.ts` — **7/7 PASS** with embedded
  PostgreSQL.
- Existing filtered legacy operational-scope route test was attempted with
  `--test-name-pattern='scopes operational events'` but skipped because the
  local PostgreSQL test database was unavailable; the new focused route suite
  covered the same isolation behavior against embedded PostgreSQL.
- `git diff --check` — PASS.
- Broad regression and CI were not run; CI/KI-003 remains deferred.

**Files changed by PART 04:**
`src/modules/operational-events/operational-event.routes.ts`,
`tests/operational-event-audit-read.test.ts`, and this governance document.

## 18. PART 05 implementation notes and governance closure

**Status:** PART 05 implemented. CR-BE-AUDIT-01 is closed for FINAL REVIEW.

### OpenAPI changes

- Added reusable `components.headers.RequestId` documenting the server-generated
  UUID `X-Request-ID` response header.
- Documented that `error.requestId` is the same UUID as `X-Request-ID` and added
  the reusable header reference to common error responses.
- Updated the existing operational-event list/detail paths with the runtime
  permission, Client/Building scope, all audit filters, bounded pagination,
  newest-first behavior, and response-header references.
- Added `OperationalEventSource` (`HTTP`, `SCHEDULER`, `SYSTEM`) and additive
  nullable `OperationalEvent.requestId`/`source` fields. The schema describes
  historical nulls and the scrubbed metadata boundary.
- Reused the existing pagination shape rather than rewriting unrelated
  operations; no runtime capability or unrelated OpenAPI operation was added.

### Cross-module validation and closure

- `tests/audit-part05-openapi.test.ts` verifies YAML parsing, reusable header
  references, error/request correlation documentation, audit filters/pagination,
  event schema, RBAC, and runtime authority alignment.
- Focused HTTP correlation/error validation passed; operational persistence,
  scheduler/system correlation, audit read/search, and integration-outbox
  preservation all passed in their directly affected focused suites.
- Runtime and OpenAPI are aligned for the implemented surface. There is no
  audit mutation API, event injection, historical backfill, retention/deletion
  policy, new permission, or CI/KI-003 change.
- Governance closure preserves `operational_events` as the business-event
  authority, the existing outbox/scheduler/transaction authorities, the
  append-only boundary, Client/Building isolation, and sensitive-data rules.

### Validation

- `npm run typecheck` — PASS.
- PART 05 OpenAPI/cross-module test — **4/4 PASS**:
  `tests/audit-part05-openapi.test.ts`.
- HTTP/request/error/security tests — **16/16 PASS**.
- PART 02 operational-event correlation tests — **10/10 PASS**.
- PART 03 scheduler/system correlation tests — **5/5 PASS**.
- PART 04 audit read/search tests — **7/7 PASS**.
- CR-BE-INTEG-01 integration-outbox preservation tests — **15/15 PASS**.
- `git diff --check` — PASS.
- No broad regression or CI run; CI/KI-003 remains deferred.

**Files changed by PART 05:**
`docs/api/openapi.yaml`, `tests/audit-part05-openapi.test.ts`, and this
governance document.

## 19. FINAL REVIEW readiness

**READY.** PART 01–05 are implemented on the current Arena branch and the
correlation/audit governance is closed for FINAL REVIEW. No PR was opened and
no merge was performed. Further work is out of scope for this CR.
