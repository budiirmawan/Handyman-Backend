# CR-HM-MASTER-TENANT-BATCH-01 — Frontend Handoff (Customer Care app)

Audience: Handyman-Frontend (Customer Care + Building Manager modules).
Backend branch `arena/6853ae83-handyman-operations`. Contract:
`docs/api/CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml` (Backend repo).

## 1. What changes for you (and what does not)

**Unchanged (do not touch):** every Customer Care API you already call —
Building workspace summary, selections (floors/units/tenants/PICs), request
create, evidence upload, request detail/progress. The canonical request DTO is
byte-identical (no party fields; `INTAKE` status). `spaces.id` /
`tenant_companies.id` / `tenant_pics.id` remain the ONLY identity vocabulary
for your payloads.

**Additive:**

1. `verificationStatus` now appears on Tenant party and PIC reads:
   `PENDING_VERIFICATION` | `VERIFIED` | `REJECTED`.
   - Show it as a badge in tenant/PIC pickers and detail screens.
   - Imported (temporary) registrations arrive as `PENDING_VERIFICATION`.
   - Existing parties are `VERIFIED` — your current screens behave exactly as
     before.
2. **Authority rule** — approval authority and billing (cost-responsibility)
   authority are only granted to a `VERIFIED` party. Request creation with an
   unverified party (as the represented tenant's default parties OR as an
   explicit `approvalTenantCompanyId` / `costResponsibleTenantCompanyId`
   designation) fails with `409 TENANT_VERIFICATION_REQUIRED`:
   ```json
   { "success": false, "error": {
       "code": "TENANT_VERIFICATION_REQUIRED",
       "message": "Tenant party is not VERIFIED; unverified parties cannot hold approval or billing authority.",
       "category": "CONFLICT", "retryable": false } }
   ```
   UI copy: "Tenant ini belum diverifikasi. Verifikasi dulu sebelum
   mengajukan/menanggung biaya permintaan." — and never silently drop the
   designation.

## 2. Verification actions (Operations performs these)

`POST /tenant-companies/{id}/verification` and
`POST /tenant-pics/{id}/verification` with body `{"status":"VERIFIED"}`
(`tenant_company.manage` — Operations admin, not Care staff). If your module
includes an admin surface, gate it behind that permission; otherwise surface
the status read-only and let Operations run the verdict.

## 3. Compatibility guarantees (signed off by focused tests)

- PR #43 intake flow: preserved (canonical INTAKE request, distinct creator vs
  represented tenant/PIC, idempotency key semantics).
- PR #44 designations: approval/cost-responsibility parties recorded exactly
  as before for VERIFIED parties (`tests/cr-hm-master-ind-01.test.ts` 7-8 +
  `tests/cr-hm-master-tenant-batch-01.test.ts` 8 stay green).
- Default designation (represented tenant = approval + payer) works unchanged
  for verified tenants.
- Cross-Building/unknown-tenant denials keep the same non-enumerating
  `HANDYMAN_CARE_AUTHORITY_DENIED` — no new denial language on your surface.

## 4. What you must NOT do

- Do not invent a placeholder Tenant/PIC for a unit with an unknown occupant
  (the import refuses such rows server-side; your UIs must follow).
- Do not treat `PENDING_VERIFICATION` as verified "locally" to bypass the 409.
- Do not round-trip identity document numbers (they are masked in every read).
