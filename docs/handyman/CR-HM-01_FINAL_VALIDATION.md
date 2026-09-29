# CR-HM-01 — FINAL VALIDATION & CERTIFICATION

**CR:** CR-HM-01 — Immutable Channel Attribution + Trusted BM Super App Handoff
**Repository:** Handyman-Backend (only)
**Certified on:** 2026-09-27, branch `arena/01a0e01e-handyman-backend`
**Validation HEAD:** `f10cc363ca678806592e4dfba72dd02819986023`

**STATUS: CR-HM-01 = COMPLETE.**

---

## 1. Scope delivered

Trusted channel attribution plus a secure BM Super App handoff, end to end:

```
signed BM assertion
  → trusted integration verification (per-integration scoped HMAC, timing-safe)
  → freshness + replay protection (bounded validity window, append-only record)
  → canonical context resolution (server-side; claims never authoritative)
  → short-lived one-time exchange (token returned once, SHA-256 hash at rest)
  → atomic single-use exchange consumption
  → immutable channel attribution (BM_SUPER_APP, full provenance)
```

No standard user session is ever created, no service request is created, and
the attribution carries no BM financial entitlement and no SaaS entitlement.

## 2. PART 01–05 commits

| PART | Commit | Content |
|---|---|---|
| PART 01 | `c5eaae215201568a2b98b1c4f9a4d36b1fce8b5b` | Immutable `handyman_channel_attributions` foundation (append-only at DB + service level; tenant isolation derived; origin-reference uniqueness) |
| PART 02 | `b1bec64b3060d561b4d81657f181d0da9855b7f0` | Non-authenticating canonical handoff context resolver (no persistence, no side effects) |
| Freeze | `de86ccc33c8d9c1eb7a656833c219ec6721efa2f` | Governance §9: D1/D2/D3 decisions frozen (docs-only) |
| PART 03 | `6288d2e7b77f7212f142725bb38dae60c5623e4f` | Secure handoff runtime: integration trust metadata, append-only assertion replay records, single-use exchange (D1/D2) |
| PART 04 | `0dd7dbf68a9d27c1307ef94904542ef4795fdf31` | Atomic binding seam: one-time exchange → immutable channel attribution (existing `withTransaction` convention) |
| PART 05 | `f10cc363ca678806592e4dfba72dd02819986023` | HTTP + OpenAPI under `/api/v1/handoff/*` (D3); no `/webhooks` exposure |

## 3. Focused test certification (PART 06 run)

| Suite | File | Result |
|---|---|---|
| PART 01 | `tests/handyman-channel-attributions.test.ts` | 13/13 PASS |
| PART 02 | `tests/handyman-handoff-context.test.ts` | 10/10 PASS |
| PART 03 | `tests/handyman-handoff-runtime.test.ts` | 7/7 PASS |
| PART 04 | `tests/handyman-handoff-attribution-binding.test.ts` | 6/6 PASS |
| PART 05 | `tests/handyman-handoff-http.test.ts` (incl. OpenAPI parse/contract) | 7/7 PASS |
| **TOTAL** | | **43/43 PASS, 0 fail** |

Executed against the real migrated PostgreSQL test database (all migrations
through 0375 applied cleanly); Express app driven via supertest for PART 05.
Only the five CR-HM-01 focused files were run — no broad suite.

## 4. Security invariants — verified

1. **Untrusted payload never authoritative** — context claims are always
   re-resolved server-side (PART 02) and attribution derives only from the
   exchange snapshot.
2. **Company/building/space isolation** — enforced: building↔client linkage,
   active tenant-building context, space-relationship and PIC-company rules
   re-validated at attribution creation (PART 01 service).
3. **Invalid/expired/replayed assertions fail closed** — one
   non-enumerating 401 `HANDYMAN_HANDOFF_ASSERTION_INVALID` for
   malformed/unknown-integration/bad-signature/expired; 409
   `HANDYMAN_HANDOFF_ASSERTION_REPLAYED` via append-only replay record.
4. **Exchange short-lived, hash-only, single-use** — default 120s TTL; raw
   token returned once, SHA-256 hash at rest (proven); second use/expiry/
   unknown token → identical non-enumerating 401
   `HANDYMAN_HANDOFF_EXCHANGE_INVALID`; race-safe conditional UPDATE.
5. **Exchange ≠ standard user session** — `user_sessions` count unchanged
   across accept/consume/bind (proven); D2 honored.
6. **Attribution immutable** — append-only service surface (no update/delete);
   DB trigger rejects UPDATE/DELETE; uniqueness on origin reference.
7. **Attribution context only from trusted exchange snapshot** — binding
   accepts only the exchange token; tenant/building/space/channel ids are
   never caller-supplied (PART 04, tests 1–2).
8. **Binding atomic with consumption** — one transaction; attribution failure
   rolls back the exchange consumption (proven, PART 04 test 4).
9. **No service request creation** — `tenant_service_requests` unchanged
   (proven).
10. **No BM financial entitlement** — no financial code paths in any part.
11. **No SaaS entitlement** — no SaaS control-plane interaction.
12. **No FM workflow** — no work/finding/workflow surfaces touched.
13. **No secret/signature/token-hash exposure** — secrets exist only in
    server env config (`HANDYMAN_HANDOFF_SECRET_<CODE>`), never stored or
    logged; raw signature/exchange token never logged or echoed (client-side
    travel only: signature header in, token body out/in) — proven by PART 03
    and PART 05 test 6.
14. **HTTP only under `/api/v1`** — `POST /api/v1/handoff/assertions`,
    `POST /api/v1/handoff/channel-attributions`; nothing under `/webhooks`
    (asserted by OpenAPI test).
15. **OpenAPI matches the actual HTTP surface** — parsed spec asserts both
    paths, the `handoffAssertionSignature` header scheme (no Bearer
    substitute: Bearer never consulted, no session minted), documented
    201/400/401/409 contracts and the five request/response schemas; no
    hypothetical endpoints.

## 5. Migration inventory

| Migration | PART | Content |
|---|---|---|
| `0374_create_handyman_channel_attributions` | PART 01 | `handyman_channel_attributions` (append-only trigger, origin-reference uniqueness) |
| `0375_create_handyman_handoff_runtime` | PART 03 | `handyman_handoff_integrations` (trust metadata only, no secret column), `handyman_handoff_assertions` (append-only replay store), `handyman_handoff_exchanges` (hash-only token, canonical context snapshot, single-use status) |

PART 02, PART 04, PART 05 added **zero** migrations. Total: 2 migrations,
5 tables. No schema changes beyond these.

## 6. Frozen decisions (governance §9, commit `de86ccc…`) — implementation status

- **D1 — signed server-to-server handoff assertion:** IMPLEMENTED.
  Per-BM-integration scoped HMAC-SHA256 (`sha256=<hex>`, timing-safe),
  short-lived assertions, replay-protected, secrets only in env config;
  BM client payloads never trusted alone.
- **D2 — distinct one-time exchange, no automatic session:** IMPLEMENTED.
  Short-lived single-use exchange precedes any downstream use; no standard
  user session is created by accept/consume/bind; canonical context resolved
  first; `tenant_pics.userId` nullability never bypassed or fabricated.
- **D3 — interactive surface under versioned `/api/v1`, never `/webhooks`:**
  IMPLEMENTED with PART 05 paths above and authoritative OpenAPI entries.
- **Preserved invariants:** origin-authentication ≠ business authorization;
  customer ≠ building authorization; building ≠ unit authorization;
  attribution ≠ BM financial entitlement; attribution ≠ SaaS entitlement —
  all held (no entitlement/authorization logic exists anywhere in CR-HM-01).

## 7. Known unrelated / pre-existing debt (not CR-HM-01)

- Project-wide TypeScript check carries **23 pre-existing errors** (deferred
  CI debt, documented in `docs/BE-24/CR-BE-CI-01*`-era debt tracking); none
  in CR-HM-01 files. Per PART instructions, no project-wide typecheck was
  run as a gate for this CR.
- `tests/migrate.test.ts` full-rollback path is blocked by the irreversible
  migration 0369 (pre-existing design debt, unrelated to CR-HM-01
  migrations 0374–0375, which apply and migrate cleanly).
- Legacy untracked `node_modules/` in the workspace is intentionally never
  staged or committed.

## 8. Certification statement

CR-HM-01 PART 01–06 complete: all acceptance criteria of every PART met,
43/43 focused tests pass, all fifteen security invariants verified, API and
OpenAPI are in parity, migrations are exactly the two enumerated above, and
frozen decisions D1/D2/D3 are fully implemented. No defects found during
final validation.

**CR-HM-01: COMPLETE.**
