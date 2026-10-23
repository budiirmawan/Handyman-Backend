# CR-HM-WORKER-COMPETENCY-01 — PART 03 Backlog (proposed)

Derived from PART 02 delivery. Ordered by risk, not by size. Items 1–4, 6–10 remain unimplemented;
item 5 (requirement enforcement) was delivered by PART 03A — see
`CR-HM-WORKER-COMPETENCY-01_PART03A_DELIVERY_REPORT.md`.

## P0 — required for a complete certification lifecycle

1. **Expiry sweeper / notification dispatch**
   - Scheduled job (`due-job-scheduler`) that promotes ACTIVE → EXPIRED at the expiry instant, so no read
     path has to derive it on the fly, and emits a renewal reminder through the existing notification
     modules (no new notification transport).
   - Idempotency + replay safety and a per-Client batching cap.

2. **Evidence download endpoint with its own scope**
   - `GET /api/v1/workforce/:workforceId/certifications/:certificationId/document` streaming the verified
     bytes, re-checking Client access at the byte boundary. Today Mobile only learns
     `documentAvailable` / `documentId`; there is no scoped download path.

3. **Certificate re-verification policy**
   - When a certificate is corrected (issuer, number, dates) after being VERIFIED, the decision must be
     invalidated (revert to `PENDING_VERIFICATION`) or explicitly re-attested, with an audit event.
     PART 02 leaves an already-VERIFIED certificate VERIFIED across a metadata edit; that is safe today
     only because `isValid` re-derives from dates, but it is not a governance-complete rule.

## P1 — operational completeness

4. **Bulk operations** — bulk register (CSV/JSON import per Client) and bulk expiry review, following the
   existing tenant-batch-import conventions (validation report, per-row status, no partial writes).
5. ~~**Workforce-requirement enforcement**~~ — **DELIVERED by PART 03A**
   (`CR-HM-WORKER-COMPETENCY-01_PART03A_DELIVERY_REPORT.md`): per-job-type requirements
   (`service_catalog_competency_requirements`, migration `0463`), enforced at the single existing
   assignment authority for assign **and** reassign, plus eligibility/candidates reads. Remaining
   PART 03B follow-ups are listed in `CR-HM-WORKER-COMPETENCY-01_PART03B_BACKLOG.md`.
6. **Certification history read model** — verified decisions are currently reconstructable only from
   `operational_events`; expose a typed, paginated decision history per certificate.
7. **Worker self-service submission** — let a worker submit their own certificate (always
   `PENDING_VERIFICATION`, never self-verified), with the same evidence policy and Client isolation.
   Requires an explicit field-authority decision; PART 02 keeps create on the Operations side.

## P2 — hardening & parity

8. **Cross-repo/provider certification parity** — compare provider-level (`vendor_licenses_certifications`)
   and worker-level certificates for the same vendor and surface a reconciliation report.
9. **Audit export** — include certification events in the reporting-export datasets with the same
   permission parity rules as the other Handyman exports.
10. **Stale contract pins** — reconcile `tests/openapi-operational-final-parity.test.ts` (1687),
    `tests/deployment-cors-production.test.ts` (migration count/head) and the `r08-*` migration-count
    pins, which are already stale on `main` and were deliberately left untouched by PART 02.
11. **Frontend handoff** — Operations web screens (registry, expiry watch, verify queue) and Mobile
    screens (certificate list on the worker profile, expiry badges) consuming §7 of
    `MOBILE_API_HANDOFF.md`.

## Explicitly out of scope for the CR

- Star ratings / soft-skill scoring (unmodeled; never fabricated).
- Payroll, licensing-fee or vendor-scoring consequences of a certificate decision.
- Any change to the frozen `skillValidityWindows` / `providerLicensesAndCertifications` semantics.
