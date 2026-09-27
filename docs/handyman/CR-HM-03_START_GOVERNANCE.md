# CR-HM-03 — START GOVERNANCE
## Triage, Inspection & Specialist Escalation

Primary authority: **Handyman-Backend** (frozen roadmap: rows for
CR-HM-03 contract). Governance-only document — **no code, no migration, no
runtime change**.

**Status: decisions F1–F8 FROZEN on 2026-09-27** (their authoritative text
is §6 below; every PART must implement exactly those tokens and boundaries
— nothing else).

Frozen-roadmap scope (verbatim contract):
- triage
- inspection
- diagnosis
- specialist escalation/referral
- preserve original request/history

Frozen closure condition (roadmap acceptance row): *“Triage/inspection/
diagnosis/escalation decision contracts published; original request/history
preserved; referral cannot convert into FM workflow or silently expand
scope.”* Downstream consumers are CR-HM-06 (Quotation) and the CR-HM-17 /
CR-HM-18 journey integrations; execution glossary rows 4 and 5
(Triage/Inspection/Diagnosis, Specialist Escalation) close in this CR.

Frozen capability-map contract (rows 45–46 + glossary rows 60–61):
the entire decision sequence **Request → Initial Triage → Inspection
(when required) → Diagnosis → Scope Classification** and the **Specialist
Escalation** decision are **NEW Handyman-owned capabilities — they have NO
existing owner**. Existing engines (`tenant-service-requests`,
`service-catalog`, `work-orders`) are *supporting infrastructure only*:
- do **not** treat `tenant_service_requests` conversion or work-order
  status as triage/diagnosis,
- do **not** absorb FM workflows,
- referral must **not** replace the original request/history and must
  **not** silently become an FM workflow,
- excluded FM building disciplines (main/riser piping; pumps/building
  drainage; building electrical distribution; fire systems; lifts;
  gensets; AHU/chiller/central HVAC; structural/common-area systems; FM
  preventive maintenance) stay outside Handyman and may only be
  **refer/escalate outcomes when diagnosis identifies them**.

---

## 1. Reusable seams (exact, verified)

| Seam | Path | Role in CR-HM-03 | Disposition |
|---|---|---|---|
| Handyman request (CR-HM-02) | `src/modules/handyman-requests/` (`handymanServiceRequestService`, `handymanServiceRequestRepository.findById`, `HANDYMAN_SERVICE_REQUEST_STATUSES = ['INTAKE']`, `PublicHandymanServiceRequest`) | Sole intake parent + authoritative context snapshot (client/company/PIC/building/space; attribution handle) | REUSE (parent authority) |
| Channel attribution (CR-HM-01) | `src/modules/handyman-channel-attributions/` (`handymanChannelAttributionRepository.findById`) | Immutable provenance carried by the request; history never re-derives context | REUSE (provenance read) |
| Service/category reference | `src/modules/service-catalog/` (`serviceCatalogRepository.findById`, `ServiceCatalogStatus`, `category` free classification, `HANDYMAN` category convention from CR-HM-02) | Category/classification vocabulary reference for scope classification + specialist target category | REUSE (reference only) |
| Decision/history convention (A) | `src/modules/operational-events/index.ts` (`recordOperationalEvent` — append-only `operational_events` BE-07 authority; sensitive-key scrubbing; executor/correlation seam) | Optional **secondary** observability only (see FROZEN F6) | REUSE (secondary observability) |
| Decision/history convention (B) | `src/modules/finding-history/` (`recordFindingEvent` — per-entity append-only journal: `findingId/clientId/buildingId/eventType/actorUserId/summary/metadata`) | **Pattern** for the frozen Handyman decision journal (FROZEN F6) | REUSE (pattern) |
| Checklist engine (BE-07) | `src/modules/checklist-templates/`, `src/modules/checklist-executions/` (shared execution write service used by REST + offline sync; evidence parent `CHECKLIST_EXECUTION` already admitted) | Structured inspection checklists — **optional composition** only; HM QC templates stay separate from FM checklists (CR-HM-10 owner per frozen map row) | REUSE_WITH_CARE (composition, not FM template authority) |
| Inspection examples | `src/modules/toilet-inspections/…` (HK-scoped), `src/modules/inspection-bindings/…` (engineering-scoped) | Style/convention references ONLY — never FM-semantics adoption | REFERENCE ONLY |
| Provider/specialist reference | `src/modules/vendor-capabilities/` (types: `vendorId`, capability `code`, **`serviceCatalogId` identity link** — capability taxonomy against the governed service master) | Convention for a specialist target: **category identity anchored to `service_catalog`** (vendor-less at CR-HM-03; matching algorithm NOT built) | REUSE (convention); provider directory = REFERENCE ONLY |
| FM boundary (contrast) | `src/modules/tenant-service-requests/` (BE-14E intake + `createServiceRequestWorkRequestHandler` / `createServiceRequestWorkOrderHandler` conversion), `src/modules/work-requests/`, `src/modules/work-orders/` | FM intake→conversion workflow = the exact boundary Handyman must NOT replicate or absorb; work-orders may only consume in-scope work **after** the HM decision (frozen map row 45) | DO NOT TOUCH |

---

## 2. Required flow mapping

```
Handyman Request (CR-HM-02, INTAKE)
  → TRIAGE                       (FROZEN F1 state)
  → INSPECTION_REQUIRED          (only when the triage decision routes to inspection)
     … compartmentalized inspection record (structured result/notes only — FROZEN F3)
  → DIAGNOSIS                    (FROZEN F1 state)
  → scope classification         (FROZEN F4 vocabulary)
  → Decision:
       A. GENERAL_HANDYMAN       → READY_FOR_NEXT_STEP (later CR consumes; FROZEN F1/F4)
       B. SPECIALIST_REQUIRED    → READY_FOR_NEXT_STEP (specialist category recorded —
          Electrical/AC are targets ONLY, never execution authority — FROZEN F4)
       C. OUT_OF_HANDYMAN_SCOPE  → REFERRED (terminal for CR-HM-03 business
          processing — FROZEN F1/F4/F5)
```

| Step | Existing seam | REUSE / EXTEND / NEW | Authority | Persistence need | Missing contract |
|---|---|---|---|---|---|
| Intake → triage boundary | `handyman-requests` (INTAKE-only status) | NEW triage decision record on the existing request; bounded FROZEN F1 lifecycle on the request row | Handyman-Backend; request row stays the context authority | Decision record (FROZEN F2) + journal row (FROZEN F6) | None after freeze (was: no triage owner/vocabulary) |
| Triage result (minimum) | none | NEW bounded record: the FROZEN F1 transition it decides (`→ INSPECTION_REQUIRED` when a physical inspection is needed, `→ DIAGNOSIS` otherwise) + short reason | Authenticated user on derived Client scope (FROZEN F7/F8) | Append-only decision record + journal | None after freeze |
| Inspection (when required) | checklist engine (optional composition) | NEW HM inspection record — structured result/notes ONLY; FROZEN F3: no evidence expansion | Inspection != Work Execution (mandatory boundary) | One record per inspection | None after freeze |
| Diagnosis | none | NEW diagnosis representation bound to the triage/inspection chain: result summary + recommended service/specialty + FROZEN F4 scope classification | Diagnosis != Quotation (mandatory boundary); no pricing | Decision record (FROZEN F2) + journal | None after freeze |
| Scope classification | `service_catalog.category` vocabulary (+ excluded-discipline list from frozen map) | REUSE category reference for the FROZEN F4 outcome | Final decision authority = Handyman-Backend only | Classification fields on decision record | None after freeze |
| Decision B — SPECIALIST_REQUIRED | vendor-capability identity-link convention | NEW referral/escalation record: decision + **target category** (anchored to `service_catalog`); no provider pick, no assignment, no new request | Escalation != Provider Assignment (mandatory boundary); CR-HM-04 owns providers | Referral record + journal | None after freeze |
| Decision C — OUT_OF_HANDYMAN_SCOPE → REFERRED | none (must NOT create FM entities) | NEW terminal HM outcome record per FROZEN F5 (no FM request/conversion/work order/quotation/provider) | Refer != FM workflow (mandatory boundary) | Referral record + journal; request ends REFERRED | None after freeze |
| History/provenance preservation | finding-history pattern + (secondary) operational-events | NEW HM append-only decision journal per FROZEN F6 — audit/history, never lifecycle authority | Original request + attribution + journal immutable; never overwritten by later decisions | Append-only rows | None after freeze |

---

## 3. Mandatory boundaries (binding for every PART — PRESERVE)

1. **Triage != Diagnosis.** Triage classifies the intake and may route to
   inspection; only diagnosis concludes cause/solution.
2. **Inspection != Work Execution.** An inspection record is read/observe
   only — no repair, no material consumption, no work-order semantics.
3. **Diagnosis != Quotation.** Diagnosis output is scope/category; pricing
   executes later in CR-HM-06 exclusive authority.
4. **Specialist Escalation != Provider Assignment.** CR-HM-03 records the
   decision + target **category** only; provider/worker/crew contracts are
   CR-HM-04 authority; no matching algorithm is built (do-not-invent).
5. **Refer / Out-of-Scope != FM workflow.** Excluded disciplines produce a
   Handyman-side terminal refer outcome; no `tenant_service_requests` /
   work-request / work-order creation, no FM lifecycle (frozen roadmap:
   “FM workflows are never absorbed”; frozen map rows 45–46).
6. **Original request/history/provenance preserved.** The CR-HM-02 request
   row and its CR-HM-01 attribution snapshot are never replaced or
   rewritten by CR-HM-03 decisions; history is append-only.
7. **Electrical/AC specialist escalation must NOT turn the core General
   Handyman catalogue into Electrical/AC execution authority.** Excluded
   disciplines stay excluded from execution; they only influence the
   diagnosis → specialist-target classification.
8. **FM/common-building findings may only produce refer/escalate outcome.**
   No FM lifecycle is built here (CR-HM-10 owns Handyman finding/QC
   vocabulary; FM findings stay FM).

---

## 4. Step-specific mapping

### A. Triage
- **Intake → triage boundary:** the CR-HM-02 request in `INTAKE` is the
  parent; triage is the FIRST decision record against it and moves the
  request `INTAKE → TRIAGE` (FROZEN F1). The request row is never mutated
  beyond the bounded frozen lifecycle field.
- **Minimum triage result:** the FROZEN F1 transition decision
  (`→ INSPECTION_REQUIRED` when a physical inspection is needed,
  `→ DIAGNOSIS` otherwise) + reason text (bounded, mirroring sibling
  free-text conventions) + actor + timestamp, as an append-only decision
  record (FROZEN F2) with the journal entry (FROZEN F6).
- **Who performs triage:** an authenticated local user with existing
  scope/RBAC authority on the request-derived Client scope (FROZEN
  F7/F8) — same access convention as CR-HM-02 (`canAccessClient` +
  `BUILDING_ACCESS_DENIED`); exact permission tokens derive at PART 05A.
- **Classification vocabulary reuse:** `service_catalog.category` is the
  anchor vocabulary for service classes; the frozen F1/F4 tokens are the
  ONLY HM decision vocabulary (frozen map row 45: no existing owner).

### B. Inspection
- **Record/checklist seam:** NEW HM inspection record; OPTIONALLY composes a
  checklist execution (BE-07 shared engine) for structured notes —
  “Handyman QC templates remain separate from FM checklists” (frozen map,
  CR-HM-10 owner) ⇒ templates/checklist administration stay out of CR-HM-03.
- **Structured result/notes only — FROZEN F3:** the record carries
  structured result + free notes (bounded); FM Finding entities are NOT
  produced (frozen map row 75 closes Handyman defect/rework vocabulary in
  CR-HM-10); **no evidence parent/stage expansion in this CR** —
  inspection-specific evidence defers to CR-HM-10.
- **Physical visit:** required only when the triage decision routes to
  `INSPECTION_REQUIRED` (map contract: “Inspection when required”); the
  record exists exactly when an inspection was performed — no
  performed-physically flag is modelled in CR-HM-03.

### C. Diagnosis
- **Representation:** NEW bounded diagnosis on the decision chain
  (FROZEN F2): cause / resolution summary (bounded text), recommended
  service/specialty (category reference to `service_catalog`), FROZEN F4
  scope classification (`GENERAL_HANDYMAN` / `SPECIALIST_REQUIRED` /
  `OUT_OF_HANDYMAN_SCOPE`).
- **Relation to original request:** the diagnosis record references the
  request id (parent) + triage/inspection chain ids; the request’s
  attribution snapshot remains the only context authority.
- **Specialist target:** frozen to category-level targeting — Electrical
  and AC are specialist **targets only** (they never become General
  Handyman execution authority); FM/common-building scope classifies
  `OUT_OF_HANDYMAN_SCOPE`.

### D. Specialist Escalation
- **Capability seam:** `vendor-capabilities` identity-link convention
  (capability `code` + nullable `serviceCatalogId`) ⇒ the escalation
  target is a **category anchored to the service master**, vendor-less at
  CR-HM-03. Vendor/provider directory consult is REFERENCE ONLY.
- **Escalation/referral record:** NEW append-only record: request id,
  decision token (`SPECIALIST_REQUIRED` or `OUT_OF_HANDYMAN_SCOPE`
  refer), target category, reason, actor, timestamp; nothing is re-opened
  or replaced.
- **Original request/history/provenance:** preserved verbatim — the
  CR-HM-03 chain hangs under the CR-HM-02 request; request + attribution +
  journal are never rewritten; **no new/replacement request is created**
  (frozen map row 46).
- **No provider assignment:** CR-HM-03 names no provider, performs no
  matching, issues no routing (CR-HM-04 authority).

---

## 5. Gaps found (all resolved by FROZEN decisions §6 — implementation records them only)

1. No owner/state vocabulary for HM decision states (frozen map rows
   45–46: NEW) → **FROZEN F1/F4**.
2. No HM inspection record → bounded inspection record per §4.B with
   **FROZEN F3** restraint.
3. No HM specialist referral/escalation record → bounded record per §4.D.
4. No HM append-only decision journal → **FROZEN F6**.
5. Request lifecycle was `INTAKE`-only → **FROZEN F1** minimal vocabulary.
6. Inspection-evidence parent unadmitted → **FROZEN F3: DEFERRED to
   CR-HM-10** (not a gap inside CR-HM-03).

## 6. FROZEN decisions (authoritative — 2026-09-27)

**F1 — LIFECYCLE.** The request lifecycle remains minimal and
decision-driven:

```
INTAKE → TRIAGE → INSPECTION_REQUIRED or DIAGNOSIS
       → DIAGNOSIS → READY_FOR_NEXT_STEP or REFERRED
```

- No execution / quotation / provider states exist.
- `REFERRED` is **terminal** for CR-HM-03 business processing.
- A later CR may explicitly consume eligible `READY_FOR_NEXT_STEP`
  requests (CR-HM-06 authority for what “next step” means).

**F2 — DECISION RECORD.** Material triage/diagnosis decisions persist as
bounded **immutable, append-oriented decision records** — history is never
overwritten to represent the latest decision. Current state may be
projected/snapshotted separately if needed (the request row's bounded F1
status field is that projection). Exact schema derived during
implementation from existing conventions.

**F3 — INSPECTION EVIDENCE.** **DEFERRED** — inspection-specific evidence
expansion defers to CR-HM-10. CR-HM-03 inspection records structured
result/notes ONLY; no evidence parent/stage vocabulary is expanded in this
CR (the CR-HM-02 INTAKE evidence seam stays exactly as delivered).

**F4 — CLASSIFICATION / TARGET VOCABULARY.** Scope outcome:

```
GENERAL_HANDYMAN | SPECIALIST_REQUIRED | OUT_OF_HANDYMAN_SCOPE
```

- The specialist target is anchored to the existing service/category
  reference vocabulary (`service_catalog.category`) where possible.
- **Electrical and AC are specialist targets only here** — they never
  become General Handyman execution authority.
- **FM/common-building scope must classify `OUT_OF_HANDYMAN_SCOPE`.**

**F5 — REFER TERMINALITY.** `OUT_OF_HANDYMAN_SCOPE → REFERRED`. At a
referral: **no** FM request creation, **no** FM conversion, **no** work
order, **no** quotation, **no** provider assignment. The original
Handyman request and its history are preserved.

**F6 — JOURNAL.** A Handyman-bounded **append-only request
decision/history journal** is created, following the existing
`finding-history` pattern (per-request rows: request id / client /
building / event type / actor / summary / metadata, scrubbed). The journal
is audit/history, **not lifecycle authority**. `recordOperationalEvent`
entries may be emitted only as **secondary observability**.

**F7 — ACTOR MODEL.** CR-HM-03 actions require an authenticated local
user plus existing scope/RBAC authority. The actor is **never fabricated
from `tenantPicId`**; the BM handoff identity / channel attribution is
**not staff authority**. Exact permission binding is deferred to the HTTP
PART (F8).

**F8 — HTTP PERMISSION SPLIT.** Read operations use the closest existing
**read** permission convention. Triage / inspection / diagnosis /
referral **mutations require the closest existing `manage` permission
convention**. The service layer remains authoritative for scope/state
validation. Exact permission tokens/routes derive in PART 05A from
existing repository conventions.

## 7. Recommended SMALL implementation PARTs (≤ 5)

| PART | Scope (minimum migration each) | Focused tests |
|---|---|---|
| 01 | Triage foundation: bounded triage decision record (FROZEN F2) + FROZEN F1 lifecycle minimum + journal foundation (FROZEN F6). Triage != Diagnosis enforced | ~8 |
| 02 | Inspection record on the chain (`INSPECTION_REQUIRED` when-required contract; structured result/notes only — FROZEN F3; optional checklist-execution link) | ~8 |
| 03 | Diagnosis + FROZEN F4 scope classification (A/B/C outcome chain; category reference; Diagnosis != Quotation; request preserved) | ~8 |
| 04 | Specialist escalation / refer outcome (FROZEN F5 terminality; category target; FROZEN F4 Electrical/AC as targets only; no provider/assignment/FM entity; provenance intact) | ~8 |
| 05A | HTTP + OpenAPI bounded surface for 01–04 per FROZEN F7/F8 + admission/regression checks; 05B final validation + certification doc (CR-HM-02 convention) | ~11 |

Sequencing: 01→02→03→04→05A→05B. Any PART must STOP/report rather than
touch unrelated tables, introduce FM semantics, or invent endpoint/enum/
state/event/provider-matching vocabulary outside the FROZEN F1–F8
decisions.

---

*Decisions F1–F8 frozen 2026-09-27. Nothing in this document authorizes
code; each PART states its own minimum migration and focused test set.*
