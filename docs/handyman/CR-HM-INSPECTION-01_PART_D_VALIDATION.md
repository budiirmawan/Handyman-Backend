# CR-HM-INSPECTION-01 — PART D integrated journey

## Baseline and bounded change

- Verified starting HEAD and remote: `748cbc16a91f966deadbd358ad912b42b1e6a43c`.
- Branch: `arena/d04dc185-handyman-backend`; starting worktree clean.
- Early test checkpoint pushed before execution: `3a11782`.
- Added one test: `tests/handyman-inspection-integrated-journey.test.ts`.
- Reused PART A/B/C without modifying production services, routes, permissions,
  seeds or migrations. No new production role or provisioning surface; no
  Platform Admin, mock authority, disabled trigger or fabricated business-chain row.

## Test-only prerequisites (not production provisioning)

The test starts a fresh embedded PostgreSQL instance on port 55508 with a unique
temporary data directory and database. It applies existing migrations, never
uses a development/production database and never silently skips if setup fails.
Database connections and PostgreSQL are stopped and the temporary directory is
removed at teardown.

Master-data fixtures use existing services for client/property/building/unit,
tenant occupancy/space authority, PIC and catalogue; UOM setup uses HTTP. Existing
scoped-access test helpers supply disposable RBAC fixtures with narrowly selected
existing permission codes. These synthetic test grants are **not** new production
role definitions or proof of an approved Operations provisioning/grant process.
No Platform Admin helper is used. The Operations writer, assigned Field and
represented Tenant PIC are separate identities. Wrong-Building actors are under
the same Client, so the negative checks cannot pass merely through Client scope.

Two test-only BM-channel integration records use existing internal integration
and capability seams: `CUSTOMER_CARE` and `TENANT_PIC` are separate, exclusive
capabilities. Records are channel-level, not per-tenant integration provisioning.
Each receives a randomly generated ephemeral secret in the test process only,
before capability activation. No secret is written to a file, command argument,
database or report; environment keys are removed at teardown. Both Care and PIC
admission call the actual signed HTTP routes. These fixtures do **not** resolve
production G9 bootstrap/secret-delivery certification, and the older blocked G9
journey test is left untouched.

## Actual execution

```sh
NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1 tests/handyman-inspection-integrated-journey.test.ts
```

**Actual result: PASS 1 / FAIL 0 / SKIP 0 / CANCELLED 0.** Exit code 0.
One integrated test executed, with six completed checkpoint diagnostics. No
other test file or full suite ran. Total runner duration was approximately 21.8
seconds. The duplicate PIC-assertion constraint log is expected: that request
was refused as 401. PostgreSQL also logged an idle-connection termination during
teardown; it did not fail a test or interrupt a journey step.

## Verified journey and negative assertions

| Stage | Actual verification |
|---|---|
| Customer Care | Signed `/handyman/care/session` → property-scoped create-exchange → `/handyman/requests/care`. Creates INTAKE with BM_SUPER_APP provenance, reporter snapshot and no inferred PIC authority. |
| Operations intake | Queue list/detail exposes the same request, Care actor, reporter and exact Building. |
| Triage | Wrong-Building Operations receives 403; authorized Operations records INSPECTION_REQUIRED. |
| PART A assignment | Wrong-Building Field target refused (400). Correct assigned Field recorded; identical assignment returns 200/no change and exactly one assignment row. |
| Physical inspection | Another Field user in the same Building receives 403; Field user in another Building receives 403. Assigned Field records the single INSPECTED fact. |
| PART B report | Wrong-Field/Building submission refused. v1 pending → Operations RETURNED → Field correction v2 → Operations ACCEPTED. Duplicate pending submission is 409 without a second version; it is not claimed to be idempotent success. |
| PART C prerequisite | Missing report, pending report, returned report and pending correction each deny diagnosis and initial quotation with 409; no diagnosis, quotation or Execution Scope appears. |
| Acceptance | Wrong-Building review refused; Operations reviewer differs from Field submitter. Returned v1 remains unchanged, v2 references v1, and acceptance alone creates no diagnosis. |
| Diagnosis | Separate Operations HTTP diagnosis records the server-resolved accepted v2 source and authenticated Operations actor. |
| Quotation | Creates DRAFT, commercial line and ISSUED version through HTTP. Issue succeeds with zero approval bindings: **B12 stays OFF**. |
| Premature Execution Scope | Zero scopes through intake, inspection/report gates, issue and binding. Scope read returns 404 at DRAFT and after issue before PIC approval. |
| Signed PIC session | Actual `/handyman/pic/session` signature verification and hash-only session lookup; exact integration/PIC linkage. Replayed signed assertion returns 401. Care credential cannot act as PIC (401). |
| Approval authority | Valid PIC without explicit binding gets 409. Staff decision route returns **403 PERMISSION_DENIED**, with deprecation header: **S1 preserved**. |
| Explicit binding | Existing staff binding HTTP route supplies late PIC authority; same-key replay returns the same binding with `replayed: true`. Binding itself creates no Execution Scope. PIC eligibility read becomes eligible. |
| PIC approval | PIC HTTP APPROVE produces one TENANT_PIC ledger row and one AUTHORIZED Execution Scope with correct request/version/Building/unit, binding and session provenance. No staff decision/scope creator is fabricated. Scope is readable through existing HTTP route. |
| Decision replay | Identical PIC replay returns the original decision/scope; same key with REJECT is 409. Exactly one decision, scope and approval audit event remain; version is APPROVED. |
| History | Late binding/approval leaves the Care request's null PIC lineage intact; immutable returned/accepted report history is unchanged by approval. |

## Runtime blocker verdict

**No runtime contract blocker was encountered in this isolated journey.** No
production fix or bypass was necessary. PART A/B/C, signed PIC-session authority,
explicit binding, S1 and the existing approval-to-Execution-Scope transaction
completed together through their real routes.

## Remaining certification limits

- This certifies an isolated backend HTTP journey, not a live BM host, frontend,
  external identity system, production integration provisioning or deployment.
- Approved deployed Operations roles/grants, G9 bootstrap, secure secret injection
  and operational rotation remain outside this test. Test fixtures are not their
  substitute, and broader contract/F8 freeze readiness is not claimed.
- Direct-quotation eligibility stays deferred. No new direct-path policy is
  exercised or authorized here.
- NOT_INSPECTABLE disposition/revisits, historical null-source remediation,
  comprehensive revocation/concurrency/load/failure testing and post-scope
  execution/payment flows are outside this one journey.
- Existing data and migration 0441 are untouched. This uses a fresh database, not
  a production-history upgrade rehearsal; no broader historical regression or
  full suite was run.
- No repo-wide audit, PR, deploy or PART A/B/C reimplementation.
