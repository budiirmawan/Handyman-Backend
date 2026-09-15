# CR-BE-NOTIFY-PROV-01 — START GOVERNANCE

**Title:** Real Email + WhatsApp Delivery
**Repository:** `asentra-backend`
**Inspected branch:** `arena/01a02cd8-asentra-backend`
**Inspected head:** `b0e4130` (Merge pull request #56 — merged SLA-02 baseline)
**Inspection date:** 2026-08-23
**Status:** Governance only — no migration, no runtime implementation, no route, no permission seed, no OpenAPI change, no CI, no PR, no merge

## Decision summary

CR-BE-NOTIFY-PROV-01 owns exactly one chain and nothing else:

```text
Notification Intent (existing BE-26 event → subscription → template → recipient authority)
  → EMAIL / WHATSAPP Provider Adapter (existing interface, today noop-only)
  → Delivery Attempt (existing append-only attempt records, 0241/0242)
  → Provider Result (new: lifecycle ledger + attempt history + retry/backoff)
```

The backend already holds every authority this chain needs **except** real
provider adapters, a durable delivery lifecycle (retry/backoff/terminal
states), delivery-level idempotency, and provider-result feedback. The safest
extension is therefore **additive**:

1. Keep the existing per-channel adapter interfaces (`EmailAdapter`,
   `WhatsAppAdapter`) and their `EMAIL_PROVIDER` / `WHATSAPP_PROVIDER`
   discriminator/fail-fast selection — extend only the **result taxonomy**.
2. Add one new durable ledger — `notification_outbound_deliveries` — shaped
   after the proven BE-26I / CR-BE-SLA-02 **claim-before-send** pattern
   (guarded `PENDING → SENDING` claim, `FOR UPDATE SKIP LOCKED` due
   enumeration, at-most-once execution).
3. Keep the existing `notification_email_deliveries` /
   `notification_whatsapp_deliveries` tables as the **immutable per-attempt
   history** (additive nullable FK to the ledger only).
4. Drain retries through the **existing** due-job dispatcher/scheduler
   (CR-BE-STAB-01 PART 03/04) as an additional domain slot — no second
   scheduler, no queue, no cron.
5. No commercial provider is assumed anywhere. Real adapters are gated PARTs
   with a provider decision as input; `noop` (and a proposed dev/test
   `capture` adapter) remain the defaults.

Not touched: notification foundation (BE-26A), templates (BE-26B), recipient
resolution (BE-26C), subscriptions (BE-26D), IN_APP delivery (BE-26E),
reminders/escalations (BE-26H/I), secure links (BE-26J), history read model
(BE-26K), SLA authority (CR-BE-SLA-01/02), RBAC conventions, Client/Building
isolation, operational-event authority. Push provider, SLA redesign, unrelated
channels, and CI/KI-003 are explicitly out of scope.

---

## 1. Existing authority map (verified against the current baseline)

### 1.1 Notification foundation (BE-26 — reuse, never rebuild)

| Slice | Module / table | Contract this CR consumes |
|---|---|---|
| BE-26A | `notifications` (0237 + 0240) / `src/modules/notifications` | `recordNotification(input)` internal seam (no HTTP create). Channel check is **`IN_APP` only**; status `UNREAD\|READ`; carries `template_key`, `delivered_at`, `source_entity_type/id/event_type`, `metadata`. Inbox routes self-scoped (auth only, no permission code) |
| BE-26B | `notification_templates` (0238) / `src/modules/notification-templates` | `key` (unique, FK target), `type`, `channel` (**`IN_APP` only today**), `subject`, `body`, declared `variables`, `ACTIVE\|INACTIVE`; `getActiveTemplateByKey(key)`, `renderTemplate({subject, body}, vars)` with `{{var}}` placeholders. Deactivated template suppresses delivery (checked at send, never re-read of the intent) |
| BE-26C | `src/modules/recipient-resolution` | `resolveRecipients(specs, scope) → userId[]` (deduped). Spec kinds `USER`, `ROLE`, `PERMISSION`, `WORKFORCE`, `TEAM`, `TENANT_PIC`, `VENDOR_PIC`; scope filters by the recipient's own accessible Buildings (BE-02F/G `contextAccessService`) |
| BE-26D | `notification_event_subscriptions` (0239) / `src/modules/notification-subscriptions` | `event_type → template_key + recipient_rule` + optional client/building + status; `findMatchingSubscriptions(eventType, {clientId, buildingId?})`. Declarative event fan-out |
| BE-26E | `src/modules/notification-delivery` | `deliverInAppNotifications(event)` — composes D → B → C → A. **IN_APP only**; returns counts (`subscriptionsMatched`, `recipientsResolved`, `notificationsCreated`) |
| BE-26H/I | `notification_reminders` / `notification_escalations` (0243/0244) | Durable due items with `PENDING\|SENT\|CANCELLED` / `PENDING\|TRIGGERED\|CANCELLED`; `findDue*` + per-item dispatch seams; **claim-before-send** guarded UPDATE; produce IN_APP records only |
| BE-26J | `notification_secure_links` (0245) | Token-hash-only, recipient-bound, one-time/limited-use links; RBAC `notification_secure_link.read/manage`. Relevant to email/WhatsApp bodies (action links) but **read-only for this CR** |
| BE-26K | `src/modules/notification-history` | Unified recipient-scoped read model over IN_APP + EMAIL + WHATSAPP delivery records (`GET /notification-history`). Already anticipates both outbound channels |

### 1.2 Outbound channel seams (BE-26F / BE-26G — the direct extension surface)

| Authority | Location | Facts |
|---|---|---|
| Email adapter interface | `src/modules/email-delivery/email-adapter.ts` | `EmailAdapter { provider: string; send({to, subject, body}) → {status: 'SENT'\|'FAILED', providerReference?, error?, sentAt} }`; `resolveEmailAdapter()` selects by `EMAIL_PROVIDER`; **only `noop` ships; any other value throws `ConfigError` (fail-fast, no silent fallback)** |
| Email delivery service | `email-delivery.service.ts` | `sendTemplateEmail(input, adapter?)`: resolves recipient email from `users.email` (ACTIVE only), renders ACTIVE template, sends via adapter, records immutable attempt; `sanitizeEmailError` redacts credential-like values and truncates at 500 chars |
| Email attempt table | `notification_email_deliveries` (0241) | Append-only; `status CHECK IN ('SENT','FAILED')`; `provider`, `provider_reference`, `error_message`, `sent_at`; recipient-scoped reads; **no HTTP routes, no callers in the codebase today** |
| WhatsApp adapter interface | `src/modules/whatsapp-delivery/whatsapp-adapter.ts` | `WhatsAppAdapter { provider; send({to, message}) → SENT\|FAILED + providerReference + error + sentAt }`; `resolveWhatsAppAdapter()` by `WHATSAPP_PROVIDER`; noop-only, fail-fast |
| WhatsApp delivery service | `whatsapp-delivery.service.ts` | `sendTemplateWhatsApp(input, adapter?)`: requires ACTIVE user **and caller-supplied `recipientPhone`** (E.164-ish `^\+?[1-9][0-9]{6,14}$`), renders ACTIVE template (body, falling back to subject), sends, records attempt; `sanitizeWhatsAppError` |
| WhatsApp attempt table | `notification_whatsapp_deliveries` (0242) | Append-only; same shape as email attempts; **no HTTP routes, no callers today** |

### 1.3 Due-job execution authority (CR-BE-STAB-01, extended by SLA-02)

| Authority | Location | Facts |
|---|---|---|
| Dispatcher | `src/modules/due-job-dispatcher` | `processDueOperationalJobs(before = new Date())`; runs reminders, escalations, `processDueSlaClocks`, and (SLA-02) SLA escalation actions; per-item `try/catch` isolation; safe on empty window; additive `DueJobDispatchResult` keys are the established extension pattern |
| Scheduler | `src/modules/due-job-scheduler` | Single in-process `setInterval`, singleton guard, `inFlight` overlap skip, bounded drain on shutdown; `SCHEDULER_ENABLED` / `SCHEDULER_INTERVAL_MS`; **forced off when `NODE_ENV=test`**; started/stopped in `server.ts` |
| Due enumeration precedent | `sla-escalation-actions` repository | `FOR UPDATE SKIP LOCKED` enumeration + guarded status claim is the reference concurrency pattern for work drained by this scheduler |

### 1.4 Configuration, secrets, audit, RBAC authorities

| Authority | Location | Facts |
|---|---|---|
| Env config | `src/config/env.ts` + `.env.example` | `EMAIL_PROVIDER=noop` / `WHATSAPP_PROVIDER=noop` discriminators only; comments state **credentials are never read into config or logged**. Precedent for driver abstraction: `EVIDENCE_STORAGE_DRIVER=local` (CR-BE-API-01 PART 03) |
| Operational events | `operational_events` (0080) + `recordOperationalEvent` | Append-only audit log; `SENSITIVE_KEYS` scrubbed before insert; ~70 modules emit. **A queryable log, not an outbox** — no processed flag, no relay semantics |
| RBAC | `src/database/seeds/foundation-access.seed.ts` | `notification_template.read/manage`, `notification_subscription.read/manage`, `notification_reminder.read/manage`, `notification_escalation.read/manage`, `notification_secure_link.read/manage`; default-deny `requirePermission`. **No delivery/provider permission codes exist** |
| Isolation | BE-02G `contextAccessService` + per-row `client_id` | Every notification/delivery row carries `client_id`; user-facing reads are recipient-self-scoped in SQL |
| Idempotency precedents | BE-26H/I claims; SLA-02 action ledger; `mobile_sync_idempotency` (BE-25H) | Guarded single-UPDATE claims for at-most-once execution; keyed idempotency store for replayed operations |

---

## 2. Current noop / provider gaps

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G1 | **No real provider adapter** | `resolveEmailAdapter` / `resolveWhatsAppAdapter` throw `ConfigError` for every non-`noop` value | Real delivery is impossible; the chain stops at the adapter seam |
| G2 | **No provider dependency or HTTP-send convention** | `package.json` runtime deps: bcryptjs, cors, express, helmet, multer, pg only | Any real adapter needs an explicit, reviewed dependency decision (or Node 20 built-in `fetch`) |
| G3 | **No delivery lifecycle** | Attempt tables hold only terminal `SENT\|FAILED`, one row per send; no `PENDING/SENDING/RETRY_SCHEDULED`, no `attempt_count`, no `next_retry_at` | A failed send is terminal; nothing re-tries it; nothing prevents double-sends on re-invocation |
| G4 | **No intent wiring for EMAIL/WHATSAPP** | `sendTemplateEmail` / `sendTemplateWhatsApp` have **zero callers**; `deliverInAppNotifications` is IN_APP-only; `notification_templates.channel` and `notifications.channel` CHECK constraints allow `IN_APP` only | Event → subscription → template fan-out produces in-app records only; outbound channels are unreachable from the intent path |
| G5 | **No delivery-level idempotency key** | Attempt tables are append-only with no uniqueness constraint beyond PK | A replayed event/intent would create duplicate external sends with no dedupe surface |
| G6 | **Flat provider result taxonomy** | Adapters return only `SENT\|FAILED` + free-text `error` | Cannot distinguish retryable (timeout, 429, 5xx) from permanent (invalid recipient, policy reject) failures; no provider message-id correlation beyond free-text `provider_reference` |
| G7 | **No provider feedback (delivery/bounce) path** | No webhook routes, no callback handling anywhere; `SENT` means "provider accepted" | Post-acceptance outcomes (delivered, bounced, complained) are unobservable; status freezes at `SENT` |
| G8 | **No authoritative phone source for Users** | `users` (0002) has `email` only; phones exist only on `tenant_pics` / `vendor_pics`; `sendTemplateWhatsApp` requires the caller to supply the phone | WhatsApp to platform Users has no governed contact source; no opt-in/consent record exists (`notification_preferences` from the original BE-26 plan was never built) |
| G9 | **Provider selection is global** | Env discriminators only; no per-Client provider config table | Multi-tenant provider isolation (different SMTP/BSP per Client) is not expressible today — acceptable now, must be flagged |
| G10 | **No send timeouts / circuit breaking** | noop resolves instantly; no adapter runtime contract for timeout, rate limit, or bulkheads | A slow/failing real provider could stall the dispatcher tick (scheduler has `inFlight` skip, but a hung send blocks that run until drain timeout) |
| G11 | **Email bodies are plain text only** | Templates render `{{var}}` text; adapter `body: string \| null` | No HTML multipart, no FROM/reply-to convention, no link-rewriting through BE-26J secure links |

---

## 3. Proposed provider architecture

### 3.1 Target chain

```text
Operational event (existing authority, unchanged)
  → BE-26D subscription match (existing)
  → BE-26B template render (existing; channel widened to EMAIL / WHATSAPP)
  → BE-26C recipient resolution (existing)
  → NEW outbound intent seam: one ledger row per (event, channel, recipient)
      notification_outbound_deliveries  [PENDING, idempotency_key UNIQUE]
  → claim-before-send (guarded PENDING → SENDING; BE-26I / SLA-02 pattern)
  → channel adapter: EmailAdapter.send / WhatsAppAdapter.send (existing interfaces)
  → provider result normalization (NEW taxonomy, §3.3)
  → immutable attempt row (existing 0241/0242 tables, + delivery_id FK)
  → ledger transition: SENT | RETRY_SCHEDULED(next_retry_at) | FAILED_PERMANENT | EXHAUSTED
  → operational event (existing recordOperationalEvent)
```

### 3.2 Provider abstraction — keep, extend the result only

- **Keep** the per-channel interfaces `EmailAdapter` / `WhatsAppAdapter` and
  their discriminator selection (`EMAIL_PROVIDER` / `WHATSAPP_PROVIDER`,
  fail-fast `ConfigError`). Do **not** merge them into one generic interface —
  the channels differ materially (subject/body vs message; templates vs
  session messages) and the existing seams are tested.
- **Extend** `EmailSendResult` / `WhatsAppSendResult` additively with:
  - `retryable?: boolean` (adapter's classification of a `FAILED` outcome;
    default conservative: `false`),
  - `providerMessageId?: string | null` (normalized provider id; supersedes
    free-text `providerReference` which stays for compatibility).
- **Register** concrete adapters in the existing resolver switch — one `case`
  per provider discriminator, adapter constructed with credentials read at the
  adapter boundary (§8). No hardcoded provider names anywhere else.
- Adapter runtime contract (new, enforced by the orchestration layer, not the
  interface): bounded send timeout, sanitized error on throw, never logging or
  returning credentials.

### 3.3 Provider result taxonomy

| Outcome | Meaning | Ledger transition |
|---|---|---|
| `ACCEPTED` | Provider accepted the message (sync response or queued-accepted) | → `SENT` |
| `REJECTED_RETRYABLE` | Transient failure: timeout, connection reset, HTTP 429/5xx, provider rate limit | → `RETRY_SCHEDULED` with `next_retry_at` (§7) |
| `REJECTED_PERMANENT` | Validation/policy failure: invalid recipient, bad address/number, unapproved template, policy block | → `FAILED_PERMANENT` |
| `ERROR_UNKNOWN` | Adapter threw or returned an unclassifiable result | Treat as `REJECTED_RETRYABLE` until attempts exhausted |

`SENT` keeps its existing meaning: **provider accepted**, not end-recipient
delivered. Post-acceptance states (`DELIVERED`, `BOUNCED`, `COMPLAINT`) are
feedback states reachable only through the callback seam (§9), never through
the send path.

### 3.4 The delivery ledger (new persistence authority)

`notification_outbound_deliveries` (proposed additive migration) — one row per
(channel, recipient, intent):

- identity: `id`, `client_id`, optional `building_id`, `recipient_user_id`,
  `channel ('EMAIL'|'WHATSAPP')`, `template_key` (FK `notification_templates`),
  `source_event_type`, `source_entity_type`, `source_entity_id`;
- content snapshot: rendered `subject`/`message` (rendered once at intent
  time — identical to the SLA-02 snapshot-on-schedule rule, so template edits
  cannot rewrite in-flight deliveries);
- lifecycle: `status ('PENDING'|'SENDING'|'SENT'|'RETRY_SCHEDULED'|'FAILED_PERMANENT'|'EXHAUSTED')`,
  `attempt_count`, `max_attempts`, `next_retry_at`, `last_attempt_at`;
- idempotency: `idempotency_key TEXT NOT NULL` with
  `UNIQUE(client_id, channel, idempotency_key)`;
- resolution fields: `recipient_address` (email or phone snapshot),
  `provider` (set on first attempt), `provider_message_id`, `last_error`.

The existing `notification_email_deliveries` / `notification_whatsapp_deliveries`
tables remain the **immutable attempt history**: one append-only row per
adapter call, gaining only an additive nullable `delivery_id` FK to the ledger
(nullable — pre-existing noop-era rows keep meaning). BE-26K history reads are
unchanged (they read attempt tables already).

### 3.5 Rejected alternatives

| Rejected | Why |
|---|---|
| Rebuild `notifications` as a multi-channel record (widen `channel` CHECK to EMAIL/WHATSAPP) | `notifications` is the **in-app inbox** authority (BE-26A); its lifecycle is UNREAD→READ, which is meaningless for outbound channels. Mixing would force inbox queries to filter channels forever. Outbound attempts already have their own tables |
| One generic `DeliveryProvider` interface replacing both adapters | Loses channel semantics (subject/body vs message; WhatsApp template approval), invalidates tested seams, no benefit — the resolver/discriminator pattern is already shared |
| Reusing `operational_events` as the delivery queue | It is a log, not an outbox (no processed flag / claim / due window) — BE-26 governance already flagged this |
| A second scheduler / queue / worker for retries | Forbidden by CR scope and by CR-BE-STAB-01; the existing dispatcher slot pattern (SLA-02 precedent) suffices |
| Storing retry state as columns on the existing attempt tables | Attempts must stay immutable append-only (they are the audit history); lifecycle belongs to a separate claimable ledger |

---

## 4. Email strategy

1. **Adapter shape** — keep `EmailAdapter`. A real adapter implements
   `send({to, subject, body})` over either SMTP or an HTTP API; **no provider
   is selected by this governance**. When a provider is chosen (PART 05 input),
   prefer Node 20 built-in `fetch` for HTTP-API providers to avoid new runtime
   dependencies; an SMTP adapter requires a dependency decision (e.g.
   nodemailer) recorded in that PART.
2. **Identity envelope** — new env keys, adapter-boundary only (§8):
   `EMAIL_FROM_ADDRESS`, optional `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`. These
   are product configuration, not credentials; they still never leak into logs
   or API responses.
3. **Content** — MVP sends the rendered template as **plain text** (existing
   render output). HTML/multipart, headers, attachments, and
   secure-link-in-body composition (BE-26J) are deferred; the adapter input
   shape already tolerates `body: string | null`.
4. **Recipient source** — `users.email` of ACTIVE users (existing
   `resolveRecipientEmail`), unchanged. No send to non-user addresses in this
   CR (tenant/vendor PIC emails are a separate decision).
5. **Deliverability ops** — SPF/DKIM/DMARC, sending domain, and bounce
   handling are deployment concerns documented in PART 05; the backend's only
   obligation is to record `provider_message_id` so bounces can be correlated
   later via the callback seam (§9).
6. **Local/test** — `noop` stays the default; PART 01 adds a credential-less
   `capture` adapter (§12) so development environments can inspect rendered
   mail without external contact. `NODE_ENV=test` never resolves a real
   adapter (config guard, same as the scheduler test rule).

---

## 5. WhatsApp strategy

1. **Adapter shape** — keep `WhatsAppAdapter` (`send({to, message})`). Real
   WhatsApp delivery implies the WhatsApp Business Platform (or a BSP); the
   adapter must map the internal `template_key` to the **provider-approved
   template name + components**, because business-initiated messages outside
   the 24-hour user-initiated window require pre-approved provider templates.
   That mapping is provider configuration owned by the adapter (§8), never the
   template authority (BE-26B stays provider-agnostic).
2. **Message class split (governed now, implemented in PART 06)** —
   - *session/user-initiated*: free-form rendered body, only within the
     provider's session window;
   - *business-initiated*: approved-template messages only; the adapter fails
     with `REJECTED_PERMANENT` if no approved-template mapping exists for the
     `template_key`.
3. **Recipient phone — hard precondition.** `users` has **no phone column**
   (G8). No WhatsApp-to-User send may ship before an authoritative, consented
   phone source exists. The governed option is an additive `users.phone`
   (+ opt-in flag or a minimal preference record) in a dedicated small PART;
   the interim fallback is restricting WhatsApp delivery to contact-bearing
   targets (`tenant_pics` / `vendor_pics` phones) — which requires a BE-26C
   resolution extension decision. Both options are parked; PART 06 is blocked
   until one is chosen. **No phone number is ever derived, scraped, or
   guessed.**
4. **Provider choice** — not made here. Meta WhatsApp Business Cloud API or a
   BSP (e.g. Twilio) are equally compatible with the interface; the choice is
   PART 06 input. Prefer built-in `fetch` for HTTP APIs.
5. **Local/test** — `noop` default + `capture` adapter as for email; real
   sends are impossible while `WHATSAPP_PROVIDER=noop` is the only resolvable
   value.

---

## 6. Delivery lifecycle / status model

```text
                      ┌──────────────┐
 intent created  ───▶ │   PENDING    │ ◀── duplicate intent: idempotency_key
                      └──────┬───────┘     collision returns the existing row
                 claim (guarded UPDATE)
                      ┌──────▼───────┐
                      │   SENDING    │  (at-most-once: loser of the claim no-ops)
                      └──────┬───────┘
             ┌───────────────┼────────────────────┐
        ACCEPTED      REJECTED_RETRYABLE      REJECTED_PERMANENT
             │               │                     │
      ┌──────▼──────┐ ┌──────▼──────────┐   ┌──────▼────────────┐
      │    SENT     │ │ RETRY_SCHEDULED │   │ FAILED_PERMANENT  │ (terminal)
      │ (terminal*) │ │ next_retry_at   │   └───────────────────┘
      └──────┬──────┘ └──────┬──────────┘
             │               └──▶ due again → PENDING-style reclaim
             │                    (attempt_count += 1; if > max_attempts
             │                     → EXHAUSTED, terminal)
   optional callback seam (§9), never from the send path:
      SENT → DELIVERED | BOUNCED | COMPLAINT | PROVIDER_FAILED
```

- Terminal states of the send path: `SENT`, `FAILED_PERMANENT`, `EXHAUSTED`.
- Every adapter call — success or failure — appends **one immutable attempt
  row** to the channel's existing delivery table (status, provider,
  `provider_message_id`, sanitized error, `sent_at`), linked by `delivery_id`.
- Status vocabulary on the ledger is a CHECK constraint; feedback states are
  additive values added together with the callback seam (migration stays
  additive).
- `notifications` (in-app) is untouched: IN_APP delivery remains its own
  synchronous chain with no ledger.

---

## 7. Retry / idempotency strategy

### 7.1 Idempotency (duplicate suppression)

- `idempotency_key = sha256(source_event_type | source_entity_id | channel |
  recipient_user_id | template_key)` computed at intent creation.
- `UNIQUE(client_id, channel, idempotency_key)` on the ledger: a replayed
  event/subscription match **inserts nothing** — the conflict returns the
  existing row and the orchestrator skips it (the BE-25H keyed-store idea,
  applied to delivery).
- Claim-before-send: dispatch only claims rows through a guarded
  `UPDATE … SET status='SENDING' WHERE id=$1 AND status IN
  ('PENDING','RETRY_SCHEDULED') RETURNING …`; a caller that gets no row back
  lost the claim and does nothing (verbatim BE-26I / SLA-02 pattern).
- Concurrency-safe enumeration: due rows selected with
  `FOR UPDATE SKIP LOCKED` (SLA-02 precedent), so overlapping scheduler runs
  or future multi-instance deployments cannot double-send.
- Adapter-level at-most-once: `provider_message_id` recorded per attempt gives
  a provider-side correlation key for dedupe/support.

### 7.2 Retry and backoff

- Only `REJECTED_RETRYABLE` / `ERROR_UNKNOWN` outcomes retry;
  `REJECTED_PERMANENT` is terminal immediately.
- Exponential backoff with jitter: `delay = min(base * 2^(attempt-1), cap)` ±
  jitter (proposed defaults: base 5 min, cap 6 h, `max_attempts` 5 — final
  values are config constants, not hardcoded).
- Retries are **durable and scheduler-driven**: the failed row gets
  `next_retry_at` and is picked up by a new due-job dispatcher domain slot
  (`processDueOutboundDeliveries(before)`), drained by the existing
  `setInterval` scheduler. No in-process retry loops, no timers outside the
  scheduler, no work while `NODE_ENV=test`.
- Each retry renders **nothing again** — the content snapshot on the ledger
  row is sent; only the address snapshot is re-validated (user still ACTIVE).
- Terminal failures (`FAILED_PERMANENT`, `EXHAUSTED`) emit an operational
  event for observability and are visible through BE-26K history; no
  automatic dead-letter UI in this CR.

---

## 8. Secrets / configuration strategy

1. **Discriminator stays in shared config** — `EMAIL_PROVIDER` /
   `WHATSAPP_PROVIDER` in `env.ts` exactly as today; `noop` default preserved;
   fail-fast on unknown values.
2. **Credentials never enter `AppConfig`.** Provider credentials (API keys,
   SMTP user/password, phone-number IDs) are read **inside the concrete
   adapter module** directly from `process.env` at adapter construction, with
   per-provider env-key prefixes (e.g. `EMAIL_<PROVIDER>_*` /
   `WHATSAPP_<PROVIDER>_*`). They are validated there, never logged, never
   returned by any API, never written to `operational_events` (the existing
   `SENSITIVE_KEYS` scrub plus the existing `sanitize*Error` redaction remain
   the backstop).
3. **Non-secret provider settings** (FROM address, region, base URL,
   approved-template mapping source) are env keys documented in `.env.example`
   with **no real values**.
4. **`.env.example` rule** — discriminators and placeholders only; the file
   never gains an actual secret (existing repo convention).
5. **No per-Client provider configuration in this CR** (G9): provider choice
   is deployment-global. The ledger still records `provider` per delivery so a
   future per-Client routing change is data-compatible.
6. **Test/dev safety** — `NODE_ENV=test` forces credential-less adapters
   (config guard); the `capture` adapter (§12 PART 01) writes rendered
   payloads to the attempt tables only — never to an external system.

---

## 9. Callback / webhook boundary

**Decision: not implemented in this CR; boundary defined now.**

- `SENT` means provider-accepted. Real-world outcomes (delivered, bounced,
  complained, provider-failed) arrive asynchronously and are
  provider-specific; no provider is chosen yet, so there is nothing concrete
  to implement.
- Governed future shape (single later PART, when a provider is selected):
  - one inbound route per channel/provider, e.g.
    `POST /webhooks/notifications/:channel` — **unauthenticated by user
    session, authenticated by provider signature** (HMAC/signature
    verification is mandatory and adapter-owned);
  - payload mapped to `(delivery_id or provider_message_id) → feedback state`
    (§6), writing one attempt-history row + ledger transition + one
    operational event;
  - replay-safe by construction: feedback transitions are guarded
    (`SENT → DELIVERED` only from `SENT`), duplicates are no-ops;
  - the route is registered behind a webhook-secret check, never behind user
    RBAC; it never mutates domain state — delivery status only.
- Until then, status stops at `SENT`; consumers (BE-26K history) must treat
  `SENT` as "accepted by provider", and this is documented in PART 04.

---

## 10. Audit / observability

1. **Operational events** (via existing `recordOperationalEvent`, no second
   audit concept): proposed vocabulary —
   `NOTIFICATION_OUTBOUND_QUEUED`, `NOTIFICATION_OUTBOUND_SENT`,
   `NOTIFICATION_OUTBOUND_FAILED_RETRYABLE`,
   `NOTIFICATION_OUTBOUND_FAILED_PERMANENT`,
   `NOTIFICATION_OUTBOUND_EXHAUSTED` — `entityType='NOTIFICATION_DELIVERY'`,
   `entityId = ledger id`, carrying `channel`, `provider`, `attempt_count`,
   sanitized error only. Scrubbing via existing `SENSITIVE_KEYS`.
2. **Attempt history** — existing immutable attempt tables remain the
   forensic record (rendered content snapshot, provider, reference, sanitized
   error); additive `delivery_id` FK ties attempt → ledger.
3. **Recipient visibility** — BE-26K `/notification-history` already unifies
   IN_APP/EMAIL/WHATSAPP reads; PART 04 exposes `provider` + attempt linkage
   through it without new routes.
4. **Operational/admin visibility** — no new public admin routes in this CR;
   if later needed, they go behind a new default-deny
   `notification_delivery.read` permission + `contextAccessService` filtering
   (decision deferred — flagged in risks).
5. **Logging** — structured `logger` entries at adapter boundaries
   (attempt id, channel, provider, outcome) with the existing rule: no
   credential, no full message body in logs.

---

## 11. Risks / gaps

| ID | Risk / gap | Mitigation in this governance |
|---|---|---|
| R1 | **Duplicate external sends** during retries/replays | Idempotency key UNIQUE + claim-before-send + `SKIP LOCKED` (§7); tested explicitly in PART 02/04 |
| R2 | **No phone source / consent for Users** blocks WhatsApp-to-User | Hard precondition in §5.3; PART 06 blocked until phone+opt-in PART lands; interim scope limited by decision, not workaround |
| R3 | Provider outage stalls dispatcher | Bounded adapter send timeout (PART 01 contract), per-item failure isolation already in dispatcher, retries are durable |
| R4 | `SENT` misread as "delivered" | §9 decision + BE-26K semantics documented in PART 04; feedback states additive later |
| R5 | Credential leakage via errors/logs/events | Adapter-boundary credential reading only; `sanitize*Error` + `SENSITIVE_KEYS` scrub already in place; PART tests assert redaction |
| R6 | Provider-specific surprise (template approval, rate limits, sandbox rules) | Adapter owns all provider mapping; permanent rejects surface as `FAILED_PERMANENT` with sanitized reason; provider decision is an explicit PART input, never implicit |
| R7 | Global provider choice vs multi-tenant needs (G9) | Accepted now; ledger records `provider` per row for future routing; flagged as later CR |
| R8 | Rendered content stored on ledger enlarges data footprint | Snapshot is required by the claim-before-send model (SLA-02 precedent); bodies are short operational messages; no unbounded payloads allowed (size cap in PART 02) |
| R9 | Scheduler cadence (default 60s) sets retry granularity | Acceptable for operational notifications; backoff base ≥ cadence; no redesign of scheduler |
| R10 | No `notification_preferences` exists (opt-out) | Flagged: real sends should honor preferences; a minimal per-channel opt-out is a candidate PART before PART 05/06 go live (does not block ledger/noop work) |

**Constraints restated:** no push provider, no SLA redesign, no notification
foundation rebuild, no unrelated channels, no CI/KI-003, no commercial
provider assumed, no migration/runtime/route work in this START step.

---

## 12. Lightweight PART breakdown

```text
PART 01 — Provider result taxonomy + capture adapter (types/adapters only)
PART 02 — Outbound delivery ledger (migration + repository + idempotency)
PART 03 — Channel widening + outbound intent orchestration (noop end-to-end)
PART 04 — Retry/backoff engine + due-job dispatcher slot + observability
PART 05 — Real EMAIL adapter (gated: provider decision + secrets wiring)
PART 06 — Real WHATSAPP adapter (gated: phone/consent decision + provider decision)
PART 07 — Callback/webhook seam (gated: after PART 05/06 provider exists)
```

- **PART 01** — Extend `EmailSendResult` / `WhatsAppSendResult` additively
  (§3.2/§3.3); add credential-less `capture` adapter for both channels
  (`EMAIL_PROVIDER=capture` / `WHATSAPP_PROVIDER=capture`) that records
  payloads without external contact; config guard that `test` never resolves
  a real adapter. No migration, no route.
- **PART 02** — Migration `notification_outbound_deliveries` (§3.4) + additive
  nullable `delivery_id` FK columns on 0241/0242 tables; repository with
  insert-on-conflict-return (idempotency), guarded claim, due enumeration
  (`SKIP LOCKED`). No orchestration yet.
- **PART 03** — Widen `notification_templates.channel` CHECK to
  `IN_APP|EMAIL|WHATSAPP` (additive constraint replacement) and the
  subscription fan-out; new outbound intent seam
  `deliverOutboundNotifications(event, channels)` reusing BE-26D→B→C, creating
  ledger rows; `notifications` (IN_APP) untouched. End-to-end testable with
  noop/capture adapters only.
- **PART 04** — Retry engine (backoff/jitter/max attempts as config
  constants), `processDueOutboundDeliveries` dispatcher slot + additive
  `DueJobDispatchResult` key, operational-event vocabulary (§10), BE-26K
  history enrichment (`provider`, attempt linkage), status-semantics docs.
- **PART 05** — Gated. Real email adapter for the chosen provider: dependency
  decision, adapter-boundary credentials (§8), FROM/reply-to config,
  timeout/circuit contract, focused tests against a fake transport.
- **PART 06** — Gated. Requires prior phone+consent decision (§5.3, its own
  micro-PART: additive `users.phone` + opt-in) and provider decision;
  approved-template mapping, session vs business-initiated split.
- **PART 07** — Gated. Inbound provider feedback route per §9 (signature
  verification, guarded feedback transitions, attempt row + event).

Keep-as-defined: each PART is separable and a complete deliverable; do not
combine PARTs to go faster; PART 05/06/07 must not start before 01–04 and
their gating decisions.

---

## 13. Targeted validation strategy

Validation is per-PART, using the repository's existing harness
(`tsx --test`, `tests/*.test.ts`, embedded Postgres, `NODE_ENV=test`):

1. **PART 01** — unit: result-taxonomy mapping for every adapter outcome;
   capture adapter records payload and never contacts anything; config guard
   blocks real adapters in `test`.
2. **PART 02** — integration: idempotency-key conflict returns the existing
   row (no duplicate); guarded claim is won by exactly one of N concurrent
   claimants; due enumeration under `SKIP LOCKED` never hands the same row to
   two runs.
3. **PART 03** — integration: event → subscription → template → recipients →
   one ledger row per (channel, recipient); deactivated template suppresses;
   IN_APP chain byte-identical in behavior (regression).
4. **PART 04** — integration: retryable failure schedules `next_retry_at` and
   a later dispatcher pass re-attempts; permanent failure is terminal;
   max-attempts exhaustion → `EXHAUSTED`; exactly one attempt row per adapter
   call; operational events emitted with sanitized errors; duplicate replay
   produces zero additional sends.
5. **PART 05/06** — focused tests against a **fake transport injected through
   the existing adapter seam** (constructor injection already supported); no
   real external call in CI; redaction tests assert no credential appears in
   persisted errors, logs, or events.
6. **Never**: broad repo test runs, real provider traffic, scheduler active
   under `NODE_ENV=test`, or validation that requires migrated production
   data.

---

## 14. What was NOT done at START GOVERNANCE (per instructions)

- No migration, no runtime code, no route, no permission seed, no OpenAPI
  change, no tests added or run, no CI work (KI-003 untouched).
- No provider selected, no dependency added, no external system contacted.
- No change to notification foundation, scheduler, SLA authority, RBAC, or
  isolation behavior.
- No PR created, no merge. STOP after START GOVERNANCE.

---

## 15. Implementation notes

### PART 01 — Provider result taxonomy + capture adapter: **DONE** (2026-08-23)

Scope delivered exactly as defined in §12 PART 01 — types/adapters only; no
migration, no route, no ledger, no retry engine, no scheduler change.

| Item | Implementation |
|---|---|
| Shared taxonomy (§3.3) | `src/shared/provider-result.ts` — `DELIVERY_PROVIDER_OUTCOMES` (`ACCEPTED`, `REJECTED_RETRYABLE`, `REJECTED_PERMANENT`, `ERROR_UNKNOWN`), `classifyProviderResult` (SENT → ACCEPTED; FAILED → RETRYABLE only when the adapter explicitly says so, conservative default PERMANENT; never returns ERROR_UNKNOWN), `isRetryableProviderOutcome` (REJECTED_RETRYABLE + ERROR_UNKNOWN retryable), guard `isDeliveryProviderOutcome` |
| Result extension (§3.2) | `EmailSendResult` / `WhatsAppSendResult` extended **additively** with `retryable?: boolean` and `providerMessageId?: string \| null`; existing `providerReference` retained for compatibility; noop adapter unchanged |
| Persistence mapping | Delivery services persist `providerMessageId ?? providerReference` into the **existing** `provider_reference` column (no schema change) |
| Capture adapters | `CaptureEmailAdapter` / `CaptureWhatsAppAdapter` (`provider='capture'`): credential-less, never contact anything, record successful send inputs in an in-memory capture list, return synthetic `capture-…` / `wa-capture-…` message ids; constructor outcome `sent \| fail \| fail-permanent \| fail-retryable` simulates the taxonomy deterministically (fail/fail-permanent → `retryable:false`, fail-retryable → `retryable:true`) |
| Resolver | `resolveEmailAdapter` / `resolveWhatsAppAdapter` resolve `noop` and `capture`; fail-fast `ConfigError` otherwise; **test-environment guard**: under `NODE_ENV=test` only credential-less providers (`noop`, `capture`) may resolve |
| Config docs | `.env.example` comments updated (discriminators + non-secret values only; defaults unchanged) |
| Validation | `npm run typecheck` clean; new focused tests `tests/provider-result.test.ts` (8) + `tests/capture-adapter.test.ts` (14, incl. DB-backed capture-through-service cases) all pass; directly affected existing suites (`email-adapter`, `whatsapp-adapter`, `notification-history`) pass unchanged — no broad regression run |

Deferred to later PARTs (unchanged from §12): delivery ledger (PART 02),
channel widening + intent orchestration (PART 03), retry/backoff + dispatcher
slot (PART 04), real provider adapters (PART 05/06, gated), callbacks
(PART 07, gated).

### PART 02 — Outbound delivery ledger + idempotent repository: **DONE** (2026-08-23)

Scope delivered exactly as defined in §12 PART 02 — schema + repository only;
no orchestration, no retry engine, no scheduler wiring, no route.

| Item | Implementation |
|---|---|
| Ledger migration `0298` | `notification_outbound_deliveries` per §3.4: identity (`client_id`, optional `building_id`, `recipient_user_id`, `channel IN ('EMAIL','WHATSAPP')`, `template_key` FK, `source_event_type/entity_type/entity_id`), content snapshot (`subject` nullable, `message`), lifecycle (`status IN ('PENDING','SENDING','SENT','RETRY_SCHEDULED','FAILED_PERMANENT','EXHAUSTED')`, `attempt_count`, `max_attempts` default 5, `next_retry_at`, `last_attempt_at`), provider result fields (`provider`, `provider_message_id`, `last_error`), `idempotency_key` with `UNIQUE (client_id, channel, idempotency_key)`. Size caps per R-08 (subject ≤ 500, message ≤ 4000, address ≤ 320, last_error ≤ 500, event/entity type ≤ 128). Partial due-window expression index + recipient/client/source indexes |
| Attempt linkage migration `0299` | Additive nullable `delivery_id` FK (`ON DELETE SET NULL`) + index on both `notification_email_deliveries` and `notification_whatsapp_deliveries`; pre-existing rows stay valid with NULL (back-compat asserted by test) |
| Idempotency authority (§7.1) | `computeOutboundDeliveryIdempotencyKey` in `src/modules/notification-outbound-deliveries/outbound-delivery.idempotency.ts`: sha256 over `source_event_type \| source_entity_id \| channel \| recipient_user_id \| template_key` with normalization (event type/channel uppercase, UUIDs lowercase, trimmed); malformed identity throws — a bad key can never silently weaken dedupe |
| Repository seams (§3.5/§7) | `notificationOutboundDeliveryRepository` — `createOnConflictReturn` (INSERT ON CONFLICT DO NOTHING + read-back; returns `{record, created}`, replay never overwrites the original snapshot), `findByIdempotencyKey`, `findById`, `findDueDeliveries` (claimable + `COALESCE(next_retry_at,'-infinity') <= before`, bounded by `clampDueItemLimit`, `FOR UPDATE SKIP LOCKED`, deterministic order — mirrors `findDueActions`), `claimDelivery` (guarded `PENDING/RETRY_SCHEDULED → SENDING`, loser gets null), and guarded claim-owner result seams `markSent` / `markRetryScheduled` / `markFailedPermanent` / `markExhausted` (all `WHERE status='SENDING'`, `attempt_count += 1`, provider fields via COALESCE so the first-attempt provider survives retries) |
| Module | New `src/modules/notification-outbound-deliveries` (types + idempotency + repository + barrel); no routes, no controllers, no permission codes |
| Validation | `npm run typecheck` clean; new focused suite `tests/outbound-delivery-ledger.test.ts` (17 tests, embedded Postgres) — key-authority determinism/normalization, collision-returns-existing (payload not overwritten), channel-scoped uniqueness, claim-once under 8 concurrent claimants, SKIP LOCKED disjoint enumeration, one-way guarded result seams, attempt-linkage FK semantics. Directly affected suites (`email-adapter`, `whatsapp-adapter`, `notification-history`, PART 01 `provider-result`/`capture-adapter`) re-run green against the new migration chain (62/62) — no broad regression run |

Deferred to later PARTs (unchanged from §12): channel widening + intent
orchestration (PART 03), retry/backoff + dispatcher slot (PART 04), real
provider adapters (PART 05/06, gated), callbacks (PART 07, gated).

**PART 03 readiness:** the ledger consumes exactly the shapes PART 03
produces — rendered content snapshot + resolved address + idempotency key —
and the capture adapters (PART 01) give deterministic send simulation for the
orchestration's end-to-end tests. PART 03 owns template-channel widening
(additive CHECK replacement), the `deliverOutboundNotifications(event,
channels)` intent seam reusing BE-26D→B→C, and ledger-row creation through
`createOnConflictReturn`; it must not touch the ledger's claim/result seams.

### PART 03 — Template channel widening + outbound intent orchestration: **DONE** (2026-08-23)

Scope delivered exactly as defined in §12 PART 03 — widening + intent seam
only; no claim/send execution, no retry engine, no scheduler wiring, no
route, no provider contact.

| Item | Implementation |
|---|---|
| Channel widening (migration `0300`) | `notification_templates.channel` CHECK replaced by its strict superset `IN_APP \| EMAIL \| WHATSAPP` (every existing IN_APP row stays valid; down-migration restores IN_APP-only). `NOTIFICATION_TEMPLATE_CHANNELS` widened in BE-26B types — create/update validation and guards follow automatically. `notifications` (in-app inbox) CHECK deliberately NOT widened (§3.5) |
| Intent seam | `deliverOutboundNotifications(event, channels = ['EMAIL','WHATSAPP'])` in `src/modules/notification-delivery/outbound-delivery-intent.service.ts`: BE-26D subscription match → BE-26B render ONCE (ACTIVE + outbound-channel templates only) → BE-26C recipient resolution → one PART 02 ledger row per (channel, recipient) via `createOnConflictReturn`. IN_APP templates are skipped (BE-26E `deliverInAppNotifications` stays that authority); the IN_APP chain and `notifications` are untouched |
| Rendered-once snapshot | Subject/message rendered once at intent time and frozen on each ledger row (SLA-02 snapshot precedent): EMAIL carries `subject` + message; WHATSAPP carries `subject = NULL` + message (body, falling back to rendered subject — same rule as the BE-26G service); address snapshot = `users.email` of ACTIVE users for EMAIL |
| WHATSAPP address policy (§5.3) | No governed phone source exists (`users` has no phone) → WHATSAPP recipients are skipped with reason (`recipientsSkipped`), never derived/guessed. The seam is complete and tested for the skip path; phone + consent remains the gated PART 06 precondition |
| Idempotency | Keys computed by the PART 02 authority; replayed events return `duplicatesSuppressed` counts and create zero rows; original snapshots are never overwritten |
| Shared normalization | BE-26E's private event validation extracted verbatim into `notification-delivery-event.ts` (`normalizeDeliveryEvent`); both chains now validate/normalize identically. Types: `NotificationDeliveryEvent` (shared) + `InAppDeliveryEvent` alias (compat) + `OutboundDeliveryIntentResult` counters (`subscriptionsMatched`, `templatesSkipped`, `recipientsResolved`, `recipientsSkipped`, `deliveriesCreated`, `duplicatesSuppressed`) |
| Validation | `npm run typecheck` clean; new focused suite `tests/outbound-intent.test.ts` (7 tests, embedded Postgres): widening creates + DB-CHECK rejection of out-of-vocabulary channels, one-ledger-row-per-(channel, recipient) with snapshot/idempotency-key assertions, replay suppression, channel-filter runs, render contract (missing variable rejects), WHATSAPP skip + zero inbox side effects, produced intents claimable by PART 02 seams. Directly affected suites re-run green: `notification-delivery` (BE-26E regression), `notification-templates`, `notification-subscriptions`, `outbound-delivery-ledger` (53/53) — no broad regression run |

Deferred to later PARTs (unchanged from §12): retry/backoff + dispatcher slot
(PART 04), real provider adapters (PART 05/06, gated), callbacks (PART 07,
gated).

**PART 04 readiness:** intents accumulate as PENDING ledger rows with a
partial due-window index already in place (PART 02), the taxonomy classifies
adapter results (PART 01), and capture adapters simulate retryable/permanent
failures deterministically. PART 04 owns: backoff/jitter/max-attempt config
constants, the execution loop (claim → adapter send via PART 01 resolvers →
attempt-history row with `delivery_id` → guarded result seam per taxonomy
outcome), the `processDueOutboundDeliveries` dispatcher slot + additive
`DueJobDispatchResult` key, and the operational-event vocabulary (§10). It
must not alter the intent seam or ledger schema.

### PART 04 — Retry engine + outbound delivery execution + dispatcher integration: **DONE** (2026-08-23)

Scope delivered exactly as defined in §12 PART 04 — execution, retry, due-job
integration, observability. No intent-seam or ledger-schema change was needed
(no confirmed PART 04 defect). No real provider, no webhook, no phone/consent
authority.

| Item | Implementation |
|---|---|
| Execution loop (§3.1) | `processOutboundDelivery(id, at?, adapters?)` in `src/modules/notification-delivery/outbound-delivery-execution.service.ts`: guarded claim (`PENDING/RETRY_SCHEDULED → SENDING`) → channel adapter resolved via the PART 01 discriminators (override map is the test seam) → **exactly one immutable attempt-history row per adapter call** (BE-26F/G tables, now carrying `delivery_id`) → guarded result seam per taxonomy outcome → operational event. A caller that loses the claim performs no side effect |
| Taxonomy handling (§3.3) | `ACCEPTED → markSent` (terminal); `REJECTED_RETRYABLE` → retry window while budget remains; `REJECTED_PERMANENT → markFailedPermanent` (terminal); adapter THROW → `ERROR_UNKNOWN`, treated retryable until attempts exhaust — never a silent loss. Outcomes `SENT / RETRY_SCHEDULED / FAILED_PERMANENT / EXHAUSTED / NOT_CLAIMABLE / NOT_FOUND` |
| Retry/backoff (§7.2) | Named config constants (never hardcoded in logic): `OUTBOUND_RETRY_BASE_MS` 5 min, `OUTBOUND_RETRY_CAP_MS` 6 h, `OUTBOUND_RETRY_JITTER_RATIO` ±25%, `OUTBOUND_DEFAULT_MAX_ATTEMPTS` 5; `computeOutboundRetryDelayMs(attempt, {baseMs, capMs, jitterRatio, random})` = `min(base·2^(attempt−1), cap)` × jitter ∈ [0.75, 1.25], deterministic under injected RNG. Retries are durable (`next_retry_at`) — no in-process timers |
| Exhaustion | Retryable/unknown failure with `attemptNumber >= maxAttempts` → `markExhausted` (terminal `EXHAUSTED`); exhaustion checked per row against its own ledger `max_attempts` |
| Dispatcher integration (§6.3 precedent) | `processDueOutboundDeliveries(before, limit, adapters?)`: bounded due enumeration in a short `SKIP LOCKED` transaction + per-row failure isolation (SLA-02 dispatcher pattern); wired into `processDueOperationalJobs` as a new domain running last; additive `DueJobDispatchResult.outboundDeliveries` key (`due/sent/retryScheduled/failedPermanent/exhausted/skipped/failures`) — all earlier keys unchanged. The existing `setInterval` scheduler drains it automatically; scheduler untouched |
| Attempt-history behavior | Both attempt tables gained additive read/write support for `delivery_id` (`NewEmailDelivery`/`NewWhatsAppDelivery.deliveryId?`, repository INSERT/SELECT, public shapes); SUCCESS rows: status SENT + `provider_reference = providerMessageId ?? providerReference` (PART 01 mapping) + `sent_at`; FAILURE rows: status FAILED + sanitized error + `sent_at = NULL`. Pre-ledger attempts keep `delivery_id = NULL` |
| BE-26K enrichment | History union + row/public types expose `deliveryId` (NULL for IN_APP rows and pre-ledger attempts); `provider`/`providerReference` were already exposed |
| Events/observability (§10) | `NOTIFICATION_OUTBOUND_SENT / _FAILED_RETRYABLE / _FAILED_PERMANENT / _EXHAUSTED` via `recordOperationalEvent`, `entityType='NOTIFICATION_DELIVERY'`, `entityId = ledger id`, metadata `{channel, provider, attemptCount, templateKey, error?}` (error sanitized; helper already scrubs sensitive keys). `NOTIFICATION_OUTBOUND_QUEUED` is an intent-creation-time event: vocabulary reserved, deliberately unwired because PART 04 must not modify the PART 03 intent seam |
| Validation | `npm run typecheck` clean; new focused suite `tests/outbound-delivery-execution.test.ts` (10 tests, embedded Postgres): backoff determinism/bounds/cap, ACCEPTED path with attempt-row + event assertions, retry window within jitter bounds then re-attempt to SENT (attempt accounting + provider preservation), permanent terminal, budget exhaustion, ERROR_UNKNOWN throw redaction (`api_key=[REDACTED]`), terminal replay no-ops, WHATSAPP execution via capture resolver, due-drain once-and-only-once, `processDueOperationalJobs.outboundDeliveries` reporting. Directly affected suites green (108/108 across execution, dispatcher/scheduler, email/whatsapp adapters, history, notification-delivery, ledger, intent); two directly-affected assertions updated for additive shapes (`deliveryId` key lists; dispatcher result keys) — no broad regression run |

Deferred to later PARTs (unchanged from §12): real provider adapters
(PART 05/06, gated on provider + secrets decisions and the WhatsApp
phone/consent PART), callbacks (PART 07, gated).

**Readiness for gated real-provider PARTs:** the provider boundary is fully
mechanical now — PART 05/06 only add adapter classes behind the existing
discriminators (resolver switch + credential reading at the adapter boundary,
§8), with the taxonomy's `retryable` hint as their only new contract
obligation; execution, retries, attempt history, events, and isolation need no
further change. `NOTIFICATION_OUTBOUND_QUEUED` should be wired when the
intent seam is next touched.

### PART 05 — Real Email SMTP adapter (gated provider): **DONE** (2026-08-23)

Provider decision supplied to the gate: **`EMAIL_PROVIDER=smtp`** (owner
decision, 2026-08-23). Scope delivered exactly as PART 05 defines — one real
adapter behind the existing discriminator; no ledger/retry/scheduler change,
no webhook, no WhatsApp/push.

| Item | Implementation |
|---|---|
| Provider / dependency | Discriminator `smtp`. Dependency decision per §4.1: **nodemailer** (runtime) + `@types/nodemailer` (dev) — the only new dependencies in this CR; the adapter speaks SMTP/STARTTLS/AUTH through nodemailer with bounded `connectionTimeout` 10s / `greetingTimeout` 15s / `socketTimeout` 20s (§3.2 runtime contract) |
| Adapter | `SmtpEmailAdapter` (`src/modules/email-delivery/smtp-email-adapter.ts`) implements the PART 01 `EmailAdapter` contract; construction validates config and builds an injectable `SmtpTransport` seam (production = nodemailer wrapper, tests = mock), opening **no connection until `send`**. Envelope accepts → `SENT` + nodemailer `messageId` as `providerMessageId`/`providerReference`; envelope REJECT of the recipient is classified by the server response code (4xx retryable / 5xx permanent) |
| Config keys | `EMAIL_SMTP_HOST` (required), `EMAIL_SMTP_PORT` (default 587, 1–65535), `EMAIL_SMTP_SECURE` (default false), `EMAIL_SMTP_USERNAME`/`EMAIL_SMTP_PASSWORD` (AUTH only when the username is non-empty), `EMAIL_FROM_ADDRESS` (required), `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`. Read by `readSmtpEmailConfig` **inside the adapter module only** — `env.ts`/`AppConfig` still read only the `EMAIL_PROVIDER` discriminator (§8 boundary preserved). Documented with empty placeholders in `.env.example` |
| Error/taxonomy mapping (§3.3) | `classifySmtpError`: 4xx `responseCode` / transient network codes (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`, `EAI_AGAIN`, `ENOTFOUND`, `EPROTO`) → `retryable: true`; 5xx / `EAUTH` / auth-message failures → `retryable: false`; unclassified → `retryable: true` (bounded by the ledger attempt budget — a silent permanent loss is worse than a bounded extra attempt). Every adapter error is redacted (`sanitizeSmtpError`, 500-char cap) before it leaves the module; PART 04 sanitizes again at persistence |
| Secrets boundary | Credentials never enter `AppConfig`, logs, events, DB rows, or API responses: read at construction only, excluded from wire messages (asserted by test), never embedded in error text (credential-like fragments redacted); `ConfigError` messages name fields only. Resolver test-env guard unchanged: under `NODE_ENV=test` only `noop`/`capture` resolve — `smtp` is blocked there |
| Resolver | `resolveEmailAdapter` gains the `smtp` case (after the test-env guard; fail-fast `ConfigError` on incomplete SMTP config at resolution); `AVAILABLE_EMAIL_PROVIDERS = noop, capture, smtp`; unknown discriminators still fail fast listing all three |
| Validation | `npm run typecheck` clean; new focused suite `tests/smtp-email-adapter.test.ts` (17 tests) against a **mock SmtpTransport — zero external network**: config defaults/required-keys/credential-free errors, wire-message construction (credentials absent from the message), envelope-reject 4xx/5xx mapping, transport-failure taxonomy matrix, EAUTH permanent, unclassified retryable, error redaction, resolver wiring incl. test-env guard. Directly affected suites re-run green (`email-adapter`, `capture-adapter`; one PART 01 assertion updated — its "unimplemented provider" example moved from `smtp` to `ses` since smtp is now implemented): 45/45 — no broad regression run, no CI |

Deferred (unchanged): WhatsApp provider (PART 06, gated on phone/consent +
provider decision), callbacks (PART 07, gated), `NOTIFICATION_OUTBOUND_QUEUED`
intent wiring.

**PART 06 gate status:** BLOCKED on two owner decisions per §5 — (1) the
WhatsApp provider (Meta WhatsApp Business Cloud API vs a BSP), and (2) the
authoritative consented phone source for Users (additive `users.phone` +
opt-in, or an interim contact-bearing-target restriction). Until both are
supplied, `WHATSAPP_PROVIDER` remains `noop`/`capture`-only and the resolver
test-env guard keeps any real provider out of tests.

### PART 06 — Authoritative WhatsApp contact + consent + Meta adapter (gated provider): **DONE** (2026-08-23)

Gate decisions supplied: **provider = Meta WhatsApp Business Cloud API**;
**recipient = authoritative E.164 number + explicit opt-in/opt-out consent on
Users** (gate inspection placed both on the `users` identity master). Scope
delivered exactly as PART 06 defines — no ledger/retry/scheduler architecture
change, no webhook/signature handling, no push, no PIC-derived numbers.

| Item | Implementation |
|---|---|
| Contact + consent authority (migration `0301`) | Additive on `users` (BE-01A): `whatsapp_phone TEXT` (strict E.164 CHECK `^\+[1-9][0-9]{6,14}$`), `whatsapp_opted_in_at`, `whatsapp_opted_out_at` (both nullable), partial unique index one-account-per-number. All existing rows stay valid (NULLs = no contact/consent → never messaged). `WHATSAPP_E164_PHONE_PATTERN` exported from whatsapp-delivery types |
| Consent-active rule | `status='ACTIVE'` AND phone present AND opted in AND (`opted_out_at IS NULL OR opted_in_at > opted_out_at`) — implemented once as `isUserWhatsAppConsentActive` (unit-tested) and as the single guarded SQL in intent resolution; last-write-wins timestamp semantics |
| Guarded update seam | `userService.updateUserWhatsAppContact(id, {whatsappPhone?, consent?})` + route `PATCH /users/:id/whatsapp-contact` behind existing `user.manage` (no new permission code): strict E.164 validation, OPT_IN requires a phone, clearing the phone clears both consent stamps, clear+OPT_IN rejected, one-account-per-number 409 (`USER_WHATSAPP_PHONE_ALREADY_EXISTS`), unknown user 404. Consent is always explicit — never implied by setting a number, never inferred from tenant/vendor PICs |
| WhatsApp intent resolution | PART 03 seam's WHATSAPP branch now returns the consented `users.whatsapp_phone` under the consent-active rule (ACTIVE only); everything else still counts as `recipientsSkipped`. EMAIL branch unchanged |
| Meta adapter | `MetaWhatsAppAdapter` (`provider='meta'`, `src/modules/whatsapp-delivery/meta-whatsapp-adapter.ts`) implements the PART 01 contract through an injectable `MetaWhatsAppHttpTransport` (production = built-in `fetch` with bounded 20s timeout; tests = mock). Session text sends when no `templateKey`; **approved-template mapping required** for `templateKey` sends (`WHATSAPP_META_TEMPLATE_MAP`, string shorthand or `{name, language}`; missing mapping → REJECTED_PERMANENT before any HTTP call, §5.2). Rendered message is the template's single body-text parameter. The PART 04 engine passes the ledger's `templateKey` through the additive `WhatsAppSendInput.templateKey` field (noop/capture ignore it) |
| Boundary config (§8) | `WHATSAPP_META_ACCESS_TOKEN` + `WHATSAPP_META_PHONE_NUMBER_ID` required; optional `WHATSAPP_META_API_BASE_URL` (graph.facebook.com), `WHATSAPP_META_API_VERSION` (v21.0), template map — read by `readMetaWhatsAppConfig` inside the adapter module only; `env.ts`/`AppConfig` unchanged; ConfigErrors name fields only; token never in bodies/logs/errors (redaction asserted) |
| Taxonomy mapping (§3.3) | 2xx → SENT (+ `wamid`); HTTP 429/5xx, network/timeout, Meta 130xxx throttle family → `retryable:true`; HTTP 401/403, Meta message-policy rejects (131026/131047/131051/…) → `retryable:false`; unclassified → retryable (bounded by attempt budget). Resolver gains `meta` after the test-env guard; `AVAILABLE_WHATSAPP_PROVIDERS = noop, capture, meta` |
| Validation | `npm run typecheck` clean; two new focused suites: `tests/meta-whatsapp-adapter.test.ts` (15 tests, mock transport — zero network: config/defaults/template-map parsing + credential-free errors, template & session payloads incl. auth-header-only assertion, mapping-missing permanent reject without HTTP, Meta failure matrix, network redaction, resolver wiring + test-env guard) and `tests/user-whatsapp-consent.test.ts` (9 tests, embedded Postgres: seam rules incl. 409/validation/clear-consent, consent-active rule matrix, intent resolution creates WHATSAPP rows only for consented ACTIVE users, opt-out replay-safe skip, RBAC route 200/400/404/401). Directly affected suites green (74 pass / 11 environment skips across users, whatsapp/capture adapters, outbound intent, execution; three additive-key assertions updated: `users` ×2, mobile-auth login user keys) — no broad regression run, no CI |

Deferred (unchanged): PART 07 callbacks (gated; includes Meta webhook
signature handling + `WHATSAPP_META_APP_SECRET`), `NOTIFICATION_OUTBOUND_QUEUED`
intent wiring.

**OpenAPI closure (FINAL REVIEW):** `PATCH /users/{userId}/whatsapp-contact`
documented (`UpdateUserWhatsAppContactRequest` schema; 200/400/401/403/404/409)
and the `PublicUser` schema carries the three WhatsApp contact/consent fields.

**PART 07 gate status:** BLOCKED on the provider callback enrollment details
(Meta app secret + webhook verify token provisioning). The governed shape from
§9 stands: one signature-verified inbound route per channel, guarded feedback
transitions (`SENT → DELIVERED/BOUNCED/COMPLAINT/PROVIDER_FAILED`), attempt
row + ledger + operational event per feedback, replay-safe by construction.
No webhook code exists yet.

### PART 07 — Meta WhatsApp callback + delivery feedback: **DONE** (2026-08-23)

Scope delivered exactly as PART 07 defines (gate findings applied) — WhatsApp
feedback only; no email callbacks, no new channels, no invented secrets, send
lifecycle and immutable attempt history preserved.

| Item | Implementation |
|---|---|
| Migration `0302` (additive) | Ledger feedback vocabulary: `provider_feedback_status` (CHECK `DELIVERED\|BOUNCED\|COMPLAINT\|PROVIDER_FAILED` — WhatsApp uses DELIVERED/PROVIDER_FAILED; BOUNCED/COMPLAINT reserved for a future email path), `feedback_at`, `feedback_error` (≤ 500, sanitized) + the `provider_message_id` partial correlation index (the minimum required schema addition) |
| Config boundary (§8 style) | `WHATSAPP_WEBHOOK_ENABLED` (default **false**), `WHATSAPP_META_APP_SECRET`, `WHATSAPP_META_WEBHOOK_VERIFY_TOKEN` — read at router construction only (never `env.ts`/`AppConfig`); enabled-without-secrets fails fast at boot; `.env.example` placeholders only |
| Route surface (§9 shape) | `GET /webhooks/notifications/whatsapp` — Meta handshake (mode + constant-time verify-token compare → challenge echo, else 403); `POST /webhooks/notifications/whatsapp` — raw-body `express.raw` parse (mounted **before** the app-wide JSON parser so HMAC sees the exact bytes), `X-Hub-Signature-256` HMAC-SHA256 verification via `timingSafeEqual` → 401 on mismatch with zero persistence. No session/RBAC; provider-signature auth only; 200 after verification so Meta stops retrying |
| Correlation | Primary: `statuses[].id` (wamid) → ledger `provider_message_id` (PART 07 index); fallback: attempt-history `provider_reference → delivery_id` (PART 02 linkage); `recipient_id` never used as a key |
| Lifecycle semantics | Meta `sent` → no-op; `delivered`/`read` → `DELIVERED`; `failed` → `PROVIDER_FAILED` (+ sanitized `Meta error <code>: …`). Guarded transition `status='SENT' AND provider_feedback_status IS NULL` → first accepted feedback wins; duplicates and out-of-order statuses are deterministic no-ops; **retry is never reopened** (non-SENT rows reject feedback). Send-path status and immutable attempt tables untouched — feedback annotates the ledger only (the §9 "attempt-history row" wording refined to protect attempt immutability; audit lives in events) |
| Events/observability (§10) | `NOTIFICATION_OUTBOUND_DELIVERED` / `NOTIFICATION_OUTBOUND_PROVIDER_FAILED` via `recordOperationalEvent` (`entityType='NOTIFICATION_DELIVERY'`, metadata incl. feedbackStatus/providerMessageId/sanitized error); BE-26K history enriched with `providerFeedbackStatus` + `feedbackAt` through the ledger join (NULL for IN_APP/unlinked rows) |
| Validation | `npm run typecheck` clean; new focused suite `tests/whatsapp-callback.test.ts` (13 tests, embedded Postgres, **mocked signatures/payloads only, zero external network**): signature/handshake primitives, disabled-by-default 404, handshake 200/403, 401 unsigned/mis-signed with zero persistence, delivered/read→DELIVERED once + event, sent/unknown no-ops, failed→PROVIDER_FAILED with redaction, replay + out-of-order no-ops, non-SENT guard, attempt-fallback correlation, history enrichment + attempt immutability. Directly affected suites green (`notification-history`, ledger, execution, intent — 44/44) — no broad regression run, no CI |

Deferred: email provider + email callbacks (no email feedback path exists
until an email provider decision beyond SMTP needs it), push channel.

**OpenAPI closure (FINAL REVIEW):** `NotificationHistoryItem` carries the
PART 04/07 enrichments (`deliveryId`, `providerFeedbackStatus`, `feedbackAt`).
The webhook routes are intentionally NOT placed in `docs/api/openapi.yaml`
`paths`: the contract test probes every documented path under `/api/v1`,
while the webhook surface is mounted OUTSIDE the API prefix
(`/webhooks/notifications/whatsapp`), so documenting it there would create a
false 404 inconsistency. The provider-facing webhook contract (handshake,
`X-Hub-Signature-256` HMAC verification, payload mapping, replay semantics)
is documented in this section instead.

## 16. Final review readiness

All seven PARTs are complete on this branch:

```text
PART 01  provider result taxonomy + capture adapters          DONE
PART 02  outbound delivery ledger + idempotent repository     DONE
PART 03  template channel widening + intent orchestration     DONE
PART 04  execution + retry engine + dispatcher integration    DONE
PART 05  real EMAIL SMTP adapter (EMAIL_PROVIDER=smtp)        DONE
PART 06  WhatsApp contact/consent + Meta adapter (meta)       DONE
PART 07  Meta callback + delivery feedback                    DONE
```

The chain `Notification Intent → Provider Adapter → Delivery Attempt →
Provider Result → Provider Feedback` is end-to-end runnable with `noop` /
`capture` / `smtp` / `meta` under their respective env discriminators, with
credentials always at adapter/module boundaries, at-most-once execution,
durable bounded retries, immutable attempt history, and full operational-event
audit.

**FINAL REVIEW (2026-08-23):** chain, provider-neutrality, consent rule,
bounded retry/idempotency, scheduler reuse, attempt immutability, secret
boundaries, callback verification, feedback-no-reopen, isolation, and
leakage-redaction items re-verified against the merged PART 01–07 code — no
CR defects found; contract closure applied (OpenAPI: new user-contact route +
`PublicUser`/`NotificationHistoryItem` fields; webhook surface documented in
governance, not `paths`, by design). Migrations 0298–0302 verified
sequential, registered, down-safe, and exercised green through the full
`migrateUp` chain. Remaining known items are intentionally out of CR scope:
deployment secret provisioning (SMTP + Meta credentials), email-feedback
callbacks, and `NOTIFICATION_OUTBOUND_QUEUED` intent wiring (no consistency
defect requires it — intents are observable as PENDING ledger rows).
