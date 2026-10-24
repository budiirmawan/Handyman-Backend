# CR-HM-FIELD-OPERATIONS-01 — PART 03: SIGN-OFF GATE

- **Gate status: SIGNED — APPROVED BY CR OWNER on 2026-10-24 (Asia/Jakarta).**
- Baseline: `4eae70e`. Branch: `arena/a61abf59-handyman-backend`.
- **Approval record:** §8 below. **Governance record:** this file (gate + record)
  together with `CR-HM-FIELD-OPERATIONS-01_PART03_GOVERNANCE_AMENDMENT.md`
  (design + frozen-decision review), `…_PART03_PROPOSED_API_CONTRACT.yaml`
  (contract proposal) and `…_PART03_SECURITY_TESTS.md` (test plan).
- This gate restrains exactly one thing: writing the G-2/G-3/G-4 runtime. Nothing
  in this document authorizes code, a route, a migration or an OpenAPI change by
  itself — approval OPENS the gate, and implementation happens **only in PART 04**.
- **Implementation status at this record: NOT STARTED.** Recording the approval
  changed documentation only (no runtime, no route, no migration, no OpenAPI,
  no test); PART 01 (`186628c`) and PART 02 (`4eae70e`) are untouched.

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

## 3. Decisions put to the CR Owner (all decided)

**All six decisions were APPROVED by the CR Owner on 2026-10-24 — see §8 for the
signed record and §9 for the binding implementation conditions that follow.**

| # | Decision | Options | Outcome |
| --- | --- | --- | --- |
| **SG-1** | Approve the G-2 + G-3 exposure as specified | Approve / Approve with changes / Reject | **Approved** |
| **SG-2** | Permission vocabulary | **A:** reuse `building_configuration.read\|manage` (zero registry change) · **B:** new `handyman.arrival.configuration.read\|manage`, manage placed in `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` | **Approved — OPTION A** |
| **SG-3** | G-4 refusal code and status | **A:** `409 HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED` · **B:** reuse existing `HANDYMAN_ARRIVAL_CHALLENGE_INVALID` (non-enumerating) | **Approved — OPTION A** |
| **SG-4** | G-4 precedence vs TTL | **A:** superseded binding wins over expiry · **B:** expiry wins | **Approved — OPTION A** |
| **SG-5** | G-4 certification amendment | Approve narrowing `CR-HM-07_FINAL_CERTIFICATION §8` | **Approved** (controlled amendment only) |
| **SG-6** | Scheduling | Implement now / defer to PART 04 | **Approved — proceed in PART 04** |

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

## 5. Rejection path (NOT TAKEN — recorded for audit)

**Not applicable: SG-1 was approved and SG-2/SG-3 were decided.** The path is
retained so a future reader can see what rejection would have meant.

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
| CR Owner (Handyman) | CR Owner (approval conveyed in-session) | ☑ approve ☐ approve-with-changes ☐ reject | 2026-10-24 | SG-1…SG-6 all approved; see §8 |
| Backend Lead | _not recorded_ | ☐ agree ☐ disagree | | Advisory — not required to open the gate |
| Security Reviewer | _not recorded_ | ☐ agree ☐ disagree | | Advisory — SG-2/SG-3 opinion may be appended later without blocking |
| Operations Representative | _not recorded_ | ☐ agree ☐ disagree | | Advisory — who configures Building geofences in practice |

**Gate rule satisfied:** SG-1 approved and SG-2/SG-3 decided → implementation is
authorised for **PART 04**. The three advisory roles are recorded as *not
recorded* rather than as agreement: no signature is claimed on their behalf, and
their later input does not retroactively change this approval.

---

## 7. Approval record template (filled — retained for audit)

```text
CR-HM-FIELD-OPERATIONS-01 PART 03
GATE=APPROVED
SG-1=APPROVED|APPROVED_WITH_CHANGES|REJECTED      → APPROVED
SG-2=OPTION_A|OPTION_B                            → OPTION_A
SG-3=OPTION_A|OPTION_B                            → OPTION_A
SG-4=OPTION_A|OPTION_B                            → OPTION_A
SG-5=APPROVED|REJECTED                            → APPROVED
SIGNED_BY=CR Owner (Handyman)
SIGNED_AT=2026-10-24T13:02:45+07:00
CHANGES=<empty>
```

---

## 8. Approval record (SIGNED)

```text
CR-HM-FIELD-OPERATIONS-01 PART 03
GATE=APPROVED
SG-1=APPROVED
SG-2=OPTION_A
SG-3=OPTION_A
SG-4=OPTION_A
SG-5=APPROVED
SG-6=APPROVED (proceed to PART 04)
SIGNED_BY=CR Owner (Handyman)
SIGNED_AT=2026-10-24T13:02:45+07:00 (Asia/Jakarta)
BASELINE=4eae70e
CHANGES=none
```

**Decisions as recorded (original wording of the approval, in Indonesian):**

1. **SG-1 APPROVED** — implement G-2 QR Registry and G-3 Building Geofence
   Configuration.
2. **SG-2 OPTION A APPROVED** — use the existing
   `building_configuration.read/manage`, with exact-Building RBAC, audit, and
   separation of authority. A field worker must not manage configuration in
   order to verify their own arrival.
3. **SG-3 APPROVED** — add `409 HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED`.
4. **SG-4 APPROVED** — for a **new attempt**, a challenge belonging to an
   already-superseded assignment must be refused **before TTL evaluation**,
   without consuming the token and without creating a result row. Idempotent
   replay and the existing contract for assignments that are **still ACTIVE**
   must be preserved.
5. **SG-5 APPROVED** — perform a **controlled** certification amendment without
   silently changing the frozen historical contract.
6. **SG-6 APPROVED** — continue with PART 04 implementation after the approval is
   recorded.

**Location of the governance record:**

| Artefact | Purpose |
| --- | --- |
| `docs/handyman/CR-HM-FIELD-OPERATIONS-01_PART03_SIGNOFF_GATE.md` | This gate + the signed approval record (§8) + binding conditions (§9) |
| `docs/handyman/CR-HM-FIELD-OPERATIONS-01_PART03_GOVERNANCE_AMENDMENT.md` | Frozen-decision review, design, RBAC matrix, decisions D-1…D-8 |
| `docs/handyman/CR-HM-FIELD-OPERATIONS-01_PART03_PROPOSED_API_CONTRACT.yaml` | Proposed API contract (not applied to `docs/api/openapi.yaml`) |
| `docs/handyman/CR-HM-FIELD-OPERATIONS-01_PART03_SECURITY_TESTS.md` | Proposed security test plan (25 groups / 41 assertions) |

---

## 9. Binding conditions on PART 04 (derived from the approval)

These are **implementation acceptance criteria**, not suggestions. PART 04 is not
complete if any of them fails.

| # | Condition | Enforced by |
| --- | --- | --- |
| **AC-1** | Exact-Building RBAC: `building_configuration.read\|manage` **plus** the BE-02G exact-Building guard on every G-2/G-3 operation; a same-Client sibling-Building manager is refused | G2-12, G2-13, G2-14, G3-14, G3-15 |
| **AC-2** | Audit preserved: every policy create/replace and identifier register/deactivate is journalled; policy history is readable and never overwritten; DELETE stays blocked | G2-04, G3-01, G3-02, G3-03, G3-07 |
| **AC-3** | Separation of authority: **no field worker (Crew Lead, Inspector, helper, Tenant PIC) can manage configuration**, so no actor can configure the evidence that verifies its own arrival | G2-16, G2-17, G3-17 |
| **AC-4** | G-2 secret handling: the opaque value is returned exactly once; list/get/deactivate return neither the value nor its hash | G2-01, G2-03 |
| **AC-5** | G-4 is evaluated on **new attempts** before TTL evaluation, with **no** token consume and **no** result row; the superseded binding wins over expiry | G4-01, G4-02, G4-06, G4-07 |
| **AC-6** | Idempotent replay preserved: an already-recorded result for the same challenge is still returned unchanged | G4-04 |
| **AC-7** | Existing contract preserved for **still-ACTIVE** assignments: a different actor keeps the certified `FAILED / ACTOR_ASSIGNMENT_INVALID` verdict | G4-05 |
| **AC-8** | Controlled certification amendment: the narrow for `CR-HM-07_FINAL_CERTIFICATION §8` is recorded as an explicit, dated annex referencing this gate — the frozen historical text is **not** silently rewritten | CT-03 + PART 04 governance record |
| **AC-9** | No new role, no new persona, no new permission code, no seed change (Option A); no migration | CT-05, `git diff` review |
| **AC-10** | CR-HM-07 firewall intact: configuration creates no verdict, consumes no challenge, starts no work, touches no payment/BAST/FM | G2-30…G2-32, G3-30…G3-32 |

---
