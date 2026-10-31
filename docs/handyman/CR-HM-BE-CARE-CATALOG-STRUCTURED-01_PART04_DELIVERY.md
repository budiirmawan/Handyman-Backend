# CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — PART 04 DELIVERY

**Building-Session Structured Care Parity**

| | |
|---|---|
| Date | 2026-10-31 |
| Decision | **PASS** |
| Scope | PART 04 only (PART 05 not started) |
| PR / merge / deploy | None (as instructed) |

---

## 1. Actual baseline and working branch

| Item | Value |
|---|---|
| Repository | `budiirmawan/Handyman-Backend` |
| Expected baseline | `4ff46085baddae487a52e6a7ee01d76ad819bfd9` |
| **Verified HEAD at start** | `4ff46085baddae487a52e6a7ee01d76ad819bfd9` — **exact match** |
| Source branch | `work/handyman-care-part04` |
| **Working branch** | `arena/9ab3fff8-handyman-backend` (descends from the verified baseline; no rebase, no merge) |
| Advanced branch lineage | the checkout is the compatible branch prepared from `arena/9b080bd1-handyman-backend` |

### Baseline precondition checks (before any edit)

| Check | Result |
|---|---|
| `git rev-parse HEAD` == `4ff46085…` | PASS |
| Migration inventory | **535** migration files `0001`–`0535` |
| Advanced migrations `0481`–`0535` present | PASS (all 55 files present, incl. `0481_handyman_commercial_consent_bridge`) |
| `0484_handyman_care_structured_request_items` present | PASS |
| Advanced Care structured item engine | PASS — `addCareHandymanServiceRequestItemInTransaction` in `handyman-parameterized-catalog/handyman-request-items.service.ts` |
| Advanced structured input columns | PASS — `uom_id`, `item_description`, nullable `created_by_user_id` (0484); `inherited_attribute_values` (0480) |
| INTERNAL_ONLY Care Notes | PASS — `handyman-internal-notes` + migration `0485`, `visibilityClassification = 'INTERNAL_ONLY'` |
| BM exchange-token structured intake (PART 02 reference) | PASS — `createCareHandymanServiceRequest` (`POST /handyman/requests/care`) with `items[]` |
| Care Workspace structured-item readback | PASS — `care-workspace-operational.repository.ts` items projection |
| `origin_channel` widening (`CUSTOMER_CARE_BACKEND`) | PASS — migration `0455` |

No checkout incompatibility was found. **Not BLOCKED.**

---

## 2. Changed files

| File | Change |
|---|---|
| `src/modules/handyman-care-standalone-discovery/handyman-care-tenant-request-gateway.validation.ts` | +229/−13 — structured `items[]` transport parser, mutual-exclusion rules, item vocabulary, `MAX_BUILDING_CARE_REQUEST_ITEMS = 50` |
| `src/modules/handyman-care-standalone-discovery/handyman-care-tenant-request-gateway.service.ts` | +127/−5 — structured item persistence inside the existing idempotency transaction, fingerprint normalisation, structured 201 body |
| `src/modules/handyman-care-standalone-discovery/handyman-care-standalone-discovery.repository.ts` | +92 — `listBuildingCareRequestItems` (Building/Client-scoped, executor-injectable) + `StandaloneCareRequestItemRecord` |
| `src/modules/handyman-care-standalone-discovery/handyman-care-standalone-discovery.service.ts` | +53 — `projectStandaloneCareRequestItem` + additive `items` on the detail readback |
| `docs/api/openapi.yaml` | +223/−8 — create-body mutual exclusion, structured item input/output schemas, detail `items`, new error code |
| `tests/handyman-care-building-structured-items-part04.test.ts` | **new** — 12 focused tests (9 DB-backed, 3 spec-only) |
| `docs/handyman/CR-HM-BE-CARE-CATALOG-STRUCTURED-01_PART04_DELIVERY.md` | **new** — this report |

`git diff --stat` overall: **7 files changed, 2,284 insertions(+), 26 deletions(-)** — of which the new focused test file is 1,319 lines and this report 241 lines; runtime + spec code is 724 insertions / 26 deletions across 5 pre-existing files.

**Not modified** (explicitly preserved): `handyman-request-items.service.ts` (the advanced item engine), `handyman-service-request.service.ts` (`createCareHandymanServiceRequest` BM exchange path), `handyman-care-workspace/*`, `handyman-internal-notes/*`, `handyman-unlisted-intake/*`, `handyman-quotations/*`, `handyman-scheduling/*`, invoice/payment/settlement/warranty modules, and every historical migration.

---

## 3. POST / GET contract changes

### 3.1 `POST /api/v1/handyman/care/buildings/{buildingId}/requests`

**Legacy contract — unchanged.** A body with `serviceCatalogId` (+ optional `serviceVariantId`) still returns exactly the same 201 payload with the same key set, authors **no** request-item rows, and produces the **byte-identical** idempotency fingerprint as before PART 04 (the `items` key is omitted from the fingerprint input entirely for legacy submissions).

**New structured contract — additive and mutually exclusive.**

```jsonc
{
  "tenantCompanyId": "<uuid>",
  "tenantPicId": "<uuid>",            // optional, represented customer
  "spaceId": "<uuid>",                // optional Unit
  "description": "…",                 // optional request-level text
  "items": [                          // 1..50, the structured selection
    {
      "serviceCatalogId": "<uuid>",   // required
      "quantity": 2,                  // required, NUMERIC(18,4) precision
      "serviceVariantId": "<uuid>",   // optional, ACTIVE variant of THAT service
      "uomId": "<uuid>",              // optional, ACTIVE + same Client
      "attributeValues": { "CODE": "value" },  // optional, ≤20 bounded strings
      "itemDescription": "…",         // optional, 1..1000 chars
      "accessCondition": "HIGH_FLOOR" // optional, defaults STANDARD
    }
  ]
}
```

Contract rules:

1. **Mixed payloads are rejected.** `items` together with `serviceCatalogId` **or** `serviceVariantId` → `400 VALIDATION_ERROR` with the offending legacy field named. `items` is the only selection that may accompany `items`.
2. `items` bounds: min 1, max 50; non-array / empty / over-bound → `400 VALIDATION_ERROR`.
3. Item field allow-list is strict (`additionalProperties: false`); any other item key → `400`.
4. Per-item `description` is **not** accepted; the item-level field is `itemDescription` (the persisted column name), keeping it unambiguous against the request-level `description`.
5. Semantic validation is **delegated to the existing advanced item engine** — there is no second implementation: ACTIVE catalogue service + same Client, ACTIVE variant belonging to that service, ACTIVE Client-owned UOM, `NUMERIC(18,4)` quantity precision and positivity, no variant contradiction, configured attribute data-type/allowed-value checks, reserved `ACCESS_CONDITION` attribute key refusal. Failures are `400 HANDYMAN_SERVICE_REQUEST_ITEM_INVALID`.
6. The parent request's catalogue anchor records the **first** item (`service_catalog_id`, `service_variant_id`) — the same precedence the exchange-token structured intake uses, and the anchor still satisfies the `CATALOG` intake CHECK from migration `0488`. Consequently the **anchored** item is additionally judged by the pre-existing request-intake contract, so its unknown service is `404 SERVICE_CATALOG_NOT_FOUND` and its inactive variant is `409 HANDYMAN_SERVICE_VARIANT_NOT_ACTIVE` — i.e. exactly the legacy answers. Non-anchored items always answer through the item engine (`400`). This nuance is asserted explicitly by the test suite.
7. The **201 body** for a structured submission is the unchanged parent projection **plus** `items`, using the same projection the GET detail returns.

**Preserved:** `handyman.care.building` permission + exact Building/Client authority via `resolveBuildingCareAuthority` + active lineage; Care staff user-session as the only acting identity; `Idempotency-Key` required, replay, `409 IDEMPOTENCY_CONFLICT`; `no-store`.

**Not introduced:** any BM exchange token, `hcw_` session, Tenant impersonation, or second create path.

### 3.2 `GET /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}`

`data` gains an **additive** `items[]`; `request` and `progress` are untouched (same keys, same values, same `no-store`).

```jsonc
{
  "request":  { /* unchanged allow-list projection */ },
  "items": [
    {
      "id": "<uuid>",
      "serviceCatalogId": "<uuid>", "serviceCode": "AC_INSTALLATION", "serviceName": "…",
      "serviceVariantId": "<uuid|null>", "serviceVariantCode": "…|null", "serviceVariantName": "…|null",
      "quantity": 2,                       // NUMERIC(18,4) precision preserved
      "uomId": "<uuid|null>", "uomCode": "HM_UNIT", "uomName": "Unit", "uomSymbol": "unit",
      "itemDescription": "…|null",
      "accessCondition": "HIGH_FLOOR",
      "attributeValues": { "AC_CAPACITY": "0.5", "…": "…" },        // EFFECTIVE set
      "inheritedAttributeValues": { "AC_CAPACITY": "0.5", "…": "…" }, // provenance
      "inheritedAttributeCodes": ["AC_CAPACITY", "AC_DRIVE_TYPE", "AC_TYPE"],
      "status": "ACTIVE",
      "createdAt": "…", "updatedAt": "…"
    }
  ],
  "progress": { /* unchanged */ }
}
```

* Only `status = 'ACTIVE'` rows are returned; bounded to 50 (the create bound).
* Read scope: the server-derived `client_id` **and** a request id already proven to belong to the authorized `building_id` by `findBuildingCareRequestById` — no caller-supplied context participates.
* Order: `created_at ASC, id ASC` — deterministic. Items authored in one transaction share `created_at`, so the id tie-break decides; item order is therefore **not** the submission order. Documented, not a contract of this delivery.
* `inheritedAttributeValues` is written once at authoring time (PART 03 rule 5), so a later catalogue change can never rewrite a readback.
* **INTERNAL_ONLY Care Notes are not exposed**: they live in their own table and are never joined into this projection (asserted by test 11).
* Reported items are **not** approved quotation lines; an `accessCondition` is **not** BM clearance; no item states a confirmed appointment; tenant preferred dates remain preferences.

---

## 4. Migration status

| Item | Result |
|---|---|
| Reused migration | `0484_handyman_care_structured_request_items` (unchanged, not renumbered, not edited) |
| PART 02 migration `0481` imported | **No** |
| Historical migrations edited | **No** |
| **New migration required** | **No** |
| **Schema gap found** | **None** |
| Production migrations executed | **No** (only disposable embedded PostgreSQL in tests) |

Verified that the reused schema already supports every PART 04 field: `handyman_service_request_items.uom_id` (UUID), `.item_description` (1–1000 CHECK), nullable `.created_by_user_id`, `.inherited_attribute_values` (0480), and that `0484` is registered in the migration index at its original position.

---

## 5. Focused tests — PASS/FAIL

Environment: disposable embedded PostgreSQL 18.4 per suite, unique port, removed after the run. No production data touched.

### 5.1 New PART 04 suite — `tests/handyman-care-building-structured-items-part04.test.ts`

**12 tests / 12 pass / 0 fail.**

| # | Requirement | Result |
|---|---|---|
| 1 | Legacy POST compatibility + `items: []` on detail, request/progress unchanged | PASS |
| 2 | Structured POST → authorized GET round-trip (identical projection, quantity 1.25 & 2, UOM, description, access condition, provenance) | PASS |
| 3 | Mixed payload rejection (`items`+`serviceCatalogId`, `items`+`serviceVariantId`, neither, empty, >50) | PASS |
| 4 | Quantity / variant / UOM / attribute rules (11 probes incl. precision, inactive variant, cross-service variant, contradiction, agreeing value, cross-Client UOM, inactive UOM, cross-Client service, unknown service, reserved key, bad access condition) | PASS |
| 5 | Building and Client isolation (sibling Building 403, sibling scope 404, cross-Client 404, cross-Client create 403) | PASS |
| 6 | Staff-session authorization + provenance (401 / 403 `PERMISSION_DENIED`; request, attribution and item audit all trace to the session; no BM actor) | PASS |
| 7 | Idempotent replay, default-equivalence replay, extra-item conflict, quantity conflict, access-condition conflict | PASS |
| 8 | Transaction rollback — zero orphan request / item / attribution / party / idempotency claim; key reusable afterwards | PASS |
| 9 | Attribute inheritance provenance (`inheritedAttributeValues`, `inheritedAttributeCodes`, variant-less item inherits nothing) | PASS |
| 10 | OpenAPI closure — create-body mutual exclusion keywords, item in/out schemas, detail `items`, error code, runtime reuses the engine and read | PASS |
| 11 | INTERNAL_ONLY Care Note non-disclosure | PASS |

### 5.2 Regression suites (focused, directly adjacent)

| Suite | Result | Notes |
|---|---|---|
| `handyman-care-tenant-request-gateway-http.test.ts` (legacy gateway, 15 tests) | **15 / 15 PASS** | unchanged contract |
| `handyman-care-request-create.test.ts` (**BM exchange-token structured intake / PART 02**) | **18 / 18 PASS** | run with `ASENTRA_USE_EMBEDDED_POSTGRES=true`; without it the suite self-skips |
| `handyman-internal-notes.test.ts` (INTERNAL_ONLY notes) | **14 / 14 PASS** | |
| `handyman-care-workspace-request-detail.test.ts` (Care Workspace structured-item readback) | **16 / 17 PASS** | the structured-item readback test itself PASSES; 1 failure is the pre-existing `finalReceipt` projection gap — **identical on the untouched baseline** |
| `handyman-care-standalone-discovery-http.test.ts` | **2 / 3 PASS** | failure is the pre-existing `HANDYMAN_QUOTATION_PRICE_BASIS_REQUIRED` fixture issue — **identical on the untouched baseline** |
| `cr-hm-service-catalog-01-part02.test.ts` (item engine) | **12 / 12 PASS** | |
| `cr-hm-service-catalog-01-part01.test.ts` | **14 / 15 PASS** | pre-existing, **identical on baseline** |
| `cr-hm-service-catalog-01-part03.test.ts` (variant inheritance) | **14 / 20 PASS** | 6 pre-existing (quotation price-basis / commercial-tax rules), **identical on baseline** |
| `openapi-operational-structural-closure.test.ts` | **6 / 8 PASS** | stale census constants (spec expects 2,067 runtime routes, baseline registers 2,217) — **identical on baseline** |
| `handyman-customer-care-request-reads.test.ts` | suite-level: cleanup hook blocked by the `hm_bm_issued_document_immutable` trigger | pre-existing fixture issue, **identical on baseline** |
| `handyman-service-request-intake-scope-guard.test.ts` | 2 skipped | requires an externally provisioned database; **identical on baseline** |

**Baseline-difference conclusion:** every non-PASS above was reproduced on the untouched `4ff46085` baseline via `git stash` and shows the *same* counts and the *same* failure identity. **PART 04 introduces zero new failures.** No full-suite run was performed (as instructed).

Totals for the PART 04-relevant corpus: **134 tests executed, 123 pass, 11 pre-existing failures (every one reproduced on the untouched baseline), 0 new failures.** Two suites were excluded from this arithmetic: `handyman-service-request-intake-scope-guard` (2 tests, self-skips without an externally provisioned database) and `handyman-customer-care-request-reads` (its cleanup hook aborts before the tally; identical on baseline).

---

## 6. Typecheck / OpenAPI results

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **PASS** — 0 errors |
| OpenAPI parse | `yaml.parse(docs/api/openapi.yaml)` | **PASS** — valid document |
| OpenAPI `$ref` integrity | internal walk of every `$ref` | **PASS** — **2,726 refs, 0 unresolved** |
| Focused OpenAPI assertions | tests 10 in the new suite | **PASS** |
| `git diff --check` | — | **PASS** (clean; no whitespace errors, no conflict markers) |

---

## 7. Remaining blockers

**None for PART 04.** Explicitly recorded residual items (all pre-existing, all outside PART 04 scope, none introduced here):

1. `handyman-care-workspace-request-detail` — `finalReceipt` block appears in the Care Workspace detail projection without being declared in the test's expected allow-list. Unrelated to PART 04; reproduce on baseline.
2. `handyman-care-standalone-discovery-http` — its own fixture builds an approved quotation without a price basis, which later quotation governance now rejects.
3. `cr-hm-service-catalog-01-part01/part03` — quotation price-basis / commercial-tax rule changes post-dating those suites.
4. `openapi-operational-structural-closure` — hard-coded route census (2,067) is stale against the baseline (2,217).
5. `handyman-customer-care-request-reads` — cleanup hook blocked by the BM issued-document immutability trigger.

**Documented design decisions (not blockers):**

* **Item creator provenance.** Structured Building-session items are authored through `addCareHandymanServiceRequestItemInTransaction`, so `created_by_user_id` is `NULL` on the item row — exactly as migration `0484` intends for Care-authored items and exactly as the exchange-token path behaves. The Care **staff session** provenance is preserved in three auditable places, all asserted by test 6: `handyman_service_requests.created_by_user_id`, `handyman_channel_attributions.created_by_user_id`, and the per-item `HANDYMAN_SERVICE_REQUEST_ITEM_ADDED` operational event's `metadata.careActorId`. Reusing the shared engine (instead of adding a second writer) is what keeps the BM exchange-token path untouched.
* **Anchored-item error vocabulary.** Because the parent request keeps the catalogue anchor = first item, the first item's service/variant is additionally validated by the pre-existing request-intake contract (`404 SERVICE_CATALOG_NOT_FOUND`, `409 HANDYMAN_SERVICE_VARIANT_NOT_ACTIVE`). This mirrors the exchange-token structured intake exactly and preserves the legacy single-service answers. Both the anchored and non-anchored outcomes are pinned by test 4.
* **Item ordering.** `created_at ASC, id ASC`; same-transaction items share `created_at`, so the id tie-break applies. Stable and deterministic, but not submission order. If submission order is ever required it needs a persisted ordinal column — a deliberate future migration, **not** needed for PART 04.

---

## 8. Final commit SHA

See the final line of this report after the commit is created:

**Commit:** `<see git log -1 on arena/9ab3fff8-handyman-backend>`
**Branch pushed:** `arena/9ab3fff8-handyman-backend`
**PR:** none (as instructed) · **Merge:** none · **Deployment:** none

---

## FINAL DECISION

**PASS** — PART 04 implemented and verified on the advanced baseline `4ff46085`, focused regressions green, typecheck clean, OpenAPI valid and resolved, no new migration, no production migration run, advanced capabilities preserved. **STOP after PART 04. PART 05 not started.**
