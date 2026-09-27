# CR-HM-04 — PROVIDER, WORKER & CREW — START GOVERNANCE (2026-09-27)

**Status: decisions F1–F10 FROZEN on 2026-09-27** (their authoritative
text is §5 below; every PART must implement exactly those tokens and
boundaries — nothing else). No implementation exists yet; the PART
sequence is fixed as 01→02→03→04→05A→05B.

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

## 5. F1–F10 — FROZEN DECISIONS (authoritative for implementation)

**F1 — PROVIDER AUTHORITY.** The existing `vendors` master remains the
authoritative provider identity/master. CR-HM-04 creates a bounded
**Handyman-owned provider operational context** linked to a vendor:
`handyman_provider_contexts` (Handyman-owned row → `vendors.id`).
It duplicates NO vendor identity and modifies NO vendor-master semantics;
it represents only the eligibility/state required for Handyman
operations. Provider context != SaaS Customer; != Marketplace enablement
(CR-HM-21); != FM vendor workflow.

**F2 — WORKER AUTHORITY.** `workforce_profiles` remains the
authoritative person identity. CR-HM-04 creates a Handyman-owned
worker-context association: Handyman Provider Context → Workforce
Profile. It duplicates NO person identity and modifies NO
`workforce_profiles` semantics. The worker context establishes that the
profile may participate under that Handyman provider;
`workforce_profiles.userId` may be NULL.

**F3 — CREW AUTHORITY.** `teams` is NOT Handyman Work Crew authority.
CR-HM-04 creates a Handyman-owned **Work Crew** entity under exactly one
Handyman provider context. Crew is an operational grouping only: crew !=
organization department/team; != attendance; != work session;
!= billable-time authority.

**F4 — LEAD WORKER / PIC.** Every ACTIVE/assignable crew has exactly one
Lead Worker/PIC. The lead MUST: (a) belong to the same Handyman
provider's worker context, (b) be an ACTIVE eligible crew member,
(c) have non-null `workforce_profiles.userId` (app-authenticated field
execution identity). Lead CHANGES preserve history — historical lead
facts are never overwritten.

**F5 — HELPERS.** A helper uses the existing `workforce_profiles`
identity; application login is NOT required (`userId` may be NULL).
Minimum helper identity = whatever `workforce_profiles` authoritatively
provides. No shadow/helper person identity exists in Handyman. Crew
membership supplies the Handyman participation context; later
attendance/work-session CRs (CR-HM-12/13+) consume this identity.

**F6 — SKILL / DISCIPLINE.** `skills`, `workforce_skill_assignments`,
and `vendor_capabilities` remain informational/reference capability
sources. CR-HM-04 creates NO skill→discipline authority mapping. The
CR-HM-03 **F9 Handyman Discipline Registry remains the ONLY Handyman
scope/discipline authority**; provider/worker capability MUST NEVER
redefine `discipline.scopeClass`. Any future capability-to-discipline
eligibility rule requires explicit later governance.

**F7 — ASSIGNMENT BOUNDARY.** CR-HM-04 owns **provider-authored crew
assignment history**: the provider selects an existing Handyman crew for
a Handyman operational target when such target is valid and available.
CR-HM-04 does NOT own: scheduling/time-slot selection (CR-HM-05),
permit/unit access, arrival verification (CR-HM-07/12), work session,
attendance, billable time, quotation, provider marketplace matching
(CR-HM-21). A CR-HM-03 referral does NOT automatically assign a
provider/crew. **No job/work-order entity is invented merely to satisfy
assignment.** **PART 04 STOP RULE (FROZEN): if no authoritative
assignable Handyman target exists at implementation time, preserve the
assignment model/contract boundary but DEFER target-binding runtime to
the owning CR.**

**F8 — LIFECYCLE.** Minimum bounded statuses only:
Provider Context / Worker Context / Crew / Crew Membership =
`ACTIVE | INACTIVE`. No commercial/compliance/FM workflow states.
INACTIVE records remain historical; operational history is never
hard-deleted.

**F9 — ACTOR / SCOPE.** Provider/worker/crew management requires an
authenticated local user plus the existing client/RBAC scope. The actor
is NEVER derived from vendor PIC, workforce profile, tenantPic, channel
attribution, or BM handoff identity. Provider-authored actions validate
that the acting authority is permitted for that provider/client using
existing RBAC/context seams. Exact HTTP permission tokens are deferred
to PART 05A (closest existing read/manage convention).

**F10 — AUDIT / HISTORY.** Material Handyman provider/worker/crew
changes journal as append-only operational-event history following the
CR-HM-03 convention (`operational_events` authority; journal is history/
audit only, NEVER lifecycle authority). At minimum history preserves:
provider-context state changes; worker-context state changes; crew state
changes; membership add/remove/deactivate; lead designation/change;
assignment changes once assignment runtime becomes valid.

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

## 7. IMPLEMENTATION PARTs — FROZEN sequence

| PART | Scope (minimum migration each) | Focused tests |
|---|---|---|
| 01 | Handyman Provider Context (F1): Handyman-owned provider operational context → `vendors`; status lifecycle (F8); journal foundation (F10) | ~8 |
| 02 | Handyman Worker Context (F2/F5): Provider Context → `workforce_profiles` association; helper representation via nullable `userId`; Lead eligibility grounded here | ~8 |
| 03 | Work Crew + Membership + Lead Worker (F3/F4): crew under one provider context; ACTIVE membership; exactly-one-lead invariant with history | ~8 |
| 04 | Crew Assignment / History (F7/F9/F10): provider-authored crew assignment + replacement + history; **STOP RULE: defer target-binding runtime if no authoritative Handyman target exists — never invent one** | ~8 |
| 05A | HTTP + OpenAPI bounded surface for 01–04 (F8/F9 tokens) | ~12 |
| 05B | Final validation + certification doc (CR-HM-03 convention) | — |

Sequencing: 01→02→03→04→05A→05B. Any PART must STOP/report rather than
touch unrelated tables, adopt FM vendor/workforce workflow semantics,
create commercial/marketplace state, or invent vocabulary outside the
FROZEN F1–F10 decisions.

## 8. Explicit non-goals for CR-HM-04

No FM provider workflows; no SaaS commercial enablement; no job
scheduling (CR-HM-05); no arrival/location verification (CR-HM-07/12);
no work session/attendance/billing (CR-HM-12/13/15); no quotation
(CR-HM-06 Consumer approval); no customer/BM-driven worker selection;
no migration/code in this governance stage.

---

*Decisions F1–F10 frozen 2026-09-27. Nothing in this document authorizes
implementation beyond the F1–F10 tokens and the FROZEN PART seque*nce.
