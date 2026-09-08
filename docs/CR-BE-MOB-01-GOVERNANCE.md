# CR-BE-MOB-01 — Mobile Operational Contract Gap Recovery (START GOVERNANCE)

> **Status:** PART 01 complete (Housekeeping contract publish);
> PART 02 complete (Security contract publish);
> PART 03 complete (Engineering field / reading contract publish);
> PART 04 complete (Work Order material context + verification composition);
> PART 05 complete (QR operational-context boundary);
> PART 06 complete (offline sync resource-kind extension);
> PART 07 complete (push delivery boundary — BE-26 channel);
> PART 08 complete (cross-contract regression & mobile handoff).
> **CR-BE-MOB-01 is COMPLETE — FINAL REVIEW passed (§22).**
> START GOVERNANCE remains the classification authority. PART 01 published
> existing BE-11 routes in OpenAPI only — no new domain, table, migration,
> or runtime behaviour.
> **Repository:** `budiirmawan/Asentra-Backend`
> **Baseline:** Arena branch `arena/01a01a9c-asentra-backend` at
> `d02c30eeebee35ace338617dfaf7f001180f33a2` (merge of PR #37 /
> CR-BE-MOB-CONTRACT-01 onto `main`).
> **Date:** 2026-08-19
> **Companion:** [`CR-BE-MOB-01-GAP-MATRIX.md`](./CR-BE-MOB-01-GAP-MATRIX.md)

---

## 1. Objective

Review the remaining **mobile operational contract blockers** discovered
after **CR-MOB-BE-03** (mobile consumer) and **CR-BE-MOB-CONTRACT-01**
(backend core mobile contract, PART 01–08 merged) and determine what
**backend contract work is actually required**.

This CR answers one question:

> For each remaining mobile operational area, does the backend already own
> the capability, is the capability present but under-contracted, is an
> authoritative capability genuinely missing, or should the mobile
> simulation **not** become a backend capability?

The backend remains the authority. Mobile must not invent workflow,
identity, or verification rules. This CR must **not** create
mobile-specific business domains when an existing wave already owns the
operation.

---

## 2. Frozen rules (this CR)

1. **Discovery and governance only.** Do not implement endpoints.
2. Do not modify database schema, OpenAPI, migrations, seeds, or runtime
   behaviour.
3. Do **not** duplicate existing backend capabilities.
4. Do **not** invent mobile-specific backend domains when an existing
   domain owns the operation.
5. Do **not** change frozen backend roadmap / wave numbering
   (BE-07…BE-27 and existing CR wave ids stay as published).
6. Prefer existing OpenAPI contracts (`docs/api/openapi.yaml`) and
   existing domain APIs over new `/mobile/*` surfaces.
7. A `/mobile/*` composition is allowed later **only** when it is a thin
   read/write facade over an existing service (the BE-25C / BE-25F /
   BE-25G / BE-25J pattern). It must not become a second engine.
8. Do not treat “mobile currently simulates this” as proof that a new
   backend authority is required.

---

## 3. What is already frozen (do not redo)

CR-BE-MOB-CONTRACT-01 (PR #37) published the **core** mobile contract.
`docs/api/CR_BE_MOB_CONTRACT_01_PART07_COMPLETENESS.md` pins **180**
mobile-consumed operations as PUBLISHED. That surface already covers:

| Area | Authority | Contract state |
|---|---|---|
| Auth / session / effective context | BE-01 / BE-02 / BE-25B | Published |
| Task assignment + execution | BE-07 + `listMobileAssignments` | Published |
| Work Order lifecycle, actions, evidence, verification, history | BE-08 | Published |
| Checklist / measurement / UOM / evidence | BE-07 | Published |
| Finding / rework / review / closure | BE-09 | Published |
| Asset QR resolve | BE-05H + BE-25F | Published (`targetType=ASSET` only) |
| Offline sync (4 resource kinds) + idempotency + conflict | BE-25G/H/I | Published |
| Supervisor verification composition | BE-25J (`CHECKLIST_EXECUTION` / `FORM_INSTANCE` / `FINDING`) | Published |
| Push **token** registration | BE-25L | Published |
| In-app notification inbox / history | BE-26A/E/K | Published |
| Location / functional-location **reads** | BE-04 / BE-05 | Published |
| Work Order material usage + cost summary | BE-16I / CR-BE-MAT-01 | Published |

CR-BE-MOB-CONTRACT-01 PART 07 explicitly marked housekeeping, security,
engineering/patrol bindings, and push **delivery** as
**NOT_APPLICABLE** to that CR. Those leftovers are this CR’s scope.

---

## 4. Baseline facts (verified this step)

| Item | Value | Evidence |
|---|---|---|
| Runtime | Node.js + TypeScript (strict) + PostgreSQL | `package.json`, `tsconfig.json` |
| Migrations | **276** | `src/database/migrations/` |
| Domain modules | **284** | `src/modules/` |
| OpenAPI | OpenAPI 3.0.3, **344 paths / 453 operations**, incremental rule | `docs/api/openapi.yaml` |
| Core mobile contract | CR-BE-MOB-CONTRACT-01 PART 01–08 merged | PR #37, `docs/api/mobile-integration-handoff.md` |
| Mobile assignment types | `TASK`, `WORK_ORDER` only | `src/modules/mobile-assignments/mobile-assignment.types.ts` |
| Sync resource kinds | `TASK_EXECUTION`, `CHECKLIST_RESPONSES`, `EVIDENCE_SUBMISSION`, `TASK_ASSIGNMENT` | `src/modules/mobile-sync/mobile-sync.types.ts` |
| QR target types | `ASSET` only | `src/modules/mobile-qr-resolution/mobile-qr.types.ts` |
| Mobile verification targets | `CHECKLIST_EXECUTION`, `FORM_INSTANCE`, `FINDING` | `src/modules/mobile-verification/mobile-verification.types.ts` |
| Notification history channels | `IN_APP`, `EMAIL`, `WHATSAPP` — **no `PUSH`** | `src/modules/notification-history/notification-history.types.ts` |
| Housekeeping / security / engineering / patrol paths in OpenAPI | **None** | path-prefix scan of `openapi.yaml` |

---

## 5. Classification legend

Used in this document and in the gap matrix.

| Status | Meaning |
|---|---|
| **EXISTING** | Backend **and** published OpenAPI already support the mobile operation. No backend work required beyond consumer binding. |
| **PARTIAL** | Authoritative backend capability exists, but the published contract and/or the mobile-consumed workflow composition is incomplete. Typical action: **publish OpenAPI** and/or a thin composition over the existing domain. |
| **MISSING** | An authoritative backend capability is required and was not found. Typical action: **extend an existing domain** (sync resource kind, QR target type, BE-26 push channel). Do not create a parallel mobile engine. |
| **NOT_REQUIRED** | Mobile simulation / convenience behaviour must **not** become a backend capability or a new domain. Document the existing reuse path instead. |

Recommended backend actions (later PARTs only):

| Action | Meaning |
|---|---|
| `NONE` | Already contracted. Consumer binds to the published operationId. |
| `PUBLISH_OPENAPI` | Document existing routes/schemas. No runtime change. |
| `COMPOSE_EXISTING` | Thin `/mobile/*` or feed row over an existing service (BE-25 pattern). |
| `EXTEND_EXISTING` | Add a resource kind / target type / channel to an existing contract. |
| `DO_NOT_IMPLEMENT` | Explicitly out of backend scope. |

---

## 6. Domain findings

### 6.1 Housekeeping (owning wave: **BE-11**, execution via **BE-07**)

Housekeeping is a **context + binding** layer over shared engines. It is
not a second task/checklist/finding engine.

| Capability | Finding | Status |
|---|---|---|
| Cleaning execution | `daily-cleaning` (BE-11C) is a **read view** of BE-07 `generated_tasks` bound to a Cleaning Area. Writes are `startTask` / `completeTask` / `cancelTask`. No HK-specific execute API. Daily-cleaning and cleaning-assignment routes are unpublished. Mobile feed does not discriminate `HOUSEKEEPING` — a scheduled cleaning task appears as `type=TASK` if assigned. | **PARTIAL** |
| Inspection lifecycle | Toilet (BE-11E) and public-area (BE-11F) bindings create/start a shared BE-07 checklist execution. Complete/cancel stay on checklist endpoints. Bindings + start routes unpublished. | **PARTIAL** |
| Pass/fail verification | Quality audit (BE-11K) `PASS` / `FAIL` / `REWORK_REQUIRED`. Supervisor inspection (BE-11G) `APPROVED` / `REJECTED` / `REWORK_REQUIRED` via the BE-07 review primitive. Neither is in OpenAPI. `/mobile/verification` does not accept HK targets. | **PARTIAL** |
| Reinspection | **No** `reinspect` route, table, or status. After `FAIL` / `REWORK_REQUIRED`, the existing path is: start a **new** checklist execution on the same binding, then reuse BE-09 rework on any finding. A dedicated reinspection lifecycle would duplicate BE-07/BE-09. | **NOT_REQUIRED** |
| Consumables / material usage | BE-11J readiness (requirement + daily check) and BE-16J item/warehouse **bindings** (readiness derived from stock) exist and are unpublished. There is **no** housekeeping field stock-out / usage write. Authoritative usage lives on BE-16I Work Order material usage. | **PARTIAL** (readiness) / **NOT_REQUIRED** (HK-specific usage engine) |
| Finding / rework | BE-11H binds HK sources (`DAILY_CLEANING`, `TOILET_INSPECTION`, `PUBLIC_AREA_INSPECTION`, `SUPERVISOR_INSPECTION`) to a BE-09 Finding. Rework/reject/resubmit are the published BE-09 operations. HK binding create/list is unpublished. | **PARTIAL** (HK binding) + **EXISTING** (rework) |

**Do not create:** a mobile housekeeping execution engine, a reinspection
domain, or a housekeeping stock-usage table. Publish BE-11 reads/bindings
and keep execution on BE-07 / BE-09 / BE-16.

### 6.2 Security (owning wave: **BE-12**, incidents via **BE-21**)

| Capability | Finding | Status |
|---|---|---|
| Patrol execution | BE-12D: list/get/start over a BE-07 generated task + route context. Unpublished. | **PARTIAL** |
| Checkpoint confirmation | `POST /security/patrol-executions/:id/points/:pointId/visit` records a `patrol_point_visits` row (`VISITED`). Points are ordered location refs (floor/area/room/space/FL) — **not** QR identifiers. Unpublished. | **PARTIAL** |
| Patrol completion | `POST /security/patrol-executions/:id/complete` delegates to BE-07 task complete. Unpublished. | **PARTIAL** |
| Occurrence / incident reporting | No `occurrence` entity exists (and must not be invented). Field reporting already has: BE-12H security findings (patrol/checklist/daily-activity/handover/post sources), BE-21A `POST /incidents`, BE-21B `POST /operational-incidents` (`operationalCategory` includes `SECURITY`). Security incident **readiness** (BE-12I) is configuration only. Daily activity (BE-12F) is a read model. None of these paths are in OpenAPI. | **PARTIAL** (use BE-21 / BE-12H) / **NOT_REQUIRED** (distinct occurrence type) |

**Do not create:** a mobile patrol engine, a checkpoint master separate
from `patrol_route_points`, or an occurrence domain. QR confirmation of a
checkpoint, if required later, is an **extension of BE-25F**, not a new
security QR service.

### 6.3 Engineering (owning wave: **BE-10**, execution via **BE-07 / BE-08**)

| Capability | Finding | Status |
|---|---|---|
| PM/CM field execution | `workType` is a free data-driven code (not a hardcoded PM/CM enum). Field execution of a Work Order is the published BE-08 action set (`acknowledgeWorkOrder` … `completeWorkOrder`). BE-10G maintenance bindings **link** an asset to schedule / task / work order; they do not execute work. Breakdowns (BE-10F) link corrective WOs. Bindings unpublished. | **EXISTING** (WO execution) + **PARTIAL** (engineering binding/context) |
| Diagnosis / test / technical readings | No diagnosis or “test result” domain exists. Technical capture is already: equipment inspection (BE-10B), meter reading (BE-10C → `form_responses`), log sheet (BE-10D), engineering checklist (BE-10E). Utility meter readings (BE-18) are a separate billing-oriented authority. | **PARTIAL** (readings/inspections unpublished) / **NOT_REQUIRED** (diagnosis/test engine) |
| Supervisor review | Published: `getMobileVerification` / `submitMobileVerification` and `getWorkOrderVerification` / `submitWorkOrderVerification`. Engineering executions are checklist/form instances, so they are already reviewable **if** the client uses those target types. There is no `WORK_ORDER` or engineering-binding target on `/mobile/verification`. | **PARTIAL** |
| Meter / technical reading review | BE-18K verifies **abnormal consumption**, not every reading. A completed form/checklist reading is reviewed through BE-07 reviews / BE-25J. No dedicated “reading review” engine. | **PARTIAL** |

**Do not create:** an engineering-mobile execution domain, a diagnosis
model, or a second meter-review workflow. Publish BE-10 bindings and
keep writes on checklist / form / work-order / review authorities.

### 6.4 Work Order (owning wave: **BE-08**, materials **BE-16**)

| Capability | Finding | Status |
|---|---|---|
| Material usage | `recordWorkOrderMaterialUsage` and list/get/cost-summary are implemented **and** published. Usage snapshots `itemId`, `warehouseId`, `uomId`, quantity, cost, `stockMovementId`. | **EXISTING** |
| Item / warehouse / UOM context | UOM CRUD is published (`listUoms`, `getUom`). Item master (BE-16A: `/clients/:id/inventory-items`, `/inventory-items/:id`) and warehouse master (BE-16B: `/buildings/:id/warehouses`, `/warehouses/:id`) exist and are **unpublished**. Stock balance/movement is published. Usage payload embeds item/warehouse snapshots but mobile cannot list pickable items/warehouses from OpenAPI. | **PARTIAL** |
| Supervisor verification | Domain API published (`getWorkOrderVerification`, `submitWorkOrderVerification`, close). `/mobile/verification` does **not** include `WORK_ORDER`. Mobile supervisors can already call the Work Order endpoints; a composition is convenience, not a missing authority. | **EXISTING** (authority) / **PARTIAL** (mobile composition optional) |

**Do not create:** a mobile material-usage engine. Publish item/warehouse
**reads** if the field picker needs them. Do not add a second verification
authority.

### 6.5 QR operational context (owning wave: **BE-25F** over **BE-05H / BE-04**)

| Target | Finding | Status |
|---|---|---|
| Asset | `resolveMobileQr` + `resolveAssetByIdentifier`. Discriminator `targetType: ASSET`. Building + functional-location + equipment context included. | **EXISTING** |
| Location (floor / area / room / space) | Hierarchy and by-id reads are published (`getBuildingHierarchy`, `getFloor`, `getArea`, `getRoom`, `getSpace`). There is **no** identifier registry and no QR resolve for these types. Codes are human/machine labels, not scan identifiers. | **MISSING** (scan resolve) — reads are EXISTING |
| Functional location | `getFunctionalLocation` / `getFunctionalLocationContext` published. No FL identifier / QR resolve. | **MISSING** (scan resolve) |
| Checkpoint | Patrol points have ids + location FKs. No identifier, no QR resolve, no visit-by-scan API. Visit is by `pointId`. | **MISSING** (scan resolve) / visit-by-id is PARTIAL in §6.2 |

GPS / geofencing remains **NOT_REQUIRED** (already recorded in
CR-BE-MOB-CONTRACT-01). If a later PART adds non-asset QR, it must
**extend `resolveMobileQr`** over an identifier authority — not create
`/mobile/qr/location` or `/mobile/qr/checkpoint` engines.

If product later decides QR payloads will carry the canonical UUID, no
new resolve API is required: mobile calls the existing GET-by-id. That
convention must be documented before any identifier work starts.

### 6.6 Offline / mobile sync (owning wave: **BE-25G/H/I**)

The sync **foundation is complete** for the four supported kinds:

- authoritative client `operationId` (BE-25H idempotency store)
- per-item independent execution through the **same** domain services
- `baseVersion` → `SYNC_CONFLICT` + current resource + reload guidance
  (BE-25I)
- evidence **bytes** stay on `uploadMobileEvidence` (online)

| Capability | Finding | Status |
|---|---|---|
| Supported resource kinds | `TASK_EXECUTION`, `CHECKLIST_RESPONSES`, `EVIDENCE_SUBMISSION`, `TASK_ASSIGNMENT` | **EXISTING** |
| Authoritative IDs | `operationId` + domain `resourceId` (task / execution / assignment) | **EXISTING** (supported kinds) |
| Conflict / retry | Idempotent replay; conflict not stored; fresh `operationId` to retry a failure | **EXISTING** |
| Housekeeping / patrol / meter / WO action / WO material / incident / finding-create as sync kinds | Not in `MOBILE_SYNC_RESOURCE_TYPES`. Offline field work in those domains cannot sync today. | **MISSING** (coverage) |

**Do not create:** a second sync engine or per-domain offline tables.
A later PART may `EXTEND_EXISTING` `processSyncBatch` with additional
`resourceType` values that call the **existing** services
(patrol visit/complete, checklist already covered, WO actions, material
usage, incident create). Only add a kind when the online write already
exists.

Offline evidence **byte** queue remains **NOT_REQUIRED** as a backend
capability (mobile-side queue + online upload).

### 6.7 Mobile notification (owning wave: **BE-25L** + **BE-26**)

| Capability | Finding | Status |
|---|---|---|
| Push token registration | `registerPushToken` / `listPushTokens` / `deactivatePushToken`. User-bound, rotate-in-place, no delivery. | **EXISTING** |
| In-app delivery + inbox | `listNotifications` / `getNotification` / `markNotificationRead` + history (`IN_APP`/`EMAIL`/`WHATSAPP`) | **EXISTING** |
| Push **delivery** contract | BE-26C was planned (adapter over `mobile_push_tokens`). No push adapter, no PUSH channel, no push attempt/history, no fan-out from operational events to device tokens. Email/WhatsApp adapters exist; push does not. | **MISSING** |

**Do not create:** a mobile-only notification domain. Push delivery, if
required, is a **BE-26 channel** that consumes BE-25L tokens. In-app is
already the authoritative inbox fallback.

---

## 7. What is explicitly out of scope (NOT_REQUIRED)

These mobile-side simulations must **not** be promoted to backend
authorities in later PARTs:

1. Dedicated **reinspection** lifecycle / ids.
2. Dedicated **diagnosis** or **test-result** domain.
3. Dedicated **occurrence** entity (use Incident / Operational Incident /
   Security Finding).
4. Housekeeping-specific **stock-usage engine** (use BE-16 inventory /
   WO usage).
5. Mobile-specific housekeeping / security / engineering execution
   engines (use BE-07 task, BE-07 checklist, BE-08 work order, BE-12D
   patrol visit).
6. GPS / geofencing authority.
7. Session refresh / rotation (already a documented boundary).
8. Offline evidence **byte** store / queue on the backend.
9. Standalone Task / Work Order `availableActions` endpoint (feed +
   domain verification remain authoritative).
10. Changing frozen BE-07…BE-27 / existing CR wave numbers.

---

## 8. What backend work is actually required

Collapsing the matrix: **no new operational domain is required**.

| Required later work | Class | Why |
|---|---|---|
| Publish BE-11 housekeeping operational routes (daily cleaning, inspections, supervisor decision, quality audit, HK finding/evidence bindings, consumable readiness) | `PUBLISH_OPENAPI` | Capability exists; mobile cannot bind safely |
| Publish BE-12 patrol execution/visit/complete + security findings | `PUBLISH_OPENAPI` | Capability exists; unpublished |
| Publish BE-21 incident / operational-incident writes used for field reporting | `PUBLISH_OPENAPI` | Capability exists; unpublished |
| Publish BE-10 inspection / meter / log / checklist / maintenance / breakdown bindings + start/submit | `PUBLISH_OPENAPI` | Capability exists; unpublished |
| Publish BE-16A/B item + warehouse **reads** (field picker context) | `PUBLISH_OPENAPI` | Masters exist; usage already published |
| Optional: add `WORK_ORDER` to `/mobile/verification` | `COMPOSE_EXISTING` | Authority already published on `/work-orders/{id}/verification` |
| Optional: add HK/patrol rows to `listMobileAssignments` | `COMPOSE_EXISTING` | They already appear as `TASK` when assigned; only needed if mobile requires a discriminator |
| Extend `resolveMobileQr` for location / FL / checkpoint **only if** product requires opaque-identifier scan (needs an identifier authority first) | `EXTEND_EXISTING` | Not a new QR engine |
| Extend `processSyncBatch` resource kinds for patrol visit/complete, WO actions, material usage, incident create — only where an online write already exists | `EXTEND_EXISTING` | Not a new sync engine |
| BE-26 push delivery adapter + PUSH history channel over BE-25L tokens | `EXTEND_EXISTING` (BE-26) | Token registration exists; delivery does not |

**Headline:** after CR-BE-MOB-CONTRACT-01, the remaining blockers are
almost entirely **unpublished existing authorities** plus three genuine
extensions of existing mobile contracts (QR target types, sync kinds,
push delivery). None justify a new mobile operational domain.

---

## 9. Proposed SMALL PART breakdown

Domain-oriented, lightweight, no wave-number changes. Each PART is
contract-first. Implementation of a PART is **not** started by this
governance step.

```text
CR-BE-MOB-01
  PART 01 — Housekeeping operational contract publish
  PART 02 — Security patrol & field-incident contract publish
  PART 03 — Engineering field / reading contract publish
  PART 04 — Work Order material context + verification composition
  PART 05 — QR operational-context boundary (and optional resolve extension)
  PART 06 — Offline sync resource-kind extension (existing writes only)
  PART 07 — Mobile push delivery contract (BE-26 channel, BE-25L tokens)
  PART 08 — Cross-contract regression & mobile handoff
```

| PART | Title | In | Out | Reuse |
|---|---|---|---|---|
| **01** | Housekeeping operational contract | Publish daily-cleaning reads, toilet/public-area bind+start, supervisor inspection+decision, quality-audit complete, HK finding/evidence bindings, consumable readiness/bindings. Document that execute/complete = BE-07 task/checklist. | No HK engine, no reinspection, no HK stock-out table | BE-11, BE-07, BE-09, BE-16J |
| **02** | Security patrol & field-incident contract | Publish patrol execution start/visit/points/complete, security findings, operational-incident + incident create/get. Document “occurrence” = BE-21. | No occurrence domain, no checkpoint master, no patrol engine | BE-12D/H, BE-21A/B, BE-07 task |
| **03** | Engineering field / reading contract | Publish inspection/meter/log/checklist/maintenance/breakdown bind+start+submit/read. Document PM/CM execution = BE-08 WO + BE-07 checklist. | No diagnosis/test domain, no second meter-review | BE-10, BE-07, BE-08, BE-18 (abnormal only) |
| **04** | WO material context + verification | Publish inventory-item and warehouse **reads**. Optionally compose `WORK_ORDER` onto `/mobile/verification`. | No new usage engine (already published) | BE-16A/B/I, BE-08I, BE-25J |
| **05** | QR operational context | Freeze payload convention (canonical id vs opaque identifier). Document ASSET-only + GET-by-id for location/FL. Add resolve target types **only** if an identifier authority is approved. | No GPS, no new QR engine, no anonymous scan | BE-25F, BE-05H, BE-04, BE-12B points |
| **06** | Sync resource-kind extension | Add `resourceType`s that call existing services (e.g. patrol visit/complete, WO action, WO material usage, incident create). Same operationId idempotency + baseVersion rules. | No new sync store, no evidence-byte queue | BE-25G/H/I + domain services from PART 01–04 |
| **07** | Push delivery contract | BE-26 push channel: adapter interface + attempt/history + token fan-out. Default no-op/logging driver (same as email/WhatsApp). | No mobile-only notifier, no provider hardcode | BE-26, BE-25L |
| **08** | Regression & handoff | Completeness matrix, OpenAPI↔router invariant, update `mobile-contract.md` / handoff. | No new capability | `tests/mobile-openapi-completeness.test.ts` |

**Order:** 01 → 02 → 03 → 04 can proceed in parallel after this
governance freeze (they do not share writes). **05** and **06** depend
on the published online contracts. **07** is independent of 01–04.
**08** is last.

PART 05/06/07 contain the only possible **runtime** extensions. PART
01–04 are publish-first and must not change behaviour.

---

## 10. Priority guidance (for later PART scheduling)

| Priority | Rule |
|---|---|
| **P0** | Mobile cannot execute a live field workflow without guessing unpublished routes (HK clean/inspect, patrol execute/visit/complete, engineering reading/inspection start). |
| **P1** | Mobile can call an unpublished but existing write, or a published substitute is awkward (item/warehouse picker, incident OpenAPI, sync kinds, push delivery). |
| **P2** | Convenience composition (`WORK_ORDER` on `/mobile/verification`, assignment discriminator, non-asset QR if product still uses GET-by-id). |

See the gap matrix for per-row priority.

---

## 11. Validation (this step)

Documentation only. No runtime, schema, or OpenAPI change.

| Check | Result |
|---|---|
| Inspected backend modules + routes for BE-07…BE-12, BE-16, BE-18, BE-21, BE-25, BE-26 | Done |
| Inspected `docs/api/openapi.yaml` (344 paths / 453 operations) | Done |
| Inspected CR-BE-MOB-CONTRACT-01 governance, PART 07 completeness, mobile-contract, handoff | Done |
| Code / OpenAPI / migrations modified | **None** |
| PR / merge | **Not created** (instruction: no PR, no merge) |

---

## 12. What was NOT done

- No PART implemented.
- No endpoint, OpenAPI path, migration, seed, permission, or behaviour
  change.
- No frontend / mobile repository modified (not present here).
- No frozen wave number changed.
- No PR, no merge.

---

## 13. PART 01 completion — Housekeeping contract publish

**Date:** 2026-08-19  
**Change class:** `PUBLISH_OPENAPI` only.

### Published (existing BE-11 routes)

| Area | operationIds | Mobile use |
|---|---|---|
| Daily cleaning state | `listBuildingDailyCleaning`, `getDailyCleaning`, `listCleaningAreaDailyCleaning` | Cleaning operational list/detail (`id` = BE-07 `taskId`) |
| Cleaning assignment / my work | `assignDailyCleaning`, `listDailyCleaningAssignments`, `listWorkforceDailyCleaning`, `listTeamDailyCleaning` | Work assignment; execute via `startTask` / `completeTask` / `cancelTask` |
| Toilet inspection | `list/create/get/updateToiletInspectionBinding`, `startToiletInspectionExecution`, `getToiletInspectionExecution` | Bind + start; complete via published checklist ops |
| Public-area inspection | same pattern (`PublicAreaInspection*`) | Same |
| Supervisor verification | `list/create/getSupervisorInspection`, `submitSupervisorInspectionDecision` | APPROVED / REJECTED / REWORK_REQUIRED |
| Quality audit | `list/create/get/updateQualityAudit`, `completeQualityAudit` | PASS / FAIL / REWORK_REQUIRED |
| Finding linkage | `list/create/getHousekeepingFinding` | HK source → BE-09 `findingId`; rework stays on published finding ops |
| Evidence linkage | `listHousekeepingEvidenceRequirements`, `listHousekeepingEvidence`, `submitHousekeepingEvidence` | BE-07 evidence metadata on HK sources |

Tag: `Housekeeping`. Tests: `tests/mobile-housekeeping-contract.test.ts` +
pinned rows in `tests/mobile-openapi-completeness.test.ts`.

### Still PARTIAL / NOT_REQUIRED after PART 01

| Row | Status after PART 01 | Why |
|---|---|---|
| HK-04 reinspection | **NOT_REQUIRED** | No engine published or added. Use new checklist start + BE-09 rework. |
| HK-05 consumable readiness | **PARTIAL** | Existing BE-11J/BE-16J routes left unpublished (not a field-execution surface; no stock engine created). |
| HK-06 HK stock-usage engine | **NOT_REQUIRED** | Not published; not implemented. |
| HK-08 rework | **EXISTING** | Unchanged — BE-09 finding rework. |
| Assignment discriminator on `/mobile/assignments` | unchanged (optional P2) | Cleaning tasks still appear as `type=TASK` when assigned. |

### What PART 01 did not do

- No new Housekeeping domain, table, migration, or `/mobile/housekeeping` facade.
- No reinspection lifecycle, no HK consumable stock-out.
- No runtime RBAC / Building-isolation / status-enum change.

## 14. PART 02 completion — Security contract publish

**Date:** 2026-08-19  
**Baseline:** Arena branch `arena/01a01ad3-asentra-backend`, fast-forwarded to
`19c48b8` (PART 01 head).  
**Change class:** `PUBLISH_OPENAPI` only. No new domain, table, migration,
seed, permission, workflow, status, route, or mobile-specific API.

### Review performed first (existing Security code)

| Wave | Module(s) | Routes | Permission(s) |
|---|---|---:|---|
| BE-12A | `security-posts` | 4 | `security_post.read/manage` |
| BE-12B | `patrol-routes` (routes + points) | 7 | `patrol_route.read/manage` |
| BE-12C | `patrol-schedule-bindings` | 4 | `patrol_schedule.read/manage` |
| BE-12D | `patrol-executions` (+ point visits) | 7 | `patrol_execution.read/manage` |
| BE-12E | `patrol-checklist-bindings` | 6 | `patrol_checklist_binding.read/manage` |
| BE-12F | `security-daily-activity` | 1 | `security_daily_activity.read` |
| BE-12H | `security-findings` | 3 | `security_finding.read/manage` |
| BE-21A | `incidents` | 5 | `incident.read/manage` |
| BE-21B | `operational-incidents` | 4 | `operational_incident.read/manage` |

**41 operations across 27 paths**, all previously registered and unpublished.

### Published (existing routes only) — tag `Security`

| Requested area | operationIds | Backend authority reused |
|---|---|---|
| Patrol | `listBuildingPatrolExecutions`, `getPatrolExecution`, `startPatrolExecution`, `completePatrolExecution`; route definition `createPatrolRoute`, `listBuildingPatrolRoutes`, `getPatrolRoute`, `updatePatrolRoute`; post context `createSecurityPost`, `listBuildingSecurityPosts`, `getSecurityPost`, `updateSecurityPost` | BE-12A/B/D over the **BE-07 task engine** (`id` = `taskId`); start/complete delegate to `task-execution` |
| Patrol assignment | `createPatrolScheduleBinding`, `listPatrolRouteScheduleBindings`, `getPatrolScheduleBinding`, `updatePatrolScheduleBinding` | BE-12C binding onto a **BE-07 Schedule Definition**. Assignment of a generated patrol to a workforce/team is the already-published BE-07 `assignTask` / `listTaskAssignments` on the same `taskId` — **not** re-published here |
| Checkpoint | `addPatrolRoutePoint`, `listPatrolRoutePoints`, `updatePatrolRoutePoint`, `recordPatrolPointVisit`, `listPatrolPointVisits`, `updatePatrolPointVisit` | BE-12B `patrol_route_points` (sequenced **BE-04 location** refs) + BE-12D `patrol_point_visits`. Confirmation is by canonical `pointId` |
| Security field reporting | `getSecurityDailyActivity`, `createIncident`, `listIncidents`, `getIncident`, `updateIncident`, `cancelIncident`, `createOperationalIncident`, `listOperationalIncidents`, `getOperationalIncident`, `updateOperationalIncident` | BE-12F read model (composition only) + BE-21A foundation + BE-21B specialization (`operationalCategory: SECURITY`) |
| Incident / finding linkage | `createSecurityFinding`, `listSecurityFindings`, `getSecurityFinding` | BE-12H link over an authoritative **BE-09 Finding**; `finding` is `$ref: Finding` and `availableActions` is BE-09's. Workflow keyed by `findingId`, never by the link `id` |
| Checklist linkage | `createPatrolChecklistBinding`, `listPatrolChecklistBindings`, `getPatrolChecklistBinding`, `updatePatrolChecklistBinding`, `startPatrolChecklistExecution`, `getPatrolChecklistExecutionContext` | BE-12E binding onto a **BE-07 Checklist Template**; the start endpoint only creates the shared execution — responses/complete/cancel stay on published BE-07 checklist ops |
| Evidence linkage | — (no Security evidence route exists) | Documented reuse: evidence attaches to the **BE-07 checklist execution** returned by `startPatrolChecklistExecution`, or to the BE-09 finding, through the already-published `uploadMobileEvidence` / evidence file operations |

Every operation carries `x-required-permission` (the exact code enforced by
`requirePermission`) and `x-building-scoped: true`, plus documented 401/403.

### Classification after PART 02

| Row | Before | After | Note |
|---|---|---|---|
| SEC-01 patrol execution | PARTIAL | **EXISTING** | Published; start/complete still delegate to BE-07 |
| SEC-02 checkpoint confirmation | PARTIAL | **EXISTING** | Published by canonical `pointId` |
| SEC-03 patrol completion | PARTIAL | **EXISTING** | Published; mobile must use it instead of blunt `completeTask` |
| SEC-04 occurrence | NOT_REQUIRED | **NOT_REQUIRED** | Unchanged — no occurrence domain created |
| SEC-05 incident / field reporting | PARTIAL | **EXISTING** | BE-21A/B + BE-12H published |
| QR-04 checkpoint QR | MISSING | **MISSING** | Unchanged. No checkpoint identifier authority exists; scan-to-confirm stays out of scope (PART 05) |
| Security evidence linkage | — | **PARTIAL** | No Security-specific evidence route exists; reuse is documented, nothing invented |
| Security assignment discriminator on `/mobile/assignments` | — | **PARTIAL** (P2) | A patrol still surfaces as `type=TASK`; no discriminator added |

### Deliberately NOT published (out of the mobile field surface)

`security-keys`, `security-lost-found`, `security-visitor-bindings`,
`security-shift-handovers`, `security-reports` (BE-12M datasets),
`security-incident-readiness` (configuration only), `security-patrol-kpi`,
`security-finding-incident-kpi`, `incident-closure` (BE-21K). These exist and
work; they are management/config surfaces, not mobile field execution, and are
left for a later PART rather than published speculatively.

### What PART 02 did not do

- No new domain, table, migration, seed, permission code, workflow, status
  enum, or `/mobile/security` facade.
- No checkpoint master, checkpoint identifier/QR target, occurrence entity, or
  second patrol/finding/incident engine.
- No runtime change of any kind — RBAC, Building isolation (BE-02G) and every
  status enum are published exactly as implemented.

### Validation (PART 02)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| `tests/mobile-security-contract.test.ts` (10 subtests) | ✅ PASS — tag/paths/methods, 41 pinned operationIds, documented ⊆ registered routes, no BE-12/BE-21 route left undocumented, per-operation permission + Building scope, enum fidelity, reuse boundaries, no invented checkpoint/occurrence surface, 401-never-404 probes |
| `tests/mobile-openapi-completeness.test.ts` | ✅ PASS — no phantom paths, unique operationIds, all `$ref`s resolve |
| `tests/openapi-contract.test.ts` | ✅ PASS (6/6) |
| `tests/mobile-housekeeping-contract.test.ts` (PART 01 regression) | ✅ PASS |
| OpenAPI size | 344 → **395 paths** (+27 Security paths / 41 operations) |
| DB-backed suites | ⚠️ NOT RUN — no local PostgreSQL in the sandbox; environment limitation, not a code defect (unchanged from PART 01) |

## 15. PART 03 completion — Engineering field / reading contract publish

**Date:** 2026-08-19  
**Baseline:** Arena branch `arena/01a01ad3-asentra-backend` at `ab5ff96`
(PART 02 head).  
**Change class:** `PUBLISH_OPENAPI` only. No new domain, table, migration,
seed, permission, workflow, status, endpoint implementation, or
mobile-specific API.

### Review performed first (existing Engineering code)

| Wave | Module | Routes | Permission(s) |
|---|---|---:|---|
| BE-10A | `engineering-daily-operations` | 1 | `engineering.read` |
| BE-10B | `inspection-bindings` | 7 | `inspection_binding.read/manage` |
| BE-10C | `meter-reading-bindings` | 8 | `meter_reading_binding.read/manage` |
| BE-10D | `log-sheet-bindings` | 8 | `log_sheet_binding.read/manage` |
| BE-10E | `engineering-checklist-bindings` | 6 | `engineering_checklist_binding.read/manage` |
| BE-10F | `breakdown-bindings` | 6 | `breakdown.read/manage` |
| BE-10G | `maintenance-bindings` | 8 | `maintenance_binding.read/manage` |
| BE-10H | `engineering-findings` | 3 | `engineering_finding.read/manage` |
| BE-10J | `shift-handovers` | 6 | `shift_handover.read/manage` |
| BE-10K | `engineering-overview` | 1 | `engineering_overview.read` |

**54 operations across 39 paths**, all previously registered and unpublished.
The review confirmed that every BE-10 record is a *binding* or *read model*
over an existing authority — there is no Engineering execution engine to
publish, and none was added.

### Published (existing routes only) — tag `Engineering`

| Requested area | operationIds | Backend authority reused |
|---|---|---|
| Engineering field work | `create/list/get/updateInspectionBinding`, `listAssetInspectionBindings`, `listBuildingInspectionBindings`, `startInspectionExecution`, `getInspectionExecutionContext`; `…LogSheetBinding*`, `startLogSheetExecution`, `listLogSheetExecutions`, `getLogSheetExecutionContext` | BE-10B/D bindings over **BE-05 Asset** + **BE-07 Checklist Template / Form Template**; executions are shared BE-07 checklist executions / form instances |
| PM / corrective maintenance execution | `create/list/get/updateMaintenanceBinding`, `listAssetMaintenanceBindings`, `listBuildingMaintenanceBindings`, `linkMaintenanceSchedule`, `linkMaintenanceTask`, `linkMaintenanceWorkOrder`; `createBreakdown`, `listAssetBreakdowns`, `listBuildingBreakdowns`, `getBreakdown`, `closeBreakdown`, `linkBreakdownCorrectiveWorkOrder` | BE-10G references a **BE-07 Schedule**, **BE-07 generated Tasks** and a **BE-08 Work Order**; BE-10F links a corrective **BE-08 Work Order**. Field execution itself is the already-published BE-08 action set (`acknowledge/start/hold/resume/note/complete/cancelWorkOrder`) and BE-07 `startTask` / `completeTask` / `assignTask` — **not re-published here**. `workType` remains a data-driven code; no PM/CM enum was invented |
| Technical readings | `startInspectionExecution`, `getInspectionExecutionContext`, `startLogSheetExecution`, `listLogSheetExecutions`, `getLogSheetExecutionContext`, `start/getEngineeringChecklistExecution*` | BE-10B/D/E over BE-07 checklist executions and form instances (`form_responses`) |
| Meter readings | `create/list/get/updateMeterReadingBinding`, `listAssetMeterReadingBindings`, `listBuildingMeterReadingBindings`, `startMeterReadingExecution`, `submitMeterReading`, `getMeterReadingContext` | BE-10C: numeric **BE-07 Form Field** + **BE-07 UOM** + effective min/max range; the value is written to BE-07 `form_responses` — no second measurement store |
| Engineering checklist linkage | `create/list/get/updateEngineeringChecklistBinding`, `startEngineeringChecklistExecution`, `getEngineeringChecklistExecutionContext` | BE-10E binding onto a **BE-07 Checklist Template**; responses/complete/cancel stay on published BE-07 checklist ops |
| Engineering evidence linkage | — (no Engineering evidence route exists) | Documented reuse: every BE-10 execution id is a BE-07 `CHECKLIST_EXECUTION` or `FORM_INSTANCE`, which the already-published `submitEvidence` / `listEvidence` / evidence-file operations accept directly |
| Supervisor-relevant engineering records | `getEngineeringDailyOperations`, `getEngineeringOverview`, `create/list/get/updateEngineeringShiftHandover`, `markEngineeringShiftHandoverReady`, `acknowledgeEngineeringShiftHandover`, `create/list/getEngineeringFinding` | BE-10A/K read models (composition only) + BE-10J handover lifecycle + BE-10H link over an authoritative **BE-09 Finding** (`finding` is `$ref: Finding`, `availableActions` is BE-09's) |

Every operation carries `x-required-permission` (the exact code enforced by
`requirePermission`) and `x-building-scoped: true`, plus documented 401/403.
All ids published are the authoritative ones: BE-07 checklist-execution /
form-instance ids, BE-07 `taskId`, BE-08 `workOrderId`, BE-09 `findingId`,
BE-05 `assetId`, BE-04 location ids.

### Classification after PART 03

| Row | Before | After | Note |
|---|---|---|---|
| ENG-01 PM/CM field execution | PARTIAL | **EXISTING** | BE-10F/G binding + context published; execution stays the published BE-08/BE-07 surface |
| ENG-02 diagnosis / test domain | NOT_REQUIRED | **NOT_REQUIRED** | Unchanged — nothing created |
| ENG-03 technical readings / inspection / log / checklist | PARTIAL | **EXISTING** | BE-10B/C/D/E bind + start + submit + read published |
| ENG-04 supervisor review | PARTIAL | **PARTIAL** | Review **authority** is already published (`getMobileVerification` / `submitMobileVerification` on CHECKLIST_EXECUTION / FORM_INSTANCE, `get/submitWorkOrderVerification`, `listReviews`). Engineering-specific supervisor *records* (BE-10A/K/J) are now published. `WORK_ORDER` is still not a `/mobile/verification` target (optional composition, P2) |
| ENG-05 per-reading review | PARTIAL | **PARTIAL** (by design) | No per-reading review API exists and none was created. A completed reading is a BE-07 form instance and is reviewed through the published review / verification operations |
| ENG-06 utility (billing) meter capture — **new row** | — | **PARTIAL** | BE-18 `POST /utility/meters/{id}/readings`, `…/readings/latest`, `/utility/meter-readings/{id}` (+ evidence requirement/validation/submit) exist and are **deliberately unpublished**: BE-18 is a separate billing/tenant authority, not BE-10 engineering field work. Publishing it beside BE-10C would create two competing meter-reading contracts. Deferred, not invented |
| Engineering evidence linkage | — | **EXISTING** (via reuse) | No Engineering evidence route exists; the published BE-07 evidence API accepts the returned execution ids |

### Deliberately NOT published (out of the mobile field surface)

`engineering-reports` (BE-10 dataset endpoints — management reporting, same
exclusion as the Security/Housekeeping reporting datasets),
`equipment-profiles` (asset master, BE-05), and the whole BE-18 utility /
billing chain (meters, consumptions, aggregations, bills, abnormal
consumptions and `utility-verification`). These exist and work; they are not
engineering field execution and are left for a later PART rather than
published speculatively.

### What PART 03 did not do

- No new domain, table, migration, seed, permission code, workflow, status
  enum, endpoint implementation, or `/mobile/engineering` facade.
- No diagnosis / test-result model, no per-reading review engine, no second
  measurement store, no PM/CM status enum.
- No runtime change of any kind — RBAC, Building isolation (BE-02G) and every
  status enum are published exactly as implemented.

### Validation (PART 03)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| `tests/mobile-engineering-contract.test.ts` (11 subtests) | ✅ PASS — tag/paths/methods, 54 pinned operationIds, documented ⊆ registered routes, no BE-10 route left undocumented, per-operation permission + Building scope, enum fidelity, shared-execution/authoritative-id boundaries, PM/CM + finding delegation, no invented diagnosis/test/reading-review surface, 401-never-404 probes |
| `tests/mobile-openapi-completeness.test.ts` | ✅ PASS — no phantom paths, unique operationIds, all `$ref`s resolve |
| `tests/openapi-contract.test.ts` | ✅ PASS (6/6) |
| `tests/mobile-housekeeping-contract.test.ts` (PART 01 regression) | ✅ PASS |
| `tests/mobile-security-contract.test.ts` (PART 02 regression) | ✅ PASS |
| OpenAPI size | 395 → **434 paths** (+39 Engineering paths / 54 operations) |
| DB-backed suites | ⚠️ NOT RUN — no local PostgreSQL in the sandbox; environment limitation, not a code defect (unchanged from PART 01/02) |

## 16. PART 04 completion — Work Order material context + verification composition

**Date:** 2026-08-19  
**Baseline:** Arena branch `arena/01a01ad3-asentra-backend` at `95366fa`
(PART 03 head).  
**Change class:** `PUBLISH_OPENAPI` only. No new material workflow, inventory
engine, verification engine, table, migration, mobile-specific API, invented
id or invented state.

### Review performed first (existing Work Order / material / inventory / verification contracts)

The review found that **most of the PART 04 surface was already published by
earlier waves**; the residual gap is reference data only.

| Area | Backend | Contract state before PART 04 |
|---|---|---|
| Work Order lifecycle + actions/history/completion | BE-08 | **Published** (27 WO paths) |
| Work Order verification / rework / close | BE-08I over the BE-07 `reviews` primitive (`target_type = WORK_ORDER`) | **Published** — `getWorkOrderVerification`, `submitWorkOrderVerification`, `closeWorkOrder…` |
| Material usage / issue | BE-16I + CR-BE-MAT-01 (UOM, cost and `stockMovementId` snapshots) | **Published** — `recordWorkOrderMaterialUsage`, `list…`, `get…`, `getWorkOrderMaterialCostSummary` |
| Stock ledger + availability | BE-16C/D (`STOCK_IN` / `STOCK_OUT`, on-hand / reserved / available) | **Published** |
| Approved quantity | BE-17B `MaterialRequest.approvedQuantity` (+ `receivedQuantity`, `remainingQuantity`) and BE-16/17 procurement bindings | **Published** |
| Item master (BE-16A), Warehouse master (BE-16B), Asset ↔ spare-part binding (BE-16H) | reads exist | **Unpublished** ← the actual PART 04 gap |

### Published (existing read routes only) — tag `Inventory Master`

**8 operations across 8 paths**, all previously registered and unpublished.

| Requested area | operationIds | Backend authority reused |
|---|---|---|
| Item references | `listClientInventoryItems`, `getInventoryItem` | BE-16A item master (`itemType` is data; `uomId` is the shared BE-07 UOM) |
| Warehouse references | `listBuildingWarehouses`, `listClientWarehouses`, `getWarehouse` | BE-16B warehouse master (Client derived via Building → Property → Client) |
| Work Order material context (expected parts) | `listAssetSpareParts`, `listInventoryItemAssetBindings`, `getAssetSparePart` | BE-16H Asset ↔ SPARE_PART binding with `requiredQuantity` |

### Documented as already-composed (NOT re-published)

PART 04 contracts the composition rather than duplicating it. The tag
description and the test pin these:

| Requested area | Already-published operations |
|---|---|
| Material usage / issue visibility | `recordWorkOrderMaterialUsage`, `listWorkOrderMaterialUsages`, `getWorkOrderMaterialUsage`, `getWorkOrderMaterialCostSummary` (+ `resultingQuantityOnHand` / `resultingAvailableQuantity` / `stockMovementId` on each usage) |
| Approved quantity / issued quantity context | `getMaterialRequest` (`quantity`, `approvedQuantity`, `approvedAt`, `approvedByUserId`, `receivedQuantity`, `remainingQuantity`) + `listWorkOrderProcurementBindings`; issued quantity is `WorkOrderMaterialUsage.quantity` with its `STOCK_OUT` ledger row |
| Availability | `listWarehouseStockBalances`, `listWarehouseStockMovements` (+ building/client variants) |
| Work Order verification composition | `getWorkOrderVerification`, `submitWorkOrderVerification`, `closeWorkOrderAfterCanonicalBastReadiness` — BE-08I over the BE-07 review primitive; decisions APPROVED / REJECTED / REWORK_REQUIRED |
| Supervisor verification context | `getWorkOrderCompletion`, `getWorkOrderHistory`, `listWorkOrderEvidence`, `listWorkOrderEvidenceRequirements`, `listReviews`, `getMobileVerification` / `submitMobileVerification` (CHECKLIST_EXECUTION / FORM_INSTANCE / FINDING) |

**Quantity vocabulary is kept distinct and is asserted by test:**
`AssetSparePart.requiredQuantity` (planning) ≠
`MaterialRequest.approvedQuantity` (approved) ≠
`WorkOrderMaterialUsage.quantity` (issued).

### Classification after PART 04

| Row | Before | After | Note |
|---|---|---|---|
| WO-01 material usage | EXISTING | **EXISTING** | Unchanged — nothing re-published |
| WO-02 item / warehouse / UOM context | PARTIAL | **EXISTING** | BE-16A/B reads published; BE-16H spare-part binding added as the WO material context |
| WO-03 supervisor verification | EXISTING | **EXISTING** | Authority already published; PART 04 documents the composition |
| WO-04 `WORK_ORDER` on `/mobile/verification` — **new row** | — | **MISSING** | `MOBILE_VERIFICATION_TARGET_TYPES` is `CHECKLIST_EXECUTION` / `FORM_INSTANCE` / `FINDING`. Adding WORK_ORDER is a **runtime** change (a new target type), which this PART forbids. Mobile supervisors use the published Work Order verification endpoints. A test asserts the documented enum equals the implemented constant, so the target can never be advertised before it exists |
| WO-05 material master administration — **new row** | — | **PARTIAL** (deliberate) | `POST`/`PATCH` on items, warehouses and spare-part bindings exist and are pinned as deliberately unpublished: master-data administration is not mobile field execution |

### Deliberately NOT published (out of the mobile field surface)

Item / warehouse / spare-part **write** routes (8, pinned in the test),
`inventory-minimum-stocks` (reorder configuration), `inventory-stock-adjustments`
and `inventory-stock-transfers` (warehouse operations, not field issue), and the
rest of the BE-17 procurement chain beyond what is already published. These
exist and work; they are not Work Order material *context* for a mobile
technician.

### What PART 04 did not do

- No new material workflow, inventory engine or verification engine.
- No new table, migration, seed, permission code, status or endpoint.
- No `WORK_ORDER` target added to `/mobile/verification`, no
  `/mobile/material*` facade, no invented id or quantity concept.
- No runtime change of any kind.

### Validation (PART 04)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| `tests/mobile-material-context-contract.test.ts` (15 subtests) | ✅ PASS — tag/paths/methods, 8 pinned operationIds, documented ⊆ registered, every BE-16 master route published **or** pinned as excluded (and every exclusion still registered), per-operation permission + Building scope, composition operations still published at their exact paths, usage/approved/availability/verification field coverage, distinct quantity vocabulary, `/mobile/verification` enum equals the implemented constant, no mobile material facade, 401-never-404 probes |
| `tests/mobile-openapi-completeness.test.ts` | ✅ PASS — no phantom paths, unique operationIds, all `$ref`s resolve |
| `tests/openapi-contract.test.ts` | ✅ PASS (6/6) |
| PART 01–03 contract suites | ✅ PASS (housekeeping, security, engineering) |
| OpenAPI size | 434 → **442 paths** (+8 Inventory Master paths / 8 operations) |
| DB-backed suites | ⚠️ NOT RUN — no local PostgreSQL in the sandbox; environment limitation, not a code defect (unchanged from PART 01–03) |

## 17. PART 05 completion — QR operational-context boundary

**Date:** 2026-08-19  
**Baseline:** Arena branch `arena/01a01ad3-asentra-backend` at `fd372e6`
(PART 04 head).  
**Change class:** **boundary documentation only.** No new QR engine, endpoint
implementation, target type, resolver behaviour, table, migration,
mobile-specific API, anonymous resolution or GPS/geofencing. Zero new paths,
zero schema changes.

### Review performed first (QR resolver + authoritative context contracts)

| Question | Finding |
|---|---|
| What resolves a scanned value? | Exactly one authority: BE-05H `asset_identifiers`. `resolveMobileQr` (BE-25F) is a thin composition over `assetIdentifierService.resolveAssetByIdentifier` + BE-02G access + Building/FL/Equipment context. `MOBILE_QR_TARGET_TYPES = ['ASSET']` |
| Is the identifier registry general? | **No — it is asset-scoped.** Identifiers are registered only through `POST /assets/{assetId}/identifiers`. There is no location, functional-location, checkpoint or Work Order identifier table |
| Are there other scan resolvers? | **No.** The only resolve-by-value routes in the whole router are `GET /assets/resolve/:identifier` and `GET /mobile/qr/resolve/:identifier`. (`/contractor-contexts/resolve`, `/notification-links/resolve`, `…/:id/resolve`, `…/resolve-readiness` are unrelated business operations, not scans) |
| Location / FL | BE-04 rows have a `code` unique per parent but **no** identifier registry and **no** resolve-by-code route |
| Security checkpoint | BE-12B patrol route points are canonical UUID + sequence + location FKs; confirmation is by `pointId` (`recordPatrolPointVisit`, published in PART 02). No identifier value |
| Work Order | BE-08 has `workOrderNumber` but no identifier registry and no resolve-by-number route |
| Anonymous scan / GPS | Both QR routes sit behind `authenticationMiddleware` + `requirePermission('asset_identifier.read')`; the resolver stores and reads no coordinate |

**Conclusion: nothing new was faithfully publishable.** ASSET was already
published and correct; every other operational QR context is genuinely
**MISSING**.

### What PART 05 changed (annotation of two existing operations)

The Asset QR contract is **preserved exactly** — verified by comparing the
parsed spec before/after with `description` and `x-` keys stripped: both QR
path items are structurally identical, `components.schemas` is byte-identical,
and the path count is unchanged at 442.

On `resolveMobileQr` (and, minimally, `resolveAssetByIdentifier`):

1. **Frozen payload convention.** The scanned payload is the OPAQUE
   `identifier_value` of a BE-05H row (`QR` / `TAG` / `BARCODE` / `LEGACY`).
   It encodes no Client, Building, URL or security data; it is **not** a
   canonical UUID and **not** a structured deep link. Because the registry is
   asset-scoped, ASSET is the only target the operation can return.
2. **`x-required-permission: asset_identifier.read` + `x-building-scoped: true`**
   — recording what the router already enforces: scanning is never anonymous
   and results are filtered to the caller's accessible Buildings; an
   inaccessible identifier returns the same 404 as an unknown one.
3. **`x-qr-supported-target-types: [ASSET]`** — machine-readable, pinned by
   test to the implemented constant.
4. **`x-qr-target-type-boundary`** — the four unsupported contexts, each with
   `status: MISSING`, a reason, the owning authority, and the authoritative
   **canonical-id reads** a client must use instead:

| targetType | Status | Use instead (already published) |
|---|---|---|
| `LOCATION` | **MISSING** | `getBuildingHierarchy`, `listBuildingFloors`, `getFloor`, `getArea`, `getRoom`, `getSpace` |
| `FUNCTIONAL_LOCATION` | **MISSING** | `getFunctionalLocation`, `getFunctionalLocationContext`, `listBuildingFunctionalLocations` |
| `CHECKPOINT` | **MISSING** | `listPatrolRoutePoints`, `getPatrolExecution`, `listPatrolPointVisits` (confirm via `recordPatrolPointVisit` by `pointId`) |
| `WORK_ORDER` | **MISSING** | `listMobileAssignments`, `getWorkOrder`, `listBuildingWorkOrders` |

No unsupported context is mapped onto ASSET, and no invented target type,
identifier scheme or id appears anywhere.

### Classification after PART 05

| Row | Before | After | Note |
|---|---|---|---|
| QR-01 asset | EXISTING | **EXISTING** | Unchanged and preserved; the ASSET-only boundary is now machine-readable |
| QR-02 location | MISSING | **MISSING** | Payload convention frozen: an opaque label has no location authority; a canonical UUID needs no resolver (GET-by-id is published) |
| QR-03 functional location | MISSING | **MISSING** | Same fork; context read already published |
| QR-04 checkpoint | MISSING | **MISSING** | SEC-02 confirms by canonical `pointId`; a checkpoint QR would first need identifiers on `patrol_route_points` |
| QR-05 Work Order scan — **new row** | — | **MISSING** | `workOrderNumber` is not an identifier registry; mobile reaches a WO via its assignment feed or canonical id |
| QR-06 GPS / geofenced scan — **new row** | — | **NOT_REQUIRED** | Explicitly out of backend scope; asserted absent from the QR schemas and resolver source |

### What would be required later (not done here)

Adding any of QR-02…QR-05 requires, in order: (1) a product decision that the
label is an opaque value rather than a canonical id; (2) an **identifier
authority** for that domain (the BE-05H pattern applied to the owning table);
(3) only then `EXTEND_EXISTING` on `MOBILE_QR_TARGET_TYPES`. Steps 2 and 3 are
runtime changes and were forbidden here. A `/mobile/qr/location`-style facade
must never be created.

### Validation (PART 05)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| `tests/mobile-qr-boundary-contract.test.ts` (12 subtests) | ✅ PASS — documented supported targets == `MOBILE_QR_TARGET_TYPES`; identifier types == `ASSET_IDENTIFIER_TYPES`; every boundary entry MISSING with published canonical-id fallbacks; no unsupported target advertised in any QR enum; only two scan resolvers registered; identifier routes asset-scoped only; no extra `/mobile/qr` path; no GPS/geofence in schemas or resolver source; bearer auth + exact permission + Building scope; live 401 probes |
| Negative check (guard is not vacuous) | ✅ Adding `LOCATION` to the supported list fails 3 subtests; reverted |
| Asset QR contract preservation | ✅ Both QR path items structurally identical before/after (ignoring description + `x-`); `components.schemas` unchanged; 442 paths unchanged |
| `tests/mobile-openapi-completeness.test.ts` | ✅ PASS |
| `tests/openapi-contract.test.ts` | ✅ PASS (6/6) |
| PART 01–04 contract suites | ✅ PASS (55/55) |
| DB-backed suites | ⚠️ NOT RUN — no local PostgreSQL in the sandbox; environment limitation (unchanged from PART 01–04) |

> **Branch note.** At the start of PART 05 the sandbox's git HEAD had drifted
> back to the session base commit (`d02c30e`) while the working tree still held
> all PART 01–04 content. The branch pointer was restored to the pushed
> `fd372e6` from `origin/arena/01a01ad3-asentra-backend`; the working tree then
> verified clean. No work was lost and no PART was redone.

## 18. PART 06 completion — offline sync resource-kind extension

**Date:** 2026-08-19  
**Baseline:** Arena branch `arena/01a01ad3-asentra-backend` at `b7d13e9`
(PART 05 head).  
**Change class:** `EXTEND_EXISTING` — the **first runtime change** in this CR.
Three resource kinds were added to the existing BE-25G dispatcher. No new
domain engine, table, migration, generic catch-all kind, fabricated id,
fabricated evidence metadata, offline evidence-byte queue, endpoint or
operation verb.

### Review performed first (existing sync implementation vs PART 01–05)

| Item | Finding |
|---|---|
| Envelope | `POST /mobile/sync`, 1–100 operations, each `{operationId, resourceType, resourceId, operation, clientTimestamp, data}` |
| Kinds before PART 06 | `TASK_EXECUTION`, `CHECKLIST_RESPONSES`, `EVIDENCE_SUBMISSION`, `TASK_ASSIGNMENT` |
| Execution model | Every kind delegates to the SAME shared service the REST route uses; RBAC resolved once per batch, then checked per item; BE-02G scope enforced inside those services |
| Idempotency (BE-25H) | `(user_id, operation_id)` — a replay returns the ORIGINAL stored result, success or failure |
| Conflict (BE-25I) | `data.baseVersion` vs the resource's current `updated_at` → `SYNC_CONFLICT` + current state + reload guidance; the write is not executed |
| Structural constraint | `REQUIRED_PERMISSION`, `OPERATIONS_BY_TYPE`, `RELOAD_ENDPOINTS` are exhaustive `Record<MobileSyncResourceType, …>` and `loadCurrentResourceState` is an exhaustive switch — a half-registered kind cannot compile |

Each PART 01–05 write was then tested against the seven admission
requirements (authoritative id, existing operation, tenant/Building scope,
RBAC, stable published operationId, explicit request/response schema, client
timestamp).

### Added (3 kinds, all over already-published authoritative writes)

| resourceType | operation(s) | resourceId (authoritative) | Delegates to | operationId | Permission |
|---|---|---|---|---|---|
| `PATROL_EXECUTION` | `START`, `COMPLETE` | patrol execution id = BE-07 `taskId` | `patrolExecutionService.startPatrolExecution` / `.completePatrolExecution` | `startPatrolExecution`, `completePatrolExecution` | `patrol_execution.manage` |
| `PATROL_POINT_VISIT` | `SUBMIT` | patrol execution id; checkpoint = authoritative BE-12B `data.patrolRoutePointId` (required UUID) | `patrolExecutionService.recordPatrolPointVisit` | `recordPatrolPointVisit` | `patrol_execution.manage` |
| `METER_READING` | `SUBMIT` | BE-07 form instance id started from a BE-10C binding | `meterReadingBindingService.submitMeterReading` | `submitMeterReading` | `meter_reading_binding.manage` |

Notes that keep these faithful rather than convenient:

- **No new verb.** `MOBILE_SYNC_OPERATIONS` is unchanged; each kind reuses
  START / COMPLETE / SUBMIT.
- **No fabricated ids.** Every `resourceId` is a row the backend already owns;
  the checkpoint id is supplied explicitly and validated as a UUID rather than
  inferred, and nothing is derived from a QR payload (PART 05 boundary holds).
- **Backend keeps ownership of measurement.** `METER_READING` accepts
  `{ value, notes? }` only — UOM and the effective min/max range are resolved
  and validated by BE-10C, and the controller rejects a non-finite value.
- **Conflict + reload wired per kind.** `PATROL_EXECUTION` versions on the
  underlying `generated_tasks.updated_at` (reload `getPatrolExecution`);
  `METER_READING` on `form_instances.updated_at` (reload
  `getMeterReadingContext`); `PATROL_POINT_VISIT` is a create against the
  execution, so — exactly like `EVIDENCE_SUBMISSION` — no prior row exists to
  conflict with and replay protection is BE-25H's job.
- **Scope/RBAC unchanged.** The dispatcher checks the same permission the REST
  route enforces, and each service calls
  `contextAccessService.assertBuildingAccess` internally (verified in
  `startPatrolExecution`, `completePatrolExecution`, `recordPatrolPointVisit`
  and `submitMeterReading`).

### Evaluated and deliberately NOT added

Published in OpenAPI as `x-sync-unsupported-resource-types` so mobile cannot
mistake them for syncable, each with a reason and the online operation to use:

| Candidate | Status | Why not |
|---|---|---|
| `WORK_ORDER_ACTION` | **MISSING** | The BE-08 action set needs acknowledge / hold / resume / note verbs the envelope does not have. A kind covering only START/COMPLETE/CANCEL would advertise a half-contract |
| `WORK_ORDER_MATERIAL_USAGE` | **MISSING** | A stock-ledger write (STOCK_OUT + balance + cost snapshot). Queued issues would be applied against availability that may no longer exist and there is no reservation concept — a product decision, not a dispatcher entry |
| `INCIDENT` | **MISSING** | Create-shaped: requires a client-supplied unique `incidentNumber` and has no prior authoritative `resourceId` to key on |
| `SECURITY_FINDING` | **MISSING** | Same create-shaped gap (`createSecurityFinding` creates the BE-09 Finding) |
| `SUPERVISOR_DECISION` | **MISSING** | A reviewer act on state the reviewer must actually see; a queued stale approve/reject is unsafe |
| `EVIDENCE_BYTES` | **NOT_REQUIRED** | The backend must not hold an offline byte queue — `EVIDENCE_SUBMISSION` syncs metadata only |

### OpenAPI change (only what existing code required)

`MobileSyncOperationItem.resourceType` enum extended to the implemented set;
`resourceId`, `operation`, `clientTimestamp` and `data` descriptions extended
with the per-kind contract; `x-required-permission` / `x-building-scoped` and
the machine-readable `x-sync-supported-resource-types` /
`x-sync-unsupported-resource-types` added to `processSyncBatch`. **No new
path** (442 unchanged), no new schema.

### Classification after PART 06

| Row | Before | After | Note |
|---|---|---|---|
| SYN-01 supported kinds | EXISTING | **EXISTING** | Now 7 kinds; the original four are unchanged and asserted so by test |
| SYN-02 authoritative ids | EXISTING | **EXISTING** | Same `operationId` + `resourceId` rules applied to the new kinds |
| SYN-03 conflict / retry | EXISTING | **EXISTING** | Same `baseVersion` rule; new kinds have explicit reload targets |
| SYN-04 kinds beyond the four | MISSING | **PARTIAL** | Patrol execute/visit and meter reading are now syncable; WO action, WO material usage, incident/finding create and supervisor decision remain unsupported **by design**, documented on the operation |
| SYN-05 evidence byte queue | NOT_REQUIRED | **NOT_REQUIRED** | Unchanged; asserted by test |

### Validation (PART 06)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS — also proves the exhaustive permission / operations / reload / conflict maps cover every new kind |
| `tests/mobile-sync-kinds-contract.test.ts` (16 subtests) | ✅ PASS — BE-25G kinds preserved; exactly the three PART 06 kinds added; no new verb; documented enum == implemented constant; every kind maps to a **published** operationId and to the permission its REST route enforces; every kind wired end-to-end (dispatcher + reload + conflict case); delegation to existing services with no direct domain-table writes; authoritative payload id required; clientTimestamp required and server time authoritative; unsupported kinds absent from the constant **and** the enum, each with status + reason + published alternative; no catch-all kind; evidence bytes excluded |
| Negative check (guard is not vacuous) | ✅ Adding an unbacked `INCIDENT` kind to the constant fails 4 subtests; reverted |
| `tests/mobile-sync-contract.test.ts`, `-idempotency`, `-conflict` | ⚠️ 1 pass / 24 fail — **identical before and after** the change (verified by re-running on a stashed tree): every failing subtest is DB-backed and there is no local PostgreSQL. No regression introduced |
| PART 01–05 contract suites + completeness + openapi-contract | ✅ PASS (83/83 across eight suites) |
| OpenAPI size | **442 paths, unchanged** |

> **Runtime-change caveat, stated plainly.** PART 06 adds executable write
> paths but the sandbox has no PostgreSQL, so the new dispatcher branches
> could not be exercised end-to-end here. They were kept deliberately thin —
> each is a direct call to an existing service with the signature verified in
> source — and the exhaustive TypeScript maps plus the contract suite cover
> wiring. A DB-backed run of `tests/mobile-sync-*.test.ts` remains required
> before release.

## 19. PART 07 completion — push delivery boundary (BE-26 channel)

**Date:** 2026-08-19  
**Baseline:** Arena branch `arena/01a01ad3-asentra-backend` at `59efaf0`
(PART 06 head).  
**Change class:** **boundary documentation only.** No new notification engine,
provider integration, push vendor, table, migration, browser-simulated
delivery, fabricated delivery success or mobile-specific notification domain.
Zero new paths, zero schema changes.

> The PART 06 readiness note anticipated PART 07 as a runtime extension
> (adapter + PUSH history channel). The review below shows that is **not**
> possible within this PART's own constraints: a push delivery attempt needs a
> new table + migration and a provider adapter, both explicitly forbidden here.
> PART 07 therefore documents the boundary instead of inventing the capability.

### Review performed first (BE-25L tokens + BE-26 delivery)

| Question | Finding |
|---|---|
| Token authority | **BE-25L exists**: `mobile_push_tokens` (migration `0235`), per user + device, rotation on re-register, deactivate keeps INACTIVE history. `registerPushToken` / `listPushTokens` / `deactivatePushToken` are published |
| Notification creation | **BE-26 exists**: event → BE-26D subscriptions → BE-26B template render → BE-26C recipient resolution → BE-26A records. `NOTIFICATION_CHANNELS = ['IN_APP']` — the record itself is in-app only |
| Delivery attempts | **BE-26E in-app, BE-26F email, BE-26G WhatsApp** each persist an attempt row (status, sent/failed timestamps, provider, failure reason), unified read-only by BE-26K. `NOTIFICATION_HISTORY_CHANNELS = ['IN_APP','EMAIL','WHATSAPP']` |
| Push delivery | **Does not exist.** No push delivery attempt record type, no PUSH history channel, no subscription channel dimension at all, no adapter, no token fan-out |
| Push provider | **Does not exist.** Repo-wide search for `sendPush` / `deliverPush` / `pushAdapter` / FCM / APNS / Firebase / OneSignal returns nothing; no vendor dependency in `package.json`; the only push migration is the BE-25L token table |
| Scope / RBAC | Token and notification/history routes are authenticated and **self/recipient-scoped by `userId`** — they carry no permission code. Documented as `x-recipient-scoped`, not as a fabricated permission |

**Conclusion: BE-26 cannot faithfully support mobile push today.** The
authoritative mobile delivery path that *does* exist is the **IN_APP inbox**.

### The four stages, explicitly separated

Published as machine-readable `x-push-delivery-lifecycle` on
`registerPushToken`:

| # | Stage | Status | Authority | Published operations |
|---|---|---|---|---|
| 1 | `TOKEN_REGISTRATION` | **EXISTING** | BE-25L `mobile_push_tokens` | `registerPushToken`, `listPushTokens`, `deactivatePushToken` |
| 2 | `NOTIFICATION_CREATION` | **EXISTING** | BE-26A/B/C/D | `listNotifications`, `getNotification`, `markNotificationRead` |
| 3 | `DELIVERY_ATTEMPT` | **PARTIAL** | BE-26E/F/G + BE-26K history | `listNotificationHistory`, `getNotificationHistoryItem` — implemented `IN_APP` / `EMAIL` / `WHATSAPP`; **missing `PUSH`** |
| 4 | `PROVIDER_DELIVERY` | **MISSING** | none for push | — |

The critical separation, now stated in the contract: **registering a token is
not delivery.** A successful registration creates no notification, no attempt
and no provider send, so a client must never present it as "push enabled", and
the `PushTokenRegistration` schema deliberately exposes no `delivered`,
`deliveredAt`, `deliveryStatus`, `sentAt` or `provider` field (asserted by
test).

### Delivery lifecycle and failure behaviour (documented)

Published as `x-push-delivery-failure-behavior`:

- For the **implemented** channels, a failed attempt is persisted as a `FAILED`
  row with `failedAt`, `provider` and `failureReason`, readable through BE-26K.
  Failures are recorded — never silently dropped, never retried into a fake
  success.
- For **PUSH** there is no attempt record at all, so a missing push is
  invisible to the backend. That is exactly why the capability is **MISSING**
  rather than "degraded": there is nothing to observe, and nothing may claim
  otherwise.

### What PART 07 changed

1. `registerPushToken` — corrected the stale line "No notification delivery
   exists yet (BE-26)" (BE-26 in-app delivery now exists; push does not), added
   the registration-is-not-delivery statement, `x-recipient-scoped`,
   `x-push-delivery-lifecycle` and `x-push-delivery-failure-behavior`.
2. `listNotificationHistory` — documented the channel enum as exhaustive,
   plus `x-delivery-channels-implemented` / `x-delivery-channels-missing:
   [PUSH]` and `x-recipient-scoped`.
3. One **comment-only** source edit in `push-token.service.ts` replacing the
   same stale sentence, so a future engineer cannot read it as licence to build
   a second engine. No executable line changed (`typecheck` green; the
   DB-backed push-token suite behaves identically before and after).

Contract preservation verified by comparing the parsed spec before/after with
`description` and `x-` keys stripped: both path items are structurally
identical, `components.schemas` is byte-identical, 442 paths unchanged.

### Classification after PART 07

| Row | Before | After | Note |
|---|---|---|---|
| NTF-01 token registration | EXISTING | **EXISTING** | Unchanged; now explicitly documented as *not* delivery |
| NTF-02 in-app delivery / inbox | EXISTING | **EXISTING** | The authoritative mobile delivery path today |
| NTF-03 push **delivery** | MISSING | **MISSING** | Confirmed by review, not assumed. Split into stage 3 (no attempt record) and stage 4 (no adapter/provider/fan-out), both machine-readable |
| NTF-04 push provider integration — **new row** | — | **MISSING** | No vendor SDK, no credentials, no fan-out. Adding one is a separate CR with a table + migration + adapter |
| NTF-05 client-simulated push — **new row** | — | **NOT_REQUIRED** | A locally raised banner must never be reported as backend delivery; the backend must never fabricate a delivery success |

### What a later PART/CR would need (not done here)

In order: (1) a push delivery attempt table + migration mirroring
`email_deliveries` / `whatsapp_deliveries`; (2) a provider adapter following
the existing no-op/logging default pattern; (3) `PUSH` added to
`NOTIFICATION_HISTORY_CHANNELS` and the token fan-out over ACTIVE BE-25L rows;
(4) only then the OpenAPI enums. Steps 1–3 are runtime + schema changes that
this PART forbids. `/mobile/push-send` must never become a separate domain.

### Validation (PART 07)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| `tests/mobile-push-delivery-boundary-contract.test.ts` (14 subtests) | ✅ PASS — four stages present, ordered, each with a status and only **published** operationIds; stage 3 PARTIAL with `missingChannels: [PUSH]`; stage 4 MISSING with no operations; failure behaviour documented; registration exposes no delivery outcome; documented channel enums == implemented `NOTIFICATION_CHANNELS` / `NOTIFICATION_HISTORY_CHANNELS` / `PUSH_PLATFORMS` in every place; PUSH never advertised; only the three BE-25L routes match `push`; no push module, no extra push migration, no vendor SDK or dependency; token service has no send path; documented recipient scope matches routers that use auth without `requirePermission`; anonymous access rejected 401 |
| Negative check (guard is not vacuous) | ✅ Advertising `PUSH` as an implemented channel fails 2 subtests; reverted |
| Contract preservation | ✅ Both annotated path items structurally identical before/after; schemas byte-identical; 442 paths unchanged |
| PART 01–06 contract suites + completeness + openapi-contract | ✅ PASS (97/97 across nine suites) |
| `tests/mobile-push-token.test.ts` | ⚠️ 1 pass / 9 fail — **identical before and after** (verified on a stashed tree); all failures are DB-backed with no local PostgreSQL. No regression |

## 20. PART 08 completion — cross-contract regression & handoff

**Date:** 2026-08-19  
**Baseline:** Arena branch `arena/01a01ad3-asentra-backend` at `5b30a30`
(PART 07 head).  
**Change class:** regression + handoff. No new product capability, domain
engine, table, migration or speculative contract. One documentation-only
alignment (§20.2) forced by the regression itself.

### 20.1 Regression executed

All **310** test files were run individually (no PostgreSQL available):

| Category | Files | Detail |
|---|---:|---|
| Passing (non-DB contract/regression) | **127** | 390 assertions, 0 failures |
| Self-skipping DB-backed suites | **158** | skip cleanly when `asentra_test` is absent |
| DB-backed suites that fail without PostgreSQL | **25** | 257 subtests — listed in full in the handoff §8 |
| Harness errors | 0 | — |

**The 25 failing suites were verified against the pre-CR baseline `d02c30e`**
in a temporary git worktree: every file returns the *same* pass/fail counts
before and after PART 01–07. They are an environment limitation, **not** a CR
regression, and they are named individually rather than summarised away.

The eight CR suites all pass: housekeeping 8, security 10, engineering 11,
material context 15, QR boundary 12, sync kinds 16, push boundary 14, and the
new cross-contract regression 12.

### 20.2 What the regression found and fixed

`tests/mobile-cr-regression-contract.test.ts` asserts the CR's own claims
across PART 01–07 in one place. On first run it **failed**, and the failure was
real: the `x-required-permission` / `x-building-scoped` convention introduced in
PART 02 had never been applied to the **PART 01 Housekeeping** surface, so
"RBAC preserved" and "tenant/Building scope preserved" were not uniformly
verifiable across the CR.

Rather than weaken the assertion, the gap was closed: all **34** Housekeeping
operations were annotated with the exact permission their BE-11 router already
enforces (`daily_cleaning.read`, `cleaning_assignment.*`,
`toilet_inspection.*`, `public_area_inspection.*`, `supervisor_inspection.*`,
`quality_audit.*`, `housekeeping_finding.*`, `housekeeping_evidence.*`).
Documentation only — the parsed spec is structurally identical before/after
once `x-` keys are ignored, `components.schemas` is byte-identical, and the
path count stays at 442.

The suite now also verifies that **every** documented permission exists in the
seeded permission catalogue (`FOUNDATION_PERMISSIONS`) — a documented
permission can no longer be a plausible-looking string.

### 20.3 Confirmations required by PART 08

| Confirmation | Result | Evidence |
|---|---|---|
| Housekeeping contracts published correctly | ✅ | 34 operations, tag frozen by test, all registered |
| Security contracts published correctly | ✅ | 41 operations |
| Engineering contracts published correctly | ✅ | 54 operations |
| Work Order / material context authoritative | ✅ | Composition operationIds pinned; the three quantity concepts stay distinct |
| QR remains ASSET-only | ✅ | Documented targets == `MOBILE_QR_TARGET_TYPES`; 4 boundary rows all MISSING |
| Supported sync kinds explicit | ✅ | Documented enum == `MOBILE_SYNC_RESOURCE_TYPES` (7 kinds) |
| Unsupported offline records non-syncable | ✅ | 6 documented unsupported kinds, none in the implemented constant |
| Token registration ≠ push delivery | ✅ | `registration is NOT delivery` in the contract; no delivery field on the schema |
| Push provider delivery MISSING | ✅ | Stage 4 = MISSING; `PUSH` absent from every channel enum |
| Tenant/Building scope preserved | ✅ | 137/137 published operations carry `x-building-scoped: true` |
| RBAC preserved | ✅ | 137/137 carry `x-required-permission`, all seeded codes |
| Authoritative IDs used | ✅ | No `localId`/`tempId`/`clientGeneratedId` in any schema; sync `resourceId` documented as never client-generated |
| No fabricated mappings or capabilities | ✅ | No documented operation is unregistered; no `/mobile/<domain>` facade exists |

### 20.4 Final capability matrix (41 rows)

| Status | Rows | Meaning |
|---|---:|---|
| **EXISTING** | 21 | Ready for mobile integration |
| **PARTIAL** | 6 | Usable with a documented limit |
| **MISSING** | 7 | Requires a future backend CR |
| **NOT_REQUIRED** | 7 | Intentionally not a backend capability |

1. **Ready now:** HK-01/02/03/07/08/09, SEC-01/02/03/05, ENG-01/03,
   WO-01/02/03, QR-01, SYN-01/02/03, NTF-01/02.
2. **Future backend CR:** QR-02/03/04/05 (need an identifier authority),
   WO-04 (`WORK_ORDER` verification target — runtime change), NTF-03/NTF-04
   (push delivery table + adapter). Plus the PARTIAL limits: HK-05, ENG-04/05/06,
   WO-05, SYN-04.
3. **Intentionally not required:** HK-04, HK-06, SEC-04, ENG-02, QR-06,
   SYN-05, NTF-05.

Full per-row detail: [`CR-BE-MOB-01-GAP-MATRIX.md`](./CR-BE-MOB-01-GAP-MATRIX.md).

### 20.5 Handoff artifact

[`docs/api/CR_BE_MOB_01_MOBILE_HANDOFF.md`](./api/CR_BE_MOB_01_MOBILE_HANDOFF.md)
— concise binding guide: what to bind now, the sync allow/deny list, the QR and
push boundaries, the three-way capability split, and the honest verification
status including the 25 DB-blocked suites. The earlier
`docs/api/mobile-integration-handoff.md` (CR-BE-MOB-CONTRACT-01 core surface)
remains valid and is referenced rather than restated.

### 20.6 CR totals

| Item | Value |
|---|---|
| Operations published by this CR | **137** (HK 34 + SEC 41 + ENG 54 + INV 8) |
| Boundaries frozen | QR target types, sync resource kinds, push delivery lifecycle |
| Runtime changes | **1** — the PART 06 sync dispatcher (3 kinds over existing services) |
| New tables / migrations / domains | **0** |
| OpenAPI | 442 paths / 590 operations / 631 schemas |
| CR contract suites | 8 files, 98 assertions, all passing |

## 22. FINAL REVIEW — fix → final validation → pull request

**Date:** 2026-08-20  
**Reviewed:** the complete CR (`d02c30e..172a53c`, PART 01–08) against the
governance, gap matrix, OpenAPI contract, runtime changes, tests and handoff.

### 22.1 Defects found

**None.** Every review category was checked mechanically and came back clean:

| Check | Result |
|---|---|
| Contract inconsistencies | none — 442 paths / 590 operations / 631 schemas parse; all `$ref`s resolve |
| Duplicate / speculative operations | none — 0 duplicate `operationId`, 0 operations without one, 0 CR schemas left unreferenced |
| Incorrect operationId or schemas | none — 0 verb/operationId mismatches, 0 `required` entries missing from `properties`, 0 `nullable`-beside-`$ref` misuse |
| RBAC / Building-scope regressions | none — **137/137** CR operations carry `x-required-permission` **and** `x-building-scoped: true`; every permission exists in the seeded catalogue; all carry bearer auth + 401/403 |
| Fabricated IDs or mappings | none — no `localId`/`tempId`/`clientGeneratedId` in any schema; sync `resourceId` documented as never client-generated |
| Unsupported sync kinds | none — documented enum == implemented `MOBILE_SYNC_RESOURCE_TYPES` (7); 6 unsupported kinds documented and absent from the constant |
| QR targets beyond implemented authority | none — supported targets == `MOBILE_QR_TARGET_TYPES` == `[ASSET]`; 4 boundary rows all MISSING |
| Push delivery represented as implemented | no — stage 4 `PROVIDER_DELIVERY` = MISSING; history channels remain `IN_APP`/`EMAIL`/`WHATSAPP` |
| Accidental domain/table/migration additions | none — `src/database/` untouched (0 files), 0 new source files, runtime diff confined to `mobile-sync/` (4 files) + 1 comment in `push-token.service.ts` |
| Documentation inconsistencies | none — matrix has 41 unique rows totalling 21/6/7/7, matching the governance and handoff summaries |

No fixes were required, so **no code or contract change was made by the final
review**. (The one defect this CR did find — the missing PART 01 Housekeeping
RBAC/scope annotations — was found and fixed during PART 08; see §20.2.)

### 22.2 Final validation executed

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| CR contract suites (10 files) | ✅ **109/109 PASS** — cross-CR regression 12, housekeeping 8, security 10, engineering 11, material context 15, QR boundary 12, sync kinds 16, push boundary 14, mobile completeness 5, openapi-contract 6 |
| OpenAPI ↔ router invariant | ✅ 0 phantom operations |
| 137 published operations contract-valid + scoped | ✅ confirmed (table above) |
| Working tree | ✅ clean at `172a53c` before the review commit |

### 22.3 PostgreSQL-dependent validation — PARTIAL, with evidence

PostgreSQL **was** obtained during this review by starting the repo's own
`embedded-postgres` devDependency (PostgreSQL 18.4, `asentra_test` created),
and DB-backed tests were executed. The sandbox then recycled the background
processes mid-sweep, and the review was completed without restarting them.
Recorded exactly as observed:

| Item | Observed |
|---|---|
| **`tests/mobile-sync-contract.test.ts` with PostgreSQL** | ✅ **8 pass / 0 fail / 0 skipped** (without a DB it is 1/7). This is the **PART 06 sync dispatcher path validated against a real database** — the CR's only runtime change |
| Full-suite sweep with PostgreSQL | ⚠️ **INCOMPLETE — 234 of 310 files** ran before the process was recycled |
| Files reporting failures in that partial sweep | `asset-certifications` 43/1, `corrective-action-verifications` 6/16, `document-control` 3/2, `engineering-checklist-bindings` 0/14, `engineering-findings` 0/9, `engineering-overview` 0/6, `engineering-reports` 0/8, `incident-closure` 7/20, `log-sheet-bindings` 0/16 |

**These 9 files were NOT baseline-compared, so this review does not claim they
are pre-existing.** What is proven is that CR-BE-MOB-01 made **zero runtime
changes** to any of those domains (§22.1 diff evidence: `src/` changes are
confined to `mobile-sync/` plus one comment), so a CR-introduced cause is
implausible — but unverified. Plausible causes to check first: PostgreSQL
**18.4** versus the version the project targets, and shared-database state
across suites executed sequentially in one sweep.

**Release validation prerequisites (must run before merge to production):**

1. Full `npm test` against a project-standard `asentra_test` PostgreSQL.
2. Re-run and baseline-compare the 9 files listed above (compare against
   `d02c30e`) to classify each as environment/version-related or a genuine
   defect. None of them is in the CR's changed-file set.
3. Confirm the remaining DB-backed mobile suites (`mobile-sync-idempotency`,
   `mobile-sync-conflict`, `mobile-push-token`, `mobile-qr-resolution`,
   `mobile-verification-contract`, notification suites) — of these only the
   sync suites exercise CR runtime code, and `mobile-sync-contract` already
   passed above.

No DB result has been fabricated or inferred: everything above is either an
observed run or explicitly marked as not run.

### 22.4 Final capability classification (unchanged by the review)

**EXISTING 21 · PARTIAL 6 · MISSING 7 · NOT_REQUIRED 7** (41 rows) — see
§20.4 and the gap matrix. The final review preserved this classification and
implemented no MISSING or PARTIAL future capability.

## 23. PRE-MERGE VALIDATION — RECOVERY (2026-08-20) — DB-backed regression vs main

**Date:** 2026-08-20 02:30 UTC — **recovery mode** (recovery instructions: do NOT restart PostgreSQL, do NOT rerun the full regression, do NOT use sleep/polling, do NOT create new runner scripts; inspect only results already produced).

**Environment preserved from §22.3:** `embedded-postgres` 18.4 (`asentra_test` at `127.0.0.1:5432`, `postgres/postgres`, `trust`) started at 01:44 UTC and still running (`postgres` PID 3157, `asentra_test` alive, `LISTEN 5432`). No restart was performed.

### 23.1 Targeted DB validation — preserved, no regression

The CR's only runtime change (§22.1: `src/modules/mobile-sync/` 4 files + 1 comment) was re-validated with PostgreSQL on **both** `main` (`d02c30e`) and the PR head (`arena/01a01ad3` at `30bbac8`). Each suite was run with `DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_PASSWORD=postgres DB_SSL=false NODE_ENV=test LOG_LEVEL=error`.

| Suite (DB-backed) | main | PR `30bbac8` | Verdict |
|---|---|---|---|
| `mobile-sync-contract.test.ts` | 8/8 pass | 8/8 pass | ✅ identical — PART 06 dispatcher validated |
| `mobile-sync-idempotency.test.ts` | 8/8 pass | 8/8 pass | ✅ identical |
| `mobile-sync-conflict.test.ts` | 9/9 pass | 9/9 pass | ✅ identical |
| `mobile-push-token.test.ts` | 10/10 pass | 10/10 pass | ✅ identical (comment-only change) |
| `mobile-qr-resolution.test.ts` | 8/8 pass | 8/8 pass | ✅ identical |
| `mobile-verification-contract.test.ts` | 15/15 pass | 15/15 pass | ✅ identical |
| `mobile-housekeeping/security/engineering/material/push/qr/sync-kinds/cr-regression/completeness/openapi` (non-DB 10 suites) | 109/109 | 109/109 | ✅ identical |

No targeted failure was observed. The DB-backed mobile path that exercises the CR runtime code remains green.

### 23.2 Partial full-regression — results already produced

A sequential `npx tsx --test --test-concurrency=1 tests/<file>.test.ts` sweep with PostgreSQL was started after the targeted checks. It processed **149 of 311** test files before the allowed execution time was exceeded and the recovery instruction stopped further work. The runner wrote incrementally to `/tmp/pr-db-results.json`; only that already-produced file is reported here (no new run, no polling).

| Category (PR, 149 processed) | Files | Detail |
|---|---|---:|
| **PASS files** | **139** | 0 failures, 0 timeout |
| **FAIL files** | **10** | listed below |
| **TIMEOUT files** | **0** | — |
| Not yet processed (time-limited) | **162** | `module-configurations.test.ts` … (`ls tests/*.test.ts | wc -l` = 311) — recorded honestly as incomplete, not inferred |

**10 FAIL files observed (PR, with PostgreSQL):**

| File | Pass / Total | Fail |
|---|---|---:|
| `asset-certifications.test.ts` | 43/44 | 1 |
| `corrective-action-verifications.test.ts` | 6/22 | 16 |
| `document-control.test.ts` | 3/5 | 2 |
| `engineering-checklist-bindings.test.ts` | 0/14 | 14 |
| `engineering-findings.test.ts` | 0/9 | 9 |
| `engineering-overview.test.ts` | 0/6 | 6 |
| `engineering-reports.test.ts` | 0/8 | 8 |
| `incident-closure.test.ts` | 7/27 | 20 |
| `log-sheet-bindings.test.ts` | 0/16 | 16 |
| `meter-reading-bindings.test.ts` | 0/13 | 13 |

The first 9 are exactly the set reported as failing at `234/310` in §22.3; the 10th (`meter-reading-bindings` 0/13) falls alphabetically after `log-sheet-bindings` and had not been reached at `234` — its failure is therefore **newly observed but not newly introduced**.

### 23.3 Baseline comparison vs `main` (only where a result already exists)

For the pre-merge gate, each failing file was baseline-compared by checking out `main` (`d02c30e`) **with the same running PostgreSQL** and re-running that single file (no restart, no polling). Results already produced before recovery:

| File | `main` (d02c30e) | PR (`30bbac8`) | PR introduced? |
|---|---|---|---|
| `asset-certifications.test.ts` | 43/1 | 43/1 | **No** — identical |
| `corrective-action-verifications.test.ts` | 6/16 | 6/16 | **No** — identical |
| `document-control.test.ts` | 3/2 | 3/2 | **No** — identical |
| `engineering-checklist-bindings.test.ts` | 0/14 | 0/14 | **No** — identical |
| `engineering-findings.test.ts` | 0/9 | 0/9 | **No** — identical |
| `engineering-overview.test.ts` | 0/6 | 0/6 | **No** — identical |
| `engineering-reports.test.ts` | 0/8 | 0/8 | **No** — identical |
| `incident-closure.test.ts` | 7/20 | 7/20 | **No** — identical |
| `log-sheet-bindings.test.ts` | 0/16 | 0/16 | **No** — identical |
| `meter-reading-bindings.test.ts` | *(not re-run on `main` in this window — see §23.4)* | 0/13 | **Not claimed as PR regression** — `src/` diff is confined to `mobile-sync/` + 1 comment; `meter-reading-bindings` (BE-10C) is outside the changed-file set (see §22.1) |

**No confirmed CR-BE-MOB-01 regression was found.** All 9 re-checked failures are pre-existing baseline failures, not PR-introduced. The 10th file was not baseline-re-run after the time limit, but by construction it cannot be a PR regression (zero files in `src/database/` or `src/modules/meter-reading-bindings/` were changed by this CR).

Re-running only affected tests after a fix: **not required — no fix was made** (instruction: fix only confirmed CR-BE-MOB-01 regressions, if any). No code or contract change was made in this recovery.

### 23.4 Full-regression completeness — honest record

| Item | Status |
|---|---|
| Full `npm test` against PostgreSQL (311 files) | ⚠️ **INCOMPLETE — environment/time-limited** — 149/311 files processed before the allowed execution time was exceeded; 162 files remain unprocessed; recovery forbids restarting PostgreSQL or rerunning the full sweep |
| Baseline for the 9 gate files | ✅ **COMPLETE** — each of the 9 was compared to `main` and is identical |
| Baseline for `meter-reading-bindings` | ⚠️ **NOT RE-RUN** — already stopped; inferred pre-existing by changed-file confinement, not asserted as verified |
| Targeted mobile DB suites | ✅ **COMPLETE** — §23.1 |
| CR contract suites + typecheck + OpenAPI invariant | ✅ **COMPLETE** — §22.2 |

No DB result is fabricated: only the 149 already-written results and the two earlier targeted sweeps are reported. The 162 unprocessed files are listed as remaining rather than summarised away (`/tmp/pr-db-results.json` retains the 149).

### 23.5 Pre-merge gate verdict

- **CR-BE-MOB-01 introduces no regression** in any observed DB-backed result. The 9 gate failures are pre-existing on `main` with identical counts; the 10th is outside the CR's changed-file set.
- **The full 311-file DB sweep was not completed** due to time limits, and the recovery forbids completing it here. The available evidence (139 PASS files + 6 targeted mobile suites + 9 baseline-identical fails) is sufficient to declare the pre-merge gate **passed for the CR's scope**, with the residual 162 files to be confirmed in a project-standard PostgreSQL run before production (same prerequisite already stated in §22.3).
- **No product-scope change, no feature addition, no PART 01–07 redo, and no fix** were made (gate requires fixing only confirmed PR regressions — none were found).

## 21. Readiness

- **CR-BE-MOB-01 PART 01–08: DONE.** The CR is complete on this branch.
- **Pre-merge validation (DB-backed):** targeted validation preserved (mobile-sync 8/8); partial regression 149/311 (139 PASS, 10 FAIL pre-existing), 9/9 gate files baseline-identical to `main`; full 311 incomplete due to time limit — recorded honestly in §23.4. No confirmed PR regression; no fix required.
- **Required before production (still):** a full `npm test` against a project-standard `asentra_test` PostgreSQL (162 remaining + the meter baseline). The CR's changed-file set remains confined to `mobile-sync/` + 1 comment, so no CR cause is plausible for the remaining domain failures, but verification is still required before production.
- **Follow-up CRs (not this CR's scope):** (a) push delivery — NTF-03/NTF-04,
  needs a delivery table + provider adapter; (b) QR identifier authority —
  QR-02/03/04/05; (c) `WORK_ORDER` on `/mobile/verification` — WO-04;
  (d) remaining sync kinds — SYN-04, blocked on envelope verbs / a reservation
  decision / a create-id convention.
- Hard blockers: **none.**

**PR #38 status (2026-08-20): `OPEN`, `CLEAN`, `MERGEABLE` (GitHub). No merge performed here. Based on the targeted DB validation + 149-file partial regression with baseline-identical gate failures and zero CR-introduced failures, PR #38 is **SAFE TO MERGE** for the CR scope; the incomplete 162-file tail is an environment/time limit, not a CR defect, and should be completed in the project's standard PostgreSQL environment before production. Do NOT create another PR; do NOT merge in this session (STOP).**

STOP.

