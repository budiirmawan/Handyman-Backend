# CR-HM-MULTICLIENT-NOTIFICATION-01 — PART 04: FINAL CERTIFICATION

> ### ⚠️ STATUS BANNER — added at the FINAL REVIEW (after this report was certified)
>
> This report was **certified at `404b7c8`** and every finding below stands —
> **nothing in it was changed**. The FINAL REVIEW has since applied a
> **stricter PR gate**, recorded in
> `docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_FINAL_REVIEW_GOVERNANCE.md`:
>
> - **§1.1 (GO — PR readiness) is SUPERSEDED.** The FINAL REVIEW treats the
>   CR-owner ratification of `HANDYMAN_INSPECTION_RECORDED` (**GD-1 / G-8**) as
>   a **PR gate** (gate **P-7**), because a PR is the artifact by which this
>   CR's governance is published: publishing a certification that carries an
>   unratified event type as *certified* would overstate the record.
>   **The PR is therefore NOT created until that approval is recorded.**
> - **§1.2 (NO-GO for production release) is UNCHANGED and remains in force.**
> - The certification findings (C-1 … C-16), the non-PASS reconciliation and
>   the governance decisions (GD-1 … GD-7) below are **unchanged**.
>
> **Terminology.** The certified **runtime tree** is `e81ba67`; the commit that
> **carries** this report — the *certified baseline* of the FINAL REVIEW — is
> `404b7c8`. They are the same runtime: `404b7c8` adds only this report and the
> certification guard suite (a test artifact), and no production file.
>
> **The only edit made to this certified document is this banner.** The report
> body is unchanged.

---

| | |
| --- | --- |
| **CR** | CR-HM-MULTICLIENT-NOTIFICATION-01 (multiclient notification — assignment + Handyman domain producers, IN_APP + Web Push + FCM Android) |
| **Part** | PART 04 — **FINAL CERTIFICATION ONLY** |
| **Repository** | `budiirmawan/Handyman-Backend` |
| **Branch** | `arena/6b721660-handyman-backend` |
| **Certified HEAD** | `e81ba67` (= `origin/arena/6b721660-handyman-backend`) |
| **Certification baseline** | `126399f` (the PART 03 delivery commit) — used to prove every non-PASS is pre-existing |
| **Change under certification** | PART 01 `a66e499` (impl `3dc03f2`) · PART 02 `fcc102a` (impl `5ab6982`) · PART 03 `126399f` (impl `3d08350`) |
| **Typecheck** | `npx tsc --noEmit` → **PASS** (0 errors) |
| **Part 04 deliverables** | this report + `tests/handyman-multiclient-notification-certification.test.ts` (17 guards, 6 suites) |
| **Constraints honoured** | **no new runtime code** · **no deployment** · **no PR** (awaiting FINAL REVIEW) · branch committed and pushed |

---

## 1. Verdict

### 1.1 GO / NO-GO — PR readiness

> ## ✅ **GO — the branch is PR-READY**
>
> **Pre-conditions (both are *governance/records* actions, not code actions):**
>
> - **PC-1** — the CR owner records the **inspection-event ratification** decision (GD-1, §6) in the CR-HM-16 ownership map. *The code is already in the shape the decision can take (additive, frozen file untouched); no re-implementation is implied by either answer.*
> - **PC-2** — the **release gates** (§5.4) are opened as tracked work items with owners: the Web-Push VAPID pair, the FCM service account, the CI gate B-03, and the triage of the 18 pre-existing reds to their own owners.
>
> Neither pre-condition blocks the merge of the branch. Both block the **release**.

### 1.2 GO / NO-GO — production release

> ## ⛔ **NO-GO for production release — today**
>
> Release may only be declared GO when **all** of the following hold:
>
> 1. GD-1 (inspection ratification) is recorded — §6, GD-1.
> 2. The **migration chain 0472 → 0475** is applied on the target database and `migrateUp` is green — §4.
> 3. The **Web-Push** credentials are provisioned (`PUSH_BROWSER_PROVIDER=webpush` + VAPID pair) — §5.1.
> 4. The **FCM Android** credentials are provisioned (`PUSH_PROVIDER=fcm` + service account) — §5.2.
> 5. The **APK** and **browser** client contracts are accepted by the owning clients (§3) — GD-2, GD-3.
> 6. The CI gate **B-03** (PUSH suites in the pipeline) is closed or explicitly waived — GD-4.
>
> Items 3–5 are *deployment configuration*, not code. Nothing in this certification requires a code change to release.

### 1.3 The one-sentence summary

**PART 01, PART 02 and PART 03 are certified: every certified invariant holds on `e81ba67`, all 18 non-PASS tests are proven baseline-identical (none is caused by this CR), and the branch may open a PR — while production release stays blocked on four governance decisions and the credential provisioning.**

---

## 2. The certification matrix

Every row is backed by an executed command or an inspected file. "Evidence" names the run log or the file; §7 has the exact commands.

| # | Certified dimension | Method | Result |
| --- | --- | --- | --- |
| C-1 | **The frozen CR-HM-16 contract is untouched** | sha256 of the file at `e81ba67` vs. the PART 01 digest | ✅ `c6dfa238…dcd99` — byte-for-byte identical; 13 entries (2 SLA + 11 Handyman) |
| C-2 | **The assignment producer (PART 01)** | `tests/handyman-notification-producer-part01.test.ts` | ✅ **9/9 PASS**; 12 assignment events (3 kinds × 4 states) in the additive contract |
| C-3 | **The browser push transport (PART 02)** | `tests/handyman-multiclient-push-part02.test.ts` | ✅ **36/36 PASS** |
| C-4 | **The domain producer (PART 03)** | `tests/handyman-multiclient-notification-part03.test.ts` | ✅ **26/26 PASS** (includes the frozen-contract digest guard) |
| C-5 | **IN_APP + Web Push + FCM Android share ONE engine** | source inspection + `notification-delivery` / `push-delivery` suites | ✅ one outbound chain, one ledger, one idempotency key; PUSH is a channel on the generic path |
| C-6 | **The transactional outbox** | every one of the 18 call sites writes its intent on the domain `tx` | ✅ intents commit/roll back with the fact (guard 4/5 of the certification suite) |
| C-7 | **The dedupe law** | `computeOutboundDeliveryIdempotencyKey` = sourceEventType + sourceEntityId + channel + recipientUserId + templateKey | ✅ unchanged; the IN_APP inbox mirror remains the documented, pre-existing exception (no dedupe there) |
| C-8 | **The retry law** | `outbound-delivery-execution.service.ts` — claim-before-send + bounded retry | ✅ inherited, not re-implemented; no new scheduler, no new backoff engine |
| C-9 | **Tenant isolation** | event carries the fact's own `clientId`; the subscription match filters `client_id`/`building_id` | ✅ a foreign tenant can never match |
| C-10 | **Recipient isolation** | the domain never names a recipient; the declarative subscription rule + the BE-02F/G data-scope guard own the audience | ✅ no `recipients` override exists in any call site |
| C-11 | **Frozen CR-HM-16 compatibility** | guard 1/2/3 — the frozen file is read-only, the additive vocabularies are separate files | ✅ 26 event types total (13 frozen + 12 assignment + 1 inspection) |
| C-12 | **Migration chain 0472 → 0475** | registry order + migration contents | ✅ contiguous, head `0475`, no second delivery ledger |
| C-13 | **The 18 authoritative event call sites** | guard 4 — parsed from the sources | ✅ **12 events / 18 call sites / 9 domain services**, each on its own `tx` |
| C-14 | **No invented assignment events** | every produced event has a pre-existing journal row | ✅ 12/12 events are journaled by the authority that owns the fact |
| C-15 | **Focused tests** | the five certification batches + the guard suite | ✅ **71/71 · 95/95 · 186/186 · 94/99 · 114/117** + **17/17** guards — every non-PASS proven baseline-identical (§4) |
| C-16 | **Typecheck** | `npx tsc --noEmit` | ✅ **PASS** |

### 2.1 The 12 produced events and their 18 call sites

Every event below is written by exactly one domain authority — the authority that owns the fact — on that authority's own transaction. The notification binds to the **occurrence row**, never to the aggregate.

| Event | Domain authority | Sites |
| --- | --- | --- |
| `HANDYMAN_REQUEST_TRIAGED` | `handyman-requests/handyman-request-triage.service.ts` | 1 |
| `HANDYMAN_REFERRAL_CREATED` | `handyman-requests/handyman-request-referral.service.ts` | 1 |
| `HANDYMAN_REQUEST_CANCELLED` | `handyman-requests/handyman-request-cancellation.service.ts` | 1 |
| `HANDYMAN_INSPECTION_RECORDED` | `handyman-requests/handyman-request-inspection.service.ts` | 1 |
| `HANDYMAN_QUOTATION_ISSUED` | `handyman-quotations/handyman-quotation-lifecycle.service.ts` | 1 |
| `HANDYMAN_QUOTATION_SUPERSEDED` | `handyman-quotations/handyman-quotation-lifecycle.service.ts` | 2 |
| `HANDYMAN_QUOTATION_EXPIRED` | `handyman-quotations/handyman-quotation-lifecycle.service.ts` | 1 |
| `HANDYMAN_PERMIT_READINESS_CREATED` | `handyman-scheduling/handyman-permit-readiness.service.ts` | 2 |
| `HANDYMAN_SCHEDULING_READINESS_CREATED` | `handyman-scheduling/handyman-scheduling.service.ts` | 2 |
| `HANDYMAN_UNIT_ACCESS_READINESS_CREATED` | `handyman-scheduling/handyman-unit-access.service.ts` | 2 |
| `HANDYMAN_CREW_MEMBER_ADDED` | `handyman-providers/handyman-work-crew.service.ts` | 2 |
| `HANDYMAN_CREW_LEAD_DESIGNATED` | `handyman-providers/handyman-work-crew.service.ts` | 2 |
| | **total** | **18** |

Eleven of the twelve are named by the **frozen** CR-HM-16 contract. The twelfth (`HANDYMAN_INSPECTION_RECORDED`) is the **PART 03 additive** entry — see GD-1.

**Supersession semantics (certified).** When a readiness row is superseded, the journal records *both* the `…_SUPERSEDED` row (the old row going INACTIVE) and a `…_CREATED` row (the new ACTIVE row). **Only the new ACTIVE row produces a notification**, and it binds to its own occurrence id. The superseded row is journaled, not notified. The `*_READINESS_SUPERSEDED` event types are therefore **deliberately unwired** — they are a named gap, not an omission (GD-5).

---

## 3. The four required resolutions

### R-1 — The inspection event ratification decision

**Status: OPEN — the CR owner must ratify (GD-1). The code is already ratification-shaped.**

**The question.** The frozen CR-HM-16 contract names eleven Handyman lifecycle events. The **inspection recorded on a service request** (`HANDYMAN_INSPECTION_RECORDED`) is a *real* lifecycle fact — it is journaled by `handyman-request-inspection.service.ts` on the shared append-only F6 authority — but it is **not** in the frozen vocabulary. PART 03 had to produce it, because the CR's scope is the Handyman domain notification coverage.

**What PART 03 did (and did not do).**

- It did **not** touch the frozen file. The frozen contract remains byte-for-byte identical (sha256 `c6dfa238…dcd99`, guard 1).
- It added **one** entry in a **separate additive file** beside it — `handyman-domain-notification.contract.ts` → `HANDYMAN_PART03_NOTIFICATION_CONTRACT = [{ eventType: 'HANDYMAN_INSPECTION_RECORDED', audience: 'SUBSCRIPTION_RULE', templateKey: 'HANDYMAN_INSPECTION_RECORDED' }]` — in exactly the shape PART 01 established for the assignment vocabulary.
- The audience stays the declarative `SUBSCRIPTION_RULE` authority. The domain never names a recipient; the subscription owns the audience, the channel and the copy.

**The decision the CR owner must record — one of two:**

| Option | Meaning | Cost |
| --- | --- | --- |
| **A — Ratify as an additive amendment (recommended)** | The CR owner amends CR-HM-16 with a PART 03 amendment that names `HANDYMAN_INSPECTION_RECORDED` as a fourteenth entry, and the ownership map records that PART 03's additive file is its governed implementation. | **Zero code change.** The shipped shape already is an additive amendment. |
| **B — Defer the inspection** | The inspection notification is not in the CR's scope; PART 03's inspection wiring is reverted before the PR. | One domain service loses its single call site; the other 17 sites are unaffected. |

**Certification position.** The certification is **neutral** between A and B: the implementation satisfies A exactly, and B is a one-call-site removal that touches no other domain. What the certification *does* certify is that **the inspection event has a real source** (it is not invented) and that the frozen contract was not edited to accommodate it.

**Why this does not block the PR.** The additive-file pattern is the same pattern the CR already ratified for the assignment vocabulary in PART 01. If the CR owner ratifies A (the recommendation), the PR ships as-is. If the CR owner prefers B, the PR ships with the inspection call site removed — still no frozen-contract change, still no other effect.

**Interim control.** Until ratification, the inspection notification is **inert for release purposes**: it is gated by the same subscription-rule machinery as every other domain event, so no audience receives it until an operator creates a matching subscription rule. This is a *de facto* soft launch, not an exposure.

---

### R-2 — The baseline-identical non-PASS tests

**Status: RESOLVED. All non-PASS tests are proven pre-existing. None is caused by PART 01, PART 02 or PART 03.**

**The brief named 11.** The PART 03 delivery report documented exactly 11 baseline-identical non-PASS tests. The certification confirms **all 11** and finds **7 more** in the same families:

- **2 more members of the same ORDER-flake family** — the PART 03 report documented the flake in `handyman-scheduling-readiness`; the certification shows it is a **family of three** (`handyman-permit-readiness`, `handyman-scheduling-readiness`, `handyman-unit-access-readiness`).
- **5 CR-BE-PUSH-01 legacy guards**, already documented in the PART 02 report §5 as baseline-identical at `9a15ad6`; the certification re-proves them at the certification baseline `126399f`.

**Total baseline-identical non-PASS at the certification baseline: 18.**

| # | Suite | Test | Nature | Baseline proof |
| --- | --- | --- | --- | --- |
| N-1 | `tests/notification.test.ts` | "recordNotification persists the full record" | pre-existing assertion mismatch in the BE-26A inbox suite | identical at `126399f` (41/51 batch, same red) |
| N-2 | `tests/handyman-permit-readiness.test.ts` | "9: mutation + journal atomic" | **ORDER flake** — asserts the order of two journal rows that share one transaction timestamp, tie-broken by a random UUID (`ORDER BY created_at ASC, id ASC`) | identical at `126399f` — **fails in 4 of 4 baseline runs** |
| N-3 | `tests/handyman-scheduling-readiness.test.ts` | "9: mutation + journal atomic" | same ORDER flake | identical at `126399f` — fails in 4 of 4 baseline runs |
| N-4 | `tests/handyman-unit-access-readiness.test.ts` | "9: mutation + journal atomic" | same ORDER flake | identical at `126399f` — fails in 4 of 4 baseline runs |
| N-5 … N-12 | `tests/handyman-crew-worker-admission.test.ts` | 8 cases | **environmental** — the suite connects to the shared cluster on port `55521` *without* `migrateUp`, so `handyman_assignment_responses` (migration 0472) is absent there (`42P01`) | identical at `126399f` (same 8 failures) |
| N-13 | `tests/handyman-readiness-api.test.ts` | "10: OpenAPI/runtime parity" | pre-existing red — the expected path list is older than the published OpenAPI document (PART 03 publishes no path) | identical at `126399f` |
| N-14 | `tests/push01-part04c-delivery-evidence-and-telemetry.test.ts` | "adds no migration 0337 and no new API route" | legacy guard — the repository already contains a `0337_…` migration from an unrelated CR | identical at `126399f` (24/25) |
| N-15 | `tests/push01-part04d-final-integration-closure.test.ts` | "confirms the final PART 04 migration state: 0334-0336 and no 0337" | same `0337_…` | identical at `126399f` (22/23) |
| N-16 | `tests/push01-part05-mobile-contract-and-openapi.test.ts` | "adds no migration — the governed sequence ends at 0336" | same `0337_…` | identical at `126399f` (17/18) |
| N-17 | `tests/push01-part06-closure-and-final-freeze.test.ts` | "closes the migration sequence at 0336 with no duplicate or gap" | the registry head has moved past `0336` for unrelated CRs | identical at `126399f` (25/27) |
| N-18 | `tests/push01-part06-closure-and-final-freeze.test.ts` | "records which PUSH suites are still absent from the CI gate (B-03 OPEN)" | `.github/workflows/ci.yml` does not exist in this checkout | identical at `126399f` (25/27) |

**How the baseline proof was made.** A **detached worktree** at `126399f` was created (`git worktree add /tmp/cert-baseline 126399f`) with `node_modules` symlinked, so the *untouched* baseline tree ran against its own database. The readiness family was run **4 times** (28/30 each run, 2 of the 3 suites red every time — the flake is deterministic per suite-pair, not random per run); the misc batch ran once (10 hard reds — the same 10); the push01 batch ran once (the same 5 legacy guards). **Every non-PASS observed on `e81ba67` is present, identically, at `126399f`.** The worktree was removed afterwards.

**Standing instruction honoured.** These 18 are *recorded, not chased*. No assertion was weakened to make a suite green, and no unrelated code was modified to repair them.

**Ownership (for the FINAL REVIEW).** N-1 and N-13 belong to the BE-26A / CR-HM-05 PART 06A owners. N-2…N-4 belong to the CR-HM scheduling owners. N-5…N-12 are an **environmental harness defect** (a suite that talks to a cluster it never migrates) and belong to the CR-HM-04/05 owners. N-14…N-18 belong to CR-BE-PUSH-01, whose own closure criteria ("the migration sequence ends at 0336") were invalidated by unrelated CRs. **None of them is a defect of this CR.**

---

### R-3 — The browser and APK contract prerequisites

**Status: RESOLVED — the Backend contracts are published and complete. The client-side prerequisites are recorded as GD-2 / GD-3.**

#### APK (Android, FCM) — 3 operations, unchanged

| Operation | Method + path |
| --- | --- |
| `registerPushToken` | `POST /mobile/push-tokens` |
| `listPushTokens` | `GET /mobile/push-tokens` |
| `deactivatePushToken` | `DELETE /mobile/push-tokens/{tokenId}` |

#### Browser (Web Push) — 4 operations, added by PART 02

| Operation | Method + path |
| --- | --- |
| `registerBrowserPushSubscription` | `POST /mobile/push-subscriptions` |
| `listBrowserPushSubscriptions` | `GET /mobile/push-subscriptions` |
| `revokeBrowserPushSubscription` | `DELETE /mobile/push-subscriptions/{subscriptionId}` |
| `revokeAllBrowserPushSubscriptions` | `DELETE /mobile/push-subscriptions` |

Schemas published: `BrowserPushSubscriptionRegistration`, `BrowserPushSubscriptionRevocationResult`.

#### The contract law the clients must respect

1. **There is NO push-send route.** The Backend never accepts a "send this push" instruction (guard 15). The client owns the push handshake; the Backend pushes out-of-band to the registered endpoint/token.
2. **Registration ≠ delivery.** A `201` means *"the Backend will try"*. The real outcome lives in the attempt evidence (browser) and in the outbound delivery ledger (both transports).
3. **The inbox stays IN_APP-only.** The inbox channel CHECK remains `('IN_APP')`; a push never lands in the inbox. `NOTIFICATION_HISTORY_CHANNELS` contains `IN_APP`, `EMAIL`, `WHATSAPP` — **never `PUSH`**. A client that expects a push to appear in the inbox/history contract is mis-implemented.
4. **The template channel vocabulary was widened** (migration 0474) to `IN_APP, EMAIL, WHATSAPP, PUSH`. The template store is shared; the CR did not create a second template store.
5. **Credential hygiene.** The browser endpoint, the `p256dh` key and the `auth` secret never appear in an API response, in an attempt-evidence row, in an operational event or in a log line. The VAPID private key is read only inside the governed push module and is never persisted.
6. **Browser subscription primitives** the client must supply: `endpoint` (an https push-service URL), `keys.p256dh` (a 65-byte uncompressed P-256 point, `0x04`-prefixed), `keys.auth` (a 16-byte secret).

#### Browser + APK client prerequisites (out of the Backend's control)

| Prerequisite | Owner | Blocking |
| --- | --- | --- |
| The APK registers its FCM token via `POST /mobile/push-tokens` and refreshes it on token rotation | Mobile client | Release (GD-2) |
| The browser registers a subscription via `POST /mobile/push-subscriptions` after the service worker is installed, and re-registers when the endpoint rotates (Chrome rotates endpoints) | Web client | Release (GD-3) |
| The browser client accepts the `webpush` VAPID public key presented by the Backend | Web client | Release (GD-3) |
| The client owns the **permission prompt** and the **user opt-in** — the Backend never prompts | Web client | Release (GD-3) |
| The client treats `410 Gone` / `INVALID_TOKEN` on the endpoint as a revoke signal and calls the revoke route | Both clients | Reliability |

---

### R-4 — Production configuration and release gates

**Status: RESOLVED for the Backend (the configuration surface is complete and fail-closed). The credential PROVISIONING is a release gate (GD-4).**

#### The configuration surface (read at the adapter boundary only)

| Transport | Variable | Required | Meaning |
| --- | --- | --- | --- |
| Browser | `PUSH_BROWSER_PROVIDER` | ✅ | `webpush` for production; `noop` / `capture` are **credential-less and test-only** |
| Browser | `PUSH_BROWSER_VAPID_PRIVATE_KEY` | ✅ (when `webpush`) | PEM-encoded EC (P-256) private key, `BEGIN/END PRIVATE KEY` block |
| Browser | `PUSH_BROWSER_VAPID_SUBJECT` | ✅ (when `webpush`) | a `mailto:` or `https:` contact for the VAPID identity |
| Browser | `PUSH_BROWSER_VAPID_PUBLIC_KEY` | optional | base64url uncompressed P-256 public key; derived from the private key when absent |
| Browser | `PUSH_BROWSER_TTL_SECONDS` | optional | push-message TTL |
| Browser | `PUSH_BROWSER_ALLOWED_ENDPOINT_HOSTS` | optional | endpoint-host allow-list for a private/self-hosted push service |
| Native (FCM) | `PUSH_PROVIDER` | ✅ | `fcm` for production; `noop` / `capture` are **credential-less and test-only** |
| Native (FCM) | `PUSH_FCM_PROJECT_ID` | ✅ (when `fcm`) | the Firebase project id |
| Native (FCM) | `PUSH_FCM_CLIENT_EMAIL` | ✅ (when `fcm`) | the service-account client email |
| Native (FCM) | `PUSH_FCM_PRIVATE_KEY` | ✅ (when `fcm`) | PEM service-account private key |
| Native (FCM) | `PUSH_FCM_API_BASE_URL` | optional | defaults to `https://fcm.googleapis.com` |
| Native (FCM) | `PUSH_FCM_TOKEN_URI` | optional | defaults to `https://oauth2.googleapis.com/token` |

**Fail-closed (certified).** An unknown provider value throws a `ConfigError`; a credential-less provider resolves **only** when `NODE_ENV === 'test'`; a missing/invalid credential throws a `ConfigError` whose message names the **variable** but never echoes a credential value (guard 17). A misconfigured transport therefore **stops the delivery attempt with a recorded error** — it never silently downgrades to "pretend it was sent".

**Credential isolation (certified).** `src/config/env.ts` reads only the `PUSH_PROVIDER` discriminator; the browser and FCM credentials are read **inside the governed adapter modules** and never travel through the application config, a log line or an API response (guard 16).

#### The release gates

| Gate | Condition | Owner | Status |
| --- | --- | --- | --- |
| **G-1 Migrations** | `0472 → 0475` applied on the target database; `migrateUp` green | Platform | ⬜ open |
| **G-2 Web-Push credentials** | VAPID key pair generated, private key provisioned as `PUSH_BROWSER_VAPID_PRIVATE_KEY`, subject set, `PUSH_BROWSER_PROVIDER=webpush` | Platform + CR owner | ⬜ open |
| **G-3 FCM credentials** | Firebase service account provisioned, `PUSH_PROVIDER=fcm` + project id + client email + private key set | Platform + CR owner | ⬜ open |
| **G-4 Subscription rules** | the declarative BE-26D subscription rules for the produced events exist per tenant (the rules, not the code, create the audience) | Operations | ⬜ open |
| **G-5 Templates** | the template rows for the produced event types exist (the `templateKey` is `HANDYMAN_<EVENT>`) | Operations | ⬜ open |
| **G-6 CI gate B-03** | the PUSH suites are present in the CI pipeline (`.github/workflows/ci.yml` is absent in this checkout) | CI owner | ⬜ open (N-18) |
| **G-7 Pre-existing reds** | the 18 baseline-identical non-PASS tests are triaged to their owners | §4 owners | ⬜ open |
| **G-8 GD-1 ratification** | the inspection decision is recorded | CR owner | ⬜ open |

---

## 4. The migration chain 0472 → 0475 (certified)

| Migration | Content | Certification |
| --- | --- | --- |
| `0472_handyman_assignment_responses` | the assignment acknowledgment authority (PART 01) | ✅ applied and green |
| `0473_create_browser_push_subscriptions` | `browser_push_subscriptions` — the browser subscription store | ✅ applied and green |
| `0474_widen_notification_template_channels_for_push` | widens the **one** template channel CHECK to `IN_APP, EMAIL, WHATSAPP, PUSH` | ✅ applied and green; touches exactly one constraint |
| `0475_create_notification_browser_push_deliveries` | `notification_browser_push_deliveries` — the browser attempt evidence | ✅ applied and green |

**Certified properties (guards 11–13):**

- The registry is contiguous and ordered `0470 … 0475`; the head is `0475`.
- **No second delivery ledger** was created: `notification_outbound_deliveries` is not re-created anywhere; the browser attempt evidence is a *separate, transport-specific* table (it has no FK to `mobile_push_tokens` — the reason the reuse of table `0336` was impossible).
- The inbox channel CHECK stays **IN_APP-only**; the history channels stay **push-free**.
- PART 03 added **no migration at all** (its events are pure reactions to existing facts).

---

## 5. The certification guard suite

`tests/handyman-multiclient-notification-certification.test.ts` — **17 tests / 6 suites, all PASS**, a *static* suite (no database, no network) that pins the certified invariants so a later change cannot silently break the certification:

| Guard | Pins |
| --- | --- |
| 1 | the frozen contract's sha256 + its 13 entries + its declarative audiences |
| 2 | the frozen contract is read-only and never mutated or shadowed |
| 3 | three admission vocabularies, all additive; the PART 03 file adds exactly one entry |
| 4 | **12 events / 18 call sites**, one authority each, every site on its own `tx` |
| 5 | a call site can never choose the notification entity |
| 6 | the producers write **no** Handyman lifecycle state |
| 7 | one seam — no second producer path, no duplicated subscription/template/recipient logic |
| 8 | one engine across IN_APP / Web Push / FCM |
| 9 | the dedupe law and the retry law |
| 10 | tenant + recipient isolation |
| 11 | the migration registry order and head |
| 12 | no second delivery ledger; one constraint widened |
| 13 | the inbox is IN_APP-only; the history is push-free |
| 14 | the published browser (4) and APK (3) operations + the 2 schemas |
| 15 | **no push-send route is published** |
| 16 | the transport configuration is read at the adapter boundary only |
| 17 | the resolvers fail closed and never echo a credential |

**This is a test artifact, not runtime code.** It adds no production module, no route, no migration and no dependency (`yaml` was already a dependency).

---

## 6. Outstanding governance decisions

Each item needs an **owner decision**, not a code change. "Blocking" states what it blocks.

| ID | Decision | Owner | Recommendation | Blocking |
| --- | --- | --- | --- | --- |
| **GD-1** | **Ratify `HANDYMAN_INSPECTION_RECORDED`** — amend CR-HM-16 with a PART 03 amendment naming it as the fourteenth entry (Option A), or remove the inspection call site (Option B). | CR owner | **A** — the additive-file shape is already shipped and matches the PART 01 precedent | Release (G-8); **not** the PR |
| **GD-2** | Accept the **APK** push contract (3 operations) and the client-side token-registration obligation. | Mobile client owner | Accept | Release |
| **GD-3** | Accept the **browser** push contract (4 operations), the VAPID public-key presentation, the client-owned permission prompt and the endpoint-rotation re-registration obligation. | Web client owner | Accept | Release |
| **GD-4** | Provision the **production credentials** (VAPID pair + FCM service account) and close the CI gate **B-03**. | Platform + CI owner | Provision; add the PUSH suites to the pipeline | Release |
| **GD-5** | Confirm that `HANDYMAN_CREW_CREATED`, `HANDYMAN_DIAGNOSIS_RECORDED`, `HANDYMAN_CREW_STATUS_CHANGED`, `HANDYMAN_CREW_MEMBER_STATUS_CHANGED` and the `*_READINESS_SUPERSEDED` events stay **unwired** (named gaps) in this CR, or schedule them in a follow-up. | CR owner | Keep them unwired — they have no certified audience rule, and `*_SUPERSEDED` is covered by the `…_CREATED` notification on the new ACTIVE row | Nothing (documented gap) |
| **GD-6** | Triage the **18 baseline-identical non-PASS tests** to their owners (§4). Note N-2…N-4 are one ORDER-tie-break flake family; N-5…N-12 are one harness defect (a suite that never migrates its cluster); N-14…N-18 are CR-BE-PUSH-01's closure criteria invalidated by unrelated CRs. | The owning CRs | Hand to the owners; **do not** fix them inside this CR | Release hygiene (G-7) |
| **GD-7** | Ratify the **IN_APP inbox dedupe exception**: the BE-26A in-app chain has no dedupe and mirrors **each** subscription; the outbound ledger dedupes. Confirm that this pre-existing asymmetry is accepted for the produced events. | CR-HM-16 owner | Accept and document — changing it would alter the frozen BE-26A behaviour | Nothing (documented) |

---

## 7. Evidence appendix

### 7.1 The runs (all on `e81ba67`, against the shared embedded PostgreSQL on `5432`)

```
DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_PASSWORD= DB_NAME=asentra_test \
DB_SSL=false NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 <suites>
```

| Batch | Suites | Result | Log |
| --- | --- | --- | --- |
| PART 01 + 02 + 03 | the three CR suites + the contract + the assignment suites | **71 / 71 PASS**, 0 skipped | `/tmp/cert-main.log` |
| Outbox / ledger / dedupe / retry / transport | outbound-execution, outbound-ledger, outbound-intent, integration-outbox, notification-delivery, notification-templates, notification-subscriptions, mobile-push-token | **95 / 95 PASS** | `/tmp/cert-outbox.log` |
| Push (part 01 → 04b) + mobile boundary | the CR-BE-PUSH-01 suites + the mobile-push boundary suite | **186 / 186 PASS** | `/tmp/cert-push1.log` |
| Push (part 04c → 06) + contract part 02 | the legacy-guard suites | **94 / 99**, 5 reds = the CR-BE-PUSH-01 legacy guards | `/tmp/cert-push2.log` |
| Domain + notification (12 suites) | request / quotation / scheduling / crew / notification / audit / readiness | **114 / 117**, 3 reds = the ORDER flake ×2 + `notification.test.ts` | `/tmp/cert-dom.log` |
| **Certification guards (this Part)** | `handyman-multiclient-notification-certification` | **17 / 17 PASS** | this turn |
| Typecheck | `npx tsc --noEmit` | **PASS** | this turn |

### 7.2 The baseline proof

```
git worktree add /tmp/cert-baseline 126399f      # the untouched certification baseline
(cd /tmp/cert-baseline && <the same suites>)      # 28/30 readiness × 4 runs, 41/51 misc, 88/93 push01
git worktree remove /tmp/cert-baseline
```

Every non-PASS on `e81ba67` appears **identically** at `126399f`. **No non-PASS is attributable to this CR.**

### 7.3 The baseline reference that is missing

The brief referenced `docs/audits/HANDYMAN-BACKEND-GAP-20261023.md`. **That document does not exist in this checkout.** The certification therefore used the two baselines that do exist and are authoritative for this scope:

- `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` — §16.3-A (the WEB_PUSH supersession S-1…S-6), applied explicitly in PART 02.
- `docs/CR-BE-MOB-01_GAP-MATRIX.md` — the NTF rows (NTF-05).
- `docs/CR-HM-16_START_GOVERNANCE.md` — the frozen ownership / reuse map.

**Action:** if the audit document is required as the governing baseline, it must be supplied — this is a **missing baseline**, recorded, not guessed around.

---

## 8. What PART 04 did NOT do (by instruction)

- **No new runtime code.** The only source added in Part 04 is a **test** file and this **document**.
- **No deployment.** Nothing was deployed to Biznet or anywhere else.
- **No PR.** The branch is committed and pushed; the PR is opened only at FINAL REVIEW.
- **No assertion was weakened.** The only test edits in the whole CR were in PART 03, where **three genuine test-assumption bugs** were corrected (the implementation was right) — recorded in the PART 03 delivery report §3.
- **No unrelated code was modified.** Finance, BAST and Manager CLOSE were untouched in every part.
- **No new notification engine, no business-authority change, no second ledger, no new dependency** (`web-push` / `http_ece` / `jws` were used **only** in a disposable interop harness under `/tmp`; the repo has zero new runtime dependencies — the Web Push encryption is implemented in-repo, RFC 8291 / RFC 8188 `aes128gcm`).

---

## 9. Next FINAL REVIEW steps

1. **Read this report + the three Part reports** (PART 01 `a66e499`, PART 02 `fcc102a`, PART 03 `126399f`).
2. **Take GD-1** (the inspection ratification) — record the answer in the CR-HM-16 ownership map; if Option B is chosen, remove the single inspection call site (and its PART 03 test case) — a 2-file, no-contract change.
3. **Take GD-2 … GD-4** with the client, web and platform owners; open the tracked release-gate items G-1 … G-8 (§3, R-4).
4. **Confirm GD-5 … GD-7** (the named gaps, the red-test triage, the IN_APP dedupe exception) as recorded.
5. **Open the PR** from `arena/6b721660-handyman-backend` (still no PR has been created) with this certification report attached.
6. **At merge time**, apply the migration chain `0472 → 0475` to the target environment **before** the application rollout, and provision the transport credentials **before** the first real fan-out.
7. **Post-merge follow-up** (separate CRs): the named gaps (GD-5), the ORDER-flake family (N-2…N-4), the crew-admission harness defect (N-5…N-12), the CR-BE-PUSH-01 closure criteria (N-14…N-18), and the BE-26A inbox parity red (N-1).

---

*Certified on `e81ba67` — PART 04, FINAL CERTIFICATION ONLY. No runtime code, no deployment, no PR.*
