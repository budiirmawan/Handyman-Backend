# HANDYMAN BACKEND — MANUAL RELEASE SOURCE CERTIFICATION

## 1. Owner policy and evidence boundary

The CR Owner has selected the local/Arena certification runner as the BA-07
release-verification mechanism. Paid GitHub Actions and required GitHub status
checks are deliberately **not adopted**. No `.github/workflows` workflow is part
of the approved implementation, and no branch-protection or hosted-CI claim is
made.

BA-07 is closed only at the **manual verification implementation and recorded
local evidence** boundary. Final Review, documented manual release approval
before merging, and BA-08 through BA-11 remain separate gates. This procedure
does not authorize a merge, production deployment/migration, scheduler or push
activation, or a connection to Railway, Biznet, Coolify, staging, or production.

The previously achieved **621 PASS / 0 FAIL / 0 SKIPPED across 58 files** is
local evidence from the pre-reconstruction implementation tree. It is not
GitHub-hosted evidence and is not represented as a new execution on the clean
replacement commit. The Owner directed that it not be repeated during history
reconstruction. Any later release-candidate change requires a new recorded run
or an explicit Owner acceptance decision; never copy old counts into a new run
record.

## 2. Prerequisites

- Canonical branch: `arena/2d32486d-handyman-backend`.
- A clean worktree and the exact source SHA intended for certification.
- Node.js **22** and the locked npm dependency tree.
- PostgreSQL **18**, listening only on a local/disposable profile.
- Empty disposable databases named `asentra_ci_catalog`, `asentra_ci_core`,
  `asentra_ci_notification`, and a fresh `asentra_ci_migration`.
- No production credentials or provider configuration. Push providers remain
  `noop` and integration webhooks remain disabled.

Several suites also start and remove their own embedded disposable PostgreSQL
clusters. Keep their fixed local ports/directories available and execute each
manifest sequentially as shown; do not run conflicting embedded suites in
parallel. Database-unavailable skips are failures, not certification evidence.

## 3. Five lanes and expected inventory

| Lane | Purpose | Files | Expected product results |
|---|---|---:|---:|
| `static-contracts` | OpenAPI operational parity, structural closure, and Handyman freeze guards | 3 | 28 |
| `catalog-commerce` | Catalog, pricing, currency, BA-02, and BA-23 authority | 12 | 123 |
| `core-lifecycle` | Finance, field/work, tenant, crew, readiness, Care, and BM-fee authority | 31 | 254 |
| `notification-security` | BA-01 response secrecy, producer, browser, native token, fan-out, and provider evidence | 11 | 210 |
| `migration-recovery` | BA-03 populated-down refusal, empty round-trip, and disposable recovery | 1 | 6 |
| **Total** | **Bounded product certification; not the full repository suite** | **58** | **621** |

The static lane is accompanied by workflow-independent configuration
validation, runner self-tests, canonical migration-registry validation, and
`npm run typecheck`. The migration lane is accompanied by fresh CLI apply,
status/readiness, and idempotent-reapply validation.

## 4. Fail-closed execution and explicit selections

`scripts/ci/run-focused-tests.mjs` runs each manifest entry in a separate Node
process with `--test-reporter=tap`, `--test-concurrency=1`, and a per-file
timeout. A lane exits nonzero for any of the following:

- nonzero test exit, timeout, or missing TAP summary;
- failed, cancelled, skipped, or todo result;
- PASS or TESTS count different from the checked-in expected count;
- zero/drifted coverage or any other manifest/result mismatch.

The runner reports every selected file, writes `summary.json`, `summary.md`,
and per-file TAP logs, and sets a nonzero process exit if any file fails.
`scripts/ci/test-focused-test-runner.mjs` uses synthetic fixtures to prove a
passing control succeeds while deliberate failure and skip cases are rejected.
Those synthetic harness cases are not included in the 621 product count.

Three explicit checked-in selections exclude only registered P2 stale
structural assertions; non-selected cases are not relabeled as passes or skips:

| Debt | Required selected result | Sole exclusion |
|---|---:|---|
| BA-13 | 17 `push01-part05-mobile-contract-and-openapi` cases | Global 0336 migration-cap assertion |
| BA-14 | 10 `handyman-quotations-api` cases (1–9 and 11) | Case 10 over-broad schema selector |
| BA-15 | Five BM-fee runtime/configuration cases t2–t6 | Stale migration-closure pin t1 |

These selections do not edit, weaken, delete, or close BA-13/BA-14/BA-15.
BA-14 remains independent P2 debt. No full-suite PASS is claimed.

## 5. Exact manual execution

Run from the repository root. The commands below retain logs with `tee` and
use `pipefail` so a failed command cannot be hidden by a successful log write.
Adjust only the local disposable PostgreSQL port/credentials for the runner
profile; never point these commands at a real environment.

```bash
set -euo pipefail

test "$(git branch --show-current)" = "arena/2d32486d-handyman-backend"
test -z "$(git status --porcelain)"
node --version  # must be Node.js 22.x
npm ci --no-audit --no-fund

export SOURCE_SHA="$(git rev-parse HEAD)"
export RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export EVIDENCE_ROOT="${TMPDIR:-/tmp}/handyman-ba07-${SOURCE_SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_ROOT"
printf 'source_sha=%s\nrun_started_at=%s\nnode=%s\npostgres_major=18\n' \
  "$SOURCE_SHA" "$RUN_STARTED_AT" "$(node --version)" \
  > "$EVIDENCE_ROOT/run-metadata.txt"

export NODE_ENV=test LOG_LEVEL=error CI=true
export ASENTRA_USE_EMBEDDED_POSTGRES=true
export DB_HOST=127.0.0.1 DB_PORT=5432
export DB_USER=postgres DB_PASSWORD=postgres DB_SSL=false
export PUSH_PROVIDER=noop PUSH_BROWSER_PROVIDER=noop
export INTEGRATION_WEBHOOKS_ENABLED=false

node scripts/ci/validate-ci.mjs \
  2>&1 | tee "$EVIDENCE_ROOT/00-configuration.log"
node scripts/ci/test-focused-test-runner.mjs \
  2>&1 | tee "$EVIDENCE_ROOT/01-runner-selftest.log"
node --import tsx scripts/ci/validate-migration-registry.ts \
  2>&1 | tee "$EVIDENCE_ROOT/02-migration-registry.log"
npm run typecheck \
  2>&1 | tee "$EVIDENCE_ROOT/03-typecheck.log"

CI_ARTIFACT_DIR="$EVIDENCE_ROOT/static-contracts" \
  node scripts/ci/run-focused-tests.mjs static-contracts \
  2>&1 | tee "$EVIDENCE_ROOT/10-static-contracts.log"

DB_NAME=asentra_ci_catalog CI_ARTIFACT_DIR="$EVIDENCE_ROOT/catalog-commerce" \
  node scripts/ci/run-focused-tests.mjs catalog-commerce \
  2>&1 | tee "$EVIDENCE_ROOT/20-catalog-commerce.log"

DB_NAME=asentra_ci_core CI_ARTIFACT_DIR="$EVIDENCE_ROOT/core-lifecycle" \
  node scripts/ci/run-focused-tests.mjs core-lifecycle \
  2>&1 | tee "$EVIDENCE_ROOT/30-core-lifecycle.log"

DB_NAME=asentra_ci_notification CI_ARTIFACT_DIR="$EVIDENCE_ROOT/notification-security" \
  node scripts/ci/run-focused-tests.mjs notification-security \
  2>&1 | tee "$EVIDENCE_ROOT/40-notification-security.log"

# This validator refuses a nonempty migration history. Recreate only the
# disposable asentra_ci_migration database before a genuinely fresh run.
DB_NAME=asentra_ci_migration \
  node --import tsx scripts/ci/verify-migration-lifecycle.ts \
  2>&1 | tee "$EVIDENCE_ROOT/50-migration-lifecycle.log"
DB_NAME=asentra_ci_migration CI_ARTIFACT_DIR="$EVIDENCE_ROOT/migration-recovery" \
  node scripts/ci/run-focused-tests.mjs migration-recovery \
  2>&1 | tee "$EVIDENCE_ROOT/51-migration-recovery.log"

test "$SOURCE_SHA" = "$(git rev-parse HEAD)"
printf 'run_finished_at=%s\nsource_sha_after=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git rev-parse HEAD)" \
  >> "$EVIDENCE_ROOT/run-metadata.txt"
```

Expected final lane totals are **28 + 123 + 254 + 210 + 6 = 621 PASS**, with
**0 FAIL and 0 SKIPPED**. Registry validation must report 478 files and 478
entries; a fresh migration lifecycle must report 478 applied, 478 in status,
and `SECOND_APPLY=NO_OP`.

## 6. Evidence retention and manual release approval

Each lane directory contains its TAP files plus JSON and Markdown summaries.
Retain those directories, the numbered console logs, and `run-metadata.txt`
together. Do not dump environment variables, credentials, production data, or
database backups into the evidence pack.

Create an archive and digest only after every command has passed:

```bash
tar -czf "$EVIDENCE_ROOT.tar.gz" \
  -C "$(dirname "$EVIDENCE_ROOT")" "$(basename "$EVIDENCE_ROOT")"
sha256sum "$EVIDENCE_ROOT.tar.gz" > "$EVIDENCE_ROOT.tar.gz.sha256"
```

Attach the archive, digest, and the following approval record to Final Review
under the release owner's approved retention policy. Do not commit generated
evidence archives to Git.

```text
source_sha:
run_started_at:
run_finished_at:
evidence_archive_sha256:
configuration_and_runner_selftest: PASS / FAIL
registry_typecheck_and_migration_lifecycle: PASS / FAIL
product_results: 621 PASS / 0 FAIL / 0 SKIPPED
reviewer:
reviewed_at:
decision: APPROVE FOR MERGE / REJECT
notes:
```

A reviewer must compare the recorded SHA with the proposed merge commit,
inspect all summaries and exits, and sign the approval **before merging**.
Approval is manual; there is no automatic merge, required-check substitute, or
production auto-deployment. If the source SHA changes, the prior approval does
not transfer automatically.

## 7. Current disposition

- Local verification implementation: **COMPLETE**.
- Recorded local product evidence: **621/621 PASS, 0 FAIL, 0 SKIPPED**.
- Automated GitHub checks: **DELIBERATELY NOT ADOPTED**.
- Manual release approval before merging: **PENDING FINAL REVIEW**.
- BA-07: **CLOSED at the Owner-approved manual source-certification boundary**.
- BA-08 through BA-11: **OPEN**; production and Biznet remain **NO-GO**.
