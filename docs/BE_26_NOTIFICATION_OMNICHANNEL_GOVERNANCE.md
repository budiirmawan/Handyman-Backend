# BE-26 — Notification & Omnichannel (START GOVERNANCE)

> **Status:** START GOVERNANCE — documentation only. No BE-26 API, contract,
> migration, permission, route, or business-logic change is implemented by
> this step.
> **Baseline:** `main` / Arena branch `arena/01a011c3-asentra-backend` at
> `55acb400a4c21c4e9e1c02a42ca7a71cfb6bd6e0` (merged PR #28 = BE-25
> implementation), on top of the merged CR-BE-API-01 baseline and BE-24
> (management read models).
> **Date:** 2026-08-17
> **Consumer constraint:** Flutter stays in `asentra-mobile`; `asentra-web`
> stays in `asentra-web`. This repository contains no mobile or frontend code;
> nothing mobile/frontend-side is modified by BE-26.

## 1. Frozen boundary (verified against the current baseline)

BE-26 establishes **backend notification delivery readiness** using **existing
operational events** and **BE-25 mobile foundations**. The backend owns:

- notification records
- recipient resolution
- delivery orchestration
- channel selection
- delivery status
- retry / failure tracking
- notification preferences
- provider abstraction

Channels in scope: **in-app**, **mobile push**, and **email** (email is
adapter-ready only — no email foundation exists yet, see §4). WhatsApp / SMS /
provider integrations are **out of scope** unless a later frozen BE-26 PART
explicitly defines them (none does today).

Hard rules carried forward:

- do **not** duplicate domain workflow logic — operational modules stay the
  source of truth; notifications **react** to existing events/state
- **reuse BE-25L** push tokens (`mobile_push_tokens`)
- do **not** modify `asentra-mobile` or the frontend repository
- do **not** hardcode external providers
- do **not** send real external notifications during governance
- preserve **Client / Building isolation**
- keep implementation parts small

## 2. Current baseline (verified)

| Item | State |
|---|---|
| Repository | Node.js 20 + TypeScript (strict) + PostgreSQL; **236 migrations** (0001–0236, through `0236_create_mobile_app_versions`) |
| Routes | **1,046** route registrations in `src/modules/**/*.routes.ts` |
| Envelope | Uniform `{success, data, meta}` / `{success, error:{code,message,details?}}` via `sendSuccess`/`sendError`; `X-Request-ID` on every response |
| Error contract | `ERROR_CODES` map in `src/shared/errors.ts` (~1,150 named codes) |
| Pagination | `src/shared/pagination.ts` (limit/offset/page/total `meta`) |
| OpenAPI | `docs/api/openapi.yaml`: **57 paths, 234 schemas**, incremental extension rule; tags include `Mobile Execution`; `/mobile/push-tokens` already documented (BE-25A) |
| Data isolation | `contextAccessService` (`getAccessibleBuildingIds` / `getAccessibleClientIds` / `assertBuildingAccess` / `requireBuildingAccess`), BE-02G |
| Auth / context | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`; `/auth/me` = user + roles + permissions + `context.clients→properties→buildings` + `context.workforce` (BE-25B) + `scope` + entitlements |
| Push tokens | BE-25L merged: `mobile_push_tokens` (0235), `push-tokens` module (register/list/deactivate) |
| Operational events | BE-07 `operational_events` (0080) append-only event log + `recordOperationalEvent` helper |
| Background jobs | **None** — no cron, worker, or queue dependency exists |

## 3. Reusable foundations (verified, not modified)

### 3.1 Domain events / operational event log (BE-07)
- `operational_events` (migration **0080**): append-only rows carrying
  `client_id`, `event_type`, `entity_type`, `entity_id`, `actor_user_id`,
  `building_id`, `vendor_work_id`, `summary`, `metadata` (JSONB), `occurred_at`.
- `recordOperationalEvent(...)` in `src/modules/operational-events/index.ts`
  scrubs sensitive metadata keys and inserts rows; **~197 source references /
  call sites**.
- `recordWorkOrderEvent(...)` in `src/modules/work-order-history` (writes the
  same table) and a direct write in
  `src/modules/tenant-communications/tenant-communication.repository.ts`.
- **~70 modules** currently write operational events (via the helper or a
  direct insert); the event vocabulary is
  rich and already covers the natural notification triggers:
  `WORK_ORDER_ASSIGNED`, `WORK_ORDER_REASSIGNED`, `WORK_ORDER_COMPLETED`,
  `WORK_ORDER_VERIFIED`, `WORK_ORDER_REWORK_REQUIRED`, `VENDOR_*`,
  `PERMIT_*`, `DOCUMENT_*`, `INCIDENT_*`, `CORRECTIVE_ACTION_*`,
  `FINDING_*` (escalations/history), etc.

> **Important limitation:** `operational_events` is a **queryable event log,
> not a transactional outbox**. There is no `processed/dispatched` flag, no
> consumer, no relay, no per-event delivery dedupe. BE-26 delivery must not
> assume outbox semantics already exist (see §4, §6).

### 3.2 BE-25L push token registration
- `mobile_push_tokens` (migration **0235**): `user_id`, `device_id`,
  `push_token`, `platform` (`ANDROID`/`IOS`), `app_version`, `device_model`,
  `device_os_version`, `status` (`ACTIVE`/`INACTIVE`), `registered_at`,
  `last_seen_at`.
- One ACTIVE registration per (user, device); partial unique indexes prevent a
  token being ACTIVE twice; rotation/deactivation semantics already handled.
- `push-tokens` module: `POST/GET /mobile/push-tokens`,
  `DELETE /mobile/push-tokens/:tokenId` (auth only; token always bound to the
  session user). **Reused verbatim by BE-26C** as the push recipient registry.

### 3.3 User & recipient resolution
- `users` (0002): normalized unique `email`, `display_name`, `status`
  (`ACTIVE`/`INACTIVE`/`SUSPENDED`). Users are platform-wide (no `client_id` on
  `users`); client/building scope comes from assignments + context.
- `workforce_profiles` (0024): `user_id` nullable but **unique** → one-way
  Workforce↔User link; `team_id` links a profile to a Team; `status`.
- Team resolution: a Team's members = `workforce_profiles WHERE team_id = X AND
  status='ACTIVE'` → `user_id` → `users`.
- Assignment masters: `work_order_assignments.assignee_type`
  (`WORKFORCE`|`TEAM`|`VENDOR`|`VENDOR_WORKFORCE`),
  `task_assignments.assignee_type` (`WORKFORCE`|`TEAM`), finding assignments.
- `user_building_assignments` (0019): user→building scope for Client/Building
  isolation during recipient expansion.
- `effective-context` (`/auth/me`) already resolves `context.workforce` for the
  authenticated user (BE-25B) and `scope.buildingIds/clientIds`.

### 3.4 Audit / delivery logging primitives
- Authentication audit: `authentication_audit_events` (0011) + `audit` module
  (`GET /auth/audit-events`, `auth.audit.read`). Auth-scoped only.
- General append-only log: `operational_events` (§3.1) — the natural place to
  record notification lifecycle/delivery outcomes without inventing a second
  audit concept.

### 3.5 OpenAPI conventions
- `docs/api/openapi.yaml`: shared `Envelope`/`Error`/`Pagination` schemas,
  Bearer scheme, incremental extension rule (paths only for registered routes;
  no invented endpoints). `/mobile/push-tokens` already documented.

### 3.6 Config / provider abstraction precedent
- `src/config/env.ts` + `.env.example` centralize env-driven config.
- The `storage/` driver pattern (CR-BE-API-01 PART 03, `EVIDENCE_STORAGE_DRIVER`
  local-only with a cloud-ready interface) is the **existing precedent** for the
  notification provider abstraction BE-26 needs.

## 4. Missing notification capabilities (what does not exist)

| # | Capability | Current state |
|---|---|---|
| M1 | Notification records | **None.** No `notifications` table, no module, no routes. In-app inbox does not exist. |
| M2 | Notification preferences | **None.** No `notification_preferences` table or endpoint; no per-user/per-channel opt-in/out. |
| M3 | Provider abstraction | **None.** Push tokens are *stored* but nothing *sends*. No FCM/APNs/Expo/SMTP adapter, no channel interface, no driver pattern for messaging. |
| M4 | Delivery orchestration / channel selection | **None.** Nothing selects in-app vs push vs email; nothing fans out to BE-25L devices. |
| M5 | Delivery status / retry / failure tracking | **None.** No `notification_deliveries` (or equivalent), no attempt counters, no retry/backoff, no dead-letter/failure state. |
| M6 | Email channel | **None.** No SMTP/nodemailer/SDK anywhere. `users.email` and `user_invitations.email` are data fields only; invitations return the raw token via API ("no email delivery yet" — `invitation.controller.ts`). Email must remain **adapter-ready only**. |
| M7 | Scheduler / background job / outbox relay | **None.** No cron/worker/queue dependency (`package.json` deps: bcryptjs, cors, express, helmet, multer, pg). "Schedules" in the repo are operational schedule *definitions* (cleaning/patrol/maintenance), not job scheduling. |
| M8 | Notification permissions | **None.** No `notification.*` codes exist; `GET /notifications` etc. have no RBAC surface yet. |
| M9 | Event emission on core execution surfaces | `tasks`, `task-assignments`, `task-execution`, `checklist-executions`, `findings` (core), `finding-assignments`, `evidence`, `reviews`, `work-orders` (core), `work-order-actions`, `daily-cleaning`, `patrol-executions` do **not** emit `operational_events`. Notifications can only react to the ~70 modules that already emit. |
| M10 | OpenAPI coverage | No notification paths/schemas (nothing to document yet). |

## 5. Recommended BE-26 PART breakdown (small parts)

```text
BE-26A — Notification core foundation (records + in-app inbox + resolver)
BE-26B — Channel selection + notification preferences
BE-26C — Mobile push delivery adapter (reuses BE-25L) + provider abstraction
BE-26D — Event reaction wiring (react to existing operational_events)
BE-26E — Delivery relay/outbox, retry & failure policy + audit log + OpenAPI
```

### BE-26A — Notification core foundation
- Additive migration: `notifications` (id, `client_id`, `recipient_user_id`,
  category/type, `entity_type`/`entity_id`, `title`, `body`, payload, channel
  plan, status, timestamps) — the **notification record**.
- In-app channel: `GET /notifications` (scoped, paginated),
  `GET /notifications/:id`, `PATCH /notifications/:id/read` (mark read/unread).
- Recipient resolver service (user/actor/assignee → `user_id`) reusing §3.3 —
  no domain-logic duplication.
- `notification.read` / `notification.manage` permission codes (default-deny) +
  seed.
- Provider/channel **interfaces** as types (send/status) with **in-app** and
  **no-op** drivers only. Nothing external is contacted.

### BE-26B — Channel selection + notification preferences
- Additive migration: `notification_preferences` (per user: per-channel
  enable/disable, per-category opt-in/out, defaults).
- `GET/PUT /notification-preferences` (auth-scoped to self).
- Channel-selection service: preferences + device/token availability (BE-25L) +
  channel capability → chosen channel set; in-app is always-on fallback.

### BE-26C — Mobile push delivery adapter (provider abstraction)
- Push provider adapter consuming `mobile_push_tokens` (ANDROID/IOS).
- Adapter interface (FCM / APNs / Expo shaped) + a **logging/no-op driver** as
  the default; credentials via env config (`PUSH_PROVIDER=…`); **no real
  external send during governance**; no hardcoded provider.
- Per-channel delivery attempt records with status + attempt counter +
  `next_retry_at` + error snapshot (retry/failure tracking foundation).

### BE-26D — Event reaction wiring (react, don't rebuild)
- Declarative map: existing `event_type` → notification template + recipient
  rule (actor vs assignee vs building-scoped users).
- A best-effort post-write hook consuming newly recorded events and creating
  notification records (with idempotency/dedupe against double-notify).
- **Limited to event types that already exist** (M9 surfaces are out of scope;
  enabling events there is owned by those modules, not BE-26). No workflow
  logic duplicated; `operational_events` remains source of truth.

### BE-26E — Delivery relay/outbox, retry & failure policy + audit + OpenAPI
- Decoupled delivery: in-process dispatch or a pollable outbox/relay table
  (since no background worker exists — keep it small; a dedicated worker is a
  separate decision).
- Retry policy (backoff, terminal `FAILED`), per-attempt history retained.
- Delivery audit via `operational_events` (or a `notification_deliveries`
  history) — reusing §3.4, no second audit concept.
- OpenAPI documentation of the notification surface (§7) + integration
  validation.

**Keep-as-defined:** A–E are separable and each is a complete deliverable.
Optional splits only if a part grows: 26D could split into
D1 (recipient-rule registry) / D2 (per-domain template catalog); 26C could
split push-send from provider-credential wiring. Do not combine parts to go
faster.

## 6. Dependencies / blockers

| ID | Dependency / blocker | Impact | Status |
|---|---|---|---|
| B1 | BE-25L push tokens not yet merged at this baseline | Push channel has no recipient registry | **Cleared** — merged (0235, `push-tokens` module, tests present) |
| B2 | No scheduler / background-job infrastructure | Delivery must be in-process or DB-pollable; no cron/worker dependency may be added without an explicit PART decision | Managed — BE-26E keeps it small; no hard dependency |
| B3 | `operational_events` is a log, not an outbox | No processed-flag/consumer/dedupe; BE-26 must add its own relay/dedupe without rewriting the log | Managed — BE-26A/D/E own the relay/dedupe additively |
| B4 | Uneven event emission (M9) | Task/checklist/finding assignment surfaces (highest-value mobile triggers) do not emit events; BE-26D can only react to existing events | Managed — scope BE-26D to emitted event types; emission on those modules is a separate, module-owned change |
| B5 | No email foundation (M6) | Email cannot be a real channel; only adapter-ready | Managed — email stays interface + no-op driver; real email deferred |
| B6 | No `notification.*` permission codes (M8) | Inbox/preferences endpoints need RBAC | Managed — BE-26A adds codes + seed (default-deny preserved) |
| B7 | Push provider credentials absent (FCM/APNs) | Real push cannot be sent during governance | Managed — **by design**: logging/no-op driver; credentials remain config-level, not required now |

**Hard blockers: none.** All items are managed and isolated to named parts.

## 7. Database changes required — YES (additive only)

New tables (new migrations, no modification of existing tables, no destructive
change):

- `notifications` — notification records (BE-26A)
- `notification_preferences` — per-user channel/category preferences (BE-26B)
- `notification_deliveries` (or equivalent outbox/attempt table) — per-channel
  attempt status, retry, failure (BE-26C/E)

All scoped so Client/Building isolation is enforceable (each row carries
`client_id` and/or the resolved `recipient_user_id`; reads filtered through
`contextAccessService` like every other BE-07-era list).

## 8. External provider credentials — NOT required now (adapter-ready)

- **No credentials are required for governance or for BE-26A–D.**
- Provider abstraction follows the existing `storage/` driver precedent:
  interface + env-driven selection + a **logging/no-op default driver**.
- FCM / APNs / Expo / SMTP are **not hardcoded**; they become config values
  (`PUSH_PROVIDER`, `EMAIL_PROVIDER`, key material via env/secret config) that
  can be filled later without changing callers.
- **No real external notifications are sent during governance.**

## 9. OpenAPI impact

- **Additive only.** New tag (e.g. `Notifications`) and paths for
  `GET/PATCH /notifications`, `GET /notifications/{id}`,
  `GET/PUT /notification-preferences`; new schemas (`Notification`,
  `NotificationPreference`, `DeliveryStatus`/`DeliveryAttempt`).
- Reuse the shared `Envelope`/`Error`/`Pagination` schemas; follow the
  incremental rule (document only routes that exist in the router; never invent
  endpoints).
- `/mobile/push-tokens` is already documented; no change required there.

## 10. Ready for BE-26A: **YES**

Baseline confirmed (`55acb40`, PR #28; BE-25L push tokens and operational-event
foundations merged and preserved). Reusable foundations enumerated (§3);
missing capabilities mapped (§4); parts scoped small (§5); blockers assessed
(§6) — none hard. Start with **BE-26A (Notification core foundation)** only:
notification records + in-app inbox + recipient resolver + `notification.*`
permissions + provider/channel interfaces with no-op drivers. Do not start
BE-26C/D before A/B, and do not start BE-27.

## 11. What was NOT done (per instructions)

- No BE-26A implementation; no business logic modified; no routes, migrations,
  seeds, or tests changed.
- No full repository test run, no migration, no build, no server started.
- No change to `asentra-mobile` or the frontend repository (not present here).
- No BE-27 work started. No PR created, no merge.
