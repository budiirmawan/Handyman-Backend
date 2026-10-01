# CR-HM-01 AMENDMENT 01 (PART 12) — FINAL VALIDATION & CERTIFICATION
## Customer Care BM Handoff

**CR:** CR-HM-01 — Channel Context & Secure Handoff, AMENDMENT 01
**Repository:** Handyman-Backend (only)
**Certified on:** 2026-10-01, branch `arena/01a0f51e-handyman-backend`
**Validation HEAD:** `a534b79d6ff2a63cb7f9ffb03dd98b5c95ac51be`
(commit under certification = PART 12 certification commit)
**Governance authority:** `CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md`
(decisions D4–D8)
**Scope:** Customer Care amendment only — no repo-wide / full-suite / typecheck / build run.

**STATUS: AMENDMENT 01 PARTs 07–12 = COMPLETE (Customer Care handoff).**

---

## 1. Verified baseline (pre-work gate)

| Check | Result |
|---|---|
| Repository | `Handyman-Backend` |
| Assigned branch | `arena/01a0f51e-handyman-backend` — session branch |
| Working tree | CLEAN |
| HEAD at start | `a534b79d6ff2a63cb7f9ffb03dd98b5c95ac51be` == Expected `a534b79` |
| Mismatch | NONE — validation proceeded |

## 2. Certified end-to-end chain

Driven through the **real Express API** (supertest) against a real migrated
PostgreSQL — `tests/handyman-care-actor-e2e-certification.test.ts`:

```
signed BM assertion (per-integration HMAC over the canonical payload)
  → Customer Care actor attestation        (PART 08: capability + ACTIVE registry row)
  → represented tenant/building/unit resolution (PART 02 rules, unchanged)
  → one-time short-lived exchange          (hash-only token, returned once)
  → binding (atomic consume + attribution) (PART 04 + PART 10)
  → immutable channel attribution          (BM_SUPER_APP, append-only)
```

Certified HTTP evidence (`POST /api/v1/handoff/assertions` → 201;
`POST /api/v1/handoff/channel-attributions` → 201):

- `context.actorType = CUSTOMER_CARE`, `context.careActorId` = registry id,
  `context.actorReference` = attested reference;
- `context.tenantCompanyId/tenantPicId/buildingId/spaceId` = represented
  fixture values; `context.resolvedUserId` = the PIC's linked user;
- `attribution.actorType/careActorId/actorReference` persisted; `createdByUserId = null`;
- `attribution.originChannel = BM_SUPER_APP`;
  `originReference = bm-handoff:{integrationCode}:{assertionId}`;
- persisted exchange row `status = USED`, `token_hash = SHA-256(token)`,
  actor columns populated;
- append-only enforcement on the attribution row (UPDATE/DELETE → 23514).

## 3. Verification matrix

| Requirement | Evidence | Result |
|---|---|---|
| Working Acting Customer Care ≠ represented tenant/PIC | `context.careActorId ≠ resolvedUserId ≠ tenantPicId`; attribution actor set with `createdByUserId = null` | PASS |
| Actor claim signature-covered | swap actor after signing → 401; strip actor after signing → 401; add actor to legacy-signed → 401 | PASS |
| Actor claim server-resolved | invented member (`careActorId` in claim) → 401; resolution against registry via DB integration code | PASS |
| Incapable / unknown / inactive / foreign actor fails closed | 6-mode matrix → identical 401 `HANDYMAN_HANDOFF_ASSERTION_INVALID`, identical fingerprint (code/message/category/retryable), no internals in error body | PASS |
| No actor-bearing downgrade to legacy | rejected attempts create **zero** exchanges, **zero** replay records, **zero** attributions (table deltas) | PASS |
| Legacy handoff remains compatible | no-actor assertion: context actor fields `null`, `resolvedUserId` = linked user, attribution `createdByUserId` = linked user, channel/provenance unchanged | PASS |
| Exchange TTL preserved | `expiresAt` within (0, 120s] of acceptance | PASS |
| Exchange single-use preserved | second bind → 401 `HANDYMAN_HANDOFF_EXCHANGE_INVALID` | PASS |
| Exchange replay protection preserved | same assertion re-accepted → 409 `HANDYMAN_HANDOFF_ASSERTION_REPLAYED` | PASS |
| Exchange hash-only storage preserved | raw token never stored (0 rows matched by raw token); stored value is its SHA-256 | PASS |
| `created_by_user_id` not borrowed on care flow | attribution `createdByUserId = null` despite PIC having a linked user; DB trigger rejects a raw borrow attempt (23514) | PASS |
| No user/session/RBAC fabrication | `users`, `user_sessions`, `user_role_assignments` counts unchanged across the full chain | PASS |
| OpenAPI matches runtime | every runtime response key documented in `HandoffContextSnapshot` / `HandymanChannelAttribution`; claim schema `required [type, actorReference]`, enum `[CUSTOMER_CARE]`, `additionalProperties: false`; binding accepts only `exchangeToken`; exactly 2 handoff paths, none under `/webhooks` | PASS |

## 4. Focused test certification (executed 2026-10-01)

### Amendment suites (PART 07–12) — 54/54 PASS

| PART | Suite | Tests |
|---|---|---|
| 07 | `tests/handyman-care-actor-persistence.test.ts` | 13/13 |
| 08 | `tests/handyman-care-actor-resolver.test.ts` | 10/10 |
| 09 | `tests/handyman-handoff-care-actor-attestation.test.ts` | 8/8 |
| 10 | `tests/handyman-handoff-care-actor-attribution.test.ts` | 10/10 |
| 11 | `tests/handyman-handoff-care-actor-openapi.test.ts` | 7/7 |
| 12 | `tests/handyman-care-actor-e2e-certification.test.ts` | 6/6 |
| **Total** | | **54/54 PASS, 0 fail** |

### CR-HM-01 seam suites (pre-amendment regression baseline) — 43/43 PASS

| PART | Suite | Tests |
|---|---|---|
| 01 | `tests/handyman-channel-attributions.test.ts` | 13/13 |
| 02 | `tests/handyman-handoff-context.test.ts` | 10/10 |
| 03 | `tests/handyman-handoff-runtime.test.ts` | 7/7 |
| 04 | `tests/handyman-handoff-attribution-binding.test.ts` | 6/6 |
| 05 | `tests/handyman-handoff-http.test.ts` | 7/7 |
| **Total** | | **43/43 PASS, 0 fail** |

**Grand total: 97/97 PASS, 0 fail, 0 skipped**, on the real migrated
PostgreSQL test database (all migrations through `0427` applied cleanly).
`git diff --check`: clean.

## 5. Migration inventory (amendment)

| Migration | PART | Content |
|---|---|---|
| `0425_add_handyman_care_actor_registry` | 07 | integration `actor_capability` (default `NONE`), `handyman_handoff_care_actors` registry |
| `0426_add_handyman_handoff_exchange_actor_provenance` | 09 | exchange actor columns + coherence constraint |
| `0427_handyman_attribution_actor_provenance` | 10 | attribution actor columns + coherence constraint + no-borrow trigger |

Additive only; pre-amendment rows remain valid with NULL actor columns; no
backfill; append-only contracts preserved (PART 01/04 triggers untouched).

## 6. Frozen decisions D4–D8 — implementation status

- **D4 — ACTOR MODEL: IMPLEMENTED.** `CUSTOMER_CARE` registry actors exist as
  an identity class separate from every User/PIC/session surface.
- **D5 — ATTESTATION: IMPLEMENTED.** Signature coverage + integration
  actor-capability + ACTIVE registry resolution, with fail-closed,
  non-enumerating semantics and no silent downgrade.
- **D6 — REPRESENTATION: IMPLEMENTED.** Represented tenant/customer and
  building/unit are resolved by the unchanged PART 02 rules; the actor cannot
  widen, skip or substitute them.
- **D7 — SESSION & EXCHANGE: IMPLEMENTED.** No user/session created for the
  actor; the existing short-lived, hash-only, single-use, replay-protected
  exchange remains the only credential and carries nullable actor provenance.
- **D8 — ATTRIBUTION & COMPATIBILITY: IMPLEMENTED.** Attribution records
  immutable server-derived actor provenance; `created_by_user_id` is never
  borrowed from the represented PIC; legacy behavior is byte-compatible
  (proven by pinned canonical-signing parity and legacy end-to-end behavior).

Preserved invariants (re-verified): origin authentication ≠ business
authorization; customer ≠ building ≠ unit authorization; channel attribution
≠ BM financial entitlement ≠ SaaS entitlement.

## 7. BLOCKERS

**None.** No proven blocker was found; therefore no implementation or
refactor was performed in PART 12 (certification-only: one new test suite
plus this record).

Known pre-existing, unrelated project debt (documented in the original
CR-HM-01 certification, unchanged and out of scope here): project-wide
TypeScript check carries pre-existing errors elsewhere in the repository, and
`tests/migrate.test.ts` full-rollback is blocked by irreversible migration
0369. Neither concerns the amendment migrations (`0425`–`0427`), which apply
and migrate cleanly.

## 8. Certification statement

CR-HM-01 AMENDMENT 01 PARTs 07–12 are complete: the Customer Care BM handoff
is authenticated, attested, tenant-distinct, replay-safe, immutable — and
fully backward compatible. All twelve verification requirements above are
proven by executed tests on a real database and real HTTP surface; 97/97
focused tests pass; OpenAPI and runtime are in parity; legacy CR-HM-01 flows
are unaffected. No defects and no blockers were found during final
validation.

**CR-HM-01 AMENDMENT 01: COMPLETE.**
