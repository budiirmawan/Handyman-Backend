# CR-HM-16 — FINAL CERTIFICATION

**Verdict: PASS**

| | |
| --- | --- |
| Governance baseline | `docs/handyman/CR-HM-16_START_GOVERNANCE.md` (committed `9f21e58`) |
| Certified tip | `e3ba09d` (`arena/01a0f085-handyman-backend`) |
| Certified range | `9f21e58..e3ba09d` (START governance + PART 01–04) |
| Regression | 38/38 focused tests green (5 suites; no full test/typecheck/build/CI run) |
| Runtime changes during certification | none (one stale shared-test fixture updated; see §5) |

This certification attests that CR-HM-16 PART 01–04 implement exactly the
frozen START governance: Handyman contracts are published OVER the shared SLA,
BE-26 notification, CR-BE-AUDIT-01 audit, CR-BE-INTEG-01 outbox/webhook and
CR-BE-STAB-01 reliability capabilities — one lifecycle authority each,
provider-neutral, FM/SaaS firewalled, and provider performance a derived
read model only.

---

## 1. Per-PART certification

### PART 01 — Handyman SLA contract extension (`b6a5ae6`)

| Governance claim | Evidence |
| --- | --- |
| Milestone vocabulary + definition/binding contract over the shared engine | `src/modules/sla-definitions/handyman-sla-subjects.ts`: closed `HANDYMAN_SLA_SUBJECT_TYPES` (5) + frozen `HANDYMAN_SLA_SUBJECT_MILESTONES` (capability-map row 19: 9 milestones, each = one subject type × one existing RESPONSE/RESOLUTION clock — no new clock type). |
| Subject-type extension only; engine mechanics read-only | Migration `0423_handyman_sla_subject_binding` widens `sla_definitions`/`applied_slas` CHECKs and binds subjects polymorphically (`subject_id UUID`, **no FK** to any FM/SaaS table); exactly-one-binding CHECK mirrors the Work Order law. Engine selection/snapshot/clock/pause/breach/escalation code paths are consumed, not forked. |
| SLA Engine != Performance Read Model | PART 01 ships no performance code; the subject contract states the separation and PART 04 keeps it (§3). |
| Forbidden: second clock/breach writer, FM subject types, escalation redesign, notification delivery | None present. `markBreached` remains the single first-write breach writer; the milestone map is vocabulary only. |

### PART 02 — Handyman notification event contract (`3ae9183`)

| Governance claim | Evidence |
| --- | --- |
| Event→meaning/recipient/template contracts over BE-26 seams | `src/modules/handyman-notifications/handyman-notification-contract.ts` freezes the 12-event contract (SLA chain + certified domain vocabulary) with meaning/audience/template; `emitHandymanNotificationIntent` is a fail-closed admission wrapper that reacts through the existing `deliverInAppNotifications` / `deliverOutboundNotifications` seams only. |
| Provider-neutral boundary (B3) | Contract and emitted intent are channel-free and provider-free by construction — regression asserts no whatsapp/email/sms/push/provider/channel/smtp names anywhere in the contract. |
| Delivery/retry semantics inherited by reference | No delivery stack, scheduler, outbox or provider adapter in the PART; the outbound chain produces ledger INTENT rows only (`PENDING`, provider-null). |
| Handyman SLA escalation notification binding (PART 01-deferred) | Migration `0424_handyman_sla_escalation_notification_binding` extends `sla_escalation_actions` with the exactly-one-binding law (`work_order_id` ⇄ `subject_id`+`subject_type`); the trigger renders from the FROZEN action row through the reused BE-26A record seam with Handyman source identity and **no** Work Order navigation target. Work Order rows stay byte-identical (including `WORK_ORDER_FIELD_WORK` navigation). |
| Notification never writes domain lifecycle (B7) | Emitter is reactive-only (regression proves delivery against phantom subjects with zero domain reads/writes); escalation render reads only frozen action rows. |

### PART 03 — Audit + integration-reliability contract (`020da0e`)

| Governance claim | Evidence |
| --- | --- |
| Handyman audit context/vocabulary over `recordOperationalEvent`/`audit` seam (B8) | `src/modules/handyman-audit/` freezes the 15-event audit vocabulary, the context law (server-generated correlation; HTTP context authoritative; SCHEDULER/SYSTEM override only; append-only; sensitive-key scrubbing) and a fail-closed `recordHandymanEvent` that delegates to the single `recordOperationalEvent` authority on the caller's executor. No second event log or audit store exists; no injection endpoint; no UPDATE/DELETE path. |
| Outbox/webhook subscription contracts over the existing family (B6/B10) | `HANDYMAN_INTEGRATION_SUBSCRIPTION_CONTRACT` names the existing endpoint registry; the regression proves prospective 1:1 markers (real `SELECT EXISTS` probe), atomic event+outbox commit/rollback, fan-out through the single dispatcher with inherited claim-before-send, bounded retry (`RETRY_SCHEDULED → DELIVERED`), recursion blocklist, and zero lifecycle writes from integration delivery. |
| Idempotency/claim-before-send law for future mutations | `executeHandymanIdempotent` binds `hm.*`-namespaced mutations to the single `request-idempotency` service (claim → work-at-most-once → replay → 409 fingerprint conflict); the claim-before-send law is inherited from the existing due-job families, not restated. |

### PART 04 — Provider performance derivation + published read contract (`e3ba09d`)

| Governance claim | Evidence |
| --- | --- |
| §6 inputs only | `HANDYMAN_PERFORMANCE_INPUT_LAW` admits exactly two inputs: certified Handyman operational events and authoritative SLA outcomes (applied snapshots + clock status/breach facts). Outbox/webhook deliveries, notification records, manual KPI values and control-plane records are explicitly excluded — and the regression proves the derivation is blind to rows of each. |
| Derived read model, never manual KPI / transactional authority (B2) | `deriveHandymanProviderPerformance` is SELECT-only at query time (no persisted KPI rows, no scheduler/engine); `HANDYMAN_PERFORMANCE_SEPARATION_LAW` freezes every forbidden authority to false and the read-only battery proves the derivation writes nothing (row counts and `updated_at` touch sums unchanged). |
| Published read contract for CR-HM-17/18/22 | `HandymanProviderPerformanceSnapshot`: scope, governed-input counts, derived response/resolution attainment, nine-milestone adherence (PART 01 map referenced, zero-filled, all backend-derived), event-sequenced operational truth. No client-writable field; no financial authority fields. |
| FM/SaaS firewall (B4/B5) | FM Work Order applied SLAs and FM-entity events never enter the derivation (regression fixtures prove exclusion); SaaS control-plane rows cannot gate or bias the snapshot; no FM `overdue`/KPI field is adopted as truth. |

---

## 2. Cross-cutting verifications

1. **Shared SLA reuse (no forked engine).** CR-wide diff scope (`9f21e58..e3ba09d`)
   touches the shared SLA family only through typed widening: `applied-slas`
   (5 files), `sla-definitions` (subject vocabulary + types),
   `sla-escalation-actions` (binding columns/context/recipients/trigger),
   `sla-escalation-policies` (operational types) + migrations `0423`/`0424`.
   No second clock machine, pause ledger or breach writer exists.
2. **Provider-neutral notification.** Static scan of the three Handyman
   modules finds no WhatsApp or named-provider token, adapter, enum or config
   key; contract purity is enforced by regression.
3. **Single authorities, all untouched by this CR** (verified empty diff):
   `notification-delivery`/`notifications`/`notification-templates`/
   `notification-subscriptions` (BE-26), `operational-events`/`audit`
   (CR-BE-AUDIT-01), `integration-outbox`/`integration-webhook-*`
   (CR-BE-INTEG-01), `request-idempotency` (CR-BE-STAB-01),
   `due-job-dispatcher`/`due-job-scheduler` (the only scheduler),
   `recipient-resolution`, `work-orders`. Infra reuse ≠ authority transfer.
4. **FM/SaaS firewall.** No CR migration creates an FK to `work_orders`,
   `work-order-sla-register` or any SaaS table; Handyman subject bindings are
   polymorphic UUIDs. `subject_type`/entity admission is fail-closed to the
   `HANDYMAN_` namespace at the Handyman seams. No SaaS
   subscription/entitlement/billing state gates any SLA clock, notification
   or derivation.
5. **No API surface.** All four PARTs are service/contract modules; the only
   public projection (`toPublicSlaEscalationAction`) keeps its field list
   unchanged (no leak of Handyman bindings).

## 3. Blocker certification (§8 B1–B10)

| ID | Verdict | Evidence |
| --- | --- | --- |
| B1 second SLA clock/breach authority | PASS | shared engine extended only; `markBreached` remains sole breach writer |
| B2 performance as KPI/transactional | PASS | SELECT-only derivation; separation law; read-only battery |
| B3 WhatsApp/named provider dependency | PASS | contract purity (PART 02) + static scan (this certification) |
| B4 FM coupling | PASS | no FM FKs/dual-writes; FM SLA outcomes/events excluded from performance; no FM `overdue` adoption |
| B5 SaaS coupling | PASS | no SaaS gating anywhere; control-plane rows provably inert to the derivation |
| B6 duplicate lifecycle authority | PASS | all five single-authority families untouched (empty diff, §2.3) |
| B7 notification writes domain state | PASS | reactive-only seams; zero lifecycle writes asserted in PART 02/03 regressions |
| B8 mutable audit / injection | PASS | append-only `recordOperationalEvent` delegation; scrubbing + correlation asserted |
| B9 governance-PART change | PASS | `9f21e58` governance document unchanged by all four PARTs |
| B10 non-idempotent reliability | PASS | inherited claim-before-send + idempotency (409) semantics asserted in PART 03 |

## 4. Regression (minimum focused, no full run)

| Suite | Result |
| --- | --- |
| `tests/handyman-sla-contract-part01.test.ts` | 10/10 |
| `tests/handyman-notification-contract-part02.test.ts` | 6/6 |
| `tests/handyman-audit-integration-part03.test.ts` | 9/9 |
| `tests/handyman-provider-performance-part04.test.ts` | 4/4 |
| `tests/sla-escalation-materialization.test.ts` (shared SLA-02 engine) | 9/9 |
| **Total** | **38/38** |

No full test/typecheck/build/CI was run (per this certification's mandate).

## 5. Finding resolved during certification

The focused regression initially caught one red shared-engine test
(`sla-escalation-materialization.test.ts`, layer-2 duplicate-insert probe):
its hand-built breach context predated the frozen PART 02 `SlaBreachContext`
widening (`subjectId`/`subjectType`) and migration `0424`'s `subject_type NOT
NULL` binding law, so the probe hit a NOT NULL violation instead of the unique
constraint. Classification: **stale test fixture against the frozen binding
contract — not a runtime defect** (all three production materialization paths
pass the binding explicitly; the other 8 shared tests and all four PART suites
were green). The fixture now supplies the Work Order binding explicitly
(`subjectId: null, subjectType: 'WORK_ORDER'`), preserving the probe's intent.
No runtime code changed during certification.

## 6. Certified commit map

| Commit | PART |
| --- | --- |
| `9f21e58` | 00 — START governance (this certification's baseline document) |
| `b6a5ae6` | 01 — extend SLA contract for Handyman |
| `3ae9183` | 02 — bind Handyman notification events |
| `020da0e` | 03 — bind audit integration reliability |
| `e3ba09d` | 04 — publish provider performance contract |

## 7. Deferred (governance non-blockers; no authority implied)

Real channel providers (gated adapter decision), SLA business-day/holiday
calendars (24x7 elapsed remains engine law), performance formula/threshold
tuning beyond the §6 input law, audit retention/deletion, SaaS control-plane
notification surfaces, client UI (CR-HM-17/18), integration certification
mechanics (CR-HM-22).

## 8. Consuming-journey boundary (outbound)

CR-HM-17 (frontend), CR-HM-18 (mobile) and CR-HM-22 (certification) consume
the published read/command contracts only: the PART 02 notification meaning
contract, the PART 03 audit/integration vocabulary and the PART 04
`HandymanProviderPerformanceSnapshot`. Clients present backend-derived state
and define no event meaning, no KPI, and no security/audit decision.
