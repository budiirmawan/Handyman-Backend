# CR-HM-BE-CARE-CATALOG-METADATA-01 — PART 06 Delivery

Authorized Building-session catalogue metadata for the Care structured intake.

- **Change request:** `CR-HM-BE-CARE-CATALOG-METADATA-01`
- **Part:** PART 06 (one focused Backend part — final part in scope)
- **Branch:** `arena/9ab3fff8-handyman-backend`
- **Verified baseline HEAD:** `d85e8fa71a1d2cb21a56d79092184e3d4b29b5cc`
- **Verdict:** **PASS**
- **Migration required:** **NO** (registry unchanged at 535 migrations)

> Read-only intake metadata. This part changes no request creation, no item
> engine rule, no quotation price or price-basis UOM, no inspection-first
> policy, no Internal Care Note, no BM exchange-token authorization, no BM
> access or permit authority, and no scheduling/assignment/payment/
> settlement/warranty behaviour.

---

## 1. Verified baseline

| Check | Result |
| --- | --- |
| `git rev-parse HEAD` | `d85e8fa71a1d2cb21a56d79092184e3d4b29b5cc` — matches the required ancestor |
| Required ancestor present | CONFIRMED (`git merge-base --is-ancestor 4ff4608 HEAD` → 0) |
| Branch | `arena/9ab3fff8-handyman-backend` (never switched) |
| Working tree before changes | Clean, tracked diff empty vs `d85e8fa` |
| Migration registry | 535 files, none touched |
| Pre-existing Care Building routes | Unchanged except the one additive route below |

The local checkout had been left at `4ff4608` while the branch head was
`d85e8fa`. The two untracked files were proven byte-identical to the branch
copies and the tracked diff was empty, then `git reset --hard origin/…`
restored the branch head. No branch switch, no re-clone, no unrelated work
overwritten.

---

## 2. SCOPE 1 — discovery outcome (why a new read, and why only one)

The mandatory discovery was done before any code was written. Findings:

| Question | Source model | Consequence |
| --- | --- | --- |
| Is there an existing Building-session care catalogue read? | `GET /handyman/care/buildings/:buildingId/catalogue/services` → `listBuildingCareCatalogueServices` | **Reused as-is.** It answers "which services/variants may I pick", but exposes *labels only*: no technical attributes, no allowed values, no inheritance, no UOM options. |
| Are attribute reads reachable for Care staff? | `handyman-parameterized-catalog` reads sit behind `requireServiceEntry`/`assertClientAccess` | **Not reusable.** They need commercial-catalog permissions Care staff do not and must not hold. |
| Can the commercial projection be reused? | `listHandymanServiceCatalogProjection` | **Forbidden** — it composes `commercialProfile` + `priceRules`. |
| Is there a UOM read API? | `src/modules/uoms/uom.routes.ts`, gated `uom.read`/`uom.manage` (seeded in `foundation-access.seed.ts:642`) | Care staff hold **neither**; a global grant is prohibited. |
| Can the Care *workspace* catalogue reader be reused? | `handyman-care-catalogue.repository.ts` / `readCareWorkspaceCatalogue` | **No.** It is bound to the Care WORKSPACE principal (`hcw_` session + property grant). Substituting that credential for a Building session would replace Building-session authentication, which is explicitly out of bounds. |
| Is there a service→UOM mapping? | `units_of_measure` is Client-owned; `price_basis` (`UNIT/POINT/METER/SQM/VISIT`) is a frozen enum on `handyman_service_price_rules`, not a UOM FK | **There is none.** No per-service UOM list may be invented. |

**Decision:** add exactly **one** Care-scoped read, keyed on the Client derived
server-side from the authorized Building. No permission seed change, no global
`service_catalog.read`, no global `uom.read`, no credential substitution, no
new authorization engine.

---

## 3. Reused vs added

### Reused without change

- **Authority chain (unchanged):** Bearer session → `requirePermission('handyman.care.building')` → `requireActiveAssignedBuilding` (exact ACTIVE Building + ACTIVE Property + active Client, returning `authority.scope.clientId`).
- Route conventions (`noStore`, `...AUTHZ`, `assertAllowedQuery`, `assertEmptyReadBody`, `parseUuid`, `sendSuccess`).
- `GET /handyman/care/buildings/:buildingId/catalogue/services` — still the selection pool; still ACTIVE services + ACTIVE variants.
- `POST /handyman/care/buildings/:buildingId/requests` and `GET …/requests/:requestId` — the PART 04 structured intake, byte-for-byte unchanged.
- The governed masters: `service_catalog`, `handyman_service_attributes`, `handyman_service_variants`, `handyman_service_variant_attributes`, `handyman_service_price_rules` (bounds only), `units_of_measure`.

### Added

| Artifact | Purpose |
| --- | --- |
| `src/modules/handyman-care-standalone-discovery/handyman-care-catalog-metadata.repository.ts` (178 lines) | One client-scoped, CTE-guarded read returning service + attributes + variants (+ inherited values) + quantity bounds + ACTIVE Client UOMs. |
| `…/handyman-care-catalog-metadata.service.ts` (257 lines) | `getBuildingCareCatalogueServiceMetadata` (authority first, lookup second), non-enumerating 404, projection, `APPLICABILITY`. |
| `…/handyman-care-standalone-discovery.routes.ts` (+38) | `GET …/catalogue/services/:serviceCatalogId`. |
| `…/index.ts` (+2) | Exports both new modules. |
| `docs/api/openapi.yaml` (+351) | Operation + 9 schemas. |
| `tests/handyman-care-catalog-metadata-part06.test.ts` (916 lines) | 9 focused tests (8 DB/HTTP + 1 contract closure). |

---

## 4. API response contract

```
GET /api/v1/handyman/care/buildings/{buildingId}/catalogue/services/{serviceCatalogId}
Authorization: Bearer <care staff session>
Permission: handyman.care.building
Cache-Control: no-store
```

`200` `data` (all objects `additionalProperties: false`):

```jsonc
{
  "service": {
    "id": "uuid", "code": "AC_INSTALLATION", "name": "…",
    "description": "…|null", "category": "AIR_CONDITIONING", "status": "ACTIVE"
  },
  "attributes": [{
    "id": "uuid", "code": "AC_CAPACITY", "name": "Kapasitas AC",
    "description": "…|null",
    "dataType": "NUMBER",            // NUMBER | TEXT | ENUM | BOOLEAN
    "unit": "PK",                    // free label on the definition, NOT a UOM ref
    "required": true,
    "allowFreeValue": true,          // true ⇒ out-of-vocabulary value retained for review
    "allowedValues": [{ "code": "0.5", "label": "0.5 PK" }],
    "sortOrder": 10,
    "status": "ACTIVE",
    "variantApplicable": true        // DERIVED: an ACTIVE variant configures it
  }],
  "variants": [{
    "id": "uuid", "code": "STANDARD", "name": "Standard",
    "description": "…|null", "status": "ACTIVE",
    "inheritedAttributeValues": [{
      "attributeId": "uuid", "code": "AC_CAPACITY", "name": "Kapasitas AC",
      "dataType": "NUMBER", "unit": "PK",
      "valueText": null, "valueNumber": 0.5,
      "value": "0.5"                  // single normalized form (see §5)
    }],
    "inheritedAttributeCodes": ["AC_CAPACITY", "AC_DRIVE_TYPE", "AC_TYPE"]
  }],
  "quantityConstraints": [{
    "serviceVariantId": "uuid|null", // variant scope, null = service scope
    "minimum": 1, "maximum": 10      // BOUNDS ONLY
  }],
  "unitsOfMeasure": [{
    "id": "uuid", "code": "HM_UNIT", "name": "Unit", "symbol": "unit",
    "category": "…", "displayLabel": "Unit (unit)"
  }],
  "applicability": {
    "serviceScope": "CLIENT",
    "reportableServiceStatuses": ["ACTIVE"],
    "selectableVariantStatuses": ["ACTIVE"],
    "uomScope": "CLIENT",
    "serviceUomApplicability": "NOT_GOVERNED",
    "attributeScope": "SERVICE",
    "attributeInheritance": "VARIANT_MATERIALISED",
    "notes": ["…4 statements of the gaps below…"]
  }
}
```

Documented failures:

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | malformed `buildingId`/`serviceCatalogId`, unknown query key, non-empty GET body |
| 401 | `AUTHENTICATION_REQUIRED` | no/expired session |
| 403 | `PERMISSION_DENIED` | session lacks `handyman.care.building` |
| 403 | `HANDYMAN_CARE_AUTHORITY_DENIED` | not an ACTIVE assignee of the exact ACTIVE Building, or its Client/Property lineage cannot be established |
| 404 | `SERVICE_CATALOG_NOT_FOUND` | **identical** for absent id, INACTIVE service, cross-Client service |

No commercial field exists anywhere in the payload: no `pricingMode`, no
`commercialProfile`, no `priceRules`/`ruleId`/`ruleCode`, no
`priceCatalogEntryId`, no `priceBasis`, no amount, no currency — and the
Client id is never serialized back.

---

## 5. Two decisions worth recording

### 5.1 One vocabulary: the inherited `value` form

The first test run caught a real cross-endpoint defect in the projection: the
NUMERIC column text made the metadata report `"0.5000"` while the item engine
normalizes the same value to `"0.5"`. The UI would have been told a value the
create contract then echoes back differently.

Fixed by mirroring the item engine's normalizer
(`loadVariantAttributeValues`: `valueText ?? String(valueNumber)`, trimmed) in
the projection, and by dropping configured rows that would normalize to
nothing — the item engine does not inherit those either, so they are not
advertised and `inheritedAttributeCodes` agrees byte-for-byte across
`GET /catalogue/services/:id`, `POST /requests` and `GET /requests/:id`.
Test 8 asserts exactly that agreement.

### 5.2 `variantApplicable` is derived, not stored

The source model has SERVICE-scoped attribute definitions only; there is no
per-variant attribute definition table. `variantApplicable` therefore means
"at least one reported ACTIVE variant configures this attribute", computed
from the inherited values. It is reported as derived and documented as such,
rather than pretending a per-variant schema exists.

---

## 6. Permission and Client isolation evidence

- **Permission:** the route reuses the existing `AUTHZ` array
  (`authenticationMiddleware` + `requirePermission(HANDYMAN_CARE_BUILDING_PERMISSION)`).
  No permission was added to the seed; `service_catalog.read` and `uom.read`
  remain ungranted to Care staff. Test 6 proves a session *with* an active
  Building assignment but *without* the permission gets `403 PERMISSION_DENIED`,
  and an anonymous call gets `401`.
- **Building authority:** `requireActiveAssignedBuilding` runs **before** any
  catalogue lookup, so an unauthorized Building costs one rejection and never
  touches the catalogue. Test 5 proves staff assigned only to a sibling
  Building of the same Client is `403 HANDYMAN_CARE_AUTHORITY_DENIED`.
- **Client isolation:** the service id is looked up as
  `service_catalog.id = $serviceCatalogId AND client_id = $derivedClientId AND status = 'ACTIVE'`.
  A foreign-Client id and a random id return the **same** error object (test 5
  compares the key sets), so the endpoint is not an existence oracle.
- **Scope is CLIENT, not Building:** the catalogue is a Client master. Sibling
  Building staff of the same Client legitimately read the same service through
  their own Building (test 5), and staff of *another* Client cannot (test 5).
- **Read-only:** the module contains no mutation path at all — no `INSERT`,
  `UPDATE` or `DELETE`, no transaction, no idempotency key, no event.

---

## 7. Test results

Command: `ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-reporter=tap <file>`
(real embedded PostgreSQL on a disposable port, real authenticated sessions).

| Suite | Result |
| --- | --- |
| `tests/handyman-care-catalog-metadata-part06.test.ts` | **9/9 PASS** |
| `tests/handyman-care-building-structured-items-part04.test.ts` (regression) | **12/12 PASS** |
| `tests/handyman-care-tenant-request-gateway-http.test.ts` (regression) | **15/15 PASS** |

The nine focused tests:

1. authorized read: service identity + dynamic attributes (type, unit, required, free-value, 11 governed `AC_CAPACITY` options, sort order) and derived applicability; a service with no governed attributes reports empty lists;
2. ACTIVE variants only, ordered by code, each exposing exactly the values it inherits (`P6_AC_05_NON_INVERTER` inherits three; the starter's `STANDARD` and a bare variant inherit none); `inheritedAttributeCodes` sorted and agreeing with the values;
3. ACTIVE Client-owned UOM options with stable ids, `displayLabel = "<name> (<symbol>)"`, the reported set equal to the ACTIVE owned set, and an INACTIVE UOM disappearing from the options (`HM_POINT`);
4. INACTIVE variant not reported and no longer making any attribute applicable; INACTIVE attribute retired from the vocabulary; INACTIVE service → `404 SERVICE_CATALOG_NOT_FOUND`, and the list endpoint agrees it is unavailable;
5. cross-Client id, absent id (identical error shape), cross-Building `403`, same-Client sibling Building allowed, foreign Client's staff cannot read;
6. missing `handyman.care.building` → `403 PERMISSION_DENIED`, anonymous → `401`, malformed id → `400`, unknown query key → `400`;
7. no commercial field: recursive key scan over the payload while a commercial profile provably exists in the DB; quantity constraints carry `serviceVariantId`/`minimum`/`maximum` only; no `priceBasis`/`pricingMode`/`price_catalog` anywhere in the serialized body;
8. the metadata contract drives the unchanged PART 04 structured create: the advertised `uomId`/`serviceVariantId` are the ones the item reports, `inheritedAttributeCodes` and every inherited `attributeValues[...]` agree, and `GET …/requests/:id` returns the same `items` with its unchanged shape;
9. OpenAPI closure: the operation, permission, security, documented statuses and error codes exist; the six required metadata fields and the attribute/UOM fields are documented; no commercial key is documented; the route source contains the path and reuses the Care permission.

Static checks:

- `npx tsc --noEmit` → **exit 0**
- OpenAPI `yaml` parse → OK; internal `$ref` walk → **0 unresolved**
- `git diff --check` → **CLEAN**
- Migration registry → 535, none added or modified

---

## 8. Unresolved gaps (documented, not hidden)

These are properties of the **source model**, reported in `applicability.notes`
rather than papered over:

1. **No service→UOM mapping is governed.** "Relevant UOM options" can only
   mean "every ACTIVE unit of measure owned by the Client", because that is
   exactly what the create engine validates (ACTIVE + same Client). No
   per-service subset is inferred (`serviceUomApplicability: NOT_GOVERNED`).
   *Governance follow-up (not this part):* if a per-service UOM restriction is
   ever required, it needs a real mapping table and its own change request.
2. **Reported UOM ≠ quotation pricing UOM.** `price_basis`
   (`UNIT|POINT|METER|SQM|VISIT`) is a frozen enum on the price rule, not a
   UOM reference. Metadata therefore exposes no pricing basis, and an intake
   UOM never implies a quotation basis.
3. **Attribute definitions are SERVICE-scoped only.** Per-variant applicability
   is derived (`variantApplicable`) from configured variant values, because no
   per-variant definition table exists.
4. **Quantity bounds are flattened.** `quantityConstraints` projects only
   `minimum`/`maximum` per variant scope; multiple ACTIVE rules for the same
   scope appear as multiple entries. They reveal no price, by design.

Out of scope by instruction and untouched: request creation, item engine,
migration history `0481–0535`, quotation prices and price-basis UOM,
inspection-first policy, Internal Care Notes, BM exchange-token
authorization, BM access/permit authority,
scheduling/assignment/payment/settlement/warranty. Building-session
authentication remains the Building-session authentication; a BM exchange
token was not introduced. Reported service items are not approved quotation
lines; tenant preferred dates are not confirmed appointments; access
conditions are not BM clearance.

---

## 9. Files changed

| File | Δ |
| --- | --- |
| `src/modules/handyman-care-standalone-discovery/handyman-care-catalog-metadata.repository.ts` | +178 (new) |
| `src/modules/handyman-care-standalone-discovery/handyman-care-catalog-metadata.service.ts` | +257 (new) |
| `src/modules/handyman-care-standalone-discovery/handyman-care-standalone-discovery.routes.ts` | +38 |
| `src/modules/handyman-care-standalone-discovery/index.ts` | +2 |
| `docs/api/openapi.yaml` | +351 |
| `tests/handyman-care-catalog-metadata-part06.test.ts` | +916 (new) |
| `docs/handyman/CR-HM-BE-CARE-CATALOG-METADATA-01_PART06_DELIVERY.md` | this report |

No migration. No seed change. No permission grant. No PR, merge or
deployment — **STOP after PART 06.**
