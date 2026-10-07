# CR-HM-06 PART 06 — Downstream Binding Readiness Contract (FROZEN)

**Status: FROZEN on 2026-09-28, base `df9e41d`.** Contract-shape-only
freeze under CR-HM-06 Decision Freeze F8–F12; complements (does NOT
alter) `CR-HM-04_PART04_ASSIGNMENT_BOUNDARY.md` and
`CR-HM-05_PART05_TARGET_BINDING_CONTRACT.md`, both of which remain
unchanged. Docs-only PART: runtime=0, migration=0, test=0, OpenAPI=0,
roadmap unchanged. Basis read: CR-HM-06 freeze F8–F12; PART 05
execution-scope public shape (runtime `df9e41d`); CR-HM-04 PART 04;
CR-HM-05 PART 05; frozen roadmap rows CR-HM-07/CR-HM-08.

## 1. Target authority

- Authoritative downstream target: **`HANDYMAN_EXECUTION_SCOPE`**
  (table `handyman_execution_scopes`, runtime PART 05).
- Target identity: **`executionScopeId`** (the scope row id).
- Creation authority: **CR-HM-06 successful quotation APPROVE only**
  (inside the PART 04/05 approval transaction). No other CR may
  synthesize, recreate, patch, or re-derive an execution scope; a
  "replacement scope" does not exist (§9 boundary).

## 2. Target eligibility

A downstream binding may reference a scope only when ALL hold:

1. the scope **exists** (exact `executionScopeId` row);
2. `scope.status = 'AUTHORIZED'` (the only CR-HM-06 state);
3. the binding belongs to the **same Client** (`client_id`);
4. the **approved quotation/version lineage is valid** (scope's
   `approved_quotation_version_id` points at an `APPROVED` version of
   its quotation whose `quotation_decision_id` is an `APPROVE` record);
5. the **authoritative request lineage is valid** (scope's
   `handyman_request_id`/`channel_attribution_id` chain is intact);
6. the downstream-specific **actor/RBAC** gate passes.

Eligibility is NEVER inferred from `operational_events` (audit-only
since CR-HM-05's freeze; states are authority, events are history).

## 3. CR-HM-04 crew assignment activation

The previously deferred CR-HM-04 assignment target is ACTIVATABLE as:

```
targetType = HANDYMAN_EXECUTION_SCOPE
targetId   = executionScopeId
```

CR-HM-04 remains sole authority for: provider-authored assignment,
crew, lead, assignment history (its PART 04 §3/§4 contract applies
verbatim with §2 eligibility). CR-HM-06 does NOT implement assignment.

## 4. CR-HM-05 scheduling activation

The previously deferred CR-HM-05 target-binding (its PART 05 §3 shape)
is ACTIVATABLE against `executionScopeId`. CR-HM-05 remains sole
authority for: scheduling readiness, the preferred-window model,
scheduled-window binding semantics, reschedule (append-only) history,
and building-authoritative timezone. CR-HM-06 does NOT create any
schedule binding. **Preferred window != scheduled execution window**
(provenance via `handymanSchedulingReadinessId` chain, per the frozen
PART 05 contract §5/§6).

## 5. CR-HM-07 arrival contract

CR-HM-07 (arrival & location verification) MUST use the execution
scope as the execution target and validate arrival **against the
authoritative expected context**: expected location originates from
the Execution Scope's immutable location snapshot
(building/floor/area/room/space) and its request lineage — never
from caller, QR, GPS, crew, provider, or FM data. CR-HM-07 exclusively
owns: QR/challenge, geofence/risk signals, expected-location
verification, and the verified-arrival result.
**Execution Scope existence alone != verified arrival.**

## 6. CR-HM-08 execution contract

CR-HM-08 (work session & field execution) uses `executionScopeId` as
the field-execution anchor. `Execution Scope AUTHORIZED` != CHECK-IN !=
START WORK != PAUSE != RESUME != MATERIAL RUN != COMPLETE !=
CHECK-OUT — those semantics are owned exclusively by CR-HM-08
(presence/work/billable-time separation per the frozen roadmap row).

## 7. Lineage

Downstream consumers MUST preserve full traceability and derive
context from it (never from caller-provided replacements):

```
executionScope
  → approved quotation version (APPROVED)
  → quotation decision (APPROVE)
  → quotation (immutable versioned thread)
  → Handyman service request
  → channel attribution / customer (tenant company, PIC) / location lineage
```

## 8. Immutability

The Execution Scope authority snapshot is **immutable** (0395 trigger;
no UPDATE/DELETE pathway exists). Downstream domains REFERENCE it;
they never rewrite: customer context, location snapshot, approved
quotation provenance, request/channel lineage. Immutable lineage =
the single source of expected context for every consumer.

## 9. Failure / reversal boundary

NO cancellation / revocation / reversal lifecycle is invented here.
The `AUTHORIZED` scope is never silently mutated. If future
requirements need approved-scope cancellation or revocation, that
requires an explicit authority/change CR (new bounded lifecycle state
machine), NOT a CR-HM-06 patch.

## 10. Firewalls

- Execution Scope != FM work_order (no FM WO reuse/mutation ever).
- Execution Scope != Work Session (CR-HM-08).
- Execution Scope != Crew Assignment (CR-HM-04).
- Execution Scope != Schedule (CR-HM-05).
- Execution Scope != Arrival Verification (CR-HM-07).
- Execution Scope != BAST (CR-HM-11).
- Execution Scope != Payment/Settlement (CR-HM-13).

## 11. Activation status

| Token | Value |
|---|---|
| EXECUTION_SCOPE_AUTHORITY | CR-HM-06 |
| EXECUTION_TARGET_TYPE | HANDYMAN_EXECUTION_SCOPE |
| CR_HM_04_ASSIGNMENT_TARGET | ACTIVATABLE |
| CR_HM_05_SCHEDULING_TARGET | ACTIVATABLE |
| CR_HM_07_ARRIVAL_TARGET | DEFINED_NOT_IMPLEMENTED |
| CR_HM_08_EXECUTION_TARGET | DEFINED_NOT_IMPLEMENTED |

**ACTIVATABLE != implemented.** CR-HM-04 and CR-HM-05 runtimes remain
untouched by this PART; their activation requires their own explicit
implementation PARTs against this contract.

## 12. HTTP handoff

PART 07A may expose the Execution Scope ONLY through the minimum
CR-HM-06 API required for: quotation/approval decision results, and
downstream target discovery (bounded exact reads of the scope).
PART 07A must NOT add crew/scheduling/arrival/work-session APIs
under CR-HM-06 (those belong to their owning CRs' API surfaces).

---

*This document freezes contract wording only. It changes neither the
CR-HM-04/CR-HM-05 frozen documents nor any runtime.*
