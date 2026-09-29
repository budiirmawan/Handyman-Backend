# CR-HM-05 — DECISION FREEZE (CONTAINMENT)

**Status: FROZEN on 2026-09-27, base `b4928cd`.**
This document records the governance decision resolving the
BLOCKED_FOR_DECISION state of `CR-HM-05_START_GOVERNANCE.md`. It is
binding for all CR-HM-05 implementation PARTs. It does NOT change the
frozen roadmap — it applies the roadmap's own documented containment
(*"CR-HM-05 delivers scheduling rules/lifecycle and permit readiness;
the authorized-scope scheduling binding closes when CR-HM-06 lands"*)
as the implementation shape, mirroring CR-HM-04 PART 04.

**BLOCKED_FOR_DECISION → RESOLVED: DECISION=CONTAINMENT.**

| Token | Value |
|---|---|
| DECISION | CONTAINMENT |
| ROADMAP_RESEQUENCE | NO |
| TARGET_CREATION | CR-HM-06 |
| TARGET_BOUND_SCHEDULING | DEFERRED |
| CREW_ASSIGNMENT_BINDING | DEFERRED |
| FM_WORKFLOW_REUSE | NO |

---

**F1 — ROADMAP ORDER.** The frozen roadmap order stands unchanged:
**CR-HM-05 → CR-HM-06 → CR-HM-07**. No resequence. CR-HM-05 uses
CONTAINMENT: Handyman scheduling/access-readiness semantics are
defined now, while execution-target binding is deferred until CR-HM-06
creates the authoritative execution scope.

**F2 — SCHEDULING OWNERSHIP.** CR-HM-05 OWNS: scheduling
policy/semantics; schedule readiness; the time-window model; timezone
derivation rules (from location authority, never free input);
reschedule semantics/history; the scheduling validation contract.
CR-HM-05 does NOT invent a job, work order, execution scope, or
assignment target of any kind. Target-bound schedule runtime remains
DEFERRED.

**F3 — CR-HM-06 INTERLOCK.** CR-HM-06 owns creating the authoritative
execution scope after Customer Quotation Approval. Once that scope
exists it becomes the legitimate target for BOTH the CR-HM-04 deferred
crew-assignment binding AND the CR-HM-05 deferred target-bound
scheduling. CR-HM-06 must NOT redefine CR-HM-04 crew authority or
CR-HM-05 scheduling semantics.

**F4 — PERMIT.** The existing FM Permit-to-Work engine (BE-20) is
pattern/infrastructure only. CR-HM-05 owns a NEW bounded
permit/readiness model for tenant/unit service access. It must NOT
absorb the FM Permit-to-Work lifecycle or FM maintenance workflow.

**F5 — UNIT ACCESS.** Existing building/floor/area/room (unit) /space
masters remain the location authority — never duplicated. The CR-HM-01
attribution and the CR-HM-02 request snapshot remain the Handyman
context anchors. CR-HM-05 owns access authorization / readiness /
window semantics over those authorities.

**F6 — ARRIVAL FIREWALL.** CR-HM-05 access readiness is NOT proof of
arrival. CR-HM-07 exclusively owns: verified arrival; QR/challenge
proof; expected-location verification; geofence/risk signals; and the
location-verification outcome.

**F7 — ACTOR / AUTHORITY.** Scheduling/access/permit-readiness
mutations require an authenticated local user plus the existing
client/RBAC scope. Authority is NEVER derived from: BM handoff alone;
tenantPic; worker identity; QR; or caller-supplied client/building
context (all scope is server-derived from referenced authority rows).

**F8 — HISTORY.** Schedule/reschedule and permit/access-readiness
material changes must preserve append-only operational history when
the runtime exists. History is not lifecycle authority.

**F9 — PART BOUNDARY.** CR-HM-05 implementation may build ONLY runtime
that does not require the missing CR-HM-06 execution target. Any
operation requiring `targetId` / `executionScopeId` MUST remain
deferred. NO placeholder target IDs and NO nullable fake bindings are
created.

**F10 — FM FIREWALL.** Scheduling ≠ attendance ≠ work session. Permit
≠ FM Permit-to-Work workflow. Unit access ≠ FM work order. Access
readiness ≠ arrival verification. No quotation implementation, no
assignment implementation, no CR-HM-06 implementation inside
CR-HM-05.

---

## Recommended implementation PARTs (frozen sequence)

| PART | Scope | Runtime? |
|---|---|---|
| 01 | Scheduling Policy & Readiness Foundation (F2/F7/F8) | yes (target-free) |
| 02 | Handyman Unit Access Readiness (F5/F7/F8) | yes (target-free) |
| 03 | Handyman Permit Readiness (F4/F7/F8) | yes (target-free) |
| 04 | Reschedule / Readiness History Semantics (F8) | yes (target-free) |
| 05 | Deferred Target-Binding Contract (F2/F3/F9) | **docs/contract-only** |
| 06A | HTTP + OpenAPI for implemented readiness surfaces ONLY (F7) | yes |
| 06B | Final Validation / Certification | certification |

**PART 05 stays documentation/contract-only** unless CR-HM-06 target
authority already exists — which it MUST NOT during the current roadmap
sequence. After CR-HM-06 lands, the deferred binding is activated
through the owning integration step WITHOUT changing CR-HM-05 semantic
authority (and symmetric to CR-HM-04 PART 04's assignment-binding
activation).

## Invariants carried from START GOVERNANCE

- B1 (missing execution target) is enforced by F2/F9 as a permanent
  guard, not a blocker, under CONTAINMENT.
- B2 interlock: CR-HM-04 crew-assignment binding and CR-HM-05
  target-bound scheduling share the SAME CR-HM-06 target; both defer
  consistently (F3).
- No Handyman job/work-order/execution-scope/assignment-target entity
  may appear in any CR-HM-05 PART.

---

*Decisions F1–F10 frozen 2026-09-27. This freeze resolves the START
GOVERNANCE gate; PART 01 has NOT been started.*
