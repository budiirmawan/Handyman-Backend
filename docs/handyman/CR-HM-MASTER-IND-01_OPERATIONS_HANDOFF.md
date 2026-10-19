# CR-HM-MASTER-IND-01 — Handyman Operations Handoff

**Audience:** Handyman-Operations repository (Backend consumers).
**Status:** Backend implemented, tested, PR open. No deploy, no production
migration, no production data created by this CR.
**Machine-readable contract:** [`docs/api/CR-HM-MASTER-IND-01_OPENAPI.yaml`](../api/CR-HM-MASTER-IND-01_OPENAPI.yaml)
**Review / classification:** [`CR-HM-MASTER-IND-01_MASTER_DATA_REVIEW.md`](./CR-HM-MASTER-IND-01_MASTER_DATA_REVIEW.md)

## 1. What changed for consumers

Everything already consumed by Operations is unchanged. PR #43 intake, the
canonical request projection, Operations queue visibility, triage authority,
BM handoff and Customer Care Bearer authorization are byte-compatible.

Additive surfaces:

| Capability | Endpoints |
| --- | --- |
| Units of a Building (Unit = existing Space) | `GET /api/v1/buildings/{buildingId}/units`, `GET/PATCH /api/v1/buildings/{buildingId}/units/{unitId}` |
| Effective-dated occupancy history per Unit | `GET /api/v1/buildings/{buildingId}/units/{unitId}/occupancies` |
| Owner / Occupant / PIC of a Unit | `GET/POST /api/v1/buildings/{buildingId}/units/{unitId}/parties`, `POST /api/v1/unit-party-roles/{id}/end` |
| Catalogue administration | `GET /api/v1/service-catalog/categories`, `GET/POST /api/v1/service-catalog/entries/{serviceCatalogId}/variants`, `GET/POST /api/v1/service-catalog/entries/{serviceCatalogId}/material-profiles` |
| Individual / legal-entity Tenants | `POST /api/v1/clients/{clientId}/tenant-companies` (additive `partyKind` + identity document), `PATCH /api/v1/tenant-companies/{id}` |
| Approval / cost-responsibility parties | Post body extension on `POST /api/v1/handyman/care/buildings/{buildingId}/requests`; read `GET /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/parties` |

## 2. Identity model Operations must adopt

```
Client (operator)
└── Property
    └── Building (tower)
        └── Floor
            └── Area → Room
                └── Space  ==  UNIT (spaces.id)
                     ├── tenant_space_relationships   = TENANT / occupancy (BE-14C)
                     └── unit_party_roles             = OWNER | OCCUPANT | PIC
Party master: tenant_companies (partyKind = INDIVIDUAL | LEGAL_ENTITY)
Request parties: handyman_request_parties (APPROVAL | COST_RESPONSIBILITY)
```

**Critical for frontend/Operations:** `unitId` is `spaces.id`. Do not look for a
`units` table or a separate Unit identity. `GET /buildings/{buildingId}/units`
is the supported Unit listing.

Four distinct actors must never be collapsed in the UI or API calls:

| Actor | Where it lives |
| --- | --- |
| Creator (Backend user) | authenticated session / `created_by_user_id` |
| Represented Tenant | channel attribution / request `tenant_company_id` |
| Unit Owner / Occupant / Unit PIC | `unit_party_roles` (effective-dated) |
| Approval / Cost-responsibility party | `handyman_request_parties` (immutable facts) |

## 3. Customer Care gateway extension (PR #43 compatible)

`POST /handyman/care/buildings/{buildingId}/requests` now also accepts:

```json
{
  "tenantCompanyId": "...",
  "tenantPicId": "...",
  "spaceId": "...",
  "serviceCatalogId": "...",
  "serviceVariantId": "...",
  "description": "...",
  "approvalTenantCompanyId": "...",
  "costResponsibleTenantCompanyId": "..."
}
```

- Both new fields are **optional**. Omitted → the represented Tenant is used,
  i.e. exactly the pre-CR behavior.
- A designated party must be ACTIVE, in the same Client, and either the
  represented Tenant or a party holding a **currently-effective Unit role** on
  the selected Unit (or, with no Unit selected, an ACTIVE current Building
  context).
- Any other designation produces the single non-enumerating
  `403 HANDYMAN_CARE_AUTHORITY_DENIED` and persists nothing (the idempotency
  claim is not even opened).
- The `201` body is the unchanged PR #43 projection. The designations are read
  from the new parties endpoint; they are not added to the request projection.
- `Idempotency-Key` remains mandatory. The two designations participate in the
  request fingerprint, so the same key with a different payer is
  `409 IDEMPOTENCY_CONFLICT`.

## 4. Auth matrix (all new endpoints)

| Endpoint | Permission | Additional runtime authority |
| --- | --- | --- |
| `GET /buildings/{b}/units`, `GET /buildings/{b}/units/{u}` | `space.read` | ACTIVE assignment to the exact Building |
| `PATCH /buildings/{b}/units/{u}` | `space.manage` | same |
| `GET .../units/{u}/occupancies` | `tenant_company.read` | same |
| `GET .../units/{u}/parties` | `unit_party.read` | same |
| `POST .../units/{u}/parties`, `POST /unit-party-roles/{id}/end` | `unit_party.manage` | same |
| `GET /service-catalog/categories`, variant/material reads | `service_catalog.read` | Client reach (existing rule) |
| Variant/material creates | `service_catalog.manage` | Client reach + ACTIVE parent service |
| Care parties read | `handyman.care.building` | ACTIVE assignment to the exact Building |
| Care create | `handyman.care.building` | same + tenant/Eligibility/party scope |

`unit_party.read` / `unit_party.manage` are new permission codes. The migration
registers them without granting any role; the foundation seed grants them to
`PLATFORM_ADMIN`. Granting them to an operational role is a deliberate,
auditable administrative action.

## 5. Error contract (new codes only)

| Code | HTTP | Meaning |
| --- | --- | --- |
| `TENANT_IDENTITY_DOCUMENT_ALREADY_EXISTS` | 409 | One identity document per Client already used |
| `UNIT_PARTY_ROLE_NOT_FOUND` | 404 | Unknown / out-of-reach role assignment |
| `UNIT_PARTY_ROLE_ALREADY_ACTIVE` | 409 | Same party already holds the role on the Unit |
| `UNIT_PARTY_ROLE_CONTEXT_MISMATCH` | 400 | Party/Unit/Building/Client cannot be combined |
| `UNIT_PARTY_ROLE_UNAVAILABLE` | 400 | Unit or party is not ACTIVE |
| `APARTMENT_UNIT_NOT_FOUND` | 404 | Unknown, foreign-Client or other-Building Unit |
| `APARTMENT_UNIT_FLOOR_MISMATCH` | 400 | Floor filter does not belong to the Building |

Existing codes are reused unchanged for authorization
(`BUILDING_ACCESS_DENIED`, `HANDYMAN_CARE_AUTHORITY_DENIED`), validation
(`VALIDATION_ERROR`) and catalogue errors.

## 6. Pagination

Every new list uses the shared contract: `page` (1-based, default 1),
`pageSize` (1..200, default 50), response `meta`
`{ page, pageSize, total, totalPages }`. Occupancy and party lists include
`status` filters; party lists additionally accept `role`
(`OWNER`/`OCCUPANT`/`PIC`).

## 7. Acceptance evidence

`tests/cr-hm-master-ind-01.test.ts` (9 focused HTTP tests on disposable
embedded PostgreSQL):

1. Individual Tenant created as master data (no fictitious company), linked to
   one eligible Unit; undocumented individual / individual with legal name
   rejected.
2. Distinct Owner, Occupant and Unit PIC on the same Unit; duplicate assignment
   `409`; ending a role preserves the INACTIVE history row.
3. Tenant change: old occupancy stays readable as INACTIVE/historical, new
   occupancy is the only `current` row.
4. Invalid combinations denied: foreign Unit `404`, foreign-Client party `404`,
   wrong Floor `400`, cross-Building assignment `404`.
5. Only ACTIVE catalogue services are readable by Customer Care; deactivated
   service disappears from the reader.
6. Cross-Building `403` for master surfaces and the Care surface.
7. PR #43 create still returns the unchanged `INTAKE` projection, records
   `APPROVAL` = represented Tenant and `COST_RESPONSIBILITY` = Owner, and the
   request remains readable through the existing Care detail endpoint.
8. A party unrelated to the Unit is denied without disclosure and nothing is
   persisted.
9. Catalogue administration: categories, variant create/list, material
   reference create/list, cross-Client catalogue denial.

## 8. Remaining gaps / follow-ups

1. **Payer wiring into finance.** `COST_RESPONSIBILITY` is recorded, but
   invoicing/ledger still bills the execution-scope Tenant. Consuming the
   designation requires a financial-authority CR.
2. **Approval as decision credential.** Authority B (quotation/variation/BAST)
   still uses the existing tenant decision contracts; `APPROVAL` is declarative.
3. **Unit administration writes are bounded** to name/description/status. Unit
   creation remains `POST /rooms/{roomId}/spaces`; a floor-level bulk
   provisioning API is not implemented.
4. **No bulk import** for towers, units, parties or occupancies.
5. **Occupancy writes** remain the BE-14C endpoints; this CR only added the
   Unit-scoped history read.
6. **Category master** is still a free-text column; a governed category table is
   a documented future promotion.
