# HANDYMAN R1C — Production-bounded Visit Proposal API & Operations Staging UI
Date: 2026-10-12

## Scope / provenance
- Backend baseline: `Handyman_Backend_Full_Updated_R0_R1A_R1B_2026-10-12.zip`, full original repository retained. No migration #0432 created. Existing #0431 is required.
- Operations baseline: `Handyman-Operations-Manager-Full-Redesign-V3.zip`, demo stays isolated.
- These artifacts are ZIP source snapshots, not Git commits or verified deployments.

## Newly implemented — Backend
- `GET /api/v1/handyman/requests/:handymanRequestId/visits` (authenticated, `tenant_company.read`, exact building-scope authority, request-scoped records).
- `POST /api/v1/handyman/requests/:handymanRequestId/visits` (authenticated, `tenant_company.manage`, strict whitelisted DTO). Inserts **PROPOSED only**. No tenant approval, no reservation, no confirmation.
- `POST /api/v1/handyman/requests/:handymanRequestId/visits/:appointmentId/cancel-proposal` (authenticated, `tenant_company.manage`, current version required, only PROPOSED may transition to CANCELLED, audit actor server-derived).
- Request ID/Client/Building/TenantCompany source always request row, never HTTP payload. Inspector proposal needs active `users` actor with explicit building assignment. Execution proposal needs active authorized execution scope + active crew assignment. Building timezone is read from `buildings`; interval requires explicit offset, future time, max 24h. Single live proposal per request/type enforced by #0431 DB unique index. All mutations are transaction-bound.
- Route does NOT let Customer Care or tenant approve a slot. It does NOT claim inspector skill/availability checked; proposal is a suggestion only.

## Newly implemented — Operations
- Navigation page `#/appointments` — **Visit Proposals**, backend-only read/propose/cancel UI, no localStorage lifecycle writes.
- Staging gate: `VITE_HANDYMAN_APPOINTMENT_STAGING=true` and `VITE_APP_ENV` **not** `demo`.
- Configure public, HTTPS API base `VITE_HANDYMAN_API_BASE=https://.../api/v1` on the staging deployment. Base URL is deployment-pinned, not caller-controlled. Authorization is via a short-lived backend-issued operator bearer token entered for the current page; never stored in localStorage or build env. This remains staging scaffolding, NOT a replacement for production SSO/session integration.
- Other Operations work-order/Finance data remain unconfigured in production. The existing demo continues to use its local dataset, explicitly unrelated to the real appointment feed.

## R1C intentionally NOT completed
1. Authenticated tenant choice/consent verifier (Care cannot act as tenant), required before TENANT_SELECTED/CONFIRMED.
2. Server-validated inspector skill, full calendar availability, and transactional reservation flow. DB exclusion constraint is present but no public booking code invokes it.
3. Permit, access clearance, visit start/attempt, no-show, inspect result guard composition and rebooking.
4. Execution booking confirmation, BAST issue, Finance verification, Manager CLOSE, Customer Care and Mobile dedicated scoped appointment APIs.
5. Migrations #0431 live execution/rollback, full TypeScript build with dependencies, Postgres live concurrency and four-app end-to-end certification.

## Verification performed
- 33/33 targeted Backend tests PASS (R1A core, R1B migration/repo-focused, R1C DTO tests).
- 4/4 Operations appointment adapter unit tests PASS.
- Syntax transpilation checks on changed TypeScript source PASS.
- Full `tsc --noEmit` cannot pass in this container without installed dependencies (`@types/node` and `vite/client` are absent); no typecheck/build claim.
- No DB was created or migrated, no Git commit/push, no deploy.

## Next bounded steps
1. Migrate disposable PostgreSQL and run route-level auth negative and double-session proposed/cancel/version tests.
2. Implement signed tenant-slot selection from tenant channel with authoritative tenant occupancy/identity context. Care can submit a preference, never attest consent.
3. Add eligibility/availability/reservation transaction and permit/start gates; only then expose CONFIRMED.
4. Add dedicated Care `read/request preferred slot` and Mobile `my visits` scoped interfaces; do not reuse operational `tenant_company.read` permissions.
5. Reconcile finance and final CLOSE and certify E2E across all four repos.
