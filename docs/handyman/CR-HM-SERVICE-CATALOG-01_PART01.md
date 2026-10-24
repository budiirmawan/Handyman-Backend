# CR-HM-SERVICE-CATALOG-01 — PART 01: PARAMETERIZED CATALOG BACKEND

**Status:** PART 01 COMPLETE (coding + focused verification) — awaiting FINAL REVIEW
**Repo:** Handyman-Backend
**Branch:** `arena/d4d4105f-handyman-backend`
**Migrations:** `0476_handyman_parameterized_service_catalog`, `0477_service_price_tier_key`

---

## 1. What PART 01 delivers

A parameterized Handyman service catalogue that composes the EXISTING
authorities and adds no parallel engine:

| Concern | Existing seam | Decision |
|---|---|---|
| Service master | `service_catalog` (0321) | **REUSE** — the starter import creates catalogue entries in the existing master; the parameterized layer is a child of it. |
| Service variant | `handyman_service_variants` (0376) | **REUSE** — the default `STANDARD` variant of every starter service is a row of the existing variant master. |
| Reference price | `price_catalog_entries` (0319 + 0325) | **REUSE + EXTEND (0477)** — the amount authority. 0477 adds ONE governed discriminator (`service_price_key`) so a service may carry several simultaneously ACTIVE catalogue price tiers. |
| Quotation lifecycle | `handyman-quotations` (0391–0394) | **REUSE** — the quotation root, versions, lines, issuing and the customer decision stay exactly where they are. |
| Client/Building scope | `context-access` (BE-02G) | **REUSE** — exact-Building guard, no same-Client shortcut. |
| Catalogue governance (attributes, commercial posture, price rules, starter import, request items, price snapshots) | none | **NEW** — migration 0476. |

**Reference Price != Quotation != Final Charge** (CR-HM-02) is preserved: the
catalogue selects a governed reference price; the quotation line is the
customer-facing offer; the final charge remains the existing execution/finance
lane. The business model is unchanged — the customer pays the Handyman
directly and the Handyman pays the BM cooperation fee.

---

## 2. Data model (migration 0476)

Seven additive tables, every one of them `client_id`-scoped and proven against
its parent through a composite scope FK:

| Table | Purpose |
|---|---|
| `handyman_service_categories` | The governed category vocabulary of one Client. |
| `handyman_service_attributes` | Configurable technical attribute definitions (NUMBER / TEXT / ENUM / BOOLEAN, required flag, allowed values, free-value flag). |
| `handyman_service_variant_attributes` | Attribute values a service VARIANT fixes. |
| `handyman_service_commercial_profiles` | The commercial posture of one service: `FIXED`, `ESTIMATED` or `INSPECTION_FIRST`. |
| `handyman_service_price_rules` | (service, variant, attribute selector, quantity band, price basis) → the governed price fact. **Stores no amount, no currency and no effective date.** |
| `handyman_service_request_items` | The MIXED items of one Handyman Service Request: one row per service / variant / attribute combination with its own quantity and access condition. |
| `handyman_service_quote_resolutions` | The APPEND-ONLY price snapshot. A trigger blocks UPDATE and DELETE; the snapshot check allows amounts only on a `PRICED` row. |

Scope law: `service_catalog(id, client_id)`, `handyman_service_variants(id,
client_id)`, `handyman_service_requests(id, client_id)` and
`price_catalog_entries(id, client_id)` are the composite scope anchors — a
row can never reach across a Client.

### 0477 — the catalogue price tier key

`price_catalog_entries` (0325) allows exactly ONE ACTIVE reference price per
(client, service, currency, scope tier, effective window). That is the right
law for a plain service reference price, but it makes a PARAMETERIZED price
impossible: "1 PK non-inverter", "1 PK inverter" and "5+ units" are three
different prices for the same catalogue service and all three must be ACTIVE
at the same instant.

0477 therefore widens the SERVICE half of the ACTIVE-window exclusion with one
governed, additive discriminator:

* `price_catalog_entries.service_price_key TEXT`
  * MATERIAL rows: `NULL` — the column does not exist for MATERIAL and
    MATERIAL pricing stays byte-identical.
  * SERVICE rows: `NOT NULL`. `''` is the PLAIN service reference price (the
    client's baseline, and the only tier the plain effective-price lookup can
    ever see). A non-empty key names a CATALOGUE PRICE TIER and is shared with
    the catalogue price rule that consumes the price (the rule code and the
    tier key are the same governed string).

The plain lookup (`price-catalog-lookup.service.ts`) only ever sees the `''`
tier, so its "at most one winner per scope tier" law is untouched. The
replacement and correction lanes inherit the key from their predecessor, so a
tiered price keeps its tier through its whole lineage.

---

## 3. The governed starter catalogue

`src/modules/handyman-parameterized-catalog/handyman-parameterized-catalog.starter.ts`
is the single reviewable statement of what a Client receives:

* **8 categories** — AIR_CONDITIONING, PLUMBING, ELECTRICAL, FURNITURE,
  APPLIANCE, MINOR_CIVIL, LOCK_SECURITY, GENERAL_MAINTENANCE.
* **24 generic services** (3 per category), e.g. `AC_INSTALLATION`,
  `AC_REPLACEMENT`, `AC_MAINTENANCE`, `ELECTRICAL_DIAGNOSIS`,
  `MINOR_CIVIL_TILE`, `LOCK_ACCESS_INTERCOM`, …
* **AC attributes** — `AC_CAPACITY` (NUMBER, PK, required, free value
  allowed; standard 0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 2.5 / 3 PK plus
  configurable additional sizes), `AC_TYPE` (SPLIT / CASSETTE / STANDING /
  DUCTED), `AC_DRIVE_TYPE` (INVERTER / NON_INVERTER), `AC_EXISTING_UNIT`.
* **5 quantity UOMs** — `HM_UNIT` (unit), `HM_POINT` (point), `HM_METER`
  (meter), `HM_SQM` (m²), `HM_VISIT` (visit) — one per price basis.
* **One default variant** per service (`STANDARD`).
* **NO AMOUNT.** The starter never invents a price; a Client prices its
  catalogue explicitly through the governed price authority.

### Starter import contract

`importHandymanServiceCatalogStarter(clientId, actorUserId)`:

* **Idempotent** — every insert is `ON CONFLICT DO NOTHING`; a second import
  creates nothing.
* **Concurrency-safe** — one `pg_advisory_xact_lock` per Client inside one
  transaction, so two concurrent imports serialise.
* **Non-destructive** — existing rows are never updated, only skipped. A
  locally renamed service keeps its name after a later import.
* **Audited** — exactly one `HANDYMAN_SERVICE_CATALOG_STARTER_IMPORTED`
  operational event per run.
* Returns per-entity `{ created, skipped }` counts for categories, services,
  attributes, variants, commercial profiles and units of measure.

---

## 4. Price resolution — fail closed by construction

`resolveHandymanRequestItemPrice(item, { clientId, buildingId, effectiveAt })`
resolves ONE item at ONE effective instant. It never computes a price of its
own:

1. **Attribute validation** — an unknown attribute code is reported before a
   missing required one, and both before an invalid value, so the recorded
   reason names the FIRST thing that is wrong.
2. **Commercial posture** — `INSPECTION_FIRST` ⇒ `INSPECTION_REQUIRED`; a
   missing profile ⇒ `MANUAL_REVIEW`.
3. **Variant coherence** — the variant must belong to this service and this
   Client (the EXISTING variant master is the only variant notion).
4. **Rule selection** — variant + attribute selector + quantity band.
5. **Building scope** — a Building-scoped price applies only to its own
   Building.
6. **Deterministic precedence** — variant-specific > narrower quantity band >
   longer attribute selector. Genuinely equal candidates ⇒
   `PRICE_RULE_AMBIGUOUS` / `MANUAL_REVIEW`.
7. **Price fact validity** — ACTIVE, SERVICE mode, this service, and effective
   at the requested instant.
8. **Quantity UOM** — the UOM of the price basis (`HM_UNIT`, `HM_POINT`,
   `HM_METER`, `HM_SQM`, `HM_VISIT`).
9. `computedTotal = round(quantity × unitAmount, 2)`.

The bounded reason vocabulary: `PRICE_RESOLVED`, `ATTRIBUTE_UNKNOWN`,
`ATTRIBUTE_MISSING`, `ATTRIBUTE_VALUE_INVALID`,
`PRICING_MODE_INSPECTION_FIRST`, `PRICE_RULE_NOT_FOUND`,
`PRICE_RULE_AMBIGUOUS`, `PRICE_NOT_AVAILABLE`, `PRICE_CURRENCY_MISMATCH`,
`UNIT_OF_MEASURE_MISSING`, `COMMERCIAL_PROFILE_MISSING`,
`SERVICE_VARIANT_MISMATCH`.

**There is no default price, no interpolated price and no "best guess"
branch.** A missing price produces an inspection / manual-review need and NO
amount.

---

## 5. Quotation composition (no parallel quotation engine)

`prepareHandymanCatalogQuotation` (initial) and
`reviseHandymanCatalogQuotation` (post-inspection) compose the EXISTING
lifecycle:

* the quotation root and version 1 come from `createHandymanQuotation`;
* every commercial line comes from `addHandymanQuotationLine` (immutable
  snapshot, DB-calculated line total, one currency per version);
* a revision comes from `createHandymanQuotationRevision`;
* issuing comes from `issueHandymanQuotationVersion`;
* the customer approval stays the EXISTING `decideHandymanQuotation` decision
  surface.

The only thing PART 01 adds is the governed SELECTION of what goes into a
line: the price rule, the price fact, the quantity, the effective date and the
resulting immutable snapshot.

Two hard rules:

1. **No fictional price.** If ANY item cannot be priced, NO quotation and NO
   line is created — the outcome is `INSPECTION_REQUIRED` or `MANUAL_REVIEW`
   with the reason recorded as a resolution snapshot.
2. **One currency per version.** The prepare/revise lanes pre-check currency
   uniformity BEFORE creating a quotation, so a currency conflict can never
   leave a half-quoted DRAFT behind.

The revision lane requires a recorded inspection (the EXISTING inspection
authority), because the revision exists BECAUSE an inspection happened. An
issued version is never rewritten.

---

## 6. HTTP surface (18 operations)

### Admin CRUD — `service_catalog.read` / `service_catalog.manage`

| Method | Path |
|---|---|
| GET | `/service-catalog/parameterized/categories` |
| GET | `/service-catalog/parameterized/services` |
| POST | `/service-catalog/parameterized/starter-import` |
| GET | `/service-catalog/parameterized/entries/{serviceCatalogId}/attributes` |
| POST | `/service-catalog/parameterized/entries/{serviceCatalogId}/attributes` |
| PATCH | `/service-catalog/parameterized/attributes/{attributeId}` |
| GET | `/service-catalog/parameterized/entries/{serviceCatalogId}/commercial-profile` |
| PUT | `/service-catalog/parameterized/entries/{serviceCatalogId}/commercial-profile` |
| GET | `/service-catalog/parameterized/price-rules` |
| POST | `/service-catalog/parameterized/entries/{serviceCatalogId}/price-rules` |
| PATCH | `/service-catalog/parameterized/price-rules/{priceRuleId}` |

### Request items + quotation — `tenant_company.read` / `tenant_company.manage`

| Method | Path |
|---|---|
| POST | `/handyman/requests/{handymanRequestId}/items` |
| GET | `/handyman/requests/{handymanRequestId}/items` |
| PATCH | `/handyman/requests/{handymanRequestId}/items/{itemId}` |
| DELETE | `/handyman/requests/{handymanRequestId}/items/{itemId}` |
| POST | `/handyman/requests/{handymanRequestId}/quotation/prepare` |
| POST | `/handyman/requests/{handymanRequestId}/quotation/revision` |
| GET | `/handyman/requests/{handymanRequestId}/price-resolution` |

No new permission code was seeded: the catalogue reuses the EXISTING
`service_catalog.*` permissions and the Handyman surface reuses the EXISTING
`tenant_company.*` permissions.

---

## 7. Governance invariants

* **Tenant isolation** — the catalogue is Client-scoped; the Client of a
  child row is DERIVED from the addressed service entry, never from the
  caller. A foreign Client never gets an existence signal.
* **Building scope (BE-02G)** — every request item, resolution, quotation
  preparation and revision runs the exact-Building guard traced to the parent
  request. There is no same-Client shortcut.
* **Audit** — every catalogue write, every item write, the starter import and
  every price resolution are recorded as operational events.
* **Append-only snapshots** — `handyman_service_quote_resolutions` rejects
  UPDATE and DELETE at the database level.
* **Bounded transport** — unknown body fields and unknown query parameters are
  refused; every ID is UUID-validated; every amount-bearing decision belongs
  to the governed price authority.

---

## 8. Focused verification

`tests/cr-hm-service-catalog-01-part01.test.ts` — 15 assertions in 5 suites,
run against a DISPOSABLE embedded PostgreSQL (unique port, removed after the
run):

| # | Assertion |
|---|---|
| 1 | Starter import: 24 services / 8 categories, idempotent (0 created / 24 skipped on the second run), never overwriting a locally renamed service, one audit event per run, the five basis UOMs present, and NO price rule in the starter. |
| 2 | MIXED AC: one request with 0.5 PK split, 2 × 1.5 PK split and 2 PK cassette → READY, three quotation lines with the right quantities, one currency, the governed unit amount and the computed totals. |
| 3 | INVERTER / NON-INVERTER: the inverter rule wins for an inverter unit, the base rule for a non-inverter unit — different governed amounts. |
| 4 | QUANTITY TIERS: the narrower band wins (1 unit at the base price, 5 units at the bulk tier price). |
| 5 | FIXED vs INSPECTION_FIRST: an INSPECTION_FIRST service produces `PRICING_MODE_INSPECTION_FIRST`, no quotation thread and no amount. |
| 6 | UNKNOWN ATTRIBUTE: `ATTRIBUTE_UNKNOWN`, no amount, no quotation. |
| 7 | MISSING REQUIRED ATTRIBUTE: `ATTRIBUTE_MISSING`. |
| 8 | MISSING PRICING: `PRICE_RULE_NOT_FOUND` / `MANUAL_REVIEW`, no amount, no quotation. |
| 9 | PRICE NOT EFFECTIVE at the requested date: `PRICE_NOT_AVAILABLE`. |
| 10 | QUOTATION REVISION: after an inspection and a scope change, the revision produces version 2 (ISSUED) with the new quantity, version 1 stays untouched, the EXISTING customer decision approves it, and both resolutions are recorded. |
| 11 | PRICE SNAPSHOT: re-pointing the rule at a newer governed price never moves the recorded snapshot, and the snapshot row cannot be rewritten (DB trigger). |
| 12 | 401 (anonymous) and 403 (no permission) on both the admin and the request-item surfaces. |
| 13 | 403 for a caller with no assignment to the request's Building (no same-Client shortcut). |
| 14 | CROSS-CLIENT ISOLATION: two Clients' catalogues never mix, and a Client A price fact can never be used for a Client B service. |
| 15 | Admin projection over HTTP: 8 categories, 3 services filtered by category, and an unknown body field refused. |

Additional verification: `npm run typecheck` (clean), `npm run build`
(clean), the OpenAPI census suites (28 assertions green — Handyman surface
287 → 294, total runtime 2,034 → 2,052, in-scope operational 1,964 → 1,982,
OpenAPI operational 1,963 → 1,981), and a disposable migration validation
(472 migrations apply; 0477 and 0476 roll back and re-apply cleanly).

---

## 9. Known gaps / PART 02 candidates

* The catalogue price tier key is a governed STRING shared with the price
  rule code. A future PART may replace it with a structured selector on the
  price fact itself.
* The access condition (`STANDARD`, `DIFFICULT`, `HIGH_FLOOR`, `RESTRICTED`)
  is captured on the item and carried into the quotation line description, but
  it does not yet select a surcharge — that needs a price rule dimension that
  the current price authority cannot carry without a further extension.
* The `handyman_service_variant_attributes` table is written by the starter
  import (one default variant per service) but is not yet exposed by the admin
  CRUD API.
