# CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 03: DOMAIN NOTIFICATION PRODUCERS — DELIVERY REPORT

**What was built, what it proves, and what is still open.**

Status: PART 03 IMPLEMENTED on `arena/6b721660-handyman-backend` — **no PR**
(FINAL REVIEW gate). Baseline: `fcc102aec0efa2efe5cfe9fced864b6a5e0df86f`
(PART 02). Date: 2026-10-24. Companion record:
`docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART03_DOMAIN_PRODUCER_GOVERNANCE.md`.

---

## 1. The goal, and how it is met

**Goal:** the real Handyman lifecycle events — request, inspection,
quotation, permit/readiness and crew-change — must reach the ONE existing
notification engine, through the PART 01 producer and the PART 02 transport.

**Met by:** each domain authority now **produces its own notification**, on
its own transaction, right after it journals the fact. Nothing new was built:
the producer is a thin fail-safe wrapper over the PART 01 seam
(`emitHandymanNotificationIntent`), the audience is still the declarative
BE-26D subscription rule, the in-app record and the durable outbound intent
still come from the reused BE-26 / CR-BE-NOTIFY-PROV-01 chains, and the FCM
and Web Push transports are the PART 02 ones, unchanged.

The frozen CR-HM-16 contract is **byte-for-byte untouched** (digest-pinned by
the suite); everything PART 03 needed beyond it lives in an additive contract
**beside** it, exactly as PART 01 did for the assignment vocabulary.

---

## 2. The delivered scope (the 10 items)

| # | Scope item | Status | Where |
| --- | --- | --- | --- |
| 1 | Audit the existing lifecycle event authorities | **DONE** | 12 events traced to their journal row; the certified vocabulary cross-checked — governance §2 |
| 2 | Identify the genuine events that had no producer | **DONE** | 11 certified + 1 sourced-but-uncertified; the sourced-but-uncertified list is explicit — governance §2.1 |
| 3 | Wire request, inspection, quotation, permit/readiness and crew-change events | **DONE** | 18 call sites across 8 domain services — §3.1 |
| 4 | Reuse the PART 01 producer and the PART 02 transport | **DONE** | `handyman-domain-notification.producer.ts` → the PART 01 seam → the reused chains; no new engine |
| 5 | Preserve the frozen CR-HM-16 contract | **DONE** | the file is unchanged; its SHA-256 is pinned by the suite (case 1) |
| 6 | Enforce the tenant / recipient isolation | **DONE** | the fact's own `clientId` + the subscription's client scope + the recipient scope (cases 19, 20) |
| 7 | Preserve the transactional outbox and the dedupe | **DONE** | the intents are written on the domain transaction (case 21); the outbound idempotency key dedupes (case 22) |
| 8 | Test the IN_APP / WEB_PUSH / FCM fan-out | **DONE** | one event → one inbox record → one FCM delivery + one Web Push delivery (case 17) |
| 9 | Preserve the existing channel compatibility | **DONE** | IN_APP / EMAIL / WHATSAPP unchanged (cases 4b, 18); the regression batch is green |
| 10 | Run the typecheck and the focused tests | **DONE** | `npx tsc --noEmit` PASS; the focused suite 26/26 PASS |

---

## 3. What changed in the repository

### 3.1 The domain call sites (8 files, 18 sites)

| Domain service | Events produced |
| --- | --- |
| `src/modules/handyman-requests/handyman-request-triage.service.ts` | `HANDYMAN_REQUEST_TRIAGED` |
| `src/modules/handyman-requests/handyman-request-referral.service.ts` | `HANDYMAN_REFERRAL_CREATED` |
| `src/modules/handyman-requests/handyman-request-cancellation.service.ts` | `HANDYMAN_REQUEST_CANCELLED` |
| `src/modules/handyman-requests/handyman-request-inspection.service.ts` | `HANDYMAN_INSPECTION_RECORDED` |
| `src/modules/handyman-quotations/handyman-quotation-lifecycle.service.ts` | `HANDYMAN_QUOTATION_ISSUED`, `…_SUPERSEDED` (×2), `…_EXPIRED` |
| `src/modules/handyman-scheduling/handyman-permit-readiness.service.ts` | `HANDYMAN_PERMIT_READINESS_CREATED` (×2: create + supersession) |
| `src/modules/handyman-scheduling/handyman-scheduling.service.ts` | `HANDYMAN_SCHEDULING_READINESS_CREATED` (×2) |
| `src/modules/handyman-scheduling/handyman-unit-access.service.ts` | `HANDYMAN_UNIT_ACCESS_READINESS_CREATED` (×2) |
| `src/modules/handyman-providers/handyman-work-crew.service.ts` | `HANDYMAN_CREW_MEMBER_ADDED` (×2), `HANDYMAN_CREW_LEAD_DESIGNATED` (×2) |

Every call site writes the intent on the domain's own `tx`, **after** the
journal row of the same fact, with the fact's own `clientId`.

### 3.2 The new files (2)

* `src/modules/handyman-notifications/handyman-domain-notification.contract.ts`
  — the PART 03 **additive** vocabulary (the one inspection event) and the
  **fact binding** of all twelve events (which notification entity an event
  addresses).
* `src/modules/handyman-notifications/handyman-domain-notification.producer.ts`
  — the producer: a fail-safe wrapper over the PART 01 seam, with the
  domain's executor, the fact's tenant and the contract's entity type.

### 3.3 The changed notification module (2)

* `src/modules/handyman-notifications/handyman-notification-intent.service.ts`
  — **additive admission** of the PART 03 vocabulary (one more branch in
  `resolveAdmittedContract`); the CR-HM-16 contract import and behaviour are
  untouched.
* `src/modules/handyman-notifications/index.ts` — the new exports.

### 3.4 What did NOT change

* The frozen CR-HM-16 contract file — **byte-for-byte**.
* The BE-26 / CR-BE-NOTIFY-PROV-01 delivery chains, the delivery ledger, the
  idempotency key, the retry engine.
* The PART 01 assignment producer and its contract.
* The PART 02 browser transport, the migrations (the head stays `0475`), the
  HTTP surface, the OpenAPI document, `package.json`.
* Every other Handyman lifecycle authority (Finance, BAST, Manager CLOSE,
  the assignment/scope authorities, the SLA engine).

### 3.5 The new focused suite

`tests/handyman-multiclient-notification-part03.test.ts` — **26 cases**.

---

## 4. The test evidence

All runs: `NODE_ENV=test npx tsx --test --test-concurrency=1 <file>`, against
a disposable embedded PostgreSQL (the focused suite starts its own cluster on
port 55587).

### 4.1 The new focused suite — 26/26 PASS

```
# tests 26
# pass 26
# fail 0
```

| # | Case | What it proves |
| --- | --- | --- |
| 1 | the CR-HM-16 contract is byte-for-byte untouched | the frozen file's SHA-256 is pinned; 13 entries; no inspection entry |
| 2 | the PART 03 vocabulary lives beside the frozen contract | exactly one additive entry; twelve fact bindings |
| 3 | every produced event has a real source | each of the twelve event types is journaled AND produced by its domain file |
| 4 | the triage command produces one in-app record and one durable intent | the source event type, the entity type, the tenant, the recipient, the PENDING ledger row |
| 4b | an IN_APP template produces the inbox record and no outbound intent | the in-app channel stays the in-app chain's authority |
| 5 | the inspection command produces its notification | the PART 03 additive vocabulary in production |
| 6 | the referral command produces its notification | the referral path (a specialist-scope diagnosis) |
| 7 | the cancellation command produces its notification — and a replay does not | the replay is the same intent: no second notification |
| 8 | the issuance produces its notification | the quotation version is the entity |
| 9 | the supersession produces its notification for the superseded version | the entity is the superseded VERSION, not the quotation |
| 10 | the expiry produces its notification | the expiry path |
| 11 | the permit readiness produces its notification | the readiness path |
| 12 | the scheduling readiness produces its notification | the timezone is derived from the building, never from the caller |
| 13 | the unit access readiness produces its notification | the readiness path |
| 14 | a supersession is its own notification | the supersession writes a NEW readiness row |
| 15 | the crew creation produces the member and the lead notifications | two events, two entities |
| 16 | a second member and a new lead are their own notifications | the membership / the lead row, never the crew aggregate |
| 17 | one event → one inbox record, one FCM delivery, one Web Push delivery | the PART 02 fan-out, unchanged, on a DOMAIN event |
| 18 | the EMAIL and WHATSAPP channels still work | the channel compatibility |
| 19 | another tenant's subscription never fires | the tenant isolation |
| 20 | the recipient scope keeps a foreign recipient out | the recipient isolation |
| 21 | the intents are written ON the domain transaction | they roll back with it (the transactional outbox) |
| 22 | the outbound idempotency key dedupes a repeated intent | `duplicatesSuppressed = 1`, one ledger row |
| 23 | a notification configuration failure never fails the domain command | the fail-safe: the fact commits, the notification does not |
| 24 | an event nobody subscribed to produces nothing — and never fails | the chain is inert until a client subscribes |
| 25 | an unadmitted event type is refused by the producer | fail-closed admission |

### 4.2 The domain regression batch — no regression

| Suite | Result |
| --- | --- |
| `handyman-request-triage` + `handyman-request-referral` + `handyman-request-inspection` + `handyman-quotation-lifecycle` | **40/40 PASS** |
| `handyman-permit-readiness` + `handyman-scheduling-readiness` + `handyman-unit-access-readiness` + `handyman-work-crew` | **39/40** (1 pre-existing flaky — §5) |

### 4.3 The notification regression batch — no regression

| Suite | Result |
| --- | --- |
| `handyman-notification-producer-part01` (PART 01) + `handyman-multiclient-push-part02` (PART 02) | **45/45 PASS** |
| `notification` + `notification-delivery` + `notification-outbound-intent` + `notification-subscriptions` + `handyman-contract` | **36/37** (1 pre-existing red — §5) |
| `handyman-audit-integration-part03` + `handyman-readiness-api` + `handyman-quotation-decision` + `handyman-crew-worker-admission` | **48/57** (9 pre-existing reds — §5) |

### 4.4 TypeScript

```
npx tsc --noEmit     →  PASS (no errors)
```

---

## 5. The pre-existing red / flaky tests (recorded, NOT fixed)

Every item below was reproduced **on the untouched baseline `fcc102a`** (the
PART 03 changes stashed) and is therefore NOT a PART 03 regression.

| Suite | Test | Nature | Baseline proof |
| --- | --- | --- | --- |
| `tests/notification.test.ts` | "recordNotification persists the full record" | pre-existing red (already recorded in the PART 02 report §5) | baseline-identical |
| `tests/handyman-scheduling-readiness.test.ts` | "9: mutation + journal atomic" | **flaky**: it asserts the order of two journal rows that share one transaction timestamp, tie-broken by a random UUID (`ORDER BY created_at ASC, id ASC`) | **2 of 4 baseline runs fail** (the same assertion); the PART 03 insertion happens after both journal rows and cannot reorder them |
| `tests/handyman-crew-worker-admission.test.ts` | 8 cases | environmental: the suite connects to the shared cluster on port 55521 **without** `migrateUp`, so `handyman_assignment_responses` (migration 0472) is absent there | baseline-identical (the same 8 failures with the PART 03 changes stashed) |
| `tests/handyman-readiness-api.test.ts` | "10: OpenAPI/runtime parity" | pre-existing red: the expected path list is older than the published OpenAPI document (PART 03 publishes no path) | baseline-identical |

---

## 6. The invariants the implementation holds

1. **The frozen CR-HM-16 contract is frozen** — byte-for-byte, digest-pinned.
2. **No invented event** — every produced event has a pre-existing journal row
   written by the authority that owns the fact.
3. **No new engine** — the producer reuses the PART 01 seam; the delivery
   chains, the ledger, the idempotency key, the retry engine and both push
   transports are the reused ones.
4. **A notification never decides** — the producer runs after the fact, in the
   fact's transaction, and writes no lifecycle state.
5. **The tenant is the fact's** — the event carries the domain fact's own
   `clientId`; the subscription's client scope and the recipient scope are
   the isolation boundary; a foreign tenant never receives.
6. **The audience is the rule** — the domain never names a recipient; the
   declarative subscription rule owns the audience, the channel and the copy.
7. **Atomic with the fact** — the intents commit or roll back with the domain
   fact (the transactional outbox).
8. **Dedupe is inherited** — the outbound idempotency key suppresses a
   repeated intent; the ledger and its history are untouched.
9. **Fail-safe** — a notification configuration failure never fails a domain
   command; a database failure rolls the command back.
10. **The occurrence, not the aggregate** — two real occurrences of one event
    on one aggregate are two notifications, never one.
11. **No migration, no HTTP, no dependency, no OpenAPI change.**

---

## 7. Operational notes (for the FINAL REVIEW)

* **A client must subscribe to see anything.** The chain is inert until a
  BE-26D subscription names the event type (and a template with a matching
  channel exists). This is the BE-26D model, unchanged.
* **The template's variables must exist in the event.** A template that asks
  for a variable the event does not carry is a *configuration* failure: the
  notification is skipped and the domain command still succeeds. The
  variables each event carries are in the source (`variables:` at every call
  site) and are pinned by the suite.
* **One subscription ⇒ one inbox record.** The reused BE-26E in-app chain
  writes one record per (subscription × recipient) and mirrors every
  subscription into the inbox, whatever the template's channel; the outbound
  chain adds the durable intent for the template's channel. A client that
  wants both an inbox record and a push therefore configures ONE PUSH
  subscription (one inbox mirror + one push intent), or an IN_APP
  subscription plus a separate channel-specific one — the reused BE-26
  semantics, unchanged by PART 03.
* **No new migration** — the registry head stays `0475`.

---

## 8. Still open (NOT in PART 03)

| Item | Owner |
| --- | --- |
| Ratify `HANDYMAN_INSPECTION_RECORDED` in the certified audit vocabulary, or withdraw the inspection row from the PART 03 scope (governance §3.2) | the CR owner |
| Decide the sourced-but-uncertified events (`HANDYMAN_DIAGNOSIS_RECORDED`, the crew-status events, the readiness-supersession events) | the CR owner |
| The mobile client renders the new notifications (the client contract is unchanged; the notifications arrive through the existing inbox) | CR-HM-18 / CR-HM-17 |
| The BE-26E in-app chain has no dedupe of its own (accepted: every produced fact is a one-shot domain fact) | the BE-26 owner |

---

## 9. Baseline note

The PART 03 work starts from `fcc102aec0efa2efe5cfe9fced864b6a5e0df86f`
(PART 02). `docs/audits/HANDYMAN-BACKEND-GAP-20261023.md`, referenced by the
brief, **does not exist in this checkout**; the gap baseline used instead is
`docs/CR-BE-MOB-01-GAP-MATRIX.md` + `docs/CR-BE-PUSH-01_START_GOVERNANCE.md`
+ `docs/handyman/CR-HM-16_START_GOVERNANCE.md`.

The PART 03 changes are additive and reversible: the frozen contract is
untouched, the seam change is one admission branch, and the domain call sites
are three lines each. Reverting the PART 03 commit restores the PART 02
behaviour exactly.
