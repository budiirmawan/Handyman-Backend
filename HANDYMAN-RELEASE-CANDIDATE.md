# Handyman Release Candidate Preflight — CR-HM-PRODUCTION-01 Part 01

**Assessment date:** 2026-10-28 UTC  
**Purpose:** truthful source/config/migration preflight before Biznet staging. No staging or production system was accessed; no database writes, tests, deployments, merges, or cutovers were performed. This document is a preflight, not authorization to deploy.

## Decision

**Overall: BLOCKED / NO-GO for staging release-candidate certification.** The only available repository is Handyman-Backend. Its fetched `origin/main` HEAD is `11fad55ecae7a153df51cc463290ecc2ad70175c`; it does not contain the supplied Backend reference `706f30fca9e5dad299f866be493e810231f536e7` (that object is absent locally and `origin/main` is at a different SHA). Operations, Customer Care, and Mobile/PWA repositories/remote refs were not available in this checkout or in the accessible `budiirmawan` repository list; consequently their latest HEADs and ancestry cannot honestly be asserted. **Do not treat supplied SHAs or historical delivery notes as verified source identity.**

## Source identity and completed-branch inclusion

| Source | Supplied reference | Latest verified remote HEAD / ancestry | Inclusion in intended source | Result |
|---|---|---|---|---|
| Backend | `706f30fca9e5dad299f866be493e810231f536e7` | Fetched `origin/main`: `11fad55ecae7a153df51cc463290ecc2ad70175c`; supplied object unavailable, ancestry cannot be established | Not proven; local candidate equals repository checkout at that base SHA, not supplied integration reference | **BLOCKED** |
| Operations | `94095147a99211cfbe04ff6141428ebe05993b90` | No Operations remote/repository available to fetch or inspect | Cannot establish latest verified commit or whether completed branches are included | **BLOCKED** |
| Customer Care | latest verified branch including `39659a67` | No Customer Care remote/repository available; short SHA is not independently resolved | Cannot establish latest HEAD, ancestry, or completion inclusion | **BLOCKED** |
| Mobile/PWA | Must be identified, not presumed ready | No Mobile/PWA remote/repository or signed integration report available | Readiness and inclusion unverified | **BLOCKED — release blocker** |

No automatic merge was attempted. To close this section, provide/fetch the canonical remotes and branches and record full commit SHAs, fetched timestamps, ancestry against each approved release source, and a feature-branch inclusion map. Reconcile the supplied Backend reference discrepancy first.

## Release gate matrix

| Gate | Status | Evidence / condition to close |
|---|---|---|
| Backend source identity | **BLOCKED** | Fetched `origin/main` is `11fad55…`, not supplied `706f30…`; establish approved release source and exact ancestry. |
| Operations source identity/inclusion | **BLOCKED** | Remote unavailable; verify actual latest HEAD and completed-branch ancestry. |
| Customer Care source identity/inclusion | **BLOCKED** | Remote unavailable; resolve full SHA for branch said to include `39659a67`; verify ancestry. |
| Mobile/PWA readiness/inclusion | **BLOCKED** | No latest SHA or signed compatibility/integration report; must not assume ready. |
| PostgreSQL migration artifact order | **PASS — static registry only** | Current checkout registers numeric migrations through `0480_handyman_service_request_item_inherited_attributes`; `0449` and `0469` are intentional gaps in docs. Registry presence/order is not target migration readiness. |
| PostgreSQL 18.6 compatibility / BM settlement upgrade | **BLOCKED** | Existing migration reconciliation records disposable PostgreSQL **18.4** evidence for migrations through `0472`; current registry additionally includes `0473–0480`. No evidence here proves PostgreSQL 18.6 execution, target status, or latest migration compatibility. Latest explicitly named BM settlement migration is `0460_handyman_settlement_dispute_adjudication`; reconcile all settlement migrations from `0415–0418` and `0460` against the exact current artifact. No Biznet DB inspection/write performed. |
| Backend ↔ frontend API compatibility | **BLOCKED** | Backend OpenAPI contract exists at `docs/api/openapi.yaml` and `/api/v1`; no frontend source SHAs/contracts/integration reports are available for comparison. Static contract availability is not consumer compatibility. |
| Required production configuration | **CONDITIONAL / BLOCKED for activation** | See environment requirements below; actual secret-manager provisioning and values were not inspected. |
| Document/evidence persistence | **BLOCKED** | Backend supports local evidence storage only. Prove durable persistent volume at `/app/.data/evidence`, permissions, restart/redeploy persistence, and DB/file reference integrity on staging. |
| Push notifications | **BLOCKED for production delivery** | Default/noop is not delivery evidence; provider credentials and physical delivery/rotation/retry evidence are not verified. Keep provider activation fenced until approved. |
| Cross-app E2E | **BLOCKED** | No signed Care → Operations → PWA → Backend E2E evidence against a single exact candidate source/image. |
| Biznet staging readiness | **BLOCKED** | Must close source identity, migration 18.6 rehearsal, backup/restore and persistence, consumer compatibility, E2E, configuration, and release approval gates. |

## Migration prerequisites and compatibility

The code registry currently ends at `0480`; do not use older release notes that describe `0472` or `0478` as the current tip. Migration `0460_handyman_settlement_dispute_adjudication` adds settlement dispute adjudication; prior reconciliation evidence specifically covers a disposable PostgreSQL 18.4 cluster and migrations only through `0472`. The later migrations `0473–0480` require reconciliation against that evidence. This preflight did **not** connect to PostgreSQL 18.6 or Biznet and does not claim 18.6 compatibility or a successful migration.

Before staging: (1) confirm exact candidate artifact and registry; (2) obtain staging migration status and prove no unknown/newer history; (3) make and validate an encrypted database-plus-evidence backup/restore pair; (4) rehearse fresh install and populated upgrade on PostgreSQL 18.6 with production-like data, especially settlement ordering/constraints and migrations `0473–0480`; (5) record one-shot apply and no-op second apply; (6) keep scheduler disabled and traffic fenced until checks pass. Use forward recovery; do not assume down migrations are safe. Production/target migration remains explicitly out of scope.

## Environment, secrets, storage, uploads and notifications

Use the deployment secret manager; never place secret values in this manifest, logs, images, or source control. The backend's deployment matrix identifies core settings: `NODE_ENV`, `PORT`, `API_PREFIX`, `LOG_LEVEL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`, exact `CORS_ORIGINS`, `EVIDENCE_STORAGE_DRIVER`, `EVIDENCE_STORAGE_DIR`, `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MS`, request/session/rate-limit settings, and provider selectors `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER`, `PUSH_PROVIDER`. Set DB fields explicitly; application config uses `DB_*`, not `DATABASE_URL` or `PG*`. Keep scheduler disabled during staging provisioning and migration; only one approved active scheduler instance.

Evidence storage currently accepts `EVIDENCE_STORAGE_DRIVER=local`; use a durable mount at `/app/.data/evidence` (or the explicitly configured directory). Multipart/file upload limits and allowed MIME types are endpoint-specific contracts; validate the exact frontend upload flows, maximum sizes and storage persistence on staging. PostgreSQL stores metadata/references, not evidence bytes. No S3/object-storage setting is implemented in the deployment matrix.

If browser push is approved, provision through the secret manager: `PUSH_BROWSER_PROVIDER=webpush`, `PUSH_BROWSER_VAPID_PRIVATE_KEY`, `PUSH_BROWSER_VAPID_SUBJECT`; `PUSH_BROWSER_VAPID_PUBLIC_KEY` is optional/derivable, as are TTL and endpoint-host settings where applicable. Native FCM requires `PUSH_PROVIDER=fcm`, `PUSH_FCM_PROJECT_ID`, `PUSH_FCM_CLIENT_EMAIL`, and `PUSH_FCM_PRIVATE_KEY`; endpoint overrides are optional. Keep credentials out of logs and this document. Noop/test adapters do not prove production delivery. Email/WhatsApp provider selectors alone do not establish a working delivery integration; provision only separately approved adapters and verify actual flows. No values were read or disclosed in this assessment.

## Outstanding blockers

1. Verify/fetch all four actual release repositories and full current remote SHAs; resolve Backend reference mismatch; verify commit ancestry and feature-branch inclusion without merging.
2. Identify actual latest Mobile/PWA verified commit and obtain signed compatibility evidence.
3. Reconcile and rehearse the complete current migration registry, especially BM settlement and `0473–0480`, on PostgreSQL 18.6 and staging-like data.
4. Compare frontend contract versions to this exact backend OpenAPI/source SHA; execute cross-app E2E for Customer Care, Operations, PWA and relevant mobile flows.
5. Prove durable evidence upload/download across restart, secret/config correctness, push behavior if enabled, and backup/restore.
6. Obtain owner/release approval and record the exact staging image/source identities. No staging or production deployment is authorized by this preflight.

## Evidence boundary

Fetched backend remote: `origin` (`https://github.com/budiirmawan/Handyman-Backend.git`), `origin/main` / remote HEAD `11fad55ecae7a153df51cc463290ecc2ad70175c`. The other three source repositories were not present in the accessible repository list and were not fetched. Existing repository documents include `BIZNET_COOLIFY_RELEASE_GATE.md`, `docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md`, `docs/handyman/CR-HM-BACKEND-RELEASE-INTEGRATION-01_PART01_MIGRATION_RECONCILIATION.md`, and the notification production prerequisites; these are historical/scoped evidence, not proof of current remote branch readiness or Biznet state.
