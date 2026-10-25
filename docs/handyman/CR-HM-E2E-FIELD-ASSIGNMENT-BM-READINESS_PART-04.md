# PART04 — Field assignment, BM permit and execution readiness

> **PART04 correction (2026-10-25):** the mandatory BM API premise below is superseded. BM permit/access procedures remain external; existing manually recorded readiness and execution guards are reused without requiring BM integration. See [requested schedule / existing Surat Tugas correction](CR-HM-PART04-CORRECTION-REQUESTED-SCHEDULE-SURAT-TUGAS.md). The remainder is the historical delivery report.

Date: 2026-10-25. Branch: `arena/3a9f4872-handyman-backend`. Baseline: `6532c4cbb8df8e4492f484c1b45b7e7d9bc3f97a`.

## Outcome

**DONE (bounded backend patch); BLOCKED (live independent BM integration).** Handyman remains an external provider. BM alone owns Building work-permit/access decisions; Operations retains inspector/technician/Lead/helper planning. No BM approval endpoint, approval producer, persona, assignment/permit module, migration or deployment was added.

- Reused approved quotation → AUTHORIZED execution scope → existing crew assignment. Unapproved quotations supply no assignable scope. Diagnosis/catalog work does not acquire a mandatory inspection step.
- Planning does not require BM approval. Existing dispatch readiness now distinguishes `UNASSIGNED`, `PLANNED`, and `DISPATCH_READY`; local permit/access flags alone cannot produce the latter.
- Existing local location/window checks remain mandatory and fail closed. A separate, read-only independent-BM verification boundary must additionally confirm complete applicable permit **and** access coverage; its production implementation intentionally returns `UNAVAILABLE`.
- Binding includes Client/Tenant, Building and exact unit/location chain, original approved quotation version, customer-approved ADD/REDUCE and revised quotation version/quantity/target, operational scope authorization, confirmed visit/window, assignment, provider, crew, latest Lead designation and complete active helper/Lead roster. Helpers may have no login. Prices, tax and payment amounts are not sent in this binding.
- Every new release/check-in/start/resume freshly verifies that binding. Old dispatch snapshots are historical evidence, never reusable clearance. Wrong coverage, pending/rejected/revoked/expired decisions, missing applicability, stale/malformed responses and unavailable verification deny with the existing `HANDYMAN_DISPATCH_NOT_READY` contract.
- Scope-changing variation approval/authorization share the execution-scope lock. Crew/roster/identity and location/readiness rows are locked through each decision; the executing actor is rechecked against the latest eligible Lead under the roster lock. Existing reassignment supersedes the previous release and cannot inherit its clearance. The release enum/OpenAPI now also reflect that already-existing `SUPERSEDED` state.
- Release JSON retains existing check keys and appends BM binding digest/reference/state. Current sessions/events/helper snapshots, actor/Building checks, safe pause and historical idempotent acknowledgments remain intact. Execution/QC/billing progress alone does not manufacture a different work-scope revision.
- Browser/PWA and Android use the same existing backend dispatch/session routes. No client approval flag, override, local authorization note, Care/slot/commercial consent or platform-specific bypass can activate BM clearance.
- PART03 money/tax/BM-fee/reconciliation code is unchanged. Upfront payment still does not replace Supervisor QC, canonical customer BAST or Manager FINAL CLOSE.

## Exact remaining BM dependency — NO-GO for live affected transitions

There is no established independent Handyman BM decision source in this repository. Vendor/FM Work Order readiness and the contractor permit foundation do not prove this Handyman scope/crew's BM authority and were not repurposed.

Required before wiring `handymanBmClearanceVerifier.verify`:
1. An agreed BM-owned source/transport and authenticated issuer/service identity, trust/enrollment and tenant/Building isolation contract; no credentials belong in chat or request bodies.
2. Authoritative applicability (required/exempt and required permit types), complete permit/access decisions, immutable decision references and identity/location/scope/visit/crew mappings.
3. Current revocation/supersession/expiry semantics, reliable freshness/clock behavior and bounded timeout/unavailability handling. The consumer accepts only a fresh verification (maximum 60 seconds old), exact binding and complete visit coverage; this is a consumer constraint, **not** an invented BM API or signature protocol.
4. Real independently authenticated positive, mismatch, expiry and revocation evidence. An adapter must verify source authenticity and coverage, not echo this binding digest or translate a local readiness flag into `APPROVED`.

Until then, live required **and unproven-exempt** transitions remain **BLOCKED**. Exemptions cannot be declared by Handyman or inferred from missing records. A proven exemption still needs an explicit applicability mapping at the existing guard; never synthesize a local permit to represent N/A. This patch does not implement an exemption-policy shortcut or an external BM transport.

## Focused verification

Seven explicitly named test files, nine suites: **115 PASS / 0 FAIL / 0 SKIP**, `262070.736971 ms`. Files: `handyman-dispatch-authority`, `handyman-work-session-commands`, `handyman-scope-variations`, `handyman-work-session-checkin-start-scope-guard`, `handyman-work-sessions-api`, `handyman-e2e-financial-reconciliation-part03`, `handyman-bast-customer-authority-part04` (all under `tests/`, `.test.ts`). Source typecheck: **PASS** (`28195 ms`, after the final import-only cleanup).

Coverage: unapproved denied; approved optional-inspection planning; default unavailable/local/body claims denied; positive exact BM **test double** → dispatch-ready; BM pending/rejected/revoked/expired; foreign Client/Tenant/Building/unit/scope/visit/assignment/crew; stale/malformed/incomplete coverage; superseded assignment/release; helper status/optional login and same-crew Lead replacement; check-in/start/resume freshness, rollback, replay and safe pause; approved ADD/REDUCE re-binding; API/Building/Lead authority; finance/QC/BAST regressions. Work-revision assertions combine real variation lifecycle reads with an explicitly synthetic surrounding binding; they are not full live BM E2E evidence.

All positive BM responses are explicit **test-only boundary doubles**, including older execution suites' setup. No mock is included in `src` or activated by an environment/request switch. Initial fixture/assertion and missing disposable-DB runner failures were corrected; the final run used disposable PostgreSQL. The bash wait limit ended before that run completed; the original runner continued, produced the complete zero-failure TAP summary, and shut down its disposable database. No duplicate run was started. Evidence: `/home/user/.cache/handyman-part04-focused-final.log` and `handyman-part04-typecheck-final.log` (local, untracked). No full suite, production database change, deployment or PR.

## Precise PART05 handoff — not started

Consume existing readiness/release/session routes and the additive readiness fields in PWA/APK; never compute approval on the client. Integrate only the authenticated independent BM reader after the four dependencies above are supplied; then prove real coverage/revocation/reassignment/ADD–REDUCE and mobile execution end to end. Preserve safe stop/replay, Lead/session evidence, material, Supervisor QC, canonical BAST and financial gates. The existing arrival lookup still recognizes scope-level historical VERIFIED evidence; current-actor/current-assignment arrival-proof hardening was not silently changed here and needs explicit PART05 validation. **STOP after PART04; no PR until FINAL REVIEW.**
