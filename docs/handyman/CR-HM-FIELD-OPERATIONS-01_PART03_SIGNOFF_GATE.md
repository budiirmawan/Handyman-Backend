# CR-HM-FIELD-OPERATIONS-01 — PART 03: SIGN-OFF GATE

- **Gate status: NOT SIGNED — implementation BLOCKED.**
- Baseline: `4eae70e`. Branch: `arena/a61abf59-handyman-backend`.
- This gate restrains exactly one thing: writing the G-2/G-3/G-4 runtime. Nothing
  in this document authorizes code, a route, a migration or an OpenAPI change.

---

## 1. What is being approved

| ID | Amendment | Exposure type | Frozen text affected |
| --- | --- | --- | --- |
| **G-2** | QR registry: register (201, value returned once), list (no secrets), deactivate (ACTIVE→INACTIVE) | 3 new operations | `GEOSPATIAL_AUTHORITY_DECISION §10` deferral lifted for the registry |
| **G-3** | Building geofence policy: `PUT` (create/replace, history preserved), `GET` active, `GET` history | 3 new operations | Same §10 deferral lifted for policy administration |
| **G-4** | Superseded-challenge refusal `409 HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED` on the existing terminal command | 0 new operations, 1 new refusal | `CR-HM-07_FINAL_CERTIFICATION §8` narrowed for the superseded-binding case only |

Net at implementation: Handyman surface `288 → 294`; migrations `+0`; permission
codes `+0` (Option A); PR #58 Notification Engine `0` changes.

## 2. Preconditions already satisfied

- [x] Frozen CR-HM-07 decisions reviewed and cited (§1 of the governance record).
- [x] Existing RBAC identified and reused; **no new role, no new persona** (§4).
- [x] No worker self-authorization anywhere in the design (§4.3).
- [x] Persistence already complete: 0398 and 0399 need no schema change (§3, §7).
- [x] History/audit requirement of frozen §10 already satisfied by
      retire-then-insert + `REPLACED`/`CREATED` journal + the history read.
- [x] Security test plan published, 0-skips policy stated (§5 / SECURITY_TESTS).
- [x] Blast radius enumerated (§6 of the governance record).

## 3. Decisions the CR Owner must make

| # | Decision | Options | Recommended default |
| --- | --- | --- | --- |
| **SG-1** | Approve the G-2 + G-3 exposure as specified | Approve / Approve with changes / Reject | **Approve** |
| **SG-2** | Permission vocabulary | **A:** reuse `building_configuration.read\|manage` (zero registry change) · **B:** new `handyman.arrival.configuration.read\|manage`, manage placed in `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` | **A** (mandate: existing RBAC). Choose B if geofence configuration must be a deliberate, never-inherited grant |
| **SG-3** | G-4 refusal code and status | **A:** `409 HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED` · **B:** reuse existing `HANDYMAN_ARRIVAL_CHALLENGE_INVALID` (non-enumerating) | **A** — the mobile client must distinguish “ask Ops to reissue” from “bad token” |
| **SG-4** | G-4 precedence vs TTL | **A:** superseded binding wins over expiry · **B:** expiry wins | **A** (binding death is the earlier, more actionable fact) |
| **SG-5** | G-4 certification amendment | Approve narrowing `CR-HM-07_FINAL_CERTIFICATION §8` | **Approve** (only the superseded case changes; every other verdict is byte-identical) |
| **SG-6** | Scheduling | Implement now / defer to PART 04 | Owner's call; nothing starts without SG-1 |

## 4. Explicit non-approvals (do not infer these from this gate)

Signing SG-1 does **not** authorize:

- any change to challenge/QR/geofence **decision** logic, the verdict vocabulary,
  the reason vocabulary or the 0397–0400 schema;
- granting any field persona configuration rights (permanently prohibited);
- `REVOKED`/`SUPERSEDED` challenge statuses, or changes to the one-live-PENDING
  or one-ACTIVE-per-Building index rules;
- Notifications Engine changes, Biznet/Coolify deployment, or a pull request;
- any admin or mobile **UI**;
- API.CO.ID geometry involvement (frozen: zero geometry authority).

## 5. Rejection path

If SG-1 is rejected or SG-2/SG-3 are unresolved:

- this PART remains a **closed design record** — no runtime is written;
- the three gaps stay open and are re-published in the FINAL REVIEW register
  with `VERIFIED-ARRIVAL-UNREACHABLE` as the standing production consequence
  (no QR identifier → `QR_UNKNOWN`; no policy → `NO_GEOSPATIAL_POLICY`);
- PART 02's certified behaviour, including `FAILED / ACTOR_ASSIGNMENT_INVALID`
  for superseded challenges, remains **exactly** as certified.

## 6. Sign-off record

| Role | Name | Decision | Date | Notes |
| --- | --- | --- | --- | --- |
| CR Owner (Handyman) | _pending_ | ☐ approve ☐ approve-with-changes ☐ reject | | |
| Backend Lead | _pending_ | ☐ agree ☐ disagree | | |
| Security Reviewer | _pending_ | ☐ agree ☐ disagree | | SG-2/SG-3 opinion: |
| Operations Representative | _pending_ | ☐ agree ☐ disagree | | who configures Building geofences in practice |

**Implementation may begin only with SG-1 approved and SG-2/SG-3 decided.**

---

## 7. Approval record template (append on signature)

```text
CR-HM-FIELD-OPERATIONS-01 PART 03
GATE=OPEN|APPROVED|REJECTED
SG-1=APPROVED|APPROVED_WITH_CHANGES|REJECTED
SG-2=OPTION_A|OPTION_B
SG-3=OPTION_A|OPTION_B
SG-4=OPTION_A|OPTION_B
SG-5=APPROVED|REJECTED
SIGNED_BY=<name>, <role>
SIGNED_AT=<ISO-8601>
CHANGES=<empty or list>
```
