# CR-BE-SLA-01 — START GOVERNANCE

**Title:** SLA Definition, Clock, Pause/Resume, Breach  
**Repository:** `asentra-backend`  
**Inspection date:** 2026-08-23  
**Status:** Governance only — no runtime behavior, migration, route, permission, or OpenAPI contract added

## 1. Decision summary

The safest extension is a dedicated, client-owned SLA definition and immutable applied-SLA/clock foundation which references, but never replaces, operational lifecycle authorities. An applied SLA snapshots the selected definition and target duration, then maintains one reusable clock per metric (`RESPONSE` or `RESOLUTION`). Operational services remain the only authorities for assignment, acknowledgement, hold, completion, closure, cancellation, and other state changes.

Start with **Work Order** as the only v1 consumer. It has the strongest lifecycle, persisted timestamps, an auditable action stream, priority, and explicit hold/resume semantics. Design the generic binding keys so Tenant Service Request, Tenant Complaint, Finding, Incident, and Vendor Work can be admitted later without schema redesign, but do not enable them until their start/satisfaction/pause policies are explicitly approved. In particular, do not silently move a tenant intake clock to a derived Work Order/Finding.

Use elapsed **24x7** duration in v1. Buildings provide the authoritative optional IANA timezone, and schedules carry timezones, but the repository has no business-day/holiday calendar authority. Shifts and schedule definitions are not suitable substitutes. Store and compare instants as `TIMESTAMPTZ`/UTC; retain the applied building timezone as snapshot metadata for display/audit only in 24x7 mode.

Breach is SLA-01 state and must be persisted idempotently, with the exact breach instant and an operational event. The existing in-process due-job scheduler must be extended through its dispatcher rather than creating a second scheduler. Escalation and notification remain exclusively CR-BE-SLA-02/later notification work.

## 2. Existing authority map

| Authority | Existing location | Relevant facts | SLA treatment |
|---|---|---|---|
| Client/building ownership | `clients`; Building → Property → Client; `context-access` | Building client ownership is derived; user access resolves accessible clients/buildings | Reuse exactly; an SLA row may snapshot `client_id` and bind `building_id`, but creation validates the hierarchy |
| Effective configuration | `client_configurations`, `building_configurations`, `module_configurations`; effective configuration services | Client/building override pattern, ACTIVE/INACTIVE, module entitlement intersection | Reuse scope and permissions, not generic JSON as the SLA definition authority |
| Work Order lifecycle | `work_orders`, `work-order-*` modules | Priority and controlled transitions; persisted lifecycle timestamps; actions and history | Initial consumer and source of lifecycle signals |
| Tenant intake | `tenant_service_requests`, `tenant_complaints` | Intake records have priority/severity and source timestamps; may bind/convert to downstream records | Candidate later consumer; source-to-downstream clock ownership must be decided explicitly |
| Finding lifecycle | `findings`, assignment/review/rework/closure modules | Classification/severity, assignment, state transitions, closure and history | Candidate later consumer after metric rules are approved |
| Incident lifecycle | `incidents`, incident closure and child modules | Severity/priority; reported/cancelled/closed only at foundation level | Resolution candidate; no native acknowledgement or hold authority |
| Vendor execution | `vendor_assignments`, `vendor_works`, reviews/rework/history | Assignment timestamp and explicit NOT_STARTED/IN_PROGRESS/ON_HOLD/COMPLETED lifecycle | Candidate later or a Work Order sub-clock; avoid competing with parent Work Order SLA |
| Operational events | `operational_events`, `recordOperationalEvent`, domain history helpers | Append-only event log with client/building/entity/actor/time/metadata | Record SLA lifecycle facts here, but do not make event replay the sole clock authority |
| Due execution | `due-job-scheduler`, `due-job-dispatcher` | One in-process `setInterval`, singleton/in-flight guard, failures logged and isolated per item | Add SLA breach domain processing to dispatcher in a later PART; no new scheduler |
| Management/read models | `management-*`, KPI and reporting modules | Derived projections, often query-parameter-driven overdue thresholds | Preserve; no immediate semantic replacement by SLA breach |
| RBAC | seeded permissions and route middleware | Configuration read/manage and operational domain permissions already exist | Reuse configuration permissions for definition administration and source-domain permissions for applied SLA reads/actions |

## 3. Existing SLA-like behavior

No `SLA` definition, applied SLA, response target, resolution target, SLA deadline, pause ledger, or SLA breach authority exists in migrations or runtime modules.

### 3.1 Authoritative persisted fields

- **Work Orders:** `priority`; `created_at`, first `assigned_at`, first `started_at`, `completed_at`, `closed_at`, `cancelled_at`; status includes `OPEN`, `ASSIGNED`, `IN_PROGRESS`, `ON_HOLD`, `COMPLETED`, `CANCELLED`, `CLOSED`.
- **Work Order actions:** append-only `ACKNOWLEDGED`, `STARTED`, `ON_HOLD`, `RESUMED`, `NOTE_ADDED`, `CANCELLED`, each with `occurred_at` and actor. There is no `acknowledged_at` column; acknowledgement time is authoritative in this action log.
- **Tenant Service Requests:** priority, `requested_at`, status `OPEN/CANCELLED/CONVERTED`, optional Work Request/Work Order links.
- **Tenant Complaints:** severity, `reported_at`, status `OPEN/CANCELLED/ESCALATED`, optional Finding/Work Order links.
- **Findings:** `reported_at`, `state_changed_at`, optional classification/severity, assignment `assigned_at`, closure `closed_at`; controlled states include operational review/rework states.
- **Incidents:** severity, priority, `reported_at`, `cancelled_at`, `closed_at`.
- **Vendor:** assignment `assigned_at`; Vendor Work `started_at`, `completed_at`, explicit `ON_HOLD`; reviews provide `reviewed_at`; rework provides `requested_at`/`resubmitted_at`.
- Other due dates (for example corrective-action due dates, invoices, document expiry, utility-reading dues, schedules) are authoritative only for their own domains and are not reusable SLA authority.

### 3.2 Derived/reporting-only behavior

Several KPI/read-model modules label records `overdue`, but explicitly do not establish a source SLA:

- Vendor/tenant KPI derives unfinished Vendor Work overdue from `vendor_assignments.assigned_at < asOf - overdueAfterDays` (default/query parameter).
- Critical Finding management reads derive overdue from `reported_at` age and reuse the vendor KPI threshold helper.
- Workforce KPI derives overdue assignments against scheduled/end boundaries plus request `graceMinutes`.
- Security patrol KPI derives missed/overdue occurrences against occurrence due time plus request `graceMinutes`.
- Management building/portfolio/command-center/export models aggregate those calculations and expose `overdue`, `overdueRate`, and overdue counts.

These are query-time reporting definitions, not persisted breach facts. They must remain backward compatible. SLA-01 must add clearly named SLA projections rather than silently changing existing `overdue` fields.

### 3.3 Hardcoded/local calculations, placeholders, and unrelated meanings

- `overdueAfterDays` and `graceMinutes` calculations are local read-model policy and 24x7 elapsed arithmetic. They are not definition lookup.
- Notification reminders/escalations have persisted `scheduled_for`-style due processing and status transitions, but are delivery workflow, not SLA breach authority.
- Finding escalation and notification escalation are existing domain/delivery concepts whose name does not mean SLA escalation.
- Security “breach” text, escalation contacts, finance due dates, document targets, schedule targets, and UI/API target identifiers are semantically unrelated.
- No stale/legacy SLA runtime implementation or OpenAPI SLA placeholder was found.

## 4. Candidate consumers and lifecycle rules

### 4.1 Approved initial consumer: Work Order

Proposed v1 rules:

| Clock | Starts | Satisfied/stopped | Terminal without satisfaction | Pause |
|---|---|---|---|---|
| RESPONSE | Work Order `created_at` (direct or converted Work Order creation) | first `work_order_actions.occurred_at` with `ACKNOWLEDGED` | `CANCELLED`; record `CANCELLED`, not met/breached unless already breached | No automatic pause before response in v1 |
| RESOLUTION | Work Order `created_at` | `completed_at` (operational work completed) | `CANCELLED`; `CLOSED` is not the target because verification delay is a separate concern | `ON_HOLD` action until matching `RESUMED`; see below |

`completed_at`, rather than `closed_at`, is recommended for resolution because existing authority defines completion as operational work finished and closure as post-verification sealing. A future definition could support a controlled satisfaction policy, but v1 should not make this freely configurable.

Creation is selected over assignment as the default start because assignment latency is normally part of service performance. An enterprise requiring assignment-based timing should be a future controlled start-policy option, not a hardcoded alternate.

### 4.2 Deferred consumers

- **Tenant Service Request:** plausible start `requested_at`; no native acknowledgement/resolution timestamp. `CONVERTED` is a handoff, not satisfaction. Do not consume in v1 unless continuous clock transfer/linkage to the resulting Work Order is designed.
- **Tenant Complaint:** plausible start `reported_at`; escalation to Finding is not resolution, and no acknowledgement exists. Defer.
- **Finding:** plausible resolution start `reported_at`, stop `closed_at`; assignment time exists. Response satisfaction is ambiguous (assignment vs execution/review). No existing hold state. Defer.
- **Incident:** plausible resolution start `reported_at`, stop `closed_at`; no acknowledgement/assignment/hold lifecycle at the incident foundation. Defer.
- **Vendor Work:** resolution could start at vendor assignment or Vendor Work creation and stop `completed_at`; explicit hold exists. Because Vendor Work belongs to Work Order execution, decide whether it is a vendor contractual sub-SLA before enabling it, to avoid two authorities claiming the same resolution.

The generic foundation should whitelist supported `subject_type` values in code/schema as each adapter is approved; it must not accept arbitrary polymorphic strings.

## 5. Recommended SLA definition model

Use dedicated relational authority, not hardcoded service constants and not a single opaque configuration JSON value.

Recommended definition characteristics:

- `id`, stable `code`, name/description.
- mandatory `client_id`; optional `building_id` override validated under that client.
- controlled `subject_type`/operational module (initially `WORK_ORDER`).
- optional controlled service discriminator (`work_type` initially), not arbitrary entity IDs.
- optional priority/severity band using the source module's controlled values.
- `response_target_minutes` and/or `resolution_target_minutes`; at least one required.
- `clock_mode`, initially only `ELAPSED_24X7`.
- `effective_from`, optional `effective_to`, and `ACTIVE/INACTIVE` (or enabled) lifecycle.
- deterministic precedence: building + service + priority, building + priority, client + service + priority, then less-specific client fallback; reject equal-specificity overlaps rather than choose unpredictably.
- definition updates affect only future applications. Applied instances snapshot definition revision/targets/mode/timezone so historical deadlines never drift.

A single definition may hold both response and resolution targets because applicability is shared. Internally, instantiate separate metric clocks from the reusable clock model. Definitions are client scoped by default, optionally building scoped, module/service-type scoped where a stable source discriminator exists, and priority/severity scoped. Do not force all dimensions or all modules in v1.

Existing generic configuration infrastructure is useful precedent for effective client/building scope and administrative access, but it lacks overlap constraints, effective periods, metric semantics, and historical snapshots. Therefore it should not be the sole persisted SLA authority.

## 6. Applied SLA and clock model

Recommended split:

1. **Applied SLA instance/binding** — one application decision per subject and definition snapshot. Carries client/building, constrained subject type/id, definition id and snapshot, applied time, and source applicability values.
2. **SLA clock** — one row per applied instance + metric (`RESPONSE`/`RESOLUTION`), sharing a reusable state machine.
3. **Pause interval ledger** — append-only/closeable intervals per clock.

Suggested clock state: `PENDING` (if created before start), `RUNNING`, `PAUSED`, `MET`, `BREACHED`, `CANCELLED`. Persist `started_at`, target duration, accumulated paused milliseconds (or derive and cache it safely), current deadline, `satisfied_at`, `breached_at`, and terminal reason. Unique keys prevent duplicate application and duplicate metric clocks.

Deadline for 24x7 mode is `started_at + target_duration + total_closed_pause_duration`; while paused, expose a provisional deadline consistently but do not breach. On resume, atomically close the sole open pause and advance/recompute the deadline. Use database `NOW()`/explicit transaction time consistently; API-provided operational timestamps must not become clock authority unless the source domain already accepts them.

Persisted instance and clock rows are the query and concurrency authority. Operational events are audit/integration facts, not the only state from which every read must replay.

## 7. Pause/resume semantics

Use a **combination**, with operational transition binding as the default and tightly controlled explicit SLA operations only for reasons that cannot be represented by an approved source state.

For Work Order v1:

- `WORK_ORDER` transition/action `ON_HOLD` pauses the resolution clock.
- `RESUMED` pauses no clock and closes the current resolution pause.
- Existing free-text notes may explain a hold, but do not classify “waiting for tenant/vendor/material”; those statuses/reason codes do not exist and must not be invented by SLA-01.
- Response clock is not paused by Work Order hold because acknowledgement necessarily precedes start/hold under current action rules.

Audit requirements:

- interval has clock id, reason source (`OPERATIONAL_STATE` or later explicit), source event/action id where available, actor, `paused_at`, nullable `resumed_at`, resume actor/source, and note/reason snapshot;
- database uniqueness permits at most one open pause per clock;
- duplicate pause while paused and duplicate resume while running are idempotent no-ops only when carrying the same source identity, otherwise controlled conflicts;
- lock the clock row and update interval/accumulator/deadline in one transaction;
- terminal clocks cannot pause/resume; satisfaction or cancellation closes any open interval at the same transaction time;
- repeated cycles sum non-overlapping closed intervals and never repeatedly add the same interval.

Explicit pause endpoints should not be introduced in the first Work Order adapter. If later required, they need a controlled reason catalogue and source-domain permission; an SLA endpoint must never change the Work Order status.

## 8. Calendar and timezone decision

Findings:

- `buildings.timezone` is an optional, service-validated IANA timezone and is the best building timezone authority.
- Schedule definitions carry mandatory timezone, start/end, and recurrence, but target only forms/checklists.
- `SCHEDULE.DEFAULT_TIMEZONE` exists as an effective operational setting for schedule administration.
- Shifts are building wall-clock windows interpreted in the building timezone, but are workforce definitions, not operating calendars.
- No building operating-hours calendar, weekly business-hours authority, holiday table, exception-day calendar, or SLA calendar exists.

Decision: SLA v1 supports only `ELAPSED_24X7`. Persist all instants as `TIMESTAMPTZ`; compare in UTC. Resolve timezone from Building for presentation/audit, with an explicit documented fallback only if building timezone is null (prefer requiring a valid building timezone before future business-calendar mode; do not infer server local time). A later calendar CR may add `BUSINESS_HOURS`; SLA definitions may reserve a controlled mode field but must reject unsupported modes. Do not reinterpret shifts or schedules as business hours.

## 9. Breach authority

Breach is a persisted state transition owned by SLA-01:

`RUNNING + now >= effective_deadline + unsatisfied => BREACHED`

It must be persisted because scheduler timing, audit, idempotency, reporting, and downstream SLA-02 consumption require a stable fact. Persist `breached_at` as the authoritative deadline instant (not merely the later polling time) and separately retain processing/event occurrence time if useful. A status-guarded update (`RUNNING` to `BREACHED`) under row lock/atomic SQL provides claim/idempotency. A satisfaction transaction must evaluate its authoritative timestamp against the deadline: satisfaction at or before deadline is `MET`; after deadline is `BREACHED` even if the polling job has not run. Define equality explicitly as breached when satisfaction is after the deadline; satisfaction exactly at deadline is met.

Emit an append-only `SLA_BREACHED` operational event after/within the same database transaction boundary as the state update. Prefer passing a transaction executor to event recording so state and event commit together. Existing operational-event helper supports an executor, but many current domain services perform state and event writes sequentially without a shared transaction; the SLA adapter must not copy that partial-write risk.

Derived `isOverdue` may be exposed for running records as a read convenience, but it is not a substitute for persisted breach. Existing reporting `overdue` remains unchanged.

## 10. Scheduler and event integration

Reuse `due-job-scheduler` and extend `processDueOperationalJobs` with a separately isolated SLA breach processor. Do not create cron, a second interval, queue, or notification job.

Existing scheduler behavior:

- environment-controlled enabled/interval settings; disabled in tests;
- process singleton and non-overlapping `inFlight` guard;
- skipped overlapping ticks;
- dispatcher enumerates due records and isolates failures per item;
- domain operations use status-guarded updates for retry/idempotency;
- scheduler logs failures and continues; graceful shutdown drains with timeout.

SLA should follow the same due enumeration (`RUNNING`, not paused, deadline <= supplied `before`) and per-item failure isolation. Database status guards are required because the in-process singleton protects only one process; it is not a distributed lock. The later implementation should either claim rows atomically (`FOR UPDATE SKIP LOCKED`/guarded update) or make repeated evaluation strictly idempotent. Scheduler evaluation only materializes breach; synchronous lifecycle operations remain able to determine the correct result transactionally.

Operational events suitable as adapter signals include Work Order execution/status/history events, but current events do not provide a transactional subscription/outbox framework. Therefore adapters should be called from authoritative service transactions rather than polling/replaying event text. Event types and metadata are useful audit outputs, not an implicit generic event bus.

## 11. Isolation and RBAC

- Definition management inherits `client_configuration.read/manage` at client scope and `building_configuration.read/manage` at building scope for v1. These permissions already describe configuration administration; no new permission is justified during governance.
- Applied SLA/clock reads inherit the source domain read permission (`work_order.read` initially) and the same effective building/client access checks.
- Automatic lifecycle binding and scheduler evaluation are system operations, not user permissions.
- If explicit pause is later approved, use the source manage/execute permission (`work_order.manage` initially), never a broad configuration permission.
- Definition lookup and all mutations must constrain both `client_id` and `building_id`; building ownership is resolved through existing context-access/hierarchy authority.
- Management views may aggregate only through existing effective read scope. No new cross-client management authority is created.

A future requirement for delegating SLA administration independently from general configuration would justify dedicated permissions, but that is a clear gap to resolve in a later PART, not during START GOVERNANCE.

## 12. Compatibility and safety risks

1. **Duplicate semantics:** Existing `overdue` projections are not SLA breaches. Renaming/replacing them would break API/report contracts.
2. **Clock transfer ambiguity:** Tenant request/complaint conversion can otherwise reset or double-count time across Work Order/Finding.
3. **Parent/child duplication:** Work Order and Vendor Work resolution clocks could both claim authority over one service outcome.
4. **Acknowledgement representation:** Work Order acknowledgement is an action timestamp, not a column; queries must use the first immutable matching action and enforce one meaningful acknowledgement through lifecycle rules.
5. **Non-atomic existing service/event writes:** Adding clock hooks after a domain commit can leave domain and SLA state inconsistent. Later PARTs need explicit transaction seams/outbox-quality handling without refactoring unrelated domains.
6. **Concurrent scheduler/lifecycle writes:** Completion, pause, and breach can race; row locks/status guards and authoritative timestamps are mandatory.
7. **Definition drift/overlap:** Mutable definitions or ambiguous precedence could change historical deadlines. Snapshot and reject equal-precedence overlap.
8. **Priority changes after application:** Work Order priority is mutable. Initial application should snapshot priority; repricing a live clock must be explicitly prohibited in v1 rather than silently recalculating.
9. **Backfill:** Applying definitions retroactively could instantly breach old records. Default to prospective application only; any backfill requires an explicit audited operation.
10. **Missing timezone/calendar:** Server-local arithmetic or treating shifts as calendars would produce incorrect deadlines.
11. **In-process scheduler topology:** Multiple application processes may each tick; database idempotency cannot rely on singleton memory.
12. **Pause abuse:** Free-form explicit pauses could bypass operational governance. Bind v1 to approved state actions only.
13. **Terminal interpretation:** Completed versus closed differs by module. Adapters must own controlled rules, not user-configured arbitrary status strings.
14. **OpenAPI/mobile contracts:** Adding fields directly to existing source responses may affect strict consumers; prefer additive nested/read endpoints with contract tests when implemented.

## 13. Proposed small PART breakdown

### PART 01 — SLA Definition Foundation

- Dedicated definition/repository/service model, client/building applicability, controlled Work Order/work-type/priority selectors, effective period, 24x7 mode.
- Deterministic effective resolution and immutable-history policy.
- Reuse configuration RBAC and context isolation.

### PART 02 — SLA Instance & Clock Foundation

- Applied definition snapshots and reusable response/resolution clocks.
- Work Order adapter only.
- Prospective creation; response start/acknowledgement satisfaction and resolution start/completion/cancellation rules.
- Transaction-safe operational event recording.

### PART 04 — Breach determination and scheduler integration

PART 04 adds migration 0294 and persists `sla_clocks.breached_at`. Breach is evaluated when effective elapsed milliseconds (excluding resolution pause intervals only) reaches the target. The first breach is recorded with a conditional update and one `SLA_CLOCK_BREACHED` operational event; clock status remains RUNNING, SATISFIED, or TERMINATED, so later lifecycle transitions preserve breach history. Lifecycle completion/cancellation evaluates before transition, and the existing due-job dispatcher invokes the SLA evaluator for due RUNNING clocks. No SLA escalation or notification delivery is included.

PART 05 extension points: add escalation policy/records, notification orchestration, and additional SLA consumers behind the existing due-job dispatcher and operational-event seams without changing clock state semantics.

## PART 03 — Pause/Resume & Time Accounting

- Auditable pause intervals and accumulated duration/deadline recomputation.
- Bind Work Order `ON_HOLD`/`RESUMED` only to resolution clock.
- Idempotency, repeated-cycle, race, and terminal-state rules.

### PART 04 — Breach Determination & Scheduler Integration

- Synchronous deadline comparison plus persisted idempotent breach transition.
- Extend existing due dispatcher/scheduler only.
- `SLA_BREACHED` event; no escalation or notification.

### PART 05 — API / Contract / Documentation Closure

- Definition administration and scoped applied-SLA reads; additive source representation only if safe.
- OpenAPI, focused contract/isolation tests, operational documentation, migration rollback checks.
- Confirm SLA-02 integration event boundary without implementing consumers.

Each PART should be independently reviewable and avoid changes to operational state machines beyond narrow adapter calls/transaction seams.

## 14. Expected files/modules (implementation forecast only)

Likely new modules:

- `src/modules/sla-definitions/*`
- `src/modules/sla-clocks/*` (including application/resolution and pause ledger services)
- `src/modules/sla-work-order-adapter/*`
- `src/modules/sla-breach/*`
- focused sequential migrations registered in `src/database/migrations/index.ts`
- focused tests such as `tests/sla-definitions.test.ts`, `tests/sla-clocks.test.ts`, `tests/sla-pause-resume.test.ts`, `tests/sla-breach-scheduler.test.ts`, `tests/sla-isolation.test.ts`

Expected narrow edits:

- `src/app.ts` for later route registration;
- Work Order creation/action/completion/cancellation transaction seams;
- `src/modules/due-job-dispatcher/*` for breach processing;
- `docs/api/openapi.yaml` and API handoff documentation;
- permission seeds only if a later governance decision rejects reuse (not currently recommended).

No management read model, notification, finding escalation, scheduler replacement, or calendar subsystem should be modified by this CR.

## 15. Targeted validation strategy

Do not run full regression during governance. Implementation PARTs should use focused tests:

- definition scope, precedence, effective range overlap, inactive behavior, snapshot immutability;
- Client/Building cross-scope denial and effective-context reads;
- one applied instance and one clock per metric under retries/concurrent creation;
- response and resolution start/stop using persisted Work Order timestamps/actions;
- exact deadline arithmetic and equality boundary;
- pause before/after deadline, multiple cycles, duplicate requests, open-interval uniqueness, completion/cancel while paused;
- priority/definition edits do not mutate an existing clock;
- prospective-only behavior and explicit no-match behavior;
- synchronous completion versus scheduler breach races;
- due enumeration, status-guarded idempotency, per-item failure isolation, empty windows, scheduler-disabled tests;
- operational state plus event transactional consistency;
- preservation of existing Work Order lifecycle/action/history tests and existing KPI `overdue` semantics;
- migration up/down and focused OpenAPI contract checks.

Use injected/fixed instants or database-controlled transaction timestamps; avoid flaky wall-clock sleeps.

## 16. Explicit CR-BE-SLA-02 and notification boundary

CR-BE-SLA-01 ends after determining and persisting `MET`, `BREACHED`, or `CANCELLED` and recording the corresponding SLA audit/operational event. It does **not**:

- select escalation policies, levels, recipients, managers, vendors, or tenant contacts;
- create finding/incident escalation records;
- schedule or trigger notification escalations/reminders;
- render templates;
- send in-app, email, WhatsApp, push, SMS, or secure links;
- retry notification delivery or manage delivery status;
- alter operational priority/status/assignment because of breach.

CR-BE-SLA-02 may consume the idempotent persisted breach/event and own escalation behavior. Later notification CRs own delivery. SLA-01 must not directly call notification modules from breach determination.

## 17. Governance questions — resolved

1. **Existing SLA-like fields/logic:** lifecycle timestamps/priorities and multiple derived age/due-based `overdue` KPIs; no SLA authority.
2. **Authority vs reporting:** source timestamps/statuses/due dates are domain authority; KPI overdue labels are reporting-only.
3. **Initial modules:** Work Order only; other inspected modules are deferred candidates.
4. **Clock starts:** Work Order creation for response and resolution.
5. **Clock satisfaction:** first acknowledgement action for response; completion timestamp for resolution; cancellation terminates unsatisfied.
6. **Both clocks:** yes, separate metric clocks sharing one foundation; definition may configure either/both.
7. **Pause/resume:** operational-state binding first; audited intervals; explicit operations only for a later demonstrated gap.
8. **Legitimate states:** Work Order `ON_HOLD` and Vendor Work `ON_HOLD` exist; only Work Order resolution hold is enabled in v1. No invented waiting states.
9. **Business hours:** not safely possible with current authority; v1 is 24x7.
10. **Timezone:** Building IANA timezone is authority; UTC instants/comparison; no server-local inference.
11. **Breach:** persisted and event-backed, with derived convenience reads only.
12. **Scheduler/events:** extend existing due dispatcher/scheduler; adapter calls at authoritative transactions; operational events for audit.
13. **RBAC/isolation:** reuse configuration permissions for definitions, source permissions for clocks, and context-access Client/Building scope.
14. **Risks:** listed in section 12, especially duplicate overdue semantics, transfer/parent-child ambiguity, races, and definition drift.
15. **SLA-02:** all escalation policy/actions and notification handoff behavior remain deferred.

## 18. PART 01 implementation findings

CR-BE-SLA-01 PART 01 implemented the definition authority only:

- `sla_definitions` is client-owned with an optional Building narrowing reference, unique client/code, `WORK_ORDER` as the sole operational type, optional existing `work_type` and existing Work Order priority, and standard `created_at`/`updated_at` audit metadata.
- Targets are separate nullable positive integer minute columns (`response_target_minutes`, `resolution_target_minutes`); at least one is required. Minutes provide deterministic elapsed-24x7 duration without introducing clock arithmetic or a speculative calendar mode.
- Effective dating uses required `effective_from`, optional `effective_to`, and `ACTIVE/INACTIVE`; an end must be strictly later than its start. No overlap or precedence resolver exists in PART 01.
- Administration reuses `client_configuration.read/manage`, while service checks intersect permission with existing Client/Building access. No SLA-specific permission was added.
- Routes: `POST/GET /clients/{clientId}/sla-definitions` and `GET/PATCH /sla-definitions/{id}`. PATCH handles enable/disable through status; there is no delete or lifecycle endpoint.
- Database and service validation enforce controlled applicability, positive targets, target presence, effective range, status, and Building-to-Client consistency. Existing overdue fields and operational domains are untouched.
- PART 02 extension points are the typed `slaDefinitionRepository.findById/list` and persisted applicability fields. PART 02 may add a deterministic effective resolver and applied snapshot/clock tables without changing Work Order or definition rows in PART 01; it must still define overlap/precedence and prospective application explicitly.

## 19. PART 02 implementation findings

- Effective selection runs at the persisted Work Order `created_at` and admits only same-client, ACTIVE, effective `WORK_ORDER` definitions whose optional Building, normalized Work Type, and existing Work Order priority match.
- Precedence is a small specificity score: Building scope (4), Work Type (2), priority (1). The highest score wins, so Building beats Client and more explicit applicability beats generic applicability. Two matches sharing the highest score are rejected as ambiguous; no arbitrary code/date tie-break is used and PART 01 history is not rewritten.
- `applied_slas` stores one immutable snapshot per Work Order: source definition and code, Client/Building, definition and Work Order applicability values, both target durations, definition effective dates, and application/audit timestamps. Definition updates cannot mutate it.
- `sla_clocks` is reusable by `RESPONSE` and `RESOLUTION`, unique per applied SLA/type. It stores positive target minutes, authoritative Work Order creation time as `started_at`, neutral `RUNNING/SATISFIED/TERMINATED` state, nullable satisfaction/termination timestamps, and audit timestamps. It contains no deadline, pause, or breach authority.
- Both direct creation and Work Request conversion use the existing Work Order service path. The narrow repository create now accepts a transaction executor; Work Order insert, selection, snapshot, clocks, and `SLA_APPLIED`/`SLA_CLOCK_CREATED` events commit atomically through existing `withTransaction`. Existing Work Order history recording and request conversion behavior remain otherwise unchanged.
- Application is prospective only. No match preserves successful Work Order creation with no applied record; no migration/backfill touches historical Work Orders.
- `GET /work-orders/{id}/sla` is the only read addition. It reuses `work_order.read` and existing Building isolation and returns the immutable snapshot with clocks, or `null` when none applies. There is no manual apply API.
- PART 03 can extend `sla_clocks` with audited pause accounting and bind existing Work Order `ON_HOLD/RESUMED` actions. The immutable applied snapshot, clock uniqueness, transaction executor seams, and operational events are the extension points; breach/scheduler behavior remains deferred.

## 20. PART 03 implementation findings

- `sla_clock_pause_intervals` is the append-preserving audit ledger: clock, authoritative action timestamp, nullable resume timestamp, fixed `WORK_ORDER_ON_HOLD` source, pause/resume actors, and audit timestamps. A partial unique index permits only one open interval per clock.
- The existing Work Order action service remains the only hold/resume authority. Its status transition, action insert, resolution-clock pause/resume, and SLA operational event now share one existing `withTransaction` boundary. Invalid repeated hold/resume remains rejected by the existing action lifecycle.
- Clocks retain `RUNNING/SATISFIED/TERMINATED`; no `PAUSED` state was added. A running resolution clock is currently paused exactly when it has an open interval. RESPONSE clocks are never paused.
- SLA reads expose intervals, `isPaused`, total paused milliseconds, and effective elapsed milliseconds. PostgreSQL computes interval sums using `COALESCE(resumed_at, statement_timestamp()) - paused_at`; effective elapsed is wall elapsed minus that sum, clamped at zero. No deadline or breach comparison exists.
- Resume closes only an existing open interval and never fabricates one. Multiple cycles remain separate immutable intervals. The database uniqueness constraint and locked clock read prevent overlaps.
- Existing acknowledgement satisfies a running RESPONSE clock; completion satisfies the RESOLUTION clock; cancellation terminates remaining running clocks. Completion/cancellation atomically close any open resolution interval at their authoritative lifecycle timestamp, so terminal clocks cannot retain an open pause. Applied snapshots remain immutable.
- PART 04 can use the database-derived effective elapsed value against snapshotted target minutes and persist idempotent breach state/events. It must reuse the existing scheduler and must not derive a persisted deadline from pause intervals in PART 03.

## 21. START GOVERNANCE boundary confirmation

This deliverable was produced by inspecting source, migrations, tests, governance documents, and API patterns. No business implementation, migration, route, runtime SLA logic, scheduler job, RBAC permission, notification behavior, unrelated refactor, PR, or merge was created. Full regression and CI/KI-003 were not run or reopened.

## 22. PART 04–05 final closure

The final authority chain is: active client/building SLA definition, immutable Work Order applied snapshot, independent RESPONSE and RESOLUTION clocks, audited resolution pause intervals, PostgreSQL effective elapsed accounting, and persisted first breach history. Clock states remain RUNNING, SATISFIED, or TERMINATED; breach is historical metadata, not a terminal state. Breach uses effectiveElapsed >= targetDuration, excludes only resolution pauses, and is evaluated synchronously before acknowledgement/completion/cancellation terminal action. The existing due-job dispatcher evaluates due running clocks; conditional persistence and event creation are idempotent. The read API exposes the applied snapshot, both clocks, pause accounting, and breachedAt. **overdue != SLA breach**: overdue remains a separate reporting concept.

PART 01–05 are complete. PART 05 closes the API/OpenAPI contract and documentation without adding escalation or notification behavior. Deferred scope belongs to CR-BE-SLA-02: escalation policy/actions, notification orchestration/delivery, other SLA consumers, business calendars, historical backfill, and CI/KI-003.
