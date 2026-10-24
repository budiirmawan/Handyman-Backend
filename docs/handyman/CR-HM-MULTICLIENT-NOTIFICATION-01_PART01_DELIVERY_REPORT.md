# CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 01 DELIVERY REPORT

**Backend notification producer (Handyman assignment events → durable notification pipeline).**

| | |
| --- | --- |
| Repository | `budiirmawan/Handyman-Backend` |
| Branch | `arena/6b721660-handyman-backend` (no PR — FINAL REVIEW gate) |
| Base HEAD | `9a15ad6b6dc61f1501c66a377f5fba7d6386a12a` (PR #57 merged) |
| Implementation commit | `3dc03f29e8b474a5c4d2a664f211fd74c0ffb15e` (code + tests) |
| Delivery date | 2026-10-24 |
| Database used for evidence | disposable **embedded PostgreSQL** (`/tmp/asentra-pg-shared`, port 5432, `trust` auth, db `asentra_test`). **No** staging, **no** Biznet, **no** production. |
| Governance record | [`CR-HM-MULTICLIENT-NOTIFICATION-01_PART01_PRODUCER_AND_GOVERNANCE.md`](./CR-HM-MULTICLIENT-NOTIFICATION-01_PART01_PRODUCER_AND_GOVERNANCE.md) |

---

## 1. ACCEPTANCE CRITERIA — status

| # | Acceptance criterion | Status | Evidence |
| --- | --- | --- | --- |
| A1 | Assignment creation emits ONE durable intent | **PASS** | `tests/handyman-notification-producer-part01.test.ts` — "emits exactly one IN_APP record and one outbound intent for an assignment event" |
| A2 | A retry does NOT duplicate the intent | **PASS** | same suite — "a repeated assignment command does not duplicate the in-app record nor the outbound intent" (in-app dedup index + delivery idempotency key) |
| A3 | Correct tenant/recipient scope verified | **PASS** | same suite — "rejects a recipient whose scope belongs to a different client" / "rejects a building that does not belong to the client" |
| A4 | An invalid recipient is rejected | **PASS** | same suite — "rejects a malformed recipient id before any record is written" |
| A5 | The existing IN_APP delivery flow still works | **PASS** | 121/122 in the BE-26 notification suites (the 1 failure is pre-existing, see §5); `notification-delivery`, `notification-history`, `notification-subscriptions`, `notification-templates` all green |
| A6 | Typecheck PASS | **PASS** | `npx tsc --noEmit` → no output |
| A7 | No regression to the existing channels (IN_APP / EMAIL / WHATSAPP) | **PASS** | `notification-delivery` + `outbound-intent` + `outbound-delivery-execution` + `outbound-delivery-ledger` + `user-whatsapp-consent` green; the channel vocabulary is unchanged (`('IN_APP','EMAIL','WHATSAPP')`) |
| A8 | The producer gap is reconciled (`emitHandymanNotificationIntent` had no callers) | **PASS** | it is now the ONE producer the assignment authorities call; `grep` shows exactly one production caller of the intent seam |
| A9 | Notification creation is transactional / durable-outbox | **PASS** | every record is written on the caller's executor (`PoolClient` of the assignment transaction) → commits or rolls back with the assignment fact; the outbound intent is a row in the existing durable ledger `notification_outbound_deliveries` — **no** second outbox family (CR-HM-16 §5 / B6 respected) |
| A10 | Client-neutral semantics preserved (event identity, recipient, work order, assignment reference, navigation target) | **PASS** | every emitted record carries all five; no transport/provider/platform token in any payload (see the boundary grep in §4) |
| A11 | WEB_PUSH / FCM_ANDROID delivery NOT implemented; only documented | **PASS** | no push code in this PART; the required extension + the supersession are recorded in the governance doc §4 |
| A12 | No invented assignment events | **PASS** | all 12 event types are the **pre-existing** `source_event_type` values already written by `assignment-response.notifications.ts` |
| A13 | Finance / BAST / Manager CLOSE untouched; no Biznet deploy | **PASS** | diff touches only notification + assignment-response notification files; nothing was deployed |

---

## 2. CHANGED FILES

### 2.1 New

| File | Purpose |
| --- | --- |
| `src/modules/handyman-notifications/handyman-assignment-notification.contract.ts` | The frozen **12-entry assignment vocabulary**: event → meaning / audience (`ASSIGNEE`, `OPERATIONS`) / `templateKey` / navigation target. Channel-free, provider-free, with its own guards. |
| `src/modules/handyman-notifications/handyman-assignment-notification-producer.service.ts` | The producer `emitHandymanAssignmentNotificationIntent(input)`: fail-closed admission, tenant/building/recipient scope, deduplicated IN_APP write, outbound intent emission, fail-safe configuration-error capture. |
| `tests/handyman-notification-producer-part01.test.ts` | The focused PART 01 regression suite (**9 tests**). |
| `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART01_PRODUCER_AND_GOVERNANCE.md` | The governance record: authority decisions, the required WEB_PUSH supersession, the FCM_ANDROID extension, the gap list, the next PART. |
| `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART01_DELIVERY_REPORT.md` | This file. |

### 2.2 Modified

| File | Change |
| --- | --- |
| `src/modules/assignment-responses/assignment-response.notifications.ts` | **Rewritten.** All 12 `notify*` helpers now delegate to the producer (the titles, bodies, metadata and navigation targets are **byte-identical** to the pre-existing ones). The dedup seam is re-exported from the producer file (no barrel import ⇒ no runtime cycle). |
| `src/modules/handyman-notifications/handyman-notification-intent.service.ts` | Admission widened to **CR-HM-16 contract OR assignment contract** (both fail-closed). New options `{ executor?, deliverInApp?, channels? }`. The CR-HM-16 event set and its `SUBSCRIPTION_RULE`/`SLA_ESCALATION_POLICY` audiences are unchanged. |
| `src/modules/handyman-notifications/index.ts` | Barrel re-exports the contract, the intent service and the producer. |
| `src/modules/notification-delivery/notification-delivery.types.ts` | `NotificationDeliveryExecutor = Pick<Pool \| PoolClient,'query'>`; `NotificationDeliveryEvent.recipients?: string[]` (the authoritative audience override). |
| `src/modules/notification-delivery/notification-delivery-event.ts` | The event builder accepts and normalises `recipients` (a malformed recipient UUID → validation error). |
| `src/modules/notification-delivery/notification-delivery.service.ts` | Executor-aware `deliverInAppNotifications` / `deliverOutboundNotifications` / `findMatchingSubscriptions`; the recipients override wins over the subscription rule. |
| `src/modules/notification-delivery/outbound-delivery-intent.service.ts` | Executor-aware outbound intent emission (same idempotency key, same ledger, same channels). |
| `src/modules/notification-delivery/index.ts` | Exports the new executor type. |
| `src/modules/notification-subscriptions/notification-subscription.repository.ts` / `.service.ts` | Optional executor on the matching lookup (default: the pool). |
| `src/modules/notification-templates/notification-template.repository.ts` / `.service.ts` | Optional executor on the template lookup (default: the pool). |
| `src/modules/notifications/notification.repository.ts` / `.service.ts` | `create` / `recordNotification` accept an optional executor (default: the pool) → the record can be written on the caller's transaction. |

### 2.3 Deliberately NOT changed

| File / area | Why |
| --- | --- |
| `src/modules/handyman-notifications/handyman-notification-contract.ts` | The **frozen 13-entry CR-HM-16 contract** — untouched, byte-for-byte. `WORK_ORDER_ASSIGNED` stays unadmitted. |
| `src/database/migrations/**` | **No schema change.** Migration head stays `0472_handyman_assignment_responses`; next free number `0473` is untouched. |
| `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` (frozen) | The WEB_PUSH supersession is **recorded**, not applied. |
| `tests/push01-*.test.ts`, `tests/mobile-push-delivery-boundary-contract.test.ts` | The permanent PUSH boundary guards — untouched. |
| `docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_PENDING_GAP_REGISTER.md` | It is the **FINAL contract freeze** register (its blocking set is FG-03/FG-04 only). This CR's notification gaps are tracked in the new CR's governance doc, and the freeze register is re-issued only by its owner — it was **not** silently amended here. See §7. |
| `src/modules/finance*`, `src/modules/handyman-bast*`, Manager CLOSE authorities | Out of scope by instruction. |

---

## 3. API CONTRACTS

### 3.1 HTTP surface — UNCHANGED

No route was added, removed or re-shaped. The Mobile Browser/PWA and the Android
APK consume the **same** endpoints as before; the notification payload they
receive is unchanged.

### 3.2 The client-neutral notification contract (unchanged in content, now also durable)

Every assignment notification record carries, for ANY client:

| Element | Source of truth |
| --- | --- |
| **event identity** | `source_event_type` — one of the 12 assignment event types (e.g. `WORK_ORDER_ASSIGNMENT_PENDING`) |
| **recipient** | `recipient_user_id` — the notified user |
| **work order reference** | `metadata.workOrderId` / `metadata.workOrderNumber` |
| **assignment reference** | `metadata.<scope>AssignmentId` + `source_entity_type` (`WORK_ORDER_ASSIGNMENT` / `EXECUTION_SCOPE_ASSIGNMENT` / `INSPECTOR_VISIT_ASSIGNMENT`) + `source_entity_id` |
| **navigation target** | `navigation_target` — `WORK_ORDER_FIELD_WORK` / `EXECUTION_SCOPE_FIELD_WORK` / `INSPECTOR_VISIT_FIELD_WORK` (backend-owned; `null` for `SUPERSEDED`) |

Nothing in the payload names a transport, a provider or a client platform, so the
browser and the APK consume one contract.

### 3.3 New service-level seams (internal, not a public API)

| Seam | Signature |
| --- | --- |
| Producer | `emitHandymanAssignmentNotificationIntent(input: HandymanAssignmentNotificationIntentInput): Promise<HandymanAssignmentNotificationIntentResult>` |
| Producer input | `{ eventType, clientId, buildingId, assignmentTargetType, assignmentId, workOrderId?, recipientUserIds, content, variables?, executor? }` |
| Producer result | `{ eventType, assignmentId, recipientsResolved, recipientsRejected, inAppCreated, inAppSuppressed, outbound, outboundError }` |
| Intent seam (existing, extended) | `emitHandymanNotificationIntent(event, { executor?, deliverInApp?, channels? })` |
| Event (existing, extended) | `NotificationDeliveryEvent.recipients?: string[]` — the **authoritative audience**; an empty array suppresses delivery; a malformed UUID is a validation error |

### 3.4 Behavioural contracts introduced (regression-tested)

1. **Fail-closed admission** — an event type outside the assignment contract ⇒ validation error, **zero** records written.
2. **Scope** — the building must belong to the client; a recipient provably scoped to a *different* client is rejected; a recipient with no tenant scope is allowed (a Handyman field worker may legitimately hold no building context of their own).
3. **Atomicity** — the in-app record and the outbound intents are written on the caller's transaction; a rolled-back assignment leaves no notification and no intent.
4. **Idempotence** — in-app dedup on `notifications_assignment_response_dedup_idx`; outbound dedup on `sha256(sourceEventType|sourceEntityId|channel|recipientUserId|templateKey)` with the ledger's `UNIQUE (client_id, channel, idempotency_key)`.
5. **Fail-safe configuration** — a notification **configuration** failure (e.g. a template whose variables the event cannot satisfy) is captured on `outboundError` and **never** fails the domain command; a **database** failure stays fatal and rolls the transaction back.
6. **Audience vs policy split** — for assignment events the audience is the **fact** (resolved by the assignment authority); the subscription contributes the channel and the template only. Existing (non-assignment) subscribers keep their rule-driven audience unchanged.

---

## 4. TEST EVIDENCE

All runs: `npx tsx --test --test-concurrency=1 <suites>` on the disposable embedded
PostgreSQL, `NODE_ENV=test`, `--test-concurrency=1`.

### 4.1 Green

| Suite | Result |
| --- | --- |
| `tests/handyman-notification-producer-part01.test.ts` (NEW) | **9 / 9 PASS** |
| `tests/handyman-notification-contract-part02.test.ts` (frozen contract guard) | **6 / 6 PASS** |
| `tests/handyman-assignment-response-part02a.test.ts` | **8 / 8 PASS** |
| `tests/handyman-assignment-response-part02b.test.ts` | **5 / 5 PASS** |
| `tests/handyman-assignment-response-part02c.test.ts` | **6 / 6 PASS** |
| `tests/work-order-assignment.test.ts` | PASS |
| `tests/handyman-scope-assignments-api.test.ts` | PASS |
| `tests/handyman-inspector-assignments.test.ts` | PASS |
| `tests/handyman-execution-scope-assignment-service.test.ts` | PASS |
| `tests/handyman-execution-scope-assignments.test.ts` | PASS |
| `tests/handyman-execution-scope-assignment-scope-guard.test.ts` | PASS |
| `tests/notification-subscriptions.test.ts`, `notification-templates.test.ts`, `notification-history.test.ts`, `notification-escalations.test.ts`, `notification-reminders.test.ts`, `notification-secure-links.test.ts` | **PASS** |
| `tests/notification-delivery.test.ts`, `outbound-intent.test.ts`, `outbound-delivery-execution.test.ts`, `outbound-delivery-ledger.test.ts`, `user-whatsapp-consent.test.ts`, `integration-outbox.test.ts` | **PASS** |

Consolidated counts:

* Producer + frozen contract + assignment-response suites → **34 / 34 PASS**
* Assignment authority suites (6 files) → **54 / 54 PASS**
* BE-26 notification + channel suites (10 files) → **121 / 122 PASS** (the 1 failure is pre-existing, §5)
* Outbound ledger / execution / outbox (3 files) → **42 / 42 PASS**
* `npx tsc --noEmit` → **PASS**

### 4.2 The 9 new tests (PART 01 suite)

1. assignment creation emits **exactly one** IN_APP record and one outbound intent;
2. a **repeated** assignment command emits no second in-app record and no second outbound intent (retry-safe);
3. the producer **rejects a malformed recipient id** before any record is written;
4. the producer **rejects a recipient whose scope belongs to a different client**;
5. the producer **rejects a building that does not belong to the client**;
6. the audience is the **assignment fact**, not the subscription rule (the rule points at another user; the intent still goes to the assignee);
7. **a broken notification template never breaks the assignment command** (201, one in-app record, zero outbound intents, `outboundError` reported);
8. the produced record carries the full client-neutral contract (event identity, recipient, work order, assignment reference, navigation target);
9. the assignment event flows through the **reused** chain (the outbound ledger row exists with the expected channel, recipient and idempotency key).

### 4.3 Boundary guards

* `grep` over every changed/new `src/` file for the banned vendor tokens
  `sendPush|deliverPush|pushAdapter|fcm|apns|firebase|onesignal|expo-notifications|web-?push|webpush`
  → **no hit**. This PART does not trip the permanent PUSH boundary guards.
* `tests/push01-part04d-final-integration-closure.test.ts`,
  `tests/push01-part06-closure-and-final-freeze.test.ts`,
  `tests/mobile-push-delivery-boundary-contract.test.ts` → **63 / 66 PASS**; the 3 failures are **pre-existing** (see §5) and are byte-identical on the untouched baseline.

---

## 5. PRE-EXISTING RED TESTS (recorded separately — NOT caused by this PART)

All four were re-run on the **clean baseline** (`git stash -u`, HEAD `9a15ad6`) and
fail **identically** there.

| Suite | Failing test | Baseline check |
| --- | --- | --- |
| `tests/notification.test.ts` | "recordNotification persists the full record (type, recipient, source refs, channel, status, timestamps)" | 14 PASS / 1 FAIL on the untouched baseline ⇒ **pre-existing** |
| `tests/push01-part04d-final-integration-closure.test.ts` | "confirms the final PART 04 migration state: 0334-0336 and no 0337" | 63 PASS / 3 FAIL on the untouched baseline ⇒ **pre-existing** (the migration head is `0472`, far past `0336`; the assertion is a frozen sequence check, not a runtime defect) |
| `tests/push01-part06-closure-and-final-freeze.test.ts` | "closes the migration sequence at 0336 with no duplicate or gap" | idem |
| `tests/push01-part06-closure-and-final-freeze.test.ts` | "records which PUSH suites are still absent from the CI gate (B-03 OPEN)" | idem |

**Disposition:** not fixed here (out of scope, and the CR-BE-PUSH-01 boundary /
migration-sequence guards are frozen). They belong to the FINAL FREEZE baseline-debt
inventory (FG-10 in the freeze register) and to the PUSH CR owner respectively.
No full-suite run was performed, per instruction.

---

## 6. REMAINING NOTIFICATION GAPS

Full table in the governance doc **§5** (G-1 … G-9). Summary:

* **G-1 / G-2 / G-3 (P1)** — no PUSH template channel, no browser subscription authority, no VAPID custody, no Web Push adapter, and the three boundary guards still ban the browser vocabulary. This is exactly the §4 supersession of the governance doc.
* **G-6 (P1)** — the remaining Handyman **lifecycle** events (quotation issued/superseded/expired, permit readiness, request triage, …) are still admitted by the frozen contract but **have no producer**.
* **G-4, G-5, G-7, G-8, G-9 (P2)** — in-app copy ownership vs. client template, the inert subscription rule for assignment events, the two crew events, the missing per-user channel preferences, and the absence of an operational surface for `outboundError`.

---

## 7. NOTES FOR THE FREEZE OWNER

* The FINAL FREEZE pending-gap register was **not** amended by this PART (it is a
  different CR's freeze record and its blocking set is FG-03/FG-04 only). The four
  pre-existing red tests of §5 extend the FG-10 baseline-debt inventory
  (24 tests / 7 suites → **28 tests / 10 suites**). Re-issuing that register is the
  freeze owner's call; this report supplies the evidence.
* `docs/audits/HANDYMAN-BACKEND-GAP-20261023.md` — **referenced by the CR brief but
  ABSENT from this checkout** (the `docs/audits/` directory does not exist). The
  baseline used here is therefore `docs/CR-BE-MOB-01-GAP-MATRIX.md`,
  `docs/CR-BE-PUSH-01_START_GOVERNANCE.md`, `docs/handyman/CR-HM-16_START_GOVERNANCE.md`
  and the code itself. **Reported as a missing baseline input.**
* `MOBILE_API_HANDOFF.md` in this repository does not itself carry the BD-14…BD-21
  notification detail; the mobile handoff is treated as contract-only context and
  was **not** verified against the Handyman-Mobile repository (one-repository rule).

---

## 8. NEXT PART

**PART 02 — MULTI-CLIENT TRANSPORT EXTENSION (WEB_PUSH + FCM_ANDROID).**
Preconditions and the exact delivery list are in the governance doc **§6**: the
§4.3 supersession must be granted and recorded (including the explicit amendment
of the three PUSH boundary guards), the PUSH template channel must be migrated
(migration-0300 precedent; next free number `0473`), and the browser
subscription authority + VAPID custody must be decided by the named owners.
The producer of PART 01 stays the single entry point, so the browser and the APK
consume one client-neutral contract.

**PART 03 — REMAINING HANDYMAN DOMAIN PRODUCERS (G-6, G-7).**

---

## 9. WHAT WAS DELIBERATELY NOT DONE

* No WEB_PUSH and no FCM_ANDROID **delivery** implementation (documented only).
* No change to the frozen `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` and no change
  to the PUSH boundary guards — the supersession is **recorded** for the owner.
* No new notification table, no new outbox family, no new scheduler, no second
  notification stack (CR-HM-16 §5 / B6).
* No migration, no OpenAPI change, no route change, no Finance / BAST / Manager
  CLOSE change, no Biznet deployment, no full-suite run.
* No cross-repository access (Handyman-Mobile was read as contract context only).
