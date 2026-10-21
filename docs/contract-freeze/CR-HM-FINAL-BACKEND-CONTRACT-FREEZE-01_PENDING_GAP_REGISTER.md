# Pending-Gap Register — CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01

Severity: P0 = breaks a journey; P1 = blocks FINAL FREEZE; P2 = decision/debt
that does not block the candidate. **No P0 is open.** No gap below requires a
new backend engine; the missing-engine era ended with PR #48 (0459/0460).

**Amendment (CR-HM-BACKEND-CONTRACT-FREEZE-02, PR #51, 2026-10-21):** FG-01 is
CLOSED (below). FG-02 counts refreshed. FG-05 re-verified. FINAL FREEZE remains
blocked only by FG-03 and FG-04; this register is re-issued as v1.1 with this
amendment.

**Amendment (CR-HM-BACKEND-CONTRACT-FREEZE-03, 2026-10-21):** FG-02 is CLOSED
(below); FG-10 added (baseline test debt found while re-running focused suites
— pre-existing, not a freeze-03 regression); FG-09 evidence refreshed. FINAL
FREEZE remains blocked only by FG-03 and FG-04; this register is re-issued as
v1.2 with this amendment. OpenAPI pin: SHA-256
`f2ffec3f0bc3e4aa5db74265caeb0738b530aee0c43ca9c4e299866831d70352`
(full changelog: `CR-HM-BACKEND-CONTRACT-FREEZE-03_CHANGELOG.md`).

| ID | Sev | Gap | Evidence | Disposition / owner | Blocks FINAL FREEZE? |
|---|---|---|---|---|---|
| FG-01 | — | **CLOSED by CR-HM-BACKEND-CONTRACT-FREEZE-02 (PR #51):** all 67 formerly route-only Handyman operations are now documented in `docs/api/openapi.yaml` with exact source-derived request/response schemas, authentication, permissions and error contracts (no generic invented schemas; no production behavior change). | Runtime↔OpenAPI census re-run 2026-10-21: **269/269 Handyman operations documented, 0 missing, 0 phantom**; spec 1494 paths/1985 ops/2202 schemas; 0 duplicate `operationId`s; 0 broken local `$ref`s. Focused suites 31/31 (`openapi-contract`, `mobile-openapi-completeness`, `handyman-bast-worker-read-openapi`, `handyman-payment-proof-openapi`, `handyman-field-feed-contract`, `material-chain-openapi`); `npx tsc --noEmit` PASS | — | — |
| FG-02 | — | **CLOSED by CR-HM-BACKEND-CONTRACT-FREEZE-03:** annotation policy completed for all 269 Handyman operations — **179 carry `x-required-permission`** (167 route guards + 1 dual-guard first-permission + 11 unconditional service-enforced permissions); the remaining **90 are composite-authority by design** (current Crew Lead/assigned worker, Care workspace session + occupancy, HMAC doors) and carry their rule in prose rather than a misleading single permission. In the same pass: `x-error-codes` completed 57 → **269/269** (AST-derived from handler→service call graphs, phantom codes removed) and explicit `security` 176 → **269/269** (incl. the new `tenantSlotAssertionSignature` scheme and the one intentional anonymous exchange). | RBAC guard census + AST error derivation + spec integrity suite (freeze-03 changelog §1.2); durably guarded by `tests/handyman-contract-freeze-03-openapi.test.ts` (seeded-permission membership, 179-count, phantom absence) | — | — |
| FG-03 | P1 | **Consumer compatibility unverified.** Frontend #33, Operations #22/#23, Mobile #14 are *reported* merged in their repositories; the one-repository rule forbids verifying them here. | Task brief; no cross-repo access in this CR | Sequential integration (Frontend → Operations → Mobile) against the handoffs; each consumer reports path+`error.code` issues back. | **Yes** |
| FG-04 | P1 | **Staging E2E and staging/production migration status not run.** Pending subset for any real environment is unknown. | This CR ran only disposable embedded PostgreSQL | Operator: `npm run db:migrate:status` on staging (read-only), apply pending migrations in registry order (schema candidate doc), then run the scenario pack. Production remains untouched until staging passes. | **Yes** |
| FG-05 | P2 | **Open PR #47 (bank-receipt attestation) excluded from candidate.** Its migration was numbered `0459`, which PR #48 has since taken (`0459_handyman_request_cancellation`); its finance-confirm extension is therefore unmergeable as-is. Current frozen contract: Finance `confirm` validates idempotency/authority only; Care payment proof remains a separate fact (0433). | `gh pr view 47` (OPEN); migration registry | Product/Finance decision: if bank attestation is required for final freeze, revive PR #47 rebased with migration renumbered **≥0461**, re-run its focused suite, bump candidate. If not required, close PR #47. Not duplicated here. **Freeze-02 (2026-10-21) re-verified, documentation only:** PR #47 still OPEN and unmerged; registry unchanged at 459 migrations, head `0460_handyman_settlement_dispute_adjudication`, `0449` reserved; no historical migration was modified and PR #47 was not imported. | Only if Finance requires attestation |
| FG-06 | P2 | **BAST external e-signature (PSrE/ECDSA) not implemented.** Current contract is authenticated acceptance with `signatureDigest` + same-scope evidence. SD-01…SD-15 in `CR-HM-BAST-SIGN-00_Unresolved_Decisions.md` remain *Proposed* (SD-11 *Pending* on Legal); per that file's governance correction, Proposed decisions must not enter runtime authority. | BAST-SIGN-00 docs; J09 reconciliation | Named Product/Security/Legal decision makers must approve/reject SD items. No code until then. | No |
| FG-07 | — | **CLOSED in this CR:** `openapi-contract` suite failed 1/7 on baseline (WhatsApp webhook probed under `/api/v1`; it is mounted outside the prefix, env-gated). | Baseline run 6/7 → fixed test probes the real enabled mount with test-only secrets; 7/7 after | — | — |
| FG-08 | — | **CLOSED in this CR:** master handoffs claimed `CANCELLED` did not exist; cited 1411 paths/457 migrations/head 0458; master-data endpoints (0456/0457) existed only in supplemental OpenAPI files. | Baseline `docs/api/HANDYMAN_BACKEND_API_HANDOFF*.md`; OpenAPI scan | Handoffs corrected; 17 supplemental paths (+25 schemas) merged into `docs/api/openapi.yaml` (1432 paths/1918 ops, refs resolve). | — |
| FG-09 | P2 | Focused-evidence freshness: suites for J02/J04–J08 were last run in prior waves (PR #49/#50 closure), not re-run in this CR (focused-runs-only instruction; the full guarded chain *was* re-run via `handyman-e2e-finance-close-api` 6/6 + capability-closure 4/6-domain suites). **Freeze-03 refresh:** requests, quotation decision, scope variations, Care workspace detail/projection, customer-care warranty, financial read and E2E financial-reconciliation-close suites re-run green on embedded PG; seven other focused suites are red on the *unmodified* baseline (→ FG-10). | Freeze candidate §2 table; freeze-03 changelog §3 | Re-run the per-journey suites on staging code freeze if the integration window is long. | No |
| FG-10 | P2 | **Baseline test debt (pre-existing; NOT a freeze-03 regression):** 24 tests over 7 suites fail byte-identically on pristine `main@38e779f` and on the freeze-03 branch — `handyman-bast-signoff-scope-guard` (2), `handyman-chargeable-additional-work-scope-guard` (2), `handyman-customer-transaction-scope-guard` (2): scope-guard *fixtures* approve quotations with a non-PIC actor and now hit `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN` (the shipped PIC-personal authority); `handyman-field-feed-authority` (14): TEMP-table fixture predates the feed's dispatch-release columns (`handyman_dispatch_releases` missing); `handyman-care-workspace-admission` (1) + `handyman-care-workspace-scope` (2): stale pinned path/route-family lists; `handyman-bm-fee-prerequisite-configuration` (1): stale pinned migration-file list. Runtime behavior is not implicated (the corresponding service/run-time suites pass), but these suites cannot serve as FG-04 staging evidence until repaired. | Clean-worktree A/B runs on `38e779f` vs freeze-03 branch (identical names+counts: 26 pass / 17 fail over the 3-suite set; 5/5 identical over the guard set) — freeze-03 changelog §3/§4 | Backend test maintenance (own CR): make the scope-guard fixtures decide as the PIC-linked user (never weaken the authority), extend the field-feed TEMP fixture to the current feed projection, and re-pin the two stale lists. Freeze-03's documentation-only scope deliberately excludes these fixes. | No (but repair before citing these suites for FG-04) |

## Cross-repo gap-closure audit amendment — 2026-10-21

Baseline is now merged #52 (`5994446`). The earlier statement “No P0 is open”
is historical to the candidate audit, not a claim that inaccessible consumer
reports or staging passed. See the [cross-repo audit and handoff](../e2e/CR-HM-BACKEND-CROSS-REPO-E2E-GAP-CLOSURE-01.md)
for the complete dependency matrix (each Frontend B1–B4 and Mobile BD-7–BD-12
is ENVIRONMENT BLOCKED pending exact report text; GitHub repository access was
denied), source evidence, J01–J12 scope and final test results.

| ID | Classification / severity | Evidence and disposition | Freeze effect |
|---|---|---|---|
| FG-11 | CONTRACT-ONLY GAP, P1 consumer discovery documentation; addressed in this branch, pending merge | P0 field defect discovery is **EXISTING**, not missing: GET scope defects/detail already authenticate and admit current PIC without `tenant_company.read` (`qcDefectReadAuthorityPreamble`). OpenAPI list prose incorrectly required Care permission. Corrected list prose + list/detail summaries; real-session HTTP test proves list/detail, no staff/QC permission, foreign-Building and superseded-assignment denials and no PIC self-QC. No runtime change. | Consumer verification still FG-03 |
| FG-12 | CONFIRMED DEFECT, P2 QC test fixture; addressed in this branch, pending merge | Pristine #52 `handyman-qc-supervisor-authority`: 23/23 fail `WORKFORCE_BUILDING_ALREADY_ASSIGNED` because `crewFixture` now creates the binding. Remove duplicate fixture assignment (not runtime authority); final 24/24 pass including new HTTP case. This is additional debt, **not** a claim to have repaired FG-10's seven suites. | No |
| FG-13 | POLICY DECISION REQUIRED, optional Care eligibility projection | Existing cancellation command locks request, rejects terminal/committed requests and records audit. Existing cancellation GET is a fact read, not eligibility. No confirmed consumer requirement/credential-lane contract justifies a speculative endpoint. Ask Frontend for exact projection need; no local Boolean may authorize cancellation. | Not a newly proven P0/P1 defect |

FG-03 and FG-04 remain OPEN / ENVIRONMENT BLOCKED. FG-05 remains a Product/Finance
policy decision: PR #47 rechecked OPEN, not imported, no colliding migration
revived. FG-06 remains a Legal/Security policy decision. FG-10 remains OPEN and
was not re-run. Care staff origin is already `CUSTOMER_CARE_BACKEND`; reinspection
schema/parser and optional Tenant PIC `userId` binding agree; permission metadata
passes freeze-03 guards. Do not reopen these as missing runtime capabilities
without path + persona + error evidence.

Final focused evidence: **55/55 + 46/46 PASS, zero skips/failures**, typecheck PASS,
parity/integrity/security guards PASS, disposable PostgreSQL only. No staging,
production, consumer app or full repository-suite PASS is claimed. Descriptive
OpenAPI erratum SHA-256:
`b5edd56f696b3f75ff5f2b5f17ac02366fbab36322908c580faf2f2fc9d10948`.
The earlier v1.2 hash is historical; authority/DTO/operation inventory unchanged.

## Rules

- A gap moves to CLOSED only with a merged PR + focused evidence, never by assertion.
- New gaps found by consumers are appended here with path + `error.code`, per the handoff support rule.
- FINAL FREEZE may be declared only when FG-03 and FG-04 are CLOSED (FG-01 and FG-02 closed 2026-10-21) and this register is re-issued referencing the staging E2E report.
