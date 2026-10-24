# CR-HM-SERVICE-CATALOG-01 PART 02 — Catalog Completeness & Pricing Integrity

**Branch:** `arena/d4d4105f-handyman-backend` (base `82604d4`)
**Scope:** PART 02 of the parameterized Handyman service catalogue. It
continues PART 01 (`09ff9b8`) and never re-opens it: the service master, the
variant master, the price authority, the quotation lifecycle and the starter
catalogue are all REUSED unchanged.

**Migrations:** `0478_handyman_service_variant_attribute_lifecycle`
(applied after PART 01's `0476` / `0477`).

**Governing law (unchanged from PART 01):** the amount authority is the
EXISTING `price_catalog_entries`; the quotation lifecycle is the EXISTING
CR-HM-06 surface. PART 02 adds NO price table, NO amount of its own, NO
parallel pricing engine and NO fictitious surcharge. A price rule only
SELECTS a governed price fact.

---

## 1. Variant attribute administration (B)

PART 01 created `handyman_service_variant_attributes` (a variant carries the
configured value of a service attribute) but left it without a lifecycle and
without an administration surface. PART 02 completes it.

### 1.1 The model is reused, extended

| column | change | why |
| --- | --- | --- |
| `status` | `ACTIVE` / `INACTIVE` | the same lifecycle vocabulary as the rest of the catalogue |
| `deactivated_at` | timestamp | a retirement is a dated fact |
| `deactivated_by_user_id` | actor | a retirement is attributable |

The `(service_variant_id, attribute_id)` uniqueness is UNCHANGED: a pair
carries exactly ONE choice, so a second write is a governance conflict
(409), never a silent overwrite. Retiring keeps the row and its value
visible — history is never destroyed.

### 1.2 Validation of the choice against the service

* the variant must belong to the addressed service and the caller's Client;
* the attribute must belong to the **same service** as the variant
  ("validasi pilihan terhadap jenis layanan");
* the attribute must be `ACTIVE`;
* the value must be admissible for the attribute's data type — `NUMBER`
  takes a positive `valueNumber`, `BOOLEAN` takes `"true"`/`"false"`, an
  `ENUM` takes one of its allowed values unless it allows a free value;
* a retired service may still have its choices retired, but no NEW choice
  may be added to it.

### 1.3 Existing quotations are never broken

A choice is catalogue configuration, not a commercial fact. The quotation
keeps the price snapshot it was issued with: the amount lives in
`handyman_quotation_lines` (immutable) and the resolution fact lives in the
append-only `handyman_service_quote_resolutions`. Editing or retiring a
choice — or deactivating the consumed price fact — cannot rewrite either.
This is proven by the focused suite.

### 1.4 The administration surface (4 new operations)

| operation | permission |
| --- | --- |
| `GET /service-catalog/parameterized/entries/{serviceCatalogId}/variants` | `service_catalog.read` |
| `GET /service-catalog/parameterized/entries/{serviceCatalogId}/variants/{serviceVariantId}/attributes` | `service_catalog.read` |
| `POST /service-catalog/parameterized/entries/{serviceCatalogId}/variants/{serviceVariantId}/attributes` | `service_catalog.manage` |
| `PATCH /service-catalog/parameterized/variant-attributes/{variantAttributeId}` | `service_catalog.manage` |

The Client is always DERIVED from the addressed service entry. A foreign
variant id is a 404 (no existence leak), a caller without Client reach is a
403, an anonymous caller is a 401. No new permission code was introduced.

---

## 2. Access complexity pricing (C)

### 2.1 The audit

Work access is a real cost driver: an outdoor unit behind a locked service
space (difficult access), a condenser on a 5th-floor facade (high ceiling),
a roof-crane or boom-lift lift (special equipment). PART 01 carried the
access condition on the request item but never priced it — a `HIGH_FLOOR`
item was priced with the plain reference price of the service, which is a
**silent undercharge** and exactly the kind of fictitious price the CR
forbids.

### 2.2 The law

One reserved, governed price-rule selector key:

```
ACCESS_CONDITION ∈ { STANDARD, DIFFICULT, HIGH_FLOOR, RESTRICTED, SPECIAL_EQUIPMENT }
```

* a rule that names `ACCESS_CONDITION` prices EXACTLY that access
  complexity;
* a rule that does NOT name it prices the `STANDARD` access complexity
  ONLY — it can never price a difficult, high-floor or special-equipment
  job;
* when no access tier exists, the item fails closed to `MANUAL_REVIEW` with
  the reason `PRICE_RULE_NOT_FOUND` and a detail that names the missing
  access condition.

**There is no surcharge arithmetic anywhere.** The access tier is a COMPLETE
governed price fact that the administrator authors in the existing price
authority (`price_catalog_entries`, tier key = the rule code). The engine
selects it; it never adds to it. A job can therefore never be charged
"standard + uplift", and the total is always `unit amount × quantity` of
exactly ONE fact — no double charge.

An access rule must consume its OWN tier: the plain reference price (`''`)
is the client's STANDARD-access baseline, so consuming it for a difficult
job would price the wrong access tier. This is enforced at rule creation,
at rule update and again at resolution time.

`SPECIAL_EQUIPMENT` joins the access vocabulary (migration `0478` widens the
request-item CHECK constraint).

---

## 3. Pricing tier integrity (D)

| law | where it is enforced | failure mode |
| --- | --- | --- |
| a tiered price fact carries exactly the consuming rule's code | rule create / update | 400 `HANDYMAN_SERVICE_PRICE_RULE_INVALID` |
| an access rule consumes its own access tier | rule create / update | 400 `HANDYMAN_SERVICE_PRICE_RULE_INVALID` |
| a fact that drifted out of its tier | resolution | `MANUAL_REVIEW` / `PRICE_TIER_MISMATCH` |
| a fact of another Client | resolution | `MANUAL_REVIEW` / `PRICE_FACT_SCOPE_MISMATCH` |
| no two ACTIVE rules select the same variant + attributes + quantity band | rule create / update | 409 `HANDYMAN_SERVICE_PRICE_RULE_COLLISION` |
| the effective window is honoured (`effectiveFrom <= t < effectiveTo`) | resolution | `INSPECTION_REQUIRED` / `PRICE_NOT_AVAILABLE` |
| one rule → one fact → one amount | resolution | (structural) |
| the quotation stores the snapshot | `handyman_service_quote_resolutions` (append-only) + the quotation line | (structural) |

The collision law is a PROACTIVE guard: two equally specific rules can
never be ordered against each other, so the administration layer refuses to
create them. The resolver still fails closed if such a pair ever arrives
through a direct database write.

---

## 4. What changed

| file | change |
| --- | --- |
| `src/database/migrations/0478_handyman_service_variant_attribute_lifecycle.ts` | NEW — variant-attribute lifecycle + access vocabulary |
| `src/database/migrations/index.ts` | registers `0478` |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.types.ts` | `SPECIAL_EQUIPMENT`, the reserved `ACCESS_CONDITION` selector key, two new reason codes, the variant-attribute lifecycle fields |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.errors.ts` | 5 new error factories |
| `src/shared/errors.ts` | 5 new error codes |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.repository.ts` | variant-attribute insert / update / find / list, variant listing, `float8` cast |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.service.ts` | the 4 administration commands, the tier-coherence law, the rule-collision law |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog-pricing.service.ts` | the access dimension, the resolve-time tier integrity checks |
| `src/modules/handyman-parameterized-catalog/handyman-request-items.service.ts` | the reserved key is refused as an item attribute; the widened access vocabulary |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.routes.ts` | the 4 new administration operations |
| `src/modules/handyman-parameterized-catalog/index.ts` | the new exports |
| `docs/api/openapi.yaml` | 4 new paths, 2 new schemas, the OpenAPI census +4 |
| `tests/cr-hm-service-catalog-01-part02.test.ts` | NEW — the PART 02 focused suite (12 assertions) |
| `tests/cr-hm-service-catalog-01-part01.test.ts` | the mixed-AC test now prices each access tier with its OWN fact (the PART 02 law) |
| `tests/handyman-quotations-api.test.ts` | the frozen quotation-path count (10) was already stale at the baseline (12); it is now 14 and the guard's intent is unchanged |
| `tests/price-catalog-entries.test.ts` | the hand-written SERVICE INSERT now satisfies the `0477` tier-key CHECK so the intended constraint is the one reported |
| `tests/openapi-operational-*.test.ts` | the census pins +4 |

---

## 5. Verification

| check | result |
| --- | --- |
| `tests/cr-hm-service-catalog-01-part02.test.ts` | **12 / 12 PASS** |
| `tests/cr-hm-service-catalog-01-part01.test.ts` (regression) | **15 / 15 PASS** |
| OpenAPI / census suites (3 files) | **28 / 28 PASS** |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| disposable PostgreSQL | 473 migrations apply; `0478` rolls back and re-applies cleanly; the access CHECK carries `SPECIAL_EQUIPMENT` |
| price-catalog regression (5 suites) | 47 pre-existing failures, **identical to the baseline** (see §6), 0 new |
| quotation regression (6 suites) | 52 / 57 pass; the 5 failures are **identical to the baseline** (see §6) |

### The 12 PART 02 assertions

| # | scenario |
| --- | --- |
| 1 | add / edit / retire a variant choice; the history survives the retirement, with the deactivation stamp and the audit events |
| 2 | a duplicate choice is refused (409) and the existing value is untouched |
| 3 | a choice that configures an attribute of ANOTHER service is refused |
| 4 | a numeric attribute refuses a text value; an ENUM refuses a value outside its allowed values; a valid ENUM is accepted |
| 5 | 401 anonymous, 403 without the permission, 403 without Client reach, 404 for a foreign variant |
| 6 | a difficult job without an access tier → `MANUAL_REVIEW`, no amount, the reason names `DIFFICULT` |
| 7 | an access tier prices the job with its OWN governed amount; the total is `unit × quantity` of ONE fact, never base + uplift |
| 8 | the special-equipment access complexity is governed like any other tier |
| 9 | the reserved `ACCESS_CONDITION` key is refused as an item attribute |
| 10 | an access rule may not consume the plain reference price |
| 11 | a rule may not consume another rule's tier |
| 12 | two equally specific rules are refused at creation (409) |
| 13 | a price fact that drifted out of its tier fails closed (`PRICE_TIER_MISMATCH`) |
| 14 | the issued quotation keeps its snapshot after the catalogue changes |

---

## 6. Pre-existing failures (NOT caused by PART 01 or PART 02)

Both surfaces were measured on the untouched baseline commit `9a15ad6` in a
separate clone with its own disposable PostgreSQL:

* **price-catalog suites** — 47 of 57 assertions fail on the BASELINE as
  well (HTTP 500 on price-catalog entry creation in this sandbox). PART 02
  introduces **zero** new failures; the failing test list is identical.
* **`handyman-quotations-api.test.ts`** — 4 assertions fail on the BASELINE
  as well (403 where 201 is expected, 401 where 200 is expected). The fifth
  failure was a frozen quotation-path count that was already stale at the
  baseline (12 paths, expectation 10) and is now 14; behind it a
  pre-existing schema leak surfaces (`HandymanExecutionScopeAssignmentResponseView`
  exposes `crewId` — byte-identical to the baseline). Both are outside the
  scope of this CR and are reported, not fixed.

---

## 7. Known gaps / PART 03 candidates

* The variant choices are administration data only: a variant's configured
  value is not yet inherited by the items that reference it. Inheriting it
  would change the resolution semantics of every existing variant, so it is
  a separate, explicitly governed decision.
* The access vocabulary is fixed. A per-service access policy (which
  complexity a service may carry) would need a governed dimension in the
  price authority.
* The `crewId` leak in `HandymanExecutionScopeAssignmentResponseView` is a
  pre-existing defect of another CR and should be raised separately.
