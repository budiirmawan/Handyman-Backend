# CR-BE-SAAS-01 — Gatepro SaaS Control Plane for Asentra

**System:** Asentra Backend
**Type:** Change Request — Backend Capability Extension
**Status:** PROPOSED — PART 00 (Discovery & Contract Freeze) COMPLETE
**Owner:** Gatepro / Asentra Platform
**Primary consumer:** Gatepro SaaS Internal Desktop Portal
**Architecture principle:** Single Backend Authority / Separate Control Plane and Business Plane
**Inspection date:** 2026-09-24 (UTC)
**Frozen contract:** [`docs/architecture/SAAS_CONTROL_PLANE_CONTRACT.md`](../architecture/SAAS_CONTROL_PLANE_CONTRACT.md)

---

## 1. Summary

Extend the existing Asentra Backend with a **SaaS Control Plane** under the
canonical namespace `/api/v1/platform/*`, authoritative for the Gatepro SaaS
Internal Desktop Portal:

- customer lifecycle (on existing `clients` authority — extended, not replaced);
- SaaS product catalog, packages, features, limits;
- versioned pricebook;
- subscription lifecycle (server-authoritative state machine);
- entitlement + quota enforcement seam for the business plane;
- idempotent provisioning workflow;
- SaaS billing account, invoice, payment, reconciliation;
- trial, renewal, grace, suspension, reactivation policy;
- usage metering;
- tenant health and commercial dashboard projections;
- platform IAM, controlled support access, platform configuration,
  customer branding metadata;
- canonical audit for every control-plane mutation.

**No new backend. No new service. No tenant-model replacement.** The control
plane lives inside the same modular monolith and reuses the existing identity,
RBAC, isolation, configuration, audit, outbox, idempotency, and currency
authorities wherever semantics already match (verified in PART 00, §4 below).

---

## 2. Plane separation

```text
Gatepro SaaS Console ──────┐
                           │
Asentra Customer Web ──────┼──► ASENTRA BACKEND (single authority)
                           │
Asentra Mobile ────────────┘
ASENTRA BACKEND
├── SaaS Control Plane      → /api/v1/platform/*   (platform.* permissions)
└── Facility Operations
    Business Plane          → /api/v1/organizations|buildings|assets|...
                              (existing tenant-scoped permissions)
```

Invariants (frozen in the contract, §17):

1. A tenant user cannot access `/platform/*` (default-deny; `platform.*`
   permission required per route).
2. Platform authority does not imply business-plane mutation authority.
3. `customerId` ≠ `tenantId` ≠ `organizationId` ≠ `buildingId` — never
   interchangeable.
4. Client-supplied tenant context remains untrusted (BE-02G isolation rules
   unchanged).
5. Cross-tenant queries must be explicitly authorized.

---

## 3. Repository baseline (verified at inspection)

| Item | Verified value |
|---|---|
| Branch base / main commit | `6d9fc884f167ceefb9c4acc51ef37f1ff0fd115e` |
| Stack | Node.js 20+, TypeScript strict, Express 5, PostgreSQL (`pg`), migrations via `schema_migrations` |
| Latest migration | `0359_add_tenant_intake_provenance` → next free number **0360** |
| API prefix | `/api/v1` (`API_PREFIX`), envelope `{success, data, meta}` / `{success:false, error{code,message}}`, `X-Request-ID` correlation |
| AuthN | Opaque session tokens (hash-only storage), `authenticationMiddleware` → `req.auth` |
| AuthZ | Default-deny RBAC: `requirePermission(code)`; **322** permission codes in `foundation-access.seed.ts`; `PLATFORM_ADMIN` role; `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` precedent for exceptional authorities |
| Data isolation | BE-02G `ContextAccessService` (accessible Building/Client sets from explicit assignments) + `requireBuildingAccess`; `docs/data-isolation.md` |
| Commercial foundation | `clients` (0012) → `subscriptions` (0013) → `licenses` (0014); `modules` catalogue (0015); `module_entitlements` (0016); resolvers `isSubscriptionEffective`, `resolveEffectiveEntitlements` |
| Structure | `properties` (0017) → `buildings` (0018); `user_building_assignments` (0019); `organizations` (0020, client-scoped) |
| Configuration | `client_configurations` / `building_configurations` / `module_configurations` / `feature_entitlement_configurations` (0246–0249); lifecycle `DRAFT → VALIDATED → PUBLISHED → ACTIVE → SUPERSEDED` (0256/0257); branding as `BRANDING.PROFILE` JSONB key |
| Audit | `operational_events` + `recordOperationalEvent` (append-only, correlation, sensitive-key scrub, outbox seam); separate authentication audit (0011) |
| Events/outbox | Integration outbox (0306–0308) fan-out marker over `operational_events`; webhook delivery |
| Idempotency | CR-BE-IDEMPOTENCY-CORE-01 `executeIdempotent` (actor + operationKey + Idempotency-Key, transaction-owning, replay/409-conflict semantics) |
| Currency | Global `currencies` reference (0331, 9 codes, immutable code), `client_monetary_contexts`, FX authority (0333) |
| Scheduler | In-process due-job scheduler (disabled in tests) for periodic work |
| OpenAPI | Hand-maintained `docs/api/openapi.yaml` (≈929 paths) + per-milestone contract tests |
| Tests | node:test + supertest + embedded PostgreSQL, 579 spec files, seed-relative assertions |

---

## 4. PART 00 — Discovery results (seam audit)

Full evidence table in the frozen contract, §5–§6. Decision summary:

### Reuse as-is (no change)

- Session authN + RBAC enforcement middleware; effective context (`GET /auth/me`).
- BE-02G data isolation (`ContextAccessService`, `requireBuildingAccess`).
- `modules` catalogue = SaaS **capability registry** (entitlement subject).
- `withTransaction`, request-id correlation, error envelope, pagination helpers.
- `currencies` + client monetary context (SaaS billing currency whitelist source).
- `client_configurations` + configuration lifecycle (platform configuration
  gets an analogous platform-scoped table; tenant-side configuration unchanged).
- Branding JSON profile (extended with `supportName` / `supportContact`
  keys — additive JSON, no schema change).
- Integration outbox + operational events (extended, see below).

### Extend (additive migrations only)

- **`clients`** → SaaS customer registry: add `display_name`, `billing_email`,
  `billing_phone`, `address`, `country`, `currency_code`, `timezone`;
  extend `status` lifecycle to
  `PROSPECT → TRIAL → ACTIVE → GRACE → SUSPENDED → TERMINATED`
  (existing `ACTIVE`/`INACTIVE` values remain valid; no row rewrites).
- **`subscriptions`** → canonical SaaS subscription aggregate: add
  `package_id`, `pricebook_version_id`, `billing_cycle`, `currency_code`,
  `trial_end_date`, `current_period_start/end`, `renewal_date`,
  `grace_until`, `cancelled_at`, `terminated_at`; extend status to
  `DRAFT / TRIAL / ACTIVE / PAST_DUE / GRACE / SUSPENDED / CANCELLED /
  TERMINATED` (legacy `PENDING`/`EXPIRED` stay readable, never newly written).
- **`licenses`** — unchanged contractually (validity dimension of subscription).
- **`module_entitlements`** → entitlement records: add `source`
  (`PACKAGE/ADD_ON/OVERRIDE/PROMOTION/MANUAL`) and nullable `limit_value`.
- **`operational_events`** → make `client_id` nullable (platform-scope events
  have no customer); `recordOperationalEvent` accepts optional client. This is
  the single canonical audit store — no second audit table is created.

### New tables (no existing equivalent — verified gaps)

| Area | New tables |
|---|---|
| Product catalog | `saas_products`, `saas_packages`, `package_features`, `package_limits` |
| Pricebook | `saas_pricebooks`, `saas_pricebook_versions`, `saas_price_items` (versioned, effective-window `EXCLUDE` pattern per tariff/price-catalog precedent) |
| Add-ons | `product_add_ons`, `subscription_add_ons` |
| Billing | `saas_billing_accounts`, `saas_invoices`, `saas_invoice_lines` |
| Payment | `saas_payment_records`, `saas_payment_allocations`, `saas_payment_provider_references` |
| Usage | `saas_usage_meters`, `saas_usage_records`, `saas_usage_aggregations` |
| Provisioning | `saas_provisioning_runs` (per-step status, retries, diagnostics) |
| Platform config | `platform_configurations` (platform-scoped, versioned) |
| Support access | `platform_support_sessions` |

### Verified gaps (nothing exists today)

1. `/api/v1/platform/*` namespace — absent.
2. Platform-scoped permissions (`platform.*`) — absent; `PLATFORM_ADMIN` is a
   single all-catalogue role.
3. SaaS product/package/pricebook — absent (`subscriptions.plan_code` is a
   free-text reference, explicitly "never a driver of module entitlement").
4. SaaS billing account / SaaS invoice / payment reconciliation — absent
   (existing `tenant_invoices` / `payment_receipts` are facility-operations
   commercial records — different semantics, **not reused**).
5. Trial / PAST_DUE / GRACE / TERMINATED states — absent.
6. Usage metering & quotas — absent (utility metering is operational meter
   data, not SaaS quota metering).
7. Tenant health projection, commercial dashboard metrics — absent.
8. Gatepro support-session mechanism — absent (no impersonation exists either).
9. Provisioning workflow — absent (client/property/building/user creation
   primitives exist individually; no orchestrated idempotent command).
10. Optimistic concurrency for commercial aggregates — no repository-standard
    version mechanism exists yet (only targeted status checks); the contract
    therefore freezes an explicit `version`-column pattern for the SaaS
    aggregates only.

---

## 5. Delivery plan

Executed incrementally per PART; each PART keeps the backend running, adds
tests, and updates `docs/api/openapi.yaml` where endpoints are added.
PART 00 produced **no runtime changes** — documentation only.

| PART | Scope | Frozen-contract sections |
|---|---|---|
| 00 | Discovery & contract freeze (this delivery) | all |
| 01 | SaaS Customer registry + platform IAM foundation + `/platform/customers` + strict plane boundary + audit | §8, §13, §15, §17 |
| 02 | Product, package, features/limits, versioned pricebook | §9, §10 |
| 03 | Subscription aggregate + lifecycle state machine + renewal/trial/cancellation metadata | §11 |
| 04 | Entitlement (source/limits) + add-ons + business-plane enforcement seam | §12 |
| 05 | Provisioning command (idempotent, retry-safe, per-step audit) | §14 |
| 06 | Billing account + SaaS invoice + lines + invoice lifecycle | §15 |
| 07 | Payment records + provider reference + reconciliation + allocation | §16 |
| 08 | PAST_DUE / GRACE / SUSPENDED / reactivation + suspension access policy | §11, §18 |
| 09 | Usage meters + records + aggregations + quota projection | §12 |
| 10 | Tenant health + commercial dashboard projection (documented formulas) | §21 |
| 11 | Support sessions (explicit, timed, audited — no impersonation) | §19 |
| 12 | Platform configuration + customer branding metadata | §20 |
| 13 | OpenAPI parity, audit parity, provider ports, error/idempotency/concurrency standards | §15, §17–§19, §22 |
| 14 | Final regression across all invariants | §17, §23 |

Migration numbering continues from **0360** in PART order; applied migrations
are never edited.

---

## 6. Acceptance criteria (summary)

- **Architecture:** single backend authority preserved; control plane present;
  business plane not rewritten.
- **Security:** tenant users cannot reach `/platform/*`; platform permissions
  explicitly enforced and unassigned by default; customer isolation proven by
  tests; support access fully audited.
- **Commercial:** Product → Package → Pricebook → Subscription → Entitlement
  chain works end-to-end; pricebook versions immutable once published;
  transitions server-authoritative.
- **Provisioning:** provisioning is idempotent, retry-safe, failure-diagnosable;
  no duplicate tenant/org/building/admin on replay.
- **Billing:** invoice lifecycle present; payments reconcile to allocations;
  billing state drives subscription policy.
- **Entitlement:** backend decides capability access and quota; hiding in a UI
  is not enforcement.
- **Audit:** every control-plane mutation writes a canonical audit record
  (actor, authority, customer, resource, action, before/after, reason,
  requestId, timestamp).
- **Contract:** OpenAPI matches runtime; error/pagination conventions kept;
  no breaking change to existing API or schema without an explicit migration.

---

## 7. Explicit out of scope

Gatepro frontend; portal visual design; payment-gateway vendor selection;
accounting/ERP implementation; a full Indonesian tax engine; CRM/sales
pipeline; marketing automation; a support-ticketing platform; infrastructure
monitoring replacement; backend rewrite; microservice migration; database
replacement; mobile UI changes.

---

## 8. Governance

This CR is an **extension** of the existing backend. Implementation SHALL:

- inspect before inventing;
- reuse existing domain primitives when semantics match;
- avoid duplicate commercial authority, tenant model, entitlement system,
  audit/idempotency/concurrency infrastructure;
- preserve existing frozen roadmap behavior;
- add SaaS-specific capability only where a verified gap exists (§4).

No framework rewrite. No backend split. No microservice migration. No
frontend implementation in this CR.

---

## 9. PART 00 deliverables

| Deliverable | Path | Status |
|---|---|---|
| Change request record | `docs/change-requests/CR-BE-SAAS-01.md` | this file |
| Frozen SaaS Control Plane contract | `docs/architecture/SAAS_CONTROL_PLANE_CONTRACT.md` | complete |

No runtime code, migrations, seeds, or OpenAPI changes were made in PART 00.
