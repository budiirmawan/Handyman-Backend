# CR-HM-MASTER-TENANT-BATCH-01 — Investigation: `BUILDING_ACCESS_DENIED` and `NOT_FOUND`

Scope: investigate only. Per the CR instructions, code changes are made **only
where the evidence proves a Backend defect**, and cross-Building access is
**never** widened. Findings below are the evidence trail behind that decision.

## 1. `NOT_FOUND` on Unit reads and service-catalogue reads

**Symptom.** Handyman-Operations BFF selectors under `api/admin/master-data.ts`
(GET Unit, GET service-catalogue categories/entries) surface `404 NOT_FOUND` on
production.

**Evidence.**

- The exact BFF paths (`/buildings/{b}/units[...]`,
  `/service-catalog/categories`, `/service-catalog/entries/{id}/...`) only exist
  from `CR-HM-MASTER-IND-01` — Backend PR **#44** (migration `0456`,
  `src/modules/apartment-master/`, catalogue administration). They are **not**
  on Backend `main` (`9f86a98`).
- `src/app.ts` registers `notFoundHandler` (`src/shared/http/not-found.ts`)
  which emits `{ success:false, error:{ code:'NOT_FOUND', ... } }` with HTTP 404
  for any unmatched path. A route that does not exist therefore *looks* like a
  missing resource.
- Path-by-path comparison of the BFF allow-list against PR #44 routes shows the
  BFF and the new Backend routes agree exactly (including UUID params). No
  routing mismatch, no method mismatch, no prefix drift (`/api/v1` pinned
  everywhere).

**Verdict.** Not a Backend code defect in `main`. The endpoints exist on the
unmerged PR #44. **No code fix is warranted**; the resolution is the human
merge of PR #44. This CR stacks on top of PR #44 (`65da7d0`) precisely so the
Tenant import builds on the same Unit vocabulary.

## 2. `BUILDING_ACCESS_DENIED` in the Tenant directory

**Symptom.** A user with full Client-level rights (e.g. a user who can list the
Client's registry) sees 403 `BUILDING_ACCESS_DENIED` in Tenant-directory data
surfaces.

**Evidence.**

- Access resolution is `resolveBuildingsForUser`
  (`src/modules/building-assignments/building-assignment.service.ts`): a user's
  reach is exactly the set of Buildings with ACTIVE user assignments
  (assignment → Building ACTIVE → Property → Client). There is no "same-Client
  shortcut".
- Registry reads (`resolveClientReadScope`) are intentionally wider for
  protected roles (installation Client registry) — reading the *registry* is
  not the same as reading *operational data inside* the Client's Buildings.
- Tenant-directory data (tenant-companies, tenant-spaces, unit party roles) is
  gated by `contextAccessService.canAccessClient/canAccessBuilding`, i.e. the
  Building-assignment chain. A user without an ACTIVE assignment covering that
  Building/Client is denied — by design (BE-02 tenant isolation).

**Verdict.** Working as designed (BE-02 "no same-Client shortcut"). It is a
provisioning/UX gap (users need Building assignments, or a clearer surface), not
a Backend authorization bug. **No code change** — and in particular no widening
of cross-Building/cross-Client access. The denial vocabulary
(`403 BUILDING_ACCESS_DENIED`, non-enumerating) stays as-is.

**Guidance for Operations/Frontend (in the handoffs):**

1. Provision `user_building_assignments` for staff who must see Tenant data in
   a Building (assignment is the only grant of Building reach).
2. UI must treat 403 `BUILDING_ACCESS_DENIED` as "outside your Buildings",
   never as "does not exist", and must not probe other Buildings.
3. Batch-import rows re-check Building reach per row and fail with the same
   vocabulary (no new denial language).

## 3. Scope of the fix that *was* made (for contrast)

The only Backend changes in this CR are new capabilities required by the CR
(batch import lifecycle; verification state with authority guards) plus
additive error/audit vocabularies. No existing authorization path was relaxed,
no existing contract silently changed, and existing verified parties behave
byte-identically.
