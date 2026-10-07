# CR-BE-CI-01 — Deferred CI Debt & Governance Record

- **Date:** 2026-08-23
- **Change Request:** CR-BE-CI-01 (Continuous Integration & Automated Regression Gate)
- **PR:** [#53](https://github.com/budiirmawan/Asentra-Backend/pull/53)
- **Status:** DEFERRED CI DEBT GOVERNANCE RECORD

---

## 1. Executive Summary

CR-BE-CI-01 established the canonical GitHub Actions CI workflow (`.github/workflows/ci.yml`) with:
- PostgreSQL 16 service container (`asentra_test`) with health checks.
- Clean sequential lifecycle: `actions/checkout` → `actions/setup-node` → `npm ci` → `npm run db:migrate` → regression gates.
- Deterministic sibling test steps with `npx tsx --test --test-concurrency=1` and `set -euo pipefail` guards.
- Immediate contract alignment fixes for:
  - `tests/sessions.test.ts`: `GET /api/v1/auth/me` updated to include `scope` (`BE-25B` / OpenAPI `EffectiveUserContext` contract).
  - `tests/work-orders.test.ts`: `PUBLIC_WORK_ORDER_KEYS` updated to include `bastRequirement` (`CR-BE-COM-02` / `CR-BE-BAST-01` / OpenAPI `WorkOrder` contract).

Per governance policy, full CI stabilization is deferred to prevent altering production code or chasing legacy test assertion drifts.

---

## 2. CI Architecture Preserved

The GitHub Actions workflow configuration remains intact and authoritative:
- **Service**: `postgres:16` on `localhost:5432` with database `asentra_test`.
- **Node**: Version 20.
- **Workflow Steps**:
  1. `npm ci`
  2. `npm run db:migrate`
  3. `Identity / RBAC / Isolation regression tests`
  4. `Core operational regression tests`
  5. `Remaining DB-backed regression tests`
- **Zero test deletion / zero test weakening**: All 315 DB-backed test suites remain wired in CI.

---

## 3. Classification of Deferred CI Debt

Legacy test suites written prior to late-stage CRs (e.g. BE-24 through BE-27, CR-BE-COM-02, CR-BE-R2P-01, CR-BE-STAB-01..03) may contain exact key-set assertions (e.g. `assert.deepEqual(Object.keys(response.body.data).sort(), [...])`) that do not yet include fields subsequently added to the canonical domain entities.

### Governance Rules:
1. **Production Code Stability**: Never modify production business logic or remove canonical API fields to satisfy obsolete test assertions.
2. **Incremental Remediation**: Resolve remaining test assertion drifts in focused domain-specific follow-ups.
3. **Tracking**: Recorded in `docs/known-issues.md` under **KI-003**.

---

## 4. Verification Evidence

- `npm run typecheck`: PASSED (0 errors)
- `tests/sessions.test.ts` & `tests/mobile-auth-contract.test.ts`: PASSED
- `tests/work-orders.test.ts` & `tests/mobile-work-order-contract.test.ts`: PASSED
- `git diff --check`: PASSED (clean)
