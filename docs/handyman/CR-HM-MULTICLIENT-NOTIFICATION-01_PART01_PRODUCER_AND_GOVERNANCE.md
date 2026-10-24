# CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 01: Backend Notification Producer

**Governance record + producer contract.**
Status: PART 01 IMPLEMENTED on `arena/6b721660-handyman-backend` (no PR yet — FINAL
REVIEW gate). Baseline HEAD: `9a15ad6b6dc61f1501c66a377f5fba7d6386a12a` (PR #57
merged).

---

## 1. The problem this PART closes

The Handyman platform has exactly ONE notification stack (BE-26 / CR-BE-NOTIFY-PROV-01)
but TWO producers of Handyman notification facts, and they were not connected:

| | before PART 01 | after PART 01 |
| --- | --- | --- |
| Assignment events (Work Order, Handyman Execution Scope crew, Handyman Inspector visit) | wrote the `IN_APP` record directly; **never produced an outbound delivery intent** | write the `IN_APP` record **and** produce the durable outbound intent through the reused chain |
| `emitHandymanNotificationIntent` (CR-HM-16 PART 02 seam) | **had no caller at all** | is the ONE producer the assignment authorities call |
| Assignment audience | resolved from the assignment fact | unchanged — resolved from the assignment fact, now **scope-enforced** by the producer |
| Retry / repeated command | in-app dedup only | in-app dedup **plus** the outbound delivery idempotency key |

The CR-HM-16 §7 seam 2 contract is *"Handyman lifecycle events … are the
`sourceEventType` inputs; CR-HM-16 owns event→meaning/recipient/template
contracts; delivery/status/retry stay the reused capability"*. PART 01 realises
that seam for the assignment vocabulary instead of leaving it orphaned.

---

## 2. Authority decisions (recorded, not silent)

### 2.1 The CR-HM-16 PART 02 contract is UNCHANGED

`src/modules/handyman-notifications/handyman-notification-contract.ts` is
**byte-for-byte untouched**: the frozen 13-entry array, the
`HandymanNotificationAudience` union (`SUBSCRIPTION_RULE | SLA_ESCALATION_POLICY`)
and both exported predicates keep their exact behaviour. The frozen guard suite
`tests/handyman-notification-contract-part02.test.ts` was **not modified** and
still passes.

### 2.2 Why the assignment vocabulary is a SEPARATE contract

A CR-HM-16 lifecycle event (quotation issued, permit readiness …) is a
**declarative subject**: a BE-26D subscription can name its audience
(`SUBSCRIPTION_RULE`). An **assignment event is not**: "who must be told that
this Work Order was assigned?" is answered by the assignment fact itself — the
assignee, the superseded assignee, the Operations actors. No static recipient
rule can express that.

So PART 01 adds an **additive, beside-the-frozen** vocabulary:

* `src/modules/handyman-notifications/handyman-assignment-notification.contract.ts`
* `HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT` — 12 entries, the four lifecycle
  moments (`PENDING`, `ACCEPTED`, `DECLINED`, `SUPERSEDED`) of the three
  assignment authorities that already exist.
* Audience authority: `ASSIGNEE` / `OPERATIONS` — the FACT, never a rule.
* Channel-free and provider-free by law (same guard as the frozen contract).

**No event is invented.** Every one of the 12 event types is ALREADY the
`source_event_type` of an assignment notification written by
`src/modules/assignment-responses/assignment-response.notifications.ts`
(`WORK_ORDER_ASSIGNMENT_PENDING`, `EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED`,
`INSPECTOR_VISIT_ASSIGNMENT_SUPERSEDED`, …). The contract names them; it does
not create any.

### 2.3 The seam is now multi-vocabulary (additive)

`emitHandymanNotificationIntent` admits BOTH vocabularies. An event type
outside both is still **fail-closed** (validation error, zero intent). The
CR-HM-16 guard assertion `!isHandymanNotificationEventType('WORK_ORDER_ASSIGNED')`
still holds — `WORK_ORDER_ASSIGNED` (the Work Order *history* event) is
deliberately NOT a notification event; the assignment notification vocabulary
is `WORK_ORDER_ASSIGNMENT_*`.

---

## 3. The producer

`src/modules/handyman-notifications/handyman-assignment-notification-producer.service.ts`
→ `emitHandymanAssignmentNotificationIntent(input)`.

One occurred assignment event → one durable intent, written **on the caller's
transaction**.

### 3.1 Guarantees

| Guarantee | How it is enforced |
| --- | --- |
| **Fail-closed admission** | an event type outside the assignment contract is a validation error and NOTHING is written |
| **Assignment scope** | the event's `assignmentTargetType` must match the contract entry; the record identity is `(recipient, assignment scope, assignment id, event type)` |
| **Tenant scope** | `clientId` is the ASSIGNMENT's own tenant (never caller-asserted); the `buildingId` must resolve to that client (`buildings → properties → clients`) or the producer refuses |
| **Recipient scope** | every recipient must be a valid User UUID (else validation error) and an **ACTIVE** user (else rejected); a recipient whose OWN tenant context (Building contexts ∪ Workforce/Organization contexts) is provably a **different** client is rejected — a cross-tenant recipient is never notified |
| **Atomicity** | every record is written on the caller's executor, so the notification commits or rolls back with the assignment fact. No phantom notification and no phantom intent can survive a rolled-back assignment |
| **No duplicates** | the in-app record is deduplicated on `notifications_assignment_response_dedup_idx` (recipient × assignment scope × assignment id × event type); the outbound intent is deduplicated on the reused delivery idempotency key `sha256(eventType\|entityId\|channel\|recipient\|templateKey)` |
| **Client-neutral semantics** | every emitted record carries: event identity (`source_event_type`), recipient, work order reference, assignment reference and the backend-owned navigation target. Nothing in the payload names a transport, a provider or a client platform |
| **Notification ≠ domain authority** | a notification CONFIGURATION failure (a template whose variables the event cannot satisfy) is recorded on the result and NEVER fails the domain command. A DATABASE failure stays fatal — the transaction rolls back |

### 3.2 The audience / policy split (documented contract)

* The **subscription** owns *which channel* and *which template* apply.
* The **assignment authority** owns *who* the event is about.

`notification_delivery`'s `NotificationDeliveryEvent` therefore gained an
optional `recipients` field (the authoritative audience). When it is present
the delivery chains deliver to exactly those recipients; when it is absent the
BE-26C subscription rule resolves the audience exactly as before. **Existing
callers are unchanged** — only the assignment producer sets it.

### 3.3 Why the in-app chain is not invoked for assignment events

The assignment in-app record is written by the producer, not by the BE-26E
chain, for two reasons:

1. its copy and its navigation target are **assignment facts**, not template
   output;
2. a client IN_APP subscription for the same assignment event would otherwise
   attempt a **second** insert on the same dedup key and fail the assignment
   transaction.

`emitHandymanNotificationIntent(..., { deliverInApp: false })` states this
explicitly. The outbound intent chain still runs.

### 3.4 Additive seams on the reused capability (no behaviour change)

| Seam | Change |
| --- | --- |
| `NotificationDeliveryEvent.recipients` | new optional field: the authoritative audience |
| `normalizeDeliveryEvent` | validates that field (malformed recipient → validation error) |
| `deliverInAppNotifications(event, executor?)` | optional executor (defaults to the pool) |
| `deliverOutboundNotifications(event, channels?, executor?)` | optional executor (defaults to the pool) |
| `recordNotification(input, executor?)` | optional executor |
| `notificationRepository.create(input, q?)` | optional executor |
| `notificationSubscriptionRepository.findMatching(..., q?)` | optional executor |
| `findMatchingSubscriptions(eventType, context?, executor?)` | optional executor |
| `notificationTemplateRepository.findByKey(key, q?)` | optional executor |
| `getActiveTemplateByKey(key, executor?)` | optional executor |

Every one of them is optional and defaults to the previous behaviour, so no
existing caller changes semantics.

---

## 4. Governance supersession REQUIRED (NOT implemented in this PART)

### 4.1 The frozen rejection

`docs/CR-BE-PUSH-01_START_GOVERNANCE.md` **§16.3 "Web Push — OUT OF SCOPE"**
(and §5.2 / D-02) states that no repository evidence places Web Push in the
frozen contract, because the only push registration surface is
`/mobile/push-tokens` with a `platform` CHECK of `ANDROID|IOS`, and no
VAPID / `web-push` / service-worker artefact exists anywhere.

That decision is enforced in CODE by three permanent boundary guards:

* `tests/push01-part04d-final-integration-closure.test.ts` — "keeps every
  permanent PUSH boundary guard in force after PART 04": every `.ts` file under
  `src/modules` (outside `src/modules/push-delivery`) must not contain
  `web-?push` / `webpush`, and must not contain push-provider vocabulary.
* `tests/push01-part06-closure-and-final-freeze.test.ts` — "implements no
  direct APNs, Web Push, OneSignal or Expo transport" (`\bwebpush\b|\bVAPID\b`
  over `src/`) and "confines provider implementation to the governed module".
* `tests/mobile-push-delivery-boundary-contract.test.ts` — "integrates no push
  vendor or provider SDK outside the governed module" (`\bfcm\b|\bapns\b|…`
  over `src/modules`), and the FCM-only rule inside the governed module.

### 4.2 Why a supersession is now REQUIRED (the trigger)

The goal of this CR is **one Backend notification authority serving the Mobile
Browser/PWA AND the Android APK**. A browser PWA cannot use a native FCM/APNs
token: it needs a **browser PushSubscription** (an `endpoint` URL plus `p256dh`
and `auth` keys) and a **VAPID** key pair. The frozen §16.3 decision and the
three guards therefore block the browser half of the stated goal by design.

**This PART does not implement WEB_PUSH, does not implement FCM_ANDROID
delivery, and does not touch the frozen policy or the guards.** It records the
supersession that a follow-on PART must obtain.

### 4.3 The supersession that must be granted (scope of the next PART)

| # | Item | Why it is required |
| --- | --- | --- |
| S-1 | **A browser subscription vocabulary distinct from the native device registration.** `mobile_push_tokens` is a *token* row (`push_token TEXT`, `platform CHECK ('ANDROID','IOS')`). A browser subscription is an *object* (`endpoint` + `p256dh` + `auth`) with a different lifecycle (rotation, expiry, unsubscribe-all). It needs its own table and its own registration route — it must NOT be smuggled into `mobile_push_tokens` as a fake platform value. | data model |
| S-2 | **VAPID key custody.** The FCM adapter has ONE credential model (service account read inside the adapter). VAPID is a SECOND credential model (a key PAIR: public key published to the browser, private key used to sign). Custody must be decided (env-only secret, never persisted, never logged, never returned), mirroring `CR-BE-PUSH-01` §12.2. | security / config |
| S-3 | **A Web Push adapter under the governed provider seam** (`src/modules/push-delivery/`), behind the existing provider-neutral interface, with `noop` as the default provider. | transport |
| S-4 | **Re-scoping of the three boundary guards above.** They currently ban `web-?push` / `vapid` / push-provider vocabulary **everywhere outside** `src/modules/push-delivery`. The supersession must amend them (explicitly, in the same CR that adds the transport) so that the browser vocabulary is legal **only** under the governed adapter module — the same shape as the existing FCM carve-out. It must be an explicit, recorded amendment, never a silent relaxation. | governance |
| S-5 | **A template channel for push.** `notification_templates_channel_check` is `('IN_APP','EMAIL','WHATSAPP')` (migration 0300). **No PUSH template can exist**, therefore the outbound intent chain can never produce a PUSH row today — for the browser AND for the Android APK. The widening is additive and has an exact precedent (migration 0300 / 0335). | schema |
| S-6 | **A delivery-ledger decision for the browser subscription.** The PUSH ledger row addresses the RECIPIENT (`recipient_address = 'user:<userId>'`), never a device (CR-BE-PUSH-01 §10.2) and the fan-out resolves devices at SEND time. The browser subscription must follow the same rule (the ledger row stays device-agnostic; the subscription is selected at send time), otherwise the ledger becomes device-count-dependent and duplicate suppression breaks when a user adds or removes a browser. | architecture |

### 4.4 The required extension for FCM_ANDROID native token registration

Good news, recorded here so the next PART does not re-open it: **the native
Android side of the backend already exists.**

* `mobile_push_tokens` (migration 0235 + 0334) is the **sole** registration
  authority; `platform` already admits `'ANDROID'`.
* `POST /mobile/push-tokens` (BE-25L / CR-BE-PUSH-01 PART 01) is the
  registration route, with device-scoped uniqueness, rotation, deactivation and
  the `INVALID` lifecycle.
* `notification_outbound_deliveries` already admits the `PUSH` channel
  (migration 0335), and `resolvePushFanoutPlan` / `executePushFanout` already
  fan a PUSH intent out over the recipient's ACTIVE devices with per-device
  attempt evidence.

Therefore the FCM_ANDROID extension is **NOT** a new transport and **NOT** a new
platform value (a new `FCM_ANDROID` platform enum would duplicate the existing
`ANDROID` value and split one vocabulary into two):

| # | Item | Status |
| --- | --- | --- |
| F-1 | **A PUSH template channel** (`notification_templates_channel_check` widened with `'PUSH'`, migration-0300 precedent) so a PUSH intent can be produced by the chain at all | **REQUIRED** (same migration as S-5) |
| F-2 | **The Handyman field-worker persona must register its FCM token** through the existing `/mobile/push-tokens` route (platform `ANDROID`) — a Mobile client-contract item (the BD-14…BD-21 handoff), not a new Backend route | **REQUIRED (Mobile side)** |
| F-3 | The assignment event must reach the PUSH channel: with F-1 in place this is a *subscription* configuration (`eventType = WORK_ORDER_ASSIGNMENT_PENDING`, `templateKey` → a PUSH template). The producer already feeds the reused chain, so no new wiring is needed. | **CONFIGURATION** |

---

## 5. Remaining notification gaps (after PART 01)

| ID | Gap | Severity | Owner / next step |
| --- | --- | --- | --- |
| G-1 | No PUSH template channel exists → no PUSH intent can ever be produced (browser AND Android) | P1 | PART 02 (S-5 / F-1) |
| G-2 | No browser subscription authority, no VAPID custody, no Web Push adapter | P1 | PART 02 (S-1…S-4, S-6) |
| G-3 | The three PUSH boundary guards still ban the browser vocabulary everywhere outside the adapter module | P1 | PART 02 (S-4) — explicit recorded amendment |
| G-4 | The assignment in-app copy is domain-owned; a client IN_APP template does NOT override it | P2 | PART 02 — a governed template override for the in-app copy (or an explicit decision to keep the copy domain-owned) |
| G-5 | The subscription's recipient RULE is inert for assignment events (the audience is the fact) | P2 | PART 02 — document/settle the policy model, or add a governed "audience filter" semantic |
| G-6 | The other Handyman lifecycle events (quotation, permit readiness, request triage, …) still have no producer: they are admitted by the frozen contract but nothing emits them | P1 | PART 02 — wire the remaining Handyman domains to the same producer |
| G-7 | Only the four assignment moments are produced; the Handyman *inspection/crew* events of the frozen vocabulary (`HANDYMAN_CREW_LEAD_DESIGNATED`, `HANDYMAN_CREW_MEMBER_ADDED`) are not produced | P2 | PART 02/03 — map them onto the assignment vocabulary instead of duplicating it |
| G-8 | No notification PREFERENCE model (per user, per channel) exists (CR-BE-PUSH-01 D-03, open) | P2 | separate CR |
| G-9 | The producer's outbound step is FAIL-SAFE for configuration errors; a broken template is recorded on the result but is not observable through any public surface | P2 | PART 02 — an operational surface for `outboundError` |

---

## 6. The next PART (PART 02)

**PART 02 — MULTI-CLIENT TRANSPORT EXTENSION (WEB_PUSH + FCM_ANDROID).**

Preconditions for PART 02 to start:

1. The §4.3 supersession (S-1…S-6) is granted and recorded, INCLUDING the
   explicit amendment of the three PUSH boundary guards.
2. The PUSH template channel widening (F-1/S-5) is migrated.
3. The browser subscription authority (S-1) and VAPID custody (S-2) are
   decided by the named owners.

PART 02 delivers: the browser subscription authority + route, the Web Push
adapter under the governed seam, the PUSH template channel, the browser fan-out
at send time, and the FCM_ANDROID registration path for the Handyman
field-worker persona — all still behind the SAME producer, so the browser and
the APK consume ONE client-neutral notification contract.

**PART 03 — REMAINING HANDYMAN DOMAIN PRODUCERS (G-6, G-7).**
