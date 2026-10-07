# CR-BE-PUSH-01 — Push Provider Integration — START GOVERNANCE

**Title:** Push Provider Integration (mobile push notification delivery)
**Repository:** `asentra-backend`
**Inspected branch:** `arena/01a0371c-asentra-backend`
**Inspected head:** `3cb05819f4efd0729217d707a585091c609b127d` (= `origin/main`, merge of PR #70)
**Inspection date:** 2026-08-25
**Status:** GOVERNANCE ONLY. No runtime code, no migration file, no OpenAPI change, no
dependency, no infrastructure, no Firebase/APNs project, no credential, no test added or
run, no PR, no merge. **No migration number is consumed by this record.**

---

## Decision summary

CR-BE-PUSH-01 owns exactly one chain and nothing else:

```text
Existing Notification Intent (BE-26D subscription → BE-26B template → BE-26C recipients)
  → Outbound Delivery Ledger, widened with a PUSH channel (CR-BE-NOTIFY-PROV-01 PART 02)
  → Push Provider Adapter (new: FCM behind a thin provider-neutral interface)
  → Per-device Push Attempt record (new: 0241-shaped attempt table)
  → Honest provider result (PROVIDER_ACCEPTED — never "delivered to device")
```

The backend already owns every authority this chain needs **except** a push provider
adapter, a push delivery lifecycle, per-device fan-out, and invalid-token feedback
handling. Registration (BE-25L `mobile_push_tokens`) exists and is deliberately
delivery-free. The safest extension is therefore **additive re-use of the proven
CR-BE-NOTIFY-PROV-01 machinery**, not a new engine:

1. **Reuse** the outbound delivery ledger, its guarded claim, its idempotency key, its
   retry/backoff engine, and its due-job dispatcher slot. Widen the channel CHECK from
   `('EMAIL','WHATSAPP')` to include `'PUSH'`. **No second delivery engine, no queue,
   no cron, no worker.**
2. **Reuse** the adapter pattern proven by `EmailAdapter` / `WhatsAppAdapter`: a
   provider-neutral interface selected by a `PUSH_PROVIDER` discriminator, with
   credential-less `noop` / `capture` adapters as the defaults and the only adapters
   resolvable under `NODE_ENV=test`.
3. **Extend** `mobile_push_tokens` additively (provider discriminator, invalidation
   evidence columns, an `INVALID` status) **without changing the public
   `PushTokenRegistration` response shape**.
4. **Add** one per-device attempt table shaped after `notification_email_deliveries`
   (0241), because push is the first channel where one recipient fans out to N devices.
5. **Reuse** BE-26C recipient resolution + BE-02F/02G building access as the *only*
   isolation authority. **No second RBAC authority is created.**

Not touched: notification foundation (BE-26A), templates (BE-26B), recipient resolution
(BE-26C), subscriptions (BE-26D), IN_APP delivery (BE-26E), email/WhatsApp adapters
(BE-26F/G, NOTIFY-PROV-01 PART 05/06/07), reminders/escalations (BE-26H/I), secure links
(BE-26J), SLA authority, FX/reporting/finance, auth design, chat, marketing, the
notification centre, the Flutter app, and the Web frontend.

**Web Push is OUT OF SCOPE** (§16, R-06). No repository evidence places Web Push in the
frozen contract; the only registration surface is `/mobile/push-tokens` with a platform
CHECK of `ANDROID|IOS`. Adding a browser channel would require a new platform value, a
new token format, VAPID key custody, and a Web frontend change — all outside the reopened
boundary.

**There is one hard in-repo blocker** (§13, B-01): `tests/mobile-push-delivery-boundary-contract.test.ts`
asserts, by design, that everything this CR builds does **not** exist. It must be
*rewritten*, PART by PART, from "PUSH must not exist" into "PUSH exists exactly here" —
never deleted, never weakened silently. §13.1 maps every blocking assertion to the PART
that retires it.

---

## 1. Verified current state

### 1.1 Baseline facts (re-verified at `3cb0581`)

| Fact | Verified value |
|---|---|
| Branch / head | `arena/01a0371c-asentra-backend`, HEAD = `3cb05819f4efd0729217d707a585091c609b127d` |
| `origin/main` | Identical commit — `git rev-parse origin/main` == HEAD; working tree clean |
| Baseline precondition | **CR-BE-FIN-RPT-01 and CR-BE-FX-01 are MERGED/CLOSED** — FX landed as migration `0333` on this baseline |
| Migration registry | `src/database/migrations/` = 335 entries = **333 migrations** + `index.ts` + `types.ts` |
| Highest migration | `0333_create_fx_rate_authority_and_client_fx_policy` |
| **Next free migration number** | **`0334`** — reserved by name only; **not consumed by this record** |
| TypeScript sources | **2,841** `.ts` files under `src/` |
| Modules | **326** directories under `src/modules/` |
| Tests | **440** `tests/*.test.ts` files |
| OpenAPI contract | `docs/api/openapi.yaml`, **47,715** lines |
| Runtime dependencies | `bcryptjs, cors, exceljs, express, helmet, multer, nodemailer, pdf-lib, pg` — **no push/HTTP-client/vendor SDK of any kind** |

### 1.2 Push presence in the repository

| Probe | Result |
|---|---|
| `grep -rniE '(sendPush\|deliverPush\|pushAdapter\|\bfcm\b\|\bapns\b\|firebase\|onesignal\|expo-notifications)' src/` | **0 matches** |
| Push SDK / dependency in `package.json` | **NONE** |
| `web-push` / VAPID anywhere | **NONE** |
| Push modules (`push-delivery`, `mobile-push-delivery`, `push-notifications`) | **NONE** |
| Push migrations | Exactly one: `0235_create_mobile_push_tokens.ts` |
| Push in `NOTIFICATION_CHANNELS` | **NO** — `['IN_APP']` |
| Push in `NOTIFICATION_HISTORY_CHANNELS` | **NO** — `['IN_APP','EMAIL','WHATSAPP']` |
| Push in `OUTBOUND_DELIVERY_CHANNELS` | **NO** — `['EMAIL','WHATSAPP']`, mirrored by the 0298 channel CHECK |
| `PUSH_*` error code | **NONE.** `PUSH_TOKEN` exists only as a 404 `resource.type` string |
| Push in OpenAPI | Registration paths only, plus `x-push-delivery-lifecycle` (stage 4 = `MISSING`) and `x-delivery-channels-missing: [PUSH]` |

**Conclusion: existing push capability = REGISTRATION ONLY. No delivery capability of any
kind exists.** This is not an accident — it is an asserted, documented boundary (§13.1).

### 1.3 What BE-25L actually gives us (`src/modules/push-tokens/`)

Five files: `push-token.{controller,routes,service,types}.ts` + `index.ts`. Mounted from
`src/routes/index.ts` (~line 409) via `createPushTokenRouter()`.

| Route | Auth | Permission | Scope |
|---|---|---|---|
| `POST /mobile/push-tokens` | `authenticationMiddleware` | **none** | self (`user_id` from session, never from body) |
| `GET /mobile/push-tokens` | `authenticationMiddleware` | **none** | self |
| `DELETE /mobile/push-tokens/:tokenId` | `authenticationMiddleware` | **none** | self, owner-only |

Table `mobile_push_tokens` (migration `0235`):

```text
id, user_id → users(id), device_id, push_token, platform CHECK('ANDROID','IOS'),
app_version, device_model, device_os_version,
status CHECK('ACTIVE','INACTIVE') DEFAULT 'ACTIVE',
registered_at, last_seen_at, created_at, updated_at
UNIQUE (user_id, device_id, status)
UNIQUE INDEX (user_id, push_token) WHERE status = 'ACTIVE'
INDEX (user_id, status), INDEX (push_token)
```

Service behaviour verified in `push-token.service.ts`:

- same `(user, deviceId)` re-register → **UPDATE in place** (token rotation, no new row),
- same token arriving on a different device of the same user → old device row set
  `INACTIVE` first (plus a `23505` race-retry path),
- `DELETE` → `status = 'INACTIVE'` (row retained as history),
- `last_seen_at` refreshed on every touch,
- `listPushTokens` returns the **raw `pushToken`** in the public payload.

**Gaps for delivery** (all additive to fix): no `provider`, no `last_success_at`, no
`invalidated_at` / `invalidation_reason`, no `INVALID` status, no environment
discriminator, no attempt table, no adapter, and **no logout / session-revocation /
deactivation hook touches this table today**.

### 1.4 Existing authorities CR-BE-PUSH-01 must extend, never replace

| Authority | Location | Verified shape |
|---|---|---|
| **Outbound delivery ledger** | `notification_outbound_deliveries` (`0298`), `src/modules/notification-outbound-deliveries/` | One row per (channel, recipient, intent). `channel CHECK IN ('EMAIL','WHATSAPP')`; status `PENDING\|SENDING\|SENT\|RETRY_SCHEDULED\|FAILED_PERMANENT\|EXHAUSTED`; `attempt_count`, `max_attempts` (5), `next_retry_at`, `provider`, `provider_message_id`, `last_error`; `UNIQUE (client_id, channel, idempotency_key)`; partial due index on `PENDING\|RETRY_SCHEDULED` |
| **Idempotency** | `outbound-delivery.idempotency.ts` | `sha256(sourceEventType \| sourceEntityId \| channel \| recipientUserId \| templateKey)` |
| **Intent orchestration** | `outbound-delivery-intent.service.ts` | `deliverOutboundNotifications(event, channels)`: BE-26D match → BE-26B render once → BE-26C resolve → one ledger row per (channel, recipient) via `createOnConflictReturn`. Address resolution seam = `resolveOutboundRecipientAddress(channel, userId)` (EMAIL → `users.email` of ACTIVE user; WHATSAPP → consent-gated `users.whatsapp_phone`) |
| **Execution / retry** | `outbound-delivery-execution.service.ts` | `processOutboundDelivery(id, at, adapters?)`: guarded claim → adapter → `recordAttemptHistory` → guarded transition → operational event. Backoff 5 min × 2^(n−1), cap 6 h, ±25 % jitter, max 5 attempts, due limit 100 |
| **Attempt history** | `notification_email_deliveries` (`0241`), `notification_whatsapp_deliveries` (`0242`), linked via `delivery_id` (`0299`) | Immutable append-only per adapter call: recipient snapshot, `template_key`, `status SENT\|FAILED`, `provider`, `provider_reference`, `error_message`, `sent_at` |
| **Post-acceptance feedback** | `0302` | `provider_feedback_status DELIVERED\|BOUNCED\|COMPLAINT\|PROVIDER_FAILED`, `feedback_at`, `feedback_error` — **annotates a SENT delivery and never reopens the send lifecycle** |
| **Runtime driver** | `src/modules/due-job-dispatcher/`, `due-job-scheduler/` | `processDueOperationalJobs()` calls each domain (reminders, escalations, SLA clocks, SLA escalations, **outbound deliveries**, evidence retention, webhooks) under per-seam try/catch, inside `runWithSchedulerContext`. Driven by `setInterval` (`SCHEDULER_ENABLED` / `SCHEDULER_INTERVAL_MS`; off under test) |
| **Recipient resolution** | `src/modules/recipient-resolution/` | `resolveRecipients(specs, scope?)`, kinds USER/ROLE/PERMISSION/WORKFORCE/TEAM/TENANT_PIC/VENDOR_PIC; `RecipientScope { clientId?, buildingIds? }` filtered through `resolveBuildingsForUser` (BE-02F/02G) |
| **Isolation** | `src/modules/context-access/` | `assertBuildingAccess` / `getAccessibleBuildingIds` |
| **Adapter + secret pattern** | `email-delivery/email-adapter.ts`, `whatsapp-delivery/meta-whatsapp-adapter.ts` | Provider-neutral interface + `resolveXAdapter()` discriminator; **credentials read INSIDE the adapter at construction**, never in `AppConfig`, never logged, never persisted; `config.isTest` blocks any credentialed provider |
| **Config façade** | `src/config/env.ts` (`AppConfig` with `email`, `whatsapp`, `scheduler`) + `src/config/index.ts` (lazy getter) | A new config block requires an edit in **both** files + `.env.example`; `.env` is gitignored |
| **Telemetry** | `src/modules/operational-events/` | `recordOperationalEvent(input, executor?, correlation?)`; scrubs `password\|token\|accessToken\|secret\|apiKey\|…`; resolves correlation from the HTTP AsyncLocalStorage context (HTTP wins) |
| **Audit** | `src/modules/audit/` | `AUDIT_EVENT_TYPES` is auth/account-only — **push telemetry does not belong here** |
| **History read model** | `src/modules/notification-history/` | Read-only `UNION ALL` over the three per-channel tables; `NOTIFICATION_HISTORY_CHANNELS = ['IN_APP','EMAIL','WHATSAPP']` |

---

## 2. Boundary reopen

**Reopened — exactly one boundary:** the **external-provider boundary for push
notification delivery**, plus the strictly consequential additive extensions of the
already-governed notification delivery pipeline needed to carry a PUSH channel.

In scope:

- push provider adapter interface + one concrete provider implementation,
- `PUSH` as an additional channel on the existing outbound ledger,
- per-device push attempt evidence,
- additive columns/status on `mobile_push_tokens` for provider + invalidation evidence,
- invalid-token feedback handling and device-lifecycle hooks (logout, revocation,
  deactivation),
- push-specific configuration/secret plumbing at the adapter boundary,
- rewriting the existing push-boundary contract test to guard the *new* boundary,
- OpenAPI/mobile-contract documentation updates that describe the above (PART 05).

Explicitly **NOT** reopened:

| Not in scope | Note |
|---|---|
| Email / WhatsApp / SMS channels | Email is touched **only** if shared notification infrastructure (ledger channel enum, history UNION, shared types) requires compatibility. No email behaviour change. SMS does not exist and is not created |
| Frontend Web / Flutter mobile redesign | Integrate with existing surfaces only. No app-side change is authored here |
| Auth redesign | Existing session/logout/revocation seams are *hooked*, never redesigned |
| Chat, marketing, notification-centre redesign | Untouched |
| FX / reporting / finance | Untouched (frozen at `0333`) |
| Transactional workflow redesign | Untouched |
| Unrelated modules | Untouched |
| Web Push / browser notifications | OUT OF SCOPE — §16 R-06 |
| New RBAC authority | Forbidden — §5 |

Existing backend contracts remain frozen unless narrowly required and explicitly named in
a PART below.

---

## 3. Existing notification architecture (verified)

```text
domain event
  │
  ├─ IN_APP  ─ deliverInAppNotifications (BE-26E) ─→ notifications table ─→ inbox API
  │
  └─ OUTBOUND ─ deliverOutboundNotifications (PART 03)
        │  BE-26D subscriptions → BE-26B template rendered ONCE → BE-26C recipients
        │  → notification_outbound_deliveries (one row per channel × recipient)
        │
        └─ due-job dispatcher → processDueOutboundDeliveries
              → guarded claim (PENDING|RETRY_SCHEDULED → SENDING)
              → resolveEmailAdapter() / resolveWhatsAppAdapter()
              → attempt row (0241 / 0242, linked by delivery_id)
              → markSent | markFailedRetryable(next_retry_at) | markFailedPermanent | EXHAUSTED
              → recordOperationalEvent(NOTIFICATION_OUTBOUND_*)
              → [0302] async provider feedback annotates, never reopens
```

Read side: `notification_history` is a read-only `UNION ALL` over `notifications`,
`notification_email_deliveries`, `notification_whatsapp_deliveries`.

**Where PUSH plugs in — one insertion point per layer, all additive:**

| Layer | Change |
|---|---|
| Channel vocabulary | `OUTBOUND_DELIVERY_CHANNELS += 'PUSH'` + widen the 0298 channel CHECK |
| Address resolution | `resolveOutboundRecipientAddress` gains a PUSH branch — but see §4.2: push resolves to *N device tokens*, not one address |
| Adapter resolution | `resolvePushAdapter()` alongside the two existing resolvers |
| Attempt evidence | new `notification_push_deliveries` (per **device**, not per recipient) |
| History | extend the UNION + `NOTIFICATION_HISTORY_CHANNELS` (PART 05) |
| Telemetry | reuse `NOTIFICATION_OUTBOUND_*` event vocabulary with `channel: 'PUSH'` |

---

## 4. Mobile / backend integration evidence

Verified evidence that a mobile client already registers tokens and consumes
notifications:

- `docs/api/mobile-contract.md` **§7j** documents all three BE-25L routes, the
  rotation/duplicate rules, `registeredAt`/`lastSeenAt`, `ACTIVE`/`INACTIVE`, and states
  *"No delivery engine — notification delivery is BE-26; this is registration metadata
  only."*
- `docs/api/mobile-integration-handoff.md` line 248 lists
  `POST /mobile/push-tokens — device push token registration`.
- `docs/api/openapi.yaml` publishes `registerPushToken`, `listPushTokens`,
  `deactivatePushToken` with `x-recipient-scoped: true`, **no** `x-required-permission`,
  and a description containing the literal phrase *"registration is NOT delivery"*.
- The mobile surface today spans 14 `/mobile/*` route families (`/mobile/assignments`,
  `/mobile/sync`, `/mobile/current-shift`, `/mobile/evidence`, `/mobile/qr/resolve/…`,
  `/mobile/diagnostics`, `/mobile/app-version/…`, `/mobile/my-team`,
  `/mobile/verification/…`, `/mobile/push-tokens`, …).
- In-app notifications are read via `GET /notifications`, `GET /notifications/:id`,
  `PATCH /notifications/:id/read` — self-scoped, no create endpoint.
- `tests/mobile-push-token.test.ts` (379 lines, **in CI**) freezes 10 registration
  behaviours: full contract, multi-device, same-device rotation, token-moves-device
  replacement, 400 validation, 401 anonymous, self-scoped list, owner-only deactivate,
  re-register after deactivation, tokenId validation.

**Reading:** the mobile app is already wired to *register* and to *read the in-app
inbox*. It is not wired to receive a push, and the backend has never sent one. Nothing in
the mobile contract needs redesign — CR-BE-PUSH-01 makes the already-registered token
*useful*, and the only mobile-facing contract change is documentation (PART 05).

---

## 5. Provider decision

### 5.1 Options evaluated

| Option | Assessment |
|---|---|
| **A. Direct FCM only** (no abstraction) | Smallest code, but violates the repository's established provider-neutral pattern (`EmailAdapter`, `WhatsAppAdapter`) and makes the test path require credentials. **Rejected.** |
| **B. Direct APNs + direct FCM** (two adapters) | Two credential custody models (APNs `.p8` key + key id + team id **and** FCM service account), two token formats, two failure taxonomies, two retry classifications — roughly double the surface for zero capability gain today. **Rejected as premature.** |
| **C. Thin abstraction + FCM as the single first implementation** | Matches the existing adapter precedent exactly; one credential model; FCM delivers to **both** Android and iOS (FCM relays to APNs server-side); leaves a clean seam for a future direct-APNs adapter without redesign. **SELECTED.** |

### 5.2 Decision

**Provider architecture = thin provider-neutral abstraction, FCM as the single first
concrete implementation. iOS is served through FCM's APNs relay. No direct APNs adapter
is built by this CR.**

Justification for the iOS choice: the platform CHECK is `ANDROID|IOS`, the client is a
single Flutter app targeting both, and FCM's cross-platform delivery is precisely the
case where one adapter is smaller than two. A future `PUSH_PROVIDER=apns` adapter can be
added behind the same interface if a direct APNs path is ever required — that is a
separate CR, not a gap in this one.

```ts
// src/modules/push-delivery/push-adapter.ts  (shape only — PART 02 authors it)
export type PushSendInput = {
  /** Opaque provider device token (never logged in full). */
  token: string;
  platform: 'ANDROID' | 'IOS';
  title: string;
  body: string | null;
  /** Minimal, non-sensitive routing data only — see §9. */
  data: Record<string, string>;
};

export type PushSendResult = {
  status: 'SENT' | 'FAILED';
  providerMessageId?: string | null;
  error?: string | null;
  /** Transient-failure hint for the retry engine. */
  retryable?: boolean;
  /** TRUE only for provider codes that prove the token is dead (§8). */
  tokenInvalid?: boolean;
  sentAt: Date;
};

export interface PushAdapter {
  readonly provider: string;
  send(input: PushSendInput): Promise<PushSendResult>;
}
```

`tokenInvalid` is the one field the email/WhatsApp results do not have; it exists because
push is the only channel whose *address* is issued by the provider and revoked by the
provider.

### 5.3 Adapters shipped

| `PUSH_PROVIDER` | Adapter | Credentials | Resolvable under `NODE_ENV=test` |
|---|---|---|---|
| `noop` (default) | never contacts anything; synthetic reference | none | **yes** |
| `capture` | records every send input in memory for deterministic assertions | none | **yes** |
| `fcm` | real FCM HTTP v1 send | service-account credentials read inside the adapter | **no — `ConfigError`** |

This mirrors `resolveEmailAdapter()` exactly, including the `config.isTest` fail-fast
branch. Transport: FCM HTTP v1 over `fetch` (Node 20 global) — **no vendor SDK
dependency is added** unless PART 02 proves OAuth2 service-account signing cannot be done
with `node:crypto` alone; if a dependency is genuinely required, it is an explicit,
separately-justified PART 02 decision, not an assumption made here.

---

## 6. Device registration authority

**`mobile_push_tokens` (BE-25L) remains the single device-token authority. No second
token table, no token duplication into the ledger, no token stored in a notification
row.**

Additive changes only (PART 01, migration `0334`):

| Column / change | Purpose | Public exposure |
|---|---|---|
| `provider TEXT` | which provider issued/accepts this token (`fcm`) | **NOT** exposed in `PushTokenRegistration` (§13.1 B-01c) |
| `last_success_at TIMESTAMPTZ` | last provider-accepted send | not exposed |
| `last_failure_at TIMESTAMPTZ` | last failed send | not exposed |
| `consecutive_failure_count INTEGER NOT NULL DEFAULT 0` | stale detection | not exposed |
| `invalidated_at TIMESTAMPTZ` | when the provider declared the token dead | not exposed |
| `invalidation_reason TEXT` | sanitized provider reason (bounded ≤ 200) | not exposed |
| `status` CHECK widened to `('ACTIVE','INACTIVE','INVALID')` | distinguishes *user unregistered* from *provider rejected* | status is already exposed; the new value is additive |

Why `INVALID` is a distinct status and not just `INACTIVE`: `INACTIVE` means *the user or
the app deliberately unregistered*; `INVALID` means *the provider rejected the token*.
Collapsing them destroys the evidence needed to explain "why did this device stop getting
notifications", and it breaks the existing partial unique index semantics that already
carry meaning for `ACTIVE`.

Index consequence: the existing `UNIQUE (user_id, device_id, status)` and the partial
`UNIQUE (user_id, push_token) WHERE status='ACTIVE'` both keep working, because `INVALID`
rows are simply non-`ACTIVE`. PART 01 verifies this explicitly (an `INVALID` row must not
block re-registration of the same device).

---

## 7. Token lifecycle (complete matrix)

Every case below is a governed requirement for PART 01 / PART 04. "Registration path"
means the behaviour is already implemented by BE-25L and is only *verified*, not changed.

| # | Case | Governed behaviour |
|---|---|---|
| 1 | **First registration** | INSERT `ACTIVE` (existing path). `provider` set from the resolved adapter discriminator |
| 2 | **Token refresh (provider-initiated)** | App re-POSTs with the same `deviceId` → UPDATE in place (existing rotation path). Failure counters reset to 0; `invalidated_at`/`invalidation_reason` cleared |
| 3 | **Same installation, new token** | Identical to #2 — `deviceId` is the identity, the token is the value |
| 4 | **Multi-device** | N `ACTIVE` rows per user, one per `deviceId`. Delivery fans out to **all** ACTIVE rows (§10) |
| 5 | **Logout** | `POST /auth/logout` → `revokeSessionById` **must additionally deactivate the calling device's ACTIVE token** (device identified by the request's `deviceId`, not by guessing). Sets `INACTIVE`. PART 04 |
| 6 | **Session revocation** | `revokeActiveSessionsForUser(userId)` → deactivate **all** ACTIVE tokens for that user. PART 04 |
| 7 | **Account disablement** | `user-lifecycle.service.ts:39` already calls `revokeActiveSessionsForUser`; #6 therefore covers it. Additionally, delivery **must skip** users whose status is not `ACTIVE` — mirroring `resolveOutboundRecipientAddress`'s existing `status = 'ACTIVE'` guard |
| 8 | **Device replacement** | Same token appearing on a new `deviceId` → old device row `INACTIVE` (existing path, verified by `tests/mobile-push-token.test.ts`) |
| 9 | **Uninstall / invalid token** | Detected only via provider feedback (`tokenInvalid`) — there is no uninstall signal. → `INVALID` (§8) |
| 10 | **Client / Building reassignment** | **No token change.** Tokens are user-scoped; the *recipient set* is recomputed per event by BE-26C against current access. A reassigned user simply stops matching. **Never mutate tokens on reassignment** — that would create a second isolation authority |
| 11 | **Duplicate token** | Same user: forbidden by the partial unique index (existing). Across *different users*: the index does not cover it — PART 01 governs it as *last registration wins*, deactivating the other user's row, because a device token that moved to another account must never receive the previous account's notifications. This is a genuine isolation risk and is an explicit PART 01 test |
| 12 | **Stale cleanup** | **No destructive delete, ever.** A row with `consecutive_failure_count ≥ N` or `last_seen_at` older than a configured window is marked `INACTIVE` with reason. Rows are retained as evidence. Cleanup rides the existing due-job dispatcher if implemented at all; PART 04 may defer it and record the deferral |
| 13 | **Re-registration after INACTIVE/INVALID** | Always allowed — a fresh POST creates/reactivates the `ACTIVE` row (existing test: "re-register after deactivation") |

---

## 8. Invalid-token handling

Trigger: the provider returns a code that **proves** the token is permanently
unusable — for FCM, `UNREGISTERED` (HTTP 404) and `INVALID_ARGUMENT` on the token field
(HTTP 400). Nothing else counts. `UNAVAILABLE` (503), `INTERNAL` (500), and quota errors
(429) are **transient**, never invalidation.

Governed behaviour:

1. Mark the device row `status = 'INVALID'`, set `invalidated_at = now()`,
   `invalidation_reason = <sanitized provider code>`.
2. **Retain the row.** No `DELETE`. No column blanking. The token value stays for
   forensic linkage to attempt rows.
3. **Allow immediate re-registration** — a subsequent POST for the same `deviceId`
   returns the row to `ACTIVE` and clears the invalidation fields.
4. The *ledger delivery* for that recipient is **not** failed because one device died:
   the per-device attempt row records `FAILED` + `INVALID_TOKEN`, and the delivery
   outcome follows the §10 fan-out rule.
5. Emit one operational event (`NOTIFICATION_PUSH_TOKEN_INVALIDATED`) with the device id
   and reason — **never the token value**.

---

## 9. Minimal payload contract

The push payload is a **notification pointer, not a data channel.**

Allowed fields:

| Field | Source | Bound |
|---|---|---|
| `title` | rendered BE-26B template subject/title | ≤ 100 chars |
| `body` | rendered template body, truncated | ≤ 240 chars |
| `data.notificationId` | the BE-26A notification id (if one exists) | uuid |
| `data.entityType` | `sourceEntityType` from the intent | ≤ 64 |
| `data.entityId` | `sourceEntityId` from the intent | uuid |
| `data.eventType` | `sourceEventType` | ≤ 128 |
| `data.deliveryId` | ledger row id (correlation) | uuid |

**Forbidden in the payload, without exception:** monetary amounts, invoice/PO/quotation
figures, salary or payroll data, tenant financial data, credentials, tokens, secure-link
tokens, session identifiers, personal contact details (email/phone), evidence file
contents or signed URLs, any FX/finance figure, and any free-text field not produced by
an approved template.

Rationale: push payloads traverse Google/Apple infrastructure, are cached on-device
outside app control, and are visible on lock screens. The app is expected to **fetch
authoritative content over the authenticated API** using `data.entityId` — the push only
tells it *what changed*. PART 03 enforces the allow-list in code (an explicit whitelist
builder, not a spread of the intent metadata).

---

## 10. Recipient / isolation model and delivery pipeline

### 10.1 Isolation

- Recipients are resolved **only** by BE-26C `resolveRecipients(specs, scope)` with
  `RecipientScope { clientId, buildingIds }`, which already filters through
  `resolveBuildingsForUser` (BE-02F/02G).
- Tokens are **user-scoped**; isolation is therefore *inherited* from the resolved
  recipient set and is **never re-derived** from a token, a device, or a client id
  carried in a payload.
- **No new permission code, no new RBAC check, no `requirePermission` on any push
  route.** The registration routes stay self-scoped and permission-free (asserted today
  by the boundary test, and that assertion is *kept*).
- `client_id` / `building_id` on a push delivery come from the **ledger row** (which the
  intent seam already populates), never from the device.

### 10.2 Pipeline and the cardinality decision

The ledger is *one row per recipient*; push is *one recipient → N devices*. Three shapes
were considered:

| Shape | Verdict |
|---|---|
| One ledger row per **device** | Breaks the idempotency key (which is recipient-based), makes the same notification appear N times in history, and couples the ledger to device churn. **Rejected.** |
| A parallel push-only engine | Explicitly forbidden by the CR. **Rejected.** |
| **One ledger row per recipient + N per-device attempt rows** | Keeps idempotency, history, retry, and dispatcher semantics identical to email/WhatsApp; fan-out lives entirely inside the PUSH adapter step. **SELECTED.** |

Consequences, governed:

- `recipient_address` on a PUSH ledger row is **not** a token. It is the stable literal
  `user:<userId>` (a device-count-independent recipient reference). No token is ever
  written to the ledger.
- Fan-out happens inside `processOutboundDelivery` for `channel = 'PUSH'`: load ACTIVE
  devices for the recipient, call the adapter once per device, write one attempt row per
  device.
- **Ledger outcome rule:** `SENT` if **at least one** device was accepted;
  `FAILED_RETRYABLE` if none were accepted and at least one failure was transient;
  `FAILED_PERMANENT` if the recipient has **zero** ACTIVE devices or every failure was
  permanent/invalid. A recipient with no devices is a permanent, non-retryable, *expected*
  outcome — it must never consume five retries.

---

## 11. Retry, idempotency and honest delivery semantics

### 11.1 States — and what they are allowed to mean

| State | Meaning | Persisted where |
|---|---|---|
| `QUEUED` | intent exists, nothing attempted (`PENDING` on the ledger) | ledger |
| `SENT_TO_PROVIDER` | the adapter call was issued | attempt row (in-flight) |
| `PROVIDER_ACCEPTED` | the provider returned success for this device (`SENT` on ledger / attempt) | ledger + attempt |
| `FAILED_RETRYABLE` | transient failure; `next_retry_at` scheduled (`RETRY_SCHEDULED`) | ledger + attempt |
| `FAILED_FINAL` | permanent failure or attempts exhausted (`FAILED_PERMANENT` / `EXHAUSTED`) | ledger + attempt |

**Forbidden states:** `DELIVERED_TO_DEVICE`, `DISPLAYED`, `READ`, `SEEN`, or any wording
implying the notification reached or was seen by a human. FCM acceptance means *the
provider queued it* — nothing more. No API field, no OpenAPI description, no operational
event summary, and no history row may claim otherwise. This is the same discipline
already enforced by `0302` (feedback annotates, never reopens) and by the existing
"registration is NOT delivery" rule; CR-BE-PUSH-01 extends it to "acceptance is NOT
delivery".

### 11.2 Idempotency

Unchanged authority: `sha256(sourceEventType|sourceEntityId|channel|recipientUserId|templateKey)`
with `UNIQUE (client_id, channel, idempotency_key)`. Because `channel` is part of the key,
adding `PUSH` **cannot collide** with existing EMAIL/WHATSAPP rows. A replayed intent
inserts nothing and returns the existing row — zero extra pushes.

Per-device idempotency inside one execution is provided by the guarded claim: only the
claim winner performs adapter calls, so a device can never be pushed twice for the same
ledger row in the same pass.

### 11.3 Retry

Reuse `computeOutboundRetryDelayMs` verbatim: 5 min × 2^(attempt−1), cap 6 h, ±25 %
jitter, `max_attempts = 5`, due-batch limit 100. **No push-specific retry engine, no
push-specific backoff constants.**

Retry classification (FCM):

| Provider outcome | Classification |
|---|---|
| HTTP 200 | `PROVIDER_ACCEPTED` |
| 429, 500, 503, network timeout | `FAILED_RETRYABLE` |
| 401 / 403 (credential or auth problem) | `FAILED_FINAL` — never retried, and alarming: it means configuration is broken |
| 404 `UNREGISTERED`, 400 invalid-token | `FAILED_FINAL` for that device **+ token invalidation** (§8) |
| Unclassified | `FAILED_RETRYABLE` (conservative, matching the WhatsApp adapter's precedent) |

**Retry never re-pushes a device that already succeeded in an earlier attempt of the same
ledger row.** A retry pass targets only devices with no accepted attempt row for that
delivery.

---

## 12. Preferences, configuration, telemetry, offline behaviour, API and migrations

### 12.1 Preference behaviour

**Verified fact: no notification-preference module, table, column, or endpoint exists
anywhere in the repository** (`grep -rn preference src/` → nothing in the notification
domain).

**Decision: CR-BE-PUSH-01 creates NO preference system.** Suppression authority today is
BE-26D subscriptions (ACTIVE/INACTIVE, per event type, per client/building) plus device
registration itself — a user who does not register a device receives no push, and a user
who unregisters stops receiving pushes. That is the honest, existing, per-user opt-out.
A real per-user per-channel preference model is a **separate CR** (recorded in §16 as
D-03). Inventing one here would be a notification-centre redesign, which the boundary
forbids.

### 12.2 Secrets / configuration

| Item | Rule |
|---|---|
| `PUSH_PROVIDER` | non-secret discriminator → `AppConfig.push.provider` in **both** `src/config/env.ts` and `src/config/index.ts`; documented in `.env.example` with value `noop` |
| FCM service-account credentials (project id, client email, private key) | read **inside** `FcmPushAdapter`'s constructor via `process.env`; **never** on `AppConfig`, never returned, never logged, never persisted in any business table, never committed. `.env` is already gitignored |
| Test environment | `config.isTest` ⇒ only `noop` / `capture` resolve; any other value throws `ConfigError`. Identical to `resolveEmailAdapter` |
| Credential provisioning | **Out of scope for this CR** — deployment concern, recorded as an open item (§16 D-01) |

### 12.3 Audit vs delivery telemetry

- **Audit (`AUDIT_EVENT_TYPES`) stays auth/account-only.** No push event is added to the
  audit vocabulary. Verified: the enum contains only auth/account concerns.
- **All push telemetry goes to `recordOperationalEvent`**, which already scrubs
  `password|token|accessToken|secret|apiKey|…` and resolves correlation from the HTTP
  AsyncLocalStorage context (HTTP wins; SCHEDULER/SYSTEM only outside HTTP).
- Event vocabulary: reuse `NOTIFICATION_OUTBOUND_SENT / _FAILED_RETRYABLE /
  _FAILED_PERMANENT / _EXHAUSTED` with `metadata.channel = 'PUSH'`, plus exactly one new
  type — `NOTIFICATION_PUSH_TOKEN_INVALIDATED`.
- **Never in an event, a log line, or an error column:** the push token (log a
  device id and a truncated fingerprint at most), provider credentials, or payload body
  text beyond what the template already published.

### 12.4 Observability

Per delivery: `channel`, `provider`, `attemptCount`, `templateKey`, `deviceCount`,
`acceptedCount`, `failedCount`, sanitized `error`. Per device attempt: one immutable
attempt row. Correlation id flows from the dispatcher's `runWithSchedulerContext`, exactly
as email/WhatsApp do today. **No new logging framework, no metrics dependency.**

### 12.5 Offline / recovery behaviour

**Push is never a prerequisite for correctness.** Governed invariants:

- Every push-eligible notification **must** also exist through an authoritative
  non-push surface (the BE-26A in-app inbox and/or an outbound channel). Push is a
  redundant nudge.
- A device that is offline, uninstalled, or invalid causes **no** business-state change:
  no task, approval, SLA clock, or workflow may block on a push outcome.
- The app recovers state by **polling the authenticated API** (`GET /notifications`,
  `/mobile/sync`, `/mobile/assignments`) — never by replaying pushes. No push replay
  mechanism is built.
- Missed pushes are not resent on reconnect; the inbox is the recovery path.

### 12.6 API decision

**Verified route conventions:** mobile surfaces live under `/mobile/*` (14 families);
notification reads live at `/notifications` and `/notification-history`; the existing push
paths are exactly `/mobile/push-tokens` and `/mobile/push-tokens/{tokenId}`.

**Decision: CR-BE-PUSH-01 adds ZERO new API routes.** No send endpoint, no test-push
endpoint, no admin push console, no push-status endpoint. Push delivery is triggered by
domain events through the existing intent seam and drained by the existing dispatcher —
exactly like email and WhatsApp, neither of which has a send route. The only public
surface changes are documentary (PART 05): the `x-push-delivery-lifecycle` block, the
`x-delivery-channels-missing`/`-implemented` markers, the history `channel` enum, and the
"registration is NOT delivery" description, all of which must be rewritten to describe
reality once it exists. **No path is invented.**

### 12.7 Migration decision

- Verified highest migration: **`0333_create_fx_rate_authority_and_client_fx_policy`**.
- **Next free number: `0334`.** **No migration file is created by this record.**
- Reserved minimum (three files, consumed only when their PART executes):

| Number | Name | PART |
|---|---|---|
| `0334` | `extend_mobile_push_tokens_for_delivery` (additive columns + widened status CHECK) | PART 01 |
| `0335` | `widen_outbound_delivery_channels_for_push` (channel CHECK replacement) | PART 03 |
| `0336` | `create_notification_push_deliveries` (per-device attempt table + `delivery_id` linkage) | PART 03 |

If a PART lands and the numbers have moved, the PART takes the then-current next free
numbers in the same order. Each must be appended to the ordered registry array in
`src/database/migrations/index.ts` (`migration0334…`) and must be `down`-safe.

Proposed shape of `notification_push_deliveries` (0241-shaped, per device):

```text
id, client_id → clients, building_id → buildings NULL,
recipient_user_id → users, push_token_id → mobile_push_tokens,
device_id, platform, template_key → notification_templates NULL,
title, body, status CHECK ('SENT','FAILED'),
provider, provider_reference, error_message, error_code,
sent_at, delivery_id → notification_outbound_deliveries NULL,
created_at
```

Bounded like 0298: `title ≤ 200`, `body ≤ 500`, `error_message ≤ 500`. **No token value
column** — the token is reachable through `push_token_id`.

---

## 13. Blockers and the failure taxonomy

### 13.1 B-01 — the boundary contract test (HARD BLOCKER)

`tests/mobile-push-delivery-boundary-contract.test.ts` (CR-BE-MOB-01 PART 07) is an
in-repo, authoritative guard that asserts push delivery **must not exist**. It is
currently **not listed in any CI gate** (125 of 440 suites are unlisted — see
`docs/CR-BE-CI-01_DEFERRED_CI_DEBT.md`), but it is in the repository and **must be treated
as authoritative**: no PART may leave it stale, and no PART may delete it. It is
*rewritten*, assertion by assertion, into a guard of the new boundary.

| # | Assertion in the test | What it blocks | Retired / rewritten by |
|---|---|---|---|
| B-01a | stage 3 `status === 'PARTIAL'`, `missingChannels === ['PUSH']`, `implementedChannels === NOTIFICATION_HISTORY_CHANNELS` | adding PUSH to history/attempt channels | **PART 05** |
| B-01b | stage 4 `status === 'MISSING'` and `operationIds === []` | the existence of any provider stage | **PART 05** |
| B-01c | `PushTokenRegistration` must NOT expose `delivered\|deliveredAt\|deliveryStatus\|sentAt\|lastNotificationAt\|provider` | exposing `provider`/`lastSuccessAt` publicly | **KEPT AS IS** — §6 deliberately keeps all new columns out of the public shape. The assertion stays green and is *retained* as a permanent guard |
| B-01d | `NOTIFICATION_CHANNELS` deep-equals `['IN_APP']` | adding PUSH to the notification-record channel | **KEPT AS IS** — a push is a *delivery*, not a notification record. `notifications.channel` stays `IN_APP` |
| B-01e | `NOTIFICATION_HISTORY_CHANNELS` deep-equals `['IN_APP','EMAIL','WHATSAPP']`; PUSH absent from `NotificationHistoryItem.channel`, the history `channel` query enum, and `x-delivery-channels-implemented` | surfacing push in history | **PART 05** (extend UNION + enums + spec together) |
| B-01f | push route allow-list is exactly the 3 BE-25L routes; documented push paths exactly `/mobile/push-tokens`, `/mobile/push-tokens/{tokenId}` | any new push route | **KEPT AS IS** — §12.6 adds no route. Permanent guard |
| B-01g | `src/modules/{push-delivery,mobile-push-delivery,push-notifications}` must not exist | the adapter module | **PART 02** (rewritten to require `src/modules/push-delivery` and forbid the other two) |
| B-01h | push migrations must be exactly `['0235_create_mobile_push_tokens.ts']` | migrations 0334/0336 | **PART 01** (extend to the governed list), **PART 03** (final list) |
| B-01i | regex ban across all of `src/modules/**/*.ts`: `/(sendPush\|deliverPush\|pushAdapter\|\bfcm\b\|\bapns\b\|firebase\|onesignal\|expo-notifications)/i` — **including comments** | literally every line of the adapter | **PART 02** (narrowed to: these terms may appear only under `src/modules/push-delivery/`) |
| B-01j | dependency ban `/firebase\|fcm\|apn\|onesignal\|expo/i` in `package.json` | a vendor SDK | **KEPT unless PART 02 proves a dependency is unavoidable**; §5.3 targets zero new dependencies |
| B-01k | `push-token.service.ts` executable code must not match `\b(send\|deliver\|notify\|dispatch)[A-Za-z]*\s*\(` nor `push_deliveries\|notification_deliveries` | putting delivery in the token service | **KEPT AS IS** — delivery lives in `push-delivery`, never in `push-tokens`. Permanent guard |
| B-01l | token op description must match `/registration is NOT delivery/i` | rewording the OpenAPI description | **PART 05** — reworded to an equally honest statement (registration remains not-delivery; acceptance remains not-delivery) and the assertion updated to the new phrase |
| B-01m | `x-recipient-scoped: true`, `x-required-permission` undefined, no `requirePermission` on push routers | adding RBAC to push routes | **KEPT AS IS** — §10.1 forbids a second RBAC authority. Permanent guard |

**Governance rule:** a PART that changes behaviour guarded by a row above **must** update
that assertion in the same PART. Leaving the suite red, or deleting the file, is a CR
defect.

Related: `tests/mobile-push-token.test.ts` (10 cases, **in CI**) must stay green
unchanged through PART 01 — the additive columns must not alter any registration
behaviour or response shape.

### 13.2 Failure taxonomy

| Class | Examples | Ledger effect | Device effect | Retry |
|---|---|---|---|---|
| **Configuration** | missing/invalid credentials, unresolvable `PUSH_PROVIDER`, 401/403 | `FAILED_PERMANENT` | none | never |
| **Transient provider** | 429, 500, 503, timeout, DNS/network | `FAILED_RETRYABLE` | `last_failure_at`, counter++ | yes, bounded |
| **Invalid token** | 404 `UNREGISTERED`, 400 invalid token | per-device permanent | → `INVALID` (§8) | never for that device |
| **Payload rejected** | oversize, malformed data key | `FAILED_PERMANENT` | none | never — it is a code defect, must alarm |
| **No devices** | recipient has zero ACTIVE tokens | `FAILED_PERMANENT` with an explicit reason | none | never |
| **Recipient ineligible** | user not `ACTIVE` | skipped at intent time (counted as `recipientsSkipped`) | none | n/a |
| **Unclassified** | anything else | `FAILED_RETRYABLE` (conservative) | counter++ | yes, bounded |

New error code required: **exactly one** — `PUSH_DELIVERY_NOT_FOUND` (only if a read seam
is ever exposed; PART 03 may conclude none is needed and add nothing). No `PUSH_*` code
exists today.

---

## 14. Test strategy

Harness: the repository's existing `tsx --test` + `tests/*.test.ts` + embedded Postgres
(`ASENTRA_USE_EMBEDDED_POSTGRES=true`, per-suite `DB_PORT`/`DATA_DIR`) under
`NODE_ENV=test`.

**Absolute rule: no real push is ever sent. No test may resolve a credentialed provider —
`config.isTest` makes that a `ConfigError`.**

| PART | Focus |
|---|---|
| 01 | additive migration up/down; `INVALID` status coexists with both unique constraints; re-registration after `INVALID`; **`tests/mobile-push-token.test.ts` green unchanged**; response shape unchanged |
| 02 | adapter interface + `noop`/`capture` behaviour; taxonomy mapping for every provider outcome incl. `tokenInvalid`; `resolvePushAdapter` fail-fast under test for `fcm`; **no credential appears in any result, log, or error** |
| 03 | intent creates one PUSH ledger row per recipient; fan-out produces one attempt row per ACTIVE device; zero-device recipient → permanent, non-retryable; payload allow-list rejects a forbidden key; idempotent replay creates nothing |
| 04 | retryable failure schedules `next_retry_at`; a later pass re-attempts only unaccepted devices; exhaustion → `EXHAUSTED`; invalid token → `INVALID` + retained row + re-registration works; logout/revocation deactivate tokens |
| 05 | rewritten boundary-contract suite (§13.1); OpenAPI/history enum consistency; mobile-contract text matches code; cross-module regression (email/WhatsApp/IN_APP behaviour byte-identical) |
| 06 | full-chain regression with `capture`; isolation regression (no cross-client/building leak); add the new suites **and** `tests/mobile-push-delivery-boundary-contract.test.ts` to a CI gate in `.github/workflows/ci.yml` |

**Never:** broad repo-wide test runs, real provider traffic, an active scheduler under
`NODE_ENV=test`, or validation requiring production data.

---

## 15. PART breakdown (frozen)

```text
PART 01 — Push Device Registration Foundation
PART 02 — Provider Adapter & Secure Configuration
PART 03 — Notification → Push Delivery Integration
PART 04 — Retry, Invalid Token & Delivery Evidence
PART 05 — Mobile Contract, OpenAPI & Cross-Module Safety
PART 06 — Closure, Regression & Backend Final Freeze
```

**PART 01 — Push Device Registration Foundation.**
Migration `0334`: additive columns on `mobile_push_tokens` (`provider`,
`last_success_at`, `last_failure_at`, `consecutive_failure_count`, `invalidated_at`,
`invalidation_reason`) + status CHECK widened to include `INVALID`. Repository accessors
for "ACTIVE devices of user X" and for the invalidation/success transitions. **No public
response-shape change**, no route change, no adapter, no delivery. Update B-01h.
Verify `tests/mobile-push-token.test.ts` unchanged and green.

**PART 02 — Provider Adapter & Secure Configuration.**
New module `src/modules/push-delivery/`: `PushAdapter` interface, `NoopPushAdapter`,
`CapturePushAdapter`, `FcmPushAdapter` (credentials read inside the constructor),
`resolvePushAdapter()` with the `config.isTest` fail-fast. `AppConfig.push.provider` added
to **both** `src/config/env.ts` and `src/config/index.ts`; `.env.example` documents
`PUSH_PROVIDER=noop`. Failure taxonomy mapping. Update B-01g and B-01i (narrow the regex
ban to "outside `src/modules/push-delivery/` only"). **No wiring into delivery yet.**

**PART 03 — Notification → Push Delivery Integration.**
Migration `0335` (widen the outbound channel CHECK) + `0336` (`notification_push_deliveries`).
`OUTBOUND_DELIVERY_CHANNELS += 'PUSH'`. PUSH branch in `resolveOutboundRecipientAddress`
(`user:<userId>`, ACTIVE-user guard). PUSH branch in `processOutboundDelivery`: device
fan-out, per-device attempt rows, the §10.2 ledger outcome rule. Payload allow-list
builder (§9). End-to-end runnable on `noop`/`capture` only. Final B-01h list.

**PART 04 — Retry, Invalid Token & Delivery Evidence.**
Invalid-token handling (§8) incl. the `NOTIFICATION_PUSH_TOKEN_INVALIDATED` operational
event. Retry semantics: never re-push an already-accepted device; zero-device → permanent.
Lifecycle hooks: logout deactivates the calling device; `revokeActiveSessionsForUser`
deactivates all of the user's tokens. Stale-device marking (or an explicit, recorded
deferral). Telemetry fields (§12.4).

**PART 05 — Mobile Contract, OpenAPI & Cross-Module Safety.**
Rewrite `x-push-delivery-lifecycle` stages 3 and 4 to reflect reality; flip
`x-delivery-channels-missing: [PUSH]` → `x-delivery-channels-implemented`; extend
`NOTIFICATION_HISTORY_CHANNELS`, the history UNION, and the history `channel` query enum;
update `docs/api/mobile-contract.md` §7j and the handoff doc; reword the "registration is
NOT delivery" description honestly and add "acceptance is NOT delivery". **Rewrite
`tests/mobile-push-delivery-boundary-contract.test.ts`** per §13.1 — retiring B-01a,
B-01b, B-01e, B-01l and *keeping* B-01c, B-01d, B-01f, B-01k, B-01m. Cross-module
regression: email/WhatsApp/IN_APP unchanged.

**PART 06 — Closure, Regression & Backend Final Freeze.**
Full-chain regression on `capture`; isolation regression; secret-leakage sweep (no token,
no credential in any log, event, error column, or API response); confirm no push route was
added; append the new suites **and** the boundary suite to a CI gate in
`.github/workflows/ci.yml`; write §17 implementation notes + a final-review section into
this document; record remaining out-of-scope items (credential provisioning, Web Push,
preferences, direct APNs).

**Rules:** PARTs are executed one at a time, in order, each a complete deliverable. Do not
combine PARTs. PART 03 must not start before 01 and 02. No PART opens a PR or merges
without explicit instruction.

---

## 16. Blockers, open decisions and what was NOT done

### 16.1 Blockers

| Id | Blocker | Status |
|---|---|---|
| **B-01** | `tests/mobile-push-delivery-boundary-contract.test.ts` forbids the entire CR (§13.1) | **Resolvable inside the CR** — mapped PART by PART. Not an external blocker |
| **B-02** | No FCM project, service account, or credentials exist | **Blocks only the `fcm` adapter path at runtime.** PART 02 ships the adapter with `noop` as default; real credentials are a deployment task |
| **B-03** | `tests/mobile-push-delivery-boundary-contract.test.ts` and 124 other suites are absent from every CI gate | **STILL OPEN after PART 06 (§26.13)** — the gate additions were prepared but could not be committed: the GitHub App lacks `workflows` permission to modify `.github/workflows/ci.yml`. Blocked on repository permissions, not on code. The wider debt (`CR-BE-CI-01`) remains out of scope |

### 16.2 Open decisions (recorded, not assumed)

| Id | Decision | Owner |
|---|---|---|
| **D-01** | FCM credential provisioning + which environments enable `PUSH_PROVIDER=fcm` | Deployment / operations, outside this CR |
| **D-02** | Whether OAuth2 service-account signing for FCM HTTP v1 can be done with `node:crypto` alone, or whether one dependency is genuinely unavoidable (B-01j) | PART 02, with explicit justification |
| **D-03** | A real per-user, per-channel notification preference model | **Separate CR.** Not created here (§12.1) |
| **D-04** | Stale-device cleanup thresholds (`consecutive_failure_count`, `last_seen_at` window) | PART 04 — may defer with an explicit record |
| **D-05** | Direct APNs adapter | Not needed; a future CR if ever required (§5.2) |
| **D-06** | Whether the ledger needs a `deviceCount`/`acceptedCount` summary column or whether attempt-row aggregation suffices | PART 03 — prefer no new column |

### 16.3 Web Push

**OUT OF SCOPE.** No repository evidence places Web Push in the frozen contract: the only
push registration surface is `/mobile/push-tokens`, its platform CHECK is
`ANDROID|IOS`, no VAPID/`web-push`/service-worker artefact exists anywhere in `src/`,
`tests/`, `package.json`, or the OpenAPI contract, and `docs/api/mobile-contract.md` §7j
describes the surface as mobile-device registration. Adding it would require a new
platform value, a distinct subscription object shape, VAPID key custody, and a Web
frontend change — all outside the reopened boundary.

### 16.4 What was NOT done at START GOVERNANCE

- No runtime code, no module, no adapter, no route, no permission seed.
- No migration file; **no migration number consumed** (`0334` reserved by name only).
- No OpenAPI change, no mobile-contract change, no test added, no test run.
- No dependency added, no `npm ci`, no infrastructure, no Firebase/APNs project, no
  credential created or referenced.
- No CI change.
- No PR created, no merge. **STOP after START GOVERNANCE.**

---

## 17. PART 01 readiness

**PART 01 is READY TO START.** It is unblocked by anything external:

- target table, columns, constraints, and index consequences are fully specified (§6),
- the migration number is identified (`0334`) and the registry append pattern is verified,
- the lifecycle matrix it must satisfy is frozen (§7),
- the only contract assertion it touches is B-01h, and the required edit is named,
- the regression it must not break (`tests/mobile-push-token.test.ts`, 10 cases, in CI) is
  identified,
- it requires **no** provider, **no** credential, **no** dependency, and **no** decision
  from D-01…D-06.

Entry condition for PART 01: an explicit instruction to execute PART 01. Nothing else is
outstanding.

---

## 18. PART 01 — Push Device Registration Foundation — IMPLEMENTATION NOTES

**Status:** IMPLEMENTED. **Baseline:** `392a8347fce7781497a66ee0580ec4096f150fee`
(this document at START GOVERNANCE). **Branch:** `arena/01a0371c-asentra-backend`.
**Scope executed:** PART 01 only — device registration hardening. **No provider, no
adapter, no delivery, no FCM/APNs, no queue, no worker, no OpenAPI change, no new route.**

### 18.1 Migration

One migration, the governance-reserved number, additive only:
`src/database/migrations/0334_extend_mobile_push_tokens_for_delivery.ts`, registered last
in `src/database/migrations/index.ts`.

- **Columns added** to the existing `mobile_push_tokens` (§6): `provider TEXT`,
  `last_success_at TIMESTAMPTZ`, `last_failure_at TIMESTAMPTZ`,
  `consecutive_failure_count INTEGER NOT NULL DEFAULT 0`, `invalidated_at TIMESTAMPTZ`,
  `invalidation_reason TEXT`. All nullable except the counter, all **internal**.
- **CHECKs added**: `consecutive_failure_count >= 0`; `invalidation_reason` ≤ 200 chars;
  `status <> 'INVALID' OR invalidated_at IS NOT NULL` — an invalidation without
  provenance is not evidence.
- **Status CHECK widened** to `('ACTIVE','INACTIVE','INVALID')`. `INACTIVE` = the user or
  the app unregistered; `INVALID` = the provider declared the registration unusable.
- **Uniqueness re-expressed as the frozen semantics** (deviation from the §6 prediction
  that the 0235 constructs would keep working, with the reason recorded):
  - `UNIQUE (user_id, device_id, status)` **replaced** by partial index
    `mobile_push_tokens_user_device_active_idx (user_id, device_id) WHERE status='ACTIVE'`.
    The table constraint permitted only **one row per status value**, so a device that is
    deactivated twice — or deactivated and later invalidated — collides on its *history*
    rows. Because history must be retained (§7 #12, no destructive cleanup), the
    constraint could not survive real lifecycle traffic.
  - Partial `UNIQUE (user_id, push_token) WHERE status='ACTIVE'` **replaced** by the
    **global** `mobile_push_tokens_token_active_idx (push_token) WHERE status='ACTIVE'`.
    A user-scoped index cannot express §7 #11; one provider token silently ACTIVE for two
    accounts is an isolation defect.
- **No `CREATE TABLE`. No delivery-attempt history on the token row. No `DELETE`, no
  `TRUNCATE`, no `DROP TABLE`.** Pre-existing cross-owner duplicates are normalised by
  demoting the older ACTIVE rows to `INACTIVE` (rows and provenance retained).
- **`down`** restores the 0235 shape non-destructively: `INVALID` → `INACTIVE`, original
  index/constraint re-created, columns dropped. It never deletes rows to succeed.

### 18.2 Token model changes

`src/modules/push-tokens/push-token.types.ts`:

- `PUSH_TOKEN_STATUSES = ['ACTIVE','INACTIVE','INVALID']`.
- `PushTokenRecord` gains the six internal fields above.
- **`PublicPushToken` is deliberately unchanged — exactly 13 keys** (id, userId, deviceId,
  pushToken, platform, appVersion, deviceModel, deviceOsVersion, status, registeredAt,
  lastSeenAt, createdAt, updatedAt), carrying an explicit "deliberately unchanged" note.

`src/modules/push-tokens/push-token.service.ts` — rewritten around a shared `ROW_COLUMNS`
projection. Public surface unchanged (`toPublicPushToken`, `validateRegisterInput`,
`registerPushToken`, `deactivatePushToken`, `listPushTokens`). New **internal** seams,
re-exported from `src/modules/push-tokens/index.ts` and reachable from **no route or
controller**: `listActivePushTokensForUser`, `findPushTokenById`, `recordPushTokenSuccess`,
`recordPushTokenFailure`, `invalidatePushToken`.

### 18.3 Lifecycle implemented (§7 matrix)

| # | Case | Implemented behaviour |
|---|---|---|
| 1 | First registration | INSERT `ACTIVE`; `provider` stays `NULL` (nothing is assumed) |
| 2/3 | Refresh / same installation, new token | UPDATE in place on the ACTIVE `(user, device)` row; `registered_at` preserved; `consecutive_failure_count → 0`; `invalidated_at`/`invalidation_reason` cleared |
| 4 | Multi-device | N ACTIVE rows, one per `deviceId`; installations are never collapsed |
| 8/11 | Token moved to another device or account | **Retire-then-rotate**: the global ACTIVE row holding that token is set `INACTIVE` first, then the caller's device row is rotated or inserted. Last valid registration wins; the superseded row is retained. A `23505` race takes the same path and retries |
| ACTIVE→INACTIVE | Unregister (`DELETE /:tokenId`) | Owner-scoped UPDATE to `INACTIVE`; the row is kept |
| ACTIVE→INVALID | `invalidatePushToken(id, reason)` | ACTIVE-only transition (§18.4) |
| 13 | Re-registration after INACTIVE/INVALID | A fresh POST creates a new ACTIVE row; the historical rows are untouched |
| 5/6/7 | Logout / session revocation / account disablement | **Deferred to PART 04 as governed** — PART 01 adds no hook into `revokeSessionById` / `revokeActiveSessionsForUser` |
| 10 | Client/Building reassignment | No token mutation — unchanged, by design |
| 12 | Stale cleanup | Not implemented (PART 04); the evidence columns it needs now exist |

`findActiveByToken` is the module's only cross-user read. It is not user-scoped **on
purpose** (a provider token identifies a handset, not an account), returns nothing to any
caller-facing surface, and exists solely to retire the stale registration.

### 18.4 Invalid-token readiness

`invalidatePushToken(id, reason)` implements §8 items 1–3:

- ACTIVE-only (`WHERE id = $1 AND status = 'ACTIVE'`); an unknown or already-retired row
  returns `null`, so a first invalidation reason is **never overwritten**.
- Sets `status='INVALID'`, stamps `invalidated_at`, stores a whitespace-collapsed reason
  bounded to 200 chars, and rejects a blank reason with a validation error.
- **Retains everything**: token value, `registered_at`, device metadata, counters. No
  `DELETE`, no column blanking.
- An INVALID row is never returned by `listActivePushTokensForUser`, and never blocks
  re-registration of the same installation.
- §8 items 4–5 (attempt rows, the `NOTIFICATION_PUSH_TOKEN_INVALIDATED` operational event)
  belong to PART 03/04 and are **not** implemented here. Nothing calls
  `invalidatePushToken` in production code yet — provider feedback arrives in PART 04 —
  so **no client can observe `INVALID` through the API**, which is why the published
  `PushTokenRegistration.status` enum stays truthful at `[ACTIVE, INACTIVE]`.

`recordPushTokenSuccess` / `recordPushTokenFailure` stamp the timestamps and maintain the
consecutive-failure streak. **A failure never changes status** — only provider-proven
invalidation retires a device.

### 18.5 Duplicate safety and multi-device

- One ACTIVE registration per `(user_id, device_id)`; unlimited retained history.
- One ACTIVE registration per `push_token` **globally** — enforced in the database, not
  only in application code. Verified by test: after a cross-user handover exactly one
  ACTIVE row remains, owned by the newest registrant, with the superseded row retained.
- Multiple simultaneous ACTIVE devices per user are preserved; `deviceId` is the identity
  and the token is the value.

### 18.6 Ownership and isolation

Unchanged and re-verified: `authenticationMiddleware` only, self-service only, `userId`
taken from `req.auth.userId` and never from the body. `deactivatePushToken` is owner-scoped
**in the service**, not merely in the route (cross-user DELETE → `404 NOT_FOUND`; the
service returns `null` for a non-owner). `listPushTokens` is user-scoped, so Client/Building
isolation is preserved by the existing user/session authority — **no second RBAC authority**.
No admin cross-user token management exists. Possession of a push token is not a
credential: presenting one as a bearer token yields `401`.

### 18.7 API impact

**None.** Three routes as before (`POST`/`GET /mobile/push-tokens`,
`DELETE /mobile/push-tokens/:tokenId`), same request shape, same 13-key response, same
status codes. `docs/api/openapi.yaml` is **untouched** — no `provider`, no delivery field,
no widened status enum. No delivery, provider or test-send endpoint was added.

### 18.8 Boundary contract

`tests/mobile-push-delivery-boundary-contract.test.ts` was **edited, not deleted** — one
assertion retired, exactly as §13.1 predicted:

- **Retired:** B-01h (`adds no push delivery module, adapter or migration`) — its push
  migration allow-list is now the exact sorted pair
  `['0235_create_mobile_push_tokens.ts', '0334_extend_mobile_push_tokens_for_delivery.ts']`,
  **plus a new, stricter guard**: migration 0334 must contain no `CREATE TABLE`.
- **Retained and still green:** B-01c (no `delivered`/`deliveredAt`/`deliveryStatus`/
  `sentAt`/`lastNotificationAt`/`provider` on `PushTokenRegistration`), B-01d
  (`NOTIFICATION_CHANNELS == ['IN_APP']`), B-01e, B-01f (3 routes, 2 OpenAPI paths), B-01g
  and B-01i (vendor/provider regex bans), B-01j, B-01k, B-01m, the platform-enum equality
  and the "registration is NOT delivery" description.
- **Still scheduled:** B-01a/b/e/l → PART 05; B-01g/B-01i narrowing → PART 02.

Permanent guards are intact: no provider delivery, no FCM/APNs dependency, no parallel
queue, no web push, no provider credentials, no delivery worker.

### 18.9 Tests

New focused suite: **`tests/push01-part01-device-registration-foundation.test.ts`**
(embedded-postgres harness, `DB_PORT = 55513`), 5 groups:

1. migration 0334 additivity — registered once and last, `down` present, no
   `CREATE TABLE`/`DELETE`/`TRUNCATE`, columns present and nullable, status CHECK covers
   the three states and invents none, both partial unique indexes exist and the token
   index carries no `user_id`;
2. lifecycle — first registration, refresh resetting the failure streak while preserving
   `registeredAt`, multi-device, token moved between own devices, cross-user handover,
   unregister retaining the row;
3. INVALID — provenance retained, not an active target, not re-retirable, reason never
   overwritten, re-registration after INVALID, blank reason rejected, reason bounded,
   counters invisible publicly;
4. ownership — self-only list, cross-user DELETE 404 + service-level owner scoping, 401
   anonymous, push token rejected as a bearer credential;
5. response safety — exact 13-key shape, forbidden keys absent, the `toPublicPushToken`
   mapper does not copy internal fields, only three routes, no route/controller reference
   to the internal transitions, `PushTokenRegistration` unchanged, no push module/adapter/
   vendor dependency, boundary contract still asserts its retained strings and exactly two
   push migrations exist.

`tests/mobile-push-token.test.ts` (10 cases, in CI) is **unchanged**; every behaviour it
asserts is preserved by construction.

### 18.10 Validation — RUN / NOT RUN

| Check | Result |
|---|---|
| `git diff --check` (whitespace/conflict markers) | **RUN — clean** |
| Static verification of the module, migration and contract (delivery verbs, delivery table names, vendor regex, retained boundary assertion strings, mapper/route/controller shape) via `node -e` probes | **RUN — clean** |
| `tests/push01-part01-device-registration-foundation.test.ts` | **NOT RUN** |
| `tests/mobile-push-token.test.ts` (regression) | **NOT RUN** |
| `tests/mobile-push-delivery-boundary-contract.test.ts` | **NOT RUN** |
| TypeScript typecheck (`tsc --noEmit`) | **NOT RUN** |
| Broad regression / CI | **NOT RUN** (out of scope) |

**Reason for every NOT RUN:** `node_modules/` in this workspace is empty (0 entries) and
dependency installation is forbidden by the standing constraints, so `tsx`, `node --test`,
`typescript`, `supertest`, `yaml` and `embedded-postgres` are unavailable. No provisioning
of PostgreSQL was performed. **A skipped check is recorded as NOT RUN and is never
reported as PASS.** The three suites and the typecheck must be executed in an environment
with dependencies installed before PART 02 is closed.

### 18.11 PART 02 readiness

**PART 02 (Provider Adapter & Secure Configuration) is READY TO START**, unblocked by
PART 01:

- the device authority now carries `provider`, the success/failure evidence and the
  `INVALID` lifecycle an adapter will report against;
- `recordPushTokenSuccess` / `recordPushTokenFailure` / `invalidatePushToken` are the
  stable internal seams PART 03/04 will call — no further token-table migration is
  expected for them;
- `listActivePushTokensForUser` is the fan-out read PART 03 needs;
- B-01g and B-01i are the only boundary assertions PART 02 must narrow, and §15 already
  names the required edit;
- PART 02 still requires **no credential** — `noop`/`capture` remain the defaults, and
  D-01 (FCM credential provisioning) stays a deployment matter, not a code blocker.

Carried forward, unchanged: §7 #5/#6/#7 lifecycle hooks and §7 #12 stale marking are
PART 04; the `NOTIFICATION_PUSH_TOKEN_INVALIDATED` event is PART 04; OpenAPI/mobile-contract
wording is PART 05; the CI gate for the new suites is PART 06.

---

## 19. PART 02 IMPLEMENTATION NOTES — Provider Adapter & Secure Configuration

**Status: IMPLEMENTED.** PART 02 introduces the push provider abstraction, the real
Firebase Cloud Messaging (HTTP v1) adapter, and the secure configuration boundary. It
adds **no route, no migration, no database access, no queue, no worker and no
dependency**. Nothing in the running application calls the adapter yet — PART 02 delivers
a **dormant, fully tested seam** that PART 03 will wire into the outbound delivery
pipeline.

### 19.1 Provider decision

`PUSH_PROVIDER` selects exactly one adapter:

| Discriminator | Adapter | Credentials | Contacts a provider |
| --- | --- | --- | --- |
| `noop` (**default**) | `NoopPushAdapter` | none | no |
| `capture` | `CapturePushAdapter` | none | no |
| `fcm` | `FcmPushAdapter` | `PUSH_FCM_*` | yes |

**FCM is the single provider (§5.2).** Android is served natively; **iOS is served through
FCM's server-side APNs relay** — there is no direct APNs adapter, no `.p8` key, and
therefore no second credential custody model. OneSignal, Expo and browser Web Push /
VAPID remain OUT OF SCOPE (D-02) and are actively banned by the boundary contract inside
the new module itself.

### 19.2 Dependency decision — zero new dependencies

`package.json` and `package-lock.json` are **unchanged**. Governance §5.3 permits the FCM
HTTP v1 REST API over the built-in `fetch` unless service-account OAuth2 proves
impossible with `node:crypto` alone; it does not. The adapter therefore:

- builds the RS256 service-account assertion with `createSign('RSA-SHA256')`,
- exchanges it for an access token at `https://oauth2.googleapis.com/token`
  (`urn:ietf:params:oauth:grant-type:jwt-bearer`, scope
  `https://www.googleapis.com/auth/firebase.messaging`) and caches it until 60s before
  expiry,
- posts to `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`.

No Firebase Admin SDK, no `google-auth-library`, no vendor object anywhere. Boundary
assertion B-01j (push vendor dependency ban) stays green **unmodified**.

### 19.3 Files added

| File | Contents |
| --- | --- |
| `src/modules/push-delivery/push-adapter.ts` | `PushAdapter` interface, `PushSendInput` / `PushSendResult`, the `PUSH_ERROR_CODES` vocabulary, the `PUSH_DELIVERY_OUTCOMES` taxonomy + `classifyPushResult` / `isRetryablePushOutcome`, defensive `validatePushPayload`, `pushTokenFingerprint`, `NoopPushAdapter`, `CapturePushAdapter`, `resolvePushAdapter()` |
| `src/modules/push-delivery/fcm-push-adapter.ts` | `readFcmPushConfig` (credential boundary), `normalizeFcmPrivateKey`, `buildFcmAssertion`, injectable `FcmHttpTransport` + `createFetchFcmTransport`, `parseFcmErrorBody`, `classifyFcmError`, `sanitizeFcmError`, `FcmPushAdapter` |
| `src/modules/push-delivery/index.ts` | Module barrel (the only export surface other code may import) |
| `tests/push01-part02-provider-adapter.test.ts` | 41 DB-free, network-free tests |

Modified: `src/config/env.ts`, `src/config/index.ts`, `.env.example`, `.gitignore`,
`tests/mobile-push-delivery-boundary-contract.test.ts`.

### 19.4 Secure configuration boundary (§12.2)

`AppConfig.push` contains **exactly one field: `provider`**. `src/config/env.ts` reads
only `PUSH_PROVIDER`; it never reads a credential, so no FCM secret can reach the config
object, a config dump, a log line or an error snapshot. This mirrors the existing
`EmailConfig` / `WhatsAppConfig` precedent.

All credentials are read **inside the adapter module**, at construction, by
`readFcmPushConfig(env = process.env)`:

- required: `PUSH_FCM_PROJECT_ID`, `PUSH_FCM_CLIENT_EMAIL`, `PUSH_FCM_PRIVATE_KEY`;
- optional endpoint overrides (sandbox/mock only): `PUSH_FCM_API_BASE_URL`,
  `PUSH_FCM_TOKEN_URI`;
- `PUSH_FCM_PRIVATE_KEY` accepts a one-line PEM with escaped `\n`; the unescaping happens
  **only** at this seam and nowhere else;
- a missing or non-PEM value raises `ConfigError` naming the **field**, never the value.

Egress protection: `sanitizeFcmError` strips PEM blocks, `Bearer`/`Basic` headers, `ya29.`
access tokens and `key=`/`secret=`/`assertion=`-style fragments, then truncates to 500
characters. `pushTokenFingerprint` (`abcd…yz(len:N)`) is the only representation of a
device token that may appear in a log, a capture record or an error. A raw device token
never appears in a `PushSendResult`.

`.gitignore` now also blocks `*service-account*.json`, `*serviceAccount*.json` and
`*firebase-adminsdk*.json` so the Google service-account file cannot be committed by
accident. `.env.example` documents every key with blank values only.

### 19.5 Fail-closed resolution

`resolvePushAdapter()`:

1. `noop` / `capture` resolve unconditionally (they read no credential);
2. **in `NODE_ENV=test`, any other provider throws `ConfigError`** — a test run can never
   send a real push, even if `PUSH_FCM_*` happens to be populated in the shell;
3. `fcm` outside test constructs `FcmPushAdapter`, whose constructor validates the
   credentials and **throws** if they are missing or malformed — it never degrades to a
   silent no-op;
4. an unknown discriminator throws `ConfigError` listing the available providers — there
   is **no fallback** to a different provider and no implicit real-delivery path.

### 19.6 Normalized result contract

No caller ever sees an FCM string, HTTP status or SDK object. `PushSendResult` carries
`status` (`SENT` | `FAILED`), `provider`, `providerMessageId`, sanitized `error`,
`errorCode` from a fixed 8-value vocabulary, `retryable`, `tokenInvalid`, `deliveryId`
and `sentAt`. `classifyPushResult` reduces that to the four outcomes PART 03/04 branch
on: `ACCEPTED`, `REJECTED_RETRYABLE`, `REJECTED_PERMANENT`, `INVALID_TOKEN`.

**Deviation recorded:** PART 02 defines a push-specific outcome vocabulary rather than
reusing `src/shared/provider-result.ts`. The shared set has no `INVALID_TOKEN` member —
push is the only channel whose address is issued *and revoked by the provider*, and that
distinction is the whole point of §8. Collapsing it into the shared `ERROR_UNKNOWN`
would erase the signal PART 04 needs. The shared module is untouched, and PART 03 maps
the push outcome onto the ledger status when it writes the delivery row.

`SENT` means **provider acceptance only** — never handset display or read (§3).

### 19.7 FCM error mapping (§8, §13.2)

The canonical code is taken from the `google.firebase.fcm.v1.FcmError` detail, falling
back to `error.status`, then to the HTTP status.

| FCM condition | `errorCode` | Retryable | `tokenInvalid` |
| --- | --- | --- | --- |
| `UNREGISTERED` (404) | `INVALID_TOKEN` | no | **yes** |
| `INVALID_ARGUMENT` (400) **with a `message.token` field violation** | `INVALID_TOKEN` | no | **yes** |
| `INVALID_ARGUMENT` (400) otherwise / ambiguous | `INVALID_REQUEST` | no | no |
| `SENDER_ID_MISMATCH` (403) | `AUTHENTICATION_FAILED` | no | no |
| `THIRD_PARTY_AUTH_ERROR` (401) | `AUTHENTICATION_FAILED` | no | no |
| `PERMISSION_DENIED` / `UNAUTHENTICATED` | `AUTHENTICATION_FAILED` | no | no |
| `QUOTA_EXCEEDED` (429) | `RATE_LIMITED` | yes | no |
| `UNAVAILABLE` (503) / `INTERNAL` (500) | `PROVIDER_UNAVAILABLE` | yes | no |
| transport failure / timeout / abort | `NETWORK_ERROR` | yes | no |
| anything unclassified | `UNKNOWN_ERROR` | yes | no |

Two deliberate conservatisms:

- **`INVALID_ARGUMENT` does not blanket-invalidate a device.** The code covers oversized
  payloads, reserved data keys and bad TTLs just as often as bad tokens; a payload defect
  must never destroy a user's registration. Only an explicit token-field violation
  qualifies.
- **`SENDER_ID_MISMATCH` is a configuration fault, not a dead token.** The token belongs
  to another Firebase sender, which means *our* project is wrong; blaming the device
  would hide a misconfiguration behind mass invalidation.

Unclassified failures are retryable, bounded later by the PART 04 attempt budget, so a
send is never silently lost.

### 19.8 Defensive payload bounds (§9)

PART 03 owns the payload allow-list; the adapter is the last line of defence and enforces
bounds only: title ≤100, body ≤240, token ≤512 (the BE-25L column width), ≤12 data keys,
key ≤64, value ≤256, total data ≤2048 bytes (well under FCM's 4096-byte limit), and a
rejection of provider-reserved keys (`from`, `gcm`, `notification`, `google*`,
`message_type`, `collapse_key`). A violation returns `PAYLOAD_INVALID` **before any
request is issued** — the failure is deterministic and costs no provider call. The
adapter never enriches, never spreads metadata, and never invents content.

### 19.9 Side-effect boundary

The adapter classifies and returns. It performs **no** database access, **no**
`mobile_push_tokens` write, **no** ledger write, **no** audit or telemetry event and
**no** retry scheduling. When FCM proves a token is dead the adapter sets
`tokenInvalid: true` and stops; the `INVALID` transition via `invalidatePushToken` (a
PART 01 seam) is **PART 04's** job. This is asserted mechanically by the boundary
contract, not merely documented.

Nothing imports `src/modules/push-delivery` yet — verified by grep. The seam is dormant
until PART 03.

### 19.10 Boundary contract — retired and retained

**Narrowed (2 assertions, exactly as §15 predicted):**

- **B-01g** `adds no push delivery module, adapter or migration` → split. The
  module-directory ban is replaced by `keeps push provider code inside the one governed
  module`, which now *requires* `src/modules/push-delivery` to exist and adds **four new
  guards**: no `*.routes.ts` / `*.controller.ts` / `*.repository.ts` in the module, no
  database access (`getPool`, `withTransaction`, `query(`, `PoolClient`), no token/ledger
  state (`mobile_push_tokens`, `invalidatePushToken`,
  `notification_outbound_deliveries`), and no scheduler/retry machinery
  (`setInterval`, `nextRetryAt`, `scheduleRetry`, `attemptCount`, `backoff`). A parallel
  push module (`mobile-push-delivery`, `push-notifications`) is still banned. The
  migration half moved unchanged into its own `adds no push delivery migration` test.
- **B-01i** `integrates no push vendor or provider SDK` → narrowed to
  `…outside the governed module`. The original regex still applies **byte-for-byte to
  every other module**; only `src/modules/push-delivery/` is exempt, and inside that
  exemption a second regex bans `onesignal`, `expo-notifications`, `node-apn`,
  `web-push`, `vapid`, `applicationServerKey` and direct `http2.connect` APNs usage in
  executable code.

**Net effect: the suite gained guards.** Two assertions were relaxed at exactly one path
and six new ones were added at that same path.

**Retained unchanged:** migration allow-list (`0235` + `0334`, still no push delivery
table); the `package.json` push vendor dependency ban; the 3-route / 2-OpenAPI-path
guard; `NOTIFICATION_CHANNELS == ['IN_APP']`; `NOTIFICATION_HISTORY_CHANNELS ==
['IN_APP','EMAIL','WHATSAPP']` with `x-delivery-channels-missing: ['PUSH']`;
PROVIDER_DELIVERY `MISSING` / `operationIds: []`; DELIVERY_ATTEMPT `PARTIAL`; the
"token service has no send path" grep; the anonymous-401 checks; the
`PushTokenRegistration` forbidden-field guard; the `x-recipient-scoped` guard.
`OUTBOUND_DELIVERY_CHANNELS` remains `['EMAIL','WHATSAPP']` — PART 03 owns widening it.

### 19.11 Tests

`tests/push01-part02-provider-adapter.test.ts` — **41 tests, 8 suites**, deliberately
DB-free and network-free (the FCM transport and the access-token provider are injected;
a throwaway RSA key pair is generated in-process, so no real credential exists). Coverage:
the frozen error-code and outcome vocabularies; outcome classification and retryability;
token fingerprinting; every payload bound and reserved key; both credential-less
adapters including all simulated failure branches; capture never storing a raw token;
payload rejection costing zero provider requests; all six resolution cases including the
test-environment refusal and both fail-closed paths; credentials absent from `AppConfig`;
`ConfigError` naming fields not values; escaped-newline PEM normalization; error
redaction and truncation; RS256 assertion claims verified against the public key; FCM
envelope parsing including `BadRequest` field violations; the full error-mapping table;
HTTP-status fallback; and the send path (wire shape, Android vs the iOS APNs-relay block,
provider message id, `UNREGISTERED` → `tokenInvalid` with no DB touch, throttling/outage
vs config fault, transport failure, token-exchange failure without leaking the assertion,
access-token caching, and a 2xx with an unparsable body).

### 19.12 Validation

`node_modules` is empty and dependency installation is forbidden by the standing
constraints, so the project harness (`tsx`, `supertest`, `yaml`, `embedded-postgres`,
`typescript`) is unavailable. Node v22 type-stripping was used to execute what could be
executed without installing anything.

| Check | Result |
| --- | --- |
| `tests/push01-part02-provider-adapter.test.ts` (Node 22 `--experimental-strip-types --test`) | **PASS — 41/41**, 0 fail |
| `tests/config.test.ts` (same harness) | **PASS — 23/23**, 0 fail (config change is non-breaking) |
| Syntax check of all changed `.ts` files (`node --check`) | **PASS** |
| Boundary assertions edited in this PART, re-executed standalone (B-01g narrowed, B-01i narrowed) | **PASS** |
| Boundary assertions at risk of regression, re-executed standalone (migration allow-list, dependency ban, token-service send-path grep) | **PASS** |
| Grep: no importer of `src/modules/push-delivery` outside the module | **PASS** (dormant seam) |
| Grep: `package.json` / `package-lock.json` unchanged | **PASS** |
| `git diff --check` | **PASS** |
| Full boundary contract suite `tests/mobile-push-delivery-boundary-contract.test.ts` | **NOT RUN** — needs `yaml` + `supertest` |
| `tests/mobile-push-token.test.ts`, `tests/push01-part01-*.test.ts` | **NOT RUN** — need PostgreSQL + `embedded-postgres` |
| `npm test` (full suite) | **NOT RUN** — dependencies unavailable |
| `tsc --noEmit` typecheck | **NOT RUN** — no TypeScript compiler present (type-stripping does **not** typecheck) |

**A skipped check is recorded as NOT RUN and is never reported as PASS.** The full
boundary suite, the PART 01 database suites and a real `tsc --noEmit` must be executed in
an environment with dependencies installed before PART 02 is closed.

### 19.13 PART 03 readiness

**PART 03 (Outbound PUSH Channel) is READY TO START.** It receives from PART 02:

- `resolvePushAdapter()` — the single, fail-closed entry point to the provider;
- `PushSendInput` / `PushSendResult` / `classifyPushResult` — the normalized contract to
  record against the ledger;
- `PUSH_ERROR_CODES` and the `tokenInvalid` flag — the inputs to PART 04's invalidation;
- `CapturePushAdapter` — deterministic, credential-less fan-out assertions for PART 03's
  own tests;
- `validatePushPayload` — the defensive floor beneath PART 03's §9 allow-list builder.

Unchanged deferrals: PART 03 owns migration `0335` (widen the channel CHECK), `0336`
(`notification_push_deliveries`), the `resolveOutboundRecipientAddress` PUSH branch
(`user:<userId>`), device fan-out and widening `OUTBOUND_DELIVERY_CHANNELS`. PART 04 owns
retry execution, `invalidatePushToken` wiring, logout hooks, stale marking and
`NOTIFICATION_PUSH_TOKEN_INVALIDATED`. PART 05 owns OpenAPI / mobile-contract wording and
the B-01a/b/e/l rewrite. PART 06 owns the CI gate. D-01 (FCM credential provisioning)
remains a deployment matter and still blocks nothing in code — `noop` stays the default.

---

## 20. PART 03 completion notes (03A / 03B / 03C, validated by 03D)

**Status: PART 03 COMPLETE.** PUSH is a first-class outbound channel carried by the
existing ledger, intent and execution pipeline. No parallel queue, worker, scheduler or
public send endpoint was introduced, and no new error code was added.

### 20.1 What each sub-part delivered

- **03A — channel + ledger foundation.** `OUTBOUND_DELIVERY_CHANNELS` and the intent
  service's `OUTBOUND_CHANNELS` widened to include `PUSH`; migration `0335` DROPs and
  re-ADDs the `0298` channel CHECK as `('EMAIL','WHATSAPP','PUSH')` (`down` deletes PUSH
  rows first). `resolveOutboundRecipientAddress` resolves `user:<userId>` for ACTIVE
  recipients only, and `subject` stays null for PUSH. Notification *template* channels
  are untouched.
- **03B — fan-out + payload.** `resolvePushFanoutPlan()` expands one ledger row into the
  recipient's ACTIVE device set (`listActivePushTokensForUser`, ordered
  `registered_at DESC, id`), reporting `NO_REGISTRATIONS` / `NO_ACTIVE_REGISTRATIONS`
  distinctly. The payload is pointer-only per §9: `title`, `body` and a string→string
  `data` map, identical for every device of a recipient.
- **03C — provider invocation + attempt evidence.** `executePushFanout()` is the ONLY
  seam that invokes the provider, and only through the port alias
  (`resolvePushDeliveryPort` / `PushDeliveryPort`), resolved once per ledger row.
  Migration `0336` creates `notification_push_deliveries`; one immutable evidence row is
  written per provider call.

### 20.2 Invariants re-verified in 03D

- **One logical delivery per recipient.** N devices produce N attempt rows but exactly
  ONE ledger row; the §10.2 rollup is any-ACCEPTED → `SENT`, else any-transient →
  retryable, else permanent (zero ACTIVE devices is permanent, with a reason).
- **Idempotency and concurrency unchanged.** `channel` remains inside the sha256 key and
  the `UNIQUE (client_id, channel, idempotency_key)` index; `claimDelivery` still runs
  `FOR UPDATE SKIP LOCKED` and still precedes any provider call.
- **Retry policy untouched.** PUSH parks in `RETRY_SCHEDULED` / `FAILED_PERMANENT` via the
  same engine and constants as EMAIL.
- **`INVALID_TOKEN` is evidence only.** No token row is mutated; `invalidatePushToken()`
  is deliberately not called (PART 04 owns it).
- **EMAIL and WHATSAPP are behaviourally unchanged** — verified by comparing both
  resolver bodies against the pre-PART-03 baseline with comments stripped: byte-identical.
  Only a stale WHATSAPP doc comment was corrected to match the consent-gated
  `users.whatsapp_phone` query that CR-BE-NOTIFY-PROV-01 PART 06 had already shipped.
- **Boundary guard B-01i is byte-for-byte unchanged.** Vendor vocabulary stays inside
  `src/modules/push-delivery/`; callers use the neutral aliases. Its exemption list was
  never widened.

### 20.3 Defects found and fixed during 03D review

1. **Credential leak into attempt evidence (production defect).** A provider error that
   was *thrown* escaped the adapter's internal classification — and therefore its
   redaction — so a bearer token or API key embedded in the message was persisted
   verbatim into `notification_push_deliveries.error_message`. The dispatcher now scrubs
   thrown messages through `sanitizeProviderError` (a vendor-neutral alias of the
   adapter's redactor) before they become evidence. Covered by a regression test that was
   confirmed to fail without the fix.
2. **Inverted database guard silently disabling 32 tests (test defect).**
   `skipIfNoTestDatabase(t)` returns a truthy config when Postgres IS available, so
   `if (await skipIfNoTestDatabase(t)) return;` skipped every body precisely when the
   database worked — while still reporting `ok`. All 32 occurrences across the three PART
   03 suites now use `if (!(await skipIfNoTestDatabase(t))) return;`, matching the
   repository's existing idiom.
3. **Fixture and assertion errors unmasked by (2).** The suites truncated
   `notification_templates` without re-seeding, violating the `template_key` FK;
   `createOnConflictReturn` returns `{ record, created }` and needed destructuring; and
   two ledger assertions used non-existent statuses (`PENDING` / `FAILED`) instead of
   `RETRY_SCHEDULED` / `FAILED_PERMANENT`.

**Lesson carried forward:** a green suite is not evidence that its assertions ran. Verify
that a new negative test fails when its fix is removed.

### 20.4 Validation

Focused PART 01–03 set — 13 suites, 52 sub-suites: **214 pass / 0 fail / 0 skipped**
(0 skipped confirms the DB-backed bodies genuinely executed). `tsc --noEmit` reports the
22 pre-existing repository errors and no new ones. `git diff --check` is clean.

### 20.5 PART 04 readiness

PART 04 inherits a working PUSH pipeline plus the per-device evidence it needs to act on:
`notification_push_deliveries` rows carry `error_code` (including `INVALID_TOKEN`) and the
`push_token_id` of the offending registration, so token invalidation, logout hooks, stale
marking and `NOTIFICATION_PUSH_TOKEN_INVALIDATED` can be driven from recorded facts
without re-contacting the provider.

---

## 21. PART 04A completion notes — invalid-token lifecycle

### 21.1 What landed

One new module, `src/modules/push-tokens/push-token-invalidation.service.ts`, exposing
`reconcileInvalidTokenEvidence(deliveryId)`. It reads the PART 03C evidence rows for a
delivery and retires exactly the registrations the provider already proved are dead. The
PART 01 authority `invalidatePushToken` performs the transition; PART 04A decides *when*
it is allowed to run. The executor calls the reconciler after a push fan-out that reported
at least one `INVALID_TOKEN`.

### 21.2 No migration was required

§12.7 reserved a migration number for this PART, but none was consumed: PART 01's `0334`
already added `invalidated_at`, `invalidation_reason` (with a 200-character CHECK) and the
`INVALID` status value. Adding a migration would have been ceremony. Consequently the
**B-01h push-migration allow-list is untouched** (`0235`, `0334`, `0335`, `0336`) and the
boundary contract file is byte-for-byte unchanged — no widening, no justification needed.

### 21.3 Evidence is the only authority

Reconciliation takes a `deliveryId` and re-reads `notification_push_deliveries` rather than
consuming an in-memory fan-out result. The provider is never re-contacted to decide
invalidation — asserted by a test that counts provider calls before and after
reconciliation and requires the count to be unchanged. A replay test drives invalidation
from evidence inserted by an unrelated process, proving no in-process send state is needed.

### 21.4 The five governed rules, and where each is enforced

| §8 rule | Enforcement |
| --- | --- |
| Only `INVALID_TOKEN` invalidates | Candidate filter on `status='FAILED' AND error_code='INVALID_TOKEN'`. RATE_LIMITED / PROVIDER_UNAVAILABLE / NETWORK_ERROR / UNKNOWN_ERROR and the permanent non-token codes PAYLOAD_INVALID / INVALID_REQUEST / AUTHENTICATION_FAILED never reach a write |
| Exact `push_token_id` only | The evidence row names the id; siblings and other users are never enumerated |
| ACTIVE → INVALID only | Delegated to `invalidatePushToken`, whose `WHERE status='ACTIVE'` makes INACTIVE/INVALID rows a no-op |
| Retain the row + provenance | No DELETE and no column blanking anywhere in the module; id, owner, device, token value, platform and `registered_at` are asserted unchanged |
| Bounded reason + event | Reason is built from normalized code + provider name and sliced to 200 chars; one `NOTIFICATION_PUSH_TOKEN_INVALIDATED` event carries the device id, never the token value |

### 21.5 The staleness guard (the subtle one)

A device that re-registers **rotates its existing row in place** — same id, refreshed
`last_seen_at`, invalidation fields cleared. Evidence recorded *before* that rotation
therefore describes a token value the row no longer holds, and acting on it would kill a
live handset, violating PART 01's re-registration contract. Reconciliation compares
`last_seen_at` against the evidence `created_at` and skips with
`REREGISTERED_AFTER_EVIDENCE`. An `OWNER_MISMATCH` skip covers the case where evidence and
registry disagree on the owner: the module refuses to guess.

### 21.6 Blast radius

AUTHENTICATION_FAILED is deliberately **not** grounds for invalidation: bad sender
credentials are a configuration fault, and treating them as proof of dead handsets would
silently unsubscribe an entire fleet from one misconfiguration. Reconciliation is also
wrapped so that a reconciliation failure can never corrupt an otherwise successful send
(§8 item 4 — one dead device does not fail the recipient's delivery), and it is idempotent:
a second pass reports `TOKEN_NOT_ACTIVE`, preserves the original `invalidated_at`, and
emits no duplicate event.

### 21.7 Validation

Focused PART 01–04A set — 14 suites: **232 pass / 0 fail / 0 skipped** (214 prior + 18 new).
The new suite was **mutation-proven**, not merely green: dropping the `INVALID_TOKEN` filter
failed the two retryable/permanent guards, deleting the staleness guard failed the
re-registration race test, and broadening the write to siblings failed the exact-targeting
and executor tests. The original file was restored byte-identically afterwards and the
suite re-run green. `tsc --noEmit` reports the 22 pre-existing errors and no new ones;
`git diff --check` is clean. EMAIL/WHATSAPP execution paths are untouched — the executor
diff is confined to `runPushFanout`.

### 21.8 Explicitly NOT in PART 04A

Logout / session-revocation hooks (§7 cases 5–7), stale-device cleanup thresholds (D-04),
and the attempt-budget work remain deferred to later PARTs. No queue, worker or scheduler
was added, no public send endpoint exists, and no push-vendor dependency was introduced.

## 22. PART 04B — Retry & Failure Semantics (implementation notes)

### 22.1 Retry mapping — the existing engine, unchanged

No push-specific retry scheduler, worker, queue, backoff engine, cron or polling loop was
created, and no existing retry primitive was redesigned. PUSH reaches the retry engine as
just another channel: `runPushFanout` flattens the fan-out into the shared
`AdapterInteraction`, and the executor's channel-agnostic mapping does the rest.

| PART 03 rolled-up outcome | Existing ledger result | Status |
| --- | --- | --- |
| `ACCEPTED` | `markSent` | `SENT` (terminal success) |
| `REJECTED_RETRYABLE` | retry window | `RETRY_SCHEDULED`, or `EXHAUSTED` when the budget is spent |
| `REJECTED_PERMANENT` | `markFailedPermanent` | `FAILED_PERMANENT` (terminal) |
| adapter throw (`ERROR_UNKNOWN`) | retryable, budget applies | `RETRY_SCHEDULED` |
| `INVALID_TOKEN` (per device) | ordinary delivery failure **plus** PART 04A reconciliation | per rolled-up outcome |

No parallel status vocabulary exists: a test asserts every push outcome lands in
`PENDING|SENDING|SENT|RETRY_SCHEDULED|FAILED_PERMANENT|EXHAUSTED`. Backoff, jitter and
max attempts remain `OUTBOUND_RETRY_BASE_MS` / `_CAP_MS` / `_JITTER_RATIO` /
`OUTBOUND_DEFAULT_MAX_ATTEMPTS`; a test asserts no `PUSH_RETRY_*` policy was introduced.

### 22.2 Permanent failure fails closed

Permanent and configuration faults (`PAYLOAD_INVALID`, `INVALID_REQUEST`,
`AUTHENTICATION_FAILED`) terminate the delivery and are **never** grounds for retiring a
handset — an expired sender credential is our defect, not a dead device. Only evidence
whose `error_code` is exactly `INVALID_TOKEN` may invalidate, and only via PART 04A.

### 22.3 Failure/success telemetry — the PART 01 gap that was actually open

PART 01 shipped `recordPushTokenSuccess` / `recordPushTokenFailure`, but **nothing in
`src/` ever called them**: every registration's `consecutive_failure_count`,
`last_success_at` and `last_failure_at` sat frozen at their registration defaults no
matter what the provider said. PART 04B closes exactly that gap with
`push-tokens/push-token-delivery-telemetry.service.ts`:

- accepted → refresh `last_success_at`, **reset** the streak to 0;
- retryable/permanent → stamp `last_failure_at`, **increment** the streak, never touch `status`;
- `INVALID_TOKEN` → skipped (`INVALID_TOKEN_OWNED_BY_LIFECYCLE`), because
  `invalidatePushToken` already stamps the failure and increments the streak in the same
  UPDATE. Counting it here too would double-count it.

**Why the current attempt, not the delivery's history.** PART 04A reconciles by re-reading
every evidence row for a `delivery_id`, which is safe there because the second pass finds
the token already non-ACTIVE. Counter arithmetic has no such self-limiting property: a
retry writes another evidence row under the *same* delivery, so reconciling by
`delivery_id` would re-count every earlier attempt on every retry and inflate the streak
superlinearly. Telemetry is therefore fed the current pass's attempts only.

Telemetry is observability, never authorization state (§7): eligibility for fan-out is
`status = 'ACTIVE'`, never a counter threshold. It never throws — a counter update must not
fail a send that already happened.

### 22.4 Success and multi-device independence

Every write targets the exact `push_token_id` the attempt was made against. A test fans one
delivery out to two devices where one accepts and one fails, then asserts the accepting
device has `last_success_at` set with a zeroed streak and a null `last_failure_at`, while
its sibling has the mirror image — neither contaminates the other.

### 22.5 Attempt evidence, idempotency and concurrency

One logical delivery → N device attempts over time. A retry appends **another**
`notification_push_deliveries` row under the same `delivery_id`; it never creates a second
notification or ledger row and never regenerates the idempotency key (both asserted).
PUSH retries are re-dispatched by the **same** `processDueOutboundDeliveries` query as
EMAIL/WHATSAPP, and the order is claim → attempt → result: a row already `SENDING` is
`NOT_CLAIMABLE`, and a test asserts the provider is not contacted and no evidence row is
written in that case. Zero-active-device retries stay truthful — no fabricated acceptance,
no provider call, and a retired token is never reactivated.

### 22.6 Sanitization (§18 item 15) — a real leak, now closed

The PUSH branch of `sanitizeFor` **was reachable** and **was** a genuine leak path. PART 03C
returned push error text verbatim on the premise that it had already been redacted inside
the provider module. That premise holds only for errors the per-device `sendToDevice`
classified or caught. A throw raised *around* that seam — reading `adapter.provider` during
roll-up, port resolution touching service-account configuration, plan resolution, an
evidence write — bypasses the per-device catch entirely, escapes `executePushFanout`, and
lands in the executor's PUSH branch, where it was persisted verbatim as the ledger's
`last_error`.

The fix reuses the existing provider-neutral `sanitizeProviderError` (the same function the
adapter and dispatch seam already use — no duplicated redaction logic, and idempotent, so
already-scrubbed strings pass through unchanged). The regression test drives a
credential-bearing throw through that exact path and asserts the persisted `last_error`
contains no bearer token, no PEM body and no `client_secret`. **Verified by mutation:**
reverting the branch to `return message` makes the test fail with the raw credential
visible in the persisted ledger text.

### 22.7 EMAIL/WHATSAPP regression

Unchanged and proven by focused tests: EMAIL still retries then succeeds, WHATSAPP permanent
failure is still terminal, and no push evidence row is written for a non-push channel. The
executor diff is confined to the PUSH branch of `sanitizeFor` plus one call inside
`runPushFanout`.

### 22.8 Migration decision

**No migration.** `0335`/`0336` already provide every column PART 04B writes
(`consecutive_failure_count`, `last_success_at`, `last_failure_at` come from PART 01). No
schema blocker was encountered.

### 22.9 Validation — RUN

- `tests/push01-part04b-retry-and-failure-semantics.test.ts` — **25/25, 0 skipped**.
- Focused 15-suite regression — **257/257, 0 fail, 0 skipped**.
- Mutation testing — 4 mutants (sanitizer removed; telemetry wiring removed; `INVALID_TOKEN`
  double-counted; every outcome treated as success) — **all 4 KILLED**, sources restored
  byte-identical.
- `npx tsc --noEmit` — 22 errors, exactly the pre-existing baseline, none in touched files.
- `git diff --check` — clean.

NOT RUN (per brief): `npm ci`/dependency installs, real provider credentials, real push
sends, broad regression, CI.

### 22.10 PART 04C readiness

The retry path is now truthful end to end: outcomes map onto the existing engine, counters
move exactly once per attempt, evidence accumulates under one logical delivery, and the last
known credential-leak path into persisted failure text is closed. Deferred as before:
logout/session-revocation hooks (§7 cases 5–7), stale-device cleanup thresholds (D-04),
quiet hours/preferences, and any public send or delivery-admin endpoint.

---

## 23. PART 04C — Delivery Evidence & Operational Telemetry

PART 04C reviewed what the push path already records, corrected two truthfulness/privacy
defects at the evidence boundary, and locked the result behind regression coverage. It
added no schema, no route, no framework and no new state machine.

### 23.1 Evidence model (reviewed, not redesigned)

`notification_push_deliveries` was already sufficient, so it was kept as-is. One append-only
row is written per device per provider attempt, before the ledger is touched, carrying:
logical delivery id (`delivery_id`), registration reference (`push_token_id` + `device_id`,
`platform`), `provider`, attempt result (`status` = `SENT` | `FAILED`), provider message id
(`provider_reference`), `error_code`, sanitized `error_message`, and the attempt timestamp
(`sent_at` / `created_at`). The repository exposes only `create()` and `listByDeliveryId()` —
there is no update or delete surface, which is what makes the history immutable.

No credential is persisted, and the token VALUE is deliberately not copied: the row points at
the `mobile_push_tokens` authority by id. `mobile_push_tokens` storage was not redesigned.

### 23.2 Semantics — no invented acknowledgement authority

The recorded vocabulary stays inside the allowed concepts (queued → provider attempt →
accepted / failed-retryable / failed-final). The strongest claim the system makes is
*provider acceptance*. `DELIVERED_TO_DEVICE`, `DISPLAYED` and `READ` appear nowhere in the
push code paths, and a `provider_reference` is treated strictly as an acceptance receipt,
never as proof the handset received or showed anything. Both properties are now guarded by
tests (including a schema assertion that no `delivered_to_device` / `displayed_at` /
`read_at` / `acknowledged_at` column exists).

### 23.3 Operational events — one framework only

`recordOperationalEvent` remains the single event framework. The `NOTIFICATION_OUTBOUND_*`
events stay authoritative for the delivery lifecycle, and `NOTIFICATION_PUSH_TOKEN_INVALIDATED`
(introduced by PART 04A) remains the only push-specific addition. No second observability
system, no per-device or per-conversion-step event storm: a single-device accepted delivery
emits exactly one lifecycle event and nothing else, which is asserted directly.

### 23.4 Invalidation-event idempotency

Emission sits *after* the guarded transition in `reconcileInvalidTokenEvidence`, so the event
can only follow a real ACTIVE→INVALID change. The once-only property is protected by two
independent guards — the app-level `token.status !== 'ACTIVE'` classification and the
`AND status = 'ACTIVE'` clause in `invalidatePushToken`'s UPDATE — plus per-registration
de-duplication within a pass. Mutation testing confirmed genuine defence-in-depth: removing
either guard alone still yields one event; removing BOTH produces duplicates and fails the
suite. Repeated reconciliation is a no-op (`skipped: ['TOKEN_NOT_ACTIVE']`, `invalidated_at`
unchanged), and a healthy sibling registration on the same delivery receives no event.

### 23.5 Privacy / redaction — TWO REAL DEFECTS FOUND AND FIXED

1. **Device tokens survived sanitization.** The shared sanitizer redacted credentials only.
   Providers routinely echo the registration token back in error prose
   (`"Requested entity was not found for token <token>"`), and that text is persisted as
   immutable evidence. Two narrow device-token shapes are now redacted to
   `[REDACTED_DEVICE_TOKEN]` inside the existing sanitizer (no second redaction path):
   the `<instance-id>:APA91b…` registration-token form and 64-hex device tokens.
2. **Returned failures bypassed sanitization at the evidence boundary.** `sendToDevice`
   scrubbed only the THROWN path; a RETURNED `result.error` reached `boundError()` — and
   therefore the evidence row — unsanitized. The governed adapter self-redacts, so this was
   latent, but any other port implementation could persist a raw credential. `boundError()`
   now sanitizes before bounding. `sanitizeProviderError` is idempotent, so already-clean
   adapter text is unaffected and no redaction logic is duplicated.

Result: a raw push token and a raw credential now both fail to reach attempt evidence, the
ledger `last_error`, and operational event payloads. Events carry identifiers only
(`pushTokenId`, `deviceId`, `platform`, `provider`, `errorCode`, `reason`, `deliveryId`).
Benign diagnostics — including provider message ids — keep their meaning; redaction was
verified not to over-match.

### 23.6 Attempt history under retry

A retry appends a NEW evidence row under the SAME logical delivery. Earlier rows are proven
byte-stable across a subsequent attempt (full-row snapshot comparison), the idempotency key is
never regenerated, and no sibling ledger row is created. PART 04B's success/failure telemetry
(`last_success_at` + streak reset; `last_failure_at` + streak increment; `INVALID_TOKEN` owned
by 04A) is preserved exactly and was NOT duplicated here.

### 23.7 Retention

Non-destructive. INVALID registrations and their justifying evidence are retained (status,
`invalidated_at` and `invalidation_reason` intact), and a guard asserts no
`DELETE FROM` / `TRUNCATE` against `notification_push_deliveries`, `mobile_push_tokens` or
`notification_outbound_deliveries` exists in any push production path.

### 23.8 EMAIL / WHATSAPP safety and migration decision

EMAIL/WHATSAPP behaviour is untouched: an EMAIL delivery consults no push port, creates no
push evidence and emits no invalidation event. **No migration was added** — `0334`/`0335`/`0336`
proved sufficient and no schema blocker appeared, so there is no `0337`. No new API route, no
delivery-history endpoint, no admin resend, no test-send endpoint.

### 23.9 Validation

RUN: new suite `tests/push01-part04c-delivery-evidence-and-telemetry.test.ts` (25 cases,
0 skipped); focused 16-suite regression set **282/282 pass, 0 fail, 0 skipped**; mutation
testing (4 mutants applied and reverted byte-identically — sanitizer device-token patterns
removed → killed; `boundError` sanitization removed → killed; each invalidation guard alone →
survived, both together → killed); `tsc --noEmit` shows 22 pre-existing errors, identical to
the stashed baseline, none in the touched files; `git diff --check` clean.

NOT RUN (out of scope by instruction): full repository suite, CI, `npm ci` / dependency
installation, real provider credentials, real push sends, ESLint (no usable config).

### 23.10 PART 04D readiness

Evidence is truthful, immutable and privacy-safe; telemetry has a single framework and an
idempotent invalidation event. PART 04D can proceed on this base. Still deferred:
logout/session-revocation hooks (§7 cases 5–7), stale-device cleanup thresholds (D-04),
quiet hours/preferences, and any public send or delivery-admin endpoint. The PART 04 final
review remains outstanding and was deliberately not performed here.

## 24. PART 04 — FINAL INTEGRATION VALIDATION (PART 04D)

PART 04D reviewed PART 04A (`2510d89`), 04B (`8e54c04`) and 04C (`749d8d6`) **together**.
It is a review PART: it added **no production capability** and changed **no `src/` file**.
The only artifact is the closure suite
`tests/push01-part04d-final-integration-closure.test.ts` (23 cases, 0 skipped), which
proves the three slices compose as one path rather than three independently-correct parts.

### 24.1 End-to-end invalid-token flow
Provider `INVALID_TOKEN` → attempt evidence row → reconciliation of the **exact**
`push_token_id` → ACTIVE→INVALID with `invalidated_at` and `invalidation_reason`
retained → exactly one `NOTIFICATION_PUSH_TOKEN_INVALIDATED` event carrying identifiers
only. Verified alongside it: sibling devices on the same delivery are untouched and still
receive their notification; retryable and permanent **non-token** failures never
invalidate and emit no event; evidence that predates a re-registration is refused via
`REREGISTERED_AFTER_EVIDENCE`, preserving the PART 01 re-registration contract.

### 24.2 Retry, exhaustion and idempotency
A retryable push failure is carried by the **existing** outbound retry engine: one logical
ledger row, an unchanged `idempotency_key`, `attempt_count` advancing 1→2, and one appended
evidence row per attempt. Exhaustion uses the shared budget and the existing `EXHAUSTED`
semantics — there is no PUSH-specific max-attempt policy. A static guard over
`push-tokens`, `push-delivery` and `notification-push-deliveries` confirms no interval
timer, worker, cron, queue or retry loop was introduced. (The guard intentionally permits
`setTimeout`, which the provider adapter uses solely to abort a slow HTTP request.)

Re-running reconciliation over already-reconciled evidence is a **no-op**: the ACTIVE-only
transition means `invalidated_at` is not restamped, the failure streak is not inflated, and
the invalidation event stays at exactly one.

### 24.3 Success and failure telemetry
An accepted attempt retains the provider message id, stamps `last_success_at`, resets
`consecutive_failure_count` to 0 and never invalidates. A failed attempt stamps
`last_failure_at` and increments the streak on **that device only**, leaving siblings
untouched. `INVALID_TOKEN` remains owned by the invalidation flow: the 04B telemetry
recorder skips it so the streak is counted exactly once, never twice.

### 24.4 Evidence integrity and event boundary
Evidence is append-only across a mixed retry sequence: the first row is byte-identical
before and after a second attempt, provider message ids and sanitized error text are
preserved, and no row is overwritten. The logical lifecycle speaks only the existing
`NOTIFICATION_OUTBOUND_*` vocabulary; a three-device fan-out produces exactly **one**
lifecycle event and three evidence rows, confirming no event-per-internal-step and no
second telemetry framework.

### 24.5 Claim, concurrency and ordering
Claim-before-send is reconfirmed at runtime, not just structurally. A row already in
`SENDING` yields `NOT_CLAIMABLE` and reaches **no** provider and writes **no** evidence.
Two workers racing the same delivery resolve to exactly one `SENT` and one
`NOT_CLAIMABLE`, with the provider contacted exactly once; two concurrent due-dispatcher
passes send the row exactly once. Mutation evidence: removing the claim's
`status IN ('PENDING','RETRY_SCHEDULED')` guard fails the suite.

### 24.6 Privacy
Re-ran the redaction guards across **every** sink. A single provider error carrying a
bearer JWT, an OAuth `ya29.` token, a PEM private key, a `client_secret`, a
provider-shaped device token and the device's own live token leaves no secret in the
evidence row, the ledger `last_error`, or any operational event; the persisted text is
`[REDACTED]`. A static check confirms no logger call passes a raw token. Note recorded for
future parts: redaction is **shape-based**, so fixtures must use realistic provider-shaped
tokens — a synthetic `tok-<uuid>` fixture proves nothing about production behaviour.

### 24.7 EMAIL / WHATSAPP safety
An EMAIL delivery still executes through its own adapter, never consults the PUSH port,
writes no push evidence, touches no registration and emits no invalidation event. The
pre-existing EMAIL retry regression expectations in `outbound-delivery-execution.test.ts`
pass unchanged.

### 24.8 Boundary contract (item 11)
All 15 assertions in `mobile-push-delivery-boundary-contract.test.ts` were reviewed and
**none was retired**. They constrain the *published API surface* — which PART 04
deliberately never changed — not the internal delivery path, so none became stale. Every
permanent guard remains in force and independently re-verified: no parallel push queue, no
direct APNs, no Web Push, no public send/test/history endpoint, no token-as-auth, no
committed credentials, no provider-specific code outside `src/modules/push-delivery/`, and
no destructive token cleanup (`DELETE`/`TRUNCATE`) on any production path.

### 24.9 Migrations and test integrity
Final PART 04 migration state is exactly `0334`, `0335`, `0336` — **no `0337`**; no schema
blocker was found, so none was created. Test-integrity audit across the repository: **91
`skipIfNoTestDatabase` guard sites, all** in the required `if (!(await
skipIfNoTestDatabase(t))) return;` form, **zero inverted guards**. (`database.test.ts`,
`health.test.ts` and `migrate.test.ts` use the equivalent value-returning form
`const database = await skipIfNoTestDatabase(t); if (!database) return;` — not inverted.)

### 24.10 Validation performed
**RUN:** the focused 17-suite set with Postgres available — PART 01, 02, 03A/03B/03C,
04A/04B/04C, the new 04D closure suite, `mobile-push-delivery-boundary-contract`,
`mobile-push-token`, `outbound-delivery-execution`, `outbound-delivery-ledger`,
`notification-delivery`, `database`, `health`, `migrate` → **293 pass / 0 fail /
0 skipped**. Targeted mutation testing: the device-token redaction chain, the ledger claim
guard, and the ACTIVE-only invalidation guard were each disabled in turn and each produced
a failing suite; all sources were restored and verified byte-identical. Typecheck
`tsc --noEmit --module ES2022 --moduleResolution Bundler` → 22 errors, **equal to the
pre-existing baseline** (no new errors). `git diff --check` clean.

**NOT RUN (out of scope by instruction):** `npm ci`, dependency installation, real provider
credentials, real push sends, CI, and any broad non-push regression run.

### 24.11 PART 05 readiness
PART 04 is closed. The delivery path is coherent end to end: claim-guarded, retried by the
shared engine, evidenced append-only, telemetered per device, invalidated idempotently and
scoped to one registration, with redaction proven at every persisted sink and EMAIL and
WHATSAPP behaviourally untouched. Still deferred and explicitly **not** implied by PART 04:
logout/session-revocation hooks (§7 cases 5–7), stale-device cleanup thresholds (D-04),
quiet hours and delivery preferences, and any public send or delivery-admin endpoint.

---

## 25. PART 05 — mobile contract, OpenAPI truth & cross-module safety (COMPLETE)

PART 05 added **no capability**. It changed no `src/` file. It reconciled what the
mobile contract *says* with what PARTs 01–04 actually built, and re-proved the
boundary. Two documentation defects were found and fixed; one scheduled
retirement was deliberately **not** performed (25.4).

### 25.1 Public mobile API — unchanged, exactly 3 routes
`POST` / `GET` `/mobile/push-tokens` and `DELETE /mobile/push-tokens/{tokenId}`, all
behind `authenticationMiddleware`, all self-scoped. No send, test-push, resend,
delivery-history, provider or admin token-management endpoint was added, and the
suite asserts the router exposes exactly `get|post|delete` and that the published push
`operationIds` are exactly `registerPushToken`, `listPushTokens`, `deactivatePushToken`.

### 25.2 Status contract — a real mismatch, fixed in the SPEC (not the runtime)
A runtime probe proved that a registration retired by PART 04A is returned by the
public `GET` with `status: "INVALID"` (`listPushTokens` applies no status filter, by
design — the row is retained history). OpenAPI declared only `[ACTIVE, INACTIVE]`.

Fix: **widen the documented enum to `[ACTIVE, INACTIVE, INVALID]`** and describe each
value honestly. The lifecycle was **not** changed to simplify the schema, and the
listing was **not** filtered to hide the value — per the PART 05 brief, a
runtime-observable value must never be hidden from the spec. No test pinned the old
enum, so nothing regressed. A new guard asserts the documented enum equals
`PUSH_TOKEN_STATUSES`, so the two can no longer drift.

### 25.3 Stale lifecycle prose — corrected (B-01a, B-01b, B-01l)
The `POST` operation still carried CR-BE-MOB-01 PART 07 prose asserting push delivery
does not exist: stage 3 `PARTIAL`/`missingChannels:[PUSH]`, stage 4 `MISSING`, and a
failure-behaviour note claiming "a missing push is invisible to the backend". All were
false after PARTs 03/04 and were rewritten to the truth: attempts are recorded as
internal per-device evidence, failures are retried by the **shared** engine, and
provider rejection retires the registration to `INVALID`.

`x-push-delivery-lifecycle` stage 4 is now `EXISTING` **with `operationIds: []`** — the
capability exists but no published operation can trigger it. B-01a/B-01b were rewritten
(not weakened) to guard that, plus a new assertion that the contract never claims
device-level delivery. B-01l keeps the required "registration is NOT delivery" phrase
and now also states "acceptance is NOT delivery".

### 25.4 DEVIATION from §13.1 — B-01e is **kept**, not retired
§13.1 scheduled PART 05 to retire B-01e by adding PUSH to `NOTIFICATION_HISTORY_CHANNELS`,
the history UNION and the history `channel` query enum. **This was deliberately not done.**
Inspection of `src/modules/notification-history/` found no reference to PUSH or to
`notification_push_deliveries`: push rows are genuinely **not** in the history read model.
Declaring PUSH an implemented history channel would therefore have advertised a
capability that does not exist — precisely what this CR forbids — and building the UNION
would have been new capability, which PART 05 forbids. B-01e stays green and is now a
permanent guard that push evidence remains internal. Surfacing push in history remains
available to a later, explicitly scoped PART.

### 25.5 Token privacy — frozen contract honoured, leakage re-proven absent
`pushToken` remains in the response **only** because it is a member of the frozen
BE-25L `PUBLIC_REGISTRATION_KEYS` list, which `push01-part01` pins with a `deepEqual`
freeze — the brief's "existing frozen contract explicitly requires it" case. It was not
removed. Verified with realistic FCM-shaped fixtures (never synthetic `tok-<uuid>`) that
the raw token reaches no operational event, and that the adapter and fan-out log a
non-reversing `pushTokenFingerprint` rather than the token. The public shape still
exposes none of `provider`, `providerMessageId`, `lastSuccessAt`, `lastFailureAt`,
`consecutiveFailureCount`, `invalidatedAt`, `invalidationReason`.

### 25.6 Ownership / isolation
Proven at runtime: a user lists only their own registrations, and a cross-user
`deactivatePushToken` returns `null` and leaves the victim row `ACTIVE`. Static guards:
the controller never reads a `userId` from body/params/query, and no file under
`src/modules/auth/` consults `mobile_push_tokens` — a push token is never a credential.

### 25.7 Provider neutrality
No `firebase`, `googleapis`, `onesignal`, `expo`, `fcm`, service-account, `ya29` or
`oauth` vocabulary appears in the published push paths or schema. One pre-existing
BE-25L mention names the token **format** ("FCM/APNs style opaque token") on the request
field; that is a client-facing shape hint, not relay/credential/project detail, it
predates this CR, and PART 05 left it alone rather than invent a change. The guard
excludes that exact string and asserts it appears **exactly once**, so a new leak cannot
hide behind the exemption.

### 25.8 Cross-module safety
EMAIL, WHATSAPP, notification intent, outbound ledger idempotency, the shared retry
engine, auth/session authority, RBAC and notification subscriptions are untouched — no
`src/` file changed in this PART. No second preference authority and no second
notification engine exist. `push-token.service.ts` still contains no delivery call and
touches no delivery table.

### 25.9 Migration — none
Sequence remains `0334` / `0335` / `0336`. No `0337`; no schema blocker arose, and the
suite asserts this.

### 25.10 Mobile handoff
`docs/api/CR_BE_PUSH_01_MOBILE_HANDOFF.md` (new) documents the 3 endpoints, when to
register (post-login, reinstall, token refresh, device-identity refresh, explicit
unregister), the `INVALID` → re-register rule, the pointer-oriented payload
(`notificationId`, `eventType`, `entityType`, `entityId`, `deliveryId`) with the
instruction to fetch authoritative detail over the authenticated API, and the two
"not delivery" rules. **No deep-link scheme was invented** — routing is from
`entityType` + `entityId`. `docs/api/mobile-contract.md` §7j was corrected likewise.

### 25.11 Validation
**RUN** (Postgres up, `0 skipped`):
- 13-suite push focused set (PART 01–05, `mobile-push-token`, boundary contract,
  regression contract) → **274 tests, 273 pass, 1 fail**.
- `openapi-contract`, `mobile-openapi-completeness`, `notification-history`,
  `notification-delivery` → **30 tests, 28 pass, 2 fail**.
- The **3 failures are pre-existing at baseline `9ec4ed2`** and unrelated to push,
  confirmed by re-running each on a stashed tree: `mobile-cr-regression-contract`
  "PART 08 authoritative ids" (duplicate `#/components/headers/RequestId`), and
  `mobile-openapi-completeness` "unique operationId" + "resolves every $ref".
- Mutation-tested the two new guards: narrowing the status enum back to
  `[ACTIVE, INACTIVE]` → 2 failures; leaking `invalidationReason` through the mapper →
  2 failures. Both mutants killed, both sources restored.
- `tsc --noEmit --module ES2022 --moduleResolution Bundler` → **22 errors == baseline**.
- `git diff --check` → clean.

**NOT RUN** (forbidden/out of scope): `npm ci`, dependency install, real FCM or real
credentials, real push send, broad regression, CI.

### 25.12 PART 06 readiness
The mobile contract, OpenAPI and boundary guards now describe the implemented system
truthfully, so PART 06 starts from an honest spec. Still deferred and **not** implied by
PART 05: surfacing push in notification history (25.4), logout/session-revocation hooks
(§7 cases 5–7), stale-device cleanup (D-04), quiet hours and delivery preferences, and
any public send or delivery-admin endpoint.

---

## 26. PART 06 — Closure, Regression & Backend Final Freeze

PART 06 added **no capability**. It audited the final state of PARTs 01–05 and froze the
contract. The one remaining governance blocker (**B-03**, the CI gate) could **not** be
closed: modifying `.github/workflows/ci.yml` requires a `workflows` permission the GitHub
App does not have, so that change was reverted and B-03 is recorded as OPEN (§26.13).
One new suite was added — `tests/push01-part06-closure-and-final-freeze.test.ts`
(27 tests) — which re-proves in a single place the invariants each PART established
locally, so a later change cannot quietly undo one of them.

### 26.1 Implementation matrix

| PART | Deliverable | Final state |
|---|---|---|
| 01 | `mobile_push_tokens` registration authority + 3 mobile routes (migration `0334`) | **Complete** |
| 02 | Provider port, `noop`/`capture`/`fcm` adapters, FCM HTTP v1 (migration `0335`) | **Complete** |
| 03A/B/C | PUSH channel on the shared ledger, device fan-out, provider invocation + attempt evidence (migration `0336`) | **Complete** |
| 04A | INVALID token lifecycle | **Complete** |
| 04B | Retry & failure semantics on the shared engine | **Complete** |
| 04C | Delivery evidence & device telemetry | **Complete** |
| 04D | Final integration closure + boundary re-audit | **Complete** |
| 05 | Mobile contract, OpenAPI truth, cross-module safety | **Complete** |
| 06 | Closure, regression, CI gate, final freeze | **Complete (this section)** |

### 26.2 Final architecture

Intent → `notification_outbound_deliveries` ledger → due-job dispatcher → guarded claim
(`PENDING`/`RETRY_SCHEDULED` → `SENDING`, `FOR UPDATE SKIP LOCKED`) → PUSH fan-out over the
recipient's ACTIVE devices → one provider attempt per device → one append-only evidence row
per attempt in `notification_push_deliveries` → the **shared** retry/final transition.
There is **no** PUSH queue, worker, scheduler, cron, second ledger, or public send endpoint.

### 26.3 Provider decision

`PUSH_PROVIDER` ∈ `noop` (default) | `capture` | `fcm`; production is FCM HTTP v1 and iOS is
reached **only** through the FCM APNs relay. **Zero vendor SDK dependencies** (verified against
every dependency block in `package.json`). No direct APNs, OneSignal, Expo, or Web Push
transport exists; no second provider abstraction. Credentials are read solely at the adapter
boundary (`readFcmPushConfig`) — `PushConfig` carries only `{ provider: string }`, so no
credential can reach `AppConfig`, a log, or the database *by construction*. Missing credentials
raise `ConfigError` (**fail closed**); the test environment cannot resolve a real FCM endpoint.

### 26.4 Delivery, retry, fan-out and idempotency

One logical PUSH delivery per recipient; N ACTIVE devices → N attempts, never N notifications.
`channel` remains a hashed component of the existing idempotency authority and of
`UNIQUE (client_id, channel, idempotency_key)`. Retries reuse the same logical delivery and
append evidence. Retry/backoff is unchanged and shared (base 5 min, cap 6 h, jitter 0.25,
`OUTBOUND_DEFAULT_MAX_ATTEMPTS` = 5); there is no PUSH-specific max-attempt policy.
Zero targets → `REJECTED_PERMANENT` with `emptyReason='NO_ACTIVE_REGISTRATIONS'`.

### 26.5 Invalid-token lifecycle

`INVALID_TOKEN` evidence → the **exact** `push_token_id` only → `ACTIVE` → `INVALID`, with
`invalidated_at` and reason retained and `NOTIFICATION_PUSH_TOKEN_INVALIDATED` emitted once.
No sibling device is touched, nothing is deleted, and retryable/config/auth failures never
invalidate. Rows are retained in every terminal state, and a device may always re-register
after INVALID (proven: the retired row is neither reused nor removed).

### 26.6 Telemetry and evidence

Acceptance → `last_success_at` + streak reset; failure → `last_failure_at` + governed streak
increment; the INVALID transition stays owned by the invalidation authority, so nothing is
double counted. Evidence is append-only: no `UPDATE`/`DELETE` against
`notification_push_deliveries` exists anywhere. A provider message id records **acceptance
only** — `DELIVERED_TO_DEVICE`, `DISPLAYED` and `READ` are forbidden and guarded, because no
acknowledgement authority exists.

### 26.7 Privacy

A repo-wide sweep found **no committed credential material**. The sweep distinguishes real key
material from the deliberately credential-shaped fixtures the privacy tests require (by body
length and synthetic labelling) rather than exempting `tests/`, which would blind the guard
exactly where secrets are handled. Raw device tokens stay out of operational events, the ledger
`last_error`, attempt error evidence, logs and config serialization. Existing sanitizer guards
(`-----BEGIN`, `Bearer`, `ya29`, `REDACTED_DEVICE_TOKEN`) were **retained, not weakened**.

### 26.8 Event boundary

`NOTIFICATION_OUTBOUND_*` remains authoritative. A scan of `src/` proves the only
PUSH-specific event type in existence is **`NOTIFICATION_PUSH_TOKEN_INVALIDATED`**. No second
audit/telemetry framework and no event per internal step.

### 26.9 API / OpenAPI contract (frozen)

Exactly three authenticated, self-scoped, provider-neutral routes —
`registerPushToken`, `listPushTokens`, `deactivatePushToken` — on `/mobile/push-tokens` and
`/mobile/push-tokens/{tokenId}`, with unique operationIds and runtime ↔ spec agreement.
No send, test, resend, history, or admin endpoint. The public `PublicPushToken` shape and the
pointer-only payload (`title`, bounded `body`, `notificationId`, `entityType`, `entityId`,
`eventType`, `deliveryId`) are frozen; no financial detail, no credential, **no deep-link
scheme**. A push token can never authenticate a request.

### 26.10 B-01e decision

**B-01e stays a live guard.** `NOTIFICATION_HISTORY_CHANNELS` remains `IN_APP | EMAIL |
WHATSAPP`. PUSH notification history is **not implemented** and is recorded as a deferred
capability, not a closure defect.

### 26.11 Deferred capabilities (recorded, not implemented)

PUSH notification history; logout/session-revocation hooks; stale-device cleanup; quiet hours
and delivery preferences; Web Push; direct APNs; additional providers; admin send/test/resend;
delivery/read acknowledgement; FCM credential provisioning (**B-02**, a deployment task).

### 26.12 Migration closure

`0334`, `0335`, `0336` each exist, are imported once, registered once, and ordered ascending.
No `0337` was created. Migration file count == registered count == **336**, with no duplicate
number. PART 06 required no schema change.

### 26.13 B-03 — NOT closed (blocked on repository permissions)

PART 06 was assigned the job of appending the push suites to a CI gate. The edit was
prepared and verified locally (the 11 `push01-*` suites plus
`tests/mobile-push-delivery-boundary-contract.test.ts` inserted alphabetically into the
DB-backed gate, 327 suites, no duplicates, YAML re-parsed), but it **could not be
committed**: GitHub rejected the push with

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/ci.yml` without `workflows` permission
```

The workflow change was therefore **reverted** and `.github/workflows/ci.yml` is
unmodified by this CR. **B-03 remains OPEN.**

- **Currently gated:** `tests/mobile-push-token.test.ts` only (pre-existing, at L222).
- **Still ungated:** the 11 `push01-*` suites and the boundary contract suite.
- **Required to close:** grant the GitHub App `workflows` permission, then add those
  12 suite paths to the "Remaining DB-backed regression tests" step.

The closure suite encodes this honestly rather than hiding it: the test
`records which PUSH suites are still absent from the CI gate (B-03 OPEN)` asserts that
the one historically gated suite never regresses out of CI, that every ungated suite is
a *recorded* gap, and it flips to a strict closure assertion automatically once the
suites are gated — no further test edit needed.

### 26.14 Focused regression — RUN

- **13 PUSH suites** (PARTs 01–06, mobile push token, boundary contract): **289 tests, 289 pass,
  0 fail, 0 skipped** — the §19 target of zero skips was met with Postgres available.
- **Affected neighbours** (notification delivery/history/templates/subscriptions, outbound
  intent/ledger/execution, recipient resolution, config, OpenAPI contract, mobile OpenAPI
  completeness, mobile CR regression): **158 tests, 155 pass, 3 fail** — all three pre-existing.
- **Test-integrity audit:** every `skipIfNoTestDatabase` call across the PUSH suites uses the
  safe `!(await …)` form; zero inverted guards.
- **Mutation testing** of the new closure guards, each mutant killed and each source restored:
  (M1) committing a realistic service-account PEM → fail; (M2) adding `PUSH` to
  `NOTIFICATION_HISTORY_CHANNELS` → fail; (M3) removing the one historically gated push suite
  from `ci.yml` → fail. A guard that passes without a killed mutant proves nothing, so each
  was verified this way.
- `tsc --noEmit --module ES2022 --moduleResolution Bundler` → **22 errors == baseline**.
- `git diff --check` → clean.

### 26.15 Baseline failures (Class B — pre-existing, left untouched)

Re-proved at the PART 06 baseline by stashing all PART 06 changes and re-running: the same
3 failures appear, so none was introduced by CR-BE-PUSH-01 and none was converted to PASS.

| Suite | Failing test | Cause |
|---|---|---|
| `mobile-cr-regression-contract` | PART 08 — authoritative ids | duplicate `#/components/headers/RequestId` |
| `mobile-openapi-completeness` | documents a unique operationId per operation | global OpenAPI debt |
| `mobile-openapi-completeness` | resolves every `$ref` in the spec | global OpenAPI debt |

**NOT RUN** (forbidden or out of scope): `npm ci`, dependency installation, real FCM
credentials, real push send, CI execution, broad repo-wide regression, and repair of unrelated
global OpenAPI/backend debt.

### 26.16 Final freeze

**B-01** was resolved PART by PART. **B-02** (FCM credential provisioning) is a deployment
task. **B-03** (CI gating) remains **OPEN**, blocked on repository `workflows` permission
(§26.13) — it is a CI-infrastructure gap, not a defect in the implementation, and it does not
affect the runtime behaviour, contract, or correctness of CR-BE-PUSH-01. It must be closed
before, or as part of, final review.

> **CR-BE-PUSH-01 = IMPLEMENTATION COMPLETE = CONTRACT FROZEN = READY FOR FINAL REVIEW**
>
> **ASENTRA BACKEND FEATURE GAP CLOSURE = COMPLETE SUBJECT TO FINAL REVIEW / MERGE OF
> CR-BE-PUSH-01**

Not merged. No pull request was opened.

---

## 27. FINAL REVIEW — CR-BE-PUSH-01 (GOVERNANCE → PART 06)

Scope: review only, across START GOVERNANCE and PARTs 01, 02, 03, 04A, 04B, 04C, 04D, 05
and 06, against the frozen decisions in this document. No new capability was added.

### 27.1 Result

**No defect was found.** Every reviewed area matched the frozen decisions, so **no production
source file was changed by this review** (per the review mandate: absent a real defect, the
implementation is left exactly as PART 06 froze it). The only change in the final-review
commit is this governance section.

### 27.2 Defect review — areas examined

| # | Area | Finding |
|---|---|---|
| 1 | Registration lifecycle | ACTIVE / INACTIVE / INVALID only; rows are never deleted; retirement and rotation are guarded UPDATEs |
| 2 | Token rotation | Same device re-registering rotates the ACTIVE row in place, resets `consecutive_failure_count`, clears invalidation provenance |
| 3 | INVALID lifecycle | Re-registration after INVALID inserts a fresh ACTIVE row (rotation is ACTIVE-only), so history survives and the device recovers |
| 4 | Provider abstraction | `resolvePushAdapter()` is the single seam; `noop` / `capture` / `fcm`; unknown provider and test-env non-credential-less provider both throw `ConfigError`; no silent fallback |
| 5 | Secure config | `PushConfig = { provider }` only; no `PUSH_FCM_*` reaches `AppConfig`; all three FCM vars fail closed at the adapter boundary; `.env.example` placeholders are empty |
| 6 | Notification → PUSH integration | PUSH flows through the existing outbound engine; no parallel path |
| 7 | Fan-out | One ledger row per recipient; N device attempts underneath; roll-up ACCEPTED / REJECTED_RETRYABLE / REJECTED_PERMANENT |
| 8 | Idempotency | Key components unchanged and include `channel`, so PUSH cannot collide with EMAIL/WHATSAPP |
| 9 | Claim-before-send | `SET status='SENDING' … WHERE id=$1 AND status IN ('PENDING','RETRY_SCHEDULED')` — atomic; loser gets `null` and must not contact an adapter |
| 10 | Concurrency | `FOR UPDATE SKIP LOCKED` on due selection; registration races handled via `23505` retry-through-rotation |
| 11 | Retry / exhaustion | Shared engine only — base 5·60_000, cap 6h, jitter 0.25, max attempts 5; no PUSH-specific scheduler, worker, queue, backoff or counter |
| 12 | Attempt evidence | `notification_push_deliveries` is append-only (INSERT + SELECT only; no UPDATE/DELETE surface) |
| 13 | Success/failure telemetry | Per-registration counters; the telemetry service never throws and logs only a UUID plus a DB error string |
| 14 | Invalid-token reconciliation | Exact `push_token_id` only, ACTIVE-only guarded UPDATE, de-duplicated per registration, staleness-guarded, never re-contacts the provider, never DELETEs |
| 15 | Privacy / redaction | See §27.3 |
| 16 | Operational events | Exactly one PUSH-specific event, `NOTIFICATION_PUSH_TOKEN_INVALIDATED`; the rest reuse the existing outbound vocabulary; no event per internal step |
| 17 | Mobile API | 3 authenticated, self-scoped routes; runtime status codes match OpenAPI exactly |
| 18 | OpenAPI | 3 push operationIds over 2 paths; `PushTokenRegistration` is provider-neutral and exposes no internal telemetry |
| 19 | Migration registration | 336 files == 336 imports == 336 registrations; 0334/0335/0336 each registered once, ascending; no 0337 |
| 20 | EMAIL / WHATSAPP regression | No EMAIL or WHATSAPP module file is touched by this CR; the single deleted line in the shared execution service is a behaviour-preserving refactor of `sanitizeFor` that adds a PUSH branch |

### 27.3 Security final review

No raw push token, bearer token, OAuth access token, authorization header, private key,
client secret or service-account credential can be persisted or logged.

- `sanitizeFcmError` (exported vendor-neutrally as `sanitizeProviderError`) was executed
  against nine adversarial inputs — FCM registration token echo, 64-hex APNs token, `Bearer`
  header, bare `ya29.` access token, PEM private key, `client_secret=`, `client_email:`,
  `private_key` JSON, `api_key=` — **all nine were redacted**, and the 500-character bound held.
- Both the RETURNED and the THROWN provider-failure paths sanitize before the text becomes
  immutable evidence, so a non-governed port implementation cannot bypass redaction.
- `notification_push_deliveries` stores `push_token_id` (a UUID FK) — never the token value.
  The raw token exists only in memory during fan-out, because it is the device address.
- `notification_outbound_deliveries.last_error` receives only a rolled-up summary that names
  no device and echoes no token.
- The one logger call in the PUSH modules logs a UUID and a DB error message.
- Credential-shaped material across the whole CR diff: only synthetic fixtures in
  `tests/push01-part02-provider-adapter.test.ts` (fictional project/account identifiers) and
  short stub PEM strings used as redaction *inputs*. **No real credential is present.**

### 27.4 Delivery-claim truthfulness

Terminology remains QUEUED / SENT_TO_PROVIDER / PROVIDER_ACCEPTED / FAILED_RETRYABLE /
FAILED_FINAL, mapped onto the persisted statuses per §11.1. No `DELIVERED_TO_DEVICE`,
`DISPLAYED`, `READ` or `SEEN` claim exists in the PUSH path; the persisted attempt status is
constrained to `SENT | FAILED`. (The `READ` occurrences elsewhere in `src/` belong to
pre-existing in-app notification, tenant-communication and WhatsApp-callback code.)

### 27.5 Provider final state

FCM HTTP v1 is the only production implementation; iOS is served through FCM's APNs relay
(the `message.apns` block of the FCM v1 payload). The only outbound hosts are
`fcm.googleapis.com` and Google's OAuth token endpoint. No direct APNs, OneSignal, Expo, Web
Push, VAPID, vendor SDK or second abstraction exists in code.

### 27.6 Pipeline final state

The existing outbound pipeline is the only pipeline: no PUSH queue, worker, scheduler or
cron; one new table (attempt evidence, not a second ledger); no public send endpoint and no
admin/test/resend route.

### 27.7 Contracts, payload, history, migrations

- **Mobile contract frozen:** `POST` / `GET` `/mobile/push-tokens`, `DELETE
  /mobile/push-tokens/{tokenId}`. `PublicPushToken` keeps exactly its 13 public keys and none
  of the 11 forbidden internal fields.
- **Payload frozen:** pointer-only — title, bounded body, and `data.notificationId`,
  `eventType`, `entityType`, `entityId`, `deliveryId`. No deep-link scheme.
- **History:** **B-01e stays ACTIVE.** `NOTIFICATION_HISTORY_CHANNELS` remains
  `['IN_APP','EMAIL','WHATSAPP']`; PUSH history is NOT IMPLEMENTED / DEFERRED.
- **Migrations:** 0334/0335/0336 only; no 0337 was added.

### 27.8 Validation

**RUN** (static, dependency-free — executed in this review):

| Check | Result |
|---|---|
| Redaction executed against 9 credential shapes + length bound | PASS |
| Migration registration parse (files vs imports vs array, order, duplicates) | PASS — 336/336/336 |
| `PublicPushToken` key set vs the frozen 13-key contract | PASS |
| Runtime handler status codes vs OpenAPI (201/400/401, 200/401, 200/400/401/404) | PASS |
| Vendor / second-provider ban scan over `src/` (comments stripped) | PASS |
| Forbidden delivery-claim scan | PASS |
| Credential-material scan over the full CR diff | PASS |
| `skipIfNoTestDatabase` not inverted | PASS |
| Append-only evidence repository (SQL verb census) | PASS |
| `.github/workflows/ci.yml` byte-identical to baseline | PASS — `5e93e2f`, identical at `3cb0581`, `4015d07`, `5bfc55c` and in the worktree; the CR changes **zero** workflow files |
| `git diff --check` | PASS |

**NOT RUN — Class C (environment unavailable):** the DB-backed PUSH suites, mobile push-token
tests, provider/config tests, boundary contract, the directly affected
notification/outbound and OpenAPI tests, and `tsc`. The final-review workspace was
re-provisioned **without `node_modules` and without an npm cache**, and the PostgreSQL
binaries used in PARTs 01–06 shipped inside `node_modules/@embedded-postgres`. Installing
dependencies (`npm ci`) is forbidden by the review mandate, so no runtime, compiler or
database could be started. This is an environment limitation of the review session only —
these suites were executed at PART 06 (`5bfc55c`) with the result **289 tests / 289 pass / 0
fail / 0 skipped** across the 13 PUSH suites, plus `tsc` at the 22-error baseline. No source
file changed after that run, so the recorded result still describes the code being merged.

**Pre-existing (Class B) failures — unchanged, never converted to PASS:** the three baseline
failures recorded in §26.15 (`mobile-cr-regression-contract` PART 08 authoritative ids;
`mobile-openapi-completeness` unique operationId; `mobile-openapi-completeness` `$ref`
resolution), all global OpenAPI debt unrelated to PUSH.

### 27.9 B-03

**B-03 = OPEN / PRE-EXISTING CI-INFRASTRUCTURE LIMITATION / NON-RUNTIME BLOCKER.**

Verified byte-identical: `.github/workflows/ci.yml` is unchanged by this CR. B-03 is a gap in
CI *gating*, not a defect in the implementation — it affects no runtime behaviour, contract
or correctness. Closing it requires granting the GitHub App `workflows` permission and then
adding the 12 ungated PUSH suite paths to the "Remaining DB-backed regression tests" step.
Per the review mandate, no workflow, permission or repository setting was modified, and
**B-03 does not block the pull request.**

### 27.10 Deferred (confirmed still deferred, not defects)

Push notification history; logout / session-revocation hooks; stale-device cleanup; quiet
hours and per-user preferences; Web Push; direct APNs; additional providers; admin
send/test/resend; and device delivered/displayed/read acknowledgement.

### 27.11 Merge readiness

> **CR-BE-PUSH-01 = READY FOR MERGE WITH RECORDED CI LIMITATION**

Not merged by this review.
