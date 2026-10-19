# CR-HM-MASTER-IND-01 — Apartment Master Data Indonesia

Bounded contract + database review of the modules affected by Indonesian
apartment master data and the already-deployed Customer Care Tenant Request
Gateway (PR #43). Classification: **reusable**, **incomplete**, **missing**.

Baseline preserved: PR #43 (merged), migration `0455`, canonical Handyman
Requests (`handyman_service_requests`), Customer Care Bearer authorization
(`handyman.care.building` + exact Building assignment), Operations queue, BM
handoff, and all existing Client/Property/Building/tenant records.

## 1. Review scope

Only these modules/tables were read and touched:

| Area | Modules / tables |
| --- | --- |
| Customer identity | `tenant-companies` (`tenant_companies`), `tenant-pics` (`tenant_pics`) |
| Physical structure | `buildings`, `floors`, `areas`, `rooms`, `spaces`, `properties` |
| Occupancy | `tenant-spaces` (`tenant_space_relationships`), `tenant-building-contexts` |
| Catalogue | `service-catalog` (`service_catalog`), `handyman-catalog` (`handyman_service_variants`, `handyman_common_material_profiles`), `price-catalog-entries` (unchanged) |
| Intake | `handyman-care-standalone-discovery` (gateway + readers), `handyman-channel-attributions`, `handyman-requests` |
| Cross-cutting | `auth`/RBAC, `context-access` (BE-02 isolation), `shared/pagination`, migrations `0455`/`0456` |

Out of scope by design: financial ledger, invoicing, quotations, BAST, QC,
dispatch, provider/mobile surfaces, SaaS control plane.

## 2. Capability classification

### REUSABLE (no change)

| Capability | Authority | Note |
| --- | --- | --- |
| Client → Property → Building isolation | `buildings`/`properties` + `context-access` | Server-derived Client; assignment-based 403; unchanged |
| Floor / Area / Room / Space physical master | migrations `0034`–`0041` | Space is the authoritative Unit; no second physical master created |
| Effective-dated tenancy (occupancy) | `tenant_space_relationships` (`0146`) | Already effective-dated, ACTIVE-unique per Unit, history retained via INACTIVE |
| Occupancy close / change | `PATCH /tenant-space-relationships/{id}` | Auto-closes `effective_until` on INACTIVE |
| Tenant↔Building context | `tenant_building_contexts` (`0147`) | Requires a resolvable occupancy (kept) |
| Canonical Handyman request + intake lifecycle | `handyman_service_requests` (`0378`, frozen D3) | Single `INTAKE` state; untouched |
| Immutable channel attribution & creator/represented split | `handyman_channel_attributions` (`0374`) | Creator ≠ represented Tenant already structural |
| Customer Care authority (Bearer + exact Building) | `0450`, `handyman-care-authority` | Untouched; reused by every new Care read |
| Catalogue service identity + variants + material references | `0321`, `0376`, `0377` | Services already implemented and tested |
| Effective-dated pricing | `price_catalog_entries` (`0319`) | Reused as-is; not duplicated |
| Pagination / error / success envelopes | `shared/pagination`, `shared/api-response` | Reused by all new list endpoints |
| RBAC + non-enumerating denials | `permissions`, `handyman.care.building`, `BUILDING_ACCESS_DENIED` | Reused; new capability only for Unit party data |

### INCOMPLETE (extended, not replaced)

| Gap | Evidence | Closure |
| --- | --- | --- |
| Physical customers were company-shaped only | `tenant_companies` had `tenant_name` + optional `legal_name`; an individual required a fictitious company | `party_kind` (`INDIVIDUAL`/`LEGAL_ENTITY`) + Indonesian identity document (`KTP`/`PASSPORT`/`KITAS`/`NPWP`/`NIB`), per-Client document uniqueness, one physical party master |
| Unit administration was Room-scoped only | `POST/GET /rooms/{roomId}/spaces`; no Building/Floor-scoped Unit view | Building/Floor-scoped Unit reads, detail and name/description/status writes; identity immutable |
| Occupancy history was not readable per Unit | `GET /buildings/{buildingId}/tenant-spaces` returned raw relationships without party join or pagination | `GET /buildings/{buildingId}/units/{unitId}/occupancies` with party master, `current` evaluation, pagination |
| Catalogue administration had no HTTP transport | Variant/material services existed but were internal-only; categories were free text with no vocabulary read | Categories read + variant/material list+create endpoints delegating to the existing services |
| No approval / cost-responsibility party | Request creator (user) and represented Tenant existed; who approves / who pays did not | Append-only `handyman_request_parties` (`APPROVAL`, `COST_RESPONSIBILITY`), optional on the PR #43 create, validated against the Unit roles |

### MISSING (new, minimal)

| Gap | Why genuinely missing | Implementation |
| --- | --- | --- |
| Unit Owner / Occupant / Unit PIC relationships | No table carried these roles with history; `tenant_pics` is a contact list scoped to a tenant party, not a Unit role | `unit_party_roles` (migration `0456`), effective-dated, ACTIVE/INACTIVE, history preserved |
| Request-level commercial parties | No payer/approval column or table anywhere in the request/attribution model | `handyman_request_parties` (append-only, one designation per role per request) |
| Unit party capability | No permission covered Unit-level party data | `unit_party.read` / `unit_party.manage` (reference-master authority; PLATFORM_ADMIN by seed) |

## 3. Deliberate non-duplication decisions

1. **Unit = existing `spaces` row.** The Customer Care gateway already exposes
   spaces as Units, tenant eligibility already resolves through the Space
   chain, and the physical hierarchy is already governed. A `units` table would
   create two physical truths and a migration/backfill for every existing
   record. `unitId` in the new API is documented as `spaces.id`.
2. **TENANT is not re-modelled.** `tenant_space_relationships` remains the only
   occupancy authority (effective window + ACTIVE uniqueness + history).
   `unit_party_roles` covers only `OWNER`/`OCCUPANT`/`PIC`.
3. **No lifecycle invention.** Role lifecycle is `ACTIVE`/`INACTIVE` with an
   explicit effective window (the `0146`/`0147` idiom); request party roles are
   exactly `APPROVAL`/`COST_RESPONSIBILITY`.
4. **No pricing copy.** Variants/materials keep referencing the existing price
   catalog; `handyman_common_material_profiles` still has no price columns.
5. **No category table.** Categories stay on `service_catalog.category`; the
   new read exposes the administered vocabulary only.
6. **No request-party edits.** Designations are facts (`INSERT` only, triggers
   reject `UPDATE`/`DELETE`), so commercial responsibility history cannot be
   rewritten.

## 4. Database change summary (migration `0456_apartment_master_data`)

| Change | Type |
| --- | --- |
| `tenant_companies.party_kind`, `identity_document_type`, `identity_document_number` | additive columns + checks |
| `tenant_companies (id, client_id)` unique | additive constraint (scope-FK anchor) |
| `tenant_companies` identity-document partial unique index | additive index |
| `unit_party_roles` | new table + context/immutability trigger + partial unique index |
| `handyman_request_parties` | new table + append-only/party-scope trigger |
| `unit_party.read`, `unit_party.manage` | permission rows (no role grant by migration) |

Rollback drops the two new tables and the added columns/constraints; permission
rows are intentionally retained (the `0442`/`0446`/`0448`/`0450` precedent).

## 5. Isolation and integrity argument

- **Client scope is structural.** `unit_party_roles` proves Client scope with a
  composite FK to `tenant_companies (id, client_id)`; `handyman_request_parties`
  proves it against both the canonical request and the party master.
- **Building/Unit consistency is structural.** The `unit_party_roles` trigger
  resolves `Space → Room → Area → Floor → Building → Property` and rejects any
  mismatch of Building or Client, even if the service layer were bypassed.
- **No arbitrary payer.** The request-party trigger accepts only the
  represented Tenant or a party holding a currently-effective Unit role on the
  request's Unit.
- **No enumeration.** Cross-Building access is `403 BUILDING_ACCESS_DENIED`;
  across Care it is the single `403 HANDYMAN_CARE_AUTHORITY_DENIED`. Unknown
  Unit is `404 APARTMENT_UNIT_NOT_FOUND`, and a foreign-Client party is
  reported exactly like an unknown one.

## 6. Remaining gaps (not silently closed)

1. **Payer is declarative.** `COST_RESPONSIBILITY` is recorded and validated,
   but the existing invoice/ledger authority still derives the billed party
   from the execution-scope Tenant. Wiring the designation into invoicing is a
   separate financial-authority change.
2. **Approval is declarative.** Authority B (quotation/variation/BAST
   decisions) still uses the existing tenant decision/consent contracts; the
   `APPROVAL` designation is not (yet) a decision credential.
3. **No Unit-level tenant eligibility flag.** Eligibility remains derived
   (ACTIVE service + ACTIVE current relationship/context), not stored.
4. **Occupancy write path is unchanged.** Creating/ending tenancy still uses
   the BE-14C endpoints; no new occupancy write was added.
5. **Service-charge / utility Unit linkage** is out of scope for this CR.
6. **No bulk import** for towers/units/parties.
