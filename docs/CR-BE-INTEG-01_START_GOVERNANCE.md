# CR-BE-INTEG-01 — START GOVERNANCE

**Title:** Outbox + Webhook + Retry/Signature
**Repository:** `asentra-backend`
**Branch:** `arena/01a02db2-asentra-backend` (from `main` @ `59a156abcd1dbf8f3999ebd86089029543308337`, post CR-BE-DOC-CONTROL-01 merge)
**Inspection date:** 2026-08-23
**Status:** PART 01–06 implemented — **CR CLOSED** (see §16–§17). §0–§15 record the START GOVERNANCE decisions;
§16 records per-PART implementation notes; §17 records governance closure.

---

## 0. Decision summary

Asentra already owns every hard part of an outbound integration platform: an append-only, Client/Building-scoped
business-event authority (`operational_events`, BE-07), a transaction seam that lets events commit atomically with
business writes (`recordOperationalEvent(input, executor)` + `withTransaction`), a proven claimable outbound
delivery ledger with `FOR UPDATE SKIP LOCKED`, guarded claim-before-send, idempotent creation, and bounded
exponential-backoff retry (CR-BE-NOTIFY-PROV-01), a shared provider-result taxonomy, a due-job dispatcher +
in-process scheduler (CR-BE-STAB-01), HMAC-SHA256 + `timingSafeEqual` webhook signature utilities
(`whatsapp-callback.verify`), and a bounded-timeout HTTP adapter pattern (`meta-whatsapp-adapter`).

This CR therefore adds only three small new authorities — a thin **integration outbox** keyed to
`operational_events`, a Client-scoped **webhook endpoint registry** (URL + subscriptions + write-only signing
secret), and a per-endpoint **webhook delivery ledger** cloned from the proven notification-ledger shape — plus an
HMAC delivery adapter and additive dispatcher wiring. No second business-event authority, no new scheduler, no
queue/broker, no asymmetric PKI, no manual event injection API, and no historical replay/backfill.

---

## 1. Existing authority map (reuse — do NOT rebuild)

| Concern | Existing authority | Location / evidence | Reuse decision |
|---|---|---|---|
| Domain/operational events | BE-07 `operational_events` (migration `0080`; `client_id` NOT NULL, `event_type`, `entity_type`/`entity_id`, nullable `building_id`, `metadata` JSONB scrubbed of sensitive keys, `occurred_at`/`created_at`, append-only) | `src/modules/operational-events/index.ts`, `src/database/migrations/0080_create_operational_events.ts` | **Source of truth for what happened.** ~95 modules call `recordOperationalEvent`. Not duplicated. |
| Transaction handling | `withTransaction(work)` + the `executor` parameter of `recordOperationalEvent` (domains pass their open `PoolClient`, so the event commits atomically with the business write) | `src/database/transaction.ts`, `src/modules/operational-events/index.ts` | Outbox enqueue rides the **same executor** — the textbook transactional-outbox seam already exists. |
| Retry / claim / idempotency | `notification_outbound_deliveries` ledger: insert-on-conflict-return idempotent creation, bounded due enumeration with `FOR UPDATE SKIP LOCKED`, guarded claim `PENDING/RETRY_SCHEDULED → SENDING`, guarded result seams, `attempt_count`/`max_attempts`/`next_retry_at`, exponential backoff + jitter constants | `src/modules/notification-outbound-deliveries/outbound-delivery.repository.ts`, `src/modules/notification-delivery/outbound-delivery-execution.service.ts` | **Pattern authority.** The webhook delivery ledger clones this shape (separate table; §4). |
| Response classification | Shared provider-result taxonomy `ACCEPTED / REJECTED_RETRYABLE / REJECTED_PERMANENT / ERROR_UNKNOWN` | `src/shared/provider-result.ts` | Reused verbatim; the HTTP adapter maps status codes onto it (§6.4). |
| Scheduler | Due-job dispatcher (`processDueOperationalJobs`, per-domain isolation, additive result keys) + in-process scheduler with drain-bounded shutdown | `src/modules/due-job-dispatcher/`, `src/modules/due-job-scheduler/` | **Only scheduler.** One additive dispatcher domain (§8). No cron/queue/timer infra. |
| Webhook security / HMAC | HMAC-SHA256 over raw bytes + constant-time compare (inbound Meta verification); module-local secret config boundary that never enters `env.ts`/`AppConfig` | `src/modules/whatsapp-callback/whatsapp-callback.verify.ts`, `whatsapp-callback.config.ts` | Same primitives (`node:crypto` `createHmac`/`timingSafeEqual`) for outbound signing; same "secret never leaves the module except as an HMAC key" discipline. |
| Outbound HTTP transport | `fetch` + `AbortController` bounded timeout (20 s default), injectable transport for tests, sanitized error strings | `src/modules/whatsapp-delivery/meta-whatsapp-adapter.ts` | Transport + sanitization pattern for the webhook adapter. |
| Event→subscription matching | BE-26D `notification_event_subscriptions` (event_type + optional client/building scope + ACTIVE/INACTIVE, declarative, reactive-only) | migration `0239`, `src/modules/notification-subscriptions/` | **Pattern authority** for endpoint event subscriptions (not reused as storage — it binds events to notification templates, a different concern). |
| Audit | `recordOperationalEvent` + BE-07 sensitive-key scrubbing + `operational_event.read` API | `src/modules/operational-events/` | All webhook lifecycle audit uses this (§9). |
| Integration configuration / RBAC | Full permission catalogue inspected (`src/database/seeds/foundation-access.seed.ts`): `client_configuration.*` (BE-27A key-value registry), `notification_subscription.*` (BE-26D), no `integration_*`/webhook code exists | seed file, module routes | No existing code covers external endpoint + secret administration → one new pair (§10). |
| Client/Building isolation | `contextAccessService.getAccessibleClientIds/BuildingIds` route guards; `client_id` mandatory on ledgers | `src/modules/context-access/`, `operational-event.routes.ts` | Reused verbatim on all new read/config routes. |
| OpenAPI | Single contract file | `docs/api/openapi.yaml` (~41 k lines) | Extended additively in PART 06. |
| Secret-at-rest precedent | Secure links store only a token hash; provider credentials live in env, read at module boundary | `src/modules/notification-secure-links/`, `whatsapp-callback.config.ts` | Informs §3.3 (HMAC secrets cannot be one-way hashed; write-only column instead). |

**Explicitly NOT reused as storage:** `notification_outbound_deliveries` (its lifecycle, channels, feedback columns
and idempotency identity are notification-specific; overloading it with a `WEBHOOK` channel would entangle two
lifecycles and two RBAC surfaces). The webhook ledger is a new table with the same proven shape.

---

## 2. Transactional Outbox — decision

### 2.1 Source of truth

`operational_events` **remains the single business-event authority**. The outbox is NOT a second event store: it is
a thin, claimable *"this event is pending integration fan-out"* marker plus a byte-stable payload snapshot.

**Reference vs snapshot — decided: BOTH, with distinct roles.**

- `operational_event_id` FK → `operational_events(id)` for traceability and dedup (`UNIQUE`, one outbox row per
  event → duplicate fan-out is structurally impossible).
- A **payload snapshot serialized once at enqueue time** and stored as `TEXT` (not JSONB). Rationale: the signature
  is computed over payload bytes (§5); JSONB round-trips do not preserve key order/whitespace, so the snapshot must
  be the exact canonical bytes every attempt and every endpoint will send. Snapshotting also guarantees that later
  policy/config/template edits can never rewrite a historical payload (§7).

### 2.2 Table: `integration_outbox_events`

| Column | Decision |
|---|---|
| `id` UUID PK | outbox identity |
| `operational_event_id` UUID NOT NULL UNIQUE FK → `operational_events(id)` | reference + dedup |
| `client_id` UUID NOT NULL FK, `building_id` UUID NULL FK | copied from the event; isolation predicate for fan-out |
| `event_type` TEXT NOT NULL, `entity_type` TEXT NOT NULL, `entity_id` UUID NOT NULL | copied; fan-out matching without joining the event table |
| `payload` TEXT NOT NULL | canonical JSON envelope (§2.4), serialized exactly once |
| `occurred_at` TIMESTAMPTZ NOT NULL | copied from the event |
| `status` TEXT NOT NULL DEFAULT `'PENDING'` CHECK IN (`PENDING`,`PROCESSING`,`PROCESSED`,`FAILED`) | fan-out lifecycle only (delivery lifecycle lives on the delivery ledger) |
| `processed_at` TIMESTAMPTZ NULL, `created_at`/`updated_at` | bookkeeping |

Index: `(status, created_at)` for due retrieval; `(client_id, created_at)` for reads.

### 2.3 Enqueue seam (dual-write elimination)

Enqueue happens **inside `recordOperationalEvent`**, on the **same executor** the domain passed in — one additive
block, zero changes to the ~95 call sites. When the caller runs inside `withTransaction`, event + outbox commit or
roll back atomically; the classic dual-write problem does not exist on that path. (Callers that pass the bare pool
get two sequential autocommit inserts; residual risk recorded in §13.)

**Enqueue gate** (all must hold, evaluated on the same executor):

1. Global switch `INTEGRATION_WEBHOOKS_ENABLED` (default `false`) — zero hot-path cost until the feature is turned on.
2. `event_type` is NOT in the recursion blocklist (§7.4) — `INTEGRATION_*` and `NOTIFICATION_OUTBOUND_*` event
   types can never enqueue.
3. `SELECT EXISTS` — at least one **ACTIVE** endpoint of that `client_id` subscribed to that `event_type`
   (single indexed probe). This bounds outbox volume to what will actually be delivered and is what makes rollout
   prospective-only (§12).

Enqueue failures inside a transaction propagate (atomicity is the point); the gate itself is cheap and read-only.

### 2.4 Payload envelope (small, non-sensitive)

```json
{
  "id": "<operational_event_id>",
  "type": "<event_type>",
  "occurredAt": "<ISO-8601>",
  "clientId": "…", "buildingId": "… | null",
  "entity": { "type": "<entity_type>", "id": "<entity_id>" },
  "summary": "<summary>",
  "metadata": { "…scrubbed BE-07 metadata…" }
}
```

No full aggregate bodies, no attachments, no recipient PII beyond what BE-07 metadata already allows (it is
already scrubbed of `password`/`token`/`secret`/`apiKey`/… at record time). Receivers needing more must call the
authenticated read APIs.

---

## 3. Webhook Endpoint Configuration — decision

### 3.1 Table: `integration_webhook_endpoints`

| Column | Decision |
|---|---|
| `id` UUID PK, `client_id` UUID NOT NULL FK | **Client-scoped always** |
| `building_id` UUID NULL FK | optional Building narrowing (NULL = whole Client), mirroring BE-26D |
| `name` TEXT NOT NULL | operator label |
| `url` TEXT NOT NULL | HTTPS required; validation rejects loopback/private/link-local/metadata-range IP literals and `localhost` (SSRF guard, §13) |
| `event_types` TEXT[] NOT NULL (non-empty) | subscribed BE-07 event-type codes; validated against the event-type pattern; blocklisted types rejected at write time |
| `status` TEXT NOT NULL DEFAULT `'ACTIVE'` CHECK IN (`ACTIVE`,`INACTIVE`) | BE-26D-style enable flag |
| `signing_secret` TEXT NOT NULL | server-generated (32 random bytes, `whsec_<base64url>`), **write-only** (§3.2) |
| `secret_rotated_at` TIMESTAMPTZ NULL | rotation bookkeeping |
| `timeout_ms` INTEGER NOT NULL DEFAULT 10000 CHECK (1000–30000) | per-endpoint receiver timeout |
| `created_at`, `updated_at` | lifecycle |

Index: `(client_id, status)`; fan-out probe uses `(client_id, status, event_types)`.

### 3.2 Secret handling — decided

- Secrets are **server-generated only** (never client-supplied) and returned **exactly once**: in the `201` create
  response and in the rotate-secret response. Every other read seam uses a projection that **excludes the
  `signing_secret` column entirely** (the repository never selects it outside the signing path) — the secret
  cannot leak through list/detail APIs, logs, or operational events.
- Rotation = `POST /integration/webhook-endpoints/:id/rotate-secret` → new secret generated, old value replaced,
  `secret_rotated_at` set, new value returned once. Single-active-secret model (no dual-key overlap window) —
  smallest correct model; overlap-window rotation recorded as a known gap (§13).
- One-way hashing (the secure-link precedent) is **not applicable**: HMAC signing requires the raw key. DB-at-rest
  encryption is out of scope; risk recorded (§13).

### 3.3 Lifecycle — decided

**No hard-delete API.** Deactivation (`status = INACTIVE`) is the retirement path — it stops fan-out and stops new
attempts at claim time, while historical deliveries keep a valid FK (append-only ledger discipline, and it removes
the "endpoint deleted while deliveries remain" failure class by construction). Config edits (`url`, `event_types`,
`timeout_ms`, `status`) apply to **future behavior only**; payload snapshots are immutable (§2.1, §7.3).

---

## 4. Delivery Model — decision

### 4.1 Table: `integration_webhook_deliveries` (cloned from the proven notification ledger)

| Column | Decision |
|---|---|
| `id` UUID PK | delivery identity — also the receiver-facing idempotency key (§5, §6.1) |
| `outbox_event_id` UUID NOT NULL FK → `integration_outbox_events(id)` | source |
| `endpoint_id` UUID NOT NULL FK → `integration_webhook_endpoints(id)` | target |
| `client_id` NOT NULL, `building_id` NULL | denormalized isolation columns for reads |
| `event_type` TEXT NOT NULL | denormalized for filtering |
| `status` TEXT NOT NULL DEFAULT `'PENDING'` | lifecycle (§4.2) |
| `attempt_count` INT NOT NULL DEFAULT 0, `max_attempts` INT NOT NULL DEFAULT 5 | bounded budget |
| `next_retry_at` TIMESTAMPTZ NULL, `last_attempt_at` TIMESTAMPTZ NULL | due window |
| `last_response_status` INT NULL, `last_error` TEXT NULL (sanitized, truncated) | observability — never response bodies beyond a bounded, sanitized snippet, never request headers |
| `delivered_at` TIMESTAMPTZ NULL, `created_at`, `updated_at` | bookkeeping |
| `UNIQUE (outbox_event_id, endpoint_id)` | **structural duplicate-fan-out prevention** |

### 4.2 Lifecycle — decided (identical vocabulary to the notification ledger, `DELIVERED` in place of `SENT`)

```
PENDING ──claim──▶ SENDING ──2xx──────────────▶ DELIVERED            (terminal)
   ▲                  │──retryable, budget left─▶ RETRY_SCHEDULED ──due──▶ (claim again)
   │                  │──retryable, budget gone─▶ EXHAUSTED           (terminal)
   └── lost claim     └──permanent──────────────▶ FAILED_PERMANENT    (terminal)
```

- Claimable set: `PENDING`, `RETRY_SCHEDULED`. Terminal set: `DELIVERED`, `FAILED_PERMANENT`, `EXHAUSTED`.
- Claim-before-send: bounded due enumeration with `FOR UPDATE SKIP LOCKED`, then a status-guarded single-`UPDATE`
  claim (`PENDING/RETRY_SCHEDULED → SENDING`); every result transition is status-guarded on `SENDING`. Exactly one
  worker can own an attempt; a lost claim is a skip, not an error — verbatim the CR-BE-NOTIFY-PROV-01 pattern.
- A `SENDING` row orphaned by a crash is recovered via a bounded stale-claim age window — a seam this CR adds
  (the notification ledger has no such recovery; PART 04 scope, see §16.4).

---

## 5. Signature — decision

Symmetric **HMAC-SHA256** (the repository's proven primitive — `whatsapp-callback.verify.ts`). No asymmetric PKI,
no JWKS, no key servers.

**Canonical signing input** (byte-exact, `.`-joined):

```
signed_payload = "<timestamp_unix_seconds>" + "." + "<delivery_id>" + "." + <raw_request_body_bytes>
signature      = hex( HMAC_SHA256( endpoint.signing_secret, signed_payload ) )
```

The raw body bytes are the outbox `payload` TEXT verbatim (serialized once at enqueue — §2.1 — so bytes are
identical across attempts and endpoints; only timestamp and delivery id vary per attempt/endpoint, which is what
makes replay detection possible).

**Outbound headers:**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Asentra-Timestamp` | Unix seconds at send time |
| `X-Asentra-Delivery-Id` | delivery UUID (receiver idempotency key) |
| `X-Asentra-Event-Id` | `operational_event_id` |
| `X-Asentra-Event-Type` | event type code |
| `X-Asentra-Signature` | `v1=<hex digest>` (versioned scheme, Stripe-style) |
| `User-Agent` | `Asentra-Webhook/1` |

**Receiver expectations (documented in PART 06 handoff):** recompute the HMAC over the raw received bytes with the
shared secret, compare constant-time, reject when `|now − timestamp|` exceeds a 5-minute tolerance, and
de-duplicate on `X-Asentra-Delivery-Id` (retries reuse the same delivery id by design).

Never sent: `Authorization` values, secrets, internal hostnames.

---

## 6. Retry / Idempotency — decision

1. **Idempotency keys.** Outbox: `UNIQUE (operational_event_id)`. Fan-out: `UNIQUE (outbox_event_id, endpoint_id)`
   via insert-on-conflict-do-nothing. Receiver side: `X-Asentra-Delivery-Id` stable across attempts. No string-composed
   key needed — the natural keys are total.
2. **Bounded attempts + backoff.** `max_attempts` default **5**; delay `min(base · 2^(attempt−1), cap)` with ±25 %
   jitter, base **5 min**, cap **6 h** — reusing `computeOutboundRetryDelayMs` (exported, options-injectable) rather
   than re-implementing it. Retries are durable (`next_retry_at`) and drained by the dispatcher; no in-process timers.
3. **Timeout.** Per-endpoint `timeout_ms` (default 10 s, cap 30 s) enforced with `AbortController` per the Meta
   adapter transport pattern. Timeout ⇒ retryable.
4. **Response classification** (mapped onto `shared/provider-result.ts`):
   - **2xx → `ACCEPTED` → `DELIVERED`** — the only success signal; explicitly distinct from every other outcome.
   - `408`, `425`, `429`, `5xx`, network error, timeout → `REJECTED_RETRYABLE` → `RETRY_SCHEDULED` (or `EXHAUSTED`
     when the budget is spent).
   - Other `4xx` (400/401/403/404/410/413/422…) → `REJECTED_PERMANENT` → `FAILED_PERMANENT` (a misconfigured or
     rejecting receiver will not be fixed by retrying).
   - Adapter throw / unclassifiable → `ERROR_UNKNOWN`, treated as retryable until exhaustion (never a silent loss).
   - 3xx are **not followed** (redirects disabled — SSRF surface) and classify as permanent.
5. **Concurrent-worker safety.** `FOR UPDATE SKIP LOCKED` + guarded claim + status-guarded result transitions, per §4.2.

---

## 7. Event Selection / Fan-out — decision

One dispatcher-driven fan-out phase: claim a `PENDING` outbox row (`PROCESSING`, guarded, SKIP LOCKED batch) →
resolve matching endpoints → insert one `PENDING` delivery per endpoint (on-conflict-do-nothing) → mark
`PROCESSED` (possibly with zero deliveries). A fan-out crash re-runs safely: the uniqueness constraint makes
re-fan-out idempotent.

Matching predicate — ALL of:

1. `endpoint.client_id = outbox.client_id` — **cross-Client delivery structurally impossible**; there is no
   wildcard/global endpoint concept.
2. `endpoint.building_id IS NULL OR endpoint.building_id = outbox.building_id` (BE-26D scope semantics).
3. `outbox.event_type = ANY(endpoint.event_types)`.
4. `endpoint.status = 'ACTIVE'`.
5. `endpoint.created_at <= outbox.created_at` — an endpoint created *after* an event never receives it, even if
   fan-out runs later (prospective boundary, §12).

- **Duplicate fan-out:** prevented twice — outbox `UNIQUE (operational_event_id)` and delivery
  `UNIQUE (outbox_event_id, endpoint_id)`.
- **Config edits vs history:** payload is snapshotted at enqueue (§2.1); endpoint edits change future matching
  only; existing delivery rows and their payload bytes are immutable.
- **Recursion prevention:** the enqueue blocklist (§2.3) excludes all `INTEGRATION_*` audit events (§9) and the
  `NOTIFICATION_OUTBOUND_*` family — an integration-delivery audit event can never enqueue another outbox row.
  The blocklist is a code-level constant; endpoint `event_types` writes are validated against it as well
  (defense in depth).

---

## 8. Scheduler — decision

**Reuse only.** One additive domain in `processDueOperationalJobs` — `webhookDeliveries` — executing two bounded
phases per tick: (1) outbox fan-out (§7), (2) due delivery execution (§4/§6). Additive result key on
`DueJobDispatchResult` (`fannedOut / delivered / retryScheduled / failedPermanent / exhausted / skipped /
failures`), per-item error isolation, bounded batch limits via the existing `clampDueItemLimit` convention. No new
scheduler, timer, cron, queue, or worker process. Feature-disabled ⇒ the domain is a cheap no-op.

---

## 9. Audit / Observability — decision

Via `recordOperationalEvent` (all types on the recursion blocklist):

| Moment | Event type |
|---|---|
| Fan-out created deliveries | `INTEGRATION_WEBHOOK_QUEUED` (per delivery) |
| 2xx | `INTEGRATION_WEBHOOK_DELIVERED` |
| Retryable failure, budget left | `INTEGRATION_WEBHOOK_RETRY_SCHEDULED` |
| Permanent 4xx | `INTEGRATION_WEBHOOK_FAILED_PERMANENT` |
| Budget exhausted | `INTEGRATION_WEBHOOK_EXHAUSTED` |
| Endpoint created / updated / status changed / secret rotated | `INTEGRATION_ENDPOINT_CREATED / _UPDATED / _STATUS_CHANGED / _SECRET_ROTATED` |

Metadata: delivery id, endpoint id, event type, attempt number, HTTP status class, sanitized+truncated error,
payload **size**. **Never** logged or persisted in audit/metadata: signing secrets, `Authorization`/header values,
full payload bodies, raw response bodies. (BE-07's sensitive-key scrub applies on top.) Read models = the delivery
ledger read API (§11) + existing `operational_event.read` surface; no new metrics infrastructure.

---

## 10. RBAC / Isolation — decision

Catalogue inspection (`foundation-access.seed.ts`, full code list reviewed): no permission covers external
integration endpoints. Nearest candidates rejected: `client_configuration.*` governs the BE-27A key-value registry
(reusing it would let any config editor create outbound URLs and mint signing secrets — an SSRF/exfiltration
privilege escalation); `notification_subscription.*` governs BE-26D event→template bindings (different lifecycle
and audience). **Necessity is therefore proven** for exactly one new pair, following the established seed pattern:

- `integration_webhook.read` — endpoint list/detail (secret-free) + delivery history.
- `integration_webhook.manage` — create/update/deactivate endpoints, rotate secrets.

Seeded additively to `PLATFORM_ADMIN` (existing convention). Isolation: every route additionally filters by
`contextAccessService.getAccessibleClientIds/BuildingIds` exactly as `operational-event.routes.ts` does; all
queries carry the `client_id` predicate. No cross-Client visibility even for permission holders without context
access.

---

## 11. API Boundary — decision (minimum surface)

| Method / path | Permission | Notes |
|---|---|---|
| `POST /integration/webhook-endpoints` | manage | returns the signing secret **once** |
| `GET /integration/webhook-endpoints` / `GET …/:id` | read | secret-free projection, pagination convention |
| `PATCH /integration/webhook-endpoints/:id` | manage | `name`, `url`, `event_types`, `timeout_ms`, `status`; never the secret |
| `POST /integration/webhook-endpoints/:id/rotate-secret` | manage | returns new secret **once** |
| `GET /integration/webhook-deliveries` (+ `/:id`) | read | filters: endpoint, status, event type, time range; exposes attempt/status/error fields, never payload secrets |

**Excluded, with reasons:** manual event injection API (no existing authority requires one; `operational_events`
has no write API today and gets none here); endpoint hard-delete (§3.3); manual delivery retry — deferred, no
repository precedent (the notification ledger has none) and terminal states are deliberate; recorded as a
candidate follow-up in §13. OpenAPI additions land in PART 06.

---

## 12. Historical / Rollout Boundary — decision

- **No replay/backfill.** No API or job ever enqueues outbox rows from pre-existing `operational_events`.
- **Prospective activation is structural, twice over:** (1) outbox rows are only created at event-record time when
  an ACTIVE subscribed endpoint already exists (§2.3), so history has no outbox rows; (2) fan-out excludes
  endpoints created after the outbox row (§7 rule 5). Creating an endpoint today can only ever deliver events
  recorded after that creation.
- Feature ships dark: `INTEGRATION_WEBHOOKS_ENABLED` defaults `false`; with the flag off there is no hot-path
  probe, no outbox growth, and the dispatcher domain no-ops.
- Migrations are additive-only; no changes to `operational_events` rows or schema semantics.

---

## 13. Risks / Gaps (recorded)

| # | Risk | Position |
|---|---|---|
| R1 | **Outbox dual-write** when `recordOperationalEvent` is called with the pool (no enclosing tx): event insert may succeed and outbox insert fail (lost delivery) — never the reverse. | Accepted, low: same-executor enqueue removes the risk on all `withTransaction` paths; residual paths lose at most integration fan-out, never business data. Documented; a future sweep can move stragglers into transactions. |
| R2 | **Duplicate delivery to receivers** — at-least-once semantics: a crash after a 2xx but before `markDelivered` commits re-sends. | Inherent to webhooks. Mitigated by stable `X-Asentra-Delivery-Id` + documented receiver dedup expectation (§5). |
| R3 | **Receiver timeout / slow receiver** ties up a dispatcher tick. | Bounded `timeout_ms` (cap 30 s) + bounded batch size; a slow endpoint can still slow its tick's batch — per-endpoint concurrency isolation deferred (gap). |
| R4 | **Retry storms** against a down receiver. | Exponential backoff to a 6 h cap + 5-attempt budget + jitter; no per-endpoint circuit breaker in v1 (gap, acceptable at these caps). |
| R5 | **Secret rotation** invalidates in-flight verification instantly (single-active-secret). | Accepted for v1; dual-secret overlap window is a recorded follow-up. Rotation is audited. |
| R6 | **SSRF via endpoint URL.** | HTTPS-only, literal-IP/localhost/private/metadata-range rejection at write time, redirects disabled, `manage` permission required. Residual: DNS-rebinding to private ranges at resolve time (no egress proxy in repo) — recorded. |
| R7 | **Cross-tenant leakage.** | Structural: client-scoped endpoints only, `client_id` equality in fan-out SQL, no global endpoints, context-access filters on reads. |
| R8 | **Recursive webhook generation.** | Code-constant blocklist at enqueue + subscription-write validation (§7). |
| R9 | **Payload size / sensitive data.** | Envelope carries summary + already-scrubbed metadata only (§2.4); size logged, bodies never logged. Residual: domains that put large/sensitive values into BE-07 metadata leak them to subscribed receivers of that client — same exposure class as the existing `operational_event.read` API; blocklist can exclude event types if needed. |
| R10 | **Ordering.** At-least-once, per-endpoint ordering NOT guaranteed (retries reorder). Documented: receivers must key on `occurredAt`/event id, not arrival order. FIFO-per-endpoint out of scope. |
| R11 | **Endpoint deletion while deliveries remain.** Removed by construction: no hard delete; INACTIVE stops claims (§3.3). |
| R12 | **Secrets at rest** are plaintext in `integration_webhook_endpoints` (DB-level encryption out of scope). | Write-only column discipline + never-selected projection; KMS/at-rest encryption recorded as platform-level follow-up. |
| R13 | **Outbox growth.** `PROCESSED` rows accrue. | Bounded by the enqueue gate; retention/pruning policy deferred (gap; append-only precedent is `operational_events` itself). |
| R14 | **Manual retry API** intentionally absent (§11); operators re-point/rotate + future events flow. Recorded as candidate follow-up if operations demand it. |
| R15 | **CI/KI-003** (legacy test-suite assertion alignment debt) **remains deferred** — not reopened, not worsened; new PARTs ship with their own focused tests only. |

---

## 14. PART breakdown (confirmed — repository inspection supports the proposed six)

| PART | Scope | Contents |
|---|---|---|
| **PART 01 — Transactional Outbox Foundation** | migration + module | `integration_outbox_events` (+ index), types/repository (idempotent create, guarded claim/mark seams), enqueue gate + blocklist constants, the additive block inside `recordOperationalEvent`, config flag read. Focused tests. |
| **PART 02 — Webhook Endpoint + Secret/Subscription Foundation** | migration + module | `integration_webhook_endpoints`, secret generation/rotation seams, secret-free projection, URL/event-type/timeout validation (SSRF guard), permission pair + seed, endpoint config routes + endpoint audit events. |
| **PART 03 — Event Fan-out + Delivery Ledger** | migration + module | `integration_webhook_deliveries` (+ uniques/indexes), fan-out service (matching rules §7, on-conflict inserts, outbox `PROCESSED`), ledger repository (SKIP LOCKED due retrieval, guarded claim/result seams). |
| **PART 04 — HMAC Delivery Adapter + Retry Engine** | module | signing helper (canonical input §5), HTTP adapter (fetch + AbortController, injectable transport, sanitized errors), response classification onto `provider-result`, execution service reusing `computeOutboundRetryDelayMs`, stale-claim recovery. |
| **PART 05 — Dispatcher Integration + Audit/Observability** | wiring | `webhookDeliveries` dispatcher domain (fan-out phase + delivery phase), additive result key, `INTEGRATION_*` operational events, log hygiene. |
| **PART 06 — Read API + OpenAPI + Governance Closure** | API + docs | delivery-history read routes, OpenAPI additions for all §11 routes, receiver verification handoff notes, governance closure section in this document. |

Each PART is independently shippable, additive-only, and dark behind the flag until PART 05/06 complete.

---

## 15. Report

- **Branch / base:** `arena/01a02db2-asentra-backend` from `main` @ `59a156a` (post CR-BE-DOC-CONTROL-01 merge). Governance-only change.
- **Existing authorities found:** §1 — BE-07 `operational_events` + transactional record seam; `withTransaction`; CR-BE-NOTIFY-PROV-01 ledger/claim/retry/idempotency patterns; `shared/provider-result`; due-job dispatcher + scheduler; whatsapp-callback HMAC utilities; Meta adapter transport/timeout pattern; BE-26D subscription matching pattern; context-access isolation; full RBAC catalogue; `docs/api/openapi.yaml`.
- **Outbox / source-of-truth decision:** `operational_events` stays the only business-event authority; thin `integration_outbox_events` rows **reference the event by unique FK AND snapshot a byte-stable TEXT payload**; enqueue inside `recordOperationalEvent` on the caller's executor, gated by flag + blocklist + active-subscription probe (§2).
- **Endpoint / secret model:** Client-scoped (optional Building) endpoint registry; server-generated write-only HMAC secret returned once at create/rotate; no hard delete — INACTIVE retirement (§3).
- **Delivery / retry / signature model:** per-endpoint ledger `PENDING → SENDING → DELIVERED / RETRY_SCHEDULED / FAILED_PERMANENT / EXHAUSTED`, `FOR UPDATE SKIP LOCKED` claim-before-send, 5 attempts, 5 min→6 h exponential backoff ±25 % jitter, 2xx-only success, HMAC-SHA256 `v1` over `timestamp.deliveryId.body` with `X-Asentra-*` headers (§4–§6).
- **Scheduler decision:** existing due-job dispatcher/scheduler only; one additive domain (§8).
- **RBAC / isolation decision:** one new pair `integration_webhook.read|manage` (necessity proven by catalogue inspection — reuse candidates rejected as privilege-escalating or semantically wrong); context-access filtering + structural `client_id` equality everywhere (§10).
- **Prospective rollout decision:** flag-dark by default; no replay/backfill; enqueue-time gating + `endpoint.created_at <= outbox.created_at` make historical fan-out structurally impossible (§12).
- **Proposed PARTs:** the six PARTs as targeted, confirmed by inspection (§14).
- **Key risks / gaps:** §13 (pool-path dual-write residue, at-least-once duplicates, no circuit breaker, single-active-secret rotation, DNS-rebind residual, plaintext secret at rest, no ordering guarantee, outbox retention, manual retry deferred, CI/KI-003 stays deferred).
- **Files changed:** `docs/CR-BE-INTEG-01_START_GOVERNANCE.md` (new; only change).
- **Commit hash / push status / worktree status:** recorded in the delivery report (commit + push performed after this document is written; worktree clean at hand-off).
- **PART 01 readiness:** READY — table shape, enqueue seam, gate semantics, blocklist, and test focus are fully specified in §2/§14; next migration slot after `0305` is free.

**STOP: START GOVERNANCE complete. No implementation in this CR step.**

---

## 16. Implementation notes

### 16.1 PART 01 — Transactional Outbox Foundation (implemented)

- **Migration `0306_create_integration_outbox_events`** — exactly the §2.2 shape: UNIQUE
  `operational_event_id` FK reference, Client/Building + event/entity identity snapshot, byte-stable `payload`
  TEXT, `occurred_at`, fan-out lifecycle `PENDING / PROCESSING / PROCESSED / FAILED` (CHECK), `(status,
  created_at)` due index + `(client_id, created_at)` read index. Registered in `migrations/index.ts`.
- **Module `src/modules/integration-outbox/`** —
  - `integration-outbox.types.ts`: statuses, record/input types, recursion blocklist constant
    (`INTEGRATION_`, `NOTIFICATION_OUTBOUND_` prefixes, case-insensitive) + `isIntegrationOutboxBlockedEventType`.
  - `integration-outbox.config.ts`: `INTEGRATION_WEBHOOKS_ENABLED` module-local read (dark by default, never in
    `env.ts`/`AppConfig` — the whatsapp-callback precedent).
  - `integration-outbox.payload.ts`: canonical §2.4 envelope with FIXED field order, serialized exactly once
    (`serializeIntegrationOutboxPayload`) — the single serialization point; later PARTs sign/send the stored TEXT
    verbatim.
  - `integration-outbox.repository.ts`: idempotent `createOnConflictReturn` (on-conflict-return-existing on the
    unique event reference; a replay never overwrites the snapshot), reads, bounded `findPendingBatch` with
    `FOR UPDATE SKIP LOCKED`, guarded `claimPending` (`PENDING → PROCESSING`) and `markProcessed`/`markFailed`
    (`PROCESSING → …`) single-UPDATE seams — verbatim the CR-BE-NOTIFY-PROV-01 pattern.
  - `integration-outbox.enqueue.ts`: `maybeEnqueueIntegrationOutboxEvent(event, executor)` with the §2.3 gate
    (flag → blocklist → subscription probe) on the CALLER'S executor. The subscription probe is an injectable
    seam (`registerIntegrationOutboxSubscriptionProbe`); the PART 01 default answers **false** (no endpoint
    authority exists yet), so production enqueue is impossible until PART 02/03 registers the real
    `SELECT EXISTS` probe — dark twice over.
- **`recordOperationalEvent`** — one additive block after the authoritative insert: enqueue on the same executor
  (atomic inside `withTransaction`; failures propagate per §2.3). Zero changes to the ~95 call sites;
  `operational_events` untouched as the sole business-event authority.
- **Tests `tests/integration-outbox.test.ts`** (15/15 pass, embedded Postgres): event+outbox atomicity (commit
  and rollback together; probe failure aborts the transaction), byte-exact payload snapshot (including the
  BE-07 scrub carrying through), duplicate prevention (replay returns existing row, snapshot immutable),
  disabled gate ⇒ no outbox, default-probe/probe-false ⇒ no outbox, recursion-blocked types ⇒ no outbox,
  no historical backfill after the gate opens, guarded claim/mark single-owner transitions.
- **Validation:** `npm run typecheck` clean; PART 01 tests 15/15; `tests/vendor-work-history.test.ts` (the only
  test importing the operational-events module) 11/12 with the single failure reproduced identically on the base
  commit — pre-existing KI-003-class legacy BAST assertion debt, untouched; `git diff --check` clean.
- **Deferred to later PARTs:** real subscription probe (PART 02/03), fan-out orchestration + delivery ledger
  (PART 03), HMAC adapter/retry (PART 04), dispatcher wiring + audit events (PART 05), read API/OpenAPI (PART 06).

### 16.2 PART 02 — Webhook Endpoint + Secret/Subscription Foundation (implemented)

- **Migration `0307_create_integration_webhook_endpoints`** — exactly the §3.1 shape: `client_id` NOT NULL,
  optional `building_id`, `name`, `url`, `event_types TEXT[]` (CHECK non-empty), `status` ACTIVE/INACTIVE (CHECK),
  write-only `signing_secret`, `secret_rotated_at`, `timeout_ms` (CHECK 1000–30000, default 10000),
  `(client_id, status)` index. No delete path exists anywhere (INACTIVE retirement, §3.3).
- **Module `src/modules/integration-webhook-endpoints/`** —
  - `…secret.ts`: server-generated `whsec_` + 32 random bytes base64url; never client-suppliable.
  - `…validation.ts`: HTTPS-only URL with the §13 R6 SSRF guard (localhost/`*.localhost`, loopback, private,
    link-local/metadata, CGNAT, multicast/reserved IPv4; `::`, `::1`, ULA, link-local, v4-mapped IPv6; embedded
    credentials rejected), event-type codes uppercase-normalized/deduped and validated against the PART 01
    recursion blocklist (defense in depth), timeout bounds, and explicit rejection of any secret material in
    create/update bodies (`clientId`/`buildingId` immutable on update).
  - `…repository.ts`: **secret read boundary** — the standard projection never selects `signing_secret`;
    the secret is written at create/rotate and readable only through `findSigningSecretById` (reserved for the
    PART 04 signer). `listForClients` is always bounded to an explicit accessible-Client set.
    `hasActiveSubscription(clientId, eventType, executor)` is the §2.3 stage-3 `SELECT EXISTS` probe.
  - `…service.ts`: BE-02G `canAccessClient` on every seam (permission alone never crosses Clients), Building→
    Client consistency check, one-time secret disclosure on create/rotate responses only, and
    `INTEGRATION_ENDPOINT_CREATED / _UPDATED / _STATUS_CHANGED / _SECRET_ROTATED` audit events (blocklisted
    family; metadata never carries secrets).
  - `…probe.ts`: `registerIntegrationWebhookSubscriptionProbe()` replaces the PART 01 conservative default with
    the real probe on the caller's executor; registered in `createApp()` (visible wiring).
  - `…routes.ts` + controller: `POST/GET/GET:id/PATCH /integration/webhook-endpoints` +
    `POST …/:id/rotate-secret`, RBAC default-deny.
- **RBAC** — new pair `integration_webhook.read|manage` added to `foundation-access.seed.ts` (granted to
  PLATFORM_ADMIN via the existing assignment loop) and to the test-helper permission catalogue, with the §10
  necessity rationale recorded in the seed comment.
- **Tests `tests/integration-webhook-endpoints.test.ts`** (13/13 pass, embedded Postgres): default-deny RBAC and
  read-vs-manage separation; create/one-time secret disclosure with DB-stored secret equality; secret absent from
  every detail/list/update response (`whsec_` never in any read body); Building scope validated against the
  owning Client; ACTIVE/INACTIVE lifecycle with no delete route; secret-in-body rejection; rotation (new secret,
  old replaced, `secretRotatedAt` set); SSRF/URL matrix (15 rejected URLs); blocked-subscription and timeout
  validation; Client isolation for permission holders (create/read/list/filter/rotate all denied cross-Client);
  real probe activation — pre-endpoint events stay dark, matching events enqueue PENDING outbox rows,
  unsubscribed types / foreign Clients / INACTIVE endpoints stay dark; endpoint audit events carry no secret and
  enqueue nothing (recursion guard).
- **Validation:** `npm run typecheck` clean; PART 02 tests 13/13; PART 01 outbox tests re-run 15/15 (probe seam
  interplay); `tests/seeds.test.ts` 1/1 (seed catalogue change); `git diff --check` clean. No OpenAPI test is
  affected (per-domain contract tests only; OpenAPI additions land in PART 06 as governed).
- **Deferred:** delivery ledger + fan-out (PART 03), HMAC signing/sending + retry (PART 04), dispatcher/audit
  read models (PART 05), read API/OpenAPI/closure (PART 06).

### 16.3 PART 03 — Event Fan-out + Delivery Ledger (implemented)

- **Migration `0308_create_integration_webhook_deliveries`** — exactly the §4.1 shape: one row per
  `UNIQUE (outbox_event_id, endpoint_id)` (structural duplicate-fan-out prevention), FKs to outbox + endpoint +
  clients/buildings, denormalized `client_id`/`building_id`/`event_type` identity snapshot, lifecycle CHECK
  (`PENDING/SENDING/DELIVERED/RETRY_SCHEDULED/FAILED_PERMANENT/EXHAUSTED`), attempt accounting
  (`attempt_count`, `max_attempts` default 5), `next_retry_at`/`last_attempt_at`,
  `last_response_status`/`last_error`, `delivered_at`; partial due index on claimable statuses (the 0298
  pattern) + endpoint/client read indexes. Payload bytes stay on the outbox row (never duplicated per endpoint;
  byte-stable per §2.1).
- **Module `src/modules/integration-webhook-deliveries/`** —
  - `…types.ts`: statuses + claimable/terminal sets, records/inputs, attempt/retry outcome shapes, fan-out
    result shape.
  - `…repository.ts`: verbatim the CR-BE-NOTIFY-PROV-01 ledger seams — idempotent `createOnConflictReturn`
    (replay returns the existing row), reads, bounded `findDueDeliveries` with `FOR UPDATE SKIP LOCKED`,
    guarded `claimDelivery` (PENDING/RETRY_SCHEDULED → SENDING), guarded `markDelivered` (2xx only, sets
    `delivered_at`) / `markRetryScheduled` (durable window) / `markFailedPermanent` / `markExhausted` — all
    single-owner, status-guarded single UPDATEs. Claim/result callers are PART 04+.
  - `…fanout.service.ts`: `fanOutIntegrationOutboxEvents({limit})` — bounded PENDING enumeration, then ONE
    transaction per outbox row: guarded claim (PENDING→PROCESSING) → `findMatchingForFanOut` → idempotent
    delivery creation → `markProcessed`. PROCESSED + deliveries commit **atomically**; any throw rolls the row
    back to PENDING (self-healing transient failures; outbox FAILED stays reserved). Zero matches ⇒ PROCESSED
    with no deliveries (valid outcome). Per-row error isolation with counted failures.
- **Endpoint repository** — new secret-free `findMatchingForFanOut(clientId, buildingId, eventType, notAfter)`
  seam encoding all five §7 predicate rules in SQL, including Building narrowing (a Building-scoped endpoint
  never matches a Client-level event) and `created_at <= outbox.created_at` (prospective boundary).
- **Tests `tests/integration-webhook-fanout.test.ts`** (11/11 pass, embedded Postgres): per-endpoint PENDING
  deliveries with full identity snapshot + outbox PROCESSED with byte-identical payload; zero-match rows
  PROCESSED with no deliveries; idempotent re-runs (second pass is a total no-op) and `created:false` replay;
  cross-Client never delivers; Building narrowing matrix (client-wide vs A1/A2-scoped, client-level events);
  subscribed-types-only; prospective `created_at` rule (backdated outbox row excluded, fresh event included);
  non-PENDING outbox rows untouched (claim guard); delivery claim single-owner + guarded result seams
  (DELIVERED terminal, RETRY_SCHEDULED due again via SKIP-LOCKED enumeration, EXHAUSTED terminal).
- **Validation:** `npm run typecheck` clean; PART 03 tests 11/11; PART 01 outbox tests 15/15 and PART 02
  endpoint tests 13/13 re-run (shared repo/migration chain); `git diff --check` clean.
- **Deferred:** HMAC signing + HTTP adapter + retry engine over the claim/result seams (PART 04), dispatcher
  wiring + audit events (PART 05), read API/OpenAPI/closure (PART 06).

### 16.4 PART 04 — HMAC Delivery Adapter + Retry Engine (implemented)

- **No migration** — pure runtime over the PART 01–03 tables, plus one additive repository seam.
- **`…signature.ts`** — exactly the §5 scheme, no invention: canonical signed payload
  `"<unix_seconds>.<delivery_id>." + raw body bytes`, hex HMAC-SHA256 via `node:crypto` (the whatsapp-callback
  precedent), versioned `X-Asentra-Signature: v1=<hex>` header, the full governed header set
  (`X-Asentra-Timestamp / -Delivery-Id / -Event-Id / -Event-Type`, `Content-Type`, `User-Agent:
  Asentra-Webhook/1` — never `Authorization`, never secrets), constant-time `verify…` helper (the documented
  receiver recipe), and the 300 s replay-tolerance constant for the PART 06 handoff.
- **`…http.adapter.ts`** — meta-adapter transport pattern: injectable `IntegrationWebhookTransport`; the
  production fetch transport uses `AbortController` with the endpoint's bounded `timeout_ms` and
  `redirect: 'manual'` (redirects never followed — SSRF surface; response bodies never read). §6.4
  classification: **2xx → DELIVERED (the only success)**; 408/425/429/5xx and transport throw
  (network/timeout, `responseStatus: null`) → RETRYABLE; 3xx + all other 4xx → PERMANENT. Errors are built
  from controlled parts only (`HTTP <status>`, `Request timeout after <n>ms`, `Network error: <name>`), then
  passed through `sanitizeIntegrationWebhookError` (whsec_/bearer/credential redaction + 300-char bound) as
  defense in depth.
- **`…execution.service.ts`** — the retry engine over the PART 03 seams: stale-claim recovery → SKIP-LOCKED
  bounded due enumeration → guarded claim → sendable-state gate (missing/INACTIVE endpoint or unreadable
  secret ⇒ FAILED_PERMANENT without transport contact — §3.3 "INACTIVE stops attempts at claim time") → sign
  the stored payload TEXT **verbatim** → POST → exactly one guarded result transition. Retryable outcomes
  REUSE `computeOutboundRetryDelayMs` (5 min base, 6 h cap, ±25 % jitter; injectable RNG); the attempt that
  spends `max_attempts` becomes EXHAUSTED. Per-row error isolation; secrets flow only through the
  signing-path seam. Result shape `DueIntegrationWebhookDeliveryResult` (due/delivered/retryScheduled/
  failedPermanent/exhausted/skipped/failures/staleRecovered) ready for the PART 05 dispatcher.
- **Repository addition `recoverStaleClaims(olderThan)`** (§4.2) — crashed-worker SENDING rows older than
  15 min: the orphaned attempt is COUNTED (it may have reached the receiver), then RETRY_SCHEDULED
  (immediately due) or EXHAUSTED when the counted attempt spends the budget. Guarded UPDATEs, safe every pass.
- **Tests `tests/integration-webhook-execution.test.ts`** (15/15 pass; MOCKED transports only — no external
  network): signing vectors + verify accept/reject matrix + complete header set; classification matrix
  (2xx/408/425/429/5xx/3xx/4xx) and throw handling (AbortError → timeout, TypeError → network); redaction +
  length bound; end-to-end 2xx (byte-exact body = stored payload, signature verifies against sent bytes,
  DELIVERED with attempt accounting); 503 → RETRY_SCHEDULED (future window, idle pass does nothing) → due →
  DELIVERED with STABLE delivery-id key and identical bytes across attempts; timeout retryable with null
  status; 404 → FAILED_PERMANENT after exactly one attempt, never re-enumerated; max_attempts=2 exhaustion;
  INACTIVE endpoint terminal without transport contact; stale-claim recovery then successful redelivery; no
  `whsec_` ever persisted in ledger errors.
- **Validation:** `npm run typecheck` clean; PART 04 tests 15/15; PART 03 ledger/fan-out tests re-run 11/11
  (repository gained the recovery seam); `git diff --check` clean.
- **Deferred:** dispatcher domain + `INTEGRATION_*` operational events + log hygiene (PART 05), delivery read
  API + OpenAPI + governance closure (PART 06).

### 16.5 PART 05 — Dispatcher Integration + Audit/Observability (implemented)

- **No migration, no scheduler change** — the CR-BE-STAB-01 scheduler module is untouched; it drives the new
  work automatically through `processDueOperationalJobs`.
- **Dispatcher domain (§8)** — new `integration-webhook-dispatch.service.ts` exposes
  `processDueIntegrationWebhookJobs(before)`: ONE domain, two bounded phases in order — **outbox fan-out first,
  then due delivery execution** — so an event enqueued before a tick is fanned out AND attempted in the SAME
  tick. Dark by default: with `INTEGRATION_WEBHOOKS_ENABLED` off the domain returns all zeros without touching
  the database (and pauses leftover deliveries rather than losing them). Wired into
  `processDueOperationalJobs` as the additive `webhookDeliveries` key (batch-level throw isolated, existing
  domains and their ORDER unchanged; runs after `evidenceRetention`).
- **Result contract (§8, exactly the seven governed counters)** — `DueIntegrationWebhookResult`:
  `fannedOut` (deliveries created by fan-out) / `delivered` / `retryScheduled` / `failedPermanent` /
  `exhausted` / `skipped` (lost claims, both phases) / `failures` (isolated throws, both phases). Additive on
  `DueJobDispatchResult`; the module-level execution result keeps `staleRecovered` internally without leaking
  a non-governed counter into the dispatcher contract.
- **Audit events (§9)** — governed vocabulary centralized in `INTEGRATION_WEBHOOK_EVENT_TYPES`:
  `INTEGRATION_WEBHOOK_QUEUED` is recorded per created delivery INSIDE the fan-out transaction (atomic with
  PROCESSED — a QUEUED audit can never exist for a rolled-back fan-out); `_DELIVERED / _RETRY_SCHEDULED /
  _FAILED_PERMANENT / _EXHAUSTED` are recorded from the post-transition ledger row (including the unsendable
  INACTIVE-endpoint terminal path). Entity: `INTEGRATION_WEBHOOK_DELIVERY` / delivery id. Metadata carries
  endpointId, outboxEventId, sourceEventType, attempt/maxAttempts, responseStatus, the already-sanitized
  error, nextRetryAt, and payload SIZE (QUEUED) — never payload bodies, secrets, or Authorization material.
- **Recursion (§7.4)** — every audit type carries the `INTEGRATION_` prefix, blocked at the enqueue seam
  BEFORE the probe; proven by test with a fully-open gate: one business event ⇒ exactly one outbox row and
  one delivery across repeated ticks, zero self-amplification.
- **Test-only transport registration** — `registerIntegrationWebhookTransport` /
  `resetIntegrationWebhookTransport` (the PART 01 probe-registration precedent) so dispatcher-level tests
  never touch the network; production default remains the bounded fetch transport.
- **Tests `tests/integration-webhook-dispatch.test.ts`** (7/7 pass): flag-off all-zero no-op inside the full
  dispatcher result with all existing keys preserved; same-tick fan-out+delivery with ordered QUEUED →
  DELIVERED audit; cross-tick retry with RETRY_SCHEDULED audit and idle-tick no-op; FAILED_PERMANENT and
  EXHAUSTED audits; audit hygiene (identity + payload size only, no secrets/bodies); recursion proof; 1:1
  QUEUED-to-delivery invariant with no QUEUED for PENDING outbox rows.
- **Directly affected re-runs:** PART 04 execution 15/15, PART 03 fan-out 11/11,
  `cr-be-stab-01-due-job-dispatcher` 10/10 (its exact key-set assertion extended additively for
  `webhookDeliveries` — the same alignment earlier CRs made), `cr-be-stab-01-due-job-scheduler` 15/15
  (untouched). `npm run typecheck` clean; `git diff --check` clean.
- **Deferred:** delivery/history read API + OpenAPI + governance closure (PART 06).

### 16.6 PART 06 — Read API + OpenAPI + Governance Closure (implemented)

- **No migration; no fan-out / signing / retry / dispatcher / scheduler behavior change** — purely a read
  surface plus documentation.
- **Read API (§11)** — `GET /integration/webhook-deliveries` and `GET /integration/webhook-deliveries/:id`
  under `integration_webhook.read` (default-deny; auth before RBAC), BE-02G accessible-Client intersection on
  the list and `canAccessClient` on the detail (an explicit out-of-scope `clientId` filter is 403, matching the
  endpoint registry). Filters: `clientId`, `endpointId`, `status`, `eventType`, `from`/`to`; shared opt-in
  pagination (`page`/`pageSize` + meta); newest first. The projection (`PublicIntegrationWebhookDelivery`)
  exposes state / attempt / timing / response metadata (`status`, `attemptCount`/`maxAttempts`,
  `nextRetryAt`/`lastAttemptAt`/`deliveredAt`, `lastResponseStatus`, sanitized `lastError`) — signing secrets
  and payload bodies are STRUCTURALLY absent. No manual retry and no manual event-injection API (the §11
  exclusions stand; manual retry stays the recorded R14 follow-up).
- **Repository additions** — `listForClients` (shared WHERE + optional LIMIT/OFFSET) and `countForClients`
  over the same predicate so page and total can never disagree; always bounded to an explicit
  accessible-Client set.
- **OpenAPI (`docs/api/openapi.yaml`)** — new `Integration Webhooks` tag documenting the outbound request
  contract (envelope, all five `X-Asentra-*` headers, `v1=` scheme) and the six-step receiver verification
  recipe (raw bytes, `HMAC_SHA256(secret, timestamp.deliveryId.body)`, constant-time compare, 300-second
  replay tolerance, delivery-id dedup, 2xx acknowledgement, retry/permanent classification, no ordering
  guarantee). Seven operations published with `x-required-permission` (the §10 pair): endpoint create
  (one-time secret disclosure documented on the 201), secret-free list/detail, PATCH (immutable
  clientId/buildingId, no delete, prospective-only config edits), rotate-secret (one-time disclosure of the
  NEW secret, single-active-secret semantics), delivery list/detail. Schemas:
  `IntegrationWebhookEndpoint` (secret-free — `signingSecret` structurally absent),
  `IntegrationWebhookEndpointWithSecret` (referenced by exactly the two disclosing responses),
  `IntegrationWebhookDelivery` (no secret, no payload). Spec parses cleanly.
- **Tests `tests/integration-webhook-deliveries-read.test.ts`** (7/7 pass): 401-before-403 and default-deny;
  accessible-Client-only list with full metadata and the privacy boundary (`whsec_`, `"payload"`, and payload
  metadata fields absent from every response body); status/eventType/endpointId filters + pagination meta +
  invalid-filter 400; Client-isolated detail (cross-Client 403, unknown 404, malformed 400); OpenAPI contract
  — all seven operations with exact operationIds and REAL seeded permission codes, secret-boundary schema
  assertions (WithSecret referenced by exactly two responses), and the signature/verification documentation
  fragments.
- **Validation:** `npm run typecheck` clean; PART 06 tests 7/7; full CR suite re-run green (PART 01 15/15,
  PART 02 13/13, PART 03 11/11, PART 04 15/15, PART 05 7/7 — 61 focused tests + 7 = 68 total);
  `git diff --check` clean. No broad regression, no CI / KI-003.

---

## 17. Governance closure

CR-BE-INTEG-01 is **CLOSED**. All six PARTs implemented as governed, with zero deviation from the §0–§14
decisions:

- `operational_events` remained the sole business-event authority; the outbox references it by unique FK and
  snapshots a byte-stable payload; enqueue is transactional on the caller's executor and prospective-only.
- Endpoint registry is Client-scoped with write-only, one-time-disclosure `whsec_` secrets; INACTIVE is the
  only retirement path; SSRF guard at write time.
- Delivery ledger + fan-out enforce the five §7 matching rules structurally (unique constraints, SQL
  predicates, `created_at` prospective boundary); 2xx is the only success; bounded retry reuses the proven
  backoff helper; stale claims recover.
- One additive dispatcher domain, no new scheduler; governed `INTEGRATION_WEBHOOK_*` audit events,
  recursion-blocked; secrets/Authorization/payload bodies never logged, audited, or exposed by any API.
- RBAC: exactly the one new `integration_webhook.read|manage` pair (§10 necessity proven); BE-02G isolation on
  every surface.
- OpenAPI documents the full §11 surface plus the §5 signature contract and receiver recipe.

**Open items carried forward (unchanged from §13):** R1 pool-path enqueue residue, R2 at-least-once receiver
dedup responsibility, R3/R4 no per-endpoint concurrency isolation or circuit breaker, R5 single-active-secret
rotation (no overlap window), R6 DNS-rebinding residual, R10 no ordering guarantee, R12 plaintext secret at
rest (platform-level KMS follow-up), R13 outbox/ledger retention policy, R14 manual retry API (add only if
operations demand it), R15 CI/KI-003 stays deferred and untouched. Feature remains dark by default
(`INTEGRATION_WEBHOOKS_ENABLED=false`).
