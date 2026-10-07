# SaaS Control Plane — Frozen Contract (CR-BE-SAAS-01)

**Status:** FROZEN at PART 00 (Discovery & Contract Freeze)
**Frozen date:** 2026-09-24 (UTC)
**Baseline commit:** `6d9fc884f167ceefb9c4acc51ef37f1ff0fd115e`
**Change management:** any deviation from this contract requires an explicit
CR amendment recorded here (§24). PARTs implement it; they do not silently
reinterpret it.

Companion document: [`docs/change-requests/CR-BE-SAAS-01.md`](../change-requests/CR-BE-SAAS-01.md).

---

## 1. Purpose

This document freezes the authoritative contract for the **SaaS Control
Plane** of the Asentra Backend: the customer lifecycle, product catalog,
versioned pricebook, subscription lifecycle, entitlement & quota,
provisioning, SaaS billing/payment, usage metering, tenant health, platform
IAM, support access, platform configuration, branding metadata, audit, and
the API surface consumed by the Gatepro SaaS Internal Desktop Portal.

It is derived exclusively from repository inspection (PART 00). Every "reuse"
and "new" decision below is backed by verified seams in §5.

## 2. Terminology reconciliation (binding)

The repository already uses "Tenant" for facility-operations tenants
(`tenant_companies`, `tenant_spaces`, `tenant_invoices`, … — occupants of a
building). The SaaS CR uses "tenant" for a customer's subscribed operational
context. To prevent ambiguity, this contract uses:

| This contract says | Repository authority | Meaning |
|---|---|---|
| **Customer** | `clients` (0012) | The SaaS customer / commercial counterparty (Gatepro's client). Canonical SaaS customer registry. |
| **Tenant context** | `Client` + its `organizations`, `properties`, `buildings` | The subscribed operational scope a customer provisions. There is **no new `tenants` table**. |
| **Organization** | `organizations` (0020) | Existing client-scoped organization unit — semantics unchanged. |
| **Building** | `buildings` (0018) | Existing structure unit — identity unchanged. |
| **Subscription** | `subscriptions` (0013) | Existing commercial state of a Customer — extended, never replaced. |
| **Capability** | `modules` (0015) | Existing module catalogue = SaaS capability registry (ASSET, WORK_ORDER, …). `module.code` is the `capabilityCode`. |
| **Entitlement** | `module_entitlements` (0016) | Existing subscription × capability grant — extended with source/limit. |
| **SaaS tenant** (if unavoidable) | — | Always means "the tenant context of a Customer". Never a new entity. |

Invariants (binding, mirrors CR §28):

1. `customerId` (=`clients.id`) ≠ `organizationId` ≠ `buildingId` — never
   interchangeable; repositories must not silently accept one as another.
2. A **Customer** has 1..n **Subscriptions** and 1..n
   **Organizations/Properties/Buildings**.
3. Operational "tenants" (`tenant_companies`, …) are unaffected by this CR.

## 3. Plane separation & namespace

```text
Control Plane   /api/v1/platform/*     → platform.* permissions only
Business Plane  /api/v1/<existing>     → existing permissions, unchanged
Tenant-side     /me/* (new, §22)       → authenticated tenant users,
                                         scoped to their accessible Customers
```

- Control-plane routes are registered in a new `createPlatformRouter()`
  mounted by `src/routes/index.ts`, following the existing router conventions
  (`authenticationMiddleware` → `requirePermission('platform.…')` → handler).
- **Default deny:** a route under `/platform/*` that is not behind an explicit
  `platform.*` permission is a contract violation. Additionally, every
  platform route handler resolves the caller's effective permissions and
  refuses any permission not in the `platform.*` namespace (defense in depth;
  no tenant permission can ever open a platform route).
- Business-plane routes must never check `platform.*` permissions as
  sufficient for business-plane mutation (platform authority ≠ business
  authority).
- The Gatepro SaaS Console is served its own brand by the frontend; the
  backend control plane never returns Gatepro branding for tenant consumers.

## 4. Repository conventions the control plane MUST follow

All control-plane code follows existing conventions exactly:

- Module layout: `src/modules/<domain>/{<domain>.routes,controller,service,repository,types,validation,errors,index}.ts`.
- Response envelope: `sendSuccess` → `{success:true, data, meta}`; errors via
  `AppError` + `error-handler` → `{success:false, error:{code,message,…,
  category,retryable,requestId}}`.
- `X-Request-ID` correlation end-to-end (request context AsyncLocalStorage).
- Validation: per-module `*.validation.ts`, 400 `VALIDATION_ERROR` with field
  details.
- Errors: new error codes appended to `ERROR_CODES` (`shared/errors.ts`) —
  additive only.
- Pagination: `shared/pagination.ts` opt-in `page`/`pageSize` (1..200,
  default 50) + `meta {page,pageSize,total,totalPages}` for all platform
  list endpoints.
- Migrations: numbered from **0360** in `src/database/migrations/`,
  registered in `migrations/index.ts`; never edit applied migrations.
- Seeds: permission catalogue growth in `foundation-access.seed.ts`
  (tests are seed-relative — no hardcoded counts).
- OpenAPI: `docs/api/openapi.yaml` updated in the same PART that registers a
  route; per-milestone contract test added (e.g. `tests/platform-openapi.test.ts`).
- Tests: node:test + supertest + `tests/helpers/{access,http,postgres}.ts`
  pattern; every PART ships focused tests including negative isolation tests.
- UUID PKs, `created_at`/`updated_at`, status check constraints, FK integrity,
  indexes on lookup keys (governance §Database principles).

## 5. Verified seam map (evidence)

| Concern | Existing authority | Evidence | Contract decision |
|---|---|---|---|
| Authentication | Opaque session tokens, hash-only storage | `src/modules/auth` (session.*, credential.*, `authenticationMiddleware`) | Reuse. Platform actors are Users with `platform.*` permissions; no second auth mechanism. |
| Authorization | `requirePermission(code)` default-deny | `src/modules/auth/rbac.middleware.ts` | Reuse + `platform.*` code namespace (§13). |
| Effective context | `GET /auth/me` (user, roles, permissions, clients, entitlements, scope) | `effective-context.service.ts`, `docs/effective-context.md` | Reuse for business plane. Control plane adds `/platform/me`-style resolution via permission set only. |
| Data isolation | BE-02G `ContextAccessService`, `requireBuildingAccess` | `src/modules/context-access`, `docs/data-isolation.md` | Reuse unchanged for business plane. Control plane has **no** building-scope filter: platform actors are cross-customer by authority, per permission. |
| Customer | `clients` (code unique, name, legal_name, tax_id, status ACTIVE/INACTIVE) | `0012_create_clients.ts`, `src/modules/clients` | **Extend** into SaaS customer registry (§8.1). |
| Subscription | `subscriptions` (client_id, code, plan_code, status PENDING/ACTIVE/SUSPENDED/EXPIRED/CANCELLED, starts_at, ends_at) | `0013`, `src/modules/subscriptions` | **Extend** into canonical SaaS aggregate (§11). |
| License | `licenses` (subscription validity, one active per subscription) | `0014`, `src/modules/licenses` | Reuse unchanged; license validity stays part of effective-subscription resolution. |
| Capability catalogue | `modules` (code/name/status, authoritative, never hardcoded) | `0015`, `src/modules/modules` | Reuse as capability registry. Capability set per CR §9 is seeded as module rows (PROSPECT-safe seed, PART 02). |
| Entitlement | `module_entitlements` (subscription × module, status, period, one active per pair); `resolveEffectiveEntitlements` | `0016`, `src/modules/entitlements` | **Extend** with `source` + `limit_value` (§12). Resolver extended, never replaced. |
| Organizations | `organizations` (client-scoped, code unique per client) | `0020` | Reuse unchanged (tenant context unit). |
| Properties/Buildings | `0017`/`0018`, `user_building_assignments` (`0019`) | structure + assignment authorities | Reuse unchanged; provisioning targets them (§14). |
| Client configuration | `client_configurations` (JSONB key/value), lifecycle DRAFT→VALIDATED→PUBLISHED→ACTIVE→SUPERSEDED, preview, configuration_versions | `0246`–`0258`, BE-27 docs | Reuse for tenant-side configuration & branding. Platform configuration is a new platform-scoped table (§20) — the lifecycle pattern is copied, the tables are separate (different scope, different actors). |
| Feature-level configuration | `feature_entitlement_configurations` (client/module/feature ENABLED/DISABLED) | `0249` | Complements, does not replace, subscription entitlements: configuration can **further disable** an entitled feature at client/building scope; it can never grant a capability the subscription does not entitle. |
| Branding | `BRANDING.PROFILE` JSONB in `client_configurations` (brandName, logoReference, login/portal/report, theme tokens) | `src/modules/branding` | **Extend profile JSON** with `supportName`, `supportContact` (additive keys; validation updated; no schema change). Gatepro console branding is frontend-side, not stored here. |
| Currency | `currencies` (global, 9 codes, immutable code), `client_monetary_contexts`, `client_allowed_transaction_currencies`, FX authority | `0331`, `0333` | Reuse. SaaS billing currency must be an ACTIVE currency; customer `currency_code` references `currencies`. |
| Operational billing (NOT SaaS billing) | `tenant_invoices`, `invoice_payment_status`, `payment_receipts` (BE-19), vendor invoices, basic expenses, operational finance | BE-19/BE-17 modules | **Deliberately not reused** for SaaS billing: semantics are facility-operations charges (customer → tenant/vendor), the CR's SaaS invoice is Gatepro → customer. Separate tables (§15–§16). |
| Audit | `operational_events` + `recordOperationalEvent` (append-only, requestId correlation, sensitive-key scrub, outbox seam); authentication audit (0011) | `src/modules/operational-events/index.ts`, `0309` | **Extend**: `client_id` becomes nullable (platform-scope events). Single canonical store; no second audit table. |
| Events/outbox | Integration outbox (0306–0308) over `operational_events`; webhook delivery | `src/modules/integration-outbox` | Reuse. SaaS events enqueue outbox rows only when customer-scoped; platform-scope events (NULL client) skip fan-out. |
| Idempotency | `executeIdempotent` (actor + operationKey + Idempotency-Key, fingerprint, transaction-owning, replay + 409 conflict) | CR-BE-IDEMPOTENCY-CORE-01, `src/modules/request-idempotency` | **Reuse exclusively** for all commands in the §18 catalog. No second mechanism. |
| Transactions | `withTransaction` | `src/database/transaction.ts` | Reuse. All multi-step control-plane mutations run in one transaction. |
| Concurrency | No repository-standard optimistic versioning (targeted status checks + partial unique indexes only) | grep-verified | **Freeze a pattern** for SaaS commercial aggregates: `version` column + `expectedVersion` command field + 409 `VERSION_CONFLICT` (§17.3). Applied only to §17.3's aggregate list, not retrofitted across the business plane. |
| Scheduler | In-process due-job scheduler (disabled in tests) | `src/modules/due-job-scheduler` | Reuse for periodic commercial sweeps (§11.4). |
| Proving admin / users | `users` (global, not client-scoped), credentials, invitations (0010), `user_building_assignments` | `0002`, `src/modules/users`, `src/modules/invitations` | Reuse as provisioning primitives (§14). |

## 6. Identity / relationship model (frozen)

```text
SaasCustomer (clients, extended)
  ├── 1..n Subscription (subscriptions, extended)
  │        ├── 1 PricebookVersion (commercial snapshot reference)
  │        ├── 1 Package (edition reference)
  │        ├── 0..n License (validity)
  │        ├── 0..n ModuleEntitlement (capability + optional limit)
  │        ├── 0..n SubscriptionAddOn
  │        ├── 0..n SaasInvoice
  │        └── 0..n SaasPaymentRecord (via BillingAccount)
  ├── 1..n BillingAccount (initially 1:1; extensible)
  ├── 1..n Organization
  ├── 1..n Property → 1..n Building
  ├── 1..n User (via existing user/building/organization links)
  ├── 1..n ProvisioningRun
  ├── 1..n SupportSession (Gatepro actor → this customer's context)
  └── 1 BrandingProfile (existing BRANDING.PROFILE, extended JSON)
```

`SaasProduct → SaasPackage → (PackageFeature, PackageLimit)` and
`SaasPricebook → SaasPricebookVersion → SaasPriceItem` are platform-global
reference data (no customer FK).

`ProductAddOn` is platform-global; `SubscriptionAddOn` binds a
`ProductAddOn` to one `Subscription`.

## 7. SaaS Customer (extension of `clients`) — PART 01

### 7.1 Columns (additive migration)

| Column | Type | Notes |
|---|---|---|
| `display_name` | TEXT NULL | Console-friendly name; `name` remains the canonical legal name. |
| `billing_email` | TEXT NULL | Normalized lowercase; unique index (partial, WHERE NOT NULL). |
| `billing_phone` | TEXT NULL | E.164 normalization. |
| `address` | TEXT NULL | Free-text street address. |
| `country` | VARCHAR(2) NULL | ISO-3166-1 alpha-2, uppercased. |
| `currency_code` | VARCHAR(3) NULL → `currencies(code)` | Billing default currency; must be ACTIVE. |
| `timezone` | TEXT NULL | IANA name (e.g. `Asia/Jakarta`). |
| `status` | TEXT | Lifecycle extended (§7.2). |

`code` remains the stable machine identifier (`customerCode`), uppercase-
normalized — unchanged semantics. `legal_name`, `tax_id` unchanged
(`taxIdentity`). No existing row is rewritten.

### 7.2 Customer lifecycle (server-authoritative)

```text
PROSPECT → TRIAL → ACTIVE → GRACE → SUSPENDED → TERMINATED
            │          │          │           │
            └────────────────────┴───────────┴──→ TERMINATED (direct, authorized)
                        ACTIVE ⇄ GRACE (billing-driven, see §11.4)
```

- `PROSPECT`: created, not yet subscribed (pre-sales).
- `TRIAL`: an active trial subscription exists (derived, set by subscription
  transitions — the customer status is a projection of its best subscription,
  always computed server-side).
- `ACTIVE`: at least one ACTIVE subscription, billing healthy.
- `GRACE`: best subscription in GRACE.
- `SUSPENDED`: best subscription SUSPENDED.
- `TERMINATED`: no active commercial relationship; data retention concerns
  are **out of scope** (separate retention lifecycle, CR §17).
- Legacy `ACTIVE`/`INACTIVE` rows remain valid values; `INACTIVE` maps to
  `TERMINATED` in console projections but is never newly written.

Status changes are only made by the subscription-lifecycle service (billing
drives customer status), never by direct console PATCH. `PATCH
/platform/customers/:id` updates registry fields only (§19).

## 8. Platform IAM — PART 01

### 8.1 Platform actor definition

A **platform actor** is an authenticated User whose effective active
permission set contains at least one `platform.*` permission. The concept is
permission-set based (consistent with existing RBAC) — no new user flag, no
new user table.

### 8.2 Permission catalogue (frozen codes)

| Code | Grants |
|---|---|
| `platform.customer.read` | Read customers, provisioning status, customer-scoped commercial data |
| `platform.customer.manage` | Create/update customer registry fields |
| `platform.product.read` | Read products, packages, features, limits, add-ons |
| `platform.product.manage` | Mutate product catalog / packages / add-ons |
| `platform.pricebook.read` | Read pricebooks, versions, items |
| `platform.pricebook.manage` | Create pricebook versions, publish, supersede |
| `platform.subscription.read` | Read subscriptions, entitlements, health, usage |
| `platform.subscription.manage` | Create subscriptions, lifecycle commands (activate/suspend/reactivate/cancel/terminate/renew), entitlement overrides |
| `platform.provisioning.execute` | Execute provisioning command |
| `platform.billing.read` | Read billing accounts, invoices |
| `platform.billing.manage` | Create billing accounts, issue/void invoices, record usage |
| `platform.payment.read` | Read payment records & allocations |
| `platform.payment.reconcile` | Reconcile payments (allocation + billing consequences) |
| `platform.usage.read` | Read usage meters/records/aggregations (redundant with `platform.subscription.read`; kept for independent grantability) |
| `platform.health.read` | Tenant health projection |
| `platform.reporting.read` | Commercial dashboard projection (MRR/ARR/…) |
| `platform.support.access` | Open/close support sessions |
| `platform.configuration.manage` | Mutate platform configuration |
| `platform.audit.read` | Read canonical audit (control-plane events) |

Rules:

1. **All `platform.*` codes enter `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`**
   — never inherited by `PLATFORM_ADMIN` or any existing role. Granting them
   is always a deliberate administrative act (repo precedent: `rfq.award`,
   `price_catalog.override`, `fx_rate.approve`, `operational_budget.override`).
2. No existing permission is renamed or removed.
3. A `platform.*` permission grants no business-plane authority, and no
   business-plane permission grants platform access (enforced per-route;
   §3).
4. `platform.audit.read` is the only platform read over the audit store;
   authentication audit stays under `auth.audit.read`.

## 9. Product catalog — PART 02

### 9.1 `saas_products`

`id`, `code` (unique, e.g. `ASENTRA`), `name`, `description`, `status`
(`ACTIVE`/`INACTIVE`), timestamps. Platform-global.

### 9.2 `saas_packages`

`id`, `product_id` (FK), `code` (unique per product: `STARTER` / `STANDARD` /
`PROFESSIONAL` / `ENTERPRISE` seeded), `name`, `description`, `status`,
timestamps. A package is an **edition definition** — features + limits +
default add-on eligibility. Packages are never hardcoded in any consumer;
the business plane resolves entitlements only through
`Subscription → Package → (features, limits)`.

### 9.3 `package_features`

`id`, `package_id`, `capability_code` (must exist in `modules` catalogue),
`enabled` (bool, default true), timestamps, unique `(package_id,
capability_code)`. This is the declarative grant list resolved at
subscription activation (§12.1).

### 9.4 `package_limits`

`id`, `package_id`, `limit_key`, `limit_value` (BIGINT), `unit` (TEXT),
timestamps, unique `(package_id, limit_key)`. Canonical `limit_key`
vocabulary (frozen; extensible only by CR amendment):

`building.count`, `user.count`, `active.asset.count`, `monthly.wo.count`,
`storage.bytes`, `api.requests`, `integration.count`, `ai.usage`.

### 9.5 `product_add_ons`

`id`, `product_id`, `code` (unique per product), `name`, `description`,
`status`, `entitlement_effects` (JSONB: `[{capabilityCode, action:
"ENABLE"|"LIMIT", limitKey?, limitValue?}]`), `quota_effects` (JSONB:
`[{limitKey, deltaValue}]`), timestamps. Add-ons grant entitlement/quotas
without creating packages (CR §19).

## 10. Versioned pricebook — PART 02

### 10.1 `saas_pricebooks`

`id`, `code` (unique), `name`, `currency_code` (default currency for items),
`status` (`ACTIVE`/`INACTIVE`), timestamps.

### 10.2 `saas_pricebook_versions`

`id`, `pricebook_id`, `version_number` (int, unique per pricebook,
monotonic), `status` (`DRAFT`/`PUBLISHED`/`SUPERSEDED`), `effective_from`
(tstz), `effective_to` (tstz NULL), `published_at`, `published_by_user_id`,
timestamps.

- A version is immutable once `PUBLISHED` (enforced by trigger + service).
- Publishing a new version for the same pricebook supersedes the previous
  `PUBLISHED` version's `effective_to` (single-publish invariant, partial
  unique index `WHERE status = 'PUBLISHED'` on `(pricebook_id)` — at most one
  live published version per pricebook at any moment).
- **Historical pricing is immutable:** subscriptions reference the
  `pricebook_version_id` effective at creation/renewal; republishing never
  restates existing subscriptions or invoices.

### 10.3 `saas_price_items`

`id`, `pricebook_version_id`, `product_id`, `package_id` (nullable for
platform-wide items), `currency_code`, `billing_cycle` (`MONTHLY`/`ANNUAL`/
`CUSTOM`), `base_price` (NUMERIC(18,2) ≥ 0), `included_building_count` (INT
≥ 0, default 0), `additional_building_price` (NUMERIC(18,2) ≥ 0, default 0),
timestamps. Unique per `(pricebook_version_id, product_id, package_id,
billing_cycle)`. Rows immutable with the version.

### 10.4 Price resolution rule (frozen)

For a subscription: resolve the `SaasPriceItem` from its
`pricebook_version_id` by `(product, package, currency, billingCycle)`.
Missing item → subscription creation in DRAFT is still allowed, but
activation and invoice generation are blocked with a `PRICE_ITEM_MISSING`
error (fail loud, never guess a price).

## 11. Subscription lifecycle — PART 03 / PART 08

### 11.1 Columns (additive migration to `subscriptions`)

| Column | Type | Notes |
|---|---|---|
| `package_id` | UUID NULL → `saas_packages(id)` | Edition reference. |
| `pricebook_version_id` | UUID NULL → `saas_pricebook_versions(id)` | Commercial snapshot reference. |
| `billing_cycle` | TEXT NULL (`MONTHLY`/`ANNUAL`/`CUSTOM`) | NULL for legacy rows. |
| `currency_code` | VARCHAR(3) NULL → `currencies(code)` | NULL for legacy rows. |
| `trial_end_date` | TIMESTAMPTZ NULL | Trial window end. |
| `current_period_start` | TIMESTAMPTZ NULL | Current billing period. |
| `current_period_end` | TIMESTAMPTZ NULL | |
| `renewal_date` | TIMESTAMPTZ NULL | Next renewal due. |
| `grace_until` | TIMESTAMPTZ NULL | Grace deadline. |
| `cancelled_at` | TIMESTAMPTZ NULL | |
| `terminated_at` | TIMESTAMPTZ NULL | |
| `version` | INTEGER NOT NULL DEFAULT 1 | Optimistic concurrency (§17.3). |

`plan_code` stays (legacy reference, now informational only; new writes may
leave it as a display alias of the package code — server-filled, not a
driver of anything).

### 11.2 Canonical status & transitions (server-authoritative)

```text
DRAFT ──activate──▶ TRIAL ──trial-convert──▶ ACTIVE
  │                                            │  ▲
  │cancel                                      ▼  │ reactivate (payment resolved
  ▼                                          PAST_DUE │  + approval, §11.5)
CANCELLED ◀──cancel──┐                          │  │
                                       grace elapses │  │ grace begins
  ▲                   │                          ▼  │
  │                   │◀─────────────────  GRACE ──┘
  │                   ▼
  │              SUSPENDED ──reactivate──▶ ACTIVE
  │                   │
  └───────────────────┴──terminate──▶ TERMINATED
       (any non-terminal status → TERMINATED, authorized)
```

Allowed transitions (frozen; anything else is a 409
`SUBSCRIPTION_TRANSITION_NOT_ALLOWED` with the expected state in `details`):

| From | To | Trigger |
|---|---|---|
| DRAFT | TRIAL | `activate` command (trial: `trial_end_date` set) |
| DRAFT | ACTIVE | `activate` command (paid: period + pricebook ref present) |
| TRIAL | ACTIVE | `convert` command (subscription → paid terms) |
| ACTIVE | PAST_DUE | `renewal_date` passed without paid renewal (scheduler/command) |
| PAST_DUE | GRACE | grace period begins (server, per policy) |
| GRACE | SUSPENDED | `grace_until` passed (scheduler/command) |
| GRACE | ACTIVE | payment reconciled (§15.4) |
| PAST_DUE | ACTIVE | payment reconciled (§15.4) |
| SUSPENDED | ACTIVE | `reactivate` command (§11.5) |
| ACTIVE/PAST_DUE/GRACE/SUSPENDED | CANCELLED | `cancel` command (cancels at period end) or immediate per input |
| DRAFT | CANCELLED | `cancel` command |
| any non-terminal | TERMINATED | `terminate` command (terminal, irreversible) |
| CANCELLED | TERMINATED | `terminate` command |

Rules:

1. **Only registered command endpoints** cause transitions; each transition is
   validated against this table inside a single transaction with
   `expectedVersion` optimistic check. There is no generic
   "set status" API on `/platform/subscriptions` (contrast: the legacy
   `PATCH /subscriptions/:id/status` business-plane route is **left untouched**
   for existing consumers — it remains a business-plane surface governed by
   `subscription.manage`; new SaaS consumers must use the control-plane
   commands).
2. Every transition writes a canonical audit event (§15.2) and a
   `SAAS_SUBSCRIPTION_*` operational event (§22.2).
3. Entitlements are **recomputed** on every transition (revoke on
   CANCELLED/TERMINATED; restore on ACTIVE/reactivate) — never manually
   desynced from state.
4. Customer status is reprojected from all its subscriptions after each
   transition (§7.2).

### 11.3 Renewal

- `renew` command: extends `current_period_*` and `renewal_date` by
  `billing_cycle`; commercial terms stay on the **same** `pricebook_version_id`
  unless the command explicitly carries a new version reference (a deliberate
  change, audited with `reason`).
- `CUSTOM` cycles require explicit `period_end` in the command.
- Renewal never restates the pricebook; it reads the item price from the
  version bound to the subscription at renewal time.

### 11.4 Billing policy sweep (scheduler)

A due-job (registered with the existing scheduler, disabled in tests) runs
periodically and, in a single transaction per subscription:

1. `ACTIVE` with `renewal_date < now` and unpaid invoice → `PAST_DUE`.
2. `PAST_DUE` older than platform-configured `past_due_grace_days` → `GRACE`
   with `grace_until = now + grace_period_days`.
3. `GRACE` with `grace_until < now` → `SUSPENDED`.
4. `TRIAL` with `trial_end_date < now` and no paid conversion → `SUSPENDED`
   (trial lapsed) — or policy-configured fallback.

All dates/periods come from `platform_configurations` (§20); the sweep is
idempotent (state-checked, version-checked).

### 11.5 Reactivation

`reactivate` command requires, in order:

1. subscription in SUSPENDED (or GRACE per policy);
2. billing resolved (no outstanding SaaS invoice) **or** an explicit
   `overrideReason` (contract adjustment / authorized override) — override is
   mandatory-audited;
3. `expectedVersion` match;
4. audit event `SAAS_SUBSCRIPTION_REACTIVATED`.

## 12. Entitlement, limits, quota — PART 04 / PART 09

### 12.1 Entitlement resolution (frozen algorithm)

Effective entitlements for a subscription (extended
`resolveEffectiveEntitlements`):

```text
if subscription not effective (existing isSubscriptionEffective) → ∅
else
  base  = ACTIVE module_entitlements within period (existing)
  for each base:
    source ∈ {PACKAGE, ADD_ON, OVERRIDE, PROMOTION, MANUAL}
    limit = entitlement.limit_value
            ?? add-on quota delta (sum of active SubscriptionAddOn effects
                matching the capability's package limit key)
            ?? package_limits(package_id, limit_key)
  feature configuration (feature_entitlement_configurations) may DISABLE a
    feature at client/building scope — it can never ENABLE beyond the set above
```

- `module_entitlements.source`: `MANUAL` (legacy/default) — existing rows
  stay `MANUAL`; new rows created by package resolution are `PACKAGE`;
  add-ons `ADD_ON`; console overrides `OVERRIDE` (audit + reason); campaigns
  `PROMOTION`.
- The **one-active-per-(subscription, capability)** invariant is preserved
  (existing partial unique index).
- `module_entitlements` gains nullable `limit_value BIGINT` (0 = unlimited).

PART 13C PART 01C add-on interaction rules (minimum clarification):

- If the current ACTIVE source is `PACKAGE`, an `ADD_ON` attach may
  SUSPEND the PACKAGE row and materialize `source='ADD_ON'` as the
  one-active grant; on detach, PACKAGE is re-materialized through
  the canonical `syncPackageEntitlements` seam (PART 04).
- If the current ACTIVE source is `ADD_ON`, the binding uniqueness
  rule (one ACTIVE binding per `(subscription_id, add_on_id)`) rejects
  a duplicate attach with canonical generic 409 CONFLICT — no second
  ACTIVE grant is created.
- If the current ACTIVE source is `OVERRIDE`, `PROMOTION`, or
  `MANUAL`, an `ADD_ON` attach MUST NOT displace that authority. The
  attach command fails with canonical generic 409 CONFLICT; the
  protected row remains `ACTIVE` and no entitlement rows are written
  for the targeted capability. No new precedence engine is created —
  the one-active invariant is preserved by the failure path.
- On `ADD_ON` detach: the ACTIVE `ADD_ON` row is SUSPENDED; PACKAGE
  authority is restored via `syncPackageEntitlements` (existing
  PART 04 re-materialization). `OVERRIDE`/`PROMOTION`/`MANUAL`
  history is preserved unchanged — they are NEVER reactivated by the
  add-on path because the attach never suspended them.

PART 13C PART 01C quota formula clarification:

The §12.1 `??` chain is interpreted as the precedence among three
limit sources for a given `(subscription, limitKey)`:

1. If `module_entitlements.limit_value` is non-null on the active
   row for the capability whose `package_limits` row carries
   `limit_key`, that value is authoritative. (A capability-level
   override supersedes everything below.)
2. Otherwise, the effective limit is the package base (`package_limits`
   row for the bound package) PLUS the sum of ACTIVE add-on quota
   deltas whose `limitKey` matches: `packageBase + SUM(deltaValue)`
   across every ACTIVE `saas_subscription_add_ons` joined to its
   `product_add_ons.quota_effects` where `limitKey` matches. The
   add-on quota delta is **additive** to the package base — `delta`
   in `quota_effects.deltaValue` denotes the increment the add-on
   grants above the package.
3. Otherwise (no row, no package base), no effective limit is
   published.

Detach semantics follow from query-time computation: a detached
binding transitions `saas_subscription_add_ons.status` to
`REMOVED`, so the SUM no longer includes its `deltaValue`. No
quota history deletion is required and no separate quota table
is created.

### 12.2 Business-plane enforcement seam (frozen)

1. Capability check: a business-plane operation for capability `C` in the
   caller's customer context must call the central
   `resolveCapabilityAccess(customerId, capabilityCode)` (new service over the
   §12.1 algorithm; reuses the existing resolver, never reimplements it).
   Hiding UI is not enforcement (governance).
2. Quota check: a business-plane mutation creating a counted resource calls
   `assertQuotaAvailable(customerId, limitKey)` → compares
   `saas_usage_aggregations` (BILLING_PERIOD scope) + current in-flight
   count against the effective limit (§12.1). Over-quota mutation → 409
   `QUOTA_EXCEEDED` with `{limitKey, limit, used}`.
3. Suspension policy: when the caller's customer is SUSPENDED, the
   `suspended_access_policy` platform setting (§20) applies:
   `READ_ONLY` → mutations 403 `SUBSCRIPTION_SUSPENDED`, reads allowed;
   `LIMITED_ACCESS` → only the platform-configured read+explicit allowlist;
   `FULL_BLOCK` → all business-plane API 403 `SUBSCRIPTION_SUSPENDED`.
   Platform (`/platform/*`) is unaffected. Enforcement is a reusable guard
   evaluated in middleware for the business plane; policy is backend
   authoritative, never client-supplied.
4. The business plane does **not** compute entitlements from
   `plan_code`, role, or any frontend field.

### 12.3 Usage metering (PART 09)

- `saas_usage_meters` (platform-global meter definitions): `id`, `meter_key`
  (unique; aligned to `limit_key` where a meter feeds a limit), `name`,
  `unit`, `period_types` (JSONB subset of `DAILY`/`MONTHLY`/`BILLING_PERIOD`),
  `status`.
- `saas_usage_records` (append-only): `id`, `customer_id`, `building_id`
  (nullable), `meter_key`, `quantity` (NUMERIC ≥ 0), `scope`
  (`CURRENT`/`DAILY`/`MONTHLY`/`BILLING_PERIOD`), `period_start`,
  `period_end`, `source` (`BACKEND`/`TRUSTED_INTEGRATION`),
  `source_reference` (dedup key), `recorded_by_user_id` (nullable),
  `created_at`. Unique `(customer_id, meter_key, scope, period_start,
  source_reference)` — double-recording is structurally impossible.
- `saas_usage_aggregations`: `id`, `customer_id`, `meter_key`, `scope`,
  `period_start`, `period_end`, `total_quantity`, `record_count`,
  `updated_at`; unique per `(customer_id, meter_key, scope, period_start,
  period_end)`; maintained transactionally with records.
- **Producer rule:** usage values come from backend operations (e.g. building
  creation, WO creation, storage events) or trusted integration callbacks —
  never from frontend-reported quantities. The `POST /platform/usage/records`
  API is for trusted producers only (`platform.billing.manage`).
- Quota projection: `GET /platform/customers/:id/usage` and `GET
  /me/usage` return per-meter `{limit, used, available, periodStart,
  periodEnd}` (CR §10 example: limit 20, used 17, available 3).

## 13. Provisioning — PART 05

### 13.1 Command

`POST /api/v1/platform/customers/:customerId/provision`
(permission `platform.provisioning.execute`, `Idempotency-Key` required,
body: `{ organizationCode?, organizationName?, buildingCode?,
buildingName?, adminEmail?, adminName?, reason?, expectedVersion? }`).

### 13.2 Workflow (single transaction per attempt; idempotent)

```text
1. verify customer exists, status in {PROSPECT, TRIAL, ACTIVE}, version match
2. resolve/keep Organization   (code-anchored: same code ⇒ same org)
3. resolve/keep Property + initial Building (code-anchored)
4. resolve/keep initial admin User (email-anchored; invite if INVITED)
5. apply initial building assignment for the admin
6. apply default tenant configuration (defaults from platform_configurations)
7. mark customer provisioning COMPLETED
```

- **Idempotency:** `executeIdempotent` with operation key
  `saas.customer.provision`; replay returns the stored success. Within a run,
  each step is anchored on a stable natural key (org code, building code,
  admin email) — a retry after partial failure converges to the same
  resources and **never duplicates** tenant/org/building/admin.
- **Status:** `saas_provisioning_runs` (one row per idempotency claim):
  `id`, `customer_id`, `status` (`RUNNING`/`COMPLETED`/`FAILED`),
  `attempt`, `steps` (JSONB per-step `{name, status, naturalKey, resourceIds,
  error?}`), `last_error`, `completed_at`, timestamps. Console reads run
  status via `GET /platform/customers/:id/provisioning`.
- **Audit:** `SAAS_TENANT_PROVISIONED` (+ per-step metadata) on success;
  `SAAS_TENANT_PROVISIONING_FAILED` with `last_error` on failure — failure is
  diagnosable from the run record + audit (no silent failure).
- Provisioning does **not** create a subscription (subscription creation is a
  separate command, §11); it initializes the operational context the
  subscription will entitle.

## 14. Billing account & SaaS invoice — PART 06

### 14.1 `saas_billing_accounts`

`id`, `customer_id` (FK), `legal_name`, `tax_identity`, `billing_address`
(JSONB), `billing_email`, `currency_code` (→ `currencies`), `payment_terms`
(days, INT, default 30), `status` (`ACTIVE`/`INACTIVE`), timestamps. Partial
unique index: at most one `ACTIVE` account per customer initially; the
schema supports multiple accounts (future multi-billing-relationship without
tenant-model change, CR §13).

### 14.2 `saas_invoices`

`id`, `number` (unique, server-generated `SAAS-YYYY-NNNNNN`),
`billing_account_id`, `customer_id`, `subscription_id` (nullable for
adjustments), `period_start`, `period_end`, `currency_code`,
`base_amount`, `tax_amount`, `total_amount` (NUMERIC(18,2) ≥ 0), `status`,
`issued_at`, `due_at`, `paid_at`, `voided_at`, `void_reason`, `version`,
timestamps.

### 14.3 `saas_invoice_lines`

`id`, `invoice_id`, `line_type`
(`BASE_SUBSCRIPTION`/`ADDITIONAL_BUILDING`/`ADD_ON`/`USAGE`/`DISCOUNT`/
`ADJUSTMENT`/`TAX`), `description`, `quantity` (NUMERIC), `unit_amount`
(NUMERIC(18,2)), `amount` (NUMERIC(18,2)), `currency_code`,
`reference_type`/`reference_id` (provenance: subscription/add-on/usage
aggregation), timestamps. Line amounts must sum to invoice totals (checked at
issue). Invoices are immutable once `ISSUED` (corrections = new `ADJUSTMENT`
line invoice or `VOID`).

### 14.4 Invoice lifecycle (frozen)

```text
DRAFT → ISSUED → PARTIALLY_PAID → PAID
         │
         ├─► OVERDUE (due_at passed, unpaid) ─► PAID (late payment)
         └─► VOID (authorized, reason, terminal)
```

- `issue` command: `Idempotency-Key`, `expectedVersion`, price resolution per
  §10.4 (BASE_SUBSCRIPTION from the bound version item;
  ADDITIONAL_BUILDING for buildings beyond `included_building_count`;
  ADD_ON lines from active add-ons; USAGE lines from the previous period's
  `saas_usage_aggregations`). Audit `SAAS_INVOICE_ISSUED`.
- Status transitions only via commands/reconciliation; no generic status PATCH.
- `OVERDUE` drives subscription `PAST_DUE` per §11.4.

## 15. Payment & reconciliation — PART 07

### 15.1 `saas_payment_records`

`id`, `billing_account_id`, `provider_type`
(`MANUAL_TRANSFER`/`VIRTUAL_ACCOUNT`/`QRIS`/`CARD`/`PAYMENT_GATEWAY`/`OTHER`),
`provider_name`, `provider_reference` (unique per provider), `amount`
(NUMERIC(18,2) > 0), `currency_code`, `received_at`, `status`
(`PENDING`/`RECONCILED`/`REJECTED`), `rejection_reason`, `reconciled_by_user_id`,
`reconciled_at`, `version`, timestamps.

### 15.2 `saas_payment_allocations`

`id`, `payment_id`, `invoice_id`, `amount`, `created_at`,
`created_by_user_id`; unique `(payment_id, invoice_id)`. Sum of allocations ≤
payment amount; allocation to a fully-paid invoice is rejected.

### 15.3 `saas_payment_provider_references`

Provider-event log (append-only): `id`, `payment_id` (nullable),
`provider_type`, `external_reference`, `event_type`, `payload` (JSONB,
scrubbed), `received_at`. Provider integration sits behind the **Payment
Provider Port** (§22.3); no vendor dependency in the core.

### 15.4 Reconciliation flow (frozen, CR §15)

```text
Provider event / manual record   →  saas_payment_records (PENDING)
reconcile command (idempotent)   →  allocations (payment → invoices)
                                  →  invoice status (PARTIALLY_PAID/PAID)
                                  →  billing state (customer/subscription)
                                  →  subscription consequence (§11.4/§16.4)
```

- `POST /platform/payments/:paymentId/reconcile` —
  `platform.payment.reconcile`, `Idempotency-Key`, `expectedVersion`,
  body `{ allocations: [{invoiceId, amount}], reason? }`. One transaction:
  validate invoices belong to the same customer/billing account & currency,
  apply allocations, update invoice statuses, audit `SAAS_PAYMENT_RECONCILED`,
  then subscription consequence (unpaid→paid may clear PAST_DUE/GRACE per
  §11.2; SUSPENDED reactivation still requires the explicit `reactivate`
  command — reconciliation never auto-reactivates).
- A provider callback can only **create** a PENDING payment record; it can
  never mutate invoices/subscriptions directly (CR §15 rule).

## 16. Grace, suspension & access policy — PART 08

- Lifecycle per §11.4; policy parameters from `platform_configurations`.
- **Suspension never deletes customer data** (CR §17); retention is a
  separate concern.
- Business-plane behavior while suspended per `suspended_access_policy`
  (§12.2.3). The policy value is part of every suspended-customer error
  response `details` so consumers know the mode.
- Reactivation per §11.5 (audit-mandatory, override-reason-mandatory).

## 17. Cross-cutting standards

### 17.1 Error semantics

Additive `ERROR_CODES` (exact strings frozen):

`SAAS_CUSTOMER_NOT_FOUND`, `SAAS_CUSTOMER_CODE_ALREADY_EXISTS`,
`SAAS_CUSTOMER_STATUS_NOT_ALLOWED`, `SAAS_PRODUCT_NOT_FOUND`,
`SAAS_PACKAGE_NOT_FOUND`, `SAAS_PACKAGE_CODE_ALREADY_EXISTS`,
`SAAS_PRICEBOOK_NOT_FOUND`, `SAAS_PRICEBOOK_VERSION_NOT_FOUND`,
`SAAS_PRICE_ITEM_NOT_FOUND`, `SAAS_ADD_ON_NOT_FOUND`,
`SAAS_SUBSCRIPTION_NOT_FOUND`, `SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED`,
`SAAS_SUBSCRIPTION_TRIAL_INVALID`, `SAAS_ENTITLEMENT_NOT_FOUND`,
`SAAS_BILLING_ACCOUNT_NOT_FOUND`, `SAAS_INVOICE_NOT_FOUND`,
`SAAS_INVOICE_STATUS_NOT_ALLOWED`, `SAAS_PAYMENT_NOT_FOUND`,
`SAAS_PAYMENT_ALREADY_RECONCILED`, `SAAS_USAGE_METER_NOT_FOUND`,
`SAAS_USAGE_RECORD_DUPLICATE`, `SAAS_PROVISIONING_NOT_FOUND`,
`SAAS_PROVISIONING_IN_PROGRESS`, `SAAS_PLATFORM_CONFIG_NOT_FOUND`,
`SAAS_SUPPORT_SESSION_NOT_FOUND`, `SAAS_SUPPORT_SESSION_EXPIRED`,
`SAAS_QUOTA_EXCEEDED`, `SAAS_SUBSCRIPTION_SUSPENDED`,
`VERSION_CONFLICT`.

`VERSION_CONFLICT` (409) carries `details: {version, expectedVersion}`.
`SAAS_QUOTA_EXCEEDED` (409) carries `{limitKey, limit, used}`.

### 17.2 Idempotency (CR §30)

Reuse `executeIdempotent` exclusively. Frozen operation-key catalog:

| Operation key | Endpoint |
|---|---|
| `saas.customer.create` | POST /platform/customers |
| `saas.customer.provision` | POST /platform/customers/:id/provision |
| `saas.subscription.create` | POST /platform/subscriptions |
| `saas.subscription.activate` | POST /platform/subscriptions/:id/activate |
| `saas.subscription.reactivate` | POST /platform/subscriptions/:id/reactivate |
| `saas.invoice.issue` | POST /platform/invoices/:id/issue (and POST /platform/invoices for draft+issue) |
| `saas.payment.ingest` | POST /platform/payments |
| `saas.payment.reconcile` | POST /platform/payments/:id/reconcile |
| `saas.usage.record` | POST /platform/usage/records |

All other commands are naturally safe to retry (state-checked transitions)
and do not take `Idempotency-Key`.

### 17.3 Optimistic concurrency (CR §29)

Aggregates carrying `version INTEGER NOT NULL DEFAULT 1`:
`subscriptions`, `saas_invoices`, `saas_payment_records`,
`saas_billing_accounts`, `platform_configurations`.

Command contract: body field `expectedVersion` (integer, required for every
mutating command on these aggregates). Repository update is
`UPDATE … SET …, version = version + 1 WHERE id = $1 AND version =
$expected`; zero rows → 409 `VERSION_CONFLICT`. Reads always return
`version`. No silent last-write-wins on commercial state.

### 17.4 Pagination & filtering

All platform list endpoints: opt-in `page`/`pageSize` via
`shared/pagination.ts`; stable `ORDER BY created_at DESC, id`; filters are
explicit query params per endpoint (e.g. `status`, `customerId`,
`productId`, `periodStart/End`) — documented in OpenAPI.

## 18. Audit contract — canonical (CR §25)

### 18.1 Store

`operational_events` (extended: `client_id` nullable). `recordOperationalEvent`
accepts `clientId?: string | null`. Platform-scope events (product catalog,
pricebook, platform configuration, support sessions) use `client_id = NULL`,
`entity_type` = `SAAS_PRODUCT`/`SAAS_PACKAGE`/`SAAS_PRICEBOOK`/
`PLATFORM_CONFIGURATION`/`SUPPORT_SESSION`, etc. Customer-scoped events carry
the customer's `clientId` and fan out to the integration outbox as today;
platform-scope events skip outbox fan-out (no customer webhook).

### 18.2 Critical event catalogue (frozen names)

`SAAS_CUSTOMER_CREATED`, `SAAS_CUSTOMER_UPDATED`,
`SAAS_SUBSCRIPTION_CREATED`, `SAAS_SUBSCRIPTION_ACTIVATED`,
`SAAS_SUBSCRIPTION_CHANGED` (any transition, with `before`/`after` status in
metadata), `SAAS_SUBSCRIPTION_CANCELLED`, `SAAS_SUBSCRIPTION_TERMINATED`,
`SAAS_PACKAGE_CHANGED`, `SAAS_ENTITLEMENT_OVERRIDDEN`,
`SAAS_PRICE_CHANGED` (version publish/supersede),
`SAAS_INVOICE_ISSUED`, `SAAS_INVOICE_VOIDED`,
`SAAS_PAYMENT_RECORDED`, `SAAS_PAYMENT_RECONCILED`,
`SAAS_SUBSCRIPTION_PAST_DUE`, `SAAS_SUBSCRIPTION_SUSPENDED`,
`SAAS_SUBSCRIPTION_REACTIVATED`, `SAAS_TENANT_PROVISIONED`,
`SAAS_TENANT_PROVISIONING_FAILED`, `SAAS_SUPPORT_ACCESS_STARTED`,
`SAAS_SUPPORT_ACCESS_ENDED`, `SAAS_PLATFORM_CONFIG_CHANGED`,
`SAAS_ADD_ON_CHANGED` (PART 13C PART 01C — platform-scope; add-on
catalogue create/update; `metadata.action ∈ {CREATED, UPDATED}`,
`metadata.addOnId`, `metadata.productId`, `metadata.before`/`metadata.after`
where applicable),
`SAAS_SUBSCRIPTION_ADD_ON_CHANGED` (PART 13C PART 01C — customer-scoped;
subscription add-on attach/detach; `metadata.action ∈ {ATTACHED, DETACHED}`,
`metadata.subscriptionId`, `metadata.addOnId`,
`metadata.before`/`metadata.after` binding state,
`metadata.expectedVersion`/`metadata.resultingVersion` where applicable).
The PART 13C PART 01C amendment adds the two events above to close
`ADDON_AUDIT_EVENT_GAP`; no other §18.2 entry is reused or repurposed
for add-on mutations.

### 18.3 Record content

Every control-plane mutation audit carries: actor
(`actor_user_id`), authority (the `platform.*` permission used — stored in
`metadata.authority`), customer (`client_id` when scoped), tenant context
(`metadata.organizationId/buildingId` when relevant), resource
(`entity_type`/`entity_id`), action (`event_type`), before/after
(`metadata.before`/`metadata.after` — non-sensitive field snapshots), reason
(`metadata.reason`, mandatory for overrides/reactivations/voids),
`request_id` (existing correlation), timestamp (`occurred_at`).

Read API: `GET /platform/audit` (`platform.audit.read`), filterable by
`customer_id`, `entity_type`, `event_type`, `actor_user_id`, time range;
paginated per §17.4. Authentication audit (`/audit`, `auth.audit.read`) is
unchanged.

## 19. Support access — PART 11

### 19.1 `platform_support_sessions`

`id`, `support_actor_user_id` (Gatepro user), `customer_id` (target tenant
context), `building_id` (optional narrowing), `reason` (mandatory TEXT),
`started_at`, `expires_at` (mandatory, bounded), `ended_at`,
`ended_by_user_id`, `status` (`ACTIVE`/`ENDED`), timestamps. Unique active
session per `(support_actor_user_id, customer_id)`.

### 19.2 Rules (frozen, CR §24)

1. Explicit start: `POST /platform/support-sessions`
   (`platform.support.access`), body `{customerId, buildingId?, reason,
   durationMinutes}` (`durationMinutes` ≤ platform-configured maximum,
   default 480).
2. Explicit end: `DELETE /platform/support-sessions/:id` (owner or
   `platform.configuration.manage`) → `ended_at`, audit
   `SAAS_SUPPORT_ACCESS_ENDED`. Sessions auto-expire (liveness check at use;
   expired session ⇒ 403 `SAAS_SUPPORT_SESSION_EXPIRED`).
3. **No impersonation, ever.** A support session does not replace the
   identity of any tenant user. While a Gatepro actor performs control-plane
   work on the target customer under an active session, the audit record
   carries `metadata.supportSessionId` in addition to their real
   `actor_user_id` — real identity is always distinguishable from support
   identity.
4. Opening a session is audited (`SAAS_SUPPORT_ACCESS_STARTED`) with reason.
5. Support access does not bypass §12.2 suspension policy for business-plane
   data it inspects; it authorizes platform-console visibility into the
   customer's context only.

## 20. Platform configuration — PART 12

### 20.1 `platform_configurations`

`id`, `key` (unique), `value` (JSONB), `description`, `version` (optimistic,
§17.3), `updated_by_user_id`, timestamps. Platform-scoped (no customer).

### 20.2 Frozen initial keys

| Key | Value shape | Default |
|---|---|---|
| `saas.default_trial_days` | int | 14 |
| `saas.past_due_grace_days` | int | 7 (PAST_DUE → GRACE) |
| `saas.grace_period_days` | int | 14 (GRACE duration) |
| `saas.supported_currencies` | `[currencyCode]` | from ACTIVE `currencies` |
| `saas.supported_billing_cycles` | `[MONTHLY, ANNUAL, CUSTOM]` | all three |
| `saas.suspended_access_policy` | `READ_ONLY`/`LIMITED_ACCESS`/`FULL_BLOCK` | `FULL_BLOCK` |
| `saas.suspended_limited_allowlist` | `[routePattern]` | `[]` |
| `saas.support_session_max_minutes` | int | 480 |
| `saas.product_availability` | `[{productId, available: bool}]` | seeded product available |
| `saas.provider_enablement` | `[{providerType, enabled: bool}]` | all `false` (no live provider yet) |
| `saas.commercial_defaults` | `{paymentTermsDays, invoiceNumberPrefix}` | `{30, "SAAS"}` |

Mutations: `POST /platform/configuration/:key` /
`PATCH /platform/configuration/:key` (`platform.configuration.manage`,
`expectedVersion`, audit `SAAS_PLATFORM_CONFIG_CHANGED` with before/after).
Reads: `GET /platform/configuration[/:key]` — any platform actor (a user
holding at least one `platform.*` permission) may read configuration values;
the configuration store holds no secrets.

## 21. Tenant health & reporting projections — PART 10

### 21.1 `GET /platform/tenant-health` (`platform.health.read`)

Per customer (or `?customerId=`): overall status
`HEALTHY`/`DEGRADED`/`ACTION_REQUIRED`/`SUSPENDED` + component projections:

| Component | Source | Degraded when |
|---|---|---|
| subscription | subscription status/periods | PAST_DUE/GRACE; near-renewal (< 7d) |
| billing | SaaS invoices | OVERDUE or unpaid within due window |
| provisioning | latest provisioning run | FAILED |
| usage quota | quota projection | used ≥ 90% of any limit |
| configuration completeness | tenant configuration/branding presence | missing branding or required keys |
| integration failures | outbox/webhook delivery failures (customer-scoped) | recent FAILED deliveries |
| notification failures | notification delivery failures | recent failed deliveries |

No infrastructure secrets in responses (CR §20). Status derivation rules are
documented here and implemented as a single read-model service (never
computed by the console).

**Overall status precedence (PART 10 contract clarification, frozen):**

```
SUSPENDED > ACTION_REQUIRED > DEGRADED > HEALTHY
```

Rules (must be applied exactly):

- `SUSPENDED` only when the canonical PART 03 customer-subscription
  projection (`§11.2` rule 4 — `PROSPECT → TRIAL → ACTIVE → GRACE →
  SUSPENDED → TERMINATED`, healthy wins) is `SUSPENDED`. No other
  component may force `SUSPENDED`.
- Otherwise `ACTION_REQUIRED` if any available frozen component has
  `actionRequired = true`.
- Otherwise `DEGRADED` if any available frozen component has
  `degraded = true`.
- Otherwise `HEALTHY` only when **all required frozen components have
  authoritative sources that are assessable** (`sourceAvailable = true`)
  AND none is `degraded` or `actionRequired`. If any required
  component is missing its source, the overall result is **not**
  `HEALTHY` — the projection MUST additionally expose a top-level
  `complete: boolean` flag.

**Failure-window authority:** the `recent` term in §21.1 is
frozen but not quantified by the contract. PART 10A reads the
window from the platform configuration key
`saas.health.failure_lookback_days` (default 7 days, seeded by
PART 12 once the configuration seam is wired). PART 10A MUST NOT
hardcode the lookback duration in code.

**`configuration_completeness` source seam (PART 12 contract
clarification, frozen for §21.1):**

- Authoritative source: `client_configurations.key = 'BRANDING.PROFILE'`
  for the target customer. The `configuration_completeness`
  component is NEVER read from `platform_configurations` and NEVER
  from `saas.health.failure_lookback_days`.
- `sourceAvailable` is `true` when this seam is wired (PART 12B).
  A missing row is a real assessed failure (`degraded = true`),
  not a source gap.
- `degraded = true` when ANY of the following is true for the
  target customer:
  1. No `BRANDING.PROFILE` row exists for the customer.
  2. The `BRANDING.PROFILE` value is not a non-null object.
  3. The required-key set is incomplete (see below).
- Required-key set (the minimum keys whose presence + shape make
  a profile structurally complete):
  - `brandName` — non-empty string after trim.
  - `login` — object with at least one of `title`/`showLogo` set.
  - `portal` — object with at least one of `headerTitle`/`showLogo` set.
  - `report` — object with at least one of `headerText`/`showLogo` set.
  - `theme` — object containing `primaryColor` (string).
  The following keys are explicitly OPTIONAL for completeness:
  `logoReference` (nullable), `supportName` (nullable additive
  key from §5 row "Branding"), `supportContact` (nullable additive
  key from §5 row "Branding"). Their absence or `null` value does
  NOT degrade the component.
- Evidence reported on `degraded = true`:
  `{ reason: 'MISSING_PROFILE' | 'INVALID_PROFILE' | 'INCOMPLETE_PROFILE', missing: string[] }`
  where `missing` lists the required keys that are absent or
  invalid.

### 21.2 `GET /platform/reports/commercial-summary` (`platform.reporting.read`)

Documented formulas (frozen):

- **MRR** = Σ over ACTIVE subscriptions of `base_amount` normalized to a
  monthly figure (ANNUAL: annual/12; MONTHLY: as-is) in each subscription's
  currency, reported per currency; ARR = MRR × 12 (per currency; no FX
  conversion in this projection — FX is a separate authority, CR-BE-FX-01).
- **activeCustomers** = customers with ≥1 ACTIVE subscription.
- **trialCustomers** = customers with best subscription TRIAL.
- **activeSubscriptions / pastDueSubscriptions / suspendedSubscriptions** =
  status counts.
- **buildingsUnderSubscription** = Σ ACTIVE-subscription customers'
  buildings count (with per-customer breakdown).
- **outstandingInvoices** = Σ total_amount of ISSUED/PARTIALLY_PAID/OVERDUE
  SaaS invoices (per currency).
- **collectionStatus** = bucketed by invoice age (current / 1–30 / 31–60 /
  60+ days).
- **usageNearingLimit** = customers with any limit usage ≥ 90%.

The console must consume this endpoint for commercial metrics — it must not
recompute authoritative commercial metrics from raw calls (CR §33).

## 22. API surface (frozen initial contract)

Base: `/api/v1/platform` (registered by `createPlatformRouter`). Every route:
`authenticationMiddleware` + the listed `requirePermission`. "Idem." =
`Idempotency-Key` required. "ver" = `expectedVersion` required.

| Method & path | Permission | Idem./ver | Notes |
|---|---|---|---|
| GET /platform/customers | platform.customer.read | — | list; filters `status`, `q` (code/name) |
| POST /platform/customers | platform.customer.manage | Idem. | create customer (PROSPECT) |
| GET /platform/customers/:id | platform.customer.read | — | includes best subscription summary |
| PATCH /platform/customers/:id | platform.customer.manage | ver | registry fields only; **no status** |
| GET /platform/customers/:id/provisioning | platform.customer.read | — | latest + history runs |
| POST /platform/customers/:id/provision | platform.provisioning.execute | Idem. | §13 |
| GET /platform/customers/:id/usage | platform.usage.read | — | quota projection §12.3 |
| GET /platform/products | platform.product.read | — | |
| GET /platform/products/:id | platform.product.read | — | includes packages |
| POST /platform/products | platform.product.manage | — | |
| PATCH /platform/products/:id | platform.product.manage | — | |
| GET /platform/packages | platform.product.read | — | |
| POST /platform/packages | platform.product.manage | — | with features[] & limits[] nested |
| GET /platform/packages/:id | platform.product.read | — | |
| PATCH /platform/packages/:id | platform.product.manage | — | |
| GET /platform/add-ons | platform.product.read | — | |
| POST /platform/add-ons | platform.product.manage | — | |
| PATCH /platform/add-ons/:id | platform.product.manage | — | |
| GET /platform/pricebooks | platform.pricebook.read | — | |
| POST /platform/pricebooks | platform.pricebook.manage | — | |
| GET /platform/pricebooks/:id | platform.pricebook.read | — | with versions |
| POST /platform/pricebooks/:id/versions | platform.pricebook.manage | — | DRAFT version with items[] |
| POST /platform/pricebook-versions/:id/publish | platform.pricebook.manage | Idem. | publish (+ supersede previous) |
| GET /platform/subscriptions | platform.subscription.read | — | filters `customerId`, `status`, `packageId` |
| POST /platform/subscriptions | platform.subscription.manage | Idem. | DRAFT (customerId, productId, packageId, pricebookVersionId, billingCycle, currencyCode?, trial?) |
| GET /platform/subscriptions/:id | platform.subscription.read | — | full aggregate + version |
| PATCH /platform/subscriptions/:id | platform.subscription.manage | ver | non-status fields (renewal date, trial end) |
| POST /platform/subscriptions/:id/activate | platform.subscription.manage | Idem. | DRAFT→TRIAL/ACTIVE |
| POST /platform/subscriptions/:id/convert | platform.subscription.manage | Idem. | TRIAL→ACTIVE |
| POST /platform/subscriptions/:id/renew | platform.subscription.manage | ver | §11.3 |
| POST /platform/subscriptions/:id/cancel | platform.subscription.manage | ver | reason mandatory |
| POST /platform/subscriptions/:id/terminate | platform.subscription.manage | ver | reason mandatory; terminal |
| POST /platform/subscriptions/:id/reactivate | platform.subscription.manage | Idem. | §11.5 |
| GET /platform/subscriptions/:id/entitlements | platform.subscription.read | — | resolved entitlements incl. limits |
| POST /platform/subscriptions/:id/entitlements | platform.subscription.manage | ver | OVERRIDE (reason mandatory, audited) |
| POST /platform/subscriptions/:id/add-ons | platform.subscription.manage | ver | attach ProductAddOn |
| DELETE /platform/subscriptions/:id/add-ons/:addOnId | platform.subscription.manage | ver | detach |
| GET /platform/billing-accounts | platform.billing.read | — | |
| POST /platform/billing-accounts | platform.billing.manage | Idem. | |
| GET /platform/billing-accounts/:id | platform.billing.read | — | |
| PATCH /platform/billing-accounts/:id | platform.billing.manage | ver | |
| GET /platform/invoices | platform.billing.read | — | filters `customerId`, `status`, `periodStart/End` |
| POST /platform/invoices | platform.billing.manage | Idem. | DRAFT (or draft+issue) |
| GET /platform/invoices/:id | platform.billing.read | — | with lines |
| POST /platform/invoices/:id/issue | platform.billing.manage | Idem. | DRAFT→ISSUED |
| POST /platform/invoices/:id/void | platform.billing.manage | ver | reason mandatory |
| GET /platform/payments | platform.payment.read | — | filters `customerId`, `status` |
| POST /platform/payments | platform.billing.manage | Idem. | ingest PENDING record (manual or trusted provider) |
| GET /platform/payments/:id | platform.payment.read | — | with allocations |
| POST /platform/payments/:id/reconcile | platform.payment.reconcile | Idem. | §15.4 |
| POST /platform/payments/:id/reject | platform.payment.reconcile | ver | reason mandatory |
| GET /platform/usage/meters | platform.usage.read | — | |
| POST /platform/usage/meters | platform.billing.manage | — | meter definition |
| GET /platform/usage | platform.usage.read | — | filters `customerId`, `meterKey`, `scope`, `periodStart/End` |
| POST /platform/usage/records | platform.billing.manage | Idem. | trusted producers only |
| GET /platform/tenant-health | platform.health.read | — | §21.1 |
| GET /platform/reports/commercial-summary | platform.reporting.read | — | §21.2 |
| POST /platform/support-sessions | platform.support.access | — | §19 |
| GET /platform/support-sessions | platform.support.access | — | active/expired, filterable |
| DELETE /platform/support-sessions/:id | platform.support.access | — | explicit end |
| GET /platform/audit | platform.audit.read | — | §18.3 |
| GET /platform/configuration | platform.customer.read | — | all keys |
| GET /platform/configuration/:key | platform.customer.read | — | |
| POST /platform/configuration/:key | platform.configuration.manage | Idem. | create key |
| PATCH /platform/configuration/:key | platform.configuration.manage | ver | update value (OCC §17.3) |

Notes:

- No `DELETE` on customers/subscriptions (termination is a state, not a
  delete — CR §17).
- The legacy business-plane commercial routes (`/clients`, `/subscriptions`,
  `/licenses`, `/modules`, `/entitlements`) remain registered and functional
  for existing consumers; PART 13 reconciles their OpenAPI exposure but
  changes none of their behavior.

PART 13 contract alignment:

- `POST /platform/configuration/:key` is now `Idem.` (no `expectedVersion`).
  §17.3 OCC applies to mutation of an existing versioned aggregate; on a
  POST the aggregate is freshly created (no prior `version` exists, so the
  OCC predicate `WHERE version = $expected` is meaningless at creation
  time). The earlier `ver` marker conflicted with the create-vs-update
  semantics delivered and certified in PART 12. PART 13 aligns the marker
  with the canonical semantics: POST creates without OCC, PATCH requires
  `expectedVersion`. Runtime unchanged.

### 22.1 Tenant-side commercial projections (PART 10, business-plane auth)

| Method & path | Access |
|---|---|
| GET /me/subscription | authenticated user; resolves the user's accessible customers (BE-02G); returns each accessible customer's effective subscription summary (status, package code+name, billing cycle, period dates, renewal date) — only what the caller may see |
| GET /me/entitlements | same scope; resolved entitlements (capability codes, enabled, limit) for accessible customers — superset-compatible with the existing `GET /auth/me` entitlements, which remains unchanged |
| GET /me/usage | same scope; quota projection per §12.3 for accessible customers |

These projections are read-only, scoped, and must never expose another
customer's data (isolation tests mandatory).

## 23. Events / outbox (CR §31)

Event names in §18.2 are `operational_events.event_type` values (the
`SAAS_*` set). Critical transitions enqueue through the existing
`recordOperationalEvent` seam, so the integration outbox fan-out works
unchanged for customer-scoped events (customer webhooks may subscribe to
`SAAS_SUBSCRIPTION_*` types). Events are **projections, never authority** —
state always reads from the aggregates.

## 24. Integration boundary (CR §32)

```text
SaaS billing domain
      ↓  Payment Provider Port (interface in src/modules/saas-payments or
         shared port definition: record(providerType, externalReference,
         payload) → PENDING record; query(ref) → references)
      ↓  Provider Adapter (future CR; none enabled until
         saas.provider_enablement marks one enabled)
Vendor (bank transfer / VA / QRIS / card / gateway)
```

Core SaaS code contains no vendor SDK, endpoint, or credential. Accounting /
tax / CRM adapters follow the same port pattern in later CRs.

## 25. Compatibility & migration rules (CR §34)

1. All schema changes are additive migrations from 0360; no column is
   dropped, renamed, or re-typed in an existing table.
2. `clients.status` and `subscriptions.status` CHECK constraints are
   re-declared with the **superset** of old + new values.
3. No existing route's signature, permission, or behavior changes;
   business-plane resolvers keep their current signatures (new parameters,
   if any, are optional with the old behavior as default).
4. `plan_code` keeps its column and its "never a driver" rule.
5. Existing entitlement rows keep working: `source` defaults to `MANUAL`,
   `limit_value` defaults to NULL (= unlimited) — current behavior
   preserved.
6. `operational_events.client_id` NULL-allowing migration is a constraint
   drop, not a data rewrite; all existing rows retain their `client_id`.
7. OpenAPI: additive paths only for new PARTs; existing paths untouched.
8. Each PART ships with regression tests proving (a) existing business-plane
   flows pass, (b) the new invariants hold.

## 26. Open issues / decisions (frozen as decided at PART 00)

| # | Question | Decision |
|---|---|---|
| D1 | New audit table vs extend `operational_events`? | Extend (nullable `client_id`). Single canonical store; no duplicate audit infra. |
| D2 | `PLATFORM_ADMIN` gets `platform.*` by default? | No — `platform.*` unassigned by default (exceptional-authority precedent). |
| D3 | Reuse `tenant_invoices` for SaaS invoicing? | No — different counterparty semantics. New `saas_invoices`. |
| D4 | New `tenants` table? | No — tenant context = Client + its structure; no new tenant model. |
| D5 | Concurrency mechanism? | Explicit `version` + `expectedVersion` + 409, scoped to §17.3 aggregates only (no repo-wide retrofit). |
| D6 | Legacy `PENDING`/`EXPIRED` subscription statuses? | Readable, never newly written; `isSubscriptionEffective` already treats non-ACTIVE as ineffective, so behavior is unchanged. |
| D7 | Does reconciliation auto-reactivate? | No — explicit `reactivate` command only (policy + audit). |
| D8 | FX in commercial summary? | No — per-currency reporting; FX conversion stays with CR-BE-FX-01 authority. |
| D9 | Where do `plan_code`-era routes go? | Unchanged (business-plane compatibility); console uses `/platform/*`. |
| D10 | Trial expiry → ? | `SUSPENDED` (lapsed trial), platform-configurable later via amendment. |

## 27. PART → contract section map

PART 01: §7, §8, §17.1, §18, §22 (customers subset), §25
PART 02: §9, §10, §22 (catalog/pricebook subset)
PART 03: §11 (minus 11.4/11.5 enforcement), §17.2/17.3, §22 (subscriptions subset)
PART 04: §12.1–12.2, §9.5 (add-on binding)
PART 05: §13
PART 06: §14
PART 07: §15
PART 08: §11.4, §11.5, §16
PART 09: §12.3
PART 10: §21, §22.1
PART 11: §19
PART 12: §20, branding JSON extension (§5 row "Branding")
PART 13: §17, §18, §23, §24, OpenAPI parity
PART 14: §17 invariants regression + §22 full surface
