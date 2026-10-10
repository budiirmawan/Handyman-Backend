# CR-HM-06 — ADDENDUM A: LATE TENANT PIC BINDING AUTHORITY

**Parent authority:** `CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` (`CR-HM-06/A01` v1.1, RATIFIED).
**Amends:** the A01 coherence rule for `handyman_quotation_decisions.tenant_pic_id` (see §5, recorded as **R-1**).
**Governed by:** `CR-HM-06_DECISION_FREEZE.md` F1–F12 as revised at v1.1 (F6) — this document adds **no** new lifecycle state, **no** new decision vocabulary, **no** new ledger.
**Repository:** Handyman-Backend holds the design authority; BM Super App owns nothing here (the binding is a Handyman-side act, §3.3).
**Type:** GOVERNANCE / DESIGN RECORD — **no runtime, migration, OpenAPI, or test change is made by this document.**
**Addendum id:** `CR-HM-06/A01-ADD-A` · **Version:** 1.0 · **Date:** 2026-10-10 · **Working HEAD:** `2db34f2` (`arena/44e8ce22-handyman-backend`).
**Status:** **FROZEN AS CONTRACT.** No P0 *design* contradiction remains. One **P0 release-sequencing decision is open and reported** (BLK-GAP-1, §8) — it gates the cutover PART (03E), not the foundation PARTs (03B–03D). No certification is claimed by this document.

---

## 1. The problem this addendum exists to solve

Ratified decisions that created it:

| # | Decision | Source |
|---|---|---|
| 2 | No obligation of an internal `users` account for a PIC | W03 PART 02 |
| 3 | **A PIC need not be determined at Customer Care intake** | ratified in A01 v1.1 |
| 4 | **A PIC approver MAY be bound after intake, before the quotation is presented** | ratified in A01 v1.1 |
| 5 | The binding must be authoritative, audited, scoped, and unchangeable after the decision | ratified in A01 v1.1 |
| 6 | No silent change to an immutable request or to historical ledgers | ratified in A01 v1.1 |
| 7 | No staff approval fallback | ratified in A01 v1.1 |
| 8 | Maker-checker fail-closed | ratified in A01 v1.1 |

**F-06 restated.** `handyman_service_requests.tenant_pic_id` is nullable (`0378:40`) and care-assisted intake **cannot** populate it: the care create-exchange body whitelist is exactly `['tenantCompanyId','buildingId','spaceId']` (`care-create-exchange.service.ts:26-31`), and the request inherits the PIC only from the immutable attribution (`handyman-service-request.service.ts:232`). Under A01 v1.0 the ledger coherence rule (`tenant_pic_id IS NOT DISTINCT FROM decided_by_tenant_pic_id`) therefore left **every** care-assisted request with **no eligible approver at all** — while decision 7 closed the staff path. That is a mainline dead end, not an edge case.

**What F-06 is NOT.** It is not a missing column and not an intake defect to be fixed by forcing BM to send a PIC: `resolveHandoffContext` already accepts and validates an optional `tenantPicId` (`handoff-context.service.ts:91-100`), so the *absence* is a business fact of assisted intake — Customer Care legitimately opens work for a tenant before the responsible person is identified. The fix must therefore be a **first-class, later, revocable act of authority**: someone with standing binds a named, verified Tenant PIC to the quotation thread, and that binding — not the request, not a caller — is what makes an approver exist.

## 2. Where the binding lives (scope 4) — thread, decided by existing invariants

| Candidate anchor | Test against existing invariants | Verdict |
|---|---|---|
| `handyman_service_requests.tenant_pic_id` (write it later) | The request's `tenant_pic_id` is a **create-time mirror of the BM-attested provenance**: `channel_attribution_id UUID NOT NULL UNIQUE → handyman_channel_attributions(id)` (`0378:37-38`) and attributions are append-only with an actor no-borrow guard (`0427`). No code path updates the request column today (grep: no `UPDATE handyman_service_requests` sets `tenant_pic_id`). Writing it later would silently rewrite "what BM attested", desync request↔attribution for every existing reader (C6, Operations Queue, SLA), and is exactly the "silent change to an immutable request" decision 6 forbids | **REJECTED** |
| `handyman_quotation_versions` (per presented version) | Versions are immutable after decision (F2, `VERSION_MUTATION=FORBIDDEN_AFTER_DECISION`) and their guard is a **column list** (`0391:79-113`) — an unlisted column is silently mutable, so a new column there needs the guard extended on a table this addendum must not disturb. It would also multiply one authority fact across revisions (each revision re-binding a signer) | **REJECTED** |
| `handyman_quotations` (the thread) | The thread is **1:1 with the request** — `handyman_quotations_request_unique UNIQUE (handyman_request_id)` (`0391`) — so thread-level == request-level reach, without touching the request; it survives revisions; and `0393`'s partial unique index already gives the DB-enforced invariant this design needs: **at most one ISSUED version per thread** (`handyman_quotation_versions_one_issued_idx … WHERE status='ISSUED'`) | **SELECTED** |

**B0 (FROZEN).** The PIC approver binding is anchored on the **quotation thread** (`handyman_quotations.id`), never on the request row and never on a version row. Because the thread is 1:1 with the request, "bound to the thread" is operationally "bound to the request's work" — without mutating intake provenance.

## 3. The binding contract

### 3.1 New table (the only new object this addendum authorizes)

`handyman_quotation_approval_bindings` — append-only, ACTIVE→REVOKED, modelled on the repo's own grant-history idiom (`0432` `handyman_care_actor_permission_grants`), **not** on a mutable column.

| Column | Contract |
|---|---|
| `id` | UUID PK |
| `quotation_id` | `NOT NULL REFERENCES handyman_quotations (id)` — the anchor (B0) |
| `handyman_request_id`, `client_id`, `tenant_company_id`, `building_id`, `space_id` | server-derived **audit snapshot**, each cross-checked against the request row by trigger (never caller-supplied) |
| `tenant_pic_id` | `NOT NULL REFERENCES tenant_pics (id)` — the approver being conferred |
| `binding_version` | `INTEGER NOT NULL`, monotonic per thread, `CHECK (binding_version >= 1)` |
| `supersedes_binding_id` | nullable self-FK — the reassignment chain is explicit, never an overwrite |
| `status` | `CHECK (status IN ('ACTIVE','REVOKED'))`; **no delete lifecycle** |
| `effective_from`, `effective_until` | `effective_from NOT NULL DEFAULT NOW()`, `effective_until` nullable; `CHECK (effective_until IS NULL OR effective_until > effective_from)` |
| `occupancy_authority_id` | `NOT NULL REFERENCES tenant_building_contexts (id)` — **what justified the binding**, snapshotted for audit only; it is never authority at decision time (§3.4) |
| `space_authority_id` | nullable `REFERENCES tenant_space_relationships (id)`; required whenever the request carries a `space_id` |
| `granted_by_user_id` | `NOT NULL REFERENCES users (id)` — a local User act (see §3.3) |
| `granted_at`, `revoked_by_user_id`, `revoked_at` | `CHECK ((status='ACTIVE' AND revoked_by_user_id IS NULL AND revoked_at IS NULL) OR (status='REVOKED' AND revoked_by_user_id IS NOT NULL AND revoked_at >= granted_at))` |

Indexes/constraints:

```sql
CREATE UNIQUE INDEX handyman_quotation_approval_bindings_one_per_version
  ON handyman_quotation_approval_bindings (quotation_id, binding_version);
CREATE UNIQUE INDEX handyman_quotation_approval_bindings_one_active
  ON handyman_quotation_approval_bindings (quotation_id) WHERE status = 'ACTIVE';
CREATE INDEX handyman_quotation_approval_bindings_pic_idx
  ON handyman_quotation_approval_bindings (tenant_pic_id, status);
```

`…_one_active` is the repo idiom for "exactly one live grant" (`0432`, the `tenant_pics` primary index, `tenant_building_contexts_active_unique`). The `…_pic_idx` index exists from birth because W03 PART 01 recorded the opposite lesson for `tenant_pics.user_id` (**P1-B4**: a reverse lookup with no index leading on it) — PIC → bindings is precisely the query the portal read, the revoke flow, and MC1' all need.

Guard trigger (name/shape per convention): refuses `DELETE`, refuses every UPDATE except `ACTIVE → REVOKED`, and on INSERT validates snapshot coherence + lineage-equality (R-1) + "no binding after a decision" (§4). `ERRCODE '23514'`, `$funcname$` quoting, same as `0427`/`0429`/`0430`.

### 3.2 Eligibility of a candidate PIC (all server-side, all fail-closed)

| Rule | Requirement | Existing mechanism reused |
|---|---|---|
| B1 | PIC exists and `status='ACTIVE'` | `tenantPicRepository.findById` (`tenant-pic.repository.ts:47-52`) — the same check `resolveHandoffContext` applies (`handoff-context.service.ts:92-98`) |
| B2 | `pic.tenant_company_id = request.tenant_company_id` (cross-tenant refusal; PART 01 class **R4**) | explicit comparison, idiom precedent `tenant-communication.service.ts:100-121` |
| B3 | **Occupancy**: an `ACTIVE`, currently-effective `tenant_building_contexts` row for `(tenant_company_id, request.building_id)` | the *occupancy half* only of what W03 PART 01 (F-05) identified as the reusable part of `customerRequestReadScope`; **never** `user_building_assignments` |
| B4 | If `request.space_id IS NOT NULL`: an `ACTIVE`, effective `tenant_space_relationships` row for that space | `handyman-service-request.repository.ts:209-227` shape, `FOR SHARE` + `clock_timestamp()` per `care-representation.service.ts:63-86` |
| B5 | Tenant company `status='ACTIVE'`; Client `status='ACTIVE'` | `handoff-context.service.ts` resolution chain |
| B6 | A PIC that is already an ACTIVE binding target on another thread needs **no** dedup — one PIC may hold many thread bindings; the reverse (one ACTIVE binding per thread) is the constraint that matters | `…_one_active` index |
| B7 | **No request-status precondition may be invented.** `0378:71-73` restricts `handyman_service_requests.status` to `INTAKE` alone ("frozen D3": triage/diagnosis are CR-HM-03 scope), so request status cannot serve as a binding gate. The gate is quotation-thread state (B12, B13, B18) | the same reason intake must not be mutated for approval purposes (§2) |

### 3.3 Who may bind, and what binding is not

| Rule | Statement |
|---|---|
| B8 | Binding is written by an **authenticated local User** holding `tenant_company.manage` for the thread's tenant **plus** the exact-Building BE-02G assignment (`assertQuotationThreadBuildingAccess`, `handyman-quotation-access.ts:23-41`) — i.e. the same authority that already creates, prices and issues the thread. **No new permission code** in V1; a dedicated `…:approval-binding:manage` code is recorded as deferred hardening (BLK-BIND-SCOPE) because it must pass the registry gate (`tests/config-perm-01-permission-registry.test.ts`) and the catalogue in a code-bearing PART. |
| B9 | Binding is **not** approval and must not be able to act like it: the binding write path cannot touch `handyman_quotation_decisions` (whose INSERT guard independently refuses every non-`TENANT_PIC` row, A01 §6.2). Selecting the signer is authority *over who consents*, never *that someone consented*. |
| B10 | A **Customer Care workspace principal must not bind** in V1: the binder lands in the maker set (§6), and a non-User binder would require cross-namespace granter equality to be provable — deferred as BLK-CARE-BIND rather than silently widened. |
| B11 | The binding endpoint accepts **no** identity other than `{tenantPicId, effectiveUntil?}`; tenant/building/space/occupancy/client are all derived from the thread. Smuggled keys are structurally ignored, and a caller cannot bind a PIC into a tenant it does not manage (B2 + BE-02G). |

### 3.4 Effectivity, pinning, revoke, reassignment (reconciling decision 4 with "reassignment before decision")

The two ratified requirements collide, so the contract resolves them explicitly:

| Rule | Statement |
|---|---|
| B12 | **Bind-before-present.** `issueHandymanQuotationVersion` (`handyman-quotation-lifecycle.service.ts:85`) must refuse to present a version while the thread has no binding that is `ACTIVE` **and** effective at the presentation instant. This is the enforcement point of decision 4; it lives at issue time, not at decision time, so a tenant is never asked to approve under an unbound thread. |
| B13 | **Pin at presentation.** Once a version is `ISSUED` and undecided, its thread binding is **pinned**: `supersede`/reassignment is refused while any version of the thread is `ISSUED` (`0393`'s one-ISSUED index makes this a cheap, deterministic existence check). Rationale: the presented commercial facts were presented *to* a person; swapping that person mid-presentation would let a binding change decide who was always entitled to see the quote. |
| B14 | **Reassignment is allowed** while the thread has no ISSUED-undecided version — i.e. DRAFT, or after the presented version reached `SUPERSEDED` / `EXPIRED` / `REJECTED`. Reassignment = INSERT `binding_version + 1` + revoke the prior row, one transaction; never an UPDATE in place. |
| B15 | **Revoke is always allowed** — safety outranks the pin. A live PIC revocation, tenant suspension, or occupancy turnover must take effect immediately; if it lands while a version is ISSUED, the consequence is B16. |
| B16 | A revoked/expired binding never authorizes anything: the decision path re-evaluates `status`, `effective_from/until`, B1–B5 **live** at decision time (same per-call discipline as the care workspace). The presented version then has no eligible approver and remains undecided; the only resolution is a new binding + a new revision (`supersede → ISSUED` under the new binding). **Fail-closed, never fall back to a stale snapshot** (decision 8). |
| B17 | `occupancy_authority_id` / `space_authority_id` are **audit evidence of what justified the binding**, not cached authority. Any implementation that reads them instead of re-resolving violates B16. |

## 4. Unchangeable after the decision (decision 5)

| Rule | Statement |
|---|---|
| B18 | Once **any** version of the thread has a row in `handyman_quotation_decisions`, the binding table refuses further writes for that `quotation_id` (INSERT and the revoke-only UPDATE alike). The authorization context of a decided quotation is frozen forever, and the decision row still points at the exact binding row that authorized it — history remains readable. |
| B19 | Rejected/revoked-then-revised flows are unaffected: the *previous* version's decision is what freezes the thread; a thread that was REJECTED is finished by F2/F3 (no new binding needed, and none permitted). |
| B20 | The freeze is enforced in the DB guard, **not** only in the service, so a future writer that forgets the check cannot mutate an authorized-consent context. This is the same argument A01 §6.2 used for the decision ledger. |

## 5. R-1 — the explicit revision of A01's coherence rule

A01 v1.0 froze: `handyman_quotation_decisions.tenant_pic_id IS NOT DISTINCT FROM decided_by_tenant_pic_id`. **Withdrawn and replaced.** The reason is F-06: that rule made the request's lineage PIC the *only* possible source of an approver, which is precisely what decisions 3+4 reject.

Ratified replacement (three rules, same anti-fabrication strength, redistributed):

```
R-1.1  decision.decided_by_tenant_pic_id = binding.tenant_pic_id
       (binding = the row referenced by decision.approval_binding_id)         [trigger]
R-1.2  IF request.tenant_pic_id IS NOT NULL
       THEN binding.tenant_pic_id = request.tenant_pic_id                      [trigger, at binding INSERT]
R-1.3  decision.decision_actor_type = 'TENANT_PIC'
       IMPLIES decision.approval_binding_id IS NOT NULL                        [CHECK]
```

| Concern | v1.0 answer | v1.1 + ADD-A answer |
|---|---|---|
| Can a caller name the approver? | no — lineage only | no — the endpoint accepts a PIC id **for a binding act only**, and only a manager of that exact tenant+Building may create it (B8, B11); the *decision* still accepts no identity at all |
| Can a PIC-less request gain an approver? | **no** (the F-06 dead end) | yes, through an audited, revocable, occupancy-verified binding (B1–B5) |
| Can an *attested* approver be swapped? | not at decision time | **not at all** — R-1.2 refuses a binding that contradicts the BM-attested lineage PIC, and B18 freezes the thread after any decision |
| Is historical semantics rewritten? | n/a | no — `tenant_pic_id` on the decision keeps meaning "request lineage PIC", `decided_by_tenant_pic_id` means "who signed", `approval_binding_id` means "under what authority"; three facts, three columns, none repurposed (decision 6/9) |

**Ledger delta on top of A01 §6.1** (same migration, still additive, still zero-UPDATE):

```sql
ALTER TABLE handyman_quotation_decisions
  ADD COLUMN approval_binding_id UUID REFERENCES handyman_quotation_approval_bindings (id),
  ADD CONSTRAINT handyman_quotation_decisions_binding_check CHECK (
       (decision_actor_type = 'USER'      AND approval_binding_id IS NULL)
    OR (decision_actor_type = 'TENANT_PIC' AND approval_binding_id IS NOT NULL));
```

`handyman_execution_scopes` needs **no** binding column: `quotation_decision_id NOT NULL` (`0395:34-35`) already chains every scope to the decision that carries `approval_binding_id` — one hop, always present, no denormalized copy to drift. A01 E2 (`created_by_tenant_pic_id = decision.decided_by_tenant_pic_id`) stands unchanged.

## 6. Maker-checker finalization (decision 8)

The binding makes the maker set **complete**, which v1.0 could not achieve:

```
M(thread) = { handyman_quotations.created_by_user_id                    (root author)
            ∪ handyman_quotation_versions.created_by_user_id             (version author)
            ∪ handyman_quotation_approval_bindings.granted_by_user_id }  (the person who chose the signer)
C(row)    = { decision.decided_by_tenant_pic_id }
            ∪ { tenant_pics.user_id of that PIC, when NOT NULL }
```

| Rule | Statement |
|---|---|
| **MC1'** | Reject when `M ∩ C ≠ ∅`. Adding the **granter** closes the real loop: a manage-holder could previously "select a signer who is themselves" via a PIC link; now that exact act is the thing being refused, at **both** write points (binding INSERT refuses a granter who equals the PIC's linked user; decision INSERT refuses the same equality — A01 §6.2) |
| **MC2'** | Same double enforcement as v1.0 (service for the error code, DB guard as the floor) |
| **MC3** | Unchanged: reuse `HANDYMAN_QUOTATION_DECISION_CONFLICT` (409); no new enumerable decide error. Binding refusal reuses the existing validation/denial envelope with a non-enumerating 404 for an inaccessible PIC |
| **MC4'** | Fail-closed means: **overlap → refuse; inability to evaluate → refuse** (missing PIC row, missing occupancy row, unresolved tenant). It never means "PIC without a `users` link is unapprovable" — decision 2 stays intact; a NULL link is a *legitimate* state, and it is now guarded by MC1' instead of by MC4's provisioning wish |
| **MC5'** | v1.0's BLK-6 (version issuer is not stored, so `M` is author-based) is **partially cured without touching the immutable versions table**: the granter is stored and is the actor who controls presentation eligibility (B12). Widening `M` with a real `issued_by_user_id` stays optional and is still recorded (BLK-ISSUER) |

## 7. Migration safety, backward compatibility, consumer impact

### 7.1 Safety

| Rule | Statement |
|---|---|
| **M1** | The bindings table is **new** → no immutable-ledger conflict, no backfill, no rewrite of `0378`/`0391`/`0394`/`0395`. Its guard exists from birth (unlike the ledgers, which needed a trigger-timing widening) |
| **M2** | `approval_binding_id` rides in **the same additive migration** as A01 §6.1's columns (one `ALTER`, one `up`, metadata-only constant default/NULL add) so no intermediate state can exist where a `TENANT_PIC` row is legal but unlinked |
| **M3** | `down()` refuses when `EXISTS (SELECT 1 FROM handyman_quotation_decisions WHERE approval_binding_id IS NOT NULL)` **or** any binding row exists; otherwise forward-fix-only (A01 R1–R4 unchanged, and the `0431.down()` asymmetry is still not copied) |
| **M4** | Lock order at every write: **request/quotation/version rows → binding rows → session row → decision insert**, i.e. authority before credential (A01 R7). The binding guard reading a version row is safe because the service already holds `lockVersionById` before the projection (`handyman-quotation-decision.service.ts:155-163`) |
| **M5** | Revocation cascade: `AFTER UPDATE` on `tenant_pics` (non-ACTIVE, tenant re-parent, or `user_id` change) revokes live **PIC sessions** (A01 §5 rule 18) **and** marks live bindings' authority stale by *leaving them ACTIVE* — the binding is a historical fact, not a credential; B16 re-evaluation, not a silent UPDATE, is what kills its effect. Documented explicitly because "revoke everything" would falsify history |
| **M6** | No new UNIQUE/NOT NULL tightening may ride along (A01 R6): BLK-7 (global `idempotency_key`) stays its own measured migration |

### 7.2 Consumers added to A01's C1–C16 list

| # | Site | Required change |
|---|---|---|
| C17 | `handyman-quotation-lifecycle.service.ts:85` `issueHandymanQuotationVersion` | refuse presentation without an active, effective, occupancy-verified binding (B12) — this is where "bind before present" is actually enforceable |
| C18 | same file `:234` `supersedeHandymanQuotationVersion` | supersede is also the recovery path after B16; a new revision inherits the thread and must be presented under the then-active binding |
| C19 | `handyman-quotation-decision.service.ts` (eligibility step, `:189-208`) | resolve + re-verify the binding before insert; snapshot `approval_binding_id`; MC1' evaluate **including the granter** |
| C20 | `handyman-quotation-decision.repository.ts` / `.types.ts` | `approvalBindingId` in select/insert/types; projection exposes it read-only (id only, no names) |
| C21 | new module `handyman-quotation-approval-bindings/` (repository + service + staff routes) | write path per B1–B11, read path `GET /handyman/quotations/:quotationId/approval-binding` (staff, `tenant_company.read`, bounded, IDs only) |
| C22 | `handyman-quotations-api.routes.ts:73-97` | one new POST (bind) + one new POST (revoke) + one new GET (read) on the **staff** surface; the PIC surface (A01 §9) reads the same fact through its own bounded read |
| C23 | `handyman-service-request.repository.ts` / C6 / Operations Queue | **no change** — lineage `tenant_pic_id` semantics untouched, so no read wall, queue projection, or SLA view shifts (decision 6, and the reason `request.tenant_pic_id` must stay create-time-only) |
| C24 | `0396`–`0422` downstream scope consumers | no change (A01 E4 verified: none join `created_by_user_id`); re-run their focused suites as regression evidence in the certification PART |

### 7.3 Compatibility matrix

| Scenario | Result |
|---|---|
| Pre-existing request with a lineage PIC, no binding row | Cannot be presented/decided under the new rule until a binding exists — and R-1.2 forces that binding to name **the same** PIC. One audited row converts them; recorded as BLK-BIND-BACKFILL (**P0 for rollout**, P1 for design: bulk-bind derived rows, or enable B12 per-tenant as the PIC path opens - see §8) |
| Pre-existing request with NULL lineage PIC, before cutover | Unaffected while the staff path is still operative; after cutover, requires a binding (the F-06 remedy working as designed) |
| Historical decision rows (`USER` class) | Readable forever; `approval_binding_id IS NULL` satisfies R-1.3 by the first disjunct; never reinterpreted (A01 A8/A9) |
| Threads already decided | B18 makes them write-proof — the safest possible state at cutover |
| Existing quotation tests (54) | The issue-path change (C17) touches **more** tests than A01 alone: every fixture that issues a version will need a binding. Priced in the sequencing (03C before 03E), not hidden |

## 8. Open decisions carried out of this addendum

| ID | Question | Owner | Blocks |
|---|---|---|---|
| **BLK-GAP-1 (P0)** | Approval continuity at cutover. Between "A01 closes staff approval" and "binding + PIC session ship", care-assisted threads have no approver. Sequence B12–B18 **before** the staff route is closed (03C/03D land before 03E) so there is no standstill — but that leaves a window where staff approval remains operative *by deployment reality*, which decision 7 must explicitly tolerate as a migration window rather than a fallback. Alternative: accept a hard approval standstill until 03E | Product owner + release manager | **03E only** (03B–03D proceed) |
| BLK-CARE-BIND (P1) | May a Customer Care workspace principal bind an approver (B10 defers it)? Needs a care-actor granter in the maker set | Architecture | later hardening |
| BLK-BIND-SCOPE (P1) | Keep binding under `tenant_company.manage` (B8) or split a dedicated code? Residual: a manage-holder selects the signer | Product owner + Security | later hardening |
| BLK-BIND-BACKFILL (P0 for rollout, P1 for design) | Policy for existing threads that must gain a binding row to move (§7.3) — **and the enablement order of B12 itself**: the moment the issue-gate ships, every thread that has no binding can no longer be presented, so B12 must land together with (or after) the backfill policy, or be enabled per-tenant. Turning B12 on globally ahead of the policy is a self-inflicted presentation standstill, not a safety win | Product owner + Operations + release manager | **03B2 ship order** (the table, guard, and routes can land dark; the gate cannot) |
| BLK-ISSUER (P1) | Add `issued_by_user_id` to versions + extend the `0391` guard, or accept author-based `M` (MC5')? | Architecture + CR-HM-06 owner | exit gate of the ledger PART |
| BLK-PIC-SESSION-* | All non-binding blockers from A01 §12 (BLK-2 session authority freeze, BLK-3 staging measurement, BLK-4 route disposition, BLK-7 idempotency scoping, BLK-8 TTL, BLK-9 portal reads) | as listed in A01 | as listed in A01 |

## 9. Explicit non-goals

- No change to `handyman_service_requests`, its attribution, or C6 (decision 6; A01 A7).
- No new decision ledger, no new decision vocabulary, no lifecycle state (decision 9; F3).
- No auto-binding, no default binding, no bulk UPDATE of lineage `tenant_pic_id`, no derived row minted at read time.
- No binding by a PIC of themselves; no self-service "claim to be the approver" surface of any kind.
- No staff approval fallback, and no "emergency approve" flag (decision 7).
- No occupancy/property grant model for PICs (occupancy is their basis; care grants are a different namespace).
- No permission code added by this addendum (registry gate untouched).
- No population claim of any kind: how many threads already carry a lineage PIC (and therefore need a matching binding row before B12 may be switched on), and how many would need a fresh binding, are **UNVERIFIED**. Everything in §7.3 is a schema-logical statement readable from the DDL; the only permitted measurement path is BLK-3's aggregate-only queries (`docs/e2e/W03_PART01_PIC_READINESS_AND_REGISTRY_GUARD.md` §3), extended with a `handyman_quotations` × `handyman_service_requests.tenant_pic_id` count.

## 10. References

- `CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md` v1.1 — amended F6, session contract, ledger design, threat model, R1–R8, PART sequence.
- `CR-HM-06_DECISION_FREEZE.md` — F2/F3/F6(revised)/F7/F8/F9/F10/F11/F12.
- `CR-HM-CARE-WORKSPACE-01_PART01_AUTHORITY_CONTRACT_FREEZE.md` — no parallel masters, per-call re-validation, credential-kind separation.
- `docs/e2e/W03_PART03A_LATE_PIC_BINDING_RATIFICATION.md` — evidence ledger, acceptance criteria, PART sequence, blocker routing for this addendum.
- Migrations: `0374`/`0375`/`0378` (attribution & request lineage), `0391`/`0393` (thread & one-ISSUED), `0394`/`0395` (ledgers), `0425`–`0432` (actor/session/grant idioms), `0145`–`0148` (PIC + occupancy), `0002` (users).
- Modules: `handyman-quotations`, `handyman-quotations-api`, `handyman-care-workspace`, `handyman-handoff`, `handyman-requests`, `tenant-pics`, `context-access`.
