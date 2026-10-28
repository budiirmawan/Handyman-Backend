# Handyman Release Candidate Preflight — CR-HM-PRODUCTION-01 Part 01

**Assessment date:** 2026-10-28 UTC (source reconciliation addendum performed 2026-10-29)  
**Purpose:** truthful source/config/migration preflight before Biznet staging. No staging or production system was accessed; no database writes, tests, deployments, merges, or cutovers were performed. This document is a preflight, not authorization to deploy.

## Decision

**Overall: BLOCKED / NO-GO for staging release-candidate certification.** Source reconciliation now identifies the actual Backend candidate as remote branch `origin/arena/7c4baf34-handyman-backend` at `706f30fca9e5dad299f866be493e810231f536e7`. It descends from `origin/main` `11fad55ecae7a153df51cc463290ecc2ad70175c`; all main commits are ancestors of the candidate. The candidate contains the BM settlement changes and migration registry through `0534`. This verifies Backend Git source only—not frontend integration, database 18.6 compatibility, staging state, or release readiness.

## Source identity and ancestry

| Source/ref | Verified SHA and relationship | Result |
|---|---|---|
| Backend `origin/main` | `11fad55ecae7a153df51cc463290ecc2ad70175c` | Baseline; ancestor of feature and documentation refs. |
| Backend verified integration / feature branch | `origin/arena/7c4baf34-handyman-backend` = `706f30fca9e5dad299f866be493e810231f536e7` | Actual candidate source; includes 96 commits beyond main, including integration SHA itself. Main has 0 commits absent from candidate. |
| Documentation branch | `origin/arena/562a1b9b-handyman-backend` = `a7814cd483bd6ed64e36efdc03b3433036567385` | One documentation commit beyond main; its parent is main. The doc branch is not an ancestor of the candidate (and candidate is not an ancestor of doc branch). No product commits were added to the doc branch. |
| Operations | `94095147a99211cfbe04ff6141428ebe05993b90` supplied by requester | Separate repository remote/ancestry is not verifiable from this Backend repository. |
| Customer Care | latest branch said to include `39659a67` | Full remote branch/HEAD and ancestry remain unverified. |
| Mobile/PWA | No SHA supplied | Latest verified commit/readiness remain unverified; do not presume ready. |

**Feature inclusion relative to Backend main:** `git rev-list --left-right --count origin/main...origin/arena/7c4baf34-handyman-backend` = `0 96`; therefore no main-side commits are missing from the candidate. This does not prove inclusion of work from unrelated repositories or undocumented/unmerged branches.

## Backend component source matrix (presence in candidate tree)

| Component | Evidence at candidate | Status |
|---|---|---|
| Finance / financial reconciliation | `handyman-finance-close-api` and financial migrations, including `0482_handyman_financial_reconciliation` | **PRESENT** (source tracked; runtime verification not performed) |
| BAST | `handyman-bast*` modules and migrations including `0516_handyman_bast_official_documents` | **PRESENT** (source tracked) |
| Invoice | Invoice modules and `0520_handyman_official_invoices`, `0521_handyman_official_invoice_payments` | **PRESENT** (source tracked) |
| Payment | Customer payment/allocation/receipt modules and related migrations, including `0532_handyman_payment_receipt_numbering` | **PRESENT** (source tracked) |
| Warranty | Warranty modules and migrations `0522–0529` (terms, certificates, assessment, rework, complaints, resolution) | **PRESENT** (source tracked) |
| BM Settlement | `handyman-bm-settlement` module, BM settlement migration history including `0505_handyman_bm_settlement_payment_evidence`, and final `0534_handyman_bm_settlement_supersession`; candidate tip commit is the secure payout-evidence API change | **PRESENT** (source tracked) |
| Request CLOSE | `handyman-finance-close-api/handyman-final-close.service.ts` and `handyman-finance-close-api.routes.ts`; implementation enforces close prerequisites including active crew, completed sessions, settled materials, QC, and finalized invoice | **PRESENT** (source tracked; no execution/test claim) |

This matrix confirms repository source presence, not deployment, migration application, correctness against external clients, or signed acceptance.

## Release gate matrix

| Gate | Status | Evidence / condition to close |
|---|---|---|
| Backend source identity and main ancestry | **PASS** | Candidate `706f30f…`; `origin/main` `11fad55…` is its ancestor; 0 main commits missing. |
| Finance / BAST / Invoice / Payment / Warranty / BM Settlement / Request CLOSE source presence | **PASS — source only** | Verified in candidate tree as listed above; no runtime/full-suite revalidation performed. |
| Operations source identity/inclusion | **BLOCKED** | Verify actual Operations remote HEAD and completed-branch ancestry. |
| Customer Care source identity/inclusion | **BLOCKED** | Resolve full SHA for branch said to include `39659a67`; verify ancestry. |
| Mobile/PWA readiness/inclusion | **BLOCKED** | No latest SHA or signed compatibility/integration report; must not assume ready. |
| PostgreSQL migration artifact order | **PASS — static registry only** | Candidate registry ends at `0534_handyman_bm_settlement_supersession`; see migration section. Registry presence/order is not target migration readiness. |
| PostgreSQL 18.6 compatibility / BM settlement upgrade | **BLOCKED** | No evidence here proves PostgreSQL 18.6 execution, target status, or compatibility of candidate migrations `0481–0534`. No Biznet DB inspection/write performed. |
| Backend ↔ frontend API compatibility | **BLOCKED** | Backend OpenAPI contract exists at `docs/api/openapi.yaml` and `/api/v1`; no verified frontend SHAs/contracts/integration reports available for comparison. |
| Required production configuration | **CONDITIONAL / BLOCKED for activation** | See environment requirements below; actual secret-manager provisioning and values were not inspected. |
| Document/evidence persistence | **BLOCKED** | Backend supports local evidence storage only. Prove durable persistent volume at `/app/.data/evidence`, permissions, restart/redeploy persistence, and DB/file reference integrity on staging. |
| Push notifications | **BLOCKED for production delivery** | Provider credentials and physical delivery/rotation/retry evidence are not verified. Keep provider activation fenced until approved. |
| Cross-app E2E | **BLOCKED** | No signed Care → Operations → PWA → Backend E2E evidence against a single exact candidate source/image. |
| Biznet staging readiness | **BLOCKED** | Must close external source identity, migration 18.6 rehearsal, backup/restore and persistence, consumer compatibility, E2E, configuration, and release approval gates. |

## Migration prerequisites and compatibility

**Actual candidate registry tip: `0534_handyman_bm_settlement_supersession`.** This was read from `src/database/migrations/index.ts` on the verified feature branch, not inferred from `main` or old preflight notes. Candidate registry also includes migrations `0481–0533`, with documented numbering gaps possible; registry order/file reconciliation was inspected statically only. Migration `0534` is the latest BM settlement migration. No migrations were executed.

Earlier repository reconciliation evidence covers disposable PostgreSQL **18.4** only through `0472`; it does not establish compatibility for the candidate's subsequent migrations through `0534` or PostgreSQL 18.6. Before staging: (1) confirm exact candidate artifact and registry; (2) obtain staging migration status and prove no unknown/newer history; (3) make and validate an encrypted database-plus-evidence backup/restore pair; (4) rehearse fresh install and populated upgrade on PostgreSQL 18.6 with production-like data, especially BM settlement ordering/constraints and migrations after `0472`; (5) record one-shot apply and no-op second apply; (6) keep scheduler disabled and traffic fenced until checks pass. Use forward recovery; do not assume down migrations are safe. Production/target migration remains explicitly out of scope.

## Environment, secrets, storage, uploads and notifications

Use the deployment secret manager; never place secret values in this manifest, logs, images, or source control. The backend deployment matrix identifies core settings: `NODE_ENV`, `PORT`, `API_PREFIX`, `LOG_LEVEL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`, exact `CORS_ORIGINS`, `EVIDENCE_STORAGE_DRIVER`, `EVIDENCE_STORAGE_DIR`, `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MS`, request/session/rate-limit settings, and provider selectors `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER`, `PUSH_PROVIDER`. Set DB fields explicitly; application config uses `DB_*`, not `DATABASE_URL` or `PG*`. Keep scheduler disabled during staging provisioning and migration; only one approved active scheduler instance.

Evidence storage currently accepts `EVIDENCE_STORAGE_DRIVER=local`; use a durable mount at `/app/.data/evidence` (or the explicitly configured directory). Multipart/file upload limits and allowed MIME types are endpoint-specific contracts; validate exact frontend upload flows, maximum sizes and storage persistence on staging. PostgreSQL stores metadata/references, not evidence bytes. No S3/object-storage setting is implemented in the deployment matrix.

If browser push is approved, provision through the secret manager: `PUSH_BROWSER_PROVIDER=webpush`, `PUSH_BROWSER_VAPID_PRIVATE_KEY`, `PUSH_BROWSER_VAPID_SUBJECT`; `PUSH_BROWSER_VAPID_PUBLIC_KEY` is optional/derivable, as are TTL and endpoint-host settings where applicable. Native FCM requires `PUSH_PROVIDER=fcm`, `PUSH_FCM_PROJECT_ID`, `PUSH_FCM_CLIENT_EMAIL`, and `PUSH_FCM_PRIVATE_KEY`; endpoint overrides are optional. Keep credentials out of logs and this document. Noop/test adapters do not prove production delivery. Email/WhatsApp provider selectors alone do not establish a working delivery integration; provision only separately approved adapters and verify actual flows. No values were read or disclosed in this assessment.

## Outstanding blockers

1. Verify Operations, Customer Care and Mobile/PWA current remote SHAs and ancestry; reconcile all completed frontend branches without merging.
2. Obtain signed frontend contract compatibility and cross-app E2E evidence against this exact Backend candidate/image.
3. Reconcile and rehearse the complete `0534` candidate migration registry, especially latest BM settlement migration, on PostgreSQL 18.6 and staging-like data.
4. Prove durable evidence upload/download across restart, secret/config correctness, push behavior if enabled, and backup/restore.
5. Obtain owner/release approval and record exact staging image/source identities. No staging or production deployment is authorized by this preflight.

## Evidence boundary

Fetched Backend remote: `origin` (`https://github.com/budiirmawan/Handyman-Backend.git`). Verified refs: `origin/main` `11fad55ecae7a153df51cc463290ecc2ad70175c`; `origin/arena/7c4baf34-handyman-backend` `706f30fca9e5dad299f866be493e810231f536e7`; documentation branch `origin/arena/562a1b9b-handyman-backend` `a7814cd483bd6ed64e36efdc03b3433036567385`. The Operations, Customer Care and Mobile/PWA repositories were not fetched. Existing repository documents—including `BIZNET_COOLIFY_RELEASE_GATE.md`, `docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md` and older migration reconciliation records—are scoped/historical evidence, not proof of current remote readiness or Biznet state.
