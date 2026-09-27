# CR-HM-04 — FINAL VALIDATION & CERTIFICATION

**Role:** certification only — no feature, route, migration, domain-logic
or refactor changes. Frozen roadmap / capability map / ownership matrix
untouched.

**Base:** `86960459` (PART 05A). **Certified on:** 2026-09-27.

## F1–F10 compliance (START GOVERNANCE frozen 2026-09-27)

| Decision | Verdict | Evidence |
|---|---|---|
| F1 Provider Context → `vendors` | PASS | PART 01: context is a bounded operational projection keyed by vendorId; `vendors` remains authoritative identity, never duplicated/mutated. |
| F2 Worker Context → `workforce_profiles` | PASS | PART 02: context references the master profile; no person fields copied. |
| F3 Work Crew ≠ `teams` | PASS | PART 03: `handyman_work_crews`; `teams` never read/written (scan confirms comment-only mentions). |
| F4 Exactly one valid Lead | PASS | PART 03: append-only `handyman_crew_leads` (BIGSERIAL `lead_seq`, UPDATE/DELETE-blocked); transactional create — no DRAFT. |
| F5 Login-less helper | PASS | Profile `userId` NULL valid as worker/member; never Lead; no shadow person/account. |
| F8 Lifecycle | PASS | `ACTIVE | INACTIVE` only across all four entities; no DRAFT/hidden states; no hard delete (no `DELETE FROM` in CR-HM-04 runtime). |
| F7 Assignment boundary | PASS | PART 04 deferral doc frozen (see §Assignment). |
| F9 Actor/scope | PASS | 05A: actor = authenticated session user only; scope server-derived; smuggle-proof parsers. |
| F10 Audit/history | PASS | Operational events journaled atomically (history-only, never lifecycle authority). |
| F6 (registry discipline firewall, per F9 HM-03 anchor) | PASS | No skill→discipline authority introduced; CR-HM-03 Discipline Registry remains sole authority. |

## 1. Provider authority — PASS

`vendors` = authoritative identity. `handyman_provider_contexts` is a
bounded operational context only: `{id, clientId (server-derived verbatim
vendor snapshot), vendorId, status ACTIVE|INACTIVE, createdByUserId,
timestamps}`. No vendor-master semantic mutation; context ≠ SaaS
customer, ≠ marketplace enablement, ≠ FM workflow.

## 2. Worker authority — PASS

`workforce_profiles` = person authority. Worker context =
Provider Context → Workforce Profile, `ACTIVE|INACTIVE`. Existing
`vendor_workforce_bindings` reused READ-ONLY (`findActiveByVendorAndWorkforce`,
standing-window check). Login-less profile (`userId` NULL) is a valid
helper identity; no shadow person/account anywhere.

## 3. Crew authority — PASS

`handyman_work_crews` is separate from `teams` (never reused); crew
belongs to exactly one ACTIVE provider context (lock-validated).
Membership references Handyman Worker Context (same provider, same
Client, ACTIVE when added). Membership ≠ attendance, ≠ work session, ≠
billable time — no such fields/concepts exist in the surface.

## 4. Lead Worker — PASS

ACTIVE crew has exactly one valid current Lead (MAX `lead_seq` of
append-only history). Lead must be: ACTIVE member + ACTIVE worker
context + same provider/Client + `workforce_profiles.userId` NON-NULL.
Login-less helper rejected at create and designate (400
`HANDYMAN_CREW_LEAD_INVALID`). Lead changes append; old facts
immutable (DB triggers).

## 5. Lifecycle — PASS

All four entities: `ACTIVE ⇄ INACTIVE` only; same-state/unknown
transitions rejected (400). No DRAFT anywhere. History rows (journal,
leads, memberships) never hard-deleted; INACTIVE records remain
historical.

## 6. Skill / discipline firewall — PASS

`skills`, `workforce_skill_assignments`, `vendor_capabilities` remain
informational-only and unreferenced by CR-HM-04 runtime (scan: zero
usage beyond migration-registry entries predating CR-HM-04). No
skill→discipline authority introduced; CR-HM-03 F9 Discipline Registry
remains authoritative.

## 7. Assignment boundary — PASS

- NO assignment runtime / table / service / API anywhere.
- NO invented Handyman job/work-order; NO FM work-order reuse.
- CR-HM-03 referral does not auto-assign (frozen in code comments +
  F7 contract).
- PART 04 boundary document preserved verbatim
  (`CR-HM-04_PART04_ASSIGNMENT_BOUNDARY.md`).
- Earliest target owner remains documented as **CR-HM-06** (roadmap
  wording-derived only: *"approval creates authorized execution scope"*).
- Not implemented — deliberately deferred.

## 8. Actor / context — PASS

Mutations use the authenticated local user (`req.auth.userId` / service
`actorUserId`). Actor is NEVER derived from vendor PIC, workforce
profile, tenantPic, channel attribution, or BM identity. Client/provider
scope is server-authoritative (derived from referenced authority rows;
accessible-Client re-checked per call).

## 9. Audit / atomicity — PASS

Material changes journaled: provider-context created/status, worker
created/status, crew created/status, member added/status,
lead designated/change. Every invariant-changing mutation commits record
projection + journal in ONE `withTransaction` (12 transactional paths
across 3 services; scan confirms). Failed leaves never pollute journal
(atomicity tests). Journal is history-only, never lifecycle authority.

## 10. HTTP / OpenAPI — PASS

Actual surface = **exactly 12 operations across 7 paths**:

| Path | Ops |
|---|---|
| `/handyman/provider-contexts` | POST create |
| `/handyman/provider-contexts/by-vendor/{vendorId}` | GET exact read |
| `/handyman/provider-contexts/{providerContextId}/status` | POST |
| `/handyman/worker-contexts` | POST create |
| `/handyman/worker-contexts/{workerContextId}` | GET exact read |
| `/handyman/worker-contexts/{workerContextId}/status` | POST |
| `/handyman/work-crews` | POST create-with-Lead |
| `/handyman/work-crews/{crewId}` | GET exact read |
| `/handyman/work-crews/{crewId}/status` | POST |
| `/handyman/work-crews/{crewId}/members` | POST add |
| `/handyman/work-crews/{crewId}/lead` | POST designate/change |
| `/handyman/crew-memberships/{membershipId}/status` | POST |

GETs gated by `tenant_company.read`; mutations by
`tenant_company.manage` (closest existing Handyman convention). NO
assignment endpoint. Runtime/OpenAPI parity PASS (test 10, YAML
parse-verified). No list/search/dashboard APIs invented.

## 11. FM firewall — PASS

No FM provider workflow/process adopted; no FM work-order provider
assignment; Handyman surface is self-owned end to end.

## 12. Artefact check — PASS

Scan of ONLY the CR-HM-04 changed source/docs/tests for
`environmental-action plan` / `416 bpp` (and fragments): **ZERO
occurrences**.

## Migrations

- `0384_create_handyman_provider_contexts.ts`
- `0385_create_handyman_worker_contexts.ts`
- `0386_create_handyman_work_crews.ts`

Minimal, additive-only, registered in order; no existing table touched.

## Focused validation result

Suites run (ONLY these; no full suite, no project-wide typecheck/build):

- `tests/handyman-provider-context.test.ts` — 10/10
- `tests/handyman-worker-context.test.ts` — 10/10
- `tests/handyman-work-crew.test.ts` — 10/10
- `tests/handyman-provider-api.test.ts` — 10/10

**Total: 40/40 PASS (4 suites).** OpenAPI YAML parse PASS.
`git diff --check` PASS.

## Defects

**None** found during certification review.

## Final status

All gates PASS → **CR-HM-04: COMPLETE.**

Next in frozen roadmap: CR-HM-05 (Scheduling, Permit & Unit Access) —
NOT started. Crew-assignment runtime remains deferred until the
authoritative CR-HM-06 target exists (PART 04 boundary doc governs).

---

*Commit chain: START `e39a0bea` → FREEZE `e6852e4` → PART 01 `f356d8e`
→ PART 02 `bf7cfab` → PART 03 `0cdfcda` → PART 04 `cd9b8c0` → PART 05A
`8696045` → this certification.*
