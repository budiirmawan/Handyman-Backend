# API Contract Checkpoint 01 — BE-00 … BE-23

> **Type:** Contract audit only. No new business capability, no BE-24, no CR, no Web/Flutter change.
> **Baseline:** merged BE-23 baseline — commit `515e8f3368aca927da655bb8f0d3ca9458377ab5` (PR #25).
> **Date:** 2026-08-17
> **Consumers audited against:** `asentra-web`, `asentra-mobile` (contract-side assessment only; consumer repositories are out of scope for this checkpoint and were not modified).
> **Authoritative contract:** `docs/api/openapi.yaml` **does not exist in this baseline** — see §3. Source of truth used here: registered routes (`src/modules/**/*.routes.ts`, ~1,004 registrations), shared envelope (`src/shared/api-response.ts`, `src/shared/errors.ts`), middleware, seeds (`foundation-access.seed.ts`, 230 permission codes), and module type contracts.

**Validation performed:** documentation/contract inspection only. No repository tests run, no migrations run, no build executed (per checkpoint instructions).

---

## 1. Summary counts

| Status | Count |
|---|---|
| READY | 25 |
| PARTIAL | 14 |
| MISSING | 2 |
| FUTURE_WAVE | 6 |
| **Total rows** | **47** |

Critical blockers: **3** (§9). Consolidated gaps: BE-24 = **4** (G01–G04), BE-25 = **4** (G05–G08, incl. the 6 FUTURE_WAVE capability rows), BE-26 = **1** (G09), BE-27 = **0**, POTENTIAL_CR = **4** (P1–P4).

Legend: WEB / MOBILE columns are contract-side readiness: ✅ = contract sufficient for the consumer, ⚠️ = partial (consumer must compensate), ❌ = blocked.

---

## 2. Contract matrix

### 2.1 Platform & context

| CONTRACT | BACKEND SOURCE | WEB | MOBILE | STATUS | GAP | PLANNED OWNER |
|---|---|---|---|---|---|---|
| Authentication / Session | `auth.routes` (`POST /auth/login`, `GET /auth/me`, `POST /auth/logout`), `session.*`, `login-rate-limit`, `invitation.routes`, `audit.routes` (`GET /auth/audit-events`) | ✅ | ✅ | READY | — | — |
| Effective User Context | `effective-context.service|types` — `/auth/me` returns `user`, `access.roles/permissions`, `context.clients→properties→buildings`, `entitlements` | ✅ | ✅ | PARTIAL | Org / Department / Team / Position and **operational data scope** not in the context read model (deferred per `docs/effective-context.md`); no workspace/configuration dimension | BE-24 (scope) / BE-26 (workspace) |
| Client / Property / Building Context | `client.routes`, `property.routes`, `building.routes`, `campus.routes`, `floor.routes`, `area.routes`, `room.routes`, `space.routes`, `functional-location.routes`, `structure-context.routes`, `building-assignment.routes` (`GET /auth/me/buildings`), `context-access` | ✅ | ✅ | READY | — | — |
| Role / Permission / Data Scope | `role.routes`, `permission.routes`, `rbac.middleware` (default-deny), `context-access` (BE-02G building isolation), 230 seeded permissions | ✅ | ✅ | PARTIAL | Building-level scope READY; **org/position/team-level operational data scope** not yet resolvable | BE-24 |
| Entitlement | `subscription.routes`, `license.routes`, `module.routes`, `entitlement.routes` (+ `GET /subscriptions/:id/entitlements/effective`), `entitlements` inside `/auth/me` | ✅ | ✅ | READY | — | — |
| Workspace / Configuration context | — (no module exposes workspace or configuration) | ❌ | ❌ | MISSING | No available-workspace, no configuration context endpoint anywhere in BE-00…BE-23 | BE-26 |

### 2.2 Operational domains

| CONTRACT | BACKEND SOURCE | WEB | MOBILE | STATUS | GAP | PLANNED OWNER |
|---|---|---|---|---|---|---|
| Asset / Equipment | `asset.routes` (+ status/location), `asset-category|type|warranty|certification|identifier|history|failure`, `equipment-profile.routes`, `GET /assets/resolve/:identifier` (QR-ready) | ✅ | ✅ | READY | — | — |
| Dynamic Form / Checklist | `form-template|section|version|instance|condition.routes`, `checklist-template.routes`, `checklist-execution.routes` (start/save/complete/cancel) | ⚠️ | ⚠️ | PARTIAL | List endpoints unscoped (global `SELECT *`); no building-access middleware; executions reuse `form_template.*` permissions; no assignment binding; no available-actions read model | BE-25 (+ P2, P4) |
| Task / Assignment | `schedule.routes`, `recurrence.routes`, `task.routes` (generate-tasks), `task-assignment.routes`, `task-execution.routes` (start/complete/cancel, assignee check) | ⚠️ | ⚠️ | PARTIAL | No "my assignments" feed keyed to the authenticated user; unscoped task/assignment lists; `form_template.*` permission reuse | BE-25 |
| Evidence | `evidence-requirement.routes`, `evidence.routes`, domain evidence: `work-order-evidence`, `housekeeping-evidence`, `vendor-work-evidence`, `permit-evidence`, `utility-meter-reading-evidence`, `visitor-photo` | ⚠️ | ⚠️ | PARTIAL | Submission is **metadata-only** (`fileReference` string); no upload/download/media contract; unscoped evidence lists | POTENTIAL_CR (P3) + BE-25 (offline sync) |
| Work Order | `work-order.routes` (+status/priority/context/complete/completion), `work-order-action.routes` (ack/start/hold/resume/notes/cancel), `work-order-assignment|evidence|verification|history|procurement-binding.routes`, `work-request.routes` | ⚠️ | ⚠️ | PARTIAL | Full lifecycle present, but **no `availableActions` in the read model** — `GET /work-orders/:id/actions` returns action *history*, not allowed actions; clients cannot know valid transitions without inferring them | BE-25 |
| Finding / Rework / Verification | `finding.routes` (`GET /findings/:id/available-actions`, `GET|PATCH /findings/:id/state`), `finding-assignment|review|rework|closure|history|escalation|classification|severity.routes`, `security-finding.routes` (reuses BE-09 actions) | ✅ | ✅ | READY | — | — |
| Engineering | `engineering-daily-operations`, `inspection-binding`, `meter-reading-binding`, `log-sheet-binding`, `engineering-checklist-binding`, `breakdown-binding`, `maintenance-binding`, `engineering-finding`, `engineering-report`, `engineering-overview`, `shift-handover` | ✅ | ✅ | READY | — | — |
| Housekeeping | `cleaning-area`, `cleaning-schedule-binding`, `daily-cleaning`, `cleaning-assignment`, `toilet/public-area/supervisor-inspection`, `housekeeping-finding`, `housekeeping-evidence`, `consumable-readiness`, `quality-audit`, `housekeeping-complaint`, `housekeeping-report` | ✅ | ✅ | READY | — | — |
| Security | `security-post`, `patrol-route|schedule-binding|checklist-binding|execution`, `security-daily-activity`, `security-finding`, `security-incident-readiness`, `security-visitor-binding`, `security-key`, `security-lost-found`, `security-shift-handover`, `security-report`, `security-*-kpi` | ✅ | ✅ | READY | — | — |
| Visitor / Front Desk | `visitor`, `visitor-invitation`, `expected-visitor`, `walk-in-visit`, `visitor-photo` (+OCR/review), `host-confirmation`, `visit-check-in` (+check-out), `visitor-pass`, `contractor-visitor`, `delivery-courier`, `front-desk-log` | ✅ | ✅ | READY | — | — |
| Tenant | `tenant-company`, `tenant-pic`, `tenant-space`, `tenant-building-context`, `tenant-service-request`, `tenant-complaint`, `tenant-utility-request`, `tenant-approval`, `tenant-contractor`, `tenant-document`, `tenant-communication`, `tenant-charge`, `tenant-invoice` | ✅ | ✅ | READY | — | — |
| Vendor | `vendor`, `vendor-category`, `vendor-pic`, `vendor-building`, `vendor-capability`, `vendor-workforce`, `vendor-compliance-document`, `vendor-license`, `vendor-assignment`, `vendor-work`, `vendor-checklist-binding`, `vendor-work-evidence`, `vendor-completion/service-report`, `vendor-bast-binding`, `vendor-verification`, `vendor-rework`, `vendor-work-history`, `vendor-service-cost`, `vendor-selection` | ✅ | ✅ | READY | — | — |
| Inventory | `inventory-item`, `inventory-warehouse`, `inventory-stock-balance|movement|transfer|adjustment`, `inventory-minimum-stock`, `inventory-asset-spare-part`, `inventory-work-order-material-usage`, `inventory-housekeeping-consumable-binding` | ✅ | ✅ | READY | — | — |
| Procurement | `purchase-request`, `material-request`, `service-request`, `procurement-approval` (+available-actions), `vendor-selection`, `purchase-order-readiness`, `receiving`, `payment-receipt`, `work-order-procurement-binding` | ✅ | ✅ | READY | — | — |
| Utility | `utility-meter`, `utility-type-configuration`, `utility-meter-hierarchy`, `utility-meter-tenant`, `utility-meter-reading` (+evidence), `utility-meter-consumption`, `utility-usage-history`, `utility-calculation`, `utility-abnormal-consumption`, `utility-verification`, `utility-aggregation`, `utility-bill`, `utility-kpi` | ✅ | ✅ | READY | — | — |
| Billing / Lite ERP | `tenant-invoice` (+lines/finalize/cancel), `invoice-payment-status`, `payment-receipt`, `service-charge-readiness`, `basic-expense`, `basic-financial-reporting` (`GET /buildings/:buildingId/financial-summary`) | ✅ | ✅ | READY | Intentionally lightweight per governance (no gateway/accounting/ledger) — outside BE-00…BE-23 scope | — |
| Permit | `permit`, `permit-application`, `permit-work-context`, `permit-safety-requirement`, `permit-approval` (+available-actions), `permit-validity`, `permit-worker`, `permit-equipment`, `permit-evidence`, `permit-work-lifecycle`, `work-permit-readiness`, `contractor-context` (`POST /contractor-contexts/resolve`) | ✅ | ✅ | READY | — | — |
| Incident / Corrective Action | `incident`, `operational-incident`, `asset-failure`, `finding-escalation`, `immediate-action`, `investigation-readiness`, `corrective-action` (+approve/reject/start/complete/cancel/due-date), `corrective-action-responsibility`, `corrective-action-verification`, `incident-closure` | ✅ | ✅ | READY | — | — |
| BAST / Document | `document` (+versions/expiry/approvals/archive/restore), `work-completion-document`, `bast-document`, `handover-document`, `acceptance-sign-off`, `supporting-document` | ✅ | ✅ | READY | — | — |
| Reporting / KPI | BE-23: `security-patrol-kpi` (F1), `security-finding-incident-kpi` (F2), `workforce-kpi` (G), `vendor-tenant-kpi` (H), `utility-kpi` (I), `reporting-export` (J); pre-BE-23: `engineering-overview` (BE-10K), `engineering-report` (BE-10I), `housekeeping-report` (BE-11M) | ⚠️ | ⚠️ | PARTIAL | No cross-domain **Operations KPI**; Engineering/Housekeeping read models are building-scoped pre-BE-23 reports, not BE-23 KPI read models, and are absent from the export dataset list | BE-24 |

### 2.3 BE-23 reporting read models (confirm/deny)

| CONTRACT | BACKEND SOURCE | WEB | MOBILE | STATUS | GAP | PLANNED OWNER |
|---|---|---|---|---|---|---|
| Operations KPI | — (none) | ❌ | ❌ | MISSING | No operations-level KPI read model exists in BE-23 | BE-24 |
| Engineering / Asset KPI | `GET /buildings/:buildingId/engineering/overview` (BE-10K), `GET /engineering/reports/*` (BE-10I, 8 datasets) | ⚠️ | ⚠️ | PARTIAL | Building-scoped only; no owner-level Engineering/Asset KPI; not in export datasets | BE-24 |
| Housekeeping KPI | `GET /housekeeping/reports/summary` + 7 datasets (BE-11M) | ⚠️ | ⚠️ | PARTIAL | Building-scoped only; not in export datasets | BE-24 |
| Security KPI | `GET /security/reports/patrol-kpi` (BE-23F1), `GET /security/reports/finding-incident-kpi` (BE-23F2) | ✅ | ✅ | READY | — | — |
| Workforce KPI | `GET /workforce/reports/kpi` (BE-23G) | ✅ | ✅ | READY | — | — |
| Vendor / Tenant KPI | `GET /reports/vendor-tenant-kpi` (BE-23H) | ✅ | ✅ | READY | — | — |
| Utility KPI | `GET /utility/reports/kpi` (BE-23I) | ✅ | ✅ | READY | — | — |
| Export Dataset | `GET /reports/export?dataset=…` (BE-23J) — datasets: `SECURITY_PATROL`, `SECURITY_FINDING_INCIDENT`, `WORKFORCE`, `VENDOR_TENANT`, `UTILITY` | ✅ | ✅ | PARTIAL | Neutral export envelope READY, but only the 5 BE-23 KPI datasets; Operations / Engineering / Housekeeping datasets missing | BE-24 |

### 2.4 Mobile readiness (audit only — no BE-25 implementation)

| CONTRACT | BACKEND SOURCE | WEB | MOBILE | STATUS | GAP | PLANNED OWNER |
|---|---|---|---|---|---|---|
| Mobile: authentication | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`; opaque bearer token | — | ✅ | READY | — | — |
| Mobile: effective context | `/auth/me` (user + roles + permissions + clients/properties/buildings + entitlements); `GET /auth/me/buildings` | — | ✅ | READY | — | — |
| Mobile: assignments | `GET /workforce/:workforceId/tasks`, `/workforce/:workforceId/housekeeping/daily-cleaning`, `work-order-assignments` (`GET /work-orders/:id/assignments/current`), `finding-assignments` | — | ⚠️ | PARTIAL | Per-domain assignee endpoints exist; **no unified "my assignments" feed keyed to the authenticated user**; task lists unscoped | BE-25 |
| Mobile: checklist execution | `POST /checklist-templates/:templateId/executions`, start / responses / complete / cancel | — | ⚠️ | PARTIAL | Execution flow exists; no assignment binding, unscoped lists, no available-actions, `form_template.*` permissions | BE-25 (+ P2, P4) |
| Mobile: evidence | `POST /evidence` + domain evidence endpoints (`work-order`, `housekeeping`, `vendor`, `permit`, `utility-meter-reading`) | — | ⚠️ | PARTIAL | Metadata-only submission; **no upload/download endpoint**; offline capture/queue belongs to BE-25 | POTENTIAL_CR (P3) + BE-25 |
| Mobile: QR / context resolution | `GET /assets/resolve/:identifier`, `POST /contractor-contexts/resolve`, `GET /contractor-contexts/permit-eligibility`, `GET /buildings/:buildingId/hierarchy` | — | ✅ | READY | — | — |
| Mobile: verification / actions | `GET /findings/:id/available-actions` + state, `permit-approvals|procurement-approvals|tenant-approvals|tenant-complaints|tenant-service-requests|tenant-utility-requests/:id/available-actions`, `POST /work-orders/:id/close`, `corrective-action-verification`, `vendor-verification` | — | ⚠️ | PARTIAL | available-actions present for findings/approvals/tenant flows; **absent for work orders, corrective actions, vendor work** — Web/Mobile must not infer workflow authority | BE-25 |

### 2.5 BE-25 mobile-only capabilities (out of scope by design — audit only)

| CONTRACT | BACKEND SOURCE | WEB | MOBILE | STATUS | GAP | PLANNED OWNER |
|---|---|---|---|---|---|---|
| Offline Sync contract | — | — | — | FUTURE_WAVE | Not present in BE-23 baseline (by design) | BE-25 |
| Idempotency | — | — | — | FUTURE_WAVE | Not present (by design) | BE-25 |
| Conflict Handling | — | — | — | FUTURE_WAVE | Not present (by design) | BE-25 |
| Mobile-specific API stabilization | — | — | — | FUTURE_WAVE | Not present (by design) | BE-25 |
| Push Token | — | — | — | FUTURE_WAVE | Not present (by design) | BE-25 |
| App Version Metadata | — | — | — | FUTURE_WAVE | Not present (by design) | BE-25 |

---

## 3. OpenAPI coverage gaps

- **`docs/api/openapi.yaml` — the designated authoritative contract — does not exist** in this baseline. `grep -ri openapi` over the repository returns nothing. This is the single largest contract gap and blocks Web/Mobile codegen, client validation, and automated consumer tests.
- There is no schema registry, no endpoint listing, and no response-shape documentation beyond inline TypeScript types and prose route comments.
- README's REST API section documents only the BE-01-era endpoints (`users`, `auth`, `roles`, `permissions`, `invitations`); all ~1,004 route registrations added in BE-02…BE-23 are undocumented there.

## 4. Undocumented existing endpoints

- **All BE-02…BE-23 endpoints are undocumented** in any OpenAPI/API reference (see §3). Representative high-volume undocumented surfaces:
  - Work order lifecycle (`/work-orders/*` incl. actions, verification, completion, context, procurement bindings)
  - Finding workflow (`/findings/:id/state`, `/available-actions`, rework, closure, escalations)
  - Engineering bindings and executions (`/engineering/*-bindings/*/start`, `/engineering/*-executions/:id`)
  - Security patrol execution (`/security/patrol-executions/:id/points/:pointId/visit`, complete)
  - Utility meter reading & evidence (`/utility/meter-readings/:id/evidence`, `/utility/meter-readings/:id/evidence-validation`)
  - Permit lifecycle (`/permit-applications/:id/submit`, `/permit-approvals/:id/request-rework`, `/permits/:permitId/evidence-readiness`)
  - KPI & export endpoints (`/security/reports/*-kpi`, `/workforce/reports/kpi`, `/reports/vendor-tenant-kpi`, `/utility/reports/kpi`, `/reports/export`)
- Pre-BE-23 read models (`/engineering/reports/*`, `/housekeeping/reports/*`, `/buildings/:buildingId/engineering/overview`) are documented only in route-file comments.

## 5. Contract inconsistencies

- **Stateful read-model shape is not uniform:** findings expose `status` + dedicated `state` + `available-actions` endpoints; work orders expose `status` + separate action endpoints but no allowed-actions projection; corrective actions/vendor work expose lifecycle endpoints with no available-actions read model (§6).
- **List endpoints have no pagination contract:** `sendSuccess` always emits an empty `meta`; no controller populates `meta` with limit/offset/page/total. Every list response is unbounded JSON.
- **Data-scope enforcement is inconsistent across waves:** BE-08+ modules assert Building access in middleware (`requireBuildingAccess`) or inside services (KPI/report services via `contextAccessService`), while BE-07-era modules (checklist executions, form instances, tasks, task assignments, evidence, evidence requirements, schedules) expose global `SELECT *` lists with no building scope and no `requireBuildingAccess` (§7 blockers).
- **Permission naming/reuse is inconsistent:** BE-07-era execution modules gate on `form_template.read` / `form_template.manage` instead of dedicated permissions, while every other wave has domain-specific permission codes.
- **Empty success payloads:** some mutation endpoints return `data: {}` (e.g. checklist/form response save) while others return the updated resource — consumers cannot rely on a uniform write-response shape.
- **Envelope is otherwise consistent:** all responses use `{ success, data, meta }` / `{ success, error: { code, message, details? } }` via `sendSuccess`/`sendError`; unknown routes → `NOT_FOUND`; unhandled errors → `INTERNAL_SERVER_ERROR` (no stack leakage); `X-Request-ID` on every response.

## 6. available_actions inconsistencies

- Exposed as dedicated read models: `GET /findings/:id/available-actions` (+ `/state`), `GET /permit-approvals/:id/available-actions`, `GET /procurement-approvals/:id/available-actions`, `GET /tenant-approvals/:id/available-actions`, `GET /tenant-complaints/:id/available-actions`, `GET /tenant-service-requests/:id/available-actions`, `GET /tenant-utility-requests/:id/available-actions`. Security findings deliberately reuse BE-09's endpoints (documented in route comments).
- **Missing for:** Work Orders (`GET /work-orders/:id/actions` is history, not allowed actions), Corrective Actions (approve/reject/start/complete/cancel endpoints without an allowed-actions projection), Vendor Work (status patch + rework/resubmit/verification without allowed-actions projection), Engineering executions, Patrol executions, Checklist executions, Security keys/lost-found (issue/return/mark-lost/claim/close endpoints without allowed-actions projection).
- Impact: Web and Mobile must currently infer valid transitions from `status` for those resources — violating the governance rule that consumers never infer backend workflow authority.

## 7. Error-contract inconsistencies

- Domain errors use specific codes in BE-08+ waves (`WORK_ORDER_*`, `FINDING_*`, `PERMIT_*`, `INCIDENT_*`, …), but BE-07-era modules raise generic `BAD_REQUEST` (`AppError.badRequest`) for domain violations (e.g. "Only draft executions can start.", "Terminal executions cannot be modified.") and generic `NOT_FOUND` ("Task not found."). Consumers cannot branch on domain-specific codes for those resources.
- Some modules translate DB unique-violation (23505) into generic `BAD_REQUEST` (evidence requirements, schedules) — inconsistent with waves that define named codes (`*_ALREADY_EXISTS`).
- Validation style is inconsistent: `AppError.validation()` (with `details`) in some controllers vs `AppError.badRequest()` with a message string in the BE-07-era inline handlers.
- Global error handler is consistent (AppError passthrough, `INTERNAL_SERVER_ERROR` fallback, sanitized DB messages, no stack traces).

## 8. Web / Mobile integration blockers

1. **No OpenAPI contract** — `docs/api/openapi.yaml` missing; consumers have no machine-readable contract (§3). (critical)
2. **Unscoped BE-07-era list endpoints** — `GET /checklist-executions`, `GET /form-instances`, `GET /tasks`, `GET /evidence`, `GET /evidence-requirements`, `GET /tasks/:taskId/assignments`, `GET /workforce/:workforceId/tasks`, `GET /teams/:teamId/tasks`, `GET /schedules` return global data (optionally filtered by `clientId`), bypassing BE-02G accessible-building scope — a data-isolation leak for both consumers. (critical)
3. **No evidence upload/download contract** — evidence is `fileReference` metadata only; there is no media endpoint, signed-URL flow, or storage abstraction endpoint, so neither Web nor Mobile can deliver evidence bytes. (critical)
4. **No unified assignments feed** — mobile workers cannot fetch "my work" in one call; they must call per-domain assignee endpoints (`/workforce/:id/tasks`, `/workforce/:id/housekeeping/daily-cleaning`, `/work-orders/:id/assignments/current`, …).
5. **available_actions gap on core execution resources** (work orders, corrective actions, vendor work) forces client-side workflow inference (§6).
6. **No pagination meta** on list endpoints → unbounded payloads on mobile networks.
7. **Permission reuse** (`form_template.*` for checklist/task/evidence) makes least-privilege role design impossible for operational staff.

## 9. Gap classification

| ID | Gap | Class | Owner |
|---|---|---|---|
| G01 | Org/Department/Team/Position + operational data scope in effective context (`/auth/me`) | BE-24 | BE-24 |
| G02 | Org/position/team-level operational data scope resolution (beyond building isolation) | BE-24 | BE-24 |
| G03 | Reporting/KPI — owner-level aggregation (Operations KPI + Engineering/Asset KPI + Housekeeping KPI) | BE-24 | BE-24 |
| G04 | Export Dataset — extend `REPORTING_EXPORT_DATASETS` with operations/engineering/housekeeping datasets | BE-24 | BE-24 |
| G05 | Mobile assignments feed (unified "my assignments") | BE-25 | BE-25 |
| G06 | Checklist/task execution stabilization for mobile (assignment binding, scoped lists) | BE-25 | BE-25 |
| G07 | available-actions read models for work order / corrective action / vendor work | BE-25 | BE-25 |
| G08 | Offline Sync contract, Idempotency, Conflict Handling, Mobile API stabilization, Push Token, App Version Metadata | BE-25 | BE-25 (FUTURE_WAVE) |
| G09 | Workspace / Configuration context | BE-26 | BE-26 |
| G10 | — (none identified in this audit) | BE-27 | — |
| P1 | `docs/api/openapi.yaml` missing — authoritative contract absent; all endpoints undocumented | POTENTIAL_CR | — |
| P2 | Unscoped BE-07-era list endpoints violate BE-02G data isolation | POTENTIAL_CR | — |
| P3 | Evidence media contract missing (upload/download/storage) | POTENTIAL_CR | — |
| P4 | Permission reuse (`form_template.*`) on checklist/task/evidence execution modules | POTENTIAL_CR | — |

> Note: BE-24…BE-27 wave plans are not present in this repository snapshot; classifications above follow the checkpoint guidance (BE-24 = Management/Owner read models, BE-25 = mobile readiness). Gaps were NOT classified as POTENTIAL_CR when they map to those planned waves.

## 10. What was NOT done (per instructions)

- No BE-24 work started; no missing APIs implemented; no Web/Flutter repositories modified; no PR created; no tests/migrations/builds run.

## 11. Required report (checkpoint output)

| Item | Value |
|---|---|
| READY count | 25 |
| PARTIAL count | 14 |
| MISSING count | 2 |
| FUTURE_WAVE count | 6 |
| Critical blockers | 3 (P1 OpenAPI missing; P2 unscoped BE-07 lists; P3 evidence upload) |
| Gaps → BE-24 | 4 (G01–G04) |
| Gaps → BE-25 | 4 + 6 FUTURE_WAVE rows (G05–G08) |
| Gaps → BE-26 | 1 (G09) |
| Gaps → BE-27 | 0 |
| POTENTIAL_CR gaps | 4 (P1–P4) |
| Checkpoint document | `docs/api/API_CONTRACT_CHECKPOINT_01.md` |
