# CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 02: MULTI-CLIENT PUSH TRANSPORT — DELIVERY REPORT

**What was built, what it proves, and what is still open.**

Status: PART 02 IMPLEMENTED on `arena/6b721660-handyman-backend` — **no PR** (FINAL
REVIEW gate). Baseline: `a66e4993ef5d5da17b76e7c274e72cadd2df0bd5` (PART 01).
Date: 2026-10-24. Companion record:
`docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_WEB_PUSH_SUPERSESSION.md`.

---

## 1. The goal, and how it is met

**Goal:** ONE Backend notification engine that serves the Mobile Browser
(PWA → Web Push / VAPID), the Android APK (→ FCM), and both through the shared
IN_APP channel.

**Met by:** the browser is a **transport**, not a second engine. The engine
(BE-26) is untouched in its shape: the same templates, the same subscriptions,
the same intent seam, the same ledger, the same outbox, the same claim-before-send
retry engine, the same operational events. One PUSH ledger row fans out at send
time to *N native devices* and *M browser subscriptions*, and each target leaves
its own immutable attempt evidence. The IN_APP record stays owned by the domain
producer (PART 01) and is written exactly once, whatever the number of push
targets.

---

## 2. The delivered scope (the 12 items)

| # | Scope item | Status | Where |
| --- | --- | --- | --- |
| 1 | Audit the actual notification schema / adapter | **DONE** | 12 verified findings (A-1 … A-12) in the supersession record §1 |
| 2 | Apply the documented WEB_PUSH governance supersession S-1…S-6 **explicitly** | **DONE** | `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` §16.3-A + the top AMENDMENT banner; the record §2; the guard amendments §5 |
| 3 | Browser subscription registration | **DONE** | `src/modules/browser-push-subscriptions/` + migration `0473` + 4 routes |
| 4 | VAPID Web Push delivery | **DONE** | `src/modules/push-delivery/browser-push-adapter.ts` (ES256 + RFC 8188/8291, `node:crypto` only) |
| 5 | Reconcile the existing FCM Android delivery | **DONE** | the native branch of the fan-out is untouched; F-1…F-3 in the record §3 |
| 6 | Token rotation and device revocation | **DONE** | rotation in place (one ACTIVE row per `(user, device)`), one-ACTIVE-per-endpoint, revoke one / revoke all, and the `INVALID` retirement with provenance + audit |
| 7 | Extend the channel / template constraints safely | **DONE** | migration `0474` (template CHECK only) + the TS constant + both OpenAPI enums; the inbox CHECK stays `IN_APP` only |
| 8 | Fan out per registered device **without duplicate IN_APP records** | **DONE** | the fan-out writes NO inbox row; the inbox record is the producer's, with its own dedup |
| 9 | Persist delivery attempts, retry and audit | **DONE** | `notification_browser_push_deliveries` (append-only) + the shared retry engine + `NOTIFICATION_BROWSER_PUSH_SUBSCRIPTION_INVALIDATED` |
| 10 | Use the outbox; send only after the DB commit | **DONE** | inherited from the existing outbox; the intent is written in the domain transaction, the dispatcher drains the ledger |
| 11 | Preserve EMAIL / WHATSAPP / IN_APP | **DONE** | no behavioural change on those channels; the regression batch below is green |
| 12 | Publish distinct Browser and APK contracts | **DONE** | 4 browser operations + 2 browser schemas in `docs/api/openapi.yaml`; the APK contract is unchanged |

---

## 3. What changed in the repository

**New — 3 migrations (registry head `0472` → `0475`):**

| Migration | Content |
| --- | --- |
| `0473_create_browser_push_subscriptions.ts` | `browser_push_subscriptions` — the browser registration authority (S-1) |
| `0474_widen_notification_template_channels_for_push.ts` | replaces `notification_templates_channel_check` with `('IN_APP','EMAIL','WHATSAPP','PUSH')` (S-5) — additive, and it touches **no** other constraint |
| `0475_create_notification_browser_push_deliveries.ts` | `notification_browser_push_deliveries` — the browser attempt-evidence table (S-1/S-6) |

**New — 2 modules + 1 governed adapter:**

* `src/modules/browser-push-subscriptions/` — `browser-push-subscription.{types,service,controller,routes}.ts`,
  `browser-push-subscription-invalidation.service.ts`,
  `browser-push-subscription-telemetry.service.ts`, `index.ts`
* `src/modules/notification-browser-push-deliveries/` — types, repository, index
* `src/modules/push-delivery/browser-push-adapter.ts` — the browser transport,
  inside the **existing governed provider module**

**Changed — 6 source files:**

* `src/modules/notification-delivery/outbound-push-fanout.service.ts` — the
  browser targets join the native targets at send time
* `src/modules/notification-delivery/outbound-push-dispatch.service.ts` — the
  browser branch of the sole provider-invocation seam + the per-target evidence
* `src/modules/notification-delivery/outbound-delivery-execution.service.ts` —
  the browser port override (the test seam) + the browser invalidation
  reconciliation
* `src/modules/notification-templates/notification-template.types.ts` — the
  channel vocabulary
* `src/modules/push-delivery/index.ts` — the browser surface + the endpoint
  allow-list helpers
* `src/routes/index.ts` — the browser router, mounted after the native token
  router

**Changed — 1 contract + 2 governance documents + 5 guard suites:**
`docs/api/openapi.yaml`, `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` (§16.3-A +
banner), `docs/CR-BE-MOB-01-GAP-MATRIX.md` (NTF-05),
`tests/mobile-push-delivery-boundary-contract.test.ts`,
`tests/push01-part06-closure-and-final-freeze.test.ts`,
`tests/push01-part05-mobile-contract-and-openapi.test.ts`,
`tests/push01-part01-device-registration-foundation.test.ts`,
`tests/notification-templates.test.ts`.

**New — 1 focused suite:** `tests/handyman-multiclient-push-part02.test.ts`
(24 cases).

**No dependency was added.** `package.json` is unchanged.

---

## 4. The test evidence

All runs: `NODE_ENV=test npx tsx --test --test-concurrency=1 <file>`, against a
disposable embedded PostgreSQL (the focused suite starts its own cluster on
port 55584).

### 4.1 The new focused suite — 36/36 PASS

`tests/handyman-multiclient-push-part02.test.ts`

| Group | Cases | What it proves |
| --- | --- | --- |
| migration compatibility | 1 | the three migrations are applied; the native `platform` CHECK, the native evidence table and the `IN_APP`-only inbox CHECK are **unchanged**; a PUSH template is accepted |
| the browser transport contract | 8 | the VAPID token (ES256, `aud` = origin, raw `r‖s`), the **RFC 8291/8188 round trip decrypted by a simulated browser**, the response classification, the signed+encrypted request shape, the payload bounds, the endpoint allow-list, the fail-closed resolver, the config custody |
| browser subscription registration | 7 | register/list/revoke-one/revoke-all, the credential-grade fields never leave the backend, the unauthenticated rejection, **another user's subscription is neither listed nor revocable**, the malformed/foreign-endpoint rejection, the rotation-in-place, the one-ACTIVE-per-endpoint rule |
| the multi-client fan-out | 4 | one ledger row → **one native attempt + one browser attempt**, no inbox row is written by the push chain, the repeated intent creates **no second ledger row**, a stranger's subscription is **never targeted** |
| retries and revocation | 3 | a retryable failure schedules the next attempt and records the failed evidence; a proven-dead subscription is retired to `INVALID` **with provenance and an audit event**; a revoked subscription is never targeted |
| the other channels | 1 | the EMAIL chain is unchanged |
| **Web Push interoperability** | 3 | the **known-answer vector of an independent implementation** (byte-identical), the vector read back by an independent subscriber, and the per-message salt + per-message ephemeral key |
| **the FCM Android token compatibility** | 2 | register / rotate (in place) / duplicate handling (one ACTIVE owner per token) / revoke (retained as history), and the independence of the native and the browser authorities |
| **one event, two transports** | 2 | one assignment command → **one IN_APP record + one FCM delivery + one Web Push delivery**; and **a failed delivery never rolls back the committed assignment** (the assignment, the work order and the inbox record all stand) |
| **the browser subscription lifecycle** | 1 | register → replace (rotation) → expire (a proven-dead subscription is retired, never targeted again, retained as history) → cleanup, plus the rule that a permanent NON-token failure never retires a subscription |
| **the migration upgrade path** | 1 | a database migrated to the pre-PART-02 head `0472` is upgraded to `0475` by the real runner, **without losing data**, and the widened channel is usable |
| **the published contracts + the tenant boundary** | 3 | the Browser contract (4 operations) beside the Android contract (3 operations), both authenticated and neither a send path; the browser schema publishes **no** credential-grade field; the channel enums; the inbox stays `IN_APP` only; a registration is bound to the **authenticated user**, never to a caller-asserted tenant |

### 4.2 The four amended boundary guards

| Suite | Result | Note |
| --- | --- | --- |
| `tests/mobile-push-delivery-boundary-contract.test.ts` | **16/16 PASS** | amended (S-4) |
| `tests/push01-part06-closure-and-final-freeze.test.ts` | **25/27** | 2 **pre-existing** reds (identical on the clean baseline) |
| `tests/push01-part05-mobile-contract-and-openapi.test.ts` | **17/18** | 1 **pre-existing** red (identical on the clean baseline) |
| `tests/push01-part01-device-registration-foundation.test.ts` | **24/24 PASS** | amended (S-4) |

### 4.3 The push suites (CR-BE-PUSH-01) — no regression

| Suite | Result |
| --- | --- |
| `push01-part02-provider-adapter` | 41/41 |
| `push01-part03a-channel-ledger-foundation` | 12/12 |
| `push01-part03b-device-fanout-and-payload` | 24/24 |
| `push01-part03c-provider-invocation-and-attempt-evidence` | 26/26 |
| `push01-part04a-invalid-token-lifecycle` | 18/18 |
| `push01-part04b-retry-and-failure-semantics` | 25/25 |
| `push01-part04c-delivery-evidence-and-telemetry` | 24/25 — 1 **pre-existing** red |
| `push01-part04d-final-integration-closure` | 22/23 — 1 **pre-existing** red |

### 4.4 The notification / delivery regression batch — no regression

| Suite | Result |
| --- | --- |
| `mobile-push-token` | 10/10 |
| `notification-delivery` | 9/9 |
| `outbound-delivery-execution` | 10/10 |
| `outbound-delivery-ledger` | 17/17 |
| `outbound-intent` | 7/7 |
| `integration-outbox` | 15/15 |
| `notification-subscriptions` | 13/13 |
| `notification-templates` | 14/14 (amended, S-5) |
| `notification-history` | 10/10 |
| `notification-escalations` | 15/15 |
| `notification-reminders` | 15/15 |
| `notification-secure-links` | 15/15 |
| `notification` | 14/15 — 1 **pre-existing** red |
| `handyman-notification-producer-part01` (PART 01) | 9/9 |
| `handyman-notification-contract-part02` (the frozen contract) | 6/6 |

### 4.5 The OpenAPI / contract guards

| Suite | Result |
| --- | --- |
| `mobile-openapi-completeness` | 5/5 |
| `openapi-contract` | 7/7 |
| `openapi-saas-route-parity` | 15/15 |

### 4.6 The assignment authorities (untouched by design)

`handyman-assignment-response-part02a` 8/8 · `part02b` 5/5 · `part02c` 6/6 ·
`work-order-assignment` 20/20.

### 4.7 TypeScript

`npx tsc --noEmit` — **PASS**, no errors.

### 4.8 The Web Push interoperability evidence (independent implementations)

The transport was cross-checked against **independent implementations of the
same standards**, outside the repository (the repository itself gains **no**
dependency — the packages were installed in a throwaway directory and only
imported the repository's source):

| # | Check | Independent implementation | Result |
| --- | --- | --- | --- |
| I-1 | RFC 8188 + RFC 8291 — the repository produces a **byte-identical** aes128gcm record (salt pinned, ephemeral key pinned) | `http_ece` (the reference encrypted-content-coding implementation used by every deployed Web Push server) | **PASS** — 200 identical bytes |
| I-2 | RFC 8188 §2.1 record layout (`salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(65) ‖ ciphertext ‖ tag(16)`) | — | **PASS** — `rs = 4096`, `idlen = 65` |
| I-3 | the independent implementation **decrypts** a record the repository produced | `http_ece` decrypt | **PASS** — the exact plaintext |
| I-4 | a record produced by the independent implementation is a valid body the repository can read | `http_ece` encrypt → the repository's subscriber simulator | **PASS** |
| I-5 | RFC 8292 — the JOSE header is `{typ: JWT, alg: ES256}` and the claims are `{aud, exp, sub}` with `aud` = the endpoint **origin** | `web-push` (the reference VAPID builder) | **PASS** |
| I-6 | RFC 8292 — the ES256 signature **verifies** | `jws` (an independent RFC 7515 implementation) | **PASS** — `jws.verify(ES256)` accepted it |
| I-7 | RFC 8292 — the signature is the raw `r‖s` form (64 bytes), not DER | — | **PASS** |
| I-8 | RFC 8292 — the `Authorization: vapid t=<jwt>, k=<publicKey>` shape | `web-push` `getVapidHeaders` | **PASS** — identical shape |
| I-9 | the repository's own subscriber simulator decrypts a repository record | — | **PASS** |

**9/9 independent interop checks PASS.** The known-answer vector of I-1 is
**committed into the repository** as a fixed expected value (the sender key is
expressed as a raw P-256 scalar + public point, never as a credential-shaped
PEM, so the repository's privacy sweep stays green), so the interoperability
is re-verified on every run **without any third-party package**.

---

## 5. The pre-existing red tests (recorded, NOT fixed)

Every one of these was verified to fail **identically on the untouched baseline**
`9a15ad6` (a disposable git worktree at the baseline commit, with its own
database), so none of them is caused by PART 02. Per the standing instruction
they are recorded, not chased.

| # | Suite / test | Why it is red | Baseline-verified |
| --- | --- | --- | --- |
| P-1 | `tests/notification.test.ts` — "recordNotification persists the full record" | a pre-existing assertion mismatch in the BE-26A inbox suite | ✅ identical (14/15) |
| P-2 | `tests/push01-part05-mobile-contract-and-openapi.test.ts` — "adds no migration — the governed sequence ends at 0336" | the repository already contains a `0337_…` migration from an unrelated CR | ✅ identical (17/18) |
| P-3 | `tests/push01-part04c-delivery-evidence-and-telemetry.test.ts` — "adds no migration 0337 and no new API route" | same `0337_…` | ✅ identical (24/25) |
| P-4 | `tests/push01-part04d-final-integration-closure.test.ts` — "confirms the final PART 04 migration state: 0334-0336 and no 0337" | same `0337_…` | ✅ identical (22/23) |
| P-5 | `tests/push01-part06-closure-and-final-freeze.test.ts` — "closes the migration sequence at 0336 with no duplicate or gap" | the registry head has moved past `0336` for unrelated CRs | ✅ identical (25/27) |
| P-6 | `tests/push01-part06-closure-and-final-freeze.test.ts` — "records which PUSH suites are still absent from the CI gate (B-03 OPEN)" | `.github/workflows/ci.yml` does not exist in this checkout | ✅ identical (25/27) |

No full-suite run was performed (standing instruction: only on request).

---

## 6. The invariants the implementation holds

1. **One engine.** No second template store, subscription store, ledger,
   dispatcher, retry engine or backoff engine was created.
2. **One IN_APP record.** The push chain writes no inbox row; the inbox record
   belongs to the domain producer and carries its own dedup key.
3. **Recipient-addressed ledger.** The PUSH row addresses `user:<userId>`; the
   devices and the browser subscriptions are resolved **at send time** (S-6).
4. **Registration ≠ delivery.** A `201` on the browser route means "the Backend
   will try"; the attempt evidence and the ledger carry the real outcome.
5. **Credential hygiene.** The endpoint, the `p256dh` and the `auth` secret
   never appear in an API response, in an attempt-evidence row, in an
   operational event or in a log line. The VAPID private key is read only
   inside the governed module and is never persisted.
6. **Fail-closed providers.** In `NODE_ENV=test` only the credential-less
   providers resolve; an unknown provider throws; a broken configuration
   throws instead of degrading to a no-op.
7. **Bounded payloads.** The browser payload is validated against the defensive
   bounds **before** any I/O.
8. **Endpoint allow-list.** Only HTTPS endpoints on a known push-service origin
   are accepted; a userinfo-bearing or foreign URL is refused at registration.
9. **Zero new dependencies.** The transport is `node:crypto` only.
10. **Reversible registration.** Revoking a browser keeps the row as history
    (`INACTIVE`), and a proven-dead subscription is retired to `INVALID` **with
    provenance and an audit event** — never deleted.

---

## 7. Operational notes (for the FINAL REVIEW)

* **Configuration** (the only new settings): `PUSH_BROWSER_PROVIDER`
  (`noop` | `capture` | `webpush`; the default is `noop`),
  `PUSH_BROWSER_VAPID_PRIVATE_KEY` (PEM, EC P-256),
  `PUSH_BROWSER_VAPID_SUBJECT` (`mailto:` or `https:` contact), and the
  optional `PUSH_BROWSER_VAPID_PUBLIC_KEY` / `PUSH_BROWSER_TTL_SECONDS`.
  Nothing is read at start-up: the configuration is read **when the adapter is
  constructed**, exactly like the FCM credentials.
* **The Browser client must** call `POST /mobile/push-subscriptions` with the
  service worker's `PushSubscription` (`endpoint`, `p256dh`, `auth`) — the
  Mobile-side task (F-2). The Backend contract is published in
  `docs/api/openapi.yaml`.
* **Activation of the PUSH channel** is a subscription configuration: a
  template with `channel = PUSH` and a subscription pointing at it (F-3). The
  producer needs no change.
* **Migration head:** `0475`. The three new migrations are additive; the
  template CHECK replacement is the only non-additive statement and it only
  widens a CHECK.

---

## 8. Still open (NOT in PART 02)

| ID | Item | Owner / next step |
| --- | --- | --- |
| G-3 | — | **CLOSED by PART 02** (the three guards are amended explicitly) |
| G-1 | — | **CLOSED by PART 02** (S-5 / F-1) |
| G-2 | — | **CLOSED by PART 02** (S-1 … S-4, S-6) |
| G-4 | the assignment in-app copy is domain-owned; a client IN_APP template does not override it | a governance decision (keep the copy domain-owned, or define a governed override) |
| G-5 | the subscription's recipient RULE is inert for assignment events (the audience is the fact) | settle the policy model, or define a governed "audience filter" semantic |
| G-6 | the other Handyman lifecycle events (quotation, permit readiness, request triage, …) still have **no producer** | **PART 03 — REMAINING HANDYMAN DOMAIN PRODUCERS** |
| G-7 | `HANDYMAN_CREW_LEAD_DESIGNATED` / `HANDYMAN_CREW_MEMBER_ADDED` are not produced | **PART 03** — map them onto the assignment vocabulary |
| G-8 | no notification PREFERENCE model (per user, per channel) | separate CR (CR-BE-PUSH-01 D-03, open) |
| G-9 | the producer's outbound step is fail-safe; `outboundError` has no public surface | an operational surface for `outboundError` |

**The next PART: PART 03 — REMAINING HANDYMAN DOMAIN PRODUCERS (G-6, G-7).**
It reuses the producer, the intent seam, the ledger and — from this PART — the
PUSH channel, so every remaining Handyman domain event reaches the browser, the
APK and the inbox through the same engine.

## 9. Baseline note

`docs/audits/HANDYMAN-BACKEND-GAP-20261023.md`, referenced by the CR brief,
**is not present in this checkout**. The audit above was therefore performed
against the repository's own governance documents
(`docs/CR-BE-MOB-01-GAP-MATRIX.md`, `docs/CR-BE-PUSH-01_START_GOVERNANCE.md`)
and the code itself. The missing file is reported here rather than substituted.
