# CR-HM-04 — PROVIDER, WORKER & CREW — START GOVERNANCE (2026-09-27)

**Status: GOVERNANCE stage — F1–F10 are DECISIONS REQUIRED (not yet frozen).**
A follow-up DECISION FREEZE docs-commit precedes any implementation PART.
This document is the only CR-HM-04 artifact at this stage: **no runtime
code, no migration, no HTTP** exists or is authorized here.

This document follows the same START → FREEZE → PARTs ≤ 5 → FINAL
VALIDATION flow proven by CR-HM-01/02/03 (docs-only governance now;
code only after the freeze).

**Repo authority:** Handyman-Backend only. Arena accesses ONLY this repo;
frozen cross-repo facts in this document are authoritative and are never
re-derived by inspecting other repositories.

---

## 1. Authoritative inputs (read, unmodified)

- `HANDYMAN_CR_CODING_ROADMAP_v1.0.md` (FROZEN) — CR-HM-04 scope row
  (lines 78–86) and acceptance row (line 369); CR-HM-21 boundary
  (line 386); glossary (line 435).
- `CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` (FROZEN) — Provider/Worker/
  Crew domain row 10 (REUSE_WITH_CONTEXT + NEW; Handyman-Backend owns);
  row 33 (Asentra-SaaS owns commercial enablement; Handyman-Backend owns
  provider onboarding/eligibility/operational assignment/transaction
  lifecycle); boundary invariants rows 90–92; blocker registration
  (row 10 = A — BACKEND CONTRACT BLOCKER; feeds rows 12, 33).
- `CR-HM-00_BACKEND_CAPABILITY_MAP.md` (FROZEN) — rows 7–8
  (REUSE_WITH_CONTEXT foundation), row 37 (Handyman Work Crew = NEW),
  coverage rows 64–66.
- `CR-HM-03_START_GOVERNANCE.md` (+ F1–F9 freeze) and
  `CR-HM-03_FINAL_VALIDATION.md` (COMPLETED) — the F9 discipline registry
  and CR-HM-03 referral boundary this CR consumes read-only.

These four are **frozen for CR-HM-04**: they are never edited by this CR.

## 2. Mandatory business model (user-directed, binding)

- **Provider** = Merchant / Executor organization.
- **Worker** = individual workforce identity belonging/linked to a
  Provider.
- **Crew** = execution grouping for a Handyman job.
- **Lead Worker / PIC** = accountable crew lead; app user for field
  execution; later confirms actual helpers at check-in.
- **Helper** = may participate WITHOUT application login; must still be
  represented sufficiently for attendance/work-session provenance when
  required later.
- **Provider assigns crew. BM/customer NEVER assign workers directly.**

## 3. Exact existing seams found (read-only inspection, Handyman-Backend)

| Seam | Location | Shape | Relevance |
|---|---|---|---|
| Provider master | `vendors` (0054); module `src/modules/vendors` | VendorRecord + ACTIVE/INACTIVE status (+ vendor_categories data, vendor_pics, vendor_building_relationships, vendor_compliance_documents) | Provider identity + catalogue-adjacent capabilities without FM workflow |
| Provider→person binding | `vendor_workforce_bindings` (0060); `src/modules/vendor-workforce` | Vendor → binding → `workforce_profiles`; effective window; ACTIVE/INACTIVE; partial-unique ACTIVE idiom; creates NO user/credential/role/building access | Worker ownership/linkage to provider |
| Person master | `workforce_profiles` (0024); `src/modules/workforce` | Profile identity with **`userId` NULLABLE — a profile may exist entirely without a User account**; status + type vocab | Individual worker identity; **native login-less representation** (helper prerequisite) |
| Org-scope awareness | `external_workforce_links` (0033) | Vendor's own personnel code + optional effective window on a workforce profile | Vendor-side code/provenance precedent |
| Team grouping | `teams` (0022) | Department-scoped org naming entity; **explicitly NOT a workforce membership/job entity** | Insufficient for per-job Handyman crew — see F3 |
| Skills | `skills` (0025) + `workforce_skill_assignments` (0026); `vendor_capabilities` (0059, code/name only) + 0323 capability service identity | Worker-side skill links (existing vocab); provider-side capability rows | Skill/capability reuse with F9 non-authority rule |
| Assignment infrastructure | `work_order_assignments` module (+ related assignment idioms BE-03D2/BE-03E/BE-03G: effective windows + partial-unique ACTIVE indexes + preserved inactive history) | Durable assignment rows with provenance windows | Crew assignment/replacement/history convention — infrastructure only |
| Realm/RBAC | `context-access` (`canAccessClient`, building access), `users`, `roles`, `permissions`, `operational_events` | Existing conventions as exercised by CR-HM-02/03 | F9/F10 anchors |

## 4. REUSE / EXTEND / NEW matrix

| Capability | Verdict | Rationale (frozen rows cited) |
|---|---|---|
| Provider identity (`vendors`) | **REUSE_WITH_CONTEXT** | Map rows 7/64. Vendor master + vendor_workforce_bindings reused; Handyman relationships/policies remain Handyman-context; no automatic adoption of FM vendor workflows. |
| Provider Handyman profile/context | **NEW (bounded)** | CR-HM-04 needs Handyman-context operational context (eligibility/relation to Handyman journeys) without touching SaaS commercial enablement (CR-HM-21 boundary, matrix row 33) and without making the vendor master Handyman-aware. A Handyman-owned provider context/link references the vendor master by ID. |
| Worker identity (`workforce_profiles`) | **REUSE_WITH_CONTEXT** | Map rows 8/65 + BE-03C foundation; Handyman roles/eligibility distinct from FM workforce. The person master is NOT reproduced. |
| Worker Handyman role marker | **EXTEND (minimum)** | A Handyman-side bounded marker/eligibility flag on the person side (e.g., via binding/profile-context row) so Lead-eligibility and helper semantics never mutate the shared master; exact mechanism decided at FREEZE (F2). |
| Lead Worker / PIC | **NEW** | Exactly-one-accountable-lead per crew is Handyman semantic; must bind to an authenticated app user (field execution) while helpers need not login. |
| Crew entity (job grouping) | **NEW** | Capability map row 37 is explicit NEW; `teams` (0022) is department org naming, not per-job membership. Handyman owns composition/responsibility/history. |
| Helper representation | **REUSE (core) + NEW (binding)** | `workforce_profiles` (`userId NULLABLE`) natively represents login-less people; the crew-side binding/history is NEW. |
| Skills | **REUSE_WITH_CONTEXT** | `skills`/`workforce_skill_assignments` + `vendor_capabilities` reused as **informational** capability data only (F6). |
| Assignment/composition windows | **REUSE (convention)** | BE-03-style partial-unique ACTIVE windows + preserved history — the per-job crew assignment/replacement/history idiom (infrastructure, never authority). |
| Discipline authority for capability | **NOT reused — consume F9 registry (CR-HM-03) by reference** | F6 firewall: skills map to `handyman_disciplines` by ID/code; capability records never become discipline authority. |

## 5. F1–F10 — governance questions, with blockers/decisions required

**F1 — Provider authority.** `vendors` is reusable as the provider
identity master. DECISION REQUIRED: shape of the bounded Handyman
**provider operational context** (Handyman-owned row referencing
`vendors.id` + Handyman-scoped status/notes) versus zero-extension reuse.
BLOCKER: confirm none of CR-HM-04's acceptance terms need fields the
vendor master lacks (operational lifecycle fields), else the bounded
context row is required. The vendor master itself is never modified for
Handyman semantics.

**F2 — Worker authority.** `workforce_profiles` is the authoritative
person master; provider linkage = `vendor_workforce_bindings` (existing).
BLOCKER/DECISION REQUIRED: decide the minimum Handyman role/eligibility
marker mechanism for Lead-eligibility + helper semantics (e.g., a
Handyman-owned worker-context row keyed to `workforce_profiles.id`) —
chosen such that creating it never creates users/credentials and never
mutates FM workforce state. Prefer composition over schema change.

**F3 — Crew model.** `teams` is insufficient (department org entity, no
job membership). **Handyman Work Crew entity is NEW** (frozen map row
37): per-job grouping with composition, responsibility, replacement,
history. DECISION REQUIRED: minimum crew schema (crew row + member rows
+ assignment/provenance windows reusing BE-03 idiom) within the ≤5 PART
budget.

**F4 — Lead Worker.** Exactly one accountable Lead Worker/PIC per crew,
an app-authenticated user for field execution. DECISION REQUIRED:
representation (crew.lead bound to a workforce profile that IS linked to
a User via `userId` — never to a bare helper). Validation: lead must
exist, be workforce-bound, and carry a non-null `userId` at assignment
time; swap/replacement preserves history.

**F5 — Helpers.** Helpers may exist WITHOUT login: `workforce_profiles`
with `userId = NULL` provides the native seam. Person-side helper
representation = plain workforce profile (bounded context per F2);
crew-side membership binding persists provenance (needed later by
CR-HM-12/13 attendance/session). BLOCKER/DECISION REQUIRED: confirm no
minimal identity fields are needed beyond the profile for F5 (keep
helper row composition minimal; session/attendance specifics are later
CRs).

**F6 — Skill/capability.** Worker skills (`workforce_skill_assignments`,
`skills`) and vendor capabilities (`vendor_capabilities`) are
**informational only**. Freezing rule (mirror F9.10): capability records
NEVER become discipline authority; any Handyman-scoped capability
statement references `handyman_disciplines` by ID/code (READ-only use of
the CR-HM-03 F9 registry). DECISION REQUIRED: whether CR-HM-04 needs a
Handyman skill→discipline link row at PART-time or remains unlinked for
now (prefer minimum: link only if assignment contracts require it).

**F7 — Assignment boundary.** The frozen roadmap scope row places
**"crew assignment" explicitly inside CR-HM-04**; scheduling/rescheduling
lives in CR-HM-05; execution/QC/session/attendance in CR-HM-12/13/14
(roadmap rows); arrival/location verification in CR-HM-07/12 (matrix row
12). CR-HM-04 OWNS: provider/worker/crew lifecycle, crew composition,
lead designation, helper representation, crew assignment to a request
(job) with history. CR-HM-04 DOES NOT OWN: scheduling decisions,
arrival/verification, session/presence/billing, execution outcome,
quotation, provider commercial enablement.

**F8 — Lifecycle statuses.** Minimum vocabularies only, chosen at
FREEZE; candidates (existing family conventions): provider context /
worker context / crew = ACTIVE / INACTIVE; assignments = effective
windows (no status field). BLOCKER: no evidence exists that more statuses
are needed — minimum follows.

**F9 — Actor/scope.** Mutations by authenticated local user with
existing accessible-Client / RBAC conventions (same derivation as
CR-HM-02/03 PART 05 surfaces). Assignments are Provider-authored in the
Handyman context (never BM/customer-authored for worker assignment) —
enforced at the service layer; HTTP permission binding deferred to the
HTTP PART (closest existing read/manage convention).

**F10 — Audit/history.** Material changes journal on the existing
append-only authority (`operational_events`) following the CR-HM-03 F6
pattern (Handyman-bounded event rows: provider/worker/crew lifecycle
events + crew assignment/replacement history incl. prior-lead
references). Journal = audit only, never lifecycle authority.

## 6. Authority boundaries (binding invariants)

- **FM Firewall (explicit):** CR-HM-04 adopts NO FM vendor workflow
  (`vendor-work` operational semantics), NO FM workforce processes, and
  creates NO FM-entity for provider/worker/crew; FM/common-building
  provider workflows remain OUT OF SCOPE (CR-HM-03 F4/F5 boundary
  unchanged).
- Provider Identity != SaaS Customer (matrix row 90/92 boundary).
- Provider Capability != Handyman Discipline Authority (F9 registry of
  CR-HM-03 remains the sole scope authority; consumed read-only).
- Worker Skill != Provider Commercial Enablement (commercial = CR-HM-21,
  owned by Asentra-SaaS via explicit contract; never derived here).
- Crew Membership != Billable Time; Crew Membership != Work Session
  Attendance (session/attendance/billing are CR-HM-12/13+).
- Provider Assignment != Specialist Referral (CR-HM-03 referral identified
  the specialist TARGET only; it selected no provider).
- Provider Assignment != Quotation (CR-HM-07+).
- Provider Marketplace Enablement remains CR-HM-21 — no commercial state
  enters Handyman-operational data here.
- BM/customer NEVER assign workers directly (mandatory business model).
- Dependency (read-only): `handyman_disciplines` (F9 registry), the
  request row/status vocabulary of CR-HM-02/03 — consumed, never
  modified.

## 7. Recommended implementation PARTs (≤ 5, DRAFT — sized for the FREEZE)

| PART | Scope (minimum migration each) | Focused tests |
|---|---|---|
| 01 | Provider operational context: bounded Handyman provider context/profile linked to `vendors` (REUSE identity; NEW context) + F1 freeze artifacts on lifecycle/status; journal foundation | ~8 |
| 02 | Worker context: Handyman-side person-context binding to `workforce_profiles` (REUSE person master) incl. helper representation (`userId` nullable) + Lead-eligibility marker (F2/F5) | ~8 |
| 03 | Crew entity: Handyman Work Crew + membership/composition (F3), exactly-one Lead Worker/PIC validation (F4), BE-03-idiom assignment windows | ~8 |
| 04 | Crew assignment to a Handyman request/job: provider-authored assignment + replacement + history (F7/F10), RBAC/service guards (F9), boundary proofs vs CR-HM-5/12/13 | ~8 |
| 05A | HTTP + OpenAPI bounded surface (F8/F9 tokens) + 05B final validation + certification doc (CR-HM-03 convention) | ~12 |

Sequencing: 01→02→03→04→05A→05B. Any PART must STOP/report rather than
touch unrelated tables, adopt FM vendor/workforce workflow semantics,
create commercial/marketplace state, or invent vocabulary outside the
frozen decisions (once F1–F10 are frozen).

## 8. Explicit non-goals for CR-HM-04

No FM provider workflows; no SaaS commercial enablement; no job
scheduling (CR-HM-05); no arrival/location verification (CR-HM-07/12);
no work session/attendance/billing (CR-HM-12/13/15); no quotation
(CR-HM-06 Consumer approval); no customer/BM-driven worker selection;
no migration/code in this governance stage.

---

*CR-HM-04 governance STARTED 2026-09-27. Decisions F1–F10 are candidates
for the follow-up DECISION FREEZE; nothing here authorizes implementation.*
