# CR-HM-BAST-SIGN-00 — Negative Security Test Matrix

## Purpose
This matrix documents negative security tests that validate the BAST authority design. Each test describes an attacker scenario, the expected API response, and the security requirement it validates.

---

## Test Table

| Test ID | Scenario | Expected API Response | Security Requirement Validated |
|---|---|---|---|
| **NST-01** | Submit ACCEPT with empty `signatureDigest` | 400 `handymanBastSignatureRequiredError` | Signature must be non-empty for ACCEPT (enforced by `assertHandymanBastSignature`) |
| **NST-02** | Submit ACCEPT with arbitrary 512-char hash (no challenge binding) | 400 validation error — "signature not challenge-verifiable" | Signature must be challenge-response verifiable, not an arbitrary browser-supplied hash |
| **NST-03** | Submit REJECT without `rejectReason` | 400 validation error — "rejectReason is required" | rejectReason is mandatory for REJECT (DB CHECK constraint + validation) |
| **NST-04** | Replay same `idempotencyKey` for ACCEPT after first success | 200 (replay) — returns original event with `replayed: true` | Idempotency key prevents duplicate processing; second request gets winner's event |
| **NST-05** | Second ACCEPT/REJECT for same event (different key) | 409 — UNIQUE constraint on `event_id` violated | Only one sign-off per event (enforced by `handyman_bast_sign_offs_event_idx UNIQUE`) |
| **NST-06** | ACCEPT on VOIDed BAST | 409 `handymanBastIllegalTransitionError` — cannot transition from VOID | BAST status gate: VOID is terminal; new BAST must be PREPARED for same scope |
| **NST-07** | ISSUE without current QC PASS | 409 `handymanBastQcNotReadyError` from `assertCurrentGuardedHandymanQcPass` | ISSUE requires current guarded Supervisor QC PASS (stringent checklist enforcement) |
| **NST-08** | ACCEPT on DRAFT BAST | 409 `handymanBastIllegalTransitionError` — DRAFT → ACCEPT not allowed | Status transition gate: must be ISSUED → ACCEPT (SIGN_OFF_FROM = ['ISSUED']) |
| **NST-09** | Submit `signatureDigest` > 512 characters | 400 `handymanBastSignatureRequiredError` | Signature length limit enforced (max 512 chars) |
| **NST-10** | Cross-client BAST sign-off (different `client_id` in sign-off vs. BAST) | 409 — trigger raises "Handyman BAST identity (client/scope) is immutable" | Client/scope identity is immutable (trigger enforcement) |
| **NST-11** | No building guard check (use `canAccessClient` as sole gate) | 403 — `assertBuildingScopedResourceAccess` rejects | Building guard from exact execution scope is mandatory; `canAccessClient` is insufficient |
| **NST-12** | Replay old signature without challenge nonce (stale nonce) | 401/400 — signature verification fails (challenge mismatch, expired nonce) | Challenge-response prevents replay; nonce must be fresh (< 5 min) |
| **NST-13** | ACCEPT with `evidenceRecordId` pointing to wrong `execution_scope_id` | 400 validation error — "evidenceRecordId must match parent BAST execution_scope_id" | Evidence record FK must match BAST's execution_scope_id and client_id |
| **NST-14** | Concurrent ACCEPT race condition (two requests simultaneously) | 409 — optimistic concurrency: second request gets ILLEGAL_TRANSITION | BAST UPDATE uses `WHERE id = $1 AND status = $3`; only one writer wins |
| **NST-15** | VOID without `voidReason` (worker API) | 400 validation error — "voidReason is required" | VOID requires reason in event metadata (CR-HM-BAST-HTTP-01) |
| **NST-16** | Delete BAST document via any API | 409 — "Handyman BAST documents cannot be deleted" | Deletion blocked by trigger (`handyman_bast_head_identity_guard`) |
| **NST-17** | Update BAST `client_id` or `execution_scope_id` | 409 — "Handyman BAST identity (client/scope) is immutable" | Identity mutation blocked by trigger; prevents cross-client spooling |
| **NST-18** | Sign-off with signature from wrong `tenant_pic_id` | 401/400 — signature verification fails (tenant PIC mismatch) | Signature must be bound to the correct tenant PIC from the execution scope |
| **NST-19** | Submit ACCEPT after BAST already `ACCEPTED` or `REJECTED` | 409 — status gate prevents transition from non-ISSUED state | ACCEPT/REJECT only from ISSUED; ACCEPTED/REJECTED are terminal states |
| **NST-20** | Challenge nonce replay after expiration (> 5 minutes) | 400/401 — "nonce expired" error | Nonce has fixed expiry (recommended 5 min); after expiry, new challenge required |
| **NST-21** | ACCEPT with `signatureDigest` that doesn't cover `tenantPicId` | 401 — "tenant_pic_mismatch" — signature verification fails | Signature must be bound to the specific tenant PIC from the execution scope |
| **NST-22** | ACCEPT with `signatureDigest` that doesn't cover `bastStateHash` | 400 — "invalid_payload_format" — signature doesn't include required fields | Signature must cover the BAST state hash at signing time (prevents sign-then-mutate) |
| **NST-23** | REJECT with `rejectReason` exceeding 2000 characters | 400 validation error — "rejectReason must not exceed 2000 characters" | Reject reason length limit enforced (max 2000 chars) |
| **NST-24** | Submit sign-off with `event_id` that doesn't match any ACCEPT/REJECT event | 404 — sign-off creation fails (no matching event) | Sign-off must be bound to a valid ACCEPT/REJECT event |
| **NST-25** | ACCEPT when BAST status is already `ACCEPTED` (second accept) | 409 — "Handyman BAST illegal transition" from ACCEPTED | ACCEPTED is terminal; no further transitions allowed |
| **NST-26** | ISSUE when BAST status is already `ISSUED` (double issue) | 409 — "Handyman BAST illegal transition" from ISSUED | ISSUED can only transition to ACCEPTED/REJECTED/VOID (via sign-off) or be VOIDed |
| **NST-27** | Cross-building access (BAST under Building A, actor from Building B, same client) | 403 — building guard rejects | BAST is isolated by building; same client different building = denied access |
| **NST-28** | Submit sign-off with invalid UUID format for `evidenceRecordId` | 400 validation error — "evidenceRecordId must be a valid UUID" | UUID format validation on all FK fields |
| **NST-28** | Exploit replay without idempotencyKey | 409 — duplicate event detection | Idempotency key is required for all event creation; without it, replay is blocked |

**Total tests**: 28 negative security test cases covering:
- Signature provenance (NST-01, 02, 09, 12, 18, 21, 22)
- Status gating (NST-06, 07, 08, 15, 19, 22, 23, 25, 26)
- Building/client isolation (NST-10, 11, 27)
- Idempotency and concurrency (NST-04, 05, 14)
- Evidence provenance (NST-13, 24)
- Reject reason requirements (NST-03, 23)
- Deletion and mutation blocking (NST-16, 17)
- Challenge nonce replay (NST-12, 20)
- UUID format validation (NST-25... wait NST-28 duplicate, let me recount)