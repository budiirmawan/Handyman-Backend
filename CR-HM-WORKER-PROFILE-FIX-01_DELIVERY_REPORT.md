# CR-HM-WORKER-PROFILE-FIX-01 — Production Schema Compatibility

**Scope:** Handyman-Backend only. No production database change, no deployment.
**Branch:** `arena/8f1ba51f-handyman-backend`.
**Surface:** `GET /api/v1/handyman/field/me/profile` and
`GET /api/v1/handyman/field/workers/:workerContextId/profile`.

## 1. Incident

`GET /api/v1/handyman/field/me/profile` returned **HTTP 500** on the Biznet
PostgreSQL instance. `CORE_WORKER_SELECT` in
`src/modules/handyman-worker-profile/handyman-worker-profile.service.ts`
referenced six columns that the canonical migration registry never creates:

| Referenced (before) | Actual schema |
| --- | --- |
| `handyman_worker_contexts.worker_code` | not modeled (0385) |
| `handyman_provider_contexts.provider_code` | not modeled (0384) |
| `workforce_profiles.client_id` | not modeled (0024); client derives via `organizations.client_id` (0020) |
| `workforce_profiles.email` | not modeled (0024); identity email lives on `users` (0002) |
| `workforce_profiles.phone` | not modeled; only `users.whatsapp_phone` (0301) |
| `workforce_profiles.employment_type` | not modeled; only `workforce_type` (0024/0031) |

## 2. Full audit of the module (not just the reported SELECT)

The same drift existed in every secondary query of the projection:

| Query | Invalid reference | Fix |
| --- | --- | --- |
| Core worker select | 6 columns above; `wp.client_id` join; `v.organization_id`; `vendor_workforce_bindings.client_id` | rebuilt on real FKs: profile → organization → client, provider context → vendor, binding by `(vendor_id, workforce_profile_id)` |
| Crew memberships | `handyman_work_crews.building_id`, `handyman_crew_memberships.joined_at` | `buildingId` = `NULL` (crews are provider-scoped per 0386); `joinedAt` = membership `created_at` |
| Building placements | `wba.client_id`, `property_id`, `assignment_role`, `is_primary` | client via `buildings → properties.client_id`; `propertyId` from `buildings.property_id`; role = placement category constant; `isPrimary` derived from the earliest ACTIVE placement |
| Work-session counts | `status IN (… 'WORK_COMPLETED')` — not a legal 0401 state | aligned to `CHECKED_IN / IN_PROGRESS / PAUSED / MATERIAL_RUN / COMPLETED` vs `CHECKED_OUT` |
| Skills + validity windows | skill master not client-scoped | joined through `skills.client_id = worker client` (also in `workforceSkillRepository.listEffectiveSkills`, optional third arg) |
| Provider certifications | columns valid | unchanged; failures now log a bounded warning instead of silently swallowing |
| Recent work orders | `handyman_service_requests.request_code`, `title`, `property_id` | `requestCode` from `origin_reference` (fallback deterministic `HM-<id8>`); `title` from `description`; no `property_id` |

No other module referenced any of these non-existent columns (verified by
repository-wide grep and by the by-context/RBAC suites).

## 3. Behaviour preserved / guaranteed

- **Client isolation is structural**, not advisory: provider context, vendor,
  organization, building placement, skills and execution scopes are all pinned
  to the worker context's `client_id`. `contextAccessService.canAccessClient`
  and the crew-lead RLS check are untouched.
- **RBAC unchanged** — self, active crew lead, and Operations/Customer Care
  (`tenant_company.read|manage`) paths verified end-to-end.
- **Controlled 404** for an authenticated actor with no worker context
  (including `PLATFORM_ADMIN`): `HANDYMAN_WORKER_PROFILE_NOT_FOUND`, never a
  500, and no synthetic profile.
- **Skills and certifications** are projected when present; a worker with no
  skills/certificates returns `200` with empty arrays.
- **API contract unchanged.** Field names, nullability and the commercial
  firewall (no amounts/invoice data in `workHistorySummary`) are identical; only
  the data source of each field changed. Derivation notes were added to
  `docs/api/openapi.yaml` (descriptions only) and `MOBILE_API_HANDOFF.md` §5.3.

## 4. Tests

- `tests/handyman-worker-profile.test.ts` — fixture schema rewritten to be a
  column-faithful subset of the migrations (it previously invented every one of
  the broken columns, which is why review passed). Adds cases for a worker
  without skills/certifications and the controlled 404. **4/4 pass.**
- `tests/handyman-worker-profile-schema-regression.test.ts` (new) — applies the
  **real migration registry** (`migrateUp`, 461 migrations) to a disposable
  PostgreSQL cluster, builds fixtures with the real domain services (provider
  context, crew, scope assignment, skills incl. an expired window and a
  cross-client skill, vendor certification, work session, user building access)
  and exercises both HTTP endpoints. Also asserts via `information_schema` that
  the six offending columns do not exist. **5/5 pass.**
- `tests/handyman-arrival-locations.test.ts` — **10/10 pass** (shared handyman
  fixtures, real migrations).
- `npm run build` — passes. `tsc --noEmit` — passes.

## 5. Follow-ups (out of scope, no action taken)

- If the Mobile client needs a true per-worker call-sign (e.g. `WKR-PIC-01`
  independent of the vendor personnel code), it must become a modeled column
  with its own migration; today the projection is deliberately derived.
- Crew building scope and per-worker building role/primary semantics remain
  unmodeled; adding them is a schema CR, not a query fix.
