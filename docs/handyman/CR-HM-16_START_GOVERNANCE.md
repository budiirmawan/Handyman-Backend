# CR-HM-16 — SLA, Notification, Audit & Reliability — START GOVERNANCE

Date: 2026-09-30 (UTC)
Branch: `arena/01a0f085-handyman-backend`
Base commit (BASELINE_HEAD): `78e793ffc6ccefee6582ff08a88e8397064fe484`
(PR #8 "CR-HM-15: Service Warranty, Claim & Rework" MERGED into `main`;
assigned branch verified on latest `origin/main`.)

Governance ONLY. NO runtime, NO migration, NO API/OpenAPI, NO tests in
this PART. This document freezes ownership/reuse boundaries, the
provider-performance derivation model, blockers, and the smallest
legal PART split for CR-HM-16. Does not invent runtime.

## §1 Position in the frozen roadmap

Roadmap row 16: **SLA, Notification, Audit & Reliability**.

Scope vocabulary: *SLA/provider performance; notification/communication;
audit/security/privacy; outbox/webhook/integration reliability*.

Primary authority: **Handyman-Backend**.

Depends on (roadmap): **— (none)**.

Produces contract for: **CR-HM-17, CR-HM-18, CR-HM-22**.

Exit gate:
> Handyman SLA/notification/audit and integration-reliability
> contracts published; provider performance derivation model stated;
> boundaries to all consuming journeys verified.

Preserve (roadmap):
- SLA Engine != Provider Performance Read Model; provider performance
  is derived from governed operational events, not manually entered
  KPI values.

Matrix domains covered (all classified **A — BACKEND CONTRACT
BLOCKER**, cross-cutting, non-gating for domain creation):

| Matrix domain | Row | Classification |
| --- | --- | --- |
| 19. SLA / Provider Performance | ownership EXTEND | A |
| 25. Notification / Communication | ownership REUSE | A |
| 26. Audit / Security / Reliability | ownership REUSE + boundaries | A |

CR-HM-01..15 are treated as **READ-ONLY event/lifecycle authorities**
for this start (their event vocabularies are SLA/notification/audit
inputs; none is reopened or mutated here). CR-HM-14 explicitly
deferred **provider performance derivation** to this CR as a
non-blocker — that derivation model is stated in §6.

## §2 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| `git fetch origin main` | DONE |
| PR #8 | MERGED 2026-09-30T04:09:24Z, merge commit `78e793ffc6ccefee6582ff08a88e8397064fe484`, base `main` |
| `origin/main` | `78e793ffc6ccefee6582ff08a88e8397064fe484` |
| Session branch | `arena/01a0f085-handyman-backend` |
| Branch based on that main | YES (`HEAD` = `merge-base` = `origin/main`) |
| BASELINE_HEAD | `78e793ffc6ccefee6582ff08a88e8397064fe484` — fresh, no mismatch |
| Working tree | clean before this document |

## §3 Minimum existing contracts (read for this start)

Authority baseline: the Asentra-derived capability set frozen in
`CR-HM-00_BACKEND_CAPABILITY_MAP.md` / `CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md`.
These are **REUSE / EXTEND** surfaces — never rebuilt.

### 3.1 SLA (CR-BE-SLA-01 / CR-BE-SLA-02 — EXTEND)

| Contract | Minimum facts |
| --- | --- |
| SLA definition | `sla_definitions` / `src/modules/sla-definitions`: client-owned, optional building narrowing, `UNIQUE(client_id, code)`, effective-dated (`effective_from`/`effective_to`), `ACTIVE\|INACTIVE`, nullable `response_target_minutes`/`resolution_target_minutes` (≥1 required). Today `SLA_OPERATIONAL_TYPES = ['WORK_ORDER']` and Work Order priority vocabulary only. |
| Definition selection | specificity resolver (Building 4 / WorkType 2 / Priority 1; equal top score → ambiguous/conflict; prospective only) — pattern reused for Handyman binding selection, never a second resolver. |
| Applied snapshot | `applied_slas`: immutable definition+targets snapshot per subject; created once at subject creation instant. |
| Clocks | `sla_clocks`, `UNIQUE(applied_sla_id, clock_type)`: metric `RESPONSE\|RESOLUTION`; state `RUNNING\|SATISFIED\|TERMINATED`; `started_at`, `target_minutes`, `satisfied_at`, `terminated_at`. One reusable clock state machine. |
| Pause accounting | `sla_clock_pause_intervals`: RESOLUTION only; effective elapsed = wall − pauses; affects breach **determination** only. |
| Breach facts | first-write-idempotent `sla_clocks.breached_at` via guarded `markBreached` (row returned **only on first breach write**); `SLA_CLOCK_BREACHED` operational event; synchronous lifecycle path + due-job path converge on the same write. `breached_at` is historical metadata, never a clock state. |
| Escalation | `sla_escalation_policies` + ordered levels (`offset_minutes` + recipient rule + `template_key`) + `sla_escalation_actions` durable per-clock/per-level ledger; materialized at first breach; drained by the existing due-job dispatcher with **claim-before-send** idempotency. Escalation ends at notification **INTENT**. |
| v1 consumer | Work Order only; binding keys generic by design; **`work-order-sla-register` is FM work-order-coupled and is NOT a Handyman authority**. |

### 3.2 Notification (BE-26 + CR-BE-NOTIFY-PROV-01 — REUSE)

| Contract | Minimum facts |
| --- | --- |
| Notification record | `notifications` / `recordNotification(input)` internal seam (no HTTP create); IN_APP channel; `sourceEntityType/Id`, `sourceEventType`, `templateKey`; self-scoped inbox reads. |
| Templates | `notification_templates`: unique `key`, `channel`, `subject`/`body` with `{{var}}` placeholders, declared `variables`, `ACTIVE\|INACTIVE`; deactivated template suppresses at send. |
| Recipient resolution | `resolveRecipients(specs, scope) → userId[]`: kinds `USER, ROLE, PERMISSION, WORKFORCE, TEAM, TENANT_PIC, VENDOR_PIC`; scope filtered by the recipient's own accessible buildings (context-access). |
| Subscriptions | `notification_subscriptions`: `event_type` → template + recipient rule + optional client/building narrowing; declarative **reactive** fan-out; no workflow authority. |
| Delivery | `notification-delivery` composes subscription → template → recipients → record. Reminders/escalations are durable `PENDING→…` ledgers with claim-before-send (`FOR UPDATE SKIP LOCKED` due enumeration, guarded claim UPDATE). |
| Outbound lifecycle | `notification_outbound_deliveries`: idempotent creation (insert-on-conflict), guarded `PENDING/RETRY_SCHEDULED → SENDING` claim, bounded `attempt_count`/`max_attempts`, `next_retry_at` exponential backoff + jitter, shared provider-result taxonomy `ACCEPTED / REJECTED_RETRYABLE / REJECTED_PERMANENT / ERROR_UNKNOWN`. |
| Provider boundary | channel adapter interfaces with credential-less `noop` default; non-`noop` selection fails fast until an explicit provider decision; **no commercial provider assumed anywhere**. WhatsApp exists only as one optional adapter slot — it is not a dependency. |

### 3.3 Audit (CR-BE-AUDIT-01 — REUSE)

| Contract | Minimum facts |
| --- | --- |
| Business-event authority | `operational_events` + `recordOperationalEvent(input, executor, correlation)` is the **single** business/operational event authority: append-only at the application boundary, SENSITIVE_KEYS metadata scrubbing, `request_id`/`source` (`HTTP\|SCHEDULER\|SYSTEM`) correlation, commits atomically with the business write via the caller's executor. |
| Correlation | one canonical server-generated `requestId` (`X-Request-ID`, logs, error envelopes) via `AsyncLocalStorage` context; caller-supplied headers never authoritative. |
| Audit module | `src/modules/audit`: `recordEvent`, `auditContextFromRequest` (requestId, socket IP, user-agent; forwarded headers not trusted). |
| Audit read | `GET /operational-events` bounded, newest-first, Client/Building-isolated search (`operational_event.read`); `auth.audit.read` stays the separate auth-audit surface. |
| Boundary rules | audit state-changing/approval/security-sensitive/integration/automated-job facts — not every GET; no manual event-injection endpoint; no second audit store/event log; no history rewrite. |

### 3.4 Outbox / webhook (CR-BE-INTEG-01 — REUSE)

| Contract | Minimum facts |
| --- | --- |
| Outbox | `integration_outbox_events`: thin unique-FK **prospective marker** over an existing `operational_events` row + byte-stable payload snapshot; atomic same-transaction enqueue (the transactional-outbox seam already exists). Not a second event log. |
| Endpoint registry | `integration_webhook_endpoints`: client-scoped URL + event subscriptions + write-only HMAC signing secret (secret never leaves the module except as an HMAC key). |
| Delivery ledger | `integration_webhook_deliveries`: per-endpoint claimable ledger cloned from the proven notification-ledger shape (guarded claim-before-send, bounded retry/backoff, provider-result taxonomy), HMAC-SHA256 signing + `timingSafeEqual`, bounded-timeout HTTP transport, drained by the **single** due-job dispatcher. |
| Explicit non-goals | no second scheduler, no queue/broker, no asymmetric PKI, no manual event injection, no historical replay/backfill. |

### 3.5 Reliability / idempotency (CR-BE-STAB-01 + shared — REUSE)

| Contract | Minimum facts |
| --- | --- |
| Request idempotency | `src/modules/request-idempotency`: transactional idempotent execution keyed `actor + operationKey + SHA-256(key)`, request-fingerprint equality, 409 on conflict, single-transaction atomicity, no failure storage, raw key never persisted/logged. |
| Due execution | `due-job-dispatcher` (`processDueOperationalJobs`, per-domain `try/catch` isolation, additive result keys) + `due-job-scheduler` (one in-process `setInterval`, singleton/in-flight guard, drain-bounded shutdown). **Only scheduler.** |
| Claim-before-send | the cross-cutting reliability pattern: `FOR UPDATE SKIP LOCKED` due enumeration + guarded `PENDING → CLAIMED/SENDING` UPDATE; only a returned row proceeds to execute. |
| Transport/transactions | `withTransaction` + executor-passing for atomic write+event+outbox; bounded-timeout HTTP adapters with sanitized error strings. |

## §4 FROZEN ownership & reuse boundaries

ONE authority: **CR-HM-16 / Handyman-Backend** owns Handyman SLA
definitions/bindings/milestone events, Handyman notification event
meaning/recipients/templates, Handyman audit context and reliability
boundaries, and the derived provider performance read model.

| Surface | Owner | This CR |
| --- | --- | --- |
| Handyman SLA definitions + binding/milestone vocabulary | CR-HM-16 (EXTEND shared engine) | AUTHORITY (contract) |
| SLA clock state machine + breach facts | shared SLA engine (CR-BE-SLA-01) | REUSE; Handyman binds, never forks |
| SLA breach persistence law (first-write-idempotent `breached_at` + `SLA_CLOCK_BREACHED`) | shared SLA engine | REUSE verbatim; no second breach writer |
| SLA escalation → notification INTENT | CR-BE-SLA-02 pattern | REUSE pattern; Handyman policies over shared infra |
| Handyman notification event meaning, recipients, templates | CR-HM-16 | AUTHORITY (contract) |
| Notification records, templates store, recipient resolution, delivery, outbound lifecycle | BE-26 / NOTIFY-PROV-01 capability | REUSE; Handyman defines meaning only |
| Handyman audit context + authorization boundaries | CR-HM-16 (REUSE + boundaries) | AUTHORITY (contract) |
| Business-event log (`operational_events` + `recordOperationalEvent`) | CR-BE-AUDIT-01 / BE-07 | REUSE as the single event/audit write path |
| Enterprise audit read | `GET /operational-events` | REUSE; Handyman adds event vocabulary, not a second store |
| Outbox/webhook fan-out + delivery ledger | CR-BE-INTEG-01 capability | REUSE; Handyman event contracts separately scoped |
| Idempotency + due-job execution + claim-before-send | shared reliability infra | REUSE verbatim |
| Provider performance derivation model + read model | CR-HM-16 | AUTHORITY (derived, §6) |
| Provider performance inputs (operational events, SLA outcomes) | CR-HM-01..15 lifecycle CRs | READ-ONLY |
| Domain lifecycle state machines (request, schedule, session, warranty, …) | CR-HM-02..15 | READ-ONLY; never written by SLA/notification/audit |
| FM Work Order SLA register / FM work-order lifecycle | FM engineering ops | FIREWALL |
| SaaS control-plane notifications/audit/billing/entitlement | Asentra-SaaS | FIREWALL |

**FK discipline (frozen):** any future Handyman SLA/notification/audit
persistence binds to Handyman domain tables and generic realm
(`users`, `clients`, `operational_events`) ONLY — NEVER to FM
`work_orders`, `work-order-sla-register` subjects, FM audit tables, or
SaaS tables. Infra reuse ≠ authority transfer.

## §5 Authority separations (FROZEN)

```text
SLA Engine              != Provider Performance Read Model
Breach fact             != Escalation/notification decision   (escalation selects; engine never addresses recipients)
Notification intent     != Delivery                           (delivery reacts; never mutates domain state)
Notification record     != Domain lifecycle                   (notifications react to events; never own workflow)
operational_events      == single business-event/audit authority (no second event log / audit store)
integration_outbox      != event store                        (prospective outbound marker only)
Provider performance    == derived read model                 (never manually entered KPI; never transactional authority)
```

**No duplicate lifecycle authority (frozen):** exactly one SLA clock
and breach writer (the shared engine); exactly one notification
delivery stack (BE-26 family); exactly one business-event/audit
authority (`recordOperationalEvent`); exactly one outbox/webhook
family; exactly one scheduler/dispatcher; exactly one idempotency
service. CR-HM-16 publishes Handyman **contracts over** these — it
does not fork any of them.

**No WhatsApp dependency (frozen):** Handyman notification semantics
are **provider-neutral**. Event meaning, recipients, and templates
bind to the channel-agnostic intent/delivery seam. No WhatsApp (or
any named provider) token, adapter, endpoint, enum, callback route,
or configuration key is a dependency of any Handyman notification
contract. Channel selection stays a delivery-layer concern behind the
existing adapter interfaces; the `noop` default remains valid.

**No FM/SaaS coupling (frozen):**

- No Handyman SLA subject type is an FM entity; Handyman milestones
  never read FM Work Order lifecycle timestamps as start/stop truth.
- No FM `overdue`/KPI read-model field is adopted as Handyman breach
  or performance truth (existing query-time `overdue` fields stay
  backward compatible and semantically separate).
- No SaaS subscription/entitlement/billing state gates any Handyman
  notification, SLA clock, or performance derivation (SaaS firewall
  carried forward unchanged).
- SaaS control-plane notifications, if any, remain a separate SaaS
  concern with no Handyman event meaning.

## §6 Provider performance derivation model (STATED)

Per roadmap preserve and matrix row 19:

1. **Inputs (read-only, governed):** Handyman operational events
   (`operational_events`, via the certified vocabulary of CR-HM-01..15)
   and SLA outcomes (applied snapshots, clock `SATISFIED`/`TERMINATED`,
   first-write breach facts). Nothing else is an input.
2. **Derivation:** provider performance is computed **from those
   governed facts only** — response/resolution attainment, milestone
   adherence (request acknowledgement, quotation turnaround, provider
   accept/decline, worker assignment, arrival, work completion, defect
   closure, warranty response, warranty rework), and event-sequenced
   operational truth. It is a **derived read model** at query/materialization time.
3. **Never:** a manually entered KPI value; a transactional or
   authoritative record; an input to entitlement, settlement, pricing,
   or payment (CR-HM-13/14 own those, from their own governed inputs);
   inferred from SaaS data; written by clients (matrix row 19: clients
   present backend-derived state; "no KPI entry client-side").
4. **Separation:** the SLA engine persists clocks and breach facts and
   stops there. The performance read model consumes those facts plus
   operational events; neither replaces the other. Derived performance
   never mutates SLA facts, and SLA breach never implies a performance
   write.

## §7 Minimum mapped seams (FROZEN)

No broad audit. Only seams required to freeze this CR:

1. **Shared SLA seam (EXTEND)** — Handyman definitions/bindings/milestone
   vocabulary extend the shared SLA engine's subject-type surface;
   clock/pause/breach/escalation mechanics are consumed read-only.
   `work-order-sla-register` is out of the Handyman authority chain.
2. **BE-26 notification seam (REUSE, inbound → outbound)** — Handyman
   lifecycle events (CR-HM-01..15 vocabularies) are the `sourceEventType`
   inputs; CR-HM-16 owns event→meaning/recipient/template contracts;
   delivery/status/retry stay the reused capability.
3. **Audit/event seam (REUSE)** — all Handyman state facts flow through
   `recordOperationalEvent` (+ `audit.recordEvent` where the audit
   boundary requires it) with request correlation; Handyman adds event
   vocabulary and context rules, never a second store.
4. **Outbox/webhook seam (REUSE)** — Handyman integration event
   contracts are separately scoped subscriptions over the existing
   outbox/webhook family; reliability semantics (claim-before-send,
   bounded retry, signature) are inherited, not restated as new infra.
5. **Reliability/idempotency seam (REUSE)** — every future mutation in
   this CR's implementation PARTs uses `request-idempotency` and the
   single due-job dispatcher; no new execution substrate.
6. **Consuming-journey boundary (outbound)** — CR-HM-17 (frontend),
   CR-HM-18 (mobile), CR-HM-22 (certification) consume published
   read/command contracts only; clients present derived state and
   define no event meaning, no KPI, no security/audit decision.
7. **FM/SaaS firewall** — documented above (§4/§5); no dual-write, no
   FK, no semantic adoption.

## §8 BLOCKERS

| ID | Blocker | Rule |
| --- | --- | --- |
| B1 | Second SLA clock/breach authority (forked clock state machine, second `breached_at` writer, or Handyman-owned pause ledger duplicating the engine) | STOP; extend the shared engine; one breach writer |
| B2 | Provider performance entered as KPI, written transactionally, or equated with the SLA engine | STOP (roadmap preserve); derived read model only (§6) |
| B3 | WhatsApp or any named provider as a dependency of Handyman notification/audit/reliability contracts | STOP; provider-neutral; adapters stay delivery-layer |
| B4 | FM coupling: FK/dual-write into FM `work_orders`/`work-order-sla-register`/FM audit; FM timestamps or FM `overdue` fields adopted as Handyman truth | STOP; firewall (§4/§5) |
| B5 | SaaS coupling: subscription/entitlement/billing state gating SLA, notification, or performance derivation | STOP; SaaS firewall carried forward |
| B6 | Duplicate lifecycle authority: second notification stack, second outbox, second scheduler/queue, second event log/audit store, second idempotency service | STOP (§5) |
| B7 | Notification/escalation writing domain lifecycle state (notification decides or mutates request/session/warranty/ledger state) | STOP; notifications react only |
| B8 | Mutable audit trail: UPDATE/DELETE of event facts, manual event-injection endpoint, user-authored audit payloads | STOP; append-only at the application boundary |
| B9 | Runtime/migration/API/OpenAPI/tests/roadmap change in this governance PART | STOP |
| B10 | Non-idempotent reliability semantics on any new seam (missing claim-before-send/idempotency key, unbounded retry, second transport substrate) | STOP |

Non-blockers (explicitly deferred, no authority implied): real channel
providers (email/push/WhatsApp adapters remain the existing gated
adapter decision); SLA business-day/holiday calendars (24x7 elapsed
remains the engine law); performance formula/threshold product tuning
beyond §6 input law; retention/deletion of audit facts; SaaS
control-plane notification surfaces; client UI (CR-HM-17/18);
integration certification mechanics (CR-HM-22).

## §9 Smallest PART split

| PART | Name | Allowed | Forbidden |
| --- | --- | --- | --- |
| **00** | START GOVERNANCE (this document) | Freeze ownership/reuse boundaries, separations, derivation model, blockers, split | Runtime, migration, API/OpenAPI, tests |
| **01** | Handyman SLA contract extension | Handyman milestone vocabulary + definition/binding contract over the shared engine (subject-type extension, snapshot/clock/breach reuse statement); SLA Engine != Performance verified | Second clock/breach writer, FM subject types, escalation redesign, notification delivery |
| **02** | Handyman notification event contract | Event→meaning/recipient/template contracts over BE-26 seams; provider-neutral boundary; delivery/retry semantics inherited by reference | New delivery stack, provider adapters, WhatsApp dependency, domain state writes |
| **03** | Audit + integration-reliability contract | Handyman audit context/vocabulary over `recordOperationalEvent`/`audit` seam; outbox/webhook subscription contracts; idempotency/claim-before-send law for this CR's future mutations | Second audit store/event log/outbox/scheduler; mutable audit; replay/backfill |
| **04** | Provider performance derivation + published read contract | Derivation model binding (§6 inputs only), derived read contract for CR-HM-17/18/22; boundary/firewall verification battery | Manual KPI writes, performance as transactional authority, entitlement/settlement inference, FM/SaaS reads as truth |

Do not start PART 01 until this START is committed on the assigned
branch. Do not merge PART 02 before PART 01's subject-type/binding
contract exists. Do not treat PART 03 as a second write path for any
domain fact. Do not open PART 04 to writes of any kind.

## §10 Out of scope

- No runtime, no SQL/migration, no HTTP/OpenAPI, no tests in this PART.
- No channel provider integration (email/push/WhatsApp/SMS), no provider
  credentials, no external sends.
- No SLA engine rework of CR-BE-SLA-01/02 mechanics; no escalation
  policy redesign.
- No FM Work Order/SLA register work; no SaaS control-plane work.
- No entitlement/settlement/payment derivation from performance
  (CR-HM-13/14 remain sole financial authorities).
- No client-side contract for CR-HM-17/18 beyond the published-contract
  obligation recorded here.

## Handoff

CR-HM-16 consumes **governed CR-HM-01..15 operational events and SLA
outcomes** as the only provider-performance inputs (§6) and extends the
**shared SLA / BE-26 notification / audit / outbox-webhook / reliability
capabilities** per the frozen reuse map (§3–§4) — one lifecycle
authority each, provider-neutral, FM/SaaS firewalled.

CR-HM-17/18/22 consume the published SLA/notification/audit/
integration-reliability contracts and the derived provider performance
read model; clients present derived state only. CR-HM-14's provider
performance derivation deferral is closed by §6. CR-HM-13/14 must not
infer financial authority from performance or notification facts.
