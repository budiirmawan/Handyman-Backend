# CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter Handoff

Backend-only contract for the Apartment Indonesia Handyman Service Catalog
Starter Pack. This PART adds the **Service Category master**, the
**Service Item → Category link**, **Client/Building availability grants**, the
**governed starter-pack import**, and the **authoritative read model**.

Authoritative machine contract: `docs/api/openapi.yaml` (base `/api/v1`).

## Business model (unchanged)

Handyman = external provider. Tenant pays the Handyman directly. BM =
facilitator partner receiving a cooperation fee. This PART **does not alter**
any payment or BM-fee authority (`handyman-bm-fee-rules` is untouched).

## Non-negotiable constraints

1. **No default price / no fictitious nominal amount.** The starter pack is
   identity only — zero prices. Any price shown is composed from the existing
   governed `price_catalog_entries` SERVICE authority and is `null` unless a
   governed entry resolves.
2. **No frontend in this PART.**
3. **No changes to `/handyman/**`** (frozen-03 pins exactly 287 Handyman ops).
4. **`GET /service-catalog/categories` keeps returning `string[]`** (pinned by
   `tests/cr-hm-master-ind-01.test.ts`).
5. **Additive, non-breaking.** The existing CR-BE-SVC-01 Service Catalog CRUD
   is unchanged; new columns are nullable/defaulted.

## Schema (migration 0473 — additive)

- `service_category` — `(client_id, code)` UNIQUE; `code` `/^[A-Z][A-Z0-9_-]*$/`
  2–64; `status` ACTIVE|INACTIVE; `source` MANUAL|STARTER_PACK.
- `service_catalog` += `service_category_id` (FK → service_category, nullable),
  `source` (NOT NULL DEFAULT 'MANUAL', CHECK MANUAL|STARTER_PACK) + index.
- `service_catalog_availability` — `(service_catalog_id, building_id)` UNIQUE;
  `status` ACTIVE|INACTIVE.

## Endpoints

Reads require `service_catalog.read`; management requires `service_catalog.manage`.
All management endpoints additionally enforce the existing Client access rule
(reach a Client only through a Building assignment) and audit via
`operational_events`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/service-catalog/catalog` | Authoritative read model (categories + items + availability + optional composed price) |
| GET | `/service-catalog/service-categories` | List Service Categories (`clientId`, `status` filters) |
| POST | `/service-catalog/service-categories` | Create a Category (ACTIVE, MANUAL) |
| GET | `/service-catalog/service-categories/{id}` | Read one Category |
| PATCH | `/service-catalog/service-categories/{id}` | Edit `name`/`description` (code immutable) |
| POST | `/service-catalog/service-categories/{id}/deactivate` | ACTIVE → INACTIVE (terminal; refused while items linked) |
| GET | `/service-catalog/entries/{serviceCatalogId}/availability` | List availability grants for a Service Item |
| POST | `/service-catalog/entries/{serviceCatalogId}/availability` | Grant availability in one Building |
| POST | `/service-catalog/entries/{serviceCatalogId}/availability/{availabilityId}/deactivate` | Revoke a grant |
| POST | `/service-catalog/entries/{serviceCatalogId}/category` | Link a Service Item to a Category |
| POST | `/service-catalog/starter-pack/import` | Import the starter pack (`Idempotency-Key` **required**) |

### Starter import (idempotent + concurrency-safe)

`POST /service-catalog/starter-pack/import`, body `{ "clientId": <uuid> }`,
header `Idempotency-Key`. Imports the frozen **8 categories / 24 services**
(see `service-catalog-starter-catalog.ts`) into one ACTIVE Client inside a
single transaction, using unique constraints + `ON CONFLICT DO NOTHING`
through the shared `request-idempotency` authority (no advisory locks, no
sleep/retry). Re-runs create nothing; a replayed call returns the recorded
summary with HTTP 200 and `replayed: true`.

## Read model shape

```
{
  clientId, buildingId, currency, asOf,
  categories: [{ ...ServiceCategory, services: [ServiceCatalogItemView] }],
  services:   [ServiceCatalogItemView]
}
```

`ServiceCatalogItemView` adds `categoryId/Code/Name`, `availabilityScope`
(`CLIENT_WIDE` | `BUILDING_SCOPED`), `availableInBuilding` (null when no
building scope requested) and `referencePrice` (null unless a `buildingId` +
`currency` are supplied **and** a governed SERVICE price resolves — never
guessed).

## Integration guidance

- **Customer Care** reads the customer-facing list from the existing frozen
  `GET /handyman/catalogue/services` (ACTIVE starter items appear automatically).
  Use `/service-catalog/catalog` for governed, category-grouped detail.
- **Operations Admin** manages Categories/availability through the endpoints
  above; the import is the only supported way to load the starter pack.
- **Pricing** is configured separately through the existing
  `price_catalog_entries` SERVICE authority; never on the catalogue.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — clean.
- `tests/service-catalog-master.test.ts` — 21 tests: starter-pack shape,
  validation grammar, migration registration, route/OpenAPI registration
  (DB-free), plus governed import idempotency, duplicate-code protection,
  concurrent imports, category CRUD/lifecycle, availability grants, cross-Client
  isolation and 401/403 (DB-gated, run with `ASENTRA_USE_EMBEDDED_POSTGRES=true`).
