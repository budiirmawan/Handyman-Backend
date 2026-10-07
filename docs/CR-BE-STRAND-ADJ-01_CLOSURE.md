# STRAND-ADJ-01 — Stranded Branch Adjudication Closure

- **Status:** CLOSED
- **Closure date:** 2026-09-14
- **Scope:** Adjudication of one stranded backend branch and disposition of its 78 unmerged commits
- **Authoritative backend head at closure:** `9b49583ab338242a5a61fe41dcd519719f280361`
- **Preceding authoritative head:** `a8d4ee78e4c07f7bd7d5fbd803473983ee09fa49` (R13 closure)

This record documents decisions already proven by the STRAND-ADJ-01 adjudication
parts. It does not re-open adjudication, re-partition commits, or modify production
code, tests, migrations, database schema, or API/OpenAPI contracts.

---

## 1. Source branch status

| Item | Value |
|---|---|
| Stranded branch | `arena/01a09098-asentra-backend` |
| Stranded tip | `521708448d0bf8e008d6b2b425919856a0ebaa65` (`feat(parking): expose subscription read api`, 2026-09-13) |
| Divergence | Branched from `2ff5360dd9df0479ff548a1b9e72c8281490daa4`; 78 commits unique to it, 90 on the authoritative line, zero rebase/merge-back |
| Pull request | Never opened against any base (verified `state=all`) |
| Governance coverage | No governance doc on authoritative main; its cited stream labels `B19-*` and `CR-BE-REC-01` appear in none of main's docs, source, or tests |

Confirmed:

- the branch was **never authoritative main**;
- the branch was **never integrated wholesale**;
- **no merge and no cherry-pick** of any stranded commit was performed;
- the branch **must not be treated as a release or reference baseline**.

No intent, motivation, or authorship narrative is recorded here beyond the facts above.

---

## 2. Commit partition

| Partition | Count |
|---|---:|
| Total stranded commits | **78** |
| Parking | **23** |
| Non-Parking | **55** |

The earlier approximate 35 / 43 estimate was **superseded** by per-commit file
evidence: 18 commits titled `feat(parking)` were verified to touch only Parking plus
registration glue, so subject-based counting over-attributed Parking. The partition was
established from changed-file lists, not commit messages, and all 78 commits were
accounted for with zero unclassified. This record does not recompute it.

---

## 3. Parking disposition

**Parking subsystem = OUT OF CURRENT BACKEND FREEZE.**

Basis, taken from authoritative main rather than from the stranded branch:

- the authoritative capability inventory classifies Parking as `NOT_FOUND` /
  `DEFER_BACKEND_GAP`, and states it "should not be planned as available backend
  capability without new work";
- current authoritative main contains no adopted Parking subsystem (0 parking files);
- Parking therefore requires explicit future scope / change request before any
  implementation.

No Parking change request is created by this closure. Parking implementation quality was
deliberately **not** inspected; only its scope boundary was adjudicated.

---

## 4. Non-Parking disposition

| Concern | Final disposition |
|---|---|
| Work Order completion / execution authority | **ALREADY EQUIVALENT IN MAIN** — main enforces the same completion gate (existence → non-terminal → active assignment → authorized actor → required-evidence fail-closed, transactionally). Added snapshot / completion-attempt / rework-cycle subsystems excluded as non-blocking. |
| Vendor Work actor / affiliation authority | **NON-BLOCKING / OUT OF CURRENT FREEZE** — vendor-as-actor self-service authority is not an established current-main primitive; main's vendor surfaces are RBAC-permission-gated admin surfaces. |
| Generated Task execution authority | **NON-BLOCKING HARDENING** — executor identity and Client scope already exist in main; additional ACTIVE-profile ordering is defensive. |
| Mobile Sync `TASK_EXECUTION` conflict scope | **CURRENT-FREEZE DEFECT → REIMPLEMENTED AND CLOSED ON MAIN** — `ebdd7cd711d043c1c40f7648e5da88062d83ade9` |
| Patrol executor identity | **ALREADY EQUIVALENT IN MAIN** — building access plus workforce-executor checks already enforced; row-lock serialization and idempotent no-op start remain non-blocking. |
| Cleaning assignment Building placement | **CURRENT-FREEZE DEFECT → REIMPLEMENTED AND CLOSED ON MAIN** — `9b49583ab338242a5a61fe41dcd519719f280361` |
| Cleaning assignment transactional wrapper | **NON-BLOCKING HARDENING** — main's own comparable assignment path is non-transactional, so this is a repo-wide improvement, not a local violation. Explicitly not bundled into FIX-02. |
| Receiving demand-line mandatory requirement | **NON-BLOCKING PRODUCT-POLICY TIGHTENING** — current main deliberately preserves optional Material Request binding while enforcing identity and scope when supplied; making the line mandatory changes policy, it does not repair a contract violation. |

Both defect classifications were established against authoritative-main evidence, not
against the presence of `fix:` commits or an unused error factory:

- FIX-01 was proven exploitable — on the unfixed code an out-of-scope actor received a
  resolved payload rather than a refusal;
- FIX-02 was proven exploitable — on the unfixed code main created an ACTIVE assignment
  for a workforce profile holding no placement at the task's Building.

---

## 5. Fix principle

Both required defects were **reimplemented against authoritative main**.

- No stranded commit was cherry-picked.
- No stranded migration was adopted.
- No stranded helper or file was reproduced. The stranded patch's `worksAtBuilding`
  helper and its `task-assignment.repository.ts` file exist only on that branch and were
  deliberately not carried over.

Each fix reuses an existing current-main shared authority:

| Fix | Shared authority reused |
|---|---|
| FIX-01 mobile-sync conflict scope | the existing scoped task-assignment / BE-02G Building-access loader |
| FIX-02 cleaning workforce placement | the existing BE-03G `workforce_building_assignments` placement authority, with the Team exemption preserved |

---

## 6. Migration collision disposition

The stranded branch carries migrations `0341`–`0349`. Its `0341`–`0347` numbering
**collides with different authoritative-main migrations** (main's `0341`–`0347` hold the
Reporting R05/R06 checklist and form DDL; the stranded numbers hold unrelated DDL).

Therefore:

- stranded `0341`–`0347` are **obsolete for authoritative integration**;
- they must **never be copied or replayed under those numbers**;
- **no stranded migration was integrated**;
- FIX-01 and FIX-02 required **no schema change**;
- the authoritative main migration chain is **unchanged by STRAND-ADJ-01**
  (contiguous through `0347` at closure, no duplicates, no gaps).

For future schema work, allocate from **the next free migration number on authoritative
main at that future point**. Do not hardcode `0348` or any later number as permanently
available: main advances, and a reserved-looking number may already be taken by then.

---

## 7. Final closure state

| Field | Value |
|---|---|
| STRAND-ADJ-01 FINAL STATUS | **CLOSED** |
| Current-freeze defects found | **2** |
| Current-freeze defects closed | **2** |
| Implementation blockers remaining | **0** |
| Authoritative backend head at closure | `9b49583ab338242a5a61fe41dcd519719f280361` |
| Stranded branch final disposition | **NON-AUTHORITATIVE / DO NOT MERGE** |
| Ready to re-run FINAL BACKEND PART 00 | **YES** |

Out-of-freeze items recorded for completeness, not as blockers: CI change requests
`PR #76` (CR-BE-CI-PERF-01) and `PR #72` (CI stabilization), which remain open and
diverged; `KI-003` legacy test assertion alignment debt; residual `CR-BE-COM-02`
LOW/P3 gaps; `CR-BE-MOB-03` ISO-03 deferrals. None is promoted by this closure, and none
reopens a closed wave.

---

## Environment note

The checkout's local `main` ref may remain stale in some Arena sessions because those
sessions are pinned to their own branch. Authoritative judgements in this adjudication
used **remote main / `origin/main`** throughout. This is an environment observation, not
a backend product blocker, and no local-ref housekeeping is part of this closure.
