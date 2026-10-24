# CR-HM-MULTICLIENT-NOTIFICATION-01 — PRODUCTION PREREQUISITES

**What must exist before the notification engine is live.** None of it is code —
every item is configuration, an operation, or a client integration.

| | |
| --- | --- |
| **Recorded at** | `404b7c8` — the FINAL REVIEW of the CR |
| **Scope** | the Backend is **complete and certified**; the items below are the **environment**, the **operations** and the **clients** |
| **Companion records** | `..._FINAL_CERTIFICATION.md` §3 (R-3, R-4) · `..._FINAL_REVIEW_GOVERNANCE.md` §7 (the Browser/APK handoffs) · `..._RELEASE_DEBT_REGISTER.md` |
| **Hard rule** | **production push is NOT activated by this CR.** Every item below is a *release* activity performed by its owner, after the merge. |

---

## 0. The activation model — what actually turns notifications on

```text
a produced event  →  the intent (transactional outbox)  →  the subscription rule
   (the domain)       (committed with the fact)            (the audience, the channel)
                          │
                          ├─ IN_APP   → the shared inbox write            (needs: rule + template)
                          ├─ EMAIL   → the reused outbound chain         (needs: rule + template + provider config)
                          ├─ WHATSAPP→ the reused outbound chain         (needs: rule + template + provider config)
                          └─ PUSH    → the reused outbound chain         (needs: rule + template + PUSH provider config
                                                                    + a registered device token OR browser subscription)
```

**The consequence:** the engine is **not** activated by deploying the code. It
is activated when an operator creates a **subscription rule** and a **template**
for an event type — and, for PUSH, when a **credential** and a **client
registration** exist. This is why an unratified event type (the inspection,
§2 of the governance record) is inert rather than exposed.

---

## 1. VAPID secrets and the Web Push provider

| # | Item | Detail |
| --- | --- | --- |
| **P-1.1** | Generate the **VAPID application key pair** | an EC (P-256) key pair for the Web Push identity. The **private** key never leaves the server; the **public** key is published to browsers. |
| **P-1.2** | `PUSH_BROWSER_VAPID_PRIVATE_KEY` | the PEM-encoded EC private key (`BEGIN/END PRIVATE KEY` block). The adapter validates the PEM and the curve and **fails closed** if either is wrong. |
| **P-1.3** | `PUSH_BROWSER_VAPID_SUBJECT` | a `mailto:` (or `https:`) contact for the VAPID identity — required by the push services to identify the sender. |
| **P-1.4** | `PUSH_BROWSER_VAPID_PUBLIC_KEY` *(optional)* | the base64url uncompressed P-256 public key. When absent it is **derived** from the private key. Set it explicitly so the published value is pinned. |
| **P-1.5** | `PUSH_BROWSER_PROVIDER=webpush` | the provider selector. **Fail-closed:** `noop` and `capture` resolve only when `NODE_ENV === 'test'`; an unknown value throws a `ConfigError`. |
| **P-1.6** | `PUSH_BROWSER_TTL_SECONDS` *(optional)* | the push-message TTL. |
| **P-1.7** | `PUSH_BROWSER_ALLOWED_ENDPOINT_HOSTS` *(optional)* | the endpoint-host allow-list — **required** if a private/self-hosted push service is used. |
| **P-1.8** | **Secret custody** | the private key is read **only** inside `src/modules/push-delivery/browser-push-adapter.ts`; it is never persisted, never logged, never returned in an API response, and never echoed in a configuration error (the error names the **variable**, not the value). |

**Owner:** Platform (+ the CR owner for the subject contact).
**Gate:** **G-2**. **Evidence to close:** a successful browser attempt-evidence row (`notification_browser_push_deliveries`) for a real device.

---

## 2. FCM service-account configuration (Android)

| # | Item | Detail |
| --- | --- | --- |
| **P-2.1** | Firebase project + service account | a service account with the FCM send role. |
| **P-2.2** | `PUSH_FCM_PROJECT_ID` | the Firebase project id. |
| **P-2.3** | `PUSH_FCM_CLIENT_EMAIL` | the service-account client email. |
| **P-2.4** | `PUSH_FCM_PRIVATE_KEY` | the PEM service-account private key. |
| **P-2.5** | `PUSH_PROVIDER=fcm` | the native provider selector — **fail-closed** exactly like the browser one. |
| **P-2.6** | `PUSH_FCM_API_BASE_URL` *(optional)* | defaults to `https://fcm.googleapis.com`. |
| **P-2.7** | `PUSH_FCM_TOKEN_URI` *(optional)* | defaults to `https://oauth2.googleapis.com/token`. |
| **P-2.8** | **Credential custody** | read **only** inside `src/modules/push-delivery/fcm-push-adapter.ts`; `src/config/env.ts` reads only the `PUSH_PROVIDER` discriminator. The native platform CHECK stays `ANDROID\|IOS` — a browser is **never** a fake platform value. |

**Owner:** Platform (+ the CR owner). **Gate:** **G-3**.
**Evidence to close:** a ledger row in `notification_outbound_deliveries` for a real device with a real outcome.

---

## 3. PUSH template and subscription activation

| # | Item | Detail |
| --- | --- | --- |
| **P-3.1** | **Template rows** | one template per produced event type, keyed `HANDYMAN_<EVENT>` (the convention of the frozen contract). The template's channel set decides which channel the rule can deliver; the migration `0474` widened the template channel CHECK to `IN_APP, EMAIL, WHATSAPP, PUSH`. A template that is **not ACTIVE** yields no delivery (the rule stays ACTIVE for when it is re-enabled). |
| **P-3.2** | **Subscription rules** | one BE-26D rule per event type per tenant: the **audience** (recipient rule + scope), the **channel**, the **template key**. The rule is what creates the audience — the domain never names a recipient. |
| **P-3.3** | **Tenant scoping** | a rule may be scoped to a `client_id` / `building_id`; the matcher applies `client_id IS NULL OR client_id = <the event's tenant>` and the same for the building. A rule of another tenant can therefore never match an event. |
| **P-3.4** | **Order of operations** | the templates **and** the rules must exist **before** the first real fan-out — otherwise the event produces an intent that matches no rule and is simply not delivered (a silent no-op, not an error). |
| **P-3.5** | **The inbox stays IN_APP-only** | a PUSH never appears in the inbox and never in the notification-history channels (`IN_APP, EMAIL, WHATSAPP`). Product and client expectations must reflect this. |

**Owner:** Operations. **Gate:** **G-4** (rules) and **G-5** (templates).
**Evidence to close:** a rule + template pair that produces a delivered notification for one tenant — and a **negative** check that another tenant's rule does **not** receive it.

---

## 4. Mobile Browser client integration

| # | Item | Owner | Evidence |
| --- | --- | --- | --- |
| **P-4.1** | Register the subscription via `POST /mobile/push-subscriptions` (`endpoint`, `keys.p256dh` = 65-byte uncompressed P-256 point, `keys.auth` = 16-byte secret) after the service worker is installed | Web client | the subscription visible in `GET /mobile/push-subscriptions` |
| **P-4.2** | Accept the **VAPID public key** and subscribe with it | Web client | a subscription created with the Backend's VAPID key |
| **P-4.3** | **Re-register when the endpoint rotates** (Chrome rotates endpoints) and revoke the old subscription | Web client | a second registration after a rotation |
| **P-4.4** | Own the **permission prompt** and the user opt-in — the Backend never prompts | Web client | the browser permission state |
| **P-4.5** | Revoke on `410 Gone` / `INVALID_TOKEN` (`DELETE /mobile/push-subscriptions/{subscriptionId}`) | Web client | the revoked subscription's state |
| **P-4.6** | The client never calls a **send** route — **no such route exists** | Web client | the integration contains no send call |

**Owner:** Web client. **Gate:** the browser half of **G-2** / **G-6**.

---

## 5. Android APK client integration

| # | Item | Owner | Evidence |
| --- | --- | --- | --- |
| **P-5.1** | Register the FCM token via `POST /mobile/push-tokens` (`platform: ANDROID`) | Mobile client | the token row visible in `GET /mobile/push-tokens` |
| **P-5.2** | **Re-register on token rotation** and deactivate the old token | Mobile client | the rotation path exercised |
| **P-5.3** | Treat a `201` on registration as *"the Backend will try"*, **not** *"delivered"* — the real outcome is in the delivery ledger | Mobile client | the client's UI does not claim delivery |
| **P-5.4** | Revoke on an invalid token (`DELETE /mobile/push-tokens/{tokenId}`) | Mobile client | the deactivated token's state |
| **P-5.5** | The client never calls a **send** route — **no such route exists** | Mobile client | the integration contains no send call |

**Owner:** Mobile client. **Gate:** the APK half of **G-3** / **G-6**.

---

## 6. Real-device E2E

**A push cannot be proven on a desktop emulator.** The E2E must run on physical
hardware (at least one Android handset with Google Play Services, and one
physical phone with a real browser).

| # | Check | Owner | Evidence |
| --- | --- | --- | --- |
| **P-6.1** | A real event produces **one** IN_APP inbox row for the intended recipient **and no row for another tenant** | QA | the inbox listing of both tenants |
| **P-6.2** | A real event produces **one** PUSH attempt per registered target, with the attempt evidence retained for every outcome | QA | `notification_browser_push_deliveries` (browser) / `notification_outbound_deliveries` (native) |
| **P-6.3** | The **dedupe** holds: replaying the same fact does not produce a second delivery | QA | one ledger row per (channel, recipient, source fact) |
| **P-6.4** | The **retry** holds: a transient provider failure is retried under the bound and ends in a recorded outcome | QA | the attempt history |
| **P-6.5** | **No credential leakage**: the endpoint, the `p256dh` key, the `auth` secret and the FCM token appear in **no** API response, **no** attempt-evidence row, **no** operational event and **no** log line | QA + Security | a sweep of the evidence and the logs |
| **P-6.6** | A **browser endpoint rotation** is survived (re-registration) | QA | the second registration |
| **P-6.7** | A **device token rotation** is survived | QA | the rotation path |

**Owner:** QA + the client owners. **Gate:** **G-6** (with the CI gate).

---

## 7. PostgreSQL migration / rollback evidence

| # | Item | Detail |
| --- | --- | --- |
| **P-7.1** | The chain to apply | `0472_handyman_assignment_responses` → `0473_create_browser_push_subscriptions` → `0474_widen_notification_template_channels_for_push` → `0475_create_notification_browser_push_deliveries` (registry head `0475`, contiguous). |
| **P-7.2** | **Apply before the rollout** | the application that reads the new tables must not start before the migration is applied. |
| **P-7.3** | **Up evidence** | `migrateUp` green on the target database; the four tables exist with the expected columns and constraints; the **template channel CHECK** accepts `PUSH` and still rejects an unknown channel; the inbox channel CHECK is still `IN_APP`-only. |
| **P-7.4** | **Rollback evidence** | the migrations are **additive** — `0473` and `0475` create tables, `0474` widens one CHECK. A rollback drops the two new tables and restores the previous template CHECK; **no existing data is rewritten or lost**. The rollback must be **executed once on a staging copy** and its output attached to the release record. |
| **P-7.5** | **No second ledger** | the migration must not create `notification_outbound_deliveries` — the shared ledger is reused. |
| **P-7.6** | **The 0472 dependency** | the crew-worker-admission harness (debt D-05…D-12) requires `handyman_assignment_responses`; it is absent only in that suite's own unmigrated cluster. |

**Owner:** Platform (DBA). **Gate:** **G-1**.
**Evidence to close:** the up-run log, the constraint verification, and the rollback-run log from staging.

---

## 8. The consolidated gate table

| Gate | Prerequisite | Owner | Blocks |
| --- | --- | --- | --- |
| **G-1** | Migrations 0472 → 0475 applied; up **and** rollback evidence | Platform | the rollout |
| **G-2** | VAPID pair + `PUSH_BROWSER_PROVIDER=webpush` | Platform | browser push |
| **G-3** | FCM service account + `PUSH_PROVIDER=fcm` | Platform | Android push |
| **G-4** | The subscription rules per tenant | Operations | every delivery |
| **G-5** | The template rows (`HANDYMAN_<EVENT>`) | Operations | every delivery |
| **G-6** | The CI gate B-03 + the real-device E2E | CI owner + QA | the release sign-off |
| **G-7** | The 18 release debts triaged to their owners | §the debt register | release hygiene |
| **G-8** | The CR-owner ratification of `HANDYMAN_INSPECTION_RECORDED` | CR owner | the PR (gate P-7 of the governance record) |

**All eight gates are open.** None of them is a code change in this repository.
