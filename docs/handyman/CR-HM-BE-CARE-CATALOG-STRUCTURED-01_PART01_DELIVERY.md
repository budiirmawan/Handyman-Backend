# CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — PART 01 Delivery

**Date:** 2026-10-30
**Scope:** Building-scoped authenticated Customer Care Staff structured Service Catalog intake only.
**Historical PART 01 decision:** **BLOCKED for deployment-lineage certification**; implementation and focused validation were complete on the assigned Arena branch.

> **PART 02 supersession note (2026-10-31):** The initial lineage gate below recorded `4ff46085baddae487a52e6a7ee01d76ad819bfd9` as the reported deployed SHA, not as independently verified runtime evidence. PART 02 found that SHA is the tip of `arena/9b080bd1-handyman-backend` and is absent from the repository's GitHub deployment records. The latest recorded deployment SHA is `0b72d7c5bff5f978740f17191821c4b26351a25d`, with a success status followed by `inactive`; therefore no active production SHA is certified by the available records. Current `main` is `11fad55ecae7a153df51cc463290ecc2ad70175c`. See the PART 02 report for the reconciliation and remaining production-lineage gate. The prior delivery's source SHA `bb7a7d96ef9886485eda7edaaf2c878792f5a2a0` is not resolvable in this checkout or through the GitHub commit API; the PART 01 patch was present as a worktree diff atop `11fad55`.

## Repository and lineage gate

- Repository remote: `https://github.com/budiirmawan/Handyman-Backend.git`
- Assigned branch: `arena/2175aeac-handyman-backend`
- Branch base / pre-change `HEAD`: `11fad55ecae7a153df51cc463290ecc2ad70175c`
- Initially reported deployed SHA: `4ff46085baddae487a52e6a7ee01d76ad819bfd9`.
- GitHub API identifies `4ff46085...` as the head of `arena/9b080bd1-handyman-backend`, not `main` and not a commit in the repository's deployment list. `main` is an ancestor of that branch by **98 commits**, with merge base `11fad55ecae7a153df51cc463290ecc2ad70175c`; this establishes branch ancestry only, not deployment status.
- The latest GitHub deployment entry is SHA `0b72d7c5bff5f978740f17191821c4b26351a25d` for `Handyman Project / production` (2026-10-18). It has earlier `success` statuses and a later `inactive` status. Current `main` is a descendant of `0b72d7c5` by **116 commits** (merge base `0b72d7c5...`). The records do not prove which SHA is running now.
- The pre-change `docs/api/openapi.yaml` was OpenAPI **3.0.3** and documented the Care Building create as a single-service body (`serviceCatalogId` plus optional `serviceVariantId`); its authorized detail schema only had `request` and `progress`.

PART 01's code and tests were green. The original deployment gate was based on a user-reported SHA; PART 02 reconciles the patch onto the verified current `main` code baseline and passes focused validation. Certification against the active production runtime remains blocked because the available deployment records do not identify an active current SHA; see the PART 02 report.

## Root cause

The authorized Care Building create validator had a closed allowlist containing only one `serviceCatalogId`/optional `serviceVariantId` selection. Its TypeScript body required that single service and the gateway created only the canonical request row. The Care Building detail allowlist did not query or return `handyman_service_request_items`.

A reusable structured request-item engine already existed in `handyman-parameterized-catalog` and persisted quantity, variants, attribute values, access condition, and inherited attribute provenance. The Care create transaction did not invoke that engine. The existing item row did not have storage for the *reported* UOM or a distinct per-item description, so those two requested facts could not be authoritatively read back.

**Exchange-flow clarification from this checkout:** `POST /handyman/requests/care` remains the separate exchange-token create contract and, in this source, accepts only `exchangeToken`, `serviceCatalogId`, optional `serviceVariantId`, and `description`. The reusable mixed-item service is the separate parameterized request-item lane; the exchange-only route was not changed and does not receive a Care staff token. Its existing regression suite passes below.

## Changes and endpoints

### Care staff create

`POST /api/v1/handyman/care/buildings/{buildingId}/requests`

- Preserves the existing session, `handyman.care.building` permission, exact active Building assignment, server-derived Client, represented Tenant/PIC/space checks, standard `Idempotency-Key`, and canonical `INTAKE` request creation.
- Accepts either the **legacy** single-service form (`serviceCatalogId`, optional `serviceVariantId`) or **structured** `items[]`. The two modes are explicit and exclusive; ambiguous mixed payloads, unknown fields, and explicit nulls in structured fields are rejected.
- `items[]` is non-empty and bounded at 50 entries. `serviceCatalogId` and `quantity` are required per item. Optional fields are `serviceVariantId`, `uomId`, `attributeValues`, `itemDescription`, and `accessCondition`.
- The immutable request row retains its existing required service anchor: for structured mode it is the first item’s service/variant. The complete mixed scope is stored as item rows in the same idempotency transaction.
- A structured submission failure rolls back the idempotency claim, attribution, request, and all items together. The structured submission is included in its fingerprint. Legacy submissions intentionally retain the pre-change fingerprint shape so existing legacy idempotent retries continue to replay.

### Authorized Care readback

`GET /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}`

The existing Care-only Building authority and non-enumerating request lookup remain in place. The response now includes `data.items`, queried from persisted `handyman_service_request_items` under the resolved Client/request scope. It returns ACTIVE items with `id`, `serviceCatalogId`, `serviceVariantId`, `quantity`, `uomId`, `itemDescription`, effective `attributeValues`, `inheritedAttributeValues`, `accessCondition`, `status`, and timestamps. REMOVED items remain excluded. The request-level `description` is not combined with item descriptions.

### Existing parameterized item lane

The existing Operations/authorized item routes were extended without creating another engine:

- `POST /api/v1/handyman/requests/{handymanRequestId}/items` accepts `uomId` and `itemDescription` in addition to its existing fields.
- `PATCH /api/v1/handyman/requests/{handymanRequestId}/items/{itemId}` can update those fields; `null` clears either field.
- Existing `GET /api/v1/handyman/requests/{handymanRequestId}/items` returns the expanded persisted item projection through the existing repository/type.

These routes retain their existing `tenant_company.manage`/`tenant_company.read` permissions and Building-scoped parent-request checks. The Care create path calls the reusable item authoring engine *inside its existing transaction*; it does not call or emulate the BM exchange-token route.

## Validation and authority behavior

- **Quantity:** positive, finite, `< 100000000000000`, and at most four decimal places, matching `NUMERIC(18,4)`. The same central normalizer is used by Care intake and existing item POST/PATCH; invalid precision is rejected rather than rounded by PostgreSQL.
- **UOM:** a supplied `uomId` must identify an ACTIVE `units_of_measure` row of the request’s server-derived Client. This is a *reported* work fact, not the quote UOM. The existing catalog stores service price basis and derives the quotation UOM from that basis; it has no separate service-to-reported-UOM compatibility relation. This part therefore enforces the existing Client-scoped UOM master, without allowing a reported UOM to override later pricing authority.
- **Technical attributes:** the existing structured engine’s structural bounds and normalization remain authoritative (up to 20 code/value entries, normalized attribute codes, string values up to 200 characters; canonical duplicate keys are refused). Variant must be ACTIVE and belong to the selected service and Client. ACTIVE configured variant values are materialized in `attributeValues`, with their origin preserved in `inheritedAttributeValues`; explicit contradictions are refused.
- **Required/unknown/invalid technical facts:** the existing item-intake contract deliberately records what was reported and does not invent missing facts or reject unknown vocabulary at intake. The existing price resolver applies required/allowed-value semantics later and routes missing/unknown/invalid facts to its inspection/manual-review outcomes. No quotation or price resolution is created during this Care create. A focused test verifies a missing required attribute remains absent and the existing resolver reports `INSPECTION_REQUIRED / ATTRIBUTE_MISSING`.
- **Access condition:** uses the existing engine vocabulary: `STANDARD`, `DIFFICULT`, `HIGH_FLOOR`, `RESTRICTED`, `SPECIAL_EQUIPMENT`; omitted means `STANDARD`. It remains a reported item access condition, not a BM permit/access authorization.
- **No other authority changed:** preferred scheduling remains a preference-only concern; permit/access approval remains with BM; quotation authority remains Operations-only; existing Non-Katalog behavior is untouched.

## Internal-only Care note contract check

No dedicated `INTERNAL_ONLY` Care note contract exists in this checkout. The existing
`POST/GET /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/communications`
contract is for reported communications: its bounded `purpose` vocabulary is `SERVICE_REQUEST_FOLLOW_UP`, `QUOTATION_RESPONSE_RECEIVED`, `VARIATION_RESPONSE_RECEIVED`, `BAST_CONFIRMATION_RECEIVED`, `PAYMENT_COMMUNICATION`, and `WARRANTY_COMMUNICATION`; it captures reported contact/channel/statement, is idempotent, and stays `PENDING_VERIFICATION`. It has no staff-only visibility or internal-note field/mode. It is not an internal Care note API.

The exact gap is therefore a future dedicated, access-controlled `INTERNAL_ONLY` note contract and persistence/read policy. This PART does not implement it. The request-level problem `description` and per-item `itemDescription` remain separate and are never concatenated with tenant complaints or each other.

## Database migration

**Required: YES.** Migration `0481_handyman_service_request_item_uom_description` adds only nullable `uom_id` (FK to the existing `units_of_measure` master) and nullable `item_description` (bounded to 1–1000 characters) to the existing `handyman_service_request_items` table. Existing item rows remain valid with `NULL`; quantity, variant, access condition, technical attributes, and inherited provenance continue using existing columns. No duplicate request/item table, catalog engine, or schema rewrite was introduced.

## Focused validation

All commands below passed on `arena/2175aeac-handyman-backend`; no full suite was run.

| Validation | Result |
|---|---:|
| `tests/cr-hm-be-care-catalog-structured-01-part01.test.ts` | 13 passed |
| `tests/cr-hm-be-care-catalog-structured-01-openapi.test.ts` | 2 passed |
| `tests/handyman-care-tenant-request-gateway-http.test.ts` (legacy Care, exact Building isolation, idempotent replay) | 9 passed |
| `ASENTRA_USE_EMBEDDED_POSTGRES=true tests/handyman-care-request-create.test.ts` (BM exchange regression) | 10 passed |
| `tests/cr-hm-service-catalog-01-part03.test.ts` (existing item/variant/inspection/quotation behavior) | 10 passed |
| `npx tsc --noEmit` | passed |
| OpenAPI YAML parse and focused contract assertions | passed |

## Commit and final decision

- **PART 01 source commit as previously reported:** `bb7a7d96ef9886485eda7edaaf2c878792f5a2a0`. PART 02 could not resolve this object from the current checkout or GitHub; the implementation diff that was present in the worktree was committed as a new reconciliation commit on the current-main baseline.
- **Reconciliation implementation commit:** `d512ecff1fc4404375b8f5f22bf3a6710c369fa4` (parent `11fad55ecae7a153df51cc463290ecc2ad70175c`).
- **Branch:** `arena/2175aeac-handyman-backend`.
- **Deployment status:** **BLOCKED for active production-lineage certification**. The patch is reconciled and validated on current `main`; no deployment or merge was performed. See `CR-HM-BE-CARE-CATALOG-STRUCTURED-01_PART02_DELIVERY.md` for the current deployment-record and migration disposition.
