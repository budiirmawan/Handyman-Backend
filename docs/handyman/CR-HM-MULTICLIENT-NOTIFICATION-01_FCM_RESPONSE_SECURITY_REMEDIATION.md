# NATIVE FCM TOKEN RESPONSE SECURITY — PART 02 REMEDIATION

**Date:** 2026-10-24 (UTC)
**Gap:** Final Backend Gap Audit **BA-01**
**Baseline:** `fb65c17e7f48f4896df2104256aa5d25f6fd07b4` (merged PR #60)
**Part 01 documentation commit:** `313b6b7`
**Scope:** native `/mobile/push-tokens` response custody only; no new PR, deployment, migration, notification engine, browser/IN_APP authority change, or other-repository change.

> **BA-01 implementation status: CLOSED.** Raw native provider tokens are now write-only in registration input and absent from registration, list, and deactivation responses and from the published response schema. Internal persistence and native delivery token access remain intact.
>
> This closure does **not** claim production provider activation or physical-device P-6.5 sign-off. Those environment/device activities remain under **BA-09**, and the overall Backend/Biznet release verdict remains **NO-GO** because the other P1 gates remain open.

## 1. Governing contract and supersession

PR #58 P-6.5 in `CR-HM-MULTICLIENT-NOTIFICATION-01_PRODUCTION_PREREQUISITES.md` requires the FCM token to appear in no API response, attempt-evidence row, operational event, or log line.

The older CR-BE-PUSH-01 §25.5 recorded a different historical decision: raw `pushToken` remained in the response because the then-frozen `PUBLIC_REGISTRATION_KEYS` required it. Part 02 explicitly supersedes that response-shape decision for security. It does not rewrite migration history, native persistence, provider authority, or the shared delivery engine.

## 2. Implementation

### Public response boundary

- `src/modules/push-tokens/push-token.types.ts`
  - Removed `pushToken` from `PublicPushToken`.
  - Retained `pushToken` in the internal `PushTokenRecord` and required registration input.
  - Approved public metadata remains `id`, `userId`, `deviceId`, `platform`, `appVersion`, `deviceModel`, `deviceOsVersion`, `status`, `registeredAt`, `lastSeenAt`, `createdAt`, and `updatedAt`.
- `src/modules/push-tokens/push-token.service.ts`
  - Removed `pushToken: row.pushToken` from the single public mapper, `toPublicPushToken`.
  - Registration, rotation, listing, and deactivation all use that mapper, so there is no parallel response serializer to drift.
  - Full-record internal accessors and persistence queries are unchanged.

### OpenAPI

`docs/api/openapi.yaml` now:

- keeps `pushToken` required in the authenticated registration request and marks it `writeOnly: true`;
- removes `pushToken` from `PushTokenRegistration.required` and `.properties`;
- states that register/list/deactivate responses contain non-secret metadata and never return the raw provider token;
- preserves the same three routes, authentication, ownership, status vocabulary, and native lifecycle.

The client-facing `docs/api/CR_BE_PUSH_01_MOBILE_HANDOFF.md` and `docs/api/mobile-contract.md` were updated to the same write-only rule; neither consumer repository was accessed.

### Internal native delivery remains intact

- `listActivePushTokensForUser` still returns internal `PushTokenRecord` values.
- `outbound-push-fanout.service.ts` still maps the internal record to the provider-only target as `token: token.pushToken`.
- The FCM adapter, provider invocation, attempt evidence, invalidation, and token fingerprint/sanitization paths were not changed.
- No browser subscription, IN_APP, outbound-ledger, route, migration, or notification-engine source was changed.

## 3. Requirement-to-evidence matrix

| Requirement | Evidence |
|---|---|
| Registration response excludes the raw token | `mobile-push-token.test.ts` registration and rotation cases assert no `pushToken` key and no raw value anywhere in the HTTP body; Part 05 repeats the service/contract assertion. |
| List response excludes the raw token | A known raw token is registered, then the complete HTTP list body is asserted not to contain it; every listed item lacks `pushToken`. |
| Delete response excludes the raw token | Owner deactivation asserts no `pushToken` and no raw value in the HTTP body; Part 05 also checks service deactivation. |
| Another actor cannot access or revoke | HTTP tests prove the other actor's list lacks the registration and cross-owner DELETE returns 404 without changing the owner row. Foundation and Part 05 owner-scope guards also pass. |
| Native delivery retains internal token access | Part 03B fan-out passes 24/24 and asserts native targets carry the stored token; Part 03C provider/evidence passes 26/26 and invokes the provider port once per active device. |
| Registration/revocation idempotency | Same-input registration replay returns the same registration id with one ACTIVE row; repeated DELETE returns the existing 404 and leaves the row INACTIVE. Rotation/re-registration history tests remain green. |
| OpenAPI matches runtime | Part 05 compares runtime mapper keys with the schema, proves the request token is required/write-only, and proves register/list/deactivate secrecy. Current operational parity/freeze checks pass 28/28; mobile boundary and completeness checks also pass. |
| Browser Web Push unaffected | `handyman-multiclient-push-part02.test.ts` passes 36/36, including secret-free browser registration/list/revocation, isolation, fan-out, native/browser independence, and IN_APP compatibility. |
| No raw token in errors/events/evidence/logs | HTTP validation errors do not echo submitted values; Part 05 operational-event and log/fingerprint guards pass; Part 03C proves provider attempt evidence never persists the raw device token. Global request logging does not log request bodies. |

## 4. Executed verification

No full repository test suite was run. All database-backed groups used fresh disposable EmbeddedPostgreSQL instances; scratch database directories were removed. **SKIPPED = 0 in every executed batch.**

### Type safety

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |

### Batch A — native HTTP and registration foundation

Command profile: `ASENTRA_USE_EMBEDDED_POSTGRES=true NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1` with the two files below.

| Suite | PASS | FAIL | SKIPPED |
|---|---:|---:|---:|
| `tests/mobile-push-token.test.ts` | 10 | 0 | 0 |
| `tests/push01-part01-device-registration-foundation.test.ts` | 24 | 0 | 0 |
| **Batch total** | **34** | **0** | **0** |

### Batch B — native fan-out, provider evidence, and runtime/OpenAPI contract

A fresh EmbeddedPostgreSQL instance was started on port 55591 and supplied through explicit `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_SSL`. The generic test helper therefore did not skip or fall back to a shared development database.

| Suite | PASS | FAIL | SKIPPED |
|---|---:|---:|---:|
| `tests/push01-part03b-device-fanout-and-payload.test.ts` | 24 | 0 | 0 |
| `tests/push01-part03c-provider-invocation-and-attempt-evidence.test.ts` | 26 | 0 | 0 |
| `tests/push01-part05-mobile-contract-and-openapi.test.ts` | 17 | 1 | 0 |
| **Batch total** | **67** | **1** | **0** |

The sole failure is the already registered **BA-13** assertion `adds no migration — the governed sequence ends at 0336`, which rejects the existence of 0337 even though the legitimate current head is 0480. Every Part 02 response-security, native-delivery, and OpenAPI assertion in this batch passed. BA-13 was not repaired or hidden in this native-response CR.

### Batch C — browser/Web Push and multi-client regression

| Suite | PASS | FAIL | SKIPPED |
|---|---:|---:|---:|
| `tests/handyman-multiclient-push-part02.test.ts` | 36 | 0 | 0 |

### Batch D — static OpenAPI and mobile boundary guards

| Suite | PASS | FAIL | SKIPPED |
|---|---:|---:|---:|
| `tests/mobile-push-delivery-boundary-contract.test.ts` | 16 | 0 | 0 |
| `tests/mobile-cr-regression-contract.test.ts` | 9 | 3 | 0 |
| `tests/mobile-openapi-completeness.test.ts` | 5 | 0 | 0 |
| `tests/openapi-operational-final-parity.test.ts` | 7 | 0 | 0 |
| `tests/openapi-operational-structural-closure.test.ts` | 8 | 0 | 0 |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | 13 | 0 | 0 |
| **Batch total** | **58** | **3** | **0** |

The three `mobile-cr-regression-contract` failures are outside the Part 02 diff and native token assertions:

1. Housekeeping operation count is pinned at 62 while the current surface has 72.
2. An old “no mobile-specific domain API” pin rejects five existing material routes.
3. Its custom resolvable-reference assertion rejects existing header/nested refs.

They remain legacy contract-maintenance evidence, not native response-security regressions. They were not “fixed” by weakening assertions in this scope. The current operational parity/structural/freeze trio itself passed **28/28**.

### Total executed focused tests

| PASS | FAIL | SKIPPED | Total |
|---:|---:|---:|---:|
| **195** | **4** | **0** | **199** |

All four failures are the unrelated legacy assertions itemized above. **All Part 02 native response-security tests passed.**

## 5. API compatibility handoff

Native Android clients must no longer read `data.pushToken` from:

- `POST /api/v1/mobile/push-tokens`;
- `GET /api/v1/mobile/push-tokens`;
- `DELETE /api/v1/mobile/push-tokens/{tokenId}`.

They continue to send the current raw token in the authenticated registration request, retain it in their own secure platform storage, rotate/re-register as before, and use the returned registration `id` plus non-secret lifecycle metadata. No consumer repository was accessed or changed.

## 6. Remaining issues and release effect

- **BA-01:** closed at implementation, OpenAPI, and focused regression level.
- **BA-09:** still open for production VAPID/FCM credentials, ACTIVE rules/templates, physical-device delivery/rotation/retry, and production P-6.5 evidence/log sweeps.
- **BA-13:** stale migration closure guard remains independently registered.
- Three unrelated `mobile-cr-regression-contract` failures remain for their owning contract-maintenance work; they are not silently reclassified as passes.
- No production migration, Biznet deployment, provider activation, scheduler change, or new PR was performed.
- **Backend FINAL FREEZE remains NOT READY; production migration and Biznet release remain NO-GO.**
