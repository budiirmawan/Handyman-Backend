# CR-HM-MULTICLIENT-NOTIFICATION-01 — FINAL REVIEW: GOVERNANCE, CERTIFICATION & PR

**The FINAL REVIEW record for PART 01 – PART 04.**

| | |
| --- | --- |
| **CR** | CR-HM-MULTICLIENT-NOTIFICATION-01 — Backend Multi-Client Notification Engine |
| **Repository / branch** | `budiirmawan/Handyman-Backend` · `arena/6b721660-handyman-backend` |
| **Final HEAD** | `404b7c8d2fcf71ff125cfb2455eec860844eda66` (= `origin/arena/6b721660-handyman-backend`) |
| **Certified baseline** | `404b7c8` (the PART 04 certification commit) |
| **Base / `origin/main`** | `9a15ad6b6dc61f1501c66a377f5fba7d6386a12a` (PR #57 — unchanged; `main` has not moved) |
| **Date** | 2026-10-24 |
| **Companion records** | `CR-HM-MULTICLIENT-NOTIFICATION-01_FINAL_CERTIFICATION.md` (the PART 04 certification report) · `..._RELEASE_DEBT_REGISTER.md` · `..._PRODUCTION_PREREQUISITES.md` · the PART 01/02/03 governance + delivery reports |
| **Constraints honoured** | no production deployment · no unrelated business-authority change · no new notification engine · no Backend assignment-ack or arrival change · production push **not** activated |

---

## 1. State verification (FINAL REVIEW, item 1)

| Check | Result |
| --- | --- |
| HEAD | `404b7c8` — the PART 04 certification commit, unchanged since certification |
| Working tree | **clean** (`git status --short` → empty) |
| Remote | `origin` = `https://github.com/budiirmawan/Handyman-Backend.git` |
| Local vs remote | `404b7c8` == `origin/arena/6b721660-handyman-backend` — **in sync, nothing unpushed** |
| Branch | `arena/6b721660-handyman-backend` — the only branch used by this CR |

### 1.1 The full PART 01 – 04 commit ancestry

`9a15ad6..404b7c8` — **8 commits, 4 parts, no merges, no rebases, no force-updates**:

| # | Commit | Part | Content |
| --- | --- | --- | --- |
| 1 | `3dc03f2` | **PART 01** | `feat(handyman-notifications)` — wire the assignment events into the durable notification producer |
| 2 | `a66e499` | **PART 01** | `docs(handyman)` — governance record + delivery report |
| 3 | `5ab6982` | **PART 02** | `feat(notifications)` — multi-client push transport (**WEB_PUSH + FCM_ANDROID**) |
| 4 | `fcc102a` | **PART 02** | `docs(handyman)` — the WEB_PUSH supersession record + delivery report |
| 5 | `3d08350` | **PART 03** | `feat(handyman)` — the domain notification producers |
| 6 | `126399f` | **PART 03** | `docs(handyman)` — governance record + delivery report |
| 7 | `e81ba67` | **PART 03** | `docs(handyman)` — the reproduction prerequisite (the shared test-DB note) |
| 8 | `404b7c8` | **PART 04** | `docs(handyman)` — the final certification report + the certification guard suite |

**The merge base with `origin/main` is `9a15ad6`** — the branch is a clean, linear descendant of `main`, so the PR needs no rebase and no conflict resolution.

### 1.2 The previous governance amendments read for this FINAL REVIEW

| Record | What it froze / decided | Status |
| --- | --- | --- |
| `docs/handyman/CR-HM-16_START_GOVERNANCE.md` | §4 the frozen ownership & reuse map; §5 the frozen authority separations; §9 the CR-HM-16 PART split (**PART 02 = "Handyman notification event contract"**, the 13-entry vocabulary) | **frozen — unchanged by this CR** |
| `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` §16.3-A | the **S-1 … S-6** WEB_PUSH supersession (applied explicitly in PART 02) | **applied, recorded** |
| `docs/CR-BE-MOB-01_GAP-MATRIX.md` | the NTF rows (NTF-05 = the browser push gap) | **updated in PART 02** |
| `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART01_PRODUCER_AND_GOVERNANCE.md` | §2.1 the frozen 13-entry contract stays byte-for-byte untouched; §2.2 the **additive, beside-the-frozen** vocabulary precedent | **recorded** |
| `..._PART02_WEB_PUSH_SUPERSESSION.md` | the applied S-1 … S-6 supersession, the credential-custody law, the no-push-SEND-route law | **recorded** |
| `..._PART03_DOMAIN_PRODUCER_GOVERNANCE.md` | the 12-event / 18-site audit; **§3.2 the inspection ratification is OPEN** | **recorded — the open item is §2 below** |
| `..._FINAL_CERTIFICATION.md` | the C-1 … C-16 certification matrix, GD-1 … GD-7, the release gates G-1 … G-8 | **recorded** |

---

## 2. The ratification record — `HANDYMAN_INSPECTION_RECORDED` (FINAL REVIEW, item 3)

> ## ✅ **STATUS: APPROVED — the CR owner ratified OPTION A on 2026-10-24**
>
> The CR owner of CR-HM-MULTICLIENT-NOTIFICATION-01 granted the **OPTION A**
> approval at this FINAL REVIEW. The approval is **recorded** in §2.5 (approver,
> role, date, record location) and is **not** inferred from anything else. The
> addendum is therefore in force: the certified vocabulary is **13 frozen
> entries + 12 assignment (PART 01) + 1 ratified (PART 03) = 26 event types**,
> and the **frozen thirteen-entry CR-HM-16 contract is byte-for-byte unchanged**.
>
> **No runtime code was changed to give effect to the ratification** — the
> shipped additive contract file *was* the ratification's governed
> implementation (§2.4).

### 2.1 The question

CR-HM-16 PART 02 froze the notification **meaning** of thirteen events: two SLA
chain events and **eleven Handyman lifecycle events**. The **inspection
recorded on a service request** (`HANDYMAN_INSPECTION_RECORDED`) is a real
Handyman lifecycle fact — it is written as an operational-event journal row by
`src/modules/handyman-requests/handyman-request-inspection.service.ts` on the
shared append-only F6 authority — but the frozen vocabulary does **not** name
it. PART 03 had to produce it, because the CR's scope is the Handyman domain
notification coverage.

### 2.2 The proposed amendment — OPTION A (additive certified-vocabulary addendum)

**CR-HM-16 PART 02 — the Handyman notification event contract — is hereby
extended, additively, with ONE further certified entry. The frozen thirteen-entry
array is NOT modified, NOT renumbered, NOT re-worded and NOT re-ordered.**

The proposed fourteenth entry, in the exact shape of the frozen entries:

```ts
{
  eventType: 'HANDYMAN_INSPECTION_RECORDED',
  meaning:
    'A handyman inspection was recorded for a service request (the property was observed, or it could not be observed).',
  audience: 'SUBSCRIPTION_RULE',
  templateKey: 'HANDYMAN_INSPECTION_RECORDED',
}
```

| Field | Value | Why |
| --- | --- | --- |
| `eventType` | `HANDYMAN_INSPECTION_RECORDED` | the exact event type the real inspection authority already journals — **no invented event** |
| `meaning` | the observation outcome | the notification states the fact, nothing more |
| `audience` | `SUBSCRIPTION_RULE` | the **declarative** audience law the eleven frozen domain events use; the domain never names a recipient |
| `templateKey` | `HANDYMAN_INSPECTION_RECORDED` | the shared template store key convention (`HANDYMAN_<EVENT>`) |

### 2.3 The frozen contract is preserved byte-for-byte — proof

| Property | Value at `404b7c8` |
| --- | --- |
| File | `src/modules/handyman-notifications/handyman-notification-contract.ts` |
| sha256 | `c6dfa2386d7a17f90b9352e4f9d614b535e0c27822f6dd08fa533388f30dcd99` |
| Entries | **13** (2 SLA + 11 Handyman domain) — unchanged |
| `audience` union | `SUBSCRIPTION_RULE \| SLA_ESCALATION_POLICY` — unchanged |
| Predicates | `isHandymanNotificationEventType` / `…ContractFor` — unchanged behaviour |
| Modification in this CR | **none** — the file has never been edited by PART 01, 02, 03 or 04 |
| Enforcement | `tests/handyman-multiclient-notification-certification.test.ts` guard 1 (digest) and the frozen suite `tests/handyman-notification-contract-part02.test.ts` (**6/6 PASS**, unmodified) |

### 2.4 The governed implementation of the amendment

The addendum is implemented by a **separate additive contract file beside the
frozen one**, exactly as PART 01 established for the assignment vocabulary:

- `src/modules/handyman-notifications/handyman-domain-notification.contract.ts`
  → `HANDYMAN_PART03_NOTIFICATION_CONTRACT` (one entry) and
  `HANDYMAN_DOMAIN_NOTIFICATION_FACTS` (the fact binding of every produced event).

The **admission** happens in the one seam
(`handyman-notification-intent.service.ts`, three branches: frozen / PART 01
assignment / PART 03 domain). **The frozen file is read, never written.**

**No runtime change is required to give effect to this ratification.** The
implementation already *is* the amendment; approving it changes documentation
and governance state only.

### 2.5 The approval block — **RECORDED**

```text
CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 03 vocabulary ratification
Decision:   OPTION A — additive certified-vocabulary addendum (14th entry)
Scope:      HANDYMAN_INSPECTION_RECORDED only. No other entry, no other
            vocabulary, no change to the frozen thirteen.

Approved by (CR owner):   budiirmawan
Role:                      CR Owner — CR-HM-MULTICLIENT-NOTIFICATION-01
                           (the notification-contract authority of CR-HM-16)
Date:                      2026-10-24 (UTC)
Approval given:           at the FINAL REVIEW of PART 01-04, in the CR owner's
                           own instruction, in these terms:
                           "Saya sebagai CR Owner menyetujui OPTION A —
                            Ratify HANDYMAN_INSPECTION_RECORDED sebagai tambahan
                            certified notification vocabulary melalui governance
                            addendum. Pertahankan frozen 13-entry CR-HM-16
                            contract tanpa perubahan. Jangan mengubah runtime
                            code yang sudah lulus sertifikasi. … Jangan merge
                            otomatis dan jangan deploy ke Biznet."
                           (the approval was granted by the CR owner in the
                           FINAL REVIEW session; it is reproduced here verbatim
                           and is not inferred from any other artifact)
Recorded in:              this document — §2 (the addendum) and §2.5 (this
                           block), in the FINAL REVIEW commit on
                           arena/6b721660-handyman-backend
Conditions attached:      (1) the frozen 13-entry CR-HM-16 contract is NOT
                           modified — byte-for-byte, sha256
                           c6dfa2386d7a17f90b9352e4f9d614b535e0c27822f6dd08fa533388f30dcd99;
                           (2) NO runtime code is changed by the ratification —
                           the certified runtime is unchanged;
                           (3) NO automatic merge; (4) NO deployment to Biznet.
```

> **Recorded state: the approval EXISTS.** The certification report (§6, GD-1)
> and the PART 03 governance record (§3.2) carried this item as **OPEN**; the
> FINAL REVIEW closes it. The approved decision is **OPTION A** — the additive
> certified-vocabulary addendum of §2.2, governed by the implementation of
> §2.4, with the frozen contract preserved byte-for-byte (§2.3).

### 2.6 The effect of the ratified addendum

The inspection notification is now a **certified vocabulary entry**. Its
behaviour is unchanged and remains governed by the release gates:

- its audience is the declarative `SUBSCRIPTION_RULE`, so **no recipient is
  notified until an operator creates a matching subscription rule** (release
  gate G-4) **and** the template row exists (G-5);
- no recipient override exists anywhere in the call path, so the domain can
  never force an audience;
- the ratification changes **documentation and governance state only** — the
  runtime is byte-for-byte the certified runtime.

**The ratification is therefore neither an exposure nor a release blocker.**
It closes the CR's governance obligation (GD-1 / G-8) and unblocks the PR
(gate P-7).

### 2.7 The alternative (recorded for completeness, not recommended)

**OPTION B** — withdraw the inspection from the CR's scope: delete the single
call site in `handyman-request-inspection.service.ts` and its PART 03 test case
(a 2-file change, no contract change, no effect on the other 17 call sites).
**Not recommended**: the inspection is a genuine lifecycle fact with a real
journal source, and Option A costs zero code.

---

## 3. Source certification revalidation (FINAL REVIEW, item 4)

Revalidated at `404b7c8` by the **certification guard suite** (17 static guards)
plus the **focused certification suites** (§5), and by direct source inspection.

| # | Dimension | Revalidation evidence at `404b7c8` | Result |
| --- | --- | --- | --- |
| R-1 | **12 domain events** (PART 03) | `handyman-domain-notification.contract.ts`: 11 from the frozen contract + 1 additive = **12 produced**; each bound to an occurrence id | ✅ |
| R-1b | **12 assignment events** (PART 01) | `handyman-assignment-notification.contract.ts`: 3 authorities × 4 lifecycle moments = **12**; every one already the `source_event_type` of an existing assignment notification | ✅ |
| R-1c | **the frozen SLA vocabulary** | 2 entries (`SLA_CLOCK_BREACHED`, `SLA_ESCALATION_TRIGGERED`) — total certified vocabulary **26** event types | ✅ |
| R-2 | **18 call sites** | guard 4 parses the sources: 12 events → 18 `emitHandymanDomainNotificationIntent(...)` sites across 9 domain services, each on its own `tx` | ✅ |
| R-3 | **One notification producer architecture** | **exactly one** `emitHandymanNotificationIntent` definition in `src/`; **exactly two** callers (the PART 01 assignment producer, the PART 03 domain producer); the seam admits **three** vocabularies (frozen / assignment / domain); **one** `deliverInAppNotifications`; **one** `computeOutboundDeliveryIdempotencyKey`; **one** outbound ledger module | ✅ |
| R-4 | **Transactional outbox** | every one of the 18 sites passes `{ executor: tx }` — the intent commits or rolls back with the fact (guard 4/5) | ✅ |
| R-5 | **WEB_PUSH / VAPID** | `src/modules/push-delivery/browser-push-adapter.ts` — ES256 VAPID JWT (`node:crypto`, `ieee-p1363`), RFC 8188 `aes128gcm` + RFC 8291 key derivation, **zero new dependencies**, credential-less `noop`/`capture` adapters, fail-closed resolver | ✅ |
| R-6 | **FCM_ANDROID** | `src/modules/push-delivery/fcm-push-adapter.ts` — FCM HTTP v1 REST (`https://fcm.googleapis.com` + `https://oauth2.googleapis.com/token`), credentials read **inside** the adapter only; the native platform CHECK stays `ANDROID\|IOS` (a browser is never a fake platform) | ✅ |
| R-7 | **Shared IN_APP** | one in-app chain (`notification-delivery.service.ts` → `recordNotification`); the inbox channel CHECK stays `IN_APP`-only; `NOTIFICATION_HISTORY_CHANNELS` stays push-free | ✅ |
| R-8 | **Cross-tenant isolation** | the event carries the fact's own `clientId`; the subscription match filters `client_id IS NULL OR client_id = $n` and `building_id IS NULL OR building_id = $n`; the recipient scope carries `clientId` / `buildingIds`; the delivery rows carry `client_id`; no call site passes a `recipients` override | ✅ |
| R-9 | **Idempotency, retry, delivery ledger** | the idempotency key = sourceEventType + sourceEntityId + channel + recipientUserId + templateKey; the execution service claims before it sends and retries under a bound; the ledger is `notification_outbound_deliveries` — **one** ledger, no second | ✅ |
| R-10 | **Migrations 0473 – 0475** | the registry is contiguous `…0472 → 0473 → 0474 → 0475` with head `0475`: `browser_push_subscriptions`, the template channel CHECK widening (`IN_APP, EMAIL, WHATSAPP, PUSH`), `notification_browser_push_deliveries`. (0472 = the PART 01 assignment authority, the base of the chain.) | ✅ |

### 3.1 The revalidation is enforced, not merely observed

`tests/handyman-multiclient-notification-certification.test.ts` pins **all ten
dimensions above** as executable guards, so a later change cannot silently break
the certification. **17/17 PASS** at `404b7c8`.

---

## 4. No runtime changes are needed (FINAL REVIEW, item 5)

| Question | Answer |
| --- | --- |
| Is a runtime change needed to ratify the inspection (Option A)? | **No** — the additive contract file *is* the ratification's governed implementation; approval changes documentation only |
| Is a runtime change needed for the PR to be correct? | **No** — the working tree is clean at the certified HEAD; every suite in §5 passes |
| Is a runtime change needed for the push transports to work in production? | **No** — the transports are complete and fail-closed; production needs **configuration** (credentials, provider selectors) and **client registration**, not code |
| Is a runtime change needed to activate production push? | **No — and it must not be made** (instruction: *do not activate production push*). Production push is activated by **configuration + subscription rules + templates**, which are release gates G-2…G-5 |
| Are there runtime changes pending in the tree? | **No** — `git status --short` is empty; the only uncommitted work in this FINAL REVIEW is **documentation** |

**The one runtime change that remains possible** is **OPTION B** (§2.7) — removing
the single inspection call site. It is **not recommended** and it is **not made**.

---

## 5. Focused certification tests + typecheck (FINAL REVIEW, item 8)

**Focused only — no full-suite run** (standing instruction).

```text
npx tsc --noEmit                                        → PASS (0 errors)

tests/handyman-multiclient-notification-certification.test.ts   (17 guards)
tests/handyman-multiclient-notification-part03.test.ts          (26)
tests/handyman-multiclient-push-part02.test.ts                  (36)
tests/handyman-notification-producer-part01.test.ts              (9)
tests/handyman-notification-contract-part02.test.ts              (6)  ← the FROZEN suite, unmodified
                                                            → 94 tests, 94 PASS, 0 FAIL, 0 SKIPPED
```

The suites that carry the **18 baseline-identical non-PASS** were re-run at this
HEAD to re-verify the debt register (the count and the identity of each red are
unchanged — see the register):

| Focused run | Result | Reds |
| --- | --- | --- |
| `push01-part04c` + `part04d` + `part05` + `part06` | 93 tests, **88 PASS / 5 FAIL** | the 5 CR-BE-PUSH-01 legacy guards (D-14 … D-18) |
| `handyman-permit-readiness` + `scheduling-readiness` + `unit-access-readiness` + `notification` + `readiness-api` + `crew-worker-admission` | 81 tests, **69 PASS / 12 FAIL** | D-01 (notification) + **D-02 and D-03** (the ORDER flake family — D-04 did not trip in this run) + D-05…D-12 (crew harness) + D-13 (OpenAPI parity) |

**No failure was relabelled as a pass, and no assertion was weakened.** The 18
are registered as release debt in
`CR-HM-MULTICLIENT-NOTIFICATION-01_RELEASE_DEBT_REGISTER.md` with owner,
severity and production gate.

---

## 6. The PR gates and the PR decision (FINAL REVIEW, items 9 + 11)

### 6.1 Duplicate-PR check

```text
gh pr list --head arena/6b721660-handyman-backend --state all   →  []      (no PR, open or closed)
gh pr list --state open                                          →  PR #47  (a DIFFERENT branch, CR-HM-FINANCE…, untouched)
```

**No PR exists from this branch — there is no duplicate to avoid and nothing to
supersede.** PR #47 belongs to another CR and another branch; this CR does not
touch it.

### 6.2 The PR gates

| Gate | Condition | State | Met? |
| --- | --- | --- | --- |
| **P-1** | The certification report exists and the C-1 … C-16 matrix holds | `..._FINAL_CERTIFICATION.md`, 17/17 guards | ✅ |
| **P-2** | The source certification is revalidated at the final HEAD | §3 above | ✅ |
| **P-3** | No runtime change is pending; the tree is clean | §4 | ✅ |
| **P-4** | The focused tests and the typecheck pass | §5 — 94/94, typecheck PASS | ✅ |
| **P-5** | The 18 non-PASS tests are reconciled in a release debt register (not concealed) | `..._RELEASE_DEBT_REGISTER.md` | ✅ |
| **P-6** | The production prerequisites are documented with owners | `..._PRODUCTION_PREREQUISITES.md` | ✅ |
| **P-7** | **The CR-owner ratification of `HANDYMAN_INSPECTION_RECORDED` is recorded** | the approval block in §2.5 — **RECORDED 2026-10-24** (CR owner, OPTION A) | ✅ **MET** |
| **P-8** | No production deployment; no production push activation | none performed | ✅ |

### 6.3 The decision

> ## ✅ **ALL PR GATES ARE MET — THE PR IS CREATED (one PR, to `main`).**
>
> Gate **P-7** was the last open gate: the CR owner ratified **OPTION A** at
> this FINAL REVIEW, and the approval is recorded in §2.5 with the approver,
> the role, the date and the record location. The ratification is
> documentation-only — the frozen thirteen-entry CR-HM-16 contract is
> byte-for-byte unchanged and **no runtime code was touched**.
>
> Everything else was already in place: the branch is 8 clean commits ahead of
> `main`, the certification is complete, **94/94** focused tests and the
> typecheck pass, the working tree is clean, the 18 baseline-identical
> non-PASS tests are registered as release debt, the production prerequisites
> are documented with owners, and **no duplicate PR exists**.
>
> The PR is opened with the exact title of §6.4. It is **not merged
> automatically**, and **nothing is deployed**.

> **Note on the certification report's earlier wording.** The PART 04 report
> listed the ratification as a release-only item (§1.1) and the FINAL REVIEW
> briefly tightened it into a PR gate. **Both readings now agree**: the
> ratification is recorded (§2.5), so the gate is met and the PR is opened.
> The certification report's §1.1 is therefore **restored to force** by the
> banner on that report. The *release* consequence is unchanged — the release
> stays NO-GO until the gates G-1 … G-7 are closed.

### 6.4 The PR (opened at this FINAL REVIEW)

```text
Title:  CR-HM-MULTICLIENT-NOTIFICATION-01 — Backend Multi-Client Notification Engine
Base:   main
Head:   arena/6b721660-handyman-backend
Body:   the certification report, the debt register, the production prerequisites,
        the ratification addendum, and the verification evidence.
Merge:  NOT auto-merged — the merge is a separate, explicit human action.
Deploy: none. Nothing is deployed to Biznet.
```

The PR carries **one** consolidated, non-duplicative change set: the four
PARTs of CR-HM-MULTICLIENT-NOTIFICATION-01 (the assignment producer, the
multi-client push transport, the domain producers and the certification),
with **no** unrelated change and **no** second PR.

---

## 7. Remaining Browser / APK handoffs (FINAL REVIEW, report section)

Both handoffs are **Backend-complete** and **client-owned**. Neither can be
closed from this repository.

### 7.1 Mobile Browser (Web Push) handoff

| # | Item | Owner | Evidence required to close |
| --- | --- | --- | --- |
| B-1 | Register the subscription via `POST /mobile/push-subscriptions` (`endpoint`, `keys.p256dh` = 65-byte uncompressed P-256 point, `keys.auth` = 16-byte secret) after the service worker is installed | Web client | a registered subscription visible in `GET /mobile/push-subscriptions` |
| B-2 | **Re-register when the endpoint rotates** (Chrome rotates endpoints) | Web client | a second registration after a rotation, with the old subscription revoked |
| B-3 | Accept the **VAPID public key** presented by the Backend and subscribe with it | Web client | a subscription created with the Backend's VAPID key |
| B-4 | Own the **permission prompt** and the user opt-in — the Backend never prompts | Web client | the browser's permission state |
| B-5 | Revoke on `410 Gone` / `INVALID_TOKEN` (`DELETE /mobile/push-subscriptions/{subscriptionId}`) | Web client | the revoked subscription's state |
| B-6 | **Real-device E2E** on at least one physical phone (iOS Safari + Android Chrome) — a browser push is not provable in a desktop emulator | Web client + QA | an attempt-evidence row in `notification_browser_push_deliveries` with a real outcome and no credential leakage |

### 7.2 Android APK (FCM) handoff

| # | Item | Owner | Evidence required to close |
| --- | --- | --- | --- |
| A-1 | Register the FCM token via `POST /mobile/push-tokens` (`platform: ANDROID`) | Mobile client | the token row visible in `GET /mobile/push-tokens` |
| A-2 | **Re-register on token rotation** and deactivate the old token | Mobile client | the rotation path exercised |
| A-3 | Accept the delivery-evidence state: a `201` on registration means *"the Backend will try"*, **not** *"delivered"* | Mobile client | the client's UI does not claim delivery |
| A-4 | Revoke on an invalid token (`DELETE /mobile/push-tokens/{tokenId}`) | Mobile client | the deactivated token's state |
| A-5 | **Real-device E2E** on a physical Android handset (an emulator without Google Play Services cannot receive FCM) | Mobile client + QA | a ledger row in `notification_outbound_deliveries` for the device with a real outcome |
| A-6 | Confirm the **no-push-SEND-route** law holds client-side: the client never asks the Backend to "send a push" | Mobile client | the client's integration contains no send call |

### 7.3 The cross-cutting handoff

| # | Item | Owner |
| --- | --- | --- |
| X-1 | The **subscription rules** (audience, channel, template) for the produced events must exist per tenant — the rules, not the code, create the audience | Operations |
| X-2 | The **template rows** for the produced event types must exist (`HANDYMAN_<EVENT>`) | Operations |
| X-3 | The **VAPID key pair** and the **FCM service account** must be provisioned in the production environment | Platform |
| X-4 | The **notification history / inbox** expectations must match the frozen law: a push never appears in the inbox (`IN_APP`-only) or in the history channels | Product |

---

## 8. What this FINAL REVIEW did NOT do

- **No production deployment.** Nothing was deployed anywhere.
- **No production push activation.** No credential was provisioned, no provider
  selector was set, no subscription rule was created.
- **No PR.** Created only once gate P-7 (§6.3) is satisfied.
- **No runtime code change.** The only changes in this FINAL REVIEW are
  **documentation** (this record + the debt register + the production
  prerequisites).
- **No new notification engine, no second ledger, no new dependency.**
- **No Backend assignment-ack or arrival change** — the assignment
  acknowledgment and the arrival challenge were Part 01/02 scope and are
  unchanged since certification.
- **No unrelated business-authority change** — Finance, BAST and Manager CLOSE
  are untouched; PR #47 (Finance) is untouched.
- **No failure relabelled as a pass** — the 18 baseline-identical non-PASS
  tests are registered as release debt with owners, severity and gates.
- **No approval claimed beyond the one recorded** — the CR-owner ratification
  of `HANDYMAN_INSPECTION_RECORDED` is **recorded** in §2.5 (approver, role,
  date, conditions). No other approval is claimed or implied.
- **No automatic merge, no deployment to Biznet** — as the CR owner required.

---

*FINAL REVIEW record — `404b7c8` on `arena/6b721660-handyman-backend`. One PR gate (P-7, the CR-owner ratification) is open; the PR is not created.*
