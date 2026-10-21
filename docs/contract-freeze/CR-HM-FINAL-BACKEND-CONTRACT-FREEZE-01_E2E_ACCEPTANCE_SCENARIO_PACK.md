# E2E Acceptance Scenario Pack — Four-Repository Integration

Purpose: the sequential acceptance script for Frontend → Operations → Mobile
against Freeze Candidate v1.0. Each scenario names the persona, the exact
operations (see consumer handoffs for the full tables), the state that must be
observable afterwards, and the negative checks. **No scenario is marked PASS
by this document** — PASS is recorded per repository during integration and
jointly on staging (FG-03/FG-04).

Entry criteria (all): candidate backend deployed to **staging** with pending
migrations applied in registry order (`db:migrate:status` clean); seeded RBAC
roles for Care, Operations, Finance, Settlement, QC Supervisor, Manager
(`finding.close`), and one Crew (Lead + Helper) with ACTIVE building
assignments; one Client/Property/Building/Unit/Tenant+PIC chain (master data
scenario S0). All mutating calls send a fresh `idempotencyKey` per intent.

| ID | Scenario (persona → operations) | Expected terminal/observable state | Negative checks |
|---|---|---|---|
| S0 | **Master data (Operations):** create Client→Property→Building→Unit (`/buildings/{id}/units`), assign Unit parties (Owner/Occupant/PIC), batch-import Tenants/PICs (`/clients/{id}/tenant-imports` upload→validate→confirm→commit), verify a Tenant Company and a PIC (`/tenant-companies/{id}/verification`, `/tenant-pics/{id}/verification`) | Unit parties effective-dated; import batch COMMITTED; verification statuses persisted | Foreign-Client unit → 404-shaped; unverified PIC cannot bind a decision (S2) |
| S1 | **Intake (Frontend/Care):** Care creates request for the Unit's tenant (`POST /handyman/care/buildings/{buildingId}/requests`), staff triages (`POST /handyman/requests/{id}/triage`) | Request `INTAKE → TRIAGE`; attribution + building server-derived | No building assignment → 403 `BUILDING_ACCESS_DENIED`; client-sent actor/status fields → 400 (Care) |
| S1a | **Cancellation (Frontend/Care):** cancel a second pre-commitment request (staff + Care variants), read `GET …/cancellation`, replay same key | `CANCELLED` terminal; replay returns same fact `replayed:true` | Cancel after quotation approval → 409 `…_CANCEL_COMMITTED`; second distinct attempt → 409 `…_ALREADY_CANCELLED`; key reuse across requests → 409 `…_KEY_CONFLICT` |
| S2 | **Inspection (Operations→Frontend):** propose visit slots, assign inspector (`/handyman/visit-appointments/{id}/inspector`), Tenant/PIC confirms via Care (`…/visits/{appointmentId}/confirm`), record inspection + diagnosis | Appointment confirmed only after tenant confirmation; diagnosis recorded | Unconfirmed appointment is not authoritative; ineligible inspector → 409/403 per handoff |
| S3 | **Quotation (Operations→Frontend):** author quotation + version with DP terms, issue, Tenant/PIC decision (`/handyman/quotation-versions/{id}/decision`) | APPROVED version immutable; execution scope created from it; amounts server-derived | Client-sent amounts → 400; decision on superseded version → 409 |
| S4 | **Dispatch (Operations→Mobile):** assign crew (`…/assignment` with `expectedVersion`+`reason`), dispatch readiness → release, worker arrival verification | Scope AUTHORIZED; release RELEASED; arrival PASS/MANUAL_REVIEW per policy | Reassign supersedes release (prior Lead loses authority — verify on Mobile with old Lead token → 403/409) |
| S5 | **Field execution (Mobile):** Lead check-in → start-work → pause/material-run → resume → complete → check-out; upload field evidence (presign/upload/bytes/confirm); propose a scope variation finding | Session CHECKED_OUT; evidence byte-verified; variation proposed | Helper attempting Lead-only command → 403; evidence confirm with mismatched hash → 400/409 |
| S6 | **Materials (Mobile→Operations):** field purchase request → Operations approve/purchase/issue/use/return/reconcile | Material lines settled; final-charge-ready reflects net usage | Over-issue beyond approved → 409 |
| S7 | **QC (Operations):** supervisor opens QC run (versioned checklist), sets items, binds evidence, FINISH PASS; raise a defect on a second scope and run rectification → reinspection PASS | QC PASSED; defect VERIFIED; only current PASS unlocks BAST | Crew member as QC actor → 403 (`handyman.qc.manage` + reporting-line gate); BAST prepare before PASS → 409 |
| S8 | **BAST (Mobile→Frontend):** worker prepares/issues BAST; customer accepts with `signatureDigest` + same-scope evidence (`POST /handyman/bast/{id}/accept`); reject path on a second BAST, then VOID + re-PREPARE | BAST ACCEPTED (resp. REJECTED→VOID→new DRAFT legal) | Accept without same-scope evidence → 400/409; accept by non-bound Tenant/PIC → 403 |
| S9 | **Finance (Operations/Frontend):** open ledger, compose charges, Tenant uploads payment proof (Care lane), Finance records + confirms payment (`obligationStage` DP→TERMIN→PELUNASAN), allocates within NET caps, posts a correction within bounds | Ledger balanced; allocations ≤ net caps (0447); proof ≠ confirmation (separate facts) | Allocation over cap → 409; Care actor confirming payment → 403 (`handyman.finance.manage` required); unknown body fields → 400 |
| S10 | **Settlement & dispute (Operations):** derive entitlements, prepare→include→reconcile→settle; open a DISPUTED exception on a second scope, adjudicate `RELEASED`, re-run include/settle; adjudicate `UPHELD` on a third and confirm it still blocks | Settlement SETTLED (state only, no fund movement); RELEASED clears the hold; UPHELD keeps blocking | Adjudication by `handyman.finance.manage`-only user → 403 (`handyman.settlement.manage` distinct); second adjudication → 409; adjudicate SETTLED unit → 409 |
| S11 | **Warranty & FINAL CLOSE (Frontend/Operations/Mobile):** start warranty, Tenant files claim, Operations approves, Mobile Lead runs free rework (start/complete), Operations verifies; Manager reads `final-close/readiness`, closes with `finding.close` | Claim rework VERIFIED; readiness blockers empty; scope CLOSED with append-only close event | FINAL CLOSE with open dispute/defect/unallocated payment → readiness lists the exact blocker codes and `POST …/final-close` → 409; close without `finding.close` → 403 |

Cross-cutting checks (every scenario): unauthenticated → 401; cross-Client
IDs → 404-shaped; replayed idempotency keys return `replayed:true` without
duplicate facts; every error body matches `{success:false,error:{code,…}}`
and the consumer renders from `error.code`, never from message text.

Exit criteria for FINAL FREEZE: S0–S11 PASS on staging with all four
repositories at their integrated builds; FG-03/FG-04 closed (FG-01 closed
2026-10-21 by CR-HM-BACKEND-CONTRACT-FREEZE-02); results
appended to this pack as a dated evidence table (build SHAs per repository).
