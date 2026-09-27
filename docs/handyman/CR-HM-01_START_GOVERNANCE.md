# CR-HM-01 — Channel Context & Secure Handoff

START GOVERNANCE

Status: GOVERNANCE BASELINE (no runtime coding in this PART)
Scope (frozen, HANDYMAN_CR_CODING_ROADMAP_v1.0):

- Secure BM Super App Handoff
- immutable Channel Attribution
- customer/building/channel context

Primary authority: Handyman-Backend

## 1. Verified Baseline

- Repository: Handyman-Backend
- Branch: arena/01a0e01e-handyman-backend (unchanged)
- Roadmap commit `c94600d359232e79aab81e50f6eaa8773be4673b`
  reachable from HEAD
- Working tree clean at baseline
- `docs/handyman/HANDYMAN_CR_CODING_ROADMAP_v1.0.md` = FROZEN v1.0
- `docs/handyman/CR-HM-00_BACKEND_CAPABILITY_MAP.md` = FROZEN,
  37/37, GAP 0
- `docs/handyman/CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` = 34
  rows, A26/B3/C5, cycles 0
- CR-HM-01 roadmap scope matches the frozen scope above
- Inspection performed: focused source inspection only, limited
  to the eight seam areas mandated for this PART. No repo-wide
  archaeology. No Frontend/Mobile/SaaS repository access. No
  runtime, migration, or OpenAPI modification.

## 2. Exact Existing Reusable Seams (+ paths)

### 2.1 Authentication / session / context resolution

- Opaque bearer session convention — `src/modules/auth/session.token.ts`:
  cryptographically random base64url tokens, stored only as
  SHA-256 hash, raw token returned once (BE-01C convention;
  mirrored by BE-01G invitation and BE-26J secure-link tokens).
- Session lifecycle — `src/modules/auth/session.service.ts`:
  `createSessionForUser`, `resolveSessionContext` →
  `AuthContext { userId, sessionId, user }`,
  `revokeActiveSessionsForUser`, expiry/last-used handling.
- Bearer authentication middleware —
  `src/modules/auth/authentication.middleware.ts`: resolves
  `Authorization: Bearer` → `req.auth`.
- Business authorization (RBAC) — `src/modules/auth/rbac.middleware.ts`,
  `src/modules/roles`, `src/modules/permissions`,
  `src/modules/entitlements`: separate from authentication.
- Effective context assembly —
  `src/modules/auth/effective-context.service.ts`: roles,
  permissions, reachable Client/Property/Building hierarchy,
  workforce profiles, module entitlements from single resolvers.
- Login abuse control — `src/modules/auth/login-rate-limit.ts`
  (pattern reusable for external endpoints).
- Request correlation — `src/shared/request-context.ts`
  (AsyncLocalStorage requestId/source), `src/middleware/request-id.ts`,
  `src/middleware/security.ts`, `src/middleware/mobile-context.ts`
  (header metadata capture, observability-only, never trusted).

### 2.2 Tenant / customer context

- Tenant Company — `src/modules/tenant-companies`
  (Client-scoped customer organization, ACTIVE/INACTIVE).
- Tenant PIC (customer person) — `src/modules/tenant-pics`:
  `tenantCompanyId`, optional `userId` binding (nullable),
  `isPrimary`, ACTIVE/INACTIVE. Customer identity seam; a
  customer may have no local User today.
- Tenant↔Building context — `src/modules/tenant-building-contexts`:
  ACTIVE/INACTIVE + effective window with `isEffectiveNow`;
  validates that a tenant company legitimately operates in a
  building.
- Tenant↔space (unit) relation — `src/modules/tenant-spaces`
  (validated by tenant-service-requests before space binding).

### 2.3 Building / location context

- Structure — `src/modules/buildings`, `properties`, `clients`
  (Client → Property → Building), `floors`, `rooms`, `spaces`,
  `functional-locations` (spatial context reuse only per frozen
  map; no FM workflows adopted).
- Accessible-scope resolver — `src/modules/building-assignments`
  (`resolveBuildingsForUser`: ACTIVE assignment + ACTIVE
  Building + hierarchy).
- Data isolation authority — `src/modules/context-access`:
  `assertBuildingAccess`, `assertClientAccess`,
  `getAccessibleBuildingIds` (backend isolation; unknown IDs are
  denied, avoiding existence leaks).

### 2.4 Request / user identity context

- Tenant Service Request — `src/modules/tenant-service-requests`:
  validates tenant company ACTIVE, active tenant-building
  context, ACTIVE PIC belonging to that company, optional
  tenant-space binding — an existing exemplar of server-side
  context validation against client-supplied references.
- Intake channel vocabulary — `src/modules/tenant-intake`:
  `INTAKE_CHANNELS` (PORTAL/MOBILE/PHONE/WHATSAPP/EMAIL/
  WALK_IN/FRONT_DESK/OTHER) — explicitly an assisted-intake
  provenance vocabulary, nullable, NOT propagated to
  work-requests/work-orders, and NOT a BM attribution model.
- Users — `src/modules/users` (global identity, status-gated
  login).

### 2.5 Vendor / provider context (channel separation only)

- `src/modules/vendors` (Client-scoped provider master data),
  `src/modules/vendor-buildings`. Used in CR-HM-01 only to keep
  customer-origin and provider-origin channels distinct; no
  reuse or authority change.

### 2.6 External handoff / token / integration primitives

- `src/modules/notification-secure-links` — external-party
  access pattern: opaque recipient-bound single-purpose token,
  target never embedded in the raw token, server-side reveal
  only after validation, statuses ACTIVE/REVOKED/EXPIRED/USED.
- `src/modules/whatsapp-callback` — external-system inbound
  authentication precedent: config module with secret boundary,
  HMAC-SHA256 over RAW body verified with `timingSafeEqual`,
  GET handshake; mounted OUTSIDE the versioned API prefix at
  `/webhooks/notifications/whatsapp`.
- `src/modules/invitations` — one-time opaque invitation token
  (same BE-01C hash convention).
- CONFIRMED ABSENT: no handoff/SSO/token-exchange seam, no
  BM Super App references, no channel-attribution storage
  anywhere in `src/` or migrations (verified by targeted
  search; the only "attribution" strings in migrations are
  unrelated approval-attribution columns).

### 2.7 Audit / outbox / idempotency / security primitives

- Audit — `src/modules/audit`: `recordEvent`,
  `auditContextFromRequest` (requestId, socket IP, user-agent;
  forwarded headers not trusted).
- Operational events — `src/modules/operational-events/index.ts`:
  `recordOperationalEvent(input, executor, correlation)` —
  transactional ledger on the caller's executor with
  SENSITIVE_KEYS metadata scrubbing and requestId/source
  correlation.
- Integration outbox — `src/modules/integration-outbox`:
  atomic same-transaction enqueue after authoritative event
  insert; subscription-probe gated; prospective only.
- Idempotency — `src/modules/request-idempotency`: generic
  transactional idempotent execution (actor + operationKey +
  SHA-256(key), request fingerprint equality, 409 conflict,
  no failure storage, single-transaction atomicity; raw key
  never persisted/logged).

### 2.8 OpenAPI conventions for the future CR-HM-01 contract

- `docs/api/openapi.yaml` — authoritative, hand-maintained
  contract; OpenAPI 3.0.3; versioned prefix (`API_PREFIX`,
  default `/api/v1`); `SuccessEnvelope` / `ErrorEnvelope`;
  `X-Request-ID` on every response; `x-required-permission` /
  `x-building-scoped` route extensions. Rule: paths are added
  only for endpoints already registered in the backend router;
  never invent.
- Router aggregation — `src/routes/index.ts`
  (`createApiRouter`, mounted at `config.apiPrefix`);
  external inbound integrations may instead mount outside the
  prefix under `/webhooks/...` (whatsapp precedent).

## 3. Missing Implementation Seams

- M1 — Trusted external channel authority: no concept of
  BM Super App as an authenticated external origin
  (IntakeChannel is staff/portal provenance, not trust).
- M2 — Handoff origin authentication: no BM-specific
  verification of handoff payload origin/integrity (raw-body
  HMAC convention exists but is Meta-specific).
- M3 — Server-side trusted-context resolution for handoff:
  customer identity → Tenant PIC/User; building → Building +
  ACTIVE tenant-building-context; unit → tenant-space binding;
  channel origin — all resolved server-side from handoff claims.
- M4 — Immutable Channel Attribution domain + persistence:
  originating BM/building/channel captured once at request/
  transaction creation; no storage or model exists today; no
  unprivileged update path may ever be added.
- M5 — Attribution carrier contract: how attribution
  accompanies the request → transaction lifecycle (binding
  point lands in CR-HM-02 intake; CR-HM-01 defines the
  carrier/binding contract only).
- M6 — Handoff + context OpenAPI surfaces (PART-gated;
  conventions in §2.8).
- M7 — Audit/operational-event semantics for handoff
  accept/reject and attribution binding (event vocabulary is
  deferred to the implementation PARTs; not invented here).
- M8 — Idempotent handoff execution (external retries) via
  `request-idempotency`; operation key choice deferred.
- M9 — Abuse control for the external handoff surface
  (login-rate-limit pattern reusable).

## 4. Security / Trust Boundaries

- BM Super App is EXTERNAL to Handyman. Handoff must NOT trust
  client-supplied authoritative tenant/customer identity,
  building identity, unit identity, channel attribution, or
  user authority. All trusted context is resolved/validated
  server-side (exemplar: `tenant-service-requests` create-flow
  server-side validation).
- Handoff authentication != Handyman business authorization
  (RBAC / context-access remain the only business authority).
- Customer identity != building authorization != unit
  authorization (tenant-pic vs tenant-building-context vs
  tenant-space are separate checks; each must hold).
- Channel Attribution != BM financial entitlement; Channel
  Attribution != SaaS product entitlement (frozen firewall).
- Channel Attribution is immutable once the Handyman request/
  transaction is created; the only conceivable future escape is
  a separately governed privileged correction mechanism — no
  update surface is designed or added in CR-HM-01.
- Secrets boundary: raw handoff tokens/secrets never persisted,
  logged, audited in plaintext, or echoed in errors (BE-01C
  hash-only, BE-26J, whatsapp config boundary, SENSITIVE_KEYS
  scrubbing conventions all apply).
- Unknown/nonexistent building/unit/company references must be
  denied without existence leaks (context-access convention).
- No FM workflow ownership may be introduced; structure modules
  are context reuse only.

## 5. Persistence Requirements

- NEW: channel attribution record store — created once at
  binding time (request/transaction creation), append-only by
  design (no UPDATE path; future privileged correction would be
  a separately governed mechanism). Exact table/column design
  belongs to the persistence PART.
- NEW: handoff resolution/acceptance record — durable record of
  server-side resolution outcome and the established context
  link (exact shape deferred; depends on Decision D2).
- NEW: whatever token/secret material the decided handoff
  mechanism requires, stored hash-only or never at rest
  (per convention).
- REUSE (read/validation sources, no schema change expected in
  CR-HM-01): `tenant-building-contexts`, `tenant-spaces`,
  `tenant-pics`, `tenant-companies`, `buildings`, `spaces`,
  `building-assignments`, `context-access`, `sessions`.

## 6. API / OpenAPI Requirements

- One secure handoff entry surface (mount convention decision
  D3: versioned public API path vs `/webhooks/...` external
  mount — both precedents documented in §2.6/§2.8).
- One server-resolved channel-context read surface for clients
  (what context the handoff established; never what the client
  asserted).
- Attribution carrier surface consumed by CR-HM-02 intake
  (binding contract; attribution fields read-only on all
  public contracts thereafter).
- All responses: `SuccessEnvelope` / `ErrorEnvelope`,
  `X-Request-ID`; authorization failures generic; no identity
  enumeration or existence leaks.
- Contract must record that handoff authentication grants no
  business permission (x-required-permission conventions).

## 7. Audit / Idempotency Requirements

- Audit + operational events for: handoff accepted, handoff
  rejected (origin/context validation failure), attribution
  binding created — recorded on the same transaction as the
  state change (operational-events executor convention;
  SENSITIVE_KEYS-scrubbed metadata; requestId correlation).
- Idempotent handoff execution via `request-idempotency`
  (actor + operation + key + fingerprint semantics; raw key
  never stored).
- Abuse control on the external surface following
  `login-rate-limit` conventions.
- No historical backfill/retroactive attribution (prospective
  only, matching outbox prospective-rollout convention).

## 8. Focused Implementation Decomposition Recommendation

Small implementation PARTs (recommendation only — NOT started,
NOT implemented):

- PART 01 — Channel context domain & persistence foundation:
  channel attribution domain module (types/repository/migration),
  append-only immutability, channel-context read primitives.
  No HTTP surface. Independent of pending decisions D1–D3.
- PART 02 — Trusted handoff context resolution: server-side
  resolution service (customer identity → PIC/User; building →
  building + ACTIVE tenant-building-context; unit →
  tenant-space; channel origin), pure application services and
  errors over existing seams. Independent of wire format.
- PART 03 — Secure handoff runtime: BM origin authentication
  (per Decision D1), handoff accept/reject semantics, context
  establishment (per D2), idempotency (M8), abuse control (M9),
  audit/operational events (M7).
- PART 04 — Channel attribution binding contract: binding
  service consumed by CR-HM-02 intake; immutability enforcement;
  no correction surface.
- PART 05 — HTTP/OpenAPI exposure: endpoint(s), envelopes,
  openapi.yaml extension per decided mount convention (D3).
- PART 06 — Focused integration validation: handoff flow
  contract tests, firewall checks (attribution != BM/SaaS
  entitlement), exit-gate evidence.

Dependency shape: PART 01 → PART 02 → PART 03 → PART 04 →
PART 05 → PART 06; PART 04 may start once PART 01 lands.
PART 03/05 follow the D1–D3 decisions frozen in §9.

## 9. Decisions FROZEN (Security Decision Freeze)

The following decisions, previously open, are now FROZEN.
Changes require an explicit new decision record.

- D1 (FROZEN) — TRUST MODEL: server-to-server signed handoff
  assertion. Credential/key scoped per BM integration.
  Assertion short-lived. A successful assertion may
  create/authorize a one-time exchange. A BM app/client payload
  by itself is never trusted. Secret/private material must not
  be stored or logged in plaintext. Exact crypto/key
  storage/schema remains a PART 03 implementation design
  following existing repository security conventions.
- D2 (FROZEN) — SESSION MODEL: use distinct short-lived
  one-time handoff/exchange state first. Do NOT automatically
  create a standard Handyman user session merely because a BM
  assertion is valid. Canonical customer/building/unit context
  must be resolved first (PART 02 resolver). The nullable
  `tenant-pics.userId` must not be bypassed or fabricated.
  Any later standard session issuance requires an explicit
  valid local identity/auth policy.
- D3 (FROZEN) — API MOUNT: the interactive handoff/exchange
  surface belongs under the versioned `/api/v1` Handyman API.
  Do NOT mount it under `/webhooks/`. Exact endpoint path
  remains PART 05/OpenAPI design.

Preserved invariants:

- origin authentication != business authorization
- customer != building authorization
- building != unit authorization
- channel attribution != BM financial entitlement
- channel attribution != SaaS entitlement

- Recorded assumption (verified at binding time): "unit"
  corresponds to the existing space model as validated through
  `tenant-spaces` (as tenant-service-requests already does).
- Out of scope by design: privileged attribution correction
  mechanism (future, separately governed); IntakeChannel
  vocabulary is NOT repurposed as attribution (frozen-map
  boundary: attribution is NEW).

STATUS NOTE: CR-HM-01 PARTs 01 (immutable channel attribution
foundation) and 02 (trusted handoff context resolver) are
delivered. PART 03 (secure handoff runtime) is next and is
unblocked by the D1–D3 freeze above.
