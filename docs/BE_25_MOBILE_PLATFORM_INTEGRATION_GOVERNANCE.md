# BE-25 — Mobile Platform Integration (START GOVERNANCE)

> **Status:** START GOVERNANCE — documentation only. No BE-25 API, contract,
> migration, permission, route, or business-logic change is implemented by
> this step.
> **Baseline:** `main` / Arena branch `arena/01a00f7e-asentra-backend` at
> `1a30f76d98c87d1309b8bba92bede41c8607f6f1` (merged PR #27 = BE-24
> implementation), on top of the merged CR-BE-API-01 baseline (PR #26) and the
> merged BE-23 baseline (PR #25).
> **Date:** 2026-08-17
> **Consumer constraint:** Flutter stays in `asentra-mobile`. This repository
> contains no mobile code; nothing mobile-side is modified by BE-25.

## 1. Frozen boundary

BE-25 provides **mobile API contracts only**:

- Backend exposes/stabilizes the REST contracts the mobile client consumes.
- No rebuild of Task, Checklist, Evidence, Finding, or Verification engines.
- No duplication of existing domain logic; mobile renders backend-authoritative
  `availableActions`.
- Existing Web API behavior is preserved (no route-path or response-shape
  changes to surfaces Web already consumes).
- Contracts must be suitable for offline/mobile operation (bounded payloads,
  stable codes, retry-friendly writes).
- `asentra-mobile` is not modified.

## 2. Current baseline (verified)

| Item | State |
|---|---|
| Repository | Node.js 20 + TypeScript (strict) + PostgreSQL; 235 migrations; ~250 modules |
| Routes | **1,023** route registrations in `src/modules/**/*.routes.ts` |
| Envelope | Uniform `{success, data, meta}` / `{success, error:{code,message,details?}}` via `sendSuccess`/`sendError`; `X-Request-ID` on every response (client-supplied id accepted when it matches `^[A-Za-z0-9._-]{1,128}$`) |
| Error contract | `ERROR_CODES` map in `src/shared/errors.ts` (~1,600 lines, **803 named codes**) |
| OpenAPI | `docs/api/openapi.yaml` exists (CR-BE-API-01 PART 01 + PART 03 + BE-24): **26 paths, 97 schemas** (plus shared parameters/responses) — health, auth, `/auth/me/buildings`, `/reports/export`, `/management/*` (16), `/evidence/{evidenceId}/file` (+`/content`). The other ~997 registered routes are still undocumented (incremental rule in the spec header) |
| Data isolation | BE-02G enforced; CR-BE-API-01 PART 02 merged — BE-07-era lists (tasks, checklist-executions, evidence, reviews, operational-events, …) now client-scoped via `contextAccessService`; work orders building-nested via `requireBuildingAccess` |
| Permissions | PART 04 merged — dedicated `checklist.*`, `task.*`, `evidence.*`, `review.*`, `schedule.*` codes; `form_template.*` no longer gates execution surfaces |
| Evidence files | CR-BE-API-01 PART 03 merged — storage abstraction (`local` driver; cloud-ready interface), `POST/GET /evidence/:evidenceId/file`, `GET …/file/content`, 50 MB cap, MIME gating per `evidence_type`, OpenAPI documented |
| Read models | BE-24 management surfaces merged (`/management/*`, `/reports/export` extension) |
| Auth / context | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`; `/auth/me` = user + roles + permissions + `context.clients→properties→buildings` + entitlements; `GET /auth/me/buildings` |

## 3. Reusable foundations (verified, not modified)

### Authentication / effective context (BE-25B)
- `src/modules/auth/*` — login/session/logout, `authenticationMiddleware`,
  `requirePermission` (default-deny RBAC).
- `effective-context.service|types` — `/auth/me` is the single authoritative
  context; invariant: permissions reported = permissions enforced; buildings =
  BE-02G accessible set; entitlements = BE-02C resolver.
- `context-access` — `getAccessibleBuildingIds` / `getAccessibleClientIds` /
  `assertBuildingAccess` / `requireBuildingAccess` (BE-02G). **Already applied**
  to the BE-07-era modules that BE-25 touches.

### Task / Assignment / Checklist / Evidence (BE-07 + CR)
- `tasks` — generate/list/get; scoped lists; `generated_tasks` carries
  `building_id`.
- `task-assignments` — assign/list/by-workforce/by-team (scoped);
  `GET /workforce/:workforceId/tasks`, `GET /teams/:teamId/tasks`.
- `task-execution` — start/complete/cancel with assignee check (WORKFORCE
  assignee must be the calling user via `workforce_profiles.user_id`).
- `checklist-templates` + `checklist-executions` — create/start/responses/
  save/complete/cancel; client-scoped lists; dedicated `checklist.*` permissions.
- `evidence` + `evidence-requirements` — scoped submission metadata
  (`file_reference` becomes the backend storage key after upload);
  `evidence-file.routes` (upload/metadata/download); `storage/` abstraction.
- `reviews` — shared review primitive (targets `FORM_INSTANCE` /
  `CHECKLIST_EXECUTION`; decisions in `review.types`).

### Work Order (BE-08)
- `work-orders` (building-nested list/get, status), `work-order-assignments`
  (`/assignments/current`), `work-order-actions` (ack/start/hold/resume/notes/
  cancel + action history), `work-order-evidence`, `work-order-verification`
  (submit/get/close), `work-order-history`.

### Finding / Verification / available_actions (BE-09)
- `findings` — `GET /findings/:id/available-actions` + `GET|PATCH
  /findings/:id/state` via `finding-action.service`/`finding-action.authority`
  (deterministic backend-authoritative action resolution — the pattern BE-25
  must reuse, not reinvent).
- `finding-assignments` (`/assignments/current`), `finding-reviews`
  (`/findings/:id/verification` submit/get), `finding-rework`, `finding-closure`,
  `finding-history`, `finding-escalations`.
- `permit-approvals`, `procurement-approvals`, `tenant-approvals`,
  `tenant-complaints`, `tenant-service-requests`, `tenant-utility-requests` —
  all expose `GET …/:id/available-actions`.

### QR / identifier foundations (BE-25F)
- `asset-identifiers` — `GET /assets/resolve/:identifier` (QR-ready three-segment
  literal route).
- `contractor-contexts` — `POST /contractor-contexts/resolve`,
  `GET /contractor-contexts/permit-eligibility`.
- `structure-context` / `buildings` — `GET /buildings/:buildingId/hierarchy`;
  `GET /auth/me/buildings` for the user's scoped building list.

### Evidence File API (CR-BE-API-01)
- Fully merged and OpenAPI-documented (§2). BE-25E consumes it; no new storage
  engine.

### RBAC / Client / Building isolation
- `rbac.middleware` default-deny; `requireBuildingAccess('buildingId')`;
  client-set scoping for tables that only carry `client_id`
  (`checklist_executions`, `form_instances`, `evidence_submissions`,
  `evidence_requirements`, `reviews`).

### OpenAPI contract (CR-BE-API-01 PART 01)
- `docs/api/openapi.yaml` — bearer scheme, shared envelopes, incremental
  extension rule; the vehicle for BE-25A coverage extension.

## 4. Contract-gap assessment per PART (BE-25A–N)

| PART | Reusable now | Missing mobile-specific contract | Assessment |
|---|---|---|---|
| **A — Mobile API Contract Stabilization** | Envelope, `ERROR_CODES`, OpenAPI foundation, incremental rule | ~997 routes undocumented in OpenAPI; **no pagination contract** (only `audit`, `asset-history`, `workforce-reporting` populate `meta`); write-response shapes vary (`data: {}` vs resource) | Gap: extend OpenAPI for the mobile surface, freeze pagination + write-response conventions. Heavy on documentation, light on engine logic |
| **B — Mobile Effective Context** | `/auth/me` (user/roles/permissions/clients→properties→buildings/entitlements) | Org/Department/Team/Position + operational data scope deferred (documented); **no workforce-profile resolution for the authenticated user** — mobile workers must know `workforceProfileId` to call `/workforce/:id/tasks` | Gap: add a safe `workforceProfileId`/assignment resolution to the context (or a resolve endpoint). No engine rebuild |
| **C — Mobile Assignment Contract** | Per-domain assignee endpoints: `/workforce/:workforceId/tasks`, `/teams/:teamId/tasks`, `/work-orders/:id/assignments/current`, `/findings/:id/assignments/current`, housekeeping daily-cleaning | **No unified "my assignments" feed keyed to the authenticated user** (checkpoint G05); no pagination on any feed; no cross-domain discriminated envelope | Gap: new read-model feed. **Heavy — see §6 split** |
| **D — Checklist Mobile Contract** | Execution flow (create/start/save/complete/cancel), scoped lists, `checklist.*` permissions, review primitive | **No assignment binding** on `checklist_executions` (client-scoped only; no assignee/user column — migration 0070); no `available-actions` read model; generic `BAD_REQUEST` codes ("Only draft executions can start.") | Gap: assignment binding (schema extension) + available-actions + code alignment. Medium |
| **E — Evidence Upload Contract** | Full file API + storage abstraction + OpenAPI; submission metadata contract | Upload is a two-step flow (submit metadata → attach bytes); no offline capture/queue contract (mobile-side), no retry guidance | Gap: near zero backend work; contract/sequencing documentation + optional `capturedAt`/device fields. Light |
| **F — QR Resolution** | `GET /assets/resolve/:identifier`, `POST /contractor-contexts/resolve`, `/buildings/:buildingId/hierarchy`, `/auth/me/buildings` | No generic QR payload contract (identifier types beyond asset/contractor), no room/floor/space QR resolution surface | Gap: contract-only composition. Light |
| **G — Offline Sync Contract** | Timestamps (`created_at/updated_at`, `captured_at`), scoped `operational-events` read feed, `X-Request-ID` correlation | **Nothing sync-specific exists** (by design, checkpoint G08): no cursor/watermark/since-params, no delta/batch envelope, no sync metadata, no change feed contract | Gap: new contract surface. **Heaviest part — see §6 split** |
| **H — Idempotency** | Client `X-Request-ID` already flows through middleware (validated, logged); incidental idempotency (task generation `ON CONFLICT DO NOTHING`, patrol start returns existing view, CA due-date replacement) | No idempotency-key contract: no dedupe table, no `Idempotency-Key` handling, no replay semantics, no dedicated error code | Gap: small new mechanism (header + dedupe + response replay). Light |
| **I — Conflict Handling** | Status guards in task/checklist execution; BE-09 state machine; `updated_at` columns | No optimistic-locking precondition (`If-Match`/version), no generic 409 `CONFLICT` code (only domain-specific `*_CONFLICT` and `*_ALREADY_EXISTS` variants), last-write-wins elsewhere | Gap: precondition contract + conflict codes. Light–medium; pairs with H/K |
| **J — Supervisor Verification Contract** | `reviews` primitive; `work-order-verification` (submit/get/close); `finding-review` + `/findings/:id/verification`; `corrective-action-verification`; `vendor-verification`; `supervisor-inspections`; `utility-verification` | **No `available-actions` on work orders, corrective actions, vendor work** (checkpoint G07 — clients must infer transitions); no unified supervisor queue (BE-24 pending-approvals covers management, not mobile supervisor) | Gap: add available-actions projections reusing BE-09-style authority pattern; compose, don't rebuild. Medium |
| **K — Mobile Error Contract** | `ERROR_CODES` (500+), envelope, sanitized handler | BE-07-era surfaces raise generic `BAD_REQUEST`/`NOT_FOUND` (tasks, checklist-executions, evidence, reviews); 23505 unique-violations translated inconsistently; no offline/network/retry error taxonomy | Gap: code alignment on execution surfaces + mobile-facing retry/offline error contract. Light–medium |
| **L — Push Token Registration** | Auth/session infrastructure, `ERROR_CODES`, migrations | **Nothing exists**: no device/push table, no `POST /devices` or token endpoint, no TTL/rotation contract | Gap: clean slate — small table + endpoint. Light |
| **M — App Version Metadata** | Config/env conventions | **Nothing exists**: no app-version registry, no min-supported-version contract, no force-update semantics | Gap: clean slate — small table + endpoint. Light |
| **N — Mobile Observability** | `requestIdMiddleware`/`requestLogger`, `GET /auth/audit-events`, scoped `operational-events` feed, audit module | No client/device telemetry endpoint, no app-level event reporting, no device context captured; audit is auth-only | Gap: decide reuse of `operational-events` vs a thin client-telemetry surface. Light |

## 5. Offline / idempotency readiness

- **Ready:** envelope stability, named error codes, client-scoped reads
  (safe offline caching per accessible building/client), `capturedAt` on
  evidence, backend-generated storage keys, `X-Request-ID` plumbing that can be
  promoted to an idempotency key, `operational-events` as a scoped event feed
  candidate.
- **Not ready (by design, checkpoint G08):** sync cursors/watermarks, delta
  queries (`since`/`updatedSince`), batch write envelope, dedupe/replay store,
  optimistic concurrency preconditions, conflict codes. BE-25G/H/I introduce
  these as **new contracts only** — no operational engine is rebuilt.

## 6. Small-part execution approach

Recommended order (each part = contract + minimal backend surface, no engine
changes):

```text
A (contract stabilization + OpenAPI mobile surface + pagination conventions)
├─ B (effective context: workforce-profile resolution)
├─ K (error contract alignment) ─┐
├─ E (evidence upload contract) ├─ H (idempotency) → I (conflict handling)
├─ F (QR resolution contract)   │
├─ L (push token) ──────────────┤
├─ M (app version metadata) ────┘
├─ C (assignment feed)   ← split (below)
├─ D (checklist contract) ← split (below)
├─ J (supervisor verification)
└─ N (mobile observability)
```

**Parts that should be split because they are too heavy:**

1. **BE-25C (Assignment Contract) → C1 + C2.**
   A unified "my assignments" feed spans Task, Checklist, Work Order, Finding,
   and Housekeeping domains with different ownership models (assignee_type
   WORKFORCE/TEAM vs work-order assignments vs finding assignments). One part
   would touch 5+ modules and need a discriminated union + pagination.
   - C1: feed contract foundation + Task/Checklist/Work-Order core (the
     highest-volume mobile worker surfaces).
   - C2: Finding, Housekeeping (and, if required, Security/Patrol) extension
     rows.
   Alternative (lighter): keep C as the **feed contract** only, with per-domain
   backend endpoints composed into the unified envelope — but the cross-domain
   aggregation still warrants C1/C2.

2. **BE-25G (Offline Sync Contract) → G1 + G2.**
   This is the heaviest part: sync requires a cursor/watermark contract, a
   delta-read convention across scoped lists, a batch envelope, sync-metadata
   (lastSyncedAt, per-scope cursors), and retry/ordering semantics.
   - G1: sync contract foundation — cursor/`since` conventions, delta envelope,
     sync metadata endpoint, scoped change feed (reusing `operational-events`).
   - G2: per-domain delta coverage and sync lifecycle semantics (batch
     boundaries, tombstone handling, ordering rules).
   G1 alone is a complete deliverable; G2 depends on G1 and on C (feed) and H
   (idempotent writes).

3. **BE-25D (Checklist Mobile Contract) → D1 + D2 (recommended, optional).**
   D is medium-sized, not heavy, but contains two separable concerns:
   - D1: assignment binding (schema extension on `checklist_executions` or a
     binding table) + scoped execution lists keyed to the assignee.
   - D2: checklist `available-actions` read model + domain error codes (reuses
     the BE-09 action-authority pattern).
   Splitting keeps each change reviewable; D can also stay whole if the part is
   strictly frozen to the execution surface.

4. **BE-25A stays as defined** (contract stabilization is documentation-heavy
   but not engine-heavy). **BE-25B, E, F, H, I, J, K, L, M, N stay as defined.**
   J is medium and should be frozen to *additive available-actions projections +
   composition* (no verification-engine changes); if it grows beyond that, split
   J1 (work order + corrective action + vendor work actions) / J2 (supervisor
   queue composition).

## 7. Blockers

| ID | Blocker | Impact | Status |
|---|---|---|---|
| B1 | OpenAPI covers 26 of 1,023 routes; mobile surfaces (tasks, checklist, work orders, findings, QR resolve) undocumented | BE-25A must extend the spec before mobile codegen/validation; hand-authored YAML drift risk | Managed risk (same R1 mitigation as CR-BE-API-01: incremental spec, FINAL REVIEW diff, no codegen dependency) |
| B2 | No workforce-profile resolution for the authenticated user in `/auth/me` | BE-25C feed cannot be keyed to the user without either a context addition (B) or a resolve endpoint | Managed — B owns the small addition; no engine change |
| B3 | `checklist_executions` has no assignment/assignee dimension | BE-25D assignment binding requires a schema migration (extension of an operational table, not a rebuild) | Managed — additive migration; existing execution rows unaffected |
| B4 | Generic `BAD_REQUEST` codes on BE-07-era execution surfaces | BE-25K error contract and mobile branching need stable domain codes | Managed — code alignment only; no logic change (rule: do not rebuild engines) |
| B5 | No pagination meta on mobile-facing lists | Unbounded payloads on mobile networks (checkpoint §8.6) | Managed — BE-25A freezes limit/offset/page/total conventions; applied to mobile surfaces only to preserve Web behavior |
| B6 | No idempotency-key, no 409 conflict code, no sync cursors | BE-25H/I/G are greenfield contract additions | Not blockers — they are the parts' deliverables |
| B7 | Work Order / Corrective Action / Vendor Work lack `available-actions` (G07) | Mobile would infer workflow transitions, violating governance | Managed — BE-25J adds additive projections reusing the BE-09 authority pattern; no engine changes |

**Hard blockers: none.** All constraints are managed and isolated to named parts.

## 8. Can BE-25A–N remain as currently defined?

| PART | Keep as defined | Note |
|---|---|---|
| A | ✅ YES | Documentation/convention heavy; extend OpenAPI mobile surface |
| B | ✅ YES | Small addition: workforce-profile resolution in effective context |
| C | ⚠️ SPLIT → C1 + C2 | Cross-domain unified feed is too heavy for one part |
| D | ⚠️ SPLIT → D1 + D2 (recommended) | Assignment binding vs available-actions/codes are separable; keepable whole if frozen |
| E | ✅ YES | Mostly reuse of CR-BE-API-01 PART 03 |
| F | ✅ YES | Contract-only composition of existing resolvers |
| G | ⚠️ SPLIT → G1 + G2 | Heaviest part; foundation vs domain coverage |
| H | ✅ YES | Small: idempotency-key + dedupe + replay |
| I | ✅ YES | Small–medium: preconditions + 409 codes; pairs with H/K |
| J | ✅ YES (freeze to additive projections) | Verification authorities already exist; only actions + composition missing |
| K | ✅ YES | Code alignment + mobile error taxonomy |
| L | ✅ YES | Greenfield but small |
| M | ✅ YES | Greenfield but small |
| N | ✅ YES | Decide reuse of operational-events vs thin telemetry surface |

## 9. Readiness

- Baseline confirmed (`1a30f76`, PR #27; CR-BE-API-01 P1–P4 and BE-24 merged and
  preserved).
- Reusable foundations enumerated (§3); gaps mapped per PART (§4); splits
  recommended (§6); blockers assessed (§7) — none hard.
- **Ready for BE-25A: YES — PART A only.** Start with Mobile API Contract
  Stabilization (OpenAPI mobile-surface coverage + pagination/write-response
  conventions + mobile error taxonomy foundation), reusing CR-BE-API-01 PART 01
  conventions. Do not start C/G before A/B/K groundwork.

## 10. What was NOT done (per instructions)

- No BE-25A implementation; no business logic modified; no routes, migrations,
  seeds, or tests changed.
- No full repository test run, no migration, no build, no server started.
- No BE-26 work started. No change to `asentra-mobile` (not present in this
  repository). No PR created, no merge.
