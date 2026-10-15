# CR-HM-FIN-AUTH-01 — Dedicated Commercial, Finance & Settlement Authority

Product decision: **Option B — explicit domain permissions.** Generic
`tenant_company.manage` alone no longer authorizes Handyman financial
mutations. This document is the finance endpoint inventory, permission
matrix, provisioning runbook and migration deployment note for the
change. It preserves all J01–J12 implementation from
CR-HM-E2E-LIFECYCLE-01 (PR #29) and secures both the 32 finance-close
routes and the already-merged customer-ledger payment routes.

## 1. Permissions (migration 0448, foundation seed catalogue)

| Permission | Business authority | Never implies |
|---|---|---|
| `handyman.commercial.manage` | Commercial agreement prepare/activate/supersede, labor & material pricing bases, BM-fee rule/term/beneficiary, service-warranty start/expire | Payment allocation, refund, settlement |
| `handyman.finance.read` | Handyman financial reads (scope transaction view, Client financial transactions, pricing-contract & BM-fee configuration reads) | Any mutation |
| `handyman.finance.manage` | Customer transaction open, charge composition, payment allocation, ledger refund/reversals/adjustment, entitlement derivation, payment verification (confirm/reject) | Settlement commands, commercial authoring |
| `handyman.settlement.manage` | Settlement prepare/include/reconcile/settle/correction/dispute-hold | Refund, allocation, correction of the ledger |

Rules enforced by the Backend:

- The four codes are registered by migration
  `0448_handyman_finance_authority_permissions` and the foundation seed
  catalogue, and are listed in `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`:
  **no role receives them automatically** — not Customer Care, Tenant
  PIC, Dispatcher, Crew Lead, generic Operations, and not
  PLATFORM_ADMIN. Every grant is a deliberate, audited administrative
  act (role assignment records actor and timestamp).
- A domain permission never bypasses Client / exact-Building scope:
  services still enforce `canAccessClient` /
  `canAccessBuildingScopedResource` from the authenticated actor.
- No caller-supplied role, actor, tenant or Building value can override
  authenticated authority; finance-close bodies keep strict allow-lists
  (unknown fields → 400).
- Rejected mutations persist zero financial changes (permission wall
  runs before any service write; proven by persisted-count assertions).
- Existing QC (`handyman.qc.*`), BAST (`handyman.bast.manage`), Work
  Session and commercial lifecycle guards are unchanged.

## 2. Endpoint inventory

All finance-close routes live in
`src/modules/handyman-finance-close-api/handyman-finance-close-api.routes.ts`
and are documented per-route in `docs/api/openapi.yaml`. Success is
HTTP 200 `{ success, data }`; money is canonical decimal strings; every
mutating route requires a single-use `idempotencyKey` (replay returns
the original result, key rebinding → 409).

| # | Route | Permission | Scope | Side effects |
|---|---|---|---|---|
| 1 | `POST /handyman/commercial-agreements` | commercial.manage | Client | Prepares agreement |
| 2–3 | `POST /handyman/commercial-agreement-versions/{id}/activate|supersede` | commercial.manage | Client via version | Version lifecycle |
| 4–8 | `POST /handyman/commercial-agreement-versions/{id}/labor-pricing-basis|material-pricing-basis|bm-fee-rule|bm-fee-term|bm-fee-beneficiary` | commercial.manage | Client via version | Pricing/BM-fee authoring |
| 9–10 | `GET /handyman/pricing-contract`, `GET /handyman/bm-fee-configuration` | finance.read | Client | Read-only |
| 11 | `POST /handyman/execution-scopes/{id}/customer-transaction` | finance.manage | Exact Building | Opens ledger transaction |
| 12 | `POST /handyman/execution-scopes/{id}/customer-charge-lines` | finance.manage | Exact Building | Charge from confirmed quotation line (amount server-derived) |
| 13 | `POST /handyman/execution-scopes/{id}/payment-allocations` | finance.manage | Exact Building | Allocates ≤ net capacity (service + 0447 DB guard) |
| 14 | `POST /handyman/execution-scopes/{id}/ledger-refunds` | finance.manage | Exact Building | Refund ≤ net received-and-applied; excess → 409, nothing recorded |
| 15–16 | `POST /handyman/execution-scopes/{id}/ledger-reversals/allocation|payment` | finance.manage | Exact Building | Forward-only reversal facts; allocation reversal restores capacity |
| 17 | `POST /handyman/execution-scopes/{id}/ledger-adjustments` | finance.manage | Exact Building | Signed adjustment |
| 18 | `POST /handyman/execution-scopes/{id}/financial-entitlements/derive` | finance.manage | Exact Building | Provider payable + BM fee derivation |
| 19–24 | `POST /handyman/execution-scopes/{id}/settlement/prepare|include|reconcile|settle|correction|dispute` | settlement.manage | Exact Building | Settlement state only, never fund movement; `dispute` records a hold only — adjudication is NOT implemented |
| 25 | `GET /handyman/execution-scopes/{id}/financial-transaction` | finance.read | Exact Building | Read-only |
| 26 | `GET /handyman/financial-transactions` | finance.read | Client | Read-only reporting |
| 27 | `POST /handyman/execution-scopes/{id}/service-warranty/start` | commercial.manage | Exact Building | Starts warranty (window server-derived) |
| 28 | `POST /handyman/service-warranties/{warrantyId}/expire` | commercial.manage | Building via warranty's scope | Expires warranty |
| 29–32 | `POST /handyman/service-warranty-claims/{claimId}/reworks`, `POST /handyman/service-warranty-reworks/{id}/start|complete|verify` | authenticated only | Service-enforced CURRENT Crew Lead | Field rework ladder (unchanged; not a Finance surface) |

Already-merged customer-ledger surface
(`src/modules/handyman-customer-ledger-api/`) — the reporting /
verification split:

| Route | Permission | Note |
|---|---|---|
| `GET /handyman/execution-scopes/{id}/customer-ledger`, `GET /handyman/customer-ledger`, `GET /handyman/execution-scopes/{id}/customer-payments` | `tenant_company.read` (unchanged) | Customer/Tenant payment reporting reads |
| `POST /handyman/execution-scopes/{id}/customer-payments` | `tenant_company.manage` (unchanged) | Payment **reporting** — records a `PENDING` payment fact |
| `POST /handyman/execution-scopes/{id}/customer-payments/{paymentId}/confirm` | `handyman.finance.manage` (**changed**) | Payment **verification** |
| `POST /handyman/execution-scopes/{id}/customer-payments/{paymentId}/reject` | `handyman.finance.manage` (**changed**) | Payment **verification** |

The read-side `availableActions` projection remains a lifecycle
projection (which actions exist for a payment status); executing
CONFIRM/REJECT now additionally requires the Finance grant. Customer
claim/authorize commands on the service-warranty API stay under the
existing customer authority and are unchanged.

## 3. Provisioning runbook (per environment, deliberate & audited)

1. Deploy code containing migration 0448; run `npm run db:migrate`
   (registers the four codes; grants nothing).
2. In the admin console (Roles & Permissions), create or choose the
   Finance / Commercial / Settlement roles and assign exactly the
   domain codes above; assign roles to named users. Do not add the
   codes to broad operational roles.
3. Grant each financial user explicit Building assignments for the
   Buildings they may act on (BE-02G); a permission without Building
   assignment authorizes nothing.
4. Verify with a scoped test user: finance commands succeed in-scope,
   return 403 out-of-scope and for the generic-manager persona.
5. Rollback: `db:migrate:down` for 0448 intentionally keeps the
   catalogue entries (never grants/revokes rights); route enforcement
   rolls back with the code deploy.

## 4. Migration deployment notes

- `0448_handyman_finance_authority_permissions` is additive only:
  four `INSERT … ON CONFLICT (code) DO NOTHING` catalogue rows. No
  table/column changes, no historical rewrite, no grants.
- Verified on disposable PostgreSQL 18: full `migrateUp` registers the
  four ACTIVE codes with **zero** role grants; 0448 down keeps the
  catalogue (0442/0446 precedent) and re-up is idempotent.
- Do not run against Production as part of this CR; deployment follows
  the normal release process with step 2 provisioning done explicitly
  by an administrator after deploy.

## 5. Focused evidence

`tests/handyman-finance-authority.test.ts` (embedded PostgreSQL, real
HTTP): generic `tenant_company.manage` actor → allocation/refund/
settlement/commercial 403 with zero persisted changes, while payment
reporting (record + customer-ledger read) still works and its payment
stays `PENDING` until a Finance actor confirms it; Finance actor
executes in-scope commands (audit: `allocatedByUserId` /
`correctedByUserId` are the Finance actor) but cannot settle;
Settlement actor settles but cannot refund or allocate; Commercial
actor authors agreements but cannot mutate payments or read finance;
cross-Building, unassigned and cross-Client actors are denied;
spoofed `actorUserId`/`role` fields → 400; final persisted allocations
total exactly the charge (100.00). Concurrency, refund bounds,
reversal/reallocation and idempotency invariants remain covered by
`tests/handyman-e2e-finance-close-api.test.ts` (6/6).

Still PARTIAL by product decision (unchanged): J01 tenant
cancellation, J11 Manager CLOSE aggregate, J12 dispute adjudication.
