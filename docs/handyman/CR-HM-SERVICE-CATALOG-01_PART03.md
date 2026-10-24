# CR-HM-SERVICE-CATALOG-01 — PART 03: Variant Selection → Request Items → Initial Quotation

**Status:** PART 03 delivered on `arena/d4d4105f-handyman-backend` (baseline
`08733cd`, which already contains PART 01 + PART 02).
**Scope:** PART 03 only. No merge, no deploy, no Biznet change, no PR.

**Migration numbers.** PART 03 shipped `0480_handyman_service_request_item_inherited_attributes`
— the FINAL REVIEW released `0476` to the in-flight E2E PR #59
(`CR-HM-FIELD-OPERATIONS-01`) and moved this CR's migrations one step up
(`0477`–`0480`), so that `main`'s `0473`–`0480` stays contiguous whichever
order the two PRs land in.

---

## 1. What PART 03 settles

PART 01 built the catalogue (service → variant → variant attribute → price
rule → request item → initial quotation). PART 02 built the administration of
the variant choices and the access/tier pricing integrity.

**PART 02 left one hole, and it is the hole this part closes.** A variant
carried configured attribute values, but the items that referenced a variant
**never inherited them**: an item stored only the values the caller typed, so
the price resolver read an item whose effective configuration did not match
the variant it claimed to select. The variant was a label, not a
configuration.

PART 03 makes the inheritance real and governed:

* a variant's ACTIVE configuration is **materialised on the item** when the
  item is authored, and the provenance is stored with it;
* an explicit contradiction is **refused** (400), never silently accepted;
* a later **catalogue change never rewrites an existing item** — the issued
  quotation keeps the snapshot it was priced from;
* the initial quotation therefore reads exactly the values that were
  inherited, and the quotation line records the variant it came from.

No pricing engine was built. The existing price authority, the existing
quotation lifecycle and the existing approval authority were used as they
are.

---

## 2. A — the audit of the existing flow

Read directly from the code on `08733cd`.

| # | stage | where | what it owns today |
| --- | --- | --- | --- |
| 1 | Service Catalogue | `service_catalog` (+ `0477`) | the governed service and its attribute vocabulary |
| 2 | Service Variant | `handyman_service_variants` (`0376`) | the catalogue-level configuration label of a service; `code`, `status` |
| 3 | Variant Attributes | `handyman_service_variant_attributes` (`0477` + lifecycle `0479`) | the **configured value** of one attribute of one variant (`value_text` / `value_number`, `status`) |
| 4 | Service Request Item | `handyman_service_request_items` (`0477`) | the **work fact**: quantity, access condition, the *reported* attribute values |
| 5 | Price Rule Resolution | `handyman-parameterized-catalog-pricing.service.ts` | validates the item's attributes, selects the rule, reads the governed price fact |
| 6 | Initial Quotation | `handyman-parameterized-quotation.service.ts` (`prepareHandymanCatalogQuotation`) | creates the root + version 1 DRAFT through the **existing** `createHandymanQuotation` / `addHandymanQuotationLine` |
| 7 | Inspection | `handyman-requests` (inspection + diagnosis) | the request diagnosis lane; append-only `handyman_service_quote_resolutions` |
| 8 | Revision + Approval | `reviseHandymanCatalogQuotation` → `createHandymanQuotationRevision`; `decideHandymanQuotation` | a **new immutable version**, then the **existing** customer decision |

### 2.1 The three classes of attribute

| class | example | owner | where it is authoritative |
| --- | --- | --- | --- |
| **customer-selected** | the AC type the tenant asked for, the free-text of an unknown fact | the caller of the intake API | the item's own `attribute_values` |
| **variant-inherited** | the 0.5 PK size, the inverter compressor of the selected variant | the **catalogue** | the variant's configured choices, materialised on the item (PART 03) |
| **inspection-verified** | the real size found on site | the **inspection lane** | a governed CORRECTION of the item — it becomes the item's own value and the price re-resolves |

The three are NOT interchangeable. Before PART 03 the item had only one
bucket, so an inspection correction and a catalogue value were
indistinguishable.

### 2.2 What MUST be on the quotation snapshot

* the **effective attribute values** of every item (what the price was
  resolved from);
* the **quantity** and the **UOM** (never re-derived);
* the **access condition** (the second price dimension);
* the **price fact** (`price_catalog_entry_id`), the currency, the unit
  amount, the total and the effective window — already append-only in
  `handyman_service_quote_resolutions`;
* **which variant** produced the values — NEW in PART 03: the quotation line
  description now carries `variant <code>` and marks the inherited
  attributes with `*`, so the snapshot explains itself without reading the
  catalogue again.

### 2.3 The defect the audit found

`handyman_service_request_items.attribute_values` carried **only** the
caller-typed values. The price resolver read exactly that column. So a
variant selection had **zero** effect on the price: the catalogue said
"1.5 PK inverter", the item said whatever the caller typed (often nothing),
and the resolver priced the item against the caller's words or refused it.
Two rules could then match the same item or none, and the variant's
configuration was invisible to the audit trail.

---

## 3. B — the integration rules (the contract)

The contract lives in
`src/modules/handyman-parameterized-catalog/handyman-variant-inheritance.service.ts`
(one module, one docblock, one place to read).

### 3.1 The rules

| # | rule | enforcement |
| --- | --- | --- |
| R1 | **Deterministic inheritance** — the item's effective set = the variant's ACTIVE configured values + the caller's own values | `composeEffectiveItemAttributes`, materialised on the item row |
| R2 | **No silent contradiction** — an explicit value that contradicts the variant is refused with the attribute code, the variant value and the submitted value | `400 HANDYMAN_SERVICE_REQUEST_ITEM_INVALID` |
| R3 | **Governed correction** — after authoring, the inspection lane may correct an inherited value; the corrected value becomes the item's **own** value (it leaves the inherited set) and the price re-resolves; a tier that no longer matches fails closed | `composeCorrectedItemAttributes` |
| R4 | **Retired choices are never inherited** — a retired variant choice (the `0479` lifecycle) never reaches a new item | `loadVariantAttributeValues` skips `choice_status <> 'ACTIVE'` |
| R5 | **The catalogue never rewrites an existing item** — a later change of the variant does not flow into an item that already exists; the variant is re-read only when the variant is (re)selected | the item stores its own effective set + provenance |
| R6 | **Variant scope** — the variant must belong to the right service **and** the right client; an INACTIVE variant is unavailable for a new request | `400` on the item route |
| R7 | **A variant change never alters an old quotation** — the quotation is immutable; the price snapshot is append-only | existing lifecycle, proven by the test suite |
| R8 | **UNKNOWN still enters inspection / manual review** — an unknown attribute or an unconfigured size is never priced | `INSPECTION_REQUIRED` / `MANUAL_REVIEW` |
| R9 | **Never a Rp0 price, never a mismatched tier** — the price fact carries `unit_price > 0` (DB CHECK) and the resolver fails closed on a non-positive amount; the tier-coherence law of PART 02 is unchanged | DB CHECK + resolver guard |
| R10 | **Quantity, UOM, PK, inverter and access condition stay consistent** — the inheritance service never touches the quantity, the UOM or the access condition; the quotation copies them from the item | `buildLineDescription` + `addHandymanQuotationLine` |

### 3.2 The write-time contract (the decision that was taken)

The inheritance is **materialised at WRITE time**, not resolved at read
time. The item row carries:

* `attribute_values` — the **effective** set (inherited + own);
* `inherited_attribute_values` — the **provenance** (the part the variant
  supplied) — NEW, migration `0480`.

Why materialised and not derived at read time:

* the price resolution must read the values that were **true when the item
  was authored**, not the values of the catalogue today;
* the issued quotation must stay reproducible after the catalogue changes
  (R5/R7);
* the provenance must be auditable — "which of these values came from the
  variant?" is answerable from the row itself.

The alternative (re-reading the variant at price time) would have made every
issued quotation change retroactively when the catalogue changed. It was
rejected.

### 3.3 The PATCH semantics changed — from REPLACE to MERGE

`PATCH /handyman/requests/{id}/items/{itemId}` used to REPLACE the
attribute set. It now **MERGES over the item's OWN values**:

* the caller's own values are merged (a stated value is corrected, never
  dropped by an unrelated correction);
* the inherited values are not part of the caller's view — they are the
  catalogue's, and they stay pinned until the variant is re-selected;
* re-selecting `serviceVariantId` re-applies that variant's configuration
  and refuses an explicit contradiction;
* detaching the variant (`serviceVariantId: null`) drops the inherited
  values and keeps the item's own values.

The OpenAPI description of the PATCH body was updated accordingly.

---

## 4. C — the focused E2E contract suite

`tests/cr-hm-service-catalog-01-part03.test.ts` — **10 / 10 PASS** against
a disposable embedded PostgreSQL (port 55641, removed after the run).

| # | CR contract point | test | proven |
| --- | --- | --- | --- |
| 1 | AC 0.5 PK non-inverter × 2 | `inherits the variant configuration and prices the matching tier` | the item inherits `AC_CAPACITY=0.5`, `AC_TYPE=SPLIT`, `AC_DRIVE_TYPE=NON_INVERTER`; the tier `AC_INSTALL_05_NON_INVERTER` prices 650 000 × 2 = 1 300 000 |
| 2 | AC 1.5 PK inverter × 1 | same test | the second item inherits `1.5 / SPLIT / INVERTER`; the tier `AC_INSTALL_15_INVERTER` prices 900 000 × 1 |
| 3 | both AC kinds in one request | same test | one request, two ACTIVE items, `GET /items` returns 2 |
| 4 | different variants → correct price tiers | same test | each item is priced by ITS OWN tier (the fact's `service_price_key` equals the rule code — the PART 02 tier-coherence law) |
| 5 | quantity and UOM unchanged during the quotation | same test | the lines carry quantities 1 and 2, one UOM for the basis, `lineTotal = unit × qty`, currency IDR |
| 6 | UNKNOWN → inspection / manual review | `routes an UNKNOWN size and an unknown attribute to manual review, never a price` | an unconfigured size → `PRICE_RULE_NOT_FOUND` / `MANUAL_REVIEW`; an unknown attribute → `ATTRIBUTE_UNKNOWN` / `INSPECTION_REQUIRED`; **no quotation at all** (no partial quote) and never an amount |
| 7 | inactive variant and cross-client variant rejected | `refuses an inactive variant and a variant of another Client` | both are `400`; no item row is written |
| 8 | attribute change after the inspection → a quotation revision | `drives a quotation REVISION when the inspected attribute changes` | the correction leaves the inherited set, the revision creates **version 2** with the new tier, **version 1 is untouched** |
| 9 | an approved quotation does not change with the catalogue | `leaves an approved quotation untouched when the catalogue changes` | after the approval, the variant is re-pointed and the price fact is deactivated — the approved version, its line and the append-only snapshot are byte-identical; the **item** is not rewritten either |
| 10 | no double charge, no automatic approval | the tests above + `never produces a zero price` | one priced resolution per item, `total = unit × qty` of exactly one fact; the revised version carries **no** decision row until the customer decides; the price authority refuses a zero amount and the DB CHECK (`unit_price > 0`) makes it structural |

Three further tests cover the variant lifecycle on an **existing** item:
`re-applies the configuration when the variant is re-selected`,
`drops the inherited values when the variant is detached`,
`never inherits a RETIRED variant choice` (R4).

---

## 5. D — baseline regression triage

The PART 02 report (kept in `docs/handyman/CR-HM-SERVICE-CATALOG-01_PART02.md`
§6) recorded two red surfaces **on the untouched baseline `9a15ad6`**:

* the five price-catalog suites — 47 failures;
* the six quotation suites — 5 failures.

PART 03 did **not** re-run the full suite. The two affected surfaces were
re-measured **once on the branch and once on the untouched baseline clone**
(`/tmp/hm-base` @ `9a15ad6`), each against its own disposable PostgreSQL,
and the failing test sets were diffed by name.

| surface | suites | branch | baseline | diff |
| --- | --- | --- | --- | --- |
| price-catalog | 5 | 47 failures | 47 failures | identical |
| quotation | 6 | 5 failures | 5 failures | identical |
| **total** | **11** | **52 / 114 assertions fail** | **52 / 114** | **the failing sets are identical — 0 new** |

### 5.1 The triage of the causes

| observed | cause | verdict |
| --- | --- | --- |
| HTTP 500 on the price-catalog entry creation (47 assertions) | a **sandbox/environment** failure of the price-catalogue entry creation path, present byte-identically on `9a15ad6` | **pre-existing, out of scope** — no Service-Catalog code is involved; the Service-Catalog price facts in PART 01/02/03 are created through the same service and work (they are created in the focused suites) |
| 403 where 201 is expected, 401 where 200 is expected (4 assertions of `handyman-quotations-api.test.ts`) | a **pre-existing RBAC/fixture** mismatch of that suite | **pre-existing, out of scope** |
| the frozen quotation-path count (12 vs the expected 10) | a **stale freeze pin**; behind it the `crewId` schema leak of `HandymanExecutionScopeAssignmentResponseView` | **pre-existing, out of scope** — another CR's defect, reported not fixed |

### 5.2 The release impact of the proven out-of-scope problems

* The price-catalogue suite is red **on `main` today**, before this CR. Any
  release that depends on that suite being green is already blocked by
  `main`, not by PART 03.
* The `crewId` leak exposes an internal field in a public projection — a
  real (small) information-disclosure defect that should be raised
  separately. It does not affect the Service-Catalog surface.
* **None of them touches the Service-Catalog flow.** The PART 01/02/03
  focused suites (15 + 12 + 10) and the OpenAPI census are green.

### 5.3 What PART 03 deliberately did NOT do

No test was changed to make it pass. The two test files touched by earlier
parts (`tests/price-catalog-entries.test.ts` — the `service_price_key` in
the hand-written INSERT) were left as they are.

---

## 6. E — delivery

### 6.1 Changed files

| file | change |
| --- | --- |
| `src/database/migrations/0480_handyman_service_request_item_inherited_attributes.ts` | **NEW** — `inherited_attribute_values JSONB NOT NULL DEFAULT '{}'`, the object CHECK, the partial index |
| `src/database/migrations/index.ts` | the `0480` registration (the only merge-conflict file) |
| `src/modules/handyman-parameterized-catalog/handyman-variant-inheritance.service.ts` | **NEW** — the contract module (`loadVariantAttributeValues`, `composeEffectiveItemAttributes`, `composeCorrectedItemAttributes`, `splitItemAttributes`) |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.repository.ts` | the `listVariantAttributeValues` join (the choice status + the attribute definition), the inherited column in SELECT / INSERT / UPDATE |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.types.ts` | `HandymanServiceRequestItemRecord.inheritedAttributeValues` |
| `src/modules/handyman-parameterized-catalog/handyman-request-items.service.ts` | the ADD path (inheritance + the contradiction refusal + the audit metadata) and the PATCH path (the merge, the correction, the re-selection, the detach + the audit metadata) |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog-pricing.service.ts` | the fail-closed guard: a non-positive amount is never quoted (defence in depth behind the DB CHECK) |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-quotation.service.ts` | the line description carries the variant code and marks the inherited attributes (`code*=value`) |
| `src/modules/handyman-parameterized-catalog/handyman-parameterized-quotation.routes.ts` | the `accessCondition` message names `SPECIAL_EQUIPMENT` (the vocabulary of `0479`) |
| `src/modules/handyman-parameterized-catalog/index.ts` | the barrel exports of the contract module |
| `docs/api/openapi.yaml` | the item schema gains `inheritedAttributeValues` and the widened access vocabulary; the POST and PATCH descriptions state the inheritance, the contradiction refusal and the MERGE semantics |
| `tests/cr-hm-service-catalog-01-part03.test.ts` | **NEW** — the 10 contract tests |
| `docs/handyman/CR-HM-SERVICE-CATALOG-01_PART03.md` | **NEW** — this document |

### 6.2 Verification

| check | result |
| --- | --- |
| `tests/cr-hm-service-catalog-01-part03.test.ts` | **10 / 10 PASS** |
| `tests/cr-hm-service-catalog-01-part01.test.ts` (regression) | **15 / 15 PASS** |
| `tests/cr-hm-service-catalog-01-part02.test.ts` (regression) | **12 / 12 PASS** |
| OpenAPI / census suites (3 files) | **17 / 17 PASS** (the census pins are unchanged — PART 03 adds **no** path) |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| disposable PostgreSQL | **474** migrations apply (473 → 474); the column, the object CHECK and the index exist; `0480` rolls back (the column is gone) and re-applies cleanly |
| affected regression (11 suites, branch vs the untouched baseline) | 52 failures on **both** — the failing sets are identical, **0 new** |

### 6.3 The initial-quotation integration (what actually happens now)

```
POST /handyman/requests/{id}/items        <- the variant is selected here
   -> the variant's ACTIVE configuration is read ONCE
   -> the effective set is materialised on the item
   -> a contradiction is refused (400) BEFORE the row is written

POST /handyman/requests/{id}/quotation/prepare
   -> the EXISTING price authority resolves every item against the
      EFFECTIVE set (inherited + own)
   -> READY  -> createHandymanQuotation (root + version 1 DRAFT)
                addHandymanQuotationLine  (quantity, UOM, currency,
                finalQuotedUnitAmount = the governed fact's amount,
                description = "SERVICE Name variant CODE [CODE*=value, ...]
                qty N access CONDITION")
                insertResolution (append-only price snapshot)
   -> not READY -> MANUAL_REVIEW / INSPECTION_REQUIRED, NO quotation

POST /handyman/requests/{id}/quotation/revision   (after an inspection)
   -> the corrected item re-resolves -> a NEW immutable version (version 2)
   -> version 1 is never edited
   -> issuing + the customer approval stay on the EXISTING lifecycle
```

### 6.4 Backend E2E risk

| risk | assessment |
| --- | --- |
| the E2E suite of another CR authors request items with explicit attribute values **and** a variant | the item's own values now win over the variant **only when they agree**; a contradicting value is a **400** instead of a silently accepted item. An E2E fixture that states a size different from the variant it selects must be corrected — this is the intended contract, but it is the one visible behaviour change. |
| an E2E suite PATCHes `attributeValues` expecting a REPLACE | the semantics changed to MERGE. A fixture that expects the unstated values to disappear would now see them kept. |
| the new column | `NOT NULL DEFAULT '{}'` — no backfill, no rewrite of the existing rows, and the old rows keep their (own) values as their effective set, so an item that existed before PART 03 keeps working exactly as before. |
| the price resolver | the new guard only triggers on a non-positive amount, which the DB CHECK already forbids — the resolution of a governed fact is unchanged. |
| the quotation line description | the text now carries `variant <code>` and `*` on the inherited attributes. A snapshot test that asserts the exact description string would see the new text. |

### 6.5 FINAL REVIEW blockers

| # | blocker | state |
| --- | --- | --- |
| 1 | merge with `origin/main` | `origin/main` is `ee20d21` (unchanged since the PART 02 simulation); `0480` is **free** on main (main ends at `0475`). The only merge-conflict file remains `src/database/migrations/index.ts` — the `0480` registration must survive the merge, and the census pins must be re-pinned if main moved again (they did not). |
| 2 | the pre-existing price-catalogue red surface | **not a PART 03 blocker** — proven identical on the untouched baseline; it blocks `main`, not this CR. It must be triaged by whoever owns the price-catalogue entry creation path. |
| 3 | the `crewId` schema leak | **not a PART 03 blocker** — another CR's defect; reported in §5.2. |
| 4 | the price-catalogue `entry_kind` / amount validation asymmetry | the API validates `unitPrice > 0` (400), the service layer does not (the DB CHECK catches it). It is a pre-existing asymmetry of the price catalogue; PART 03 relies on the DB CHECK and adds a resolver guard. It is reported, not changed. |
| 5 | the "one quotation thread per request" rule | the existing engine refuses a second quotation for one request, so the initial quotation can only be prepared once per request. This is the EXISTING contract and PART 03 does not change it — but an E2E that prepares twice must expect the `409`/`already exists` refusal. |
| 6 | the access-condition dimension | the access vocabulary is fixed (`0479`). A per-service access policy would need a governed dimension in the price authority — a PART 04 candidate, not a PART 03 gap. |

---

## 7. Known gaps / PART 04 candidates

* **The starter import still writes no variant-attribute rows.** A starter
  catalogue therefore has variants whose configuration is empty, and an item
  that selects such a variant inherits nothing. The starter import is
  idempotent and must not overwrite existing data, so adding starter
  configurations is a governed decision (which variant gets which value,
  and whether an existing starter catalogue may be re-imported with
  configurations).
* **The variant-inheritance provenance is on the item, not on the
  quotation.** The quotation line records the variant code and the
  inherited attributes in its description; a structured line-level
  provenance table would be the cleaner model.
* **A variant can only be re-selected, never "re-derived".** There is no
  operation that refreshes an item from the current catalogue — by design
  (R5), but a governed "refresh" operation would need its own audit and
  approval story.
* **The access complexity is not inherited** — it is a work fact of the
  item, chosen by the person who attended the site.
