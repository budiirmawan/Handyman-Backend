# CR-HM-02 — FINAL VALIDATION & CERTIFICATION

**Handyman Service Catalogue + Customer Request Intake (Backend)**
Certified complete on 2026-09-27 against the frozen governance
`docs/handyman/CR-HM-02_START_GOVERNANCE.md` (start `2a62630`, design
freeze `8a5248e`; decisions D1–D4 frozen before PART 01 and NEVER modified
since — verified `git log bee43e1..HEAD` over the frozen artifacts).

## Delivery chain

| PART | Commit | Scope |
|---|---|---|
| 01 | `bee43e1` | Handyman Service Variant foundation on the `service_catalog` master |
| 02 | `ec9137c` | Common Material Reference Profiles + read-time reference price |
| 03 | `b9c933d` | Attribution-bound Handyman request intake (INTAKE only) |
| 04 | `b496803d01b71e1a446b5e58778c846b216636d2` | Bounded PHOTO/VIDEO request-intake evidence |
| 05A | `663a9083e2a17db994417d32ba3618d39d146413` | Customer-facing HTTP + OpenAPI surface |

## Migrations (minimum, bounded — no unrelated table touched)

- `0376_create_handyman_service_variants.ts` — Handyman-owned variant child of
  the service master (composite scope-FK, per-service unique code).
- `0377_create_handyman_common_material_profiles.ts` — metadata-only common
  material reference profiles (two partial uniques; no price persisted).
- `0378_create_handyman_service_requests.ts` — sibling Handyman request
  entity (attribution snapshot `NOT NULL UNIQUE`; status CHECK `INTAKE` only).
- `0379_admit_handyman_request_evidence.ts` — parent admission
  `HANDYMAN_REQUEST` into `evidence_submission_execution`; type admission
  `VIDEO` into `evidence_type` (down restores the exact original lists).

## Focused tests — 41/41 PASS

| Suite | Tests | Result |
|---|---|---|
| PART 01 `tests/handyman-service-variants.test.ts` | 6 | PASS |
| PART 02 `tests/handyman-common-material-profiles.test.ts` | 8 | PASS |
| PART 03 `tests/handyman-service-requests.test.ts` | 8 | PASS |
| PART 04 `tests/handyman-request-evidence.test.ts` | 8 | PASS |
| PART 05A `tests/handyman-api.test.ts` (10 + admission regression) | 11 | PASS |

Focused OpenAPI parse: valid YAML (repo `yaml` parser); exactly the six
`/handyman/*` paths with method/security parity (proven by PART 05A test 10
and re-parsed at certification). `git diff --check`: clean.

## Frozen decisions D1–D4 — status

- **D1 — Catalogue/material media:** SATISFIED. Existing storage
  abstraction/file-security pattern reused; catalogue/material media remains
  master-data media, NOT operational Evidence. Media exposure was NOT
  implemented (bounded seam deferred; PART 04 test 8 proves zero
  catalogue/material mutation, and no media column was added to any master).
- **D2 — Video intake evidence:** SATISFIED. VIDEO is a bounded Handyman
  intake capability: explicit MIME allowlist (`video/mp4`, `video/quicktime`,
  `video/webm`), shared 50 MB size policy, engine-default retention, existing
  storage/integrity (server-side SHA-256 of exact stored bytes). No global
  EvidenceType semantic expansion — admission registered DB-side, but bound
  application-side to the `HANDYMAN_REQUEST` parent only.
- **D3 — Handyman request storage:** SATISFIED. Sibling Handyman-owned
  request entity (`handyman_service_requests`) with its own INTAKE-only
  lifecycle; no reuse of `tenant_service_requests` FM states; PART 03 test 8
  proves zero `tenant_service_requests` rows; no FM conversion workflow.
- **D4 — Customer catalogue surface:** SATISFIED. Bounded READ-ONLY surface
  (HTTP verbs enforced; 10 mutation attempts → 404); masters remain reusable
  read references only; no customer master CRUD; context is
  server-authoritative (accessible-Client scope).

## Authority / boundary invariants (all verified by the focused tests)

| Invariant | Proof |
|---|---|
| `service_catalog` remains service master | PART 01 refs master only; PART 03 ACTIVE gate on master |
| Variants remain child records | Composite scope-FK; `(service, code)` unique; PART 01 t4 |
| `inventory_items` remains material master | Profile references item only (PART 02 t1/t4/t6) |
| Common-material profile → no inventory mutation | PART 02 t8; profile is metadata-only |
| Reference price composed, never persisted | PART 02 t8 (no column; read-time lookup) |
| Reference Price != Quotation != Final Charge | Fail-closed `null` lanes (PART 02 t8, PART 05A t2); documented in OpenAPI |
| Handyman lifecycle separate from FM | PART 03 t8 (zero FM rows); sibling entity per D3 |
| Request context derives from CR-HM-01 attribution | PART 03 t2/t3; PART 05A t4/t5 (smuggled keys ignored) |
| `tenant_service_requests` unaffected | PART 03 t8 |
| No quotation by request intake | Create returns INTAKE only; no quotation surface exists |
| PHOTO + bounded VIDEO intake works | PART 04 t1–t3; PART 05A t6–t7 |
| VIDEO does not weaken non-Handyman evidence | PART 05A t11 (VIDEO refused by generic engine; PHOTO still 201) |
| Evidence does not mutate request context/status | PART 04 t7 (row deep-equal) |
| Catalogue media remains separate/unimplemented | PART 04 t8; PART 05A t3 |
| Customer catalogue is read-only | PART 05A t3; OpenAPI has GET-only catalogue |
| No FM workflow | No triage/diagnosis/escalation/conversion route or state |
| HTTP/OpenAPI parity | PART 05A t10 |
| D1–D4 | Table above |

## HTTP / OpenAPI surface (Bearer session; mounted at `/api/v1`)

| Route | Method(s) | Permission | Authority |
|---|---|---|---|
| `/handyman/catalogue/services` | GET | `tenant_company.read` | Client query access-checked; no-leak empty for foreign Client |
| `/handyman/catalogue/material-profiles` | GET | `tenant_company.read` | `clientId` + optional service/variant refinement |
| `/handyman/catalogue/material-profiles/:profileId` | GET | `tenant_company.read` | Profile + read-time reference price |
| `/handyman/requests` | POST | `tenant_company.manage` | Attribution-derived context; INTAKE; one-per-attribution 409 |
| `/handyman/requests/:handymanRequestId/intake-evidence` | GET | `tenant_company.read` | Request-derived client scope |
| `/handyman/requests/:handymanRequestId/intake-evidence` | POST | `tenant_company.manage` | Multipart `file` + `evidenceKind`; PHOTO/VIDEO policy; 50 MB |

`docs/api/openapi.yaml`: +5 paths, +8 schemas documenting exactly this
surface (PHOTO/VIDEO MIME allowlists, shared 50 MB limit, reference-price
semantics, server-side context authority). No lifecycle/triage/quotation/
cancel/destructive verb exists anywhere under `/handyman`.

## Pre-existing / unrelated debt (not introduced by CR-HM-02)

- Migration `0369` rollback check fails in the pre-existing test harness
  (unrelated to Handyman migrations).
- ~23 pre-existing typecheck errors elsewhere in the repo (out of scope for
  these PARTs; no project-wide typecheck/build was run by mandate).

Nothing Handyman-related remains open. Out-of-scope-by-design items
(evidence stages/QC/BAST vocabulary, catalogue media exposure, request
lifecycle beyond INTAKE) are explicitly deferred to later CRs per frozen
roadmap (notably CR-HM-10 for evidence authority/lifecycle closure).

## Verdict

**CR-HM-02 = COMPLETE.** All frozen decisions D1–D4 satisfied; all boundary
invariants hold; 41/41 focused tests pass; runtime and test trees unchanged
by this certification (documentation-only commit); frozen capability map /
ownership matrix / roadmap / governance docs verified byte-identical since
before PART 01.
