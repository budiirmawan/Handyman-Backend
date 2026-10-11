# W03 PART 03F — Execution Scope Gate & Controlled Cutover

**Date:** 2026-10-11
**Authority:** CR-HM-06 Decision Freeze F6 revised v1.1, F2/F3/F7–F10; A01 A4/A8/A9, E1–E5, C11, R6/R7 and §13 (03F); Addendum A B7/B16–B20, R-1, M4–M6 and C24. Read together with the committed W03 03B, 03B2, 03C, 03D and 03E records, including 03E recovery §14.
**Boundary:** prospective execution authorization gate and focused regression only. **B12 OFF. No deployment, PR, OpenAPI 03G, certification 03H, permission/role expansion, automatic binding or approval fallback.**

## 1. Baseline and preservation

Work stays on `arena/e9915f51-handyman-backend`. Expected baseline and remote were verified as `4c82dbb601d2a6567aaa814c3abea527c2c866c0`, with a clean tree and 0 ahead / 0 behind before 03F edits.

The restored sandbox initially carried old Git metadata (`9602991`) over the already-delivered files. An ignored alternate index proved the entire working tree, including untracked source, exactly matched the remote baseline tree `9149f77384c682db1331a06fff9d309a76fda3a3`. Fetch/unshallow and a content-preserving fast-forward restored that metadata. No reset, stash, discarded file, branch switch or extra recovery commit. The prior recovery evidence remains in the 03E record; its 134 passes are not counted as a new 03F run.

## 2. What changed

### Database floor — migration 0443

`0443_handyman_execution_scope_approval_gate` closes the INSERT deferral explicitly left by 0439/0442:

- The exact `quotation_decision_id` must resolve to a **TENANT_PIC APPROVE**, not merely a row with a valid foreign key. Scope creator PIC and session must equal that decision's PIC and original session; staff-user attribution must be NULL.
- Decision, quotation version, quotation, request, attribution, client, tenant, original nullable lineage PIC, binding and credential representation must agree. A building-wide credential remains valid for its building's request Space; it does not erase that Space's occupancy requirement.
- The version must be `APPROVED`, with approval inside its validity window. New scope creation also rechecks the actual clock, binding window, credential liveness, active PIC/tenant/client/attester, maker-checker, current building and Space occupancy, and the complete location/client chain.
- E1's **same transaction** is checked using the newly inserted decision's `xmin` against the current top-level transaction ID. The existing engine uses one top-level transaction. This is an INSERT-time witness, not a stored business identifier and **not** a historical replay/ongoing execution predicate. A committed orphan cannot be repaired by replay or delayed INSERT; writers must reuse the approval engine, not stage/transfer approval rows between transactions or independent savepoints.
- The service preflight and the independent BEFORE INSERT trigger share the eligibility predicate. The trigger re-locks version → binding, already held by the legitimate engine, before evaluating it. It introduces no new actor/session lock.
- The existing 0395 UPDATE/DELETE immutability trigger, AUTHORIZED-only vocabulary, version uniqueness and all original FKs remain intact. No scope transition, placeholder, binding column, new UNIQUE/NOT NULL constraint or UPDATE backfill is introduced.
- A narrow quotation projection guard protects the prerequisite lifecycle fact: new versions start DRAFT; first APPROVED/REJECTED projection requires this transaction's matching PIC decision from ISSUED; terminal versions cannot be reopened or re-timed. Existing 0391 identity/line guards stay in place. This does **not** enable B12 or alter issue/revision service behavior.

**Controlled installation:** migration `up()` locks quotation versions → scopes in EXCLUSIVE table mode before the existing-PIC provenance scan and trigger installation. This closes the scan/install race while allowing plain historical reads; an in-flight approval finishes before inspection. Invalid existing PIC scope provenance aborts the migration atomically. No historical row is repaired, silently approved or reclassified. `down()` uses the same order and refuses once PIC decisions/scopes exist: forward-fix only. Run migration work under an approved maintenance/quiescence plan, not as a live rollout experiment.

### Service and replay

- `buildExecutionScopeInput(tx, ...)` refuses USER creation and independently checks the stored decision/context before INSERT. Location derivation is one coherent query on the approval connection, not four separate pool reads.
- The decision engine reuses `assertPicWorkspaceSessionCurrent` after version/binding waits, on its already-held authority/session locks, before the ledger write. The existing seam still revalidates after all writes. Its SQL/lock protocol is unchanged; the assertion only needs the authenticated principal's session ID.
- The sequence remains `insertDecision → updateVersionLifecycle → insertScope → journals`, in the credential seam's one transaction. A service or DB-floor refusal rolls all of it back. PIC scope conflicts are mapped onto the existing non-enumerating decision-conflict envelope; no new error code.
- An APPROVE replay requires the **existing** scope with exact decision provenance. REJECT replay requires no scope. Missing/mismatched scope means controlled 409, never repair, second approval, duplicate scope or duplicate journal.
- Historical replay checks stored provenance, not today's offer/binding/credential expiry or mutable location hierarchy. A valid completed approval is not an execution lease. New credentials for the same PIC/tenant may retrieve their original decision, including its original session attribution.
- Staff APPROVE/REJECT remains S1 **403 `PERMISSION_DENIED`**, before DB work; the historical staff GET remains open under its existing authorization. No new operational writer or public endpoint.

## 3. Legacy policy is explicit, not a fallback

A01 A4/E1 is a **prospective creation gate**. A01 A8/A9 expressly preserve USER decisions **and the scopes they already created**, including live work. C11/C24 require downstream consumers to keep consuming the scope, not re-decide customer consent.

Consequently:

| Existing fact | 03F treatment |
|---|---|
| USER APPROVE with an already-created scope | Immutable history/read compatibility retained. No conversion to PIC, no new scope or consent. Downstream runtime unchanged under A9. |
| USER APPROVE without a scope | New scope INSERT refused, including actor relabelling attempts. Staff decision route cannot be used as recovery. Audited owner disposition required. |
| PIC APPROVE with valid scope | Provenance checked on replay; expired/revoked original credential does not retroactively revoke a completed fact. Current caller must still authenticate. |
| PIC APPROVE without scope | Replay and late INSERT refused. Report an orphan; never backfill authority. |
| Existing PIC scope with broken immutable provenance | 0443 installation refused. Preserve evidence and obtain an authorized resolution; do not disable the guard. |
| REJECT / absent / wrong-thread / stale authority | Cannot create a new scope. |

**Important limit:** a requirement to quarantine *all future operational activity on historical USER-created scopes* is not authorized by A9/C11/C24. No retroactive filter, revocation state or hidden deny/allow policy was invented. That stronger legacy cutover needs an explicit owner amendment and population/operational impact review. This record does not claim that existing USER scopes have been invalidated or that all legacy execution has been switched to PIC consent.

## 4. Downstream compatibility and fixture reconciliation

No runtime in the 0396–0422 consumer modules changed. In particular, assignments still consume an AUTHORIZED scope and enforce their own building, provider, crew and Lead rules; approval does not assign a crew, create FM work, verify arrival, start a work session or confer financial authority.

Focused consumer fixtures now use an explicit staff binding, actual signed PIC admission and the production PIC decision service. They do not plant scopes, restore staff approval, disable a production guard, grant a role or fabricate a user for a PIC.

Other bounded test corrections made necessary or exposed by that cutover:

- 03B migration tests peel/reapply 0443 in the correct order. Positive scope rows carry full location/original lineage and follow decision → projection → scope. Their clock follows admission, not transaction-start NOW(). The isolated old CHECK-only case uses the real empty migration down inside ROLLBACK; live-gate positives and 03F bypass tests do not.
- S1 state tests use different version rows, rather than mutate one terminal row through multiple states.
- Lifecycle terminal fixtures obtain real PIC APPROVE/REJECT; EXPIRED uses the actual expiry service. No raw approved-state fabrication.
- Assignment side-effect assertions compare the full forbidden-event set before/after assignment: legitimate PIC **admission** has already emitted a session audit. Assignment may not emit any new QR/arrival/session/FM event.
- The arrival module's exact export census now includes the two bounded read exports already present at baseline `4c82dbb`; the exact allowlist and no-payload/no-FM checks remain. No arrival export/runtime was added in 03F.

This is selected regression evidence, not the exhaustive 0396–0422 certification/mutation program reserved for 03H. Other older staff-approval fixture families are not silently certified by this change.

## 5. Validation evidence

### Fast recovery — final minimal verification

The owner stopped the long session and limited recovery to preserving the existing patch, minimal validation and same-branch commit/push. Preflight again confirmed branch/HEAD/remote at `4c82dbb`, all local changes retained, and no previous test processes still running.

The recovered log identified one 03F failure: a scope **service preflight** refusal escaped the existing PIC conflict-envelope mapping, although the DB INSERT refusal was already mapped. **One small recovery fix:** the `recordPicQuotationDecision` boundary applies the existing `asDecisionRefusal` mapping to the engine's rejected promise. It rethrows; no authorization check, rollback behavior or security assertion is removed or relaxed. The focused 03F suite was rerun once after this fix, followed by 03E because that boundary is shared.

| Recovery check | Actual result |
|---|---|
| `npm run typecheck` — production program only | **PASS**, exit 0, about 32 seconds |
| `handyman-execution-scope-approval-gate.test.ts` | **43 PASS / 0 FAIL / 0 SKIP**, exit 0, about 27 seconds; real embedded PostgreSQL 18.4, including migration/history, direct-SQL negative matrix, service/DB rollback, replay and concurrent authorization cases |
| `handyman-pic-portal-decide.test.ts` — focused 03E regression | **30 PASS / 0 FAIL / 0 SKIP**, exit 0, about 33 seconds; includes 23 DB/HTTP cases and 7 structural checks |
| `git diff --check` / staged diff whitespace check | **PASS** before commit |
| Fresh recovery total | **73 PASS / 0 FAIL / 0 SKIP**, not a full-suite claim |

Each test used an explicit single-file list with `node --import tsx --test --test-concurrency=1`; `ASENTRA_USE_EMBEDDED_POSTGRES=true`, `NODE_ENV=test` and `LOG_LEVEL=error` were passed in the Node child environment. Each recovery verification command was capped by `timeout --signal=TERM --kill-after=5s 110s`, within a 120-second tool call. No timeout was reached. No full suite or test-only typecheck was run during fast recovery.

Ignored local evidence: `.data/w03-03f/fast-recovery-typecheck.log`, `fast-recovery-03f.log`, and `fast-recovery-03e.log`. Database shutdown is present in both test logs. These scratch logs/databases are not committed; this record preserves the results.

### Recovered earlier evidence and outstanding verification debt

These are **previous-session logs**, not additional fast-recovery runs or proof that every suite is green:

- `consumers-legacy-final.log`: six explicitly selected suites completed with **60 PASS / 0 FAIL / 0 SKIP**, including assignment service, arrival result persistence, work-session persistence, quotation lifecycle, S1 staff decision and quotations API. The harness recorded status 0. They were not rerun in fast recovery.
- `w03-final.log`: the earlier six-suite W03 run recorded **145 PASS / 2 FAIL / 0 SKIP**. One failure was the 03F envelope issue fixed and revalidated above. The other remains **03B verification debt**: `authorises a PIC decision only through a live, coherent binding` received `A PIC decision must name the PIC its approval binding confers.` instead of the expected guard-message assertion. Its cause is not certified by this recovery; do not describe that suite or the combined run as PASS. No assertion was weakened or that suite rerun here.
- The earlier `npm run typecheck:tests` on the expanded explicit test-file list had **five test-only errors**: the legacy decision/lifecycle fixture helpers' `service` property typings, plus a lifecycle assertion testing a `void` expression for truthiness. Production typecheck passes. These errors were **not repaired or rerun** during fast recovery and remain verification debt; no whole-repository typing claim.

The runtime guard/replay implementation and existing valid fixture work were retained rather than reset, hidden by a config rollback, or replaced with staff approval. Full verification/cutover remains blocked until the outstanding debt and §7 owner/data blockers are resolved.

## 6. Aggregate-only cutover review (not a population claim)

Staging/production populations are **UNVERIFIED**. The following post-0443 read-only checks are for an authorized DBA/Operations review. They grant nothing and produce counts only. A failed migration provenance scan is a blocker, not permission to remove its predicate so these queries can run.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT count(*) FILTER (WHERE created_by_actor_type = 'USER') AS historical_user_scopes,
       count(*) FILTER (WHERE created_by_actor_type = 'TENANT_PIC') AS pic_scopes,
       count(*) FILTER (
         WHERE created_by_actor_type = 'TENANT_PIC'
           AND NOT handyman_execution_scope_approval_valid(handyman_execution_scopes, false)
       ) AS invalid_pic_scope_provenance
FROM handyman_execution_scopes;

SELECT d.decision_actor_type, count(*) AS approve_without_scope
FROM handyman_quotation_decisions d
WHERE d.decision = 'APPROVE'
  AND NOT EXISTS (
    SELECT 1 FROM handyman_execution_scopes s WHERE s.quotation_decision_id = d.id
  )
GROUP BY d.decision_actor_type;

SELECT count(*) AS issued_without_effective_binding
FROM handyman_quotation_versions v
WHERE v.status = 'ISSUED' AND NOT EXISTS (
  SELECT 1 FROM handyman_quotation_approval_bindings b
  WHERE b.quotation_id = v.quotation_id AND b.status = 'ACTIVE'
    AND b.effective_from <= current_timestamp
    AND (b.effective_until IS NULL OR b.effective_until > current_timestamp)
);

COMMIT;
```

The last count is presentation/binding debt while **B12 is OFF**, not a complete B16 eligibility test. Do not infer occupancy, consent or production readiness from it. Follow the already-approved BLK-3 measurement path for maker-checker/PIC-link/backfill/idempotency populations; no identity/contact exports.

## 7. Remaining blockers and release order

| Item | Disposition / owner |
|---|---|
| **BLK-3 — staging population and compatibility measurement** | Still unverified. DBA + Operations must measure through the approved aggregate-only path, including legacy/orphan/invalid PIC scope populations and target PostgreSQL compatibility. Embedded PostgreSQL is not staging. |
| **BLK-7 — globally UNIQUE idempotency key** | **Still blocks full 03F cutover/closure under A01 §12.** Existing cross-tenant conflict oracle remains. R6/M6 require its own measured migration after BLK-3; no constraint change or waiver is smuggled into 0443. Architecture + DBA. |
| **Legacy execution disposition** | A9 preservation is implemented, not a new staff fallback. Stronger quarantine/retroactive invalidation of USER-created live scopes lacks frozen authority; Product/Architecture/Operations must ratify any change. USER/PIC approval orphans are never auto-repaired. |
| **Invalid pre-gate PIC provenance** | Migration blocks if present. No production population claim and no destructive repair. Owner/DBA disposition required before proceeding. |
| **BLK-BIND-BACKFILL / B12 enablement order / BLK-GAP-1 rollout** | B12 stays **OFF**. Existing/new unbound threads remain unable to decide until an authorized staff binding exists. Backfill policy and rollout sequencing remain Product + Operations + release manager decisions. No default/derived binding. |
| **BLK-ISSUER / A01 BLK-6** | No `issued_by_user_id` added. Maker set stays root author ∪ version author ∪ binding granter. Architecture/CR-HM-06 owner sign-off remains outstanding. |
| **03G / 03H / broader regression debt** | OpenAPI and certification untouched; no W03 E2E or all-consumer certification claim. Remaining old fixture families and mutation verification belong to their approved later scope. |
| **BLK-10 / external sign-offs** | Staff route Sunset/removal, BM/FE integration, TTL/UX and rollout acceptance are not invented by 03F. S1 remains mounted with its existing refusal/deprecation behavior. |

**Order before any release:** resolve the human/data blockers → verify an authorized snapshot and database version → quiesce writers/approve maintenance → apply 0443 and require its preflight to pass → install the matching service code → verify focused acceptance with B12 still OFF. Do not roll the new service out without 0443's predicate, and do not remove the DB floor to run old writers. Once PIC facts exist, fix forward. **No part of that deployment was executed in this task.**

## 8. Integrity statement

This PART delivers a prospective gate and evidence, not ratification of missing policy or authorization to launch. Historical ledgers are untouched, original status/error vocabularies remain, PIC liveness and R7 are preserved, and operational/financial consumers are not re-authorized by staff. Full controlled cutover remains blocked by the items above. Stop after the focused validation, same-branch commit/push and clean local/remote verification; do not continue into 03G/03H.
