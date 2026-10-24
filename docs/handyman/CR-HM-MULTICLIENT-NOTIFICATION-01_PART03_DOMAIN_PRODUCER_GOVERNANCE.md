# CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 03: DOMAIN NOTIFICATION PRODUCERS — GOVERNANCE RECORD

**The authority decisions of PART 03, recorded before the delivery report.**

Status: PART 03 IMPLEMENTED on `arena/6b721660-handyman-backend` — **no PR**
(FINAL REVIEW gate). Baseline: `fcc102aec0efa2efe5cfe9fced864b6a5e0df86f`
(PART 02). Date: 2026-10-24. Companion record:
`docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART03_DELIVERY_REPORT.md`.

> **Naming note.** The `PART 01/02/03` labels in THIS series
> (CR-HM-MULTICLIENT-NOTIFICATION-01) are NOT the `PART 01…04` labels of the
> CR-HM-16 START governance (`docs/handyman/CR-HM-16_START_GOVERNANCE.md`
> §9). CR-HM-16 PART 02 is the frozen *notification contract*; THIS PART 03
> is the *producers* of the events that contract names.

---

## 1. The problem this PART closes

CR-HM-16 PART 02 froze the notification MEANING of eleven Handyman lifecycle
events and named them as the `sourceEventType` inputs of the BE-26 seam. But
naming an event is not producing it: **no Handyman domain authority emitted a
notification intent for any of those eleven events.** The result was a
notification engine that could carry a Handyman event but never saw one —
except for the assignment vocabulary PART 01 added.

PART 03 closes that gap: **the real lifecycle authorities now produce their
own notifications**, through the PART 01 producer seam and the PART 02
transport. No new engine, no new lifecycle authority, no new channel.

---

## 2. The audit — which events are genuine, and where they come from

Every produced event was traced to a **journal row that already exists** in
the shared F6 append-only authority (`recordOperationalEvent`), written by the
domain authority that owns the fact, inside its own transaction.

| Event | Real source (the journal row) | Occurrence id (the notification entity) |
| --- | --- | --- |
| `HANDYMAN_REQUEST_TRIAGED` | `handyman-request-triage.service.ts` | the triage decision row |
| `HANDYMAN_REFERRAL_CREATED` | `handyman-request-referral.service.ts` | the referral row |
| `HANDYMAN_REQUEST_CANCELLED` | `handyman-request-cancellation.service.ts` | the cancellation row |
| `HANDYMAN_INSPECTION_RECORDED` | `handyman-request-inspection.service.ts` | the inspection row |
| `HANDYMAN_QUOTATION_ISSUED` | `handyman-quotation-lifecycle.service.ts` | the issued version row |
| `HANDYMAN_QUOTATION_SUPERSEDED` | `handyman-quotation-lifecycle.service.ts` | the superseded version row |
| `HANDYMAN_QUOTATION_EXPIRED` | `handyman-quotation-lifecycle.service.ts` | the expired version row |
| `HANDYMAN_PERMIT_READINESS_CREATED` | `handyman-permit-readiness.service.ts` | the permit readiness row |
| `HANDYMAN_SCHEDULING_READINESS_CREATED` | `handyman-scheduling.service.ts` | the scheduling readiness row |
| `HANDYMAN_UNIT_ACCESS_READINESS_CREATED` | `handyman-unit-access.service.ts` | the unit access readiness row |
| `HANDYMAN_CREW_MEMBER_ADDED` | `handyman-work-crew.service.ts` | the crew membership row |
| `HANDYMAN_CREW_LEAD_DESIGNATED` | `handyman-work-crew.service.ts` | the crew lead row (the designation) |

**Eighteen call sites, twelve events.** The extra sites are the *second*
occurrence of the same event in a different path — the readiness supersession
paths (each writes a NEW active readiness row) and the crew creation (which
adds the initial lead member and designates the initial lead in ONE
transaction).

### 2.1 Events that exist but are NOT produced

The certified audit vocabulary (`src/modules/handyman-audit/handyman-audit-contract.ts`)
names sixteen event types: the eleven above plus five SLA events. The domain
authorities also journal these, and PART 03 deliberately does **not** produce
them:

| Not produced | Why |
| --- | --- |
| `HANDYMAN_PERMIT_READINESS_SUPERSEDED`, `HANDYMAN_SCHEDULING_READINESS_SUPERSEDED`, `HANDYMAN_UNIT_ACCESS_READINESS_SUPERSEDED` | Not in the certified notification vocabulary. The supersession is already carried by the NEW `…_CREATED` occurrence (a new readiness row is a new fact). |
| `HANDYMAN_CREW_CREATED`, `HANDYMAN_CREW_STATUS_CHANGED`, `HANDYMAN_CREW_MEMBER_STATUS_CHANGED` | Not in the certified notification vocabulary. |
| `HANDYMAN_DIAGNOSIS_RECORDED` | Not in the certified notification vocabulary, and outside the PART 03 scope list (request / inspection / quotation / permit-readiness / crew-change). |
| `HANDYMAN_INSPECTION_RECORDED` | **Sourced and produced** — but not in the *certified* vocabulary: see §3.2. |

**No event was invented.** A notification can only exist where a domain fact
exists.

---

## 3. The authority decisions (recorded, not silent)

### 3.1 The CR-HM-16 PART 02 contract is UNCHANGED

`src/modules/handyman-notifications/handyman-notification-contract.ts` is
**byte-for-byte identical** to the PART 02 baseline. Its SHA-256
(`c6dfa2386d7a17f90b9352e4f9d614b535e0c27822f6dd08fa533388f30dcd99`) is
pinned by the PART 03 suite, so a future edit to the frozen contract breaks
the build on purpose. The eleven frozen entries, their meanings, their
audiences and their template keys are untouched.

### 3.2 The PART 03 vocabulary lives BESIDE the frozen contract

The handyman inspection recorded on a service request is a **real lifecycle
fact** (the bounded F2 inspection row, journaled as
`HANDYMAN_INSPECTION_RECORDED` on the shared append-only authority) and the
PART 03 scope explicitly includes "inspection" — but it is **not** in the
frozen CR-HM-16 vocabulary.

PART 03 therefore follows the precedent PART 01 established for the assignment
vocabulary: **an additive contract beside the frozen one**
(`src/modules/handyman-notifications/handyman-domain-notification.contract.ts`),
holding exactly ONE entry — `HANDYMAN_INSPECTION_RECORDED`, audience
`SUBSCRIPTION_RULE`, canonical template key `HANDYMAN_INSPECTION_RECORDED`.
The frozen file is not touched, and the additive file follows the same
CHANNEL-FREE / PROVIDER-FREE law.

> **CERTIFICATION ACTION REQUIRED (for the CR owner).** The certified audit
> vocabulary (`handyman-audit-contract.ts`) does not name
> `HANDYMAN_INSPECTION_RECORDED`. PART 03 produces it under the PART 03
> additive contract; the owner must either ratify the event into the
> certified vocabulary or withdraw the inspection row from the PART 03
> scope. **This is the only open governance decision of PART 03**, and it does
> not block the delivery: the event is additive, reversible and inert until a
> client subscribes to it.

### 3.3 The fact binding — the OCCURRENCE, never the aggregate

Each produced event addresses the row that **is** the occurrence, not the
aggregate it belongs to:

* a quotation event addresses the **version** (issued / superseded / expired),
  never the quotation thread — otherwise the second issuance of one quotation
  would collide with the first;
* a readiness event addresses the **readiness row** — the supersession path
  writes a NEW row, so the two occurrences never collapse;
* a crew event addresses the **membership** (added) and the **lead row**
  (designated) — two members of one crew, and two designations of one crew,
  are two notifications each.

This matters mechanically: the outbound idempotency key is
`sourceEventType + sourceEntityId + channel + recipientUserId + templateKey`.
An aggregate-scoped entity id would make the second real occurrence look like
a replay and silently drop it. The binding is therefore **authority data**,
and it lives in the contract — never in a call site.

### 3.4 The audience stays the declarative subscription rule

Every one of the twelve events keeps the frozen contract's `SUBSCRIPTION_RULE`
audience. The domain **never** names a recipient: the BE-26D subscription
rule resolves the audience, and the subscription's client scope is the tenant
boundary. The PART 01 producer's `event.recipients` override exists for the
assignment vocabulary, where the fact itself is the audience ("the assignee
of THIS assignment"); a lifecycle event has no such fact-audience, and using
one would have replaced the certified `SUBSCRIPTION_RULE` authority with a
domain assertion.

### 3.5 The intents are written ON the domain transaction

The producer takes the producing domain's transaction client as its executor.
The in-app record and the durable outbound intent therefore **commit or roll
back with the fact** — the transactional-outbox guarantee of CR-HM-16 §7 seam
2, inherited rather than restated. No scheduler, no poller, no second outbox.

### 3.6 Fail-safe on configuration, fatal on data

A notification **configuration** failure (a template whose variables the event
cannot satisfy, an unknown event type, an invalid template reference) never
fails the domain command: the lifecycle fact is the authority, the
notification only reacts to it, and the failure is reported on the producer's
result. A **database** failure propagates, because a half-written fact must
never be committed. This is the PART 01 fail-safe, unchanged.

### 3.7 What PART 03 does NOT do

* No new notification engine, queue, scheduler, outbox or idempotency service.
* No change to any Handyman lifecycle authority: the producers are reactions
  written after the fact, inside the domain's own transaction.
* No migration (the registry head stays `0475`), no HTTP route, no OpenAPI
  change, no new dependency.
* No change to the existing IN_APP / EMAIL / WHATSAPP behaviour, to the
  delivery ledger, or to the PART 02 browser transport.

---

## 4. The ownership map (who owns what)

| Concern | Owner | Where |
| --- | --- | --- |
| The event MEANING, audience and template key (the eleven frozen events) | CR-HM-16 PART 02 | `handyman-notification-contract.ts` (UNCHANGED) |
| The event MEANING (the inspection) + the fact binding (all twelve) | CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 | `handyman-domain-notification.contract.ts` |
| The producer (the fail-safe wrapper over the PART 01 seam) | CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 | `handyman-domain-notification.producer.ts` |
| The admission of an event to the notification flow | CR-HM-16 PART 02 + PART 01 + PART 03 | `handyman-notification-intent.service.ts` |
| The domain fact (the lifecycle authority) | the Handyman domain modules | the eight domain services |
| The audience, the channel and the copy | BE-26D / BE-26B (the client) | `notification_event_subscriptions` + `notification_templates` |
| The in-app record, the durable intent, the dedupe | BE-26E / CR-BE-NOTIFY-PROV-01 | unchanged |
| The FCM / Web Push transports | CR-BE-PUSH-01 + PART 02 | unchanged |

---

## 5. The invariants PART 03 holds

1. **The frozen contract is frozen.** Byte-for-byte, digest-pinned.
2. **No invented event.** Every produced event has a pre-existing journal
   row, written by the authority that owns the fact.
3. **A notification never decides.** The producer runs after the fact, in the
   fact's transaction, and writes no lifecycle state.
4. **The tenant is the fact's.** The event carries the domain fact's own
   `clientId`; the subscription's client scope and the recipient scope are
   the isolation boundary. A foreign tenant's subscription never fires.
5. **The audience is the rule.** The domain never names a recipient.
6. **Atomic with the fact.** The intents roll back with the domain fact.
7. **Dedupe is inherited.** The outbound idempotency key suppresses a
   repeated intent; the delivery ledger and its history stay untouched.
8. **Fail-safe.** A notification configuration failure never fails a domain
   command.

---

## 6. The remaining gaps (after PART 03)

| Gap | State |
| --- | --- |
| `HANDYMAN_INSPECTION_RECORDED` is not in the certified audit vocabulary | **OPEN** — the CR owner's ratification (§3.2). |
| `HANDYMAN_DIAGNOSIS_RECORDED`, the crew-status events and the readiness-supersession events are sourced but not certified | **OPEN** — they stay unproduced until the vocabulary admits them. |
| The BE-26E in-app chain has no dedupe of its own | **Accepted** — unchanged reused behaviour. Every produced fact is a one-shot domain fact (a unique constraint rejects the second attempt before the producer runs), so a second inbox record cannot be produced through the domain flow. The dedupe that the CR requires lives in the outbound ledger. |
| The mobile client renders the new notifications | **Out of scope** — the client contract is unchanged; the notifications arrive through the existing inbox. |

---

## 7. The next PART

PART 04 (if opened) would be a **certification** PART: ratify or withdraw the
inspection event in the certified vocabulary, and decide the remaining
sourced-but-uncertified events. It would own no new runtime.
