# CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 02: WEB_PUSH SUPERSESSION RECORD

**The explicit, by-name supersession S-1 … S-6, APPLIED.**

Status: PART 02 IMPLEMENTED on `arena/6b721660-handyman-backend` (no PR yet — FINAL
REVIEW gate). Baseline HEAD: `a66e4993ef5d5da17b76e7c274e72cadd2df0bd5` (PART 01
pushed). Record created: 2026-10-24.

This document is the record the §16.3-A amendment of
`docs/CR-BE-PUSH-01_START_GOVERNANCE.md` points at. It states, for every
superseded item, **what was frozen, what is now authorised, what was actually
built, and which permanent guard proves it**. Nothing here relaxes a policy
silently: the three permanent boundary guards are **amended, not deleted**, and
each amendment is listed in §5 with its exact before/after.

---

## 1. The audit this PART was built on (scope item 1)

Before anything was written, the ACTUAL notification schema and adapter surface
were re-read in this checkout (not from the brief). The findings, and what each
one forced:

| # | Finding (verified in the repository) | Consequence for PART 02 |
| --- | --- | --- |
| A-1 | There is **ONE** notification engine: BE-26 / CR-BE-NOTIFY-PROV-01 — `notification_templates`, `notification_subscriptions`, `notifications` (inbox), `notification_outbound_deliveries` (ledger), `notification_delivery_attempts`, the intent service, the due-job dispatcher and the claim-before-send retry engine. | No second engine, no second ledger, no second scheduler. The browser transport is a **transport**, plugged into the existing engine. |
| A-2 | The outbound ledger **already** admits the `PUSH` channel (migration `0335`) and the intent service already lists `PUSH` in `OUTBOUND_CHANNELS`. | The engine was push-ready; only the **template channel** was missing (S-5). |
| A-3 | `notification_templates.channel` is constrained by `notification_templates_channel_check = ('IN_APP','EMAIL','WHATSAPP')` (migration `0300`) and by the TS constant `NOTIFICATION_TEMPLATE_CHANNELS`. | A PUSH intent is **unproducible** without S-5. Widened additively by migration `0474`. |
| A-4 | The inbox table `notifications.channel` is constrained to `IN_APP` only. | **Deliberately NOT widened.** A push is not an inbox record. |
| A-5 | The native registration table `mobile_push_tokens` has `platform CHECK('ANDROID','IOS')`, a `push_token` column (an opaque provider token) and the frozen `0334` lifecycle columns. | A browser subscription is a **different object** (endpoint + `p256dh` + `auth`). It cannot be smuggled in as a fake platform value (S-1). |
| A-6 | The native attempt-evidence table `notification_push_deliveries` (migration `0336`) has a `push_token_id` FK to `mobile_push_tokens(id)` and a `platform` column. | The browser half needs its **own** evidence table (S-1). Reusing `0336` is impossible without altering a frozen table. |
| A-7 | The fan-out seam (`resolvePushFanoutPlan` → `executePushFanout`) resolves the recipient's **ACTIVE devices at send time**; the ledger row addresses the RECIPIENT (`recipient_address = 'user:<userId>'`). | The browser subscription is resolved **at send time**, exactly like a device (S-6). The ledger stays device-agnostic. |
| A-8 | The push provider seam is `src/modules/push-delivery/` (`PushAdapter` port, `noop|capture|fcm` resolution, fail-closed in `NODE_ENV=test`, FCM = hand-rolled `fetch` + `node:crypto`, zero new dependencies). | The browser adapter is a **sibling inside the same governed module**, with the same port discipline and the same zero-dependency rule (S-3). |
| A-9 | The VAPID/credential custody: the FCM adapter reads its service-account credentials **at adapter construction only** and never persists or logs them. | VAPID follows the same custody model with a **separate** credential (S-2). |
| A-10 | The claim-before-send retry engine (`outbound-delivery-execution.service.ts`) already handles PUSH: `PENDING|RETRY_SCHEDULED → SENDING`, 5-minute base backoff, 6-hour cap, ±25 % jitter, max 5 attempts, then `EXHAUSTED`; the same engine drives EMAIL and WHATSAPP. | The browser transport reuses the **whole** retry engine. No browser-specific backoff engine was written. |
| A-11 | The outbox is the delivery mechanism (`integration-outbox.test.ts`): the intent is written in the same transaction as the domain fact, and the due-job dispatcher drains the ledger. | "Send only after DB commit" is the existing outbox property, inherited unchanged (scope item 10). |
| A-12 | `docs/audits/HANDYMAN-BACKEND-GAP-20261023.md` — referenced by the CR brief — **does not exist in this checkout**. | The baseline for the audit is this repository's own `docs/CR-BE-MOB-01-GAP-MATRIX.md` + `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` + the code itself. The missing file is reported, not silently substituted. |

---

## 2. The supersession S-1 … S-6, APPLIED

Each row: **the frozen text** → **the authorisation** → **what was built** → **the
guard that proves it**.

### S-1 — a browser subscription vocabulary distinct from the native device registration

* **Frozen:** §16.3 — *"a new platform value is required"*; the `platform`
  CHECK `('ANDROID','IOS')` may not be widened; the registration surface is
  `/mobile/push-tokens`.
* **Authorised:** a **separate** browser registration authority — its own table,
  its own lifecycle, its own route family, its own attempt-evidence table. The
  native table and its CHECK stay frozen.
* **Built:**
  * `src/database/migrations/0473_create_browser_push_subscriptions.ts` —
    `browser_push_subscriptions` (id, `user_id` FK, `device_id`, `endpoint`,
    `p256dh`, `auth`, `status CHECK('ACTIVE','INACTIVE','INVALID')`,
    `registered_at`, `last_seen_at`, `invalidated_at`, `invalidation_reason`,
    timestamps; one ACTIVE row per `(user_id, device_id)`; one ACTIVE row per
    endpoint; the endpoint/p256dh/auth columns are **credential-grade** and
    never leave the backend).
  * `src/modules/browser-push-subscriptions/` — the service, the controller,
    the routes, the types, the invalidation-reconciliation service and the
    telemetry service.
  * `src/database/migrations/0475_create_notification_browser_push_deliveries.ts`
    — `notification_browser_push_deliveries`, the browser attempt-evidence table
    (append-only, references the subscription by id, stores **no** endpoint and
    **no** key material).
  * Routes (`src/modules/browser-push-subscriptions/browser-push-subscription.routes.ts`,
    mounted in `src/routes/index.ts` right after the native token router):
    `POST /mobile/push-subscriptions`, `GET /mobile/push-subscriptions`,
    `DELETE /mobile/push-subscriptions`, `DELETE /mobile/push-subscriptions/:subscriptionId`.
* **Proved by:**
  * `tests/handyman-multiclient-push-part02.test.ts` — "registers the three
    PART 02 migrations and keeps the native shapes frozen" (the native
    `platform` CHECK still admits only `ANDROID`/`IOS`; the native evidence
    table gained **no** browser column; the inbox CHECK is still `IN_APP` only).
  * `tests/mobile-push-delivery-boundary-contract.test.ts` — the browser
    evidence table must stay separate from the frozen native table.

### S-2 — VAPID key custody

* **Frozen:** §12.2 / §16.3 — the transport vocabulary is banned, and the FCM
  credential model is the only one.
* **Authorised:** a **second, separate** custody model. The public key is
  published to browsers; the private key is held by the backend, read **only**
  inside the governed provider module, and never persisted, never logged, never
  returned.
* **Built:** `readBrowserPushConfig()` in
  `src/modules/push-delivery/browser-push-adapter.ts` reads
  `PUSH_BROWSER_VAPID_PRIVATE_KEY` (PEM, EC P-256), `PUSH_BROWSER_VAPID_SUBJECT`
  (a `mailto:`/`https:` contact) and the optional
  `PUSH_BROWSER_VAPID_PUBLIC_KEY` / `PUSH_BROWSER_TTL_SECONDS`. The private key
  is held in the adapter instance only. Config errors mention **field names
  only** — never a value. The public registration payload contains no key
  material at all.
* **Proved by:** `tests/handyman-multiclient-push-part02.test.ts` — "reads the
  VAPID configuration only at the adapter boundary" and "registers, lists and
  revokes a browser subscription of the authenticated user" (the endpoint, the
  `p256dh` and the `auth` value are absent from every response body).

### S-3 — a Web Push adapter under the governed provider seam

* **Frozen:** no Web Push transport anywhere; the provider seam is
  `src/modules/push-delivery/`.
* **Authorised:** a browser transport adapter **inside the existing governed
  module**, behind the existing provider-neutral port, with credential-less
  `noop`/`capture` adapters and the same fail-closed provider resolution.
* **Built:** `src/modules/push-delivery/browser-push-adapter.ts` —
  * `BrowserPushAdapter` port + `BrowserPushSendInput` / `BrowserPushSendResult`
    (the same taxonomy as the native port);
  * `BrowserPushWebPushAdapter` — ES256 VAPID token (RFC 8292, `aud` = the
    endpoint ORIGIN, `exp` ≤ 24 h, `sub` = the contact, raw `r||s` signature),
    RFC 8188 `aes128gcm` content encryption with the RFC 8291 key derivation
    (`HKDF-SHA256` over the ECDH secret + the subscriber auth secret, a
    **per-message ephemeral** key in the record header, the `0x02` delimiter
    byte), the endpoint allow-list, the response classification
    (`201/202` sent, `400` permanent, `401` authentication, `404/410` invalid
    subscription, `429/5xx` retryable), and the same credential redaction;
  * `NoopBrowserPushAdapter` / `CaptureBrowserPushAdapter` — the credential-less
    adapters, identical in role to the native ones;
  * `resolveBrowserPushAdapter()` — **fail-closed**: in `NODE_ENV=test` only the
    credential-less providers resolve; an unknown provider throws; `webpush`
    with a broken configuration throws instead of degrading to a no-op.
  * The implementation uses `node:crypto` only — **no dependency was added** to
    `package.json`.
* **Proved by:** `tests/handyman-multiclient-push-part02.test.ts` — the
  round-trip test decrypts the record with a **simulated browser** (its own
  private key + auth secret) and gets the exact JSON back; the **known-answer
  vector** of an INDEPENDENT implementation of the same standards is asserted
  **byte-for-byte** (and the salt + ephemeral key are proven per-message); the
  no-SDK assertion in `tests/mobile-push-delivery-boundary-contract.test.ts`;
  the no-vendor-dependency assertion in the same file. The full cross-check
  against independent implementations (`http_ece` for RFC 8188/8291, `jws` for
  RFC 8292, `web-push` for the VAPID header) is recorded in the delivery
  report §4.8 — **9/9 PASS**, and the vector is committed so the proof runs
  again on every test run **without any third-party dependency**.

### S-4 — the boundary guards become a CONFINEMENT (not a relaxation)

* **Frozen:** the browser transport vocabulary is **banned everywhere in
  `src/`** by three permanent guards.
* **Authorised:** the ban becomes a **confinement** — the vocabulary is legal
  ONLY inside the governed provider module (and the guards must assert exactly
  that). The APNs / OneSignal / Expo bans stay absolute; the "no push vendor
  dependency" rule stays absolute; the "no push SEND route" ban stays absolute.
* **Built:** see §5 for the exact, per-file amendment. Summary: the browser
  vocabulary is legal in `src/modules/push-delivery/browser-push-adapter.ts`
  and in that module's re-export barrel, and **nowhere else**; the push
  **send** route ban is preserved (the browser routes are *registration*
  surfaces, and the registration module is asserted to contain no send path);
  the vendor SDK bans are unchanged and absolute.
* **Proved by:** `tests/mobile-push-delivery-boundary-contract.test.ts`,
  `tests/push01-part06-closure-and-final-freeze.test.ts`,
  `tests/push01-part05-mobile-contract-and-openapi.test.ts`,
  `tests/push01-part01-device-registration-foundation.test.ts`.

### S-5 — a template channel for push

* **Frozen:** `notification_templates_channel_check = ('IN_APP','EMAIL','WHATSAPP')`
  (migration `0300`) and the TS constant `NOTIFICATION_TEMPLATE_CHANNELS` — so
  **no PUSH intent could ever be produced**, for the browser AND for the APK.
* **Authorised:** widen the template channel vocabulary **additively** with
  `'PUSH'` (the `0300` / `0335` precedent). The inbox CHECK stays `IN_APP` only.
* **Built:** `src/database/migrations/0474_widen_notification_template_channels_for_push.ts`
  (replaces the template CHECK with `('IN_APP','EMAIL','WHATSAPP','PUSH')` — the
  ledger CHECK is untouched, it already admitted `PUSH`);
  `src/modules/notification-templates/notification-template.types.ts`
  (`NOTIFICATION_TEMPLATE_CHANNELS = ['IN_APP','EMAIL','WHATSAPP','PUSH']`);
  the OpenAPI enums in **both** `NotificationTemplate` and the create-request
  schema.
* **Proved by:** `tests/handyman-multiclient-push-part02.test.ts` — "registers
  the three PART 02 migrations and keeps the native shapes frozen" (a PUSH
  template is accepted; the inbox CHECK is still `IN_APP` only);
  `tests/notification-templates.test.ts` — "rejects an unsupported channel and
  accepts the governed channel vocabulary".

### S-6 — the delivery-ledger decision for the browser subscription

* **Frozen:** §10.2 — one ledger row per (channel, recipient); the row
  addresses the RECIPIENT, never a device; the devices are resolved at SEND
  time.
* **Authorised:** confirmed and unchanged — the browser subscription follows
  exactly the same rule. The attempt evidence references the subscription by id
  and stores no endpoint and no key material.
* **Built:** `src/modules/notification-delivery/outbound-push-fanout.service.ts`
  resolves the browser targets next to the native targets **at send time**;
  `src/modules/notification-delivery/outbound-push-dispatch.service.ts` writes
  the browser evidence to the browser evidence table and the native evidence to
  the frozen native table; the roll-up (N targets → 1 ledger transition) and
  the retry engine are shared.
* **Proved by:** `tests/handyman-multiclient-push-part02.test.ts` — "fans one
  ledger row out to the native device AND the browser, with ONE in-app record"
  (one ledger row → one native attempt + one browser attempt; the browser
  evidence contains no endpoint).

---

## 3. F-1 … F-3 — the FCM_ANDROID (Android APK) half

The Android half of the goal needed **no new transport, no new route and no new
platform value**. The Backend side was already complete; PART 02 closed the one
missing link (S-5/F-1) and the rest is a Mobile-client action plus a
configuration.

| # | Item | Status after PART 02 |
| --- | --- | --- |
| F-1 | A PUSH template channel so a PUSH intent can be produced at all | **DONE** — migration `0474` + the TS constant + both OpenAPI enums (S-5) |
| F-2 | The Handyman field worker registers its FCM token | **Backend-ready, Mobile-side action** — the existing `POST /mobile/push-tokens` with `platform = 'ANDROID'` is the whole contract. A new `FCM_ANDROID` platform enum would have split one vocabulary into two, so it was **deliberately not created**. (The Mobile client is contract-only context here; its repository was not read or modified.) |
| F-3 | The assignment event reaches the PUSH channel | **No new wiring needed** — the PART 01 producer already feeds the reused chain, and the chain now admits a PUSH template. Activation is a **subscription configuration** (`eventType = WORK_ORDER_ASSIGNMENT_PENDING`, `templateKey` → a PUSH template). |

---

## 4. The multi-client data flow (one engine, two transports)

```text
Handyman assignment fact
        │  (PART 01 producer, unchanged)
        ▼
notification_outbound_deliveries  ── ONE row per (channel, recipient)   [S-6]
        │  address = user:<userId>          channel = PUSH
        │  ▲ outbox: written in the same transaction as the domain fact
        ▼
claim-before-send retry engine  (outbound-delivery-execution.service.ts)
        │  PENDING|RETRY_SCHEDULED → SENDING, backoff 5 min / 6 h cap / ±25 % jitter, max 5
        ▼
executePushFanout  (the sole provider-invocation seam)
        ├── native target  → mobile_push_tokens (ACTIVE)  → FCM adapter  → notification_push_deliveries  (frozen table)
        └── browser target → browser_push_subscriptions (ACTIVE) → Web Push adapter → notification_browser_push_deliveries  (new table)
        │
        ▼
one rolled-up verdict → ledger transition → operational event
        NOTIFICATION_OUTBOUND_{SENT,FAILED_RETRYABLE,FAILED_PERMANENT,EXHAUSTED}
```

* **Scope item 8 (fan out per registered device without duplicate IN_APP
  records):** the PUSH chain **never writes an inbox row**. The IN_APP record
  is written by the domain producer (PART 01), exactly once, with its own
  dedup key — the two chains are independent, so N push targets can never
  multiply the inbox record. The suite asserts both halves.
* **Scope item 9 (persist attempts, retry and audit):** one immutable attempt
  row per target, the shared retry engine, and the operational events above.
  A subscription proven dead (HTTP 404/410) is retired to `INVALID` with its
  provenance and audited by
  `NOTIFICATION_BROWSER_PUSH_SUBSCRIPTION_INVALIDATED`.
* **Scope item 10 (outbox; send only after DB commit):** inherited unchanged —
  the intent is written inside the domain transaction and the dispatcher drains
  the ledger afterwards.

---

## 5. The boundary-guard amendments (exact)

Every amendment is an **explicit edit inside an existing assertion**. No guard
was deleted, no assertion was removed, and every amendment names the
supersession that authorises it.

| Guard | Assertion | Before | After (S-4 / S-1 / S-5) |
| --- | --- | --- | --- |
| `tests/mobile-push-delivery-boundary-contract.test.ts` | "registers no push send / delivery route" | exactly the 3 native token routes | the 3 native token routes **+ the 4 browser registration routes**, plus a NEW assertion that every push route is a **registration** surface, plus a NEW assertion that the browser registration module contains **no send path** (`fetch(`, `.send(`, the transport factory). The documented push paths grow from 2 to 4. |
| `tests/mobile-push-delivery-boundary-contract.test.ts` | "integrates no push vendor or provider SDK outside the governed module" | the browser vocabulary was legal **nowhere** | the browser vocabulary is legal in `browser-push-adapter.ts` **and in the governed module's re-export barrel** (`index.ts`) and nowhere else; the APNs / OneSignal / Expo ban stays absolute; the "no vendor SDK" assertion on the browser adapter stays; the dependency-name ban gains `web-push` / `vapid`. |
| `tests/mobile-push-delivery-boundary-contract.test.ts` | "adds no push delivery migration" | the exact allow-list | the allow-list gains the three PART 02 migrations (0473/0474/0475) and the additivity assertions (the browser table is separate; `0474` only **replaces** the template CHECK; the browser evidence table references `browser_subscription_id`). |
| `tests/mobile-push-delivery-boundary-contract.test.ts` | published push operation ids | 3 | 7 (3 native + 4 browser); `provider.operationIds` stays empty. |
| `tests/push01-part06-closure-and-final-freeze.test.ts` | "freezes the three public mobile push routes" | 2 documented paths / 3 operation ids | 4 documented paths / 7 operation ids; the frozen properties (authenticated, unique operation ids) are unchanged. |
| `tests/push01-part06-closure-and-final-freeze.test.ts` | "implements no direct APNs, Web Push, OneSignal or Expo transport" | the browser vocabulary was banned over `src/` | the browser vocabulary is **confined** to `src/modules/push-delivery/`; the APNs / OneSignal / Expo bans stay absolute everywhere. |
| `tests/push01-part05-mobile-contract-and-openapi.test.ts` | the published push path set | 2 paths | 4 paths; the browser routes are asserted to carry **no** send path; the browser schema joins the vendor-vocabulary scan. |
| `tests/push01-part01-device-registration-foundation.test.ts` | "leaves the boundary contract guarding every scope PART 01 did not open" | pinned the literal `'only BE-25L token registration routes may exist'` | pins the **surviving** assertions (including the new "registration never delivers" wording) — the route ban SURVIVES, only its wording changed; the exact push-migration list gains 0473/0474/0475 and stays an exact list. |
| `tests/notification-templates.test.ts` | "rejects an unsupported channel (only IN_APP exists)" | rejected `PUSH` | rejects a channel **outside** the governed vocabulary (`SMS`) and **accepts** `PUSH` (S-5). |

**What no amendment touched:** the "no push send route" ban, the "no vendor
SDK / no vendor dependency" bans, the APNs / OneSignal / Expo bans, the
"no second push engine / no second ledger / no second scheduler" bans, the
"push evidence is internal" property, the frozen native table and its CHECK,
the frozen native evidence table, and the whole of `docs/CR-HM-MOB-01-GAP-MATRIX.md`
apart from the NTF-05 row that S-4 names.

---

## 6. The published contracts (browser vs APK — scope item 12)

Two **distinct** client contracts, one engine.

**Mobile Browser (PWA)** — `docs/api/openapi.yaml`, four operations:

| Operation | Route | Meaning |
| --- | --- | --- |
| `registerBrowserPushSubscription` | `POST /mobile/push-subscriptions` | register/rotate this browser's subscription |
| `listBrowserPushSubscriptions` | `GET /mobile/push-subscriptions` | this user's own subscriptions (no endpoint, no keys) |
| `revokeAllBrowserPushSubscriptions` | `DELETE /mobile/push-subscriptions` | revoke every browser of this user |
| `revokeBrowserPushSubscription` | `DELETE /mobile/push-subscriptions/{subscriptionId}` | revoke one browser |

Schemas: `BrowserPushSubscriptionRegistration`,
`BrowserPushSubscriptionRevocationResult`. The responses expose the
subscription **id**, the `deviceId`, the `status` and the timestamps — never the
endpoint, never the keys. Registration is explicitly documented as **not**
delivery: a `201` means "the Backend will try", never "the user was notified".

**Android APK** — unchanged from CR-BE-PUSH-01 PART 01: `POST /mobile/push-tokens`
(`platform: ANDROID`), `GET /mobile/push-tokens`, `DELETE /mobile/push-tokens/{tokenId}`.

**Both** consume the same client-neutral notification contract: the assignment
producer → the shared intent seam → the shared ledger → the shared fan-out.

---

## 7. Evidence

See `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_DELIVERY_REPORT.md`
for the full run table (24/24 in the new focused suite, the four amended guard
suites, and the notification/push regression batch).

---

## 8. What PART 02 did NOT do

* No business **lifecycle authority** was changed (no assignment, Work Order,
  Finance, BAST, Manager CLOSE or Inspector authority was touched).
* No **assignment acknowledgment** and no **arrival challenge** was implemented.
* No **other domain producer** was added (G-6/G-7 of the PART 01 record remain
  open — they are PART 03).
* No **deployment**, no infrastructure, no credential was created, and no
  **PR** was opened (FINAL REVIEW gate).
* No dependency was added to `package.json`; no `npm ci`.
* No second notification engine, ledger, scheduler or backoff engine.
* No public send / test / resend route for any push transport.
* The Mobile repository was **not** read or modified (contract-only context).
