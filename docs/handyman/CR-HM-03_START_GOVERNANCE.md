# CR-HM-03 — START GOVERNANCE
## Triage, Inspection & Specialist Escalation

Primary authority: **Handyman-Backend** (frozen roadmap: rows for
CR-HM-03 contract). Governance-only document — **no code, no migration, no
runtime change**.

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
| Decision/history convention (A) | `src/modules/operational-events/index.ts` (`recordOperationalEvent` — append-only `operational_events` BE-07 authority; sensitive-key scrubbing; executor/correlation seam) | Observability events around HM decisions (same restraint as CR-HM-01/02 → optional, dark) | REUSE (optional observability) |
| Decision/history convention (B) | `src/modules/finding-history/` (`recordFindingEvent` — per-entity append-only journal: `findingId/clientId/buildingId/eventType/actorUserId/summary/metadata`) | **Pattern** for an HM decision journal (preserve original request/history as business authority) | REUSE (pattern), journal table = NEW bounded decision (see F6) |
| Checklist engine (BE-07) | `src/modules/checklist-templates/`, `src/modules/checklist-executions/` (shared execution write service used by REST + offline sync; evidence parent `CHECKLIST_EXECUTION` already admitted) | Structured inspection checklists — **optional composition** only; HM QC templates stay separate from FM checklists (CR-HM-10 owner per frozen map row) | REUSE_WITH_CARE (composition, not FM template authority) |
| Inspection examples | `src/modules/toilet-inspections/…` (HK-scoped), `src/modules/inspection-bindings/…` (engineering-scoped) | Style/convention references ONLY — never FM-semantics adoption | REFERENCE ONLY |
| Provider/specialist reference | `src/modules/vendor-capabilities/` (types: `vendorId`, capability `code`, **`serviceCatalogId` identity link** — capability taxonomy against the governed service master) | Convention for a specialist target: **category identity anchored to `service_catalog`** (vendor-less at CR-HM-03; matching algorithm NOT built) | REUSE (convention); provider directory = REFERENCE ONLY |
| FM boundary (contrast) | `src/modules/tenant-service-requests/` (BE-14E intake + `createServiceRequestWorkRequestHandler` / `createServiceRequestWorkOrderHandler` conversion), `src/modules/work-requests/`, `src/modules/work-orders/` | FM intake→conversion workflow = the exact boundary Handyman must NOT replicate or absorb; work-orders may only consume in-scope work **after** the HM decision (frozen map row 45) | DO NOT TOUCH |

---

## 2. Required flow mapping

```
Handyman Request (CR-HM-02, INTAKE)
  → Initial Triage
  → Inspection (when required — physical visit optional; declared by triage)
  → Diagnosis
  → Scope Classification
  → Decision:
       A. General Handyman (in-scope, core catalogue skill)
       B. Specialist Required (escalation; e.g. Electrical/AC — category target)
       C. Refer / Out of Handyman Scope (excluded FM disciplines; terminal HM outcome)
```

| Step | Existing seam | REUSE / EXTEND / NEW | Authority | Persistence need | Missing contract |
|---|---|---|---|---|---|
| Intake → triage boundary | `handyman-requests` (INTAKE-only status) | NEW triage record on the existing request; EXTEND request lifecycle vocabulary (bounded, see F1) | Handyman-Backend; request row stays the context authority | New triage record + lifecycle step | No triage owner/vocabulary exists |
| Triage result (minimum) | none | NEW bounded result: outcome {SCOPE_OK, NEEDS_INSPECTION, OUT_OF_SCOPE} + short reason | Backend actor on derived Client scope (F8) | Persist outcome + actor + time in journal | Vocabulary not yet frozen |
| Inspection (when required) | checklist engine (optional composition) | NEW HM inspection record; optional link to checklist execution for structured notes | Inspection != Work Execution (mandatory boundary) | One record per inspection visit; optional structured payload | No HM inspection record exists |
| Diagnosis | none | NEW diagnosis representation bound to triage/inspection chain: result summary + recommended service/specialty + scope classification | Diagnosis != Quotation (mandatory boundary); no pricing | Persist on decision record/journal | Representation not yet defined |
| Scope classification | `service_catalog.category` vocabulary (+ excluded-discipline list from frozen map) | REUSE category reference for A/B/C classification | Final decision authority = Handyman-Backend only | Classification fields on decision record | None — free vocabulary exists |
| Decision B — Specialist Required | vendor-capability identity-link convention | NEW referral/escalation record: decision + **target category** (anchored to `service_catalog`); no provider pick, no assignment, no new request | Escalation != Provider Assignment (mandatory boundary); CR-HM-04 owns providers | Referral record + journal | No referral record exists |
| Decision C — Refer / Out of scope | none (must NOT create FM entities) | NEW terminal HM outcome record (refer) with provenance + reason preserved | Refer != FM workflow (mandatory boundary) | Referral record + journal | Outcome vocabulary on request (F1/F6) |
| History/provenance preservation | finding-history pattern + operational-events | NEW HM append-only decision journal (F6), exact finding-history convention | Original request + attribution + journal immutable; never overwritten by later decisions | Append-only rows | HM journal table (F6) |

---

## 3. Mandatory boundaries (binding for every PART)

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
  parent; triage is the FIRST decision record against it. The request row
  is never mutated beyond the bounded lifecycle field (F1).
- **Minimum triage result:** outcome token + reason text (bounded length,
  mirroring sibling free-text conventions) + actor + timestamp, appended to
  the HM journal.
- **Who performs triage:** an authenticated backend actor with access to the
  request-derived Client scope (same access convention as CR-HM-02 PART
  03/04 — `canAccessClient` + `BUILDING_ACCESS_DENIED`). Provider/staff
  actor modelling is deferred to CR-HM-04 (F8 records this decision).
- **Classification vocabulary reuse:** `service_catalog.category` is the
  anchor vocabulary for service classes; triage outcome tokens themselves
  are NEW bounded HM vocabulary (no existing owner — frozen map row 45).

### B. Inspection
- **Record/checklist seam:** NEW HM inspection record; OPTIONALLY composes a
  checklist execution (BE-07 shared engine) for structured notes —
  “Handyman QC templates remain separate from FM checklists” (frozen map,
  CR-HM-10 owner) ⇒ templates/checklist administration stay out of CR-HM-03.
- **Findings/notes:** free diagnosis-input notes on the record (bounded);
  FM Finding entities are NOT produced (frozen map row 75 closes Handyman
  defect/rework vocabulary in CR-HM-10).
- **Inspection evidence linkage:** proposed bounded parent-admission, same
  mechanism as migration 0379 (`evidence_submission_execution` CHECK +
  bounded type policy applied only from the HM seam). Requires freeze (F3);
  if F3 is rejected, inspection evidence stays out of CR-HM-03 entirely.
- **Physical visit:** required only when the triage outcome routes to
  inspection (`NEEDS_INSPECTION`); map contract says “Inspection when
  required” — visit-optional is preserved at the record level (inspection
  performed → record exists; performed-physically flag is NOT modelled in
  CR-HM-03).

### C. Diagnosis
- **Representation:** NEW bounded diagnosis on the decision chain: cause /
  resolution summary (bounded text), recommended service/specialty
  (category reference to `service_catalog`), scope classification.
- **Relation to original request:** the diagnosis record references the
  request id (parent) + triage/inspection chain ids; the request’s
  attribution snapshot remains the only context authority.
- **Scope classification:** one of {GENERAL_HANDYMAN, SPECIALIST_REQUIRED,
  OUT_OF_SCOPE} — frozen proposal (F4); the excluded-discipline list
  (frozen capability-map catalogue-row exclusions) is the refer-side
  vocabulary reference, not an execution catalogue.

### D. Specialist Escalation
- **Capability seam:** `vendor-capabilities` identity-link convention
  (capability `code` + nullable `serviceCatalogId`) ⇒ the escalation
  target is a **category anchored to the service master**, vendor-less at
  CR-HM-03. Vendor/provider directory consult is REFERENCE ONLY.
- **Escalation/referral record:** NEW append-only record: request id,
  decision token (SPECIALIST_REQUIRED or OUT_OF_SCOPE refer), target
  category, reason, actor, timestamp; nothing is re-opened or replaced.
- **Original request/history/provenance:** preserved verbatim — the
  CR-HM-03 chain hangs under the CR-HM-02 request; request + attribution +
  journal are never rewritten; **no new/replacement request is created**
  (frozen map row 46).
- **No provider assignment:** CR-HM-03 names no provider, performs no
  matching, issues no routing (CR-HM-04 authority).

---

## 5. Gaps found

1. No owner/state vocabulary for HM triage/inspection/diagnosis decision
   states (frozen map rows 45–46 explicitly declare NEW).
2. No HM inspection record of any kind.
3. No HM specialist referral/escalation record.
4. No HM append-only decision journal (provenance-preserving history).
5. Request lifecycle is `INTAKE`-only — CR-HM-03 needs a bounded next-step
   vocabulary (must be frozen; see F1).
6. Inspection evidence linkage has no admitted parent in the evidence
   engine (needs F3 mechanism, mirroring 0379, or explicit deferral).

## 6. Blockers / decisions requiring freeze (record; do NOT implement)

- **F1 — Bounded request lifecycle vocabulary for CR-HM-03.** Proposed
  minimal set (freeze before PART 01): `INTAKE` → `IN_REVIEW` → terminal
  decision states derived from the decision record (`READY_FOR_QUOTE`,
  `SPECIALIST_ESCALATED`, `REFERRED_OUT`) — exact tokens frozen at PART-01
  governance; never FM `OPEN/CANCELLED/CONVERTED`.
- **F2 — Decision-record shape.** One bounded HM decision entity spanning
  triage/inspection/diagnosis chain vs three chained records. Proposal:
  ONE `handyman_service_decisions`-style chain keyed by request with
  per-step rows (mirrors append-only journal convention; minimum schema).
- **F3 — Inspection evidence linkage.** Extend
  `evidence_submission_execution` admission with an HM inspection parent
  (same mechanism as 0379) **or** defer inspection evidence entirely to
  CR-HM-10. Default: DEFER (keeps CR-HM-03 migration-minimal); freeze
  explicitly.
- **F4 — Scope classification tokens + specialist target vocabulary.**
  Proposed: {GENERAL_HANDYMAN, SPECIALIST_REQUIRED, OUT_OF_SCOPE} + target
  = `service_catalog` category string reference (excluded-discipline list
  cited in map remains council-only vocabulary — never an execution
  catalogue).
- **F5 — Refer terminality.** A refer outcome is terminal Handyman-side;
  no re-open paths exist in CR-HM-03 (any FM hand-off is manual/out-of-
  band — never structural).
- **F6 — History.** NEW HM append-only decision journal modeled exactly on
  `finding-history` (per-request journal: requestId/clientId/buildingId/
  eventType/actorUserId/summary/metadata, scrubbed) + optional
  `recordOperationalEvent` observability (dark, optional).
- **F7 — Actor model.** Authenticated user on request-derived Client scope
  performs all CR-HM-03 decisions (same as CR-HM-02); provider/staff actor
  contracts defer to CR-HM-04.
- **F8 — Actor permissions at HTTP.** Derived at PART 05A from the closest
  existing sibling-convention seam (tenant/customer vs staff-facing split
  recorded then).

## 7. Recommended SMALL implementation PARTs (≤ 5)

| PART | Scope (minimum-migration each) | Focused tests |
|---|---|---|
| 01 | Triage foundation: NEW bounded triage record + F1 lifecycle vocabulary (minimum migration) + read seam on request. Triage != Diagnosis enforced; journal append seam (F6 foundation) | ~8 |
| 02 | Inspection record on the triage/outcome chain (when-required contract; notes; optional checklist-execution link; F3 evidence decision respected) | ~8 |
| 03 | Diagnosis + scope classification (A/B/C outcome chain; category reference; Diagnosis != Quotation; request preserved) | ~8 |
| 04 | Specialist escalation/referral record (decision + category target; referral terms; no provider/no assignment/no FM entity; provenance intact) | ~8 |
| 05A | HTTP + OpenAPI bounded surface for 01–04 + admission/regression checks; 05B final validation + certification doc (CR-HM-02 convention) | ~11 |

Sequencing: 01→02→03→04→05A→05B. Any PART may STOP/report instead of
touching unrelated tables, adding FM semantics, or inventing
endpoint/enum/state/event/provider-matching vocabulary outside F1–F8.

---

*Prepared for freeze. Nothing in this document authorizes code; each PART
must state its own minimum migration and focused test set.*
