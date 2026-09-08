# CR-BE-SLA-02 — START GOVERNANCE

**Title:** SLA Breach Escalation
**Repository:** `asentra-backend`
**Inspected branch:** `arena/01a02c55-asentra-backend`
**Inspected head:** `e587e0827986b4000c360d968ba330a6fa80184d` (Merge pull request #55)
**Inspection date:** 2026-08-23
**Status:** Governance only — no migration, no runtime implementation, no route implementation, no permission seed, no OpenAPI change, no PR, no merge

## Decision summary

CR-BE-SLA-01 is merged and closed (PART 01–05). It ends exactly where this CR begins: the backend now persists a first-write-idempotent `sla_clocks.breached_at` and records an `SLA_CLOCK_BREACHED` operational event, from both the synchronous Work Order lifecycle path and the due-job dispatcher path. It deliberately does **not** select recipients, schedule follow-up, or notify anyone.

CR-BE-SLA-02 owns exactly one chain and nothing else:

```text
persisted SLA breach (SLA-01 authority)
  → escalation policy selection (new, client-owned configuration)
  → escalation level schedule + action/history ledger (new, durable)
  → notification INTENT (existing BE-26 foundation)
```

The safest model is a **configuration pair plus an execution ledger**, all three shaped after patterns that already exist in this repository:

1. `sla_escalation_policies` — client-owned, optionally Building-narrowed, effective-dated, ACTIVE/INACTIVE, selected by the same specificity resolver already proven in `sla_definitions` (PART 01/02).
2. `sla_escalation_levels` — ordered child rows carrying `offset_minutes` after breach, a BE-26C `RecipientRule`, and a BE-26B `template_key`.
3. `sla_escalation_actions` — the durable per-clock/per-level execution ledger, materialized at first breach, drained by the **existing** due-job dispatcher with the **existing** BE-26I claim-before-send idempotency pattern.

No second scheduler, no second notification stack, no new identity or audience engine, no change to SLA definition/snapshot/clock/pause/breach authority, and no Work Order lifecycle mutation.

---

## 1. Existing authority map

### 1.1 SLA authority (CR-BE-SLA-01, merged — read-only for this CR)

| Authority | Location | Facts this CR depends on | CR-BE-SLA-02 treatment |
|---|---|---|---|
| SLA definition | `sla_definitions` (migration `0291`), `src/modules/sla-definitions` | Client-owned, optional `building_id`, `UNIQUE(client_id, code)`, `operational_type='WORK_ORDER'`, optional `work_type` + `priority`, nullable `response_target_minutes`/`resolution_target_minutes` (≥1 required), `effective_from`/`effective_to`, `ACTIVE\|INACTIVE` | Read-only. **Do not** add escalation columns here. |
| Definition selection | `appliedSlaRepository.selectApplicable` | Runs at Work Order `created_at`; specificity Building 4 / WorkType 2 / Priority 1; equal top score → 409 ambiguous; prospective only | Reuse the *pattern* for escalation policy selection; do not reuse the row. |
| Applied snapshot | `applied_slas` (migration `0292`), `UNIQUE(work_order_id)` | Immutable snapshot of definition + Client/Building + both targets + effective dates | Read-only. Escalation reads `clientId`/`buildingId`/`workOrderId` from it. **Never** mutated by escalation. |
| Clocks | `sla_clocks` (migration `0292`), `UNIQUE(applied_sla_id, clock_type)` | Types `RESPONSE\|RESOLUTION`; status `RUNNING\|SATISFIED\|TERMINATED`; `started_at`, `target_minutes`, `satisfied_at`, `terminated_at` | Read-only. Escalation binds to `sla_clock_id`. |
| Breach | `sla_clocks.breached_at` (migration `0294`) + partial index `sla_clocks_breach_due_idx ON (status, breached_at) WHERE status='RUNNING' AND breached_at IS NULL` | `appliedSlaRepository.markBreached` is a guarded `UPDATE ... WHERE status='RUNNING' AND breached_at IS NULL AND effectiveElapsed >= target_minutes RETURNING …` — returns a row **only on the first breach write**. `breached_at` is historical metadata, never a clock state | **The single trigger source.** Escalation schedules are materialized only when `markBreached` returns a row. |
| Pause accounting | `sla_clock_pause_intervals` (migration `0293`) | RESOLUTION only, `pause_source='WORK_ORDER_ON_HOLD'`, partial unique index enforcing one open interval per clock; effective elapsed = wall − pauses | Read-only. Pause accounting affects **breach determination**, not post-breach escalation timing (see §4.4). |
| Synchronous breach path | `src/modules/applied-slas/sla-clock-lifecycle.service.ts` → `evaluateBreach(w, type, at, tx)` | Called before `satisfyClock` / `terminateClocks`; runs inside the caller's `withTransaction` client `tx`; emits `SLA_CLOCK_BREACHED` only when `markBreached` returned a row | Extension point A (§2.1). |
| Scheduled breach path | `processDueSlaClocks(at)` in `src/modules/applied-slas/applied-sla.service.ts` | Enumerates `findDueRunning(at)` (`FOR UPDATE SKIP LOCKED`), joins `work_orders`→`applied_slas` for `clientId`/`buildingId`, calls `markBreached(c.id, at, pool)`, emits the event, returns a `number` | Extension point B (§2.2). **Currently runs on the raw pool, not a transaction** — see §11 R-07. |
| SLA operational events | `recordOperationalEvent` | `SLA_APPLIED`, `SLA_CLOCK_CREATED`, `SLA_CLOCK_BREACHED`, `SLA_RESOLUTION_CLOCK_PAUSED`, `SLA_RESOLUTION_CLOCK_RESUMED`; all `entityType:'WORK_ORDER'`, `entityId = work order id` | Extend with escalation events using the same convention. |
| SLA read API | `GET /work-orders/{id}/sla` (`work_order.read`) | Returns snapshot + clocks + pause accounting + `breachedAt`, or `null` | Extend/augment for escalation history in PART 05. |
| SLA RBAC | `client_configuration.read` / `client_configuration.manage` + `contextAccessService` | **No SLA-specific permission exists**; definitions are administered under client-configuration authority | Reuse identically (§10). |

### 1.2 Due-job execution authority (CR-BE-STAB-01)

| Authority | Location | Facts |
|---|---|---|
| Dispatcher | `src/modules/due-job-dispatcher/due-job-dispatcher.service.ts` | `processDueOperationalJobs(before = new Date())`; sequentially runs `findDueReminders`/`dispatchReminder`, `findDueEscalations`/`triggerEscalation`, then `processDueSlaClocks(before)`; per-item `try/catch` isolation; safe on an empty window |
| Dispatcher result | `due-job-dispatcher.types.ts` | `DueJobDispatchResult = { reminders: DueJobDomainResult; escalations: DueJobDomainResult; executedAt: string }`, where `DueJobDomainResult = { processed, notificationsCreated, failures }`. **SLA clocks are executed but not reported** |
| Scheduler | `src/modules/due-job-scheduler/due-job-scheduler.service.ts` | One in-process `setInterval`, singleton guard, `inFlight` skip, bounded drain; config `SchedulerConfig { enabled, intervalMs }` from `SCHEDULER_ENABLED` / `SCHEDULER_INTERVAL_MS`; **forced off when `NODE_ENV=test`**; started/stopped in `src/server.ts` |

### 1.3 Notification foundation (BE-26 — reuse, never rebuild)

| Slice | Module / table | Contract this CR consumes |
|---|---|---|
| BE-26A | `notifications` / `src/modules/notifications` | `recordNotification(input)` internal seam (no HTTP create). Channel `IN_APP` only; status `UNREAD\|READ`; fields `type`, `title`, `body`, `sourceEntityType/Id`, `sourceEventType`, `templateKey`, `metadata`, `deliveredAt` |
| BE-26B | `notification_templates` | `key` (unique, FK target), `type`, `channel`, `subject`, `body`, `variables`, `ACTIVE\|INACTIVE`; `getActiveTemplateByKey(key)`, `renderTemplate({subject, body}, vars)` with `{{var}}` placeholders |
| BE-26C | `src/modules/recipient-resolution` | `resolveRecipients(specs, scope) → userId[]` (deduped). `RecipientSpec` kinds: `USER`, `ROLE`, `PERMISSION`, `WORKFORCE`, `TEAM`, `TENANT_PIC`, `VENDOR_PIC`. `RecipientScope { clientId?, buildingIds? }` filters by the *recipient's own* accessible Buildings (BE-02F/G) |
| BE-26D | `notification_subscriptions` | `event_type` → `template_key` + `recipient_rule` + optional client/building + status. Declarative fan-out for *events*, independent of policy-driven escalation targeting |
| BE-26E | `src/modules/notification-delivery` | `deliverInAppNotifications(event: InAppDeliveryEvent) → InAppDeliveryResult`; composes BE-26D → BE-26B → BE-26C → BE-26A |
| BE-26H/I | `notification_reminders` / `notification_escalations` (migrations `0243`/`0244`) | Durable rows with `PENDING\|SENT\|CANCELLED` / `PENDING\|TRIGGERED\|CANCELLED`, `findDue*` + `dispatchReminder`/`triggerEscalation`, **claim-before-send** (`markTriggered` guarded UPDATE; only a returned row proceeds to resolve + record). Generic `escalation_rule` JSONB + `template_key` FK + `escalation_at` |
| BE-26J / BE-25L | `notification_secure_links`, `push_tokens` | Present; out of scope |
| Provider adapters | `src/modules/email-delivery`, `src/modules/whatsapp-delivery` | Interface + credential-less `noop` adapters only (`EMAIL_PROVIDER` / `WHATSAPP_PROVIDER`; any non-`noop` value throws `ConfigError`). **Out of scope for this CR** |

### 1.4 Recipient-target authorities that actually exist

| Relationship | Table / module | What it really is |
|---|---|---|
| User identity | `users` | The only thing a notification can be addressed to (`notifications.recipient_user_id`) |
| Role / permission | `roles`, permission catalogue in `src/database/seeds/foundation-access.seed.ts` | BE-26C `ROLE` / `PERMISSION` specs |
| Workforce profile | `workforce_profiles` (migration `0024`) | `user_id` is **nullable and unique** — a workforce member may have no login |
| Team | `teams` | BE-26C `TEAM` spec |
| Work Order assignment | `work_order_assignments` | `assigneeType ∈ WORKFORCE \| TEAM \| VENDOR \| VENDOR_WORKFORCE`; nullable `workforce_profile_id` / `team_id` / `vendor_id`; one `ACTIVE` row per Work Order; **no direct `user_id` column** |
| Supervisor | `workforce_reporting_lines` (migration `0029`) | `workforceProfileId → supervisorWorkforceProfileId`, ACTIVE/INACTIVE, effective-dated; `workforceReportingLineService.resolveCurrentSupervisor(workforceProfileId)` already exists |
| Building data access | `user_building_assignments` (BE-02F, migration `0019`) | Governs which Buildings a **User** may read. This is what BE-26C `RecipientScope` filters on |
| Building operational placement | `workforce_building_assignments` (BE-03G, migration `0030`) | Where a **workforce member works**. BE-03G explicitly states it is *not* BE-02F and neither is derived from the other |
| Tenant / vendor contacts | `tenant_pics`, `vendor_pics` | `TENANT_PIC` / `VENDOR_PIC` specs. **`VENDOR_PIC` resolves to contact data, not necessarily a User** |
| Work Order creator | `work_orders.created_by_user_id` | A real `users.id` — directly usable as a `USER` spec |

**Authorities that do NOT exist and must not be invented:** there is no building manager / building owner / building-responsible column on `buildings`, no `work_order_assignments.user_id`, no team-supervisor relation, and no organization hierarchy above `workforce_reporting_lines`.

### 1.5 Naming collision to avoid

`src/modules/finding-escalations` (BE-21D) is a **Finding → Incident specialization** (`incident_type='FINDING_ESCALATION'`) with an `escalation_reason` that happens to include `SLA_BREACH`. It is unrelated to SLA escalation, owns no timing, and must not be reused, extended, or auto-created by this CR. All new artifacts use the `sla_escalation_*` prefix.

---

## 2. Escalation extension points

### 2.1 Extension point A — synchronous breach inside a lifecycle transaction

`evaluateBreach(w, type, at, tx)` already runs inside the Work Order action/lifecycle `withTransaction` boundary and already branches on "first breach write" (`if (b) …`). The escalation **schedule materialization** hook belongs in exactly that branch, using the same `tx`, so breach + schedule commit atomically.

```text
evaluateBreach → markBreached returns row
  → recordOperationalEvent(SLA_CLOCK_BREACHED, tx)          [existing]
  → materializeSlaEscalationSchedule(clock, workOrder, tx)  [new, PART 02]
```

### 2.2 Extension point B — scheduled breach inside the dispatcher

`processDueSlaClocks(at)` performs the same first-write branch on the raw pool. The same materialization call belongs there, but the breach write, the event, and the schedule insert should be wrapped in `withTransaction` per clock (§11 R-07).

### 2.3 Extension point C — dispatcher domain slot

`processDueOperationalJobs` already calls three domains but reports two. Adding a fourth domain call plus two new result keys (`slaClocks`, `slaEscalations`) is a contained, additive change to `DueJobDispatchResult`.

### 2.4 Extension point D — BE-26I claim-before-send pattern

`triggerEscalation` is the reference implementation for at-most-once dispatch: read → skip if not `PENDING` → resolve template → **claim** (`markTriggered` guarded UPDATE) → only then resolve recipients and `recordNotification`. Copy this shape verbatim for SLA escalation actions.

### 2.5 Extension point E — clock terminal transitions

`satisfyClock` and `terminateClocks` are the only places a clock leaves `RUNNING`. They are the natural hook for cancelling remaining `PENDING` escalation actions (§8).

### 2.6 Rejected extension points

| Rejected | Why |
|---|---|
| Columns on `sla_definitions` (e.g. `escalation_policy_id`, `escalate_after_minutes`) | Overlapping authority. Definitions are snapshotted immutably into `applied_slas`; escalation policy must be able to change without rewriting SLA history, and one policy should serve many definitions. |
| Columns on `applied_slas` / `sla_clocks` | The snapshot is immutable by contract; clocks own timing, not delivery. |
| Reusing `notification_escalations` (BE-26I) as the SLA ledger | Tempting (it already has `escalation_rule`, `template_key`, `escalation_at`, claim-before-send). Rejected because it has no `level` concept, no policy linkage, no `sla_clock_id`, no `building_id`, a global `UNIQUE(key)` that would force key string encoding to carry identity, and no cancellation-on-satisfaction semantics. Encoding SLA identity into a text key is exactly the "stringly-typed foreign key" this codebase avoids. The **pattern** is reused; the table is not. |
| A new scheduler / worker / queue | Forbidden by CR scope and by CR-BE-STAB-01 governance. |
| Auto-creating `finding_escalation_incidents` on SLA breach | Different domain, different authority, would mutate operational state (§8). |
| Extending BE-26C with `WORK_ORDER_ASSIGNEE` / `SUPERVISOR` spec kinds | Would push Work Order domain knowledge into the generic recipient module. Resolved instead at escalation time into existing spec kinds (§5.3). |

---

## 3. Proposed escalation policy model

### 3.1 Scope decision

**Client-scoped with optional Building narrowing** — identical to `sla_definitions`, and consistent with `client_configurations` / `building_configurations`. This satisfies the CR preference and requires no new configuration pattern.

### 3.2 `sla_escalation_policies` (proposed, migration `0295`)

| Column | Type | Rule |
|---|---|---|
| `id` | UUID PK | |
| `client_id` | UUID NOT NULL → `clients(id)` | Owning Client |
| `building_id` | UUID NULL → `buildings(id)` | Optional narrowing; must belong to `client_id` (service-validated, as in SLA-01) |
| `code` | TEXT NOT NULL | `UNIQUE (client_id, code)` |
| `name` | TEXT NOT NULL | |
| `description` | TEXT NULL | |
| `operational_type` | TEXT NOT NULL | `CHECK (operational_type = 'WORK_ORDER')` — same v1 restriction as SLA-01 |
| `clock_type` | TEXT NOT NULL | `CHECK (clock_type IN ('RESPONSE','RESOLUTION','ANY'))` — see §4.3 |
| `work_type` | TEXT NULL | Optional applicability, same normalization as `sla_definitions` |
| `priority` | TEXT NULL | `CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL'))` |
| `effective_from` | TIMESTAMPTZ NOT NULL | |
| `effective_to` | TIMESTAMPTZ NULL | `CHECK (effective_to > effective_from)` |
| `status` | TEXT NOT NULL DEFAULT `'ACTIVE'` | `CHECK (status IN ('ACTIVE','INACTIVE'))` |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Indexes: `(client_id, status)`, `(client_id, building_id, operational_type, clock_type, status)`.

### 3.3 Policy selection

Selection runs **at breach time**, against the persisted `breached_at` instant, and reuses the SLA-01 resolver shape exactly:

- Candidate set: same `client_id`; `status='ACTIVE'`; effective at `breached_at`; `operational_type='WORK_ORDER'`; `clock_type` equal to the breached clock's type **or** `'ANY'`; `building_id` NULL or equal to the Work Order's Building; `work_type` NULL or equal; `priority` NULL or equal.
- Specificity score: **Building 8, clock_type exact (not `ANY`) 4, work_type 2, priority 1**. Highest score wins.
- **Tie → no escalation is scheduled, and an `SLA_ESCALATION_POLICY_AMBIGUOUS` operational event is recorded.** This differs deliberately from SLA-01's 409: a breach is not a user request, so there is no caller to reject. Failing closed with an audit trail is safer than arbitrarily choosing a policy or fanning out to both.
- **No match is a normal outcome.** The breach still persists and still emits `SLA_CLOCK_BREACHED`. Escalation is strictly additive.
- The selected `policy_id` and each `level_id` are recorded on the action rows, and the resolved `recipient_rule` / `template_key` are **snapshotted onto the action row** (see §3.5), so later policy edits cannot rewrite scheduled or executed history.

### 3.4 Why a separate policy entity rather than SLA-definition columns

1. `applied_slas` is immutable; anything reachable only through the definition would either be frozen at Work Order creation (wrong — escalation routing must be editable) or would silently contradict the snapshot.
2. One escalation policy typically serves many SLA definitions (all CRITICAL work orders in a Building escalate the same way).
3. Escalation has its own lifecycle, its own administration audience, and its own risk profile (it sends messages). Keeping it separate keeps SLA-01's authority intact, which the CR requires.

### 3.5 Snapshot-on-schedule rule

When an action row is materialized it copies `template_key` and `recipient_rule` from the level. Rationale: identical to why `applied_slas` snapshots the definition — a policy edit at 03:00 must not retarget an escalation that was already scheduled at 02:00. Policy edits affect **future** breaches only, exactly like SLA-01's prospective-only rule.

---

## 4. Escalation level model

### 4.1 `sla_escalation_levels` (proposed, migration `0296`)

| Column | Type | Rule |
|---|---|---|
| `id` | UUID PK | |
| `policy_id` | UUID NOT NULL → `sla_escalation_policies(id) ON DELETE CASCADE` | |
| `level` | INTEGER NOT NULL | `CHECK (level >= 1)`, `UNIQUE (policy_id, level)` |
| `offset_minutes` | INTEGER NOT NULL DEFAULT 0 | `CHECK (offset_minutes >= 0)` — minutes **after** persisted `breached_at` |
| `template_key` | TEXT NOT NULL → `notification_templates(key)` | Same FK style as `notification_escalations` |
| `recipient_rule` | JSONB NOT NULL DEFAULT `'{}'::jsonb` | BE-26C `RecipientRule` plus the derived-target extension (§5.3) |
| `status` | TEXT NOT NULL DEFAULT `'ACTIVE'` | `CHECK (status IN ('ACTIVE','INACTIVE'))` |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Index: `(policy_id, level)`.

### 4.2 Level semantics

- **Level 1 with `offset_minutes = 0` fires at breach.** This is the recommended default and makes "notify on breach" the trivial one-level policy.
- Levels are strictly additive reminders of the *same* breach at increasing distance from it. A level is **not** a state machine step: reaching level 3 does not "cancel" level 2, and there is no per-level acknowledgement in this CR.
- A policy with zero ACTIVE levels schedules nothing (valid, means "policy exists but is currently silent").
- Levels are recommended to be strictly increasing in `offset_minutes`; equal offsets are permitted by the schema but should be rejected by service validation to avoid two simultaneous messages to overlapping audiences.

### 4.3 Trigger timing relative to breach

`due_at = breached_at + offset_minutes`, computed **once**, at materialization, from the persisted `breached_at` value.

- Escalation is **strictly post-breach**. No pre-breach warning levels ("80% of target") in this CR — that would require a second, non-breach trigger source and would put timing authority back into SLA-01's clock arithmetic. Deferred (§11 R-10).
- `due_at` is an absolute instant. It is never recomputed, so a later policy edit, a later pause, or a later clock transition cannot move an already-scheduled level.
- The dispatcher may fire a level late (bounded by `SCHEDULER_INTERVAL_MS` and by dispatcher throughput). Late is acceptable and expected; early is impossible.

### 4.4 RESPONSE vs RESOLUTION applicability

| Aspect | RESPONSE | RESOLUTION |
|---|---|---|
| Trigger | `sla_clocks.breached_at` set on the RESPONSE clock | Same, on the RESOLUTION clock |
| Pause interaction | RESPONSE clocks are never paused (SLA-01 PART 03) | Pauses affect *breach determination* only; once breached, `due_at` is wall-clock from `breached_at` |
| Typical audience | Assignee + supervisor (nobody has picked the work up) | Supervisor + Building/Client operational roles (work started but is not finishing) |
| Policy targeting | `clock_type='RESPONSE'` | `clock_type='RESOLUTION'` |
| Both | `clock_type='ANY'` — one policy escalates whichever clock breaches; each breached clock gets its own independent action rows | |

**Decision — Work Order `ON_HOLD` after breach does not suspend escalation.** The escalation exists precisely because the target was already missed; a hold placed after the fact cannot un-miss it, and suspending would require re-deriving `due_at` from pause accounting, i.e. re-opening SLA-01's timing authority. Recorded as a reviewable risk (§11 R-05).

---

## 5. Recipient-resolution strategy

**Recipient resolution and notification delivery are separate concerns and separate code paths.** Resolution answers "*which existing `users.id` values are the audience?*". Delivery answers "*what record/channel carries the message?*". This CR owns resolution inputs; BE-26 owns delivery.

### 5.1 Reuse, unchanged

BE-26C `resolveRecipients(specs, scope)` remains the only resolver. It returns deduplicated `users.id` values and applies the BE-02F/G accessible-Building filter itself. This CR adds no membership logic, no audience engine, and no new identity table.

### 5.2 Static specs (stored directly on the level's `recipient_rule.specs`)

All seven existing kinds are permitted as-is: `USER`, `ROLE`, `PERMISSION`, `WORKFORCE`, `TEAM`, `TENANT_PIC`, `VENDOR_PIC`.

### 5.3 Derived targets (resolved at execution into existing specs)

The CR asks for Work Order assignment / supervisor / Building operational responsibility targeting. None of these are static — they depend on the Work Order at breach time. They are expressed as a **closed enum of derived targets** stored in `recipient_rule.derived[]`, and the SLA escalation service expands them into ordinary BE-26C specs **before** calling `resolveRecipients`:

| Derived target | Backing authority | Expansion | Empty case |
|---|---|---|---|
| `WORK_ORDER_ASSIGNEE` | ACTIVE `work_order_assignments` row for the Work Order | `WORKFORCE` (`workforce_profile_id`) · `TEAM` (`team_id`) · `VENDOR_PIC` (`vendor_id`) · `VENDOR_WORKFORCE` → `WORKFORCE` when a profile is present | No ACTIVE assignment → expands to nothing |
| `WORK_ORDER_ASSIGNEE_SUPERVISOR` | `workforceReportingLineService.resolveCurrentSupervisor(workforceProfileId)` | `WORKFORCE` (supervisor profile) | TEAM or VENDOR assignee, or no ACTIVE reporting line → expands to nothing. **A team supervisor relation does not exist and is not invented** |
| `WORK_ORDER_CREATOR` | `work_orders.created_by_user_id` | `USER` | Never empty (column is NOT NULL) |
| `BUILDING_ROLE` (`roleCode`) | `roles` + BE-02F Building scope | `ROLE` spec, scoped to the Work Order's Building | No user with that role has Building access → empty |
| `BUILDING_PERMISSION` (`permissionCode`) | permission catalogue + BE-02F Building scope | `PERMISSION` spec, scoped to the Work Order's Building | Same |

**"Building operational responsibility" is deliberately modelled as `BUILDING_ROLE` / `BUILDING_PERMISSION`, not as a new relation.** The repository has no building-manager column. The two Building relations that exist are BE-02F `user_building_assignments` (User → Building *data access*) and BE-03G `workforce_building_assignments` (workforce → Building *operational placement*, and BE-03G explicitly forbids deriving one from the other). BE-26C's `RecipientScope` already applies BE-02F. Expressing responsibility as "users holding role/permission X with access to this Building" therefore uses only relations that exist.

### 5.4 Mandatory scope injection

Whatever the stored rule says, the executing service **always** applies:

```ts
scope = { clientId: <appliedSla.clientId>, buildingIds: [<workOrder.buildingId>] }
```

A stored rule may narrow further but may never widen. This makes cross-Client and cross-Building leakage structurally impossible even if a policy is misconfigured, and it reuses the isolation rule rather than restating it.

### 5.5 Known resolution limits (documented, not worked around)

- `workforce_profiles.user_id` is nullable — a workforce assignee with no login yields no in-app recipient.
- `VENDOR_PIC` is contact data and may resolve to no User.
- Recipients who lack access to the Work Order's Building are filtered out by design, which can legitimately produce **zero** recipients. Zero recipients is recorded on the action row (`recipients_resolved = 0`) and is a `TRIGGERED` outcome, not a failure — but it is exactly the silent-misconfiguration risk in §11 R-06.

---

## 6. Scheduler strategy

### 6.1 Reuse the single existing scheduler

No new timer, process, cron, or queue. `startDueJobScheduler(config.scheduler)` in `src/server.ts`, its singleton/`inFlight` guards, its bounded drain, its `SCHEDULER_ENABLED` / `SCHEDULER_INTERVAL_MS` config, and its forced-off behaviour under `NODE_ENV=test` all remain exactly as CR-BE-STAB-01 built them. **No new environment variable is introduced.**

### 6.2 Dispatcher run order

```text
processDueOperationalJobs(before)
  1. reminders        (BE-26H)                    [existing]
  2. escalations      (BE-26I)                    [existing]
  3. slaClocks        processDueSlaClocks(before) [existing call, now reported]
  4. slaEscalations   processDueSlaEscalations(before)  [new]
```

SLA escalation runs **after** breach processing so that a breach detected in this tick can fire its `offset_minutes = 0` level in the same tick instead of waiting a full interval.

### 6.3 Additive result contract

```ts
export type DueJobDispatchResult = {
  reminders: DueJobDomainResult;
  escalations: DueJobDomainResult;
  slaClocks: DueJobDomainResult;      // new — breaches persisted
  slaEscalations: DueJobDomainResult; // new — levels triggered
  executedAt: string;
};
```

`processDueSlaClocks` currently returns `number`. It should return `DueJobDomainResult` (or the dispatcher should adapt it) so every domain reports uniformly. `tests/cr-be-stab-01-due-job-dispatcher.test.ts` asserts on the current shape and must be updated in the same PART (§11 R-08).

### 6.4 Due enumeration

`findDue(before)` on the action ledger mirrors `findDueRunning`:

```sql
SELECT … FROM sla_escalation_actions
 WHERE status = 'PENDING' AND due_at <= $1
 ORDER BY due_at
 FOR UPDATE SKIP LOCKED
```

with partial index `sla_escalation_actions_due_idx ON (status, due_at) WHERE status = 'PENDING'`, matching the `sla_clocks_breach_due_idx` precedent. `FOR UPDATE SKIP LOCKED` keeps the design multi-instance-safe even though today only one in-process scheduler exists.

### 6.5 Failure isolation and bounded work

Each action is processed in its own `try/catch` exactly like existing dispatcher items; one failure never blocks the rest of the window and is counted in `failures`. An empty window returns all zeros without error. A bounded batch size per tick (a module constant, not config) should cap fan-out after an outage (§11 R-04).

---

## 7. Idempotency strategy

Four layers, each of which is already proven somewhere in this repository.

**Layer 1 — breach is first-write idempotent (existing).** `markBreached` returns a row only the first time. Schedule materialization is called only inside that branch, so a clock can never be scheduled twice by repeated breach evaluation, and the two breach paths (lifecycle + dispatcher) cannot both schedule.

**Layer 2 — unique schedule key.** `UNIQUE (sla_clock_id, escalation_level_id)` on `sla_escalation_actions`, with `INSERT … ON CONFLICT DO NOTHING`. Even if layer 1 is bypassed by a future code path, a backfill, or a manual re-run, duplicate rows are impossible.

**Layer 3 — atomic materialization.** Breach write + `SLA_CLOCK_BREACHED` event + action inserts share one transaction (`tx` on the lifecycle path; a new per-clock `withTransaction` on the dispatcher path). A committed breach with a missing schedule, or a schedule with no breach, cannot occur.

**Layer 4 — claim-before-send (BE-26I pattern).**

```sql
UPDATE sla_escalation_actions
   SET status = 'TRIGGERED', triggered_at = $2, updated_at = NOW()
 WHERE id = $1 AND status = 'PENDING'
 RETURNING …
```

Recipient resolution and `recordNotification` run **only** when a row is returned. A concurrent or repeated dispatcher run finds the row non-`PENDING` and skips it.

**Delivery semantics: at-most-once, deliberately.** If the process dies after the claim but before the notification is written, that level is lost rather than duplicated. This matches BE-26H/I exactly. At-least-once was rejected: duplicated escalation messages to management are a worse operational failure than one missed reminder, and the breach itself remains permanently visible in `sla_clocks.breached_at`, the operational event log, and the action ledger.

**Template deactivated at trigger time:** mirror BE-26I — do **not** claim, leave the action `PENDING`, so re-activating the template delivers it later. The consequence (a stale backlog that fires late) is R-09.

---

## 8. Lifecycle behavior after breach

**Escalation never mutates operational state.** It must not change Work Order `status`, `priority`, assignment, or dates; must not create Findings, Incidents, or `finding_escalation_incidents`; must not touch `applied_slas`, `sla_clocks`, or pause intervals; and must not re-open, re-time, or clear `breached_at`. The Work Order service, the SLA-01 services, and BE-21 remain their own authorities. Escalation writes only to `sla_escalation_actions`, `notifications` (through BE-26A), and `operational_events`.

### 8.1 Action ledger — `sla_escalation_actions` (proposed, migration `0297`)

| Column | Notes |
|---|---|
| `id` | UUID PK |
| `applied_sla_id`, `sla_clock_id`, `work_order_id`, `client_id`, `building_id` | Denormalized from the authoritative chain at materialization, for isolation-safe querying without re-joining |
| `clock_type` | `RESPONSE\|RESOLUTION` |
| `policy_id`, `escalation_level_id`, `level` | Provenance |
| `template_key`, `recipient_rule` | **Snapshotted** from the level (§3.5) |
| `breached_at`, `due_at` | Absolute instants |
| `status` | `PENDING \| TRIGGERED \| CANCELLED \| SKIPPED` |
| `triggered_at`, `cancelled_at`, `cancel_reason` | |
| `recipients_resolved`, `notifications_created` | Observability |
| `failure_reason` | Last isolated failure, for support |
| `created_at`, `updated_at` | |

Constraints: `UNIQUE (sla_clock_id, escalation_level_id)`; indexes `(status, due_at) WHERE status='PENDING'`, `(work_order_id, level)`, `(client_id, created_at DESC)`.

### 8.2 State transitions

```text
                     materialized at first breach
                                  │
                                  ▼
                              PENDING ──── due_at reached, claimed ──▶ TRIGGERED (terminal)
                                 │
                                 ├── clock SATISFIED / TERMINATED ───▶ CANCELLED (terminal)
                                 └── policy or level deactivated *  ─▶ SKIPPED   (terminal)
```

\* Optional; if not implemented in PART 02/03, an inactive level simply yields no recipients at trigger time. Prefer the explicit `SKIPPED` outcome so the ledger explains itself.

### 8.3 Cancellation rule

When `satisfyClock` or `terminateClocks` moves a clock out of `RUNNING`, all **`PENDING`** actions for that `sla_clock_id` are cancelled in the same transaction, with `cancel_reason` recording `CLOCK_SATISFIED` or `CLOCK_TERMINATED`. Already-`TRIGGERED` actions are immutable history and are never rewritten — the message really was sent.

This is the behaviour operators expect: once the Work Order is acknowledged (RESPONSE) or completed/cancelled (RESOLUTION), the reason to keep escalating is gone.

### 8.4 Late satisfaction race

`evaluateBreach` already runs **before** satisfaction/termination inside the same transaction, so a Work Order completed slightly past its target both records the breach and immediately cancels its own future levels. A level whose `offset_minutes = 0` may still fire on the next tick if the dispatcher wins the race; this is correct — the breach happened.

### 8.5 New operational events

All reuse `entityType: 'WORK_ORDER'`, `entityId = work order id`, and the Client/Building of the applied SLA, matching SLA-01:

| Event | When |
|---|---|
| `SLA_ESCALATION_SCHEDULED` | One event per breach summarizing the materialized levels (not one per level) |
| `SLA_ESCALATION_TRIGGERED` | A level was claimed and its notification intent emitted |
| `SLA_ESCALATION_CANCELLED` | Pending levels cancelled on clock satisfaction/termination |
| `SLA_ESCALATION_POLICY_AMBIGUOUS` | Tie during policy selection; nothing scheduled (§3.3) |

---

## 9. Notification-intent boundary

### 9.1 What this CR owns

Producing a **notification intent**: for each triggered level, render the snapshotted BE-26B template, resolve the snapshotted rule through BE-26C under injected Client/Building scope, and call BE-26A `recordNotification` once per resolved User with `channel: 'IN_APP'`, `sourceEntityType: 'WORK_ORDER'`, `sourceEntityId: <work order id>`, `sourceEventType: 'SLA_ESCALATION_TRIGGERED'`, `templateKey`, and metadata `{ slaClockId, clockType, policyId, level, breachedAt, dueAt }`.

This is the identical composition BE-26I already performs. **No new delivery mechanism, no new channel, no new notification table.**

### 9.2 Why `recordNotification` and not `deliverInAppNotifications`

`deliverInAppNotifications` (BE-26E) resolves its audience from BE-26D **subscriptions**. SLA escalation targeting must be *policy-driven and deterministic* — the level already carries the template and the rule, and a subscription could silently widen or silence a management escalation. So the direct BE-26A path is used for the escalation message itself.

The subscription channel is still available and is not blocked: the `SLA_ESCALATION_TRIGGERED` (and `SLA_CLOCK_BREACHED`) operational events are ordinary events, and a BE-26D subscription may be configured against them for broader, non-authoritative awareness fan-out. Those two mechanisms are independent by design and neither is a prerequisite for the other.

### 9.3 Hard boundary — explicitly NOT in this CR

- No SMTP / email provider implementation. `email-delivery` keeps its `noop` adapter. → **`CR-BE-NOTIFY-PROV-01`**
- No WhatsApp provider implementation. `whatsapp-delivery` keeps its `noop` adapter. → **`CR-BE-NOTIFY-PROV-01`**
- No push delivery. `push_tokens` (BE-25L) stays registration-only. → **`CR-BE-PUSH-01`, only after an explicit boundary reopen**
- No SMS, no secure-link generation (BE-26J), no delivery retry/backoff, no per-channel delivery-status tracking, no digest/quiet-hours/rate-limit policy, no recipient notification preferences.
- No changes to `notifications`, `notification_templates`, `notification_subscriptions`, `recipient-resolution`, `notification_reminders`, or `notification_escalations` schemas.

When a real provider CR lands, it plugs in **below** BE-26A/E. Nothing in the SLA escalation model needs to change for multi-channel delivery to become real — that is the point of stopping at intent.

---

## 10. Permissions and isolation reuse

### 10.1 Permissions

| Surface | Permission | Rationale |
|---|---|---|
| Escalation policy + level administration (create / read / update / activate / deactivate) | `client_configuration.read` / `client_configuration.manage` | Exactly what `sla_definitions` uses today. SLA-01 deliberately added **no** SLA-specific permission; inventing `sla_escalation.*` now would make the SLA surface internally inconsistent and would require a seed + role-grant migration that no role currently has |
| Reading escalation history for a Work Order | `work_order.read` | Same as `GET /work-orders/{id}/sla` |
| Reading escalation operational events | `operational_event.read` | Existing |

If a dedicated permission is later required, it should be introduced for SLA definitions and SLA escalation **together**, as its own governance decision — not smuggled into this CR.

### 10.2 Isolation

- Policy write/read: `contextAccessService.canAccessClient(userId, clientId)`, plus `assertBuildingAccess(userId, buildingId)` when the policy is Building-narrowed, plus service validation that the Building belongs to the Client — the same three checks `sla-definition.service.ts` performs.
- Escalation history reads: reuse the Work Order's existing Building isolation; never accept a caller-supplied `clientId`/`buildingId` as authority.
- Recipient scope: injected from the authoritative applied SLA / Work Order (§5.4), never from request input, and filtered by BE-26C against BE-02F.
- Background execution has no HTTP actor. The dispatcher derives Client/Building from the persisted chain (`sla_clocks → applied_slas → work_orders`) exactly as `processDueSlaClocks` already does; it must never widen scope because "no user is present".

---

## 11. Risks and constraints

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-01 | **Notification storm.** A broad `ROLE`/`PERMISSION` rule × many simultaneous breaches × several levels can generate thousands of in-app rows | Inbox unusable; DB write spike | Mandatory Building scope (§5.4); recommend a service-validated cap on resolved recipients per level; bounded batch per dispatcher tick (§6.5); `recipients_resolved` recorded for auditability |
| R-02 | **Policy ambiguity.** Two equally specific ACTIVE policies | Non-deterministic routing | Fail closed: schedule nothing, emit `SLA_ESCALATION_POLICY_AMBIGUOUS` (§3.3). Considered and rejected: pick lowest code, or fan out to both |
| R-03 | **Policy edits rewriting history** | Escalations retargeted after the fact | Snapshot `template_key` + `recipient_rule` onto the action row; prospective-only, mirroring `applied_slas` (§3.5) |
| R-04 | **Backlog burst.** Scheduler disabled/outage for hours → many `due_at` in the past fire at once | Mass notification at restart | Bounded batch per tick; levels drain over successive ticks; consider (later CR) a staleness cut-off that marks very old actions `SKIPPED` |
| R-05 | **ON_HOLD after breach keeps escalating** (§4.4 decision) | Perceived noise while work is legitimately paused | Documented decision, reviewable. Changing it later means cancelling or re-timing `PENDING` actions on pause — a contained change to §8.3, not a model change |
| R-06 | **Silent zero-recipient escalations.** Building scope filters everyone out | Breach escalates to nobody, unnoticed | `recipients_resolved = 0` persisted and reported in the dispatcher result; PART 05 read API surfaces it; recommend logging at warn level |
| R-07 | **Dispatcher breach path is not transactional.** `processDueSlaClocks` writes breach + event on the raw pool | A crash between breach commit and schedule insert leaves a breach with no escalation, and layer 1 idempotency prevents retry | Wrap per-clock breach + event + materialization in `withTransaction` in PART 02. This is a small, contained improvement to existing SLA-01 code and is the only SLA-01 file this CR should modify |
| R-08 | **`DueJobDispatchResult` shape change** | `tests/cr-be-stab-01-due-job-dispatcher.test.ts` asserts the current two-key shape | Additive keys only; update that focused test in the same PART (PART 04) |
| R-09 | **Deactivated template leaves actions PENDING forever** (BE-26I behaviour) | Stale backlog that may fire much later | Consistent with BE-26H/I precedent; combine with R-04's staleness handling if it becomes a real problem |
| R-10 | **No pre-breach warning levels** | Operators may expect "warn at 80%" | Explicitly deferred; would need a second trigger source inside SLA-01 clock arithmetic. Out of scope |
| R-11 | **No org relation for "building responsible"** | Cannot target a building manager directly | Modelled as `BUILDING_ROLE` / `BUILDING_PERMISSION` over relations that exist (§5.3). Do not add a building-manager column in this CR |
| R-12 | **Non-User assignees** (`VENDOR_PIC`, workforce with `user_id = NULL`) | Escalation cannot reach them in-app | Documented limit (§5.5); reaching them needs real email/WhatsApp, i.e. `CR-BE-NOTIFY-PROV-01` |
| R-13 | **Name collision with BE-21D `finding-escalations`** | Reviewer/engineer confusion; accidental coupling | Strict `sla_escalation_*` naming; no reuse of BE-21D in either direction |
| R-14 | **Migration numbering** | Collision with a parallel CR | Last applied is `0294_add_sla_clock_breach`; this CR reserves `0295`, `0296`, `0297` and must re-check at PART start |
| R-15 | **Multi-instance execution** | Today only one in-process scheduler runs | `FOR UPDATE SKIP LOCKED` + claim-before-send are already multi-instance-safe; no assumption of single-process correctness is introduced |
| R-16 | **Timezone/calendar** | 24×7 elapsed minutes only, inherited from SLA-01 | `offset_minutes` is elapsed minutes, consistent with `target_minutes`; no business calendar exists and none is invented |

### Constraints restated

- Reuse — never rebuild — SLA definition/snapshot/clock/pause/breach, the Work Order authority, the due-job scheduler/dispatcher, the BE-26 notification foundation, RBAC/isolation, and operational events.
- No second scheduler or worker framework.
- No provider delivery (email/WhatsApp/push).
- No invented organization relationships.
- Branch is fixed to `arena/01a02c55-asentra-backend`.

---

## 12. Proposed lightweight PART breakdown

Five small PARTs, each independently reviewable, each leaving the system in a shippable state. Nothing before PART 03 can send a message.

### PART 01 — Escalation policy and level configuration
- Migrations `0295_create_sla_escalation_policies`, `0296_create_sla_escalation_levels`.
- `src/modules/sla-escalation-policies`: types, repository, service, validation, routes, index.
- Admin API: `POST/GET /clients/{clientId}/sla-escalation-policies`, `GET/PATCH /sla-escalation-policies/{id}`, `POST/GET /sla-escalation-policies/{id}/levels`, `PATCH /sla-escalation-levels/{id}`.
- RBAC `client_configuration.read/manage` + Client/Building access; Building-belongs-to-Client validation; `template_key` must reference an existing template; `recipient_rule` structurally validated (specs + derived enum).
- **No runtime triggering. No breach coupling.**

### PART 02 — Action ledger and breach-time materialization
- Migration `0297_create_sla_escalation_actions`.
- Policy selection resolver (specificity + ambiguity fail-closed).
- `materializeSlaEscalationSchedule(clock, workOrder, tx)` called from the first-breach branch of `evaluateBreach` **and** of `processDueSlaClocks`; wrap the dispatcher path in `withTransaction` (R-07).
- Cancellation of `PENDING` actions in `satisfyClock` / `terminateClocks`.
- Events `SLA_ESCALATION_SCHEDULED`, `SLA_ESCALATION_CANCELLED`, `SLA_ESCALATION_POLICY_AMBIGUOUS`.
- **Still sends nothing.**

### PART 03 — Due execution and notification intent
- `findDueSlaEscalations(before)` (`FOR UPDATE SKIP LOCKED`) + `triggerSlaEscalation(id)` with claim-before-send.
- Derived-target expansion → BE-26C specs; injected Client/Building scope; `resolveRecipients`; BE-26B render; BE-26A `recordNotification` per recipient.
- Persist `recipients_resolved`, `notifications_created`, `failure_reason`; emit `SLA_ESCALATION_TRIGGERED`.

### PART 04 — Dispatcher and scheduler integration
- Add `slaEscalations` domain to `processDueOperationalJobs`, ordered after `processDueSlaClocks`.
- Normalize `processDueSlaClocks` to `DueJobDomainResult`; add `slaClocks` + `slaEscalations` to `DueJobDispatchResult`; update `tests/cr-be-stab-01-due-job-dispatcher.test.ts`.
- Bounded batch size; failure isolation; empty-window safety; no new env var; scheduler stays off under `NODE_ENV=test`.

### PART 05 — Read API, contract, and documentation closure
- `GET /work-orders/{id}/sla/escalations` (`work_order.read`) returning the action ledger with policy/level provenance and counts; optionally extend `GET /work-orders/{id}/sla`.
- OpenAPI paths/schemas/permissions/`x-building-scoped`/error contracts in `docs/api/openapi.yaml`.
- Update this document with PART implementation findings; update `docs/known-issues.md` only if a real deferral is created.
- No provider work, no CI/KI-003 reopen.

---

## 13. Targeted validation strategy

Focused tests only. **No full regression, no broad `npm test`, no CI run, and no CI/KI-003 reopen** — consistent with CR-BE-SLA-01's validation policy. Use injected/fixed instants or database transaction timestamps; never wall-clock sleeps.

**PART 01 — configuration**
- Client ownership, `UNIQUE(client_id, code)`, Building-belongs-to-Client rejection, cross-Client and cross-Building denial.
- `clock_type` / `priority` / `operational_type` CHECK enforcement; `effective_to > effective_from`.
- Level uniqueness per policy, `offset_minutes >= 0`, non-existent `template_key` rejected, malformed `recipient_rule` rejected, unknown derived-target kind rejected.
- `client_configuration.manage` required for writes; `client_configuration.read` for reads.

**PART 02 — selection, materialization, cancellation**
- Specificity ordering Building > exact clock_type > work_type > priority; `ANY` loses to an exact `clock_type` match.
- Tie → nothing scheduled + `SLA_ESCALATION_POLICY_AMBIGUOUS`; no-match → breach still persists, no actions, no error.
- Materialization occurs on the **first** breach write only; a second `evaluateBreach` creates no rows; `UNIQUE(sla_clock_id, escalation_level_id)` holds under a forced double insert.
- Both breach paths (lifecycle transaction and dispatcher) materialize identically; a rolled-back lifecycle transaction leaves neither breach nor actions.
- `due_at = breached_at + offset_minutes`, computed once and stable across later policy edits.
- Clock `SATISFIED` / `TERMINATED` cancels `PENDING` actions and leaves `TRIGGERED` ones untouched.
- Policy edit after materialization does not change the snapshotted `template_key` / `recipient_rule`.
- SLA-01 regression guards: `applied_slas` still immutable, clock statuses unchanged, `breached_at` still non-terminal, pause accounting untouched.

**PART 03 — execution and recipients**
- Claim-before-send: two concurrent triggers → exactly one `TRIGGERED`, one notification set; a re-trigger of a `TRIGGERED`/`CANCELLED` action is a no-op.
- Inactive template → not claimed, stays `PENDING`.
- Derived targets: WORKFORCE assignee → assignee's User; TEAM assignee → team members; VENDOR assignee → `VENDOR_PIC` spec; supervisor via `resolveCurrentSupervisor`; TEAM assignee supervisor → empty (no invented relation); no ACTIVE assignment → empty; creator always resolves.
- Scope injection cannot be widened by a stored rule; a recipient without Building access is filtered out; zero recipients is `TRIGGERED` with `recipients_resolved = 0`, not a failure.
- Notification metadata carries `slaClockId`, `clockType`, `policyId`, `level`, `breachedAt`; `sourceEntityType='WORK_ORDER'`.
- Negative assertions: no Work Order status/priority/assignment write, no `finding_escalation_incidents` row, no `applied_slas`/`sla_clocks` mutation, no email/WhatsApp/push adapter invocation.

**PART 04 — dispatcher/scheduler**
- Empty window → all-zero result, no error.
- Per-item failure isolation: one throwing action does not stop the rest; `failures` counted.
- Run order: a breach detected in a tick can fire its `offset_minutes = 0` level in the same tick.
- Result contract includes `slaClocks` and `slaEscalations`; existing reminder/escalation counts unchanged.
- Scheduler remains disabled under `NODE_ENV=test`; no new env var; singleton/`inFlight` guards intact.
- Idempotency across two consecutive dispatcher runs: no duplicate notifications.

**PART 05 — contract**
- `GET /work-orders/{id}/sla/escalations` requires `work_order.read`, enforces Building isolation, returns ordered levels with status/counters, `[]` when none.
- OpenAPI structural check consistent with `tests/sla-definitions-openapi.test.ts`.

**Suggested new test files:** `tests/sla-escalation-policies.test.ts`, `tests/sla-escalation-materialization.test.ts`, `tests/sla-escalation-dispatch.test.ts`, `tests/sla-escalation-openapi.test.ts`. Existing suites to keep green: `sla-definitions`, `sla-application-clocks`, `sla-pause-accounting`, `sla-breach-scheduler-part05`, `cr-be-stab-01-due-job-dispatcher`, `cr-be-stab-01-due-job-scheduler`, `notification*`.

---

## START GOVERNANCE boundary confirmation

This deliverable was produced by inspecting source, migrations, seeds, tests, governance documents, and API contracts on `arena/01a02c55-asentra-backend` at `e587e08`. No business implementation, migration, route, runtime logic, scheduler job, permission seed, OpenAPI change, notification behavior, unrelated refactor, PR, or merge was created. Full regression, CI, and CI/KI-003 were not run or reopened. Implementation stops here pending PART approval.

---

## PART 01 implementation note — Escalation Policy & Level Foundation (delivered)

PART 01 is implemented. This section records what actually landed, where it deviates from the
plan above, and the exact hooks PART 02 continues from. Where this section and the earlier
planning sections disagree, **this section is authoritative for what exists today**.

### 1. Files delivered

| Path | Role |
| --- | --- |
| `src/database/migrations/0295_create_sla_escalation_policies.ts` | `sla_escalation_policies` table |
| `src/database/migrations/0296_create_sla_escalation_levels.ts` | `sla_escalation_levels` table |
| `src/database/migrations/index.ts` | both migrations registered in order after `0294` |
| `src/modules/sla-escalation-policies/sla-escalation-policy.types.ts` | vocabulary, records, inputs, public shapes |
| `src/modules/sla-escalation-policies/sla-escalation-policy.validation.ts` | body/filter parsing, recipient-rule validation |
| `src/modules/sla-escalation-policies/sla-escalation-policy.repository.ts` | SQL for policies and levels |
| `src/modules/sla-escalation-policies/sla-escalation-policy.service.ts` | isolation, template check, conflicts |
| `src/modules/sla-escalation-policies/sla-escalation-policy.controller.ts` | HTTP handlers |
| `src/modules/sla-escalation-policies/sla-escalation-policy.routes.ts` | router + permission guards |
| `src/modules/sla-escalation-policies/index.ts` | module export surface |
| `src/routes/index.ts` | router mounted in the central registry |
| `docs/api/openapi.yaml` | 4 path items, 9 schemas |
| `tests/sla-escalation-policies.test.ts` | behavioral suite (embedded Postgres, port `55503`) |
| `tests/sla-escalation-openapi.test.ts` | contract + negative-surface suite |

Migration `0297` remains reserved and unused — the escalation action ledger is PART 02.

### 2. Policy model as built

`sla_escalation_policies(id, client_id → clients, building_id → buildings NULL, code, name,
description, operational_type, clock_type, work_type, priority, status, effective_from,
effective_to, created_at, updated_at)`.

- `UNIQUE (client_id, code)`; `code ~ '^[A-Z][A-Z0-9_.-]*$'`, uppercased on write.
- `operational_type = 'WORK_ORDER'` (single-value CHECK — the extension point for future
  operational types is the CHECK plus the `SLA_ESCALATION_OPERATIONAL_TYPES` tuple).
- `clock_type IN ('RESPONSE','RESOLUTION','ANY')`.
- `work_type` free text uppercased, nullable — no new work-type authority was created.
- `priority IS NULL OR IN ('LOW','MEDIUM','HIGH','CRITICAL')`, validated in code through
  `isWorkOrderPriority` so the Work Order module stays the single source of truth.
- `status IN ('ACTIVE','INACTIVE')`, default `ACTIVE`; `effective_to IS NULL OR > effective_from`.
- Indexes: `(client_id, status, effective_from)` for listing and
  `(client_id, building_id, operational_type, clock_type, status)` for PART 02 candidate lookup.
- Immutable after create: `building_id`, `code`, `operational_type`. The update body rejects them.

### 3. Level model as built

`sla_escalation_levels(id, policy_id → sla_escalation_policies ON DELETE CASCADE, level,
offset_minutes, template_key → notification_templates(key), recipient_rule JSONB, status,
created_at, updated_at)`.

- `UNIQUE (policy_id, level)`, `level >= 1`, `offset_minutes >= 0` (0 = fire at breach time).
- `offset_minutes` uniqueness **within a policy** is enforced in the service, not by a DB
  constraint, so PART 02 gets a deterministic single level per offset without a schema change.
- `template_key` is a real FK to the BE-26B template catalogue and additionally pre-checked in
  the service so an unknown key returns a 400 field error rather than a raw FK violation.
- `recipient_rule` is stored JSONB. It is **validated, never resolved**.
- Levels are always returned ordered by `level`.

### 4. Applicability and specificity

PART 01 stores the applicability dimensions (`building_id`, `clock_type`, `work_type`,
`priority`, `effective_from/to`, `status`) and validates them. It **does not select** a policy for
a Work Order — no candidate query, no scoring, no ambiguity event. The specificity weights in
§3.4 (Building 8 / exact clock 4 / work type 2 / priority 1, tie ⇒ schedule nothing +
`SLA_ESCALATION_POLICY_AMBIGUOUS`) remain a PART 02 obligation and are unimplemented today.
`clock_type = 'ANY'` is deliberately stored as its own value rather than expanded into two rows.

### 5. Recipient-rule storage boundary

The stored rule accepts exactly three keys — `specs`, `derived`, `scope` — and requires at least
one static spec or one derived target.

- `specs` and `scope` are validated by reusing `parseRecipientRule` from
  `src/modules/recipient-resolution` unchanged. BE-26C was not modified, extended, or forked.
- `derived` is the PART 01 extension: `WORK_ORDER_ASSIGNEE`, `WORK_ORDER_ASSIGNEE_SUPERVISOR`,
  `WORK_ORDER_CREATOR`, `BUILDING_ROLE` (requires `roleCode`), `BUILDING_PERMISSION` (requires
  `permissionCode`). Codes are normalized, `roleCode`/`permissionCode` on any other kind is
  rejected, and duplicate `kind:code` pairs are rejected.
- A derived-only rule still gets its `scope` validated, via a local `scopeOnly()` helper, because
  BE-26C only validates scope alongside specs.
- **Nothing is resolved.** No user lookup, no notification, no organizational relationship was
  invented. The derived kinds are configuration vocabulary whose resolvability PART 03 must
  verify against existing authorities before promising delivery.

### 6. Permissions and isolation

No new permission was introduced. Reads require `client_configuration.read`, writes require
`client_configuration.manage` — both already seeded. Isolation mirrors SLA-01 exactly: a
Building-scoped row is gated by `contextAccessService.assertBuildingAccess`, a Client-scoped row
by `canAccessClient`; a `buildingId` supplied on create or as a list filter is cross-checked
against the Client via `resolveBuildingConfigurationContext`. Level access is always derived from
the parent policy, so a level cannot be reached outside the policy's own scope.

### 7. API surface

`POST|GET /clients/{clientId}/sla-escalation-policies`,
`GET|PATCH /sla-escalation-policies/{id}`,
`POST|GET /sla-escalation-policies/{id}/levels`,
`GET|PATCH /sla-escalation-levels/{id}`.

No delete, no execution endpoint, no manual trigger, no `/work-orders/{id}/sla/escalations`.
OpenAPI documents only these eight operations plus the nine PART 01 schemas.

### 8. Targeted validation performed

- `npm run typecheck` — clean.
- `npx tsx --test --test-concurrency=1 tests/sla-escalation-policies.test.ts` — 11/11 pass.
- `npx tsx --test --test-concurrency=1 tests/sla-escalation-openapi.test.ts` — 4/4 pass.

No broad `npm test`, no full regression, no CI, no CI/KI-003.

### 9. PART 02 extension points

1. **Migration `0297`** — `sla_escalation_actions` ledger; still unused, still the next number.
2. **Candidate query** — add `slaEscalationPolicyRepository.findApplicablePolicies(...)` against
   the existing `(client_id, building_id, operational_type, clock_type, status)` index; the
   effective-period and `ANY` clock filters belong in that query, not in new columns.
3. **Specificity scoring + ambiguity** — implement §3.4 in a new selection function; emit
   `SLA_ESCALATION_POLICY_AMBIGUOUS` and schedule nothing on a tie.
4. **Materialization** — snapshot `template_key` and `recipient_rule` into the action row at
   breach time so later policy edits cannot retroactively change a scheduled action.
5. **Breach hook** — the first-breach branch of `evaluateBreach`; PART 01 touched no SLA-01 code.
6. **Scope override** — the executor must force
   `scope = { clientId: appliedSla.clientId, buildingIds: [workOrder.buildingId] }`; stored rules
   may narrow, never widen. The validation layer already normalizes scope UUIDs for this.
7. **Derived resolution** — `derived[]` needs a resolver in PART 03; known limits stand
   (nullable `workforce_profiles.user_id`, `VENDOR_PIC` resolves to no User, zero recipients is a
   valid `TRIGGERED` outcome).
8. **Dispatcher key** — adding `slaEscalations` to the due-job dispatcher result will break
   `tests/cr-be-stab-01-due-job-dispatcher.test.ts`; that update is in scope for PART 04, not now.

---

## PART 02 implementation note — Escalation Action Ledger & Breach-Time Materialization (delivered)

PART 02 is implemented. This section records what actually landed and where it deviates from the
plan above. Where this section and the earlier planning sections disagree, **this section is
authoritative for what exists today**. PART 02 still sends nothing.

### 1. Files delivered

| Path | Role |
| --- | --- |
| `src/database/migrations/0297_create_sla_escalation_actions.ts` | `sla_escalation_actions` ledger |
| `src/database/migrations/index.ts` | `0297` registered after `0296` |
| `src/modules/sla-escalation-actions/sla-escalation-action.types.ts` | statuses, cancel reasons, action record, `SlaBreachContext` |
| `src/modules/sla-escalation-actions/sla-escalation-action.repository.ts` | executor-aware SQL: candidate scoring, ACTIVE levels, insert, cancel, reads |
| `src/modules/sla-escalation-actions/sla-escalation-action.service.ts` | selection, ambiguity, materialization, cancellation, events |
| `src/modules/sla-escalation-actions/index.ts` | module export surface |
| `src/modules/applied-slas/sla-clock-lifecycle.service.ts` | breach hook + cancellation hooks (SLA-01 behavior otherwise unchanged) |
| `src/modules/applied-slas/applied-sla.service.ts` | `processDueSlaClocks` made per-clock transactional |
| `tests/sla-escalation-materialization.test.ts` | behavioral suite (embedded Postgres, port `55504`) |

No route, controller, validation, permission, OpenAPI, or provider change: PART 02 adds **no API
surface**. The dispatcher (`due-job-dispatcher`) was not touched — that is PART 04.

### 2. Action model (migration `0297`)

One row = one escalation level materialized for one breached SLA clock. Foreign keys to
`applied_slas`, `sla_clocks`, `work_orders`, `clients`, `buildings`, `sla_escalation_policies`,
`sla_escalation_levels`, and `notification_templates(key)` — the row carries the full operational
address so PART 03 never has to re-derive it.

- Snapshots: `template_key`, `recipient_rule` (JSONB), `clock_type`, `level`, `breached_at`.
- `due_at` is an **absolute instant**, computed once as `breached_at + offset_minutes`
  (`$13::timestamptz + make_interval(mins => $14::int)`), never recomputed.
- Status vocabulary `PENDING | TRIGGERED | CANCELLED | SKIPPED`, with `triggered_at`,
  `cancelled_at`, `cancel_reason`, `recipients_resolved`, `notifications_created`,
  `failure_reason`. PART 02 writes only `PENDING` and `CANCELLED`; the rest are PART 03 columns
  created now so PART 03 needs no further migration.
- Constraints: `UNIQUE (sla_clock_id, escalation_level_id)` named
  `sla_escalation_actions_clock_level_unique`, `clock_type IN ('RESPONSE','RESOLUTION')`,
  `level >= 1`, status CHECK, `due_at >= breached_at`, non-negative counters, and a
  status↔timestamp consistency CHECK (a `PENDING` row cannot carry `triggered_at`, a `CANCELLED`
  row cannot, etc.).
- Indexes: partial `(status, due_at) WHERE status='PENDING'` (PART 03's due query),
  `(work_order_id, level)` (PART 05's read API), `(client_id, created_at DESC)`.

Deviation from §8.1: the planned `attempt_count` / `last_attempt_at` columns were **not** created.
PART 02 has no retry semantics, and PART 03's claim-before-send determines their real shape;
adding unused columns now would freeze the wrong contract.

### 3. Selection and ambiguity

`findApplicablePolicies` filters exactly like SLA-01's `selectApplicable` — same Client, ACTIVE,
effective at the **persisted `breached_at`**, `operational_type='WORK_ORDER'`, and Building /
`work_type` / `priority` each NULL-or-equal — plus the escalation-only widening
`clock_type = <breached clock> OR clock_type = 'ANY'`.

Scoring is computed in SQL and frozen as documented: **Building 8, exact `clock_type` 4,
`work_type` 2, `priority` 1**, ordered `specificity DESC, code`. Because Building outweighs the
sum of everything else, a Building policy always wins; because an exact `clock_type` outweighs
`work_type + priority`, `ANY` never beats an exact match at equal scope.

Outcomes are explicit (`MaterializationOutcome`):

- `NO_POLICY` — nothing matched. The breach still persists; this is not an error.
- `AMBIGUOUS` — two or more candidates share the top score. **Fails closed**: zero rows written,
  and `SLA_ESCALATION_POLICY_AMBIGUOUS` records the tied `policyIds`/`policyCodes` and the score.
  Unlike SLA-01's ambiguity (a 409 to the caller), a breach has no caller to reject, so silence
  plus an audit trail is the only safe outcome.
- `NO_LEVELS` — a policy was selected but has no ACTIVE levels ("configured but silent").
- `SCHEDULED` — one row per ACTIVE level, plus a single `SLA_ESCALATION_SCHEDULED` event
  summarizing all levels (one event per breach, not one per level).

INACTIVE levels are skipped at materialization and are never backfilled later.

### 4. Materialization, cancellation, idempotency

Materialization runs **only inside the first-write branch of a breach**:

- Lifecycle path — `evaluateBreach` calls the new exported
  `materializeBreachEscalation(workOrder, breachedClock, tx)` in the same `if (b)` branch that
  emits `SLA_CLOCK_BREACHED`, using the caller's transaction.
- Dispatcher path — `processDueSlaClocks` now wraps **each due clock in its own
  `withTransaction`** (R-07). The Work Order lookup, `markBreached`, `SLA_CLOCK_BREACHED`, and the
  action inserts commit together; one clock's failure isolates to that clock. The function still
  returns a count and keeps the `FOR UPDATE SKIP LOCKED` candidate scan unchanged, so
  `tests/sla-breach-scheduler-part05.test.ts` and the dispatcher's result contract are untouched.

Both paths build the identical `SlaBreachContext` and therefore produce identical ledgers.

Cancellation: `satisfyClock` and `terminateClocks` call
`cancelPendingEscalationActions(clockId, 'CLOCK_SATISFIED' | 'CLOCK_TERMINATED', at, tx)` right
after `transitionClock`, inside the same transaction. The UPDATE is guarded by
`status='PENDING'`, so `TRIGGERED` rows — real, already-sent history — are never rewritten, and a
repeated terminal transition cancels nothing and emits no second event.
`SLA_ESCALATION_CANCELLED` is emitted only when at least one row actually changed.

Four idempotency layers, all exercised by the suite:

1. `markBreached` is first-write idempotent, so the materialization branch runs at most once.
2. `UNIQUE (sla_clock_id, escalation_level_id)` with
   `ON CONFLICT ON CONSTRAINT … DO NOTHING` — a duplicate attempt yields `null`, not a second row
   and not an aborted transaction. A raw duplicate INSERT still raises `23505`.
3. The caller's transaction — a rollback leaves neither `breached_at` nor any action row.
4. Snapshot immunity — later edits to the level's offset, template, rule, or status, and even
   deactivating the policy, leave existing rows byte-identical.

### 5. Boundary held

Escalation is strictly additive. PART 02 writes to `sla_escalation_actions` and
`operational_events` only: no Work Order status/priority write, no `applied_slas` mutation, no new
clock status (`breached_at` remains historical), no pause-interval write, no notification, no
recipient resolution, no provider, no scheduler, no manual trigger, no new endpoint.

### 6. Targeted validation performed

- `npm run typecheck` — clean.
- `npx tsx --test --test-concurrency=1 tests/sla-escalation-materialization.test.ts` — 9/9 pass
  (specificity ordering incl. `ANY` losing to an exact match; tie → nothing + ambiguous event;
  no-match → breach persists; first-breach-only materialization + forced duplicate insert;
  lifecycle and dispatcher paths identical; rollback leaves neither breach nor actions;
  `due_at`/snapshot frozen against policy edits; SATISFIED/TERMINATED cancellation preserving
  `TRIGGERED`; SLA-01 regression + absent execution surface).
- `npx tsx --test --test-concurrency=1 tests/sla-breach-scheduler-part05.test.ts` — 5/5 pass
  (the directly affected SLA-01 breach suite).

No broad `npm test`, no full regression, no CI, no CI/KI-003.

One real defect was found and fixed by these tests: the insert originally reused `$13` as both a
timestamp and an interval operand, which PostgreSQL rejected with `42P08`
("inconsistent types deduced for parameter"). Both uses are now explicitly `::timestamptz`.

### 7. PART 03 extension points

1. **Due query** — add `findDueSlaEscalations(before)` using
   `status='PENDING' AND due_at <= $1` with `FOR UPDATE SKIP LOCKED`; the partial index
   `sla_escalation_actions_due_idx` already covers it.
2. **Claim-before-send** — a guarded `UPDATE … SET status='TRIGGERED', triggered_at=$2 WHERE
   id=$1 AND status='PENDING' RETURNING *` is the concurrency primitive; the status↔timestamp
   CHECK already forbids a `TRIGGERED` row without `triggered_at`.
3. **Snapshot is the input** — resolve `recipient_rule` and render `template_key` from the
   **action row**, never by re-reading the level; that is what makes execution replay-safe.
4. **Scope override** — force `scope = { clientId: action.clientId, buildingIds: [action.buildingId] }`;
   both columns are on the row for exactly this reason. Stored rules may narrow, never widen.
5. **Counters** — persist `recipients_resolved` / `notifications_created` on the claimed row;
   zero recipients is a valid `TRIGGERED` outcome, not a failure. `failure_reason` carries the
   non-fatal explanation; `SKIPPED` remains reserved for a deactivated-level outcome.
6. **Events** — `SLA_ESCALATION_TRIGGERED` should follow the PART 02 convention:
   `entityType='WORK_ORDER'`, `entityId = work order id`, the caller's `tx` as executor.
7. **Read seams already present** — `listActionsForClock` / `listActionsForWorkOrder` are ordered
   and executor-aware; PART 05's `GET /work-orders/{id}/sla/escalations` can project them
   directly.
8. **Dispatcher key** — adding `slaEscalations` to the due-job dispatcher result will break
   `tests/cr-be-stab-01-due-job-dispatcher.test.ts`; that update remains PART 04's scope.

---

## PART 04 implementation note — Due-Job Dispatcher / Scheduler Integration (delivered)

PART 04 is implemented. This section records what actually landed. Where it disagrees with the
planning sections above, **this section is authoritative for what exists today**. With PART 04 the
chain is live end to end: a breach detected on a scheduler tick materializes its ledger rows
(PART 02) and the due levels are claimed and delivered (PART 03) — automatically, with no manual
call.

### 1. Files delivered

| Path | Role |
| --- | --- |
| `src/modules/due-job-dispatcher/due-job-dispatcher.types.ts` | `DueJobDispatchResult` gains `slaClocks` + `slaEscalations` |
| `src/modules/due-job-dispatcher/due-job-dispatcher.service.ts` | SLA clock domain normalized + `processDueSlaEscalations` wired in as domain 4 |
| `tests/cr-be-stab-01-due-job-dispatcher.test.ts` | existing suite kept; PART 04 integration suite added |

No migration, no route, no controller, no validation, no permission, no OpenAPI change. **No file
under `src/modules/due-job-scheduler/`, `src/server.ts`, or `src/config/` was touched** — see §3.

### 2. Run order (as built)

```text
processDueOperationalJobs(before = new Date())
  1. reminders        findDueReminders   / dispatchReminder     [unchanged]
  2. escalations      findDueEscalations / triggerEscalation    [unchanged]
  3. slaClocks        processDueSlaClocks(before)               [existing call, now reported]
  4. slaEscalations   processDueSlaEscalations(before)          [new]
```

Domain 4 runs **after** domain 3, exactly as §6.2 requires: the breach persisted in step 3
materializes its actions inside SLA-01's own per-clock transaction, so an `offset_minutes = 0`
level is already `PENDING` and due when step 4 enumerates the window. The escalation fires in the
**same tick** rather than waiting a full `SCHEDULER_INTERVAL_MS`. A test asserts this directly.

### 3. Scheduler authority — unchanged by design

`startDueJobScheduler(config.scheduler)` in `src/server.ts` remains the only scheduler. Its
singleton guard, `inFlight` skip, bounded drain on shutdown, `SCHEDULER_ENABLED` /
`SCHEDULER_INTERVAL_MS` config, and forced-off behaviour under `NODE_ENV=test` are all untouched.
PART 04 introduces **no new timer, process, queue, worker, or environment variable** — it only
enriches what the existing tick already calls, because the scheduler invokes
`processDueOperationalJobs()` with no arguments and therefore picked up both new domains for free.

### 4. Result contract change (additive)

```ts
export type DueJobDispatchResult = {
  reminders: DueJobDomainResult;       // unchanged meaning and counts
  escalations: DueJobDomainResult;     // unchanged meaning and counts
  slaClocks: DueJobDomainResult;       // new — breaches persisted this tick
  slaEscalations: DueJobDomainResult;  // new — levels triggered this tick
  executedAt: string;
};
```

Only keys were added; no existing key changed type or value. Mapping:

| Domain | `processed` | `notificationsCreated` | `failures` |
| --- | --- | --- | --- |
| `slaClocks` | clocks newly marked breached | always `0` (breach detection sends nothing) | `1` if the whole batch threw |
| `slaEscalations` | `triggered` | `notificationsCreated` | `failures` |

Deviation from §6.3, deliberate: `processDueSlaClocks` **keeps** its `Promise<number>` signature and
is adapted at the dispatcher instead. §6.3 explicitly permits either. Changing an SLA-01 authority
signature would have touched SLA-01 behavior and its callers (including
`tests/sla-escalation-materialization.test.ts`) for a purely cosmetic gain; adapting at the seam
keeps PART 04 inside its blast radius.

`processDueSlaEscalations` reports `due` and `skipped` too; neither is surfaced. A skip is a due
action deliberately left `PENDING` — a claim lost to a concurrent runner, or a deactivated template
— which is neither work performed nor an error. It simply stays due for the next tick, so folding
it into `processed` or `failures` would misreport the run.

### 5. Safety properties (all reused, none re-implemented)

- **Bounded batch** — PART 03's due query is `LIMIT clampDueItemLimit(limit)`
  (`DUE_ITEM_RETRIEVAL_LIMIT = 100`) with `FOR UPDATE SKIP LOCKED`. The dispatcher passes no limit
  and therefore inherits the cap; a large backlog drains over several ticks instead of one long run.
- **Per-item isolation** — PART 03 already wraps each action in its own `try/catch`. The dispatcher
  adds a per-domain `try/catch` on top, so an infrastructure failure inside one SLA domain is
  counted as a failure and the remaining domains still execute in the same tick.
- **Empty window** — every domain returns all-zero without error and without touching the database
  beyond its due query.
- **Idempotency** — guaranteed by the layers below, not by the dispatcher: `markBreached` is
  `breached_at IS NULL`-guarded, and the escalation claim is a status-guarded
  `PENDING → TRIGGERED` UPDATE. Two consecutive runs therefore produce zero duplicate
  notifications; a test asserts this on a real breach.

### 6. Targeted validation performed

- `npm run typecheck` — clean.
- `npx tsx --test --test-concurrency=1 tests/cr-be-stab-01-due-job-dispatcher.test.ts` — **10/10**
  pass. The 5 pre-existing CR-BE-STAB-01 tests are unmodified except for the empty-window case,
  which now also asserts both SLA domains are all-zero (R-08 resolved additively). The 5 new PART 04
  tests cover: same-tick breach → `offset_minutes = 0` delivery; idempotency across two consecutive
  runs; a post-claim render failure isolated and counted while its neighbour still delivers;
  reminder/escalation counts unchanged with the exact five-key result shape; and the scheduler
  staying `null` under `NODE_ENV=test` with `SCHEDULER_ENABLED=true`.
- `npx tsx --test --test-concurrency=1 tests/cr-be-stab-01-due-job-scheduler.test.ts
  tests/sla-breach-scheduler-part05.test.ts` — 20/20 pass (the only other suites that read the
  dispatcher/scheduler seam; both unmodified).

No broad `npm test`, no full regression, no CI, no CI/KI-003.

### 7. PART 05 extension points

1. **Nothing left to wire** — execution is fully automatic. PART 05 is a read surface only:
   `GET /work-orders/{id}/sla/escalations` plus its OpenAPI contract.
2. **Read seams exist** — `listActionsForWorkOrder` / `listActionsForClock` are ordered and
   executor-aware; the `(work_order_id, level)` index from `0297` already serves them.
3. **Projected fields** — the action row carries everything the response needs (`level`,
   `clockType`, `status`, `dueAt`, `triggeredAt`, `recipientsResolved`, `notificationsCreated`,
   `failureReason`, `cancelReason`). Recipient identities must **not** be projected; the same
   no-sensitive-data rule that governs event metadata applies to the API.
4. **Isolation** — reuse the existing Work Order read permission and Client/Building scoping; the
   action row's own `client_id` / `building_id` make the check a direct column comparison.

---

## PART 05 implementation note — Read API, Contract, and Documentation Closure (delivered)

PART 05 is implemented and **closes CR-BE-SLA-02**. This section records what actually landed and,
where it disagrees with the planning sections above, **is authoritative for what exists today**.

PART 05 adds no behaviour. It is a projection of the ledger PART 02 writes and PART 03/PART 04
execute: one GET route, one read model, one OpenAPI path, one schema. No migration, no repository
change, no execution change, no scheduler change, no permission seed, no provider work.

### 1. Files delivered

| Path | Role |
| --- | --- |
| `src/modules/sla-escalation-actions/sla-escalation-action.read.ts` | `PublicSlaEscalationAction` + `toPublicSlaEscalationAction` + `listWorkOrderEscalations` |
| `src/modules/sla-escalation-actions/sla-escalation-action.routes.ts` | `createSlaEscalationActionRouter()` — GET-only |
| `src/modules/sla-escalation-actions/index.ts` | barrel exports the router, read seam, and public type |
| `src/routes/index.ts` | registers the router after `createSlaEscalationPolicyRouter()` |
| `docs/api/openapi.yaml` | path `/work-orders/{id}/sla/escalations` + schema `SlaEscalationAction` |
| `tests/sla-escalation-read-api.test.ts` | new focused suite (5 tests) |
| `tests/sla-escalation-openapi.test.ts` | PART 01 negative assertions updated for the new path |

### 2. The route

`GET /work-orders/{id}/sla/escalations` → `200 { success: true, data: SlaEscalationAction[] }`.

Ordered by `clock_type, level` — the order the levels were configured to fire — straight from
`slaEscalationActionRepository.listActionsForWorkOrder`, which the `(work_order_id, level)` index
from migration `0297` already serves. No new repository code was needed.

Access authority is byte-for-byte the authority of `GET /work-orders/{id}/sla`:

1. `authenticationMiddleware` → 401.
2. `requirePermission('work_order.read')` → 403. §10.1 holds: escalation history is Work Order
   data, so it reuses the Work Order permission; no SLA-specific permission was invented and none
   was seeded.
3. `workOrderService.getWorkOrderById(id)` → 404 for an unknown Work Order, so an unknown id never
   reaches the ledger and an empty array never doubles as an existence probe.
4. `contextAccessService.assertBuildingAccess(caller, workOrder.buildingId)` → 403.

**Isolation is derived from the Work Order, never from the caller.** No `clientId` or `buildingId`
is read from the query string, body, or headers; supplying them changes nothing (asserted). The
action row's own `client_id`/`building_id` are returned but are never the basis of the check — the
Work Order is the single authority, so the two can never disagree.

An empty ledger is `200 []`, not 404: never breached, no applicable policy, and no SLA at all are
all normal states.

### 3. Privacy boundary (the substantive decision in PART 05)

`SlaEscalationActionRecord` has 23 fields; the public model publishes 22. The one omission is
**`recipientRule`**, and it is deliberate:

- The snapshotted rule enumerates Users, roles, permissions, teams, and derived targets. Publishing
  it would tell every holder of `work_order.read` **who** was notified — and who is configured to be
  notified — which is a strictly wider audience than the recipients themselves.
- What the caller gets instead is `recipientsResolved` and `notificationsCreated`: aggregate counts
  that prove the escalation resolved people and created notifications, without naming one.
  Notification content stays where it belongs, on the notification surface, visible to its own
  recipient.
- The projection is written as an explicit field list, not a spread-and-omit. Any column added to
  the ledger later is invisible to the API until someone deliberately publishes it — a column added
  for execution cannot leak through this seam by default. The test pins the exact key set.

**Provider-delivery data:** there is none to omit. Escalation delivery is in-app only (BE-26A), so
no provider id, transport status, address, phone number, mailbox, or delivery receipt exists
anywhere in this chain. If a provider channel is ever added, its delivery data must stay out of this
projection under the same rule.

`failureReason` **is** published: it is the operator-facing diagnostic PART 03 writes (capped at 500
characters), it carries no recipient identities, and withholding it would make a failed escalation
indistinguishable from a successful one.

### 4. Read-only by construction

The router mounts `GET` and nothing else — `POST`/`PATCH`/`PUT`/`DELETE` on the path are 404
(asserted at runtime and in the OpenAPI structural test). There is deliberately **no** manual
trigger, retry, re-send, or cancel endpoint: escalation execution belongs exclusively to the PART 04
dispatcher, and an HTTP path into it would break the claim-before-send guarantee that makes delivery
at-most-once. Reading the ledger repeatedly mutates no row (asserted by comparing `status` and
`updated_at` before and after three reads).

### 5. OpenAPI alignment

- Path `/work-orders/{id}/sla/escalations` sits directly after `/work-orders/{id}/sla`, with
  `security: [{ bearerAuth: [] }]`, `x-required-permission: work_order.read`,
  `x-building-scoped: true`, and the shared `400/401/403/404` response refs. The two extensions were
  added here (the older SLA paths predate that convention) because §10.1/§10.2 explicitly ask the
  read surface to declare its permission and Building scoping.
- Schema `SlaEscalationAction` lists all 22 published fields as `required`, reuses
  `SlaEscalationClockType` and `Uuid`, and pins `status` and `cancelReason` to the runtime enums.
  Its description states the privacy boundary in the contract itself, so a client author cannot
  mistake the omission for an oversight.
- Runtime/contract alignment is enforced by test, not by convention: the OpenAPI suite asserts the
  documented field set, the enums, and the *absence* of the recipient/provider fields; the read-API
  suite asserts the served object's exact key set. The two lists must agree or one suite fails.

### 6. Contract-test adjustment (necessary, scoped)

`tests/sla-escalation-openapi.test.ts` was written in PART 01 to assert that
`/work-orders/{id}/sla/escalations` did **not** exist (both in the spec and as a live 404). PART 05
is exactly the change those two assertions were guarding against, so they were updated rather than
deleted: the path was removed from the forbidden list and the runtime check now asserts the GET is
`401` (mounted and protected) while `POST`/`DELETE` on it remain `404`. Everything else the PART 01
test forbids — `/sla-escalations`, `/sla-escalation-actions`,
`/sla-escalation-policies/{id}/trigger`, `/sla-escalation-policies/{id}/execute`, and the policy and
level `DELETE`s — is unchanged and still asserted.

### 7. Targeted validation

- `npm run typecheck` — clean.
- `ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1
  tests/sla-escalation-read-api.test.ts` — **5/5 pass**. Coverage: ordered ledger with policy/level
  provenance and `dueAt = breachedAt + offset` timing; execution outcomes reflected after a real
  `processDueSlaEscalations()` run (`TRIGGERED`, `triggeredAt`, counts `2/2`); the privacy boundary
  proven positively (the stored rule *does* name a User and that User *was* notified, yet the id
  appears nowhere in the serialized response) plus the exact published key set; 401/403/403 access
  matrix, caller-supplied `clientId`/`buildingId` ignored, 404 unknown Work Order, 400 malformed id;
  empty ledger, no execution verb, and read-causes-no-mutation.
- `ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1
  tests/sla-escalation-openapi.test.ts` — **5/5 pass** (4 pre-existing + 1 new PART 05 contract
  test).

No broad `npm test`, no full regression, no CI, no CI/KI-003. `docs/known-issues.md` was **not**
touched: PART 05 created no deferral.

### 8. CR-BE-SLA-02 closure state

| PART | Scope | State |
| --- | --- | --- |
| 01 | Escalation Policy & Level configuration | delivered |
| 02 | Action ledger + breach-time materialization/cancellation | delivered |
| 03 | Claim-before-send execution + notification intent | delivered |
| 04 | Due-job dispatcher / scheduler integration | delivered |
| 05 | Read API + OpenAPI + documentation closure | delivered |

The chain is complete and automatic: a breach persists → its levels materialize in the same
transaction → the dispatcher claims and delivers each level at its own `due_at` → the history is
readable at `GET /work-orders/{id}/sla/escalations`. SLA-01 was not redesigned; no SLA-01 migration
or behaviour was modified; no provider (SMTP, WhatsApp, push) was implemented; no second scheduler
was created; the notification foundation was reused, not rebuilt. **CR-BE-SLA-02 is ready for FINAL
REVIEW.**
