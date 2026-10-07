# CR-BE-EXP-01 — Export Formats + Report Archive

**Status:** PARTs 01–06 implemented; final CR closure readiness is recorded in §28. The START GOVERNANCE step was documentation-only. No worker, queue, scheduler, or dependency change is included.

**Repository:** `budiirmawan/Asentra-Backend` (`Asentra-Backend`)

**Inspection date:** 2026-08-24 (UTC)

**Verified baseline:** current Arena branch `arena/01a0334b-asentra-backend`, at `b70139849e099658ca9637a021b3fecb9469055d`, the merge commit `Merge PR #65: CR-BE-ESG-01 — ESG Operational Foundation`. The branch is based on and contains the expected `main` HEAD. The working tree was clean before inspection.

> This document is the governance authority for the minimum backend foundation for export formats and a durable report archive. It records the existing authorities, the gaps that must not be papered over, and the implementation boundary for later PARTs. It does not implement any of the decisions below.

---

## 0. Decision summary

| Decision | Governed position |
|---|---|
| Existing JSON export | Preserve `GET /reports/export` as the synchronous, live/current-state JSON envelope. It is not an archive and does not render binary files. |
| Export architecture | One normalized request and one canonical, read-only export snapshot feed JSON, CSV, XLSX, and PDF renderers. No separate reporting engine per format. |
| Dataset authority | Reuse the owning KPI/read-model service and its parser/scope rules. Renderers never query domain tables and never recalculate KPIs. |
| Archive identity | A future `report_archives` row is the immutable execution/archive record. It stores metadata, provenance, and an opaque storage reference; it never stores file bytes in PostgreSQL. |
| Document vs storage | `documents` is not the primary artifact authority: it is a user-managed metadata/version/archive model and currently has no backend byte upload/download path. Archive file identity belongs to the existing storage boundary, generalized to a report/artifact namespace without creating a second storage backend. |
| Generation | Synchronous only inside explicit row/byte/time budgets. Larger, multi-Building, XLSX, PDF, or durable jobs use `REQUESTED → GENERATING → COMPLETED/FAILED`. Retention is a separate lifecycle state. |
| Worker/queue | Reuse the existing due-job dispatcher/scheduler only through one additive report-archive domain. Do not use `integration_outbox_events` as an internal work queue and do not add a second scheduler, queue, or cron system. |
| Immutability | A completed artifact and its source/filter snapshot are never overwritten. Regeneration creates a new archive row and storage object, optionally linked by `supersedes_archive_id`. |
| Scope | The minimum archive is single-Client. A single-Building archive records `building_id`; a same-Client multi-Building archive records the complete `building_ids` set. Cross-Client artifacts are not created by this foundation. |
| Permissions | Keep `reporting_export.read` for the existing live JSON route. Additive future permissions are `report_export.generate` and `report_archive.read`; no override/retry bypass authority is introduced. Dataset-specific read permissions remain part of the adapter contract. |
| Audit | Reuse `operational_events` and `recordOperationalEvent` for request, generated, and failed facts. Ordinary archive reads/downloads are not automatically audited because the current audit policy does not audit ordinary GETs; add a download event only if that policy changes. |
| Retention | Reuse the existing evidence retention policy/execution authority by extending its applicability to report artifacts. Do not create `report_archive_retention_policies` or a second purge engine. Current retention is evidence-only, so this is a real implementation dependency. |
| Migration | The next available number after the ESG `0329` file is `0330`. No migration is created or reserved now. A future archive migration must not consume an earlier number or reserve unnecessary follow-on migrations. |
| CR-BE-PUSH-01 | Remains closed and deferred. This CR does not reopen push-provider integration. |

---

## 1. Governance boundary and non-goals

This CR governs:

- CSV, XLSX, PDF, and the existing JSON export behavior;
- one export request/data contract and format renderer boundaries;
- durable report/export archive identity and provenance;
- bounded synchronous/asynchronous generation behavior;
- Client/Building isolation at request, generation, archive read, and download time;
- reuse of the current storage, audit, RBAC, retention, and due-job authorities;
- a small adapter/registry adoption path for existing reporting datasets;
- future endpoint and migration shape only.

It does **not** include:

- dashboard or frontend redesign;
- a BI warehouse, ETL, data lake, or materialized reporting platform;
- arbitrary user-authored SQL;
- arbitrary user-authored HTML or PDF templates;
- recurring/scheduled reports, unless a separately governed scheduler capability already exists for a later requirement;
- email delivery, push notification, or `CR-BE-PUSH-01`;
- a new document platform, object-store engine, retention engine, or scheduler/queue;
- an ESG-specific redesign. ESG may opt into the dataset registry through its own approved contract later; this CR does not add ESG export code;
- rewriting every management, engineering, housekeeping, security, finance, or workforce reporting module;
- changing the existing `GET /reports/export` response or its OpenAPI description in this governance step.

---

## 2. Verified repository evidence and existing authorities

### 2.1 Baseline verification

The initial inspection verified all governance preconditions:

| Check | Result |
|---|---|
| Repository root | `/home/user/Asentra-Backend`; repository is `Asentra-Backend`. |
| Current branch | `arena/01a0334b-asentra-backend` (the fixed Arena branch). |
| Expected `main` HEAD | `b70139849e099658ca9637a021b3fecb9469055d`. |
| Current HEAD | Exactly `b70139849e099658ca9637a021b3fecb9469055d`. |
| Merge commit | HEAD is `Merge PR #65: CR-BE-ESG-01 — ESG Operational Foundation`. |
| Working tree | Clean before this document was created. |

### 2.2 Reporting and read-model authorities

| Authority | Existing location | Relevant verified behavior |
|---|---|---|
| Neutral export envelope | `src/modules/reporting-export/reporting-export.types.ts` | `PublicReportingExport` carries dataset metadata, actual `buildingScope`, period, applied filters, `asOf`, flat KPI values, structured tables, and `generatedAt`. Column types are `STRING`, `NUMBER`, `PERCENT`, `DATE`, and `BOOLEAN`. |
| Export dispatcher | `src/modules/reporting-export/reporting-export.service.ts` | Delegates parsing and computation to the owning KPI/read-model service, then applies pure projections. It performs no KPI arithmetic, ETL, materialization, file I/O, or binary rendering. |
| Existing export route | `src/modules/reporting-export/reporting-export.routes.ts` and `.controller.ts` | `GET /reports/export` requires authentication and `reporting_export.read`; it returns JSON only. Management Operations Command Center additionally requires `management_read_model.read`. No attachment headers or file streaming are present. |
| Current dataset registry | `REPORTING_EXPORT_DATASETS` in `reporting-export.types.ts` | Six registered datasets: `SECURITY_PATROL`, `SECURITY_FINDING_INCIDENT`, `WORKFORCE`, `VENDOR_TENANT`, `UTILITY`, and `MANAGEMENT_OPERATIONS_COMMAND_CENTER`. |
| BE-23 KPI owners | `security-patrol-kpi`, `security-finding-incident-kpi`, `workforce-kpi`, `vendor-tenant-kpi`, `utility-kpi` | Each owns its query parser, reporting-window semantics, KPI calculations, and accessible-Building resolution. The export service reuses those seams. |
| BE-24 shared scope | `src/modules/management-read-scope/` | Resolves the effective `Client → Property → Building` hierarchy, validates optional Client/Building selectors, returns `ALL_ACCESSIBLE`, `CLIENT`, `SINGLE_BUILDING`, or `MULTI_BUILDING` scope, uses UTC period semantics, and returns `asOf`. Explicit inaccessible scope is denied. |
| BE-24 command center | `src/modules/management-operations-command-center/` | A thin facade composes existing management read models: daily operations, approvals, critical findings, work orders, workforce, vendor, tenant, asset, utility, finance, operational KPI, Building Performance, and portfolio context. It does not own direct domain SQL or a competing KPI formula. |
| Management export projection | `reporting-export.management-projections.ts` | Copies command-center KPIs/tables into the neutral export shape. It explicitly does not recalculate totals, rates, thresholds, monetary rollups, or other domain measures. |
| Existing direct report datasets | `engineering-reports`, `housekeeping-reports`, `security-reports`, `basic-financial-reporting`, `workforce-reporting`, and vendor report modules | Existing read-only reporting surfaces exist with their own response shapes and permissions. Engineering and housekeeping datasets are not currently in `REPORTING_EXPORT_DATASETS`; they must opt in through adapters rather than forcing a broad rewrite. |
| Existing API contract | `docs/api/openapi.yaml` | Already documents `GET /reports/export` as structured JSON only and explicitly says it does not render PDF/Excel. No report archive/download surface exists. This CR does not modify the file. |

### 2.3 Documents, evidence, storage, and downloadable artifacts

| Authority | Existing location | Relevant verified behavior |
|---|---|---|
| Evidence metadata | `evidence_submissions` (`src/database/migrations/0073_create_evidence_submissions.ts`) | Client-owned metadata row with parent execution, evidence type, opaque `file_reference`, original name, MIME type, size, capture/submitter timestamps, and soft `ACTIVE`/`REMOVED` status. |
| Evidence file API | `src/modules/evidence/evidence-file.routes.ts`, `mobile-evidence.routes.ts` | The only current backend byte upload/download path. It uses multipart memory buffering, a 50 MB limit, MIME checks, backend-generated keys, and the same access checks as the evidence row. `GET /evidence/:evidenceId/file/content` serves bytes. |
| Storage abstraction | `src/modules/evidence/storage/` | `EvidenceStorage` exposes `put`, `get`, and `remove`; the configured driver is currently `local`; keys are constrained to `evidence/<uuid>`; local files live below `EVIDENCE_STORAGE_DIR` (default `.data/evidence`). The abstraction is the only current storage byte boundary. |
| Evidence integrity | `evidence-integrity.ts` and migration `0303_add_evidence_integrity_metadata.ts` | Server-computed SHA-256 exists for evidence bytes received by the two byte-upload flows. The helper and metadata are evidence-specific today, but the exact-byte/server-side checksum rule is a useful precedent for report artifacts. |
| Generic Documents | `src/modules/documents/`, migrations `0224`, `0230`–`0233` | `documents` and `document_versions` store an opaque `file_reference`, metadata, versions, expiry, approval/archive state, and operational events. The current module does not write bytes through `EvidenceStorage`, expose a generic binary download route, or provide a report-artifact lifecycle. Documents are mutable/archivable user-managed records, not immutable generated executions. |
| Other file-reference records | BAST, handover, supporting, tenant/vendor documents, vendor reports, visitor photos, and quotation attachments | Existing authorities retain opaque file references and metadata, but no common current download/storage flow was found. They are not report archive authorities. |
| Current downloadable/report artifacts | Evidence content route only | No existing reporting module streams a generated CSV/XLSX/PDF. Existing report endpoints return JSON/read models. No existing archive table or artifact download route was found. |

**Storage decision:** a future archive must store no bytes in PostgreSQL and must not use an `evidence/<uuid>` key merely because that is the current key pattern. The storage boundary must be generalized to a namespaced report/artifact key (for example, a backend-controlled `reports/<archive-id>` namespace) while retaining the same configured driver/root and the same path-safety properties. This is an abstraction generalization, not a new storage engine. Direct `fs` calls from reporting code and a second report-specific object-store implementation are prohibited.

**Document decision:** do not create an `INTERNAL` `documents` row for every export as a substitute for an archive. That would couple a generated execution to a mutable document/version/archive workflow whose current file reference is metadata-only. An optional future document link may be considered only if an existing Document authority later owns the binary, but it is not part of the minimum archive foundation.

### 2.4 Retention, audit, RBAC, isolation, and background execution

| Authority | Existing location | Relevant verified behavior |
|---|---|---|
| Retention policy | `src/modules/evidence-retention-policies/`, migrations `0304` and `0305` | Client-owned, optionally Building-scoped evidence retention policies with effective windows, deterministic specificity, immutable snapshots, holds, and `ACTIVE → RETENTION_DUE → PURGED` evidence lifecycle. No-match/ambiguity is never guessed and is not purged. This authority is currently evidence-only. |
| Retention executor | `evidence-retention-execution.service.ts` through `due-job-dispatcher` | Bounded `FOR UPDATE SKIP LOCKED` work, idempotent storage removal, tombstones rather than row deletion, hold blocking, per-row failure isolation, and natural bounded retry on a later tick. |
| Operational audit | `src/modules/operational-events/`, migration `0080`, migration `0309` | `operational_events` is the business/operational event authority with Client, optional Building and actor, entity identity, safe metadata, timestamps, and request/source correlation. `recordOperationalEvent` scrubs sensitive keys and is append-only at the application boundary. Ordinary GETs are not automatically audited. |
| RBAC | `src/database/seeds/foundation-access.seed.ts`, `src/modules/auth/rbac.middleware.ts` | Default-deny active permission resolution. Existing relevant permissions include `reporting_export.read`, `management_read_model.read`, `engineering_report.read`, `housekeeping_report.read`, `security_report.read`, the BE-23 `*_kpi.read` family, `basic_financial_reporting.read`, `document.*`, `evidence.*`, `operational_event.read`, and `client_configuration.read/manage`. |
| Client/Building isolation | `src/modules/context-access/`, `src/modules/management-read-scope/`, `docs/data-isolation.md` | Access derives from explicit active Building assignments and active hierarchy. A same-Client shortcut is not allowed. Client-only tables use the derived accessible Client set; Building rows use the accessible Building set; inaccessible explicit selectors return `403 BUILDING_ACCESS_DENIED`. |
| Due worker | `src/modules/due-job-dispatcher/` | One bounded dispatcher already drives reminders, escalations, SLA work, outbound delivery, evidence retention, and webhook work. It uses a scheduler context and isolates domain failures. |
| Scheduler | `src/modules/due-job-scheduler/` and `src/server.ts` | One in-process `setInterval` scheduler, disabled in tests, no overlapping ticks, bounded shutdown drain, and no cron/Redis/queue dependency. It is the only existing generic runtime invocation authority. |
| Integration outbox | `src/modules/integration-outbox/` and related delivery modules | A thin, transactional, prospective marker linked to an `operational_events` row for outbound webhook fan-out. Its payload and lifecycle are integration-specific; it is not an internal job queue and must not carry report-generation work. |

### 2.5 Static gaps found

The following are verified gaps, not implementation instructions for this step:

1. No `report_archives` table, archive service, archive route, or report download route exists.
2. `GET /reports/export` is a synchronous/current-state JSON projection only. It has no durable archive request/idempotency row, format selector, binary output, retention, or retry ledger; ordinary HTTP correlation still follows the existing request-ID middleware.
3. The current report registry is a hard-coded dataset list plus a switch, not a general adapter registry. Direct engineering/housekeeping/report read models have not been normalized into it.
4. The current storage abstraction is evidence-namespaced and local-driver-only. It cannot safely be used as-is for report artifacts without a shared namespace/generalization decision.
5. The current `documents` authority has file-reference fields but no common server-side binary upload/download flow and no generated-report identity semantics.
6. Retention policy/execution is implemented for evidence only. There is no valid generic report-artifact retention relationship today; `documents.expiry_date` is a read-time expiry convention, not a purge/retention engine.
7. No XLSX or PDF renderer dependency or renderer authority is present in `package.json`/`src`. CSV/PDF/XLSX implementation choices remain future PART decisions; no dependency was installed for this inspection.
8. The current export controller checks `reporting_export.read` and adds `management_read_model.read` for the Management dataset; it does not independently require each owning `*_kpi.read` permission. This is existing behavior and is not silently changed by this CR. Future archive generation must make dataset capability requirements explicit without granting source-domain manage authority.
9. Static inspection found that `0329_create_esg_baselines_targets_verification.ts` exists and `migrations` includes `migration0329CreateEsgBaselinesTargetsVerification`, but `src/database/migrations/index.ts` does not show the corresponding import. This pre-existing migration-index inconsistency is not fixed here and must be resolved before relying on migration execution. It does not change the next free number: `0330` remains the next archive migration number.

---

## 3. A — Existing export authority and reuse decision

### 3.1 What `reporting-export` already provides

The current authority is a deliberately thin JSON projection:

1. The route validates the dataset key.
2. The service delegates dataset-specific filter parsing to the owning KPI/read-model parser.
3. The owning service resolves the current accessible Building scope and performs the authoritative queries/calculations.
4. A pure projection copies the returned values into stable KPI and table shapes.
5. The response carries both the source evaluation instant (`metadata.asOf`) and the response generation instant (`generatedAt`).

This means the current JSON export is:

- synchronous;
- live/current-state at request time;
- bounded by the owning query parser and source service rules, including the existing UTC/date-window conventions;
- not materialized;
- not immutable after the response is returned;
- not a file, archive, or durable provenance record.

The distinction between `asOf` and `generatedAt` is authoritative and must be preserved in every archive snapshot. `asOf` describes when the underlying read model evaluated its source data; `generatedAt` describes when a renderer completed an artifact.

### 3.2 What must be reused

Later implementation must reuse, rather than copy:

- existing KPI/read-model query parsers;
- existing KPI/read-model services and their formula ownership;
- `resolveManagementReadScope` and the BE-24 contract for management data;
- existing `reporting-export` projections where their fields are approved for the requested format;
- existing Client/Building access helpers and repository-level scope predicates;
- existing response/error conventions;
- `recordOperationalEvent` for audit;
- the generalized existing storage boundary for bytes;
- the existing retention policy selection/snapshot/execution authority;
- the existing due-job dispatcher/scheduler for durable asynchronous invocation.

No renderer may bypass an owning service by issuing broad `SELECT *` queries, reconstructing a KPI, or loading a read model and filtering inaccessible rows in memory.

### 3.3 Adoption gaps

The current registry does not include every useful report surface. In particular, engineering and housekeeping report modules have established read models but are not currently registered in `REPORTING_EXPORT_DATASETS`. The correct response is a per-dataset adapter, not a rewrite of those modules and not a new parallel query layer. Dataset adoption is governed in §11.

---

## 4. B — One export request and one canonical snapshot

### 4.1 Logical request contract

The future archive request is one normalized contract, independent of output format:

- `dataset` / stable `report_type` from the approved registry;
- `format`: `JSON`, `CSV`, `XLSX`, or `PDF`;
- optional `tableKey` only when a CSV-capable dataset exposes more than one table;
- normalized Client/Building scope selectors;
- dataset-specific filters accepted by the owning parser;
- a server-created request fingerprint;
- an optional client-provided idempotency key carried in the HTTP idempotency header;
- the authenticated `requested_by_user_id` supplied by the session, never by the body.

The request body must not accept:

- a Client/Building ownership claim that is not checked against effective context;
- a storage path, storage URL, file name, checksum, signed URL, SQL string, HTML template, formula, or renderer implementation;
- arbitrary filter keys that the selected adapter does not declare.

### 4.2 Logical snapshot contract

Every renderer receives the same canonical read-only snapshot. It is structurally compatible with the existing `PublicReportingExport` envelope and adds renderer/provenance metadata where needed:

- dataset/report type and contract version;
- normalized applied filters, not raw unknown query parameters;
- requested Client and the exact actual Building set included;
- UTC period/time-basis and date-to interpretation;
- KPI values and typed tables from the owning authority;
- source/read-model identifiers and versions;
- `asOf` for the source evaluation;
- approved field classifications/masking profile;
- deterministic ordering and renderer version.

The snapshot is built once per archive execution. JSON, CSV, XLSX, and PDF must not independently call the source services, because doing so could produce four different `asOf` values and four different data answers.

### 4.3 Renderer boundary

| Format | Governed boundary |
|---|---|
| **JSON** | Serialize the canonical machine-readable snapshot. The existing live `GET /reports/export` behavior remains unchanged. A future archive request may persist JSON where an immutable machine-readable artifact is required. |
| **CSV** | Tabular data only. A dataset must declare one stable table or an explicit deterministic flattening. Multiple tables are not concatenated ad hoc; when no governed CSV mapping exists, the request is rejected rather than producing an ambiguous file. CSV uses the declared column order and types. |
| **XLSX** | Workbook/tabular export. One or more sheets are allowed only when the dataset contract declares stable sheet names, order, columns, and row/size bounds. No formulas from source values and no user-authored formulas. |
| **PDF** | Presentation/report rendering from the canonical snapshot, with server-owned template/layout versions. It is not a raw database dump, spreadsheet wrapper, or arbitrary HTML renderer. It must include deterministic period/filter/as-of provenance appropriate to the report. |

There are four format renderers, but only one request/snapshot/data contract. A renderer is a pure or side-effect-contained serialization boundary; domain calculation remains in the owning read model.

---

## 5. C — Generation model, bounded work, and retry

### 5.1 Synchronous vs asynchronous

The existing JSON endpoint remains synchronous and is not converted into an archive operation.

A future archive request may complete synchronously only when all of the following are true:

- the selected adapter has a declared finite row bound;
- the resolved scope is within the adapter's allowed Client/Building bound;
- the source query, snapshot, and renderer are within explicit byte and time budgets;
- the output is within the configured maximum artifact size;
- the operation can complete without monopolizing the HTTP process or fetching an unbounded detail list.

JSON and small CSV exports are the likely synchronous cases. XLSX and PDF may be synchronous only for a demonstrably small bounded snapshot; format name alone must not bypass the budgets.

Use asynchronous generation for:

- large or multi-Building snapshots;
- datasets with bounded-but-large detail tables;
- XLSX workbooks with multiple governed sheets;
- PDF reports with costly pagination/layout;
- any request that would approach the HTTP timeout or output limit;
- any archive operation that cannot atomically produce and persist the artifact within the request.

The exact limits must be explicit in the future adapter/configuration contract. They must not be an unreviewed magic number inside a renderer.

### 5.2 Archive generation status

`report_archives.status` is the generation status and uses the minimum vocabulary:

| Status | Meaning | Allowed transition |
|---|---|---|
| `REQUESTED` | Durable request accepted; no generation claim has started. | `GENERATING` or `FAILED` for validation/configuration failure. |
| `GENERATING` | One worker or synchronous execution owns this archive execution. | `COMPLETED` or `FAILED`; stale claims may be recovered to `REQUESTED` under the retry rules. |
| `COMPLETED` | Canonical snapshot rendered, file bytes stored, and all immutable artifact metadata/checksum persisted. | No generation transition. Retention is separate. |
| `FAILED` | Generation ended without a completed artifact, or bounded retry was exhausted. | No automatic infinite retry. A new explicit request/regeneration creates a new archive row. |

Retention must not be overloaded into this field. If retention disposes completed bytes, it uses a separate `retention_state` such as the existing `ACTIVE`, `RETENTION_DUE`, `PURGED` vocabulary while preserving the completed archive tombstone.

### 5.3 Existing worker authority

The current `due-job-dispatcher` and `due-job-scheduler` are the only suitable existing runtime invocation authority. A future implementation may add one additive `reportArchives` domain to `processDueOperationalJobs`:

- the `report_archives` row itself is the durable work item;
- enumeration is bounded and uses a state/claim guard and `FOR UPDATE SKIP LOCKED` where a transaction is required;
- only one worker owns a `GENERATING` execution at a time;
- the existing scheduler remains the sole polling timer;
- the existing scheduler's no-overlap, bounded shutdown, and scheduler correlation behavior is retained.

`integration_outbox_events` must **not** be used as the internal report-generation queue. It is a transactional outbound-webhook marker over `operational_events`, has integration-specific payload/lifecycle semantics, and its worker side effects are external delivery. Report generation may cause normal report audit events to pass through the existing operational-event/outbox hook when that feature is enabled, but archive work is not enqueued there.

No report-specific cron, queue, Redis, worker framework, or second scheduler is permitted.

### 5.4 Bounded retry and idempotency

The future archive execution must include or derive:

- `attempt_count` and a finite `max_attempts` governed by the existing worker policy;
- a safe `next_attempt_at`/claim recovery path if the existing worker contract needs one;
- a bounded stale-`GENERATING` recovery rule;
- safe failure isolation so one archive does not stop the batch;
- no retry after `COMPLETED`;
- no automatic retry loop after `FAILED` and maximum attempts;
- no second completed artifact for one archive execution.

The request idempotency rule is distinct from regeneration:

1. A client may submit an idempotency key. The server stores a hash of that key plus a canonical request fingerprint; raw keys are not returned.
2. Retrying the same key with the same fingerprint returns the existing archive execution and does not create a second row.
3. Reusing the same key with a different fingerprint returns a conflict.
4. A deliberate regeneration uses a new key/request. It creates a new archive ID and storage object, optionally records `supersedes_archive_id`, and never overwrites the prior completed artifact.
5. The storage key is derived from the archive execution ID, not from an unsafe caller filename. A retry of the same execution can safely reconcile the same object/key and checksum; a new execution cannot overwrite the old one.

---

## 6. D — Minimum `report_archives` authority

### 6.1 Table decision

The minimum durable archive authority is a future `report_archives` table. It is one row per accepted export execution and generated artifact, not a cache and not a copy of the source read model.

A future migration should use `0330` for this foundation when implementation is authorized. No migration is created by this CR.

### 6.2 Minimum logical model

| Field/group | Governed rule |
|---|---|
| `id` | UUID primary key. This is the stable archive/execution identity and is used to derive the backend storage key. |
| `client_id` | Required FK to `clients`. The minimum archive is owned by exactly one Client. This prevents a single archive row from becoming a cross-Client retrieval or financial aggregation loophole. |
| `building_id` | Nullable FK to `buildings`. Set only when exactly one Building is included; null for same-Client multi-Building or Client-level data. Building-to-Client coherence is checked by the service and, where practical, by schema constraints. |
| `building_ids` | Required resolved scope set, including every actual Building in the snapshot. It is needed for read-time subset checks when `building_id` is null for a multi-Building artifact. It must contain only Buildings of `client_id`; an empty set is allowed only for a Client-level dataset whose contract has no Building dimension. |
| `report_type` / dataset | Required stable registry key, such as `MANAGEMENT_OPERATIONS_COMMAND_CENTER`. It is not a free-form SQL/report name. The registry owns its label, source, field contract, allowed formats, and bounds. |
| `format` | Required enum: `JSON`, `CSV`, `XLSX`, `PDF`. Unknown formats are rejected before a row becomes generatable. |
| `status` | Required generation vocabulary: `REQUESTED`, `GENERATING`, `COMPLETED`, `FAILED`. |
| `filter_snapshot` | Required JSONB. Stores the normalized filters actually accepted/applied, requested scope, actual scope/period echo, UTC/time-basis/date-to semantics, and relevant adapter contract version. It is immutable after request acceptance and contains no secrets, arbitrary SQL, HTML, raw evidence, storage URLs, or unknown query parameters. |
| `source_provenance` | Required/nullable-by-lifecycle JSONB or equivalent source fields. It records the owning service/read-model adapter, source contract/version, renderer version, and any source identifiers needed to explain the artifact. It must not duplicate the full source database or raw payload. |
| `as_of` | Nullable until a source snapshot is successfully evaluated, then immutable. It is the source evaluation instant and is distinct from `requested_at` and `generated_at`. |
| `requested_by_user_id` | Required FK to `users`. Derived from the authenticated session; never accepted as a caller-owned identity. It remains historical provenance even if the user later becomes inactive. |
| `requested_at` | Required UTC server/database timestamp for acceptance. |
| `generated_at` | Nullable until the artifact is fully rendered, stored, and metadata committed. It is immutable once set. |
| `storage_reference` | Nullable until generated. Opaque internal reference/key handled only by the shared storage abstraction. Never a public filesystem path or provider URL. It remains metadata-only after a retention tombstone if needed. |
| `filename` | Nullable until generated. Server-generated safe filename with a fixed extension. No caller filename is accepted as the archive identity. |
| `content_type` | Nullable until generated; server-derived from the format/renderer, not trusted from a request. |
| `file_size` | Nullable until generated; measured from the actual bytes persisted by the storage boundary. Non-negative and bounded. |
| `checksum` and algorithm | Nullable until generated; server-computed over the exact persisted bytes. SHA-256 is the current evidence integrity precedent. A caller-supplied checksum is never authoritative. |
| failure metadata | `failure_code`, bounded safe `failure_message`, and `failed_at` (or one equivalent JSONB object) are nullable and contain no stack, SQL, credentials, storage path, signed URL, or raw provider response. |
| retry metadata | `attempt_count`, finite `max_attempts`, and any bounded next-attempt/claim timestamp required by the existing worker contract. These describe execution control, not source data. |
| idempotency metadata | Server-side idempotency-key hash and canonical request fingerprint, with a uniqueness rule scoped to the authenticated requester/Client as appropriate. Do not persist the raw idempotency key. |
| regeneration link | Nullable `supersedes_archive_id` self-reference is permitted for intentional regeneration/version lineage. It never permits an update to the superseded row. |
| retention relationship | A policy identity/snapshot and retention state, described in §8. It must follow the existing retention authority rather than define a new one. |
| timestamps | `created_at` and `updated_at` are required. `updated_at` may move for execution/retention lifecycle bookkeeping; it does not mean the completed report bytes changed. |

`document_id` is deliberately **not** required in the minimum model. The primary durable identity is `storage_reference` through the shared storage boundary. A future document link may be additive only if the existing Document authority is explicitly extended to own generated bytes; it must not be used to evade the archive lifecycle above.

### 6.3 Lifecycle invariants

At minimum, later implementation must enforce:

- `REQUESTED`/`GENERATING` rows have no claim of a completed file;
- `COMPLETED` requires `as_of`, `generated_at`, storage reference, filename, content type, size, checksum, and a valid retention relationship according to the agreed retention policy;
- `FAILED` has safe failure metadata and no completed artifact exposed as downloadable;
- `filter_snapshot`, requested identity, dataset, format, Client/Building scope, and source provenance cannot be silently changed after acceptance/completion;
- a completed archive has one immutable storage object identity and is never overwritten;
- a retention purge removes bytes through the storage boundary and leaves a metadata tombstone rather than deleting the row or audit history;
- no normal PATCH/PUT/DELETE archive route can edit or erase completed history.

---

## 7. E — Immutability and provenance

### 7.1 Immutable generated artifact

A completed archive is a historical answer to one request, not a live view. Its source/filter snapshot, actual scope, source `asOf`, renderer version, file metadata, and checksum must remain explainable after source rows, permissions, policies, or renderer code change.

Allowed later changes are limited to governed lifecycle bookkeeping:

- bounded execution claim/retry fields before completion;
- the one-way generation status transition;
- retention due/purge/hold metadata;
- safe operational audit records.

No later request may rewrite the bytes, change the report type/format, replace the scope, change the filters, or move a completed archive's storage reference. A new answer is a new archive ID.

### 7.2 Deterministic provenance

The snapshot must record enough to distinguish:

- the requested period from the source evaluation instant;
- requested selectors from the actual authorized Building set;
- source/read-model contract version from renderer version;
- a failed request from a completed artifact;
- a regenerated artifact from the prior version it supersedes.

The archive must not claim stronger reproducibility than the source supports. If a source read model is live and only provides an `asOf` instant rather than a database snapshot/transaction timestamp, the archive records that fact and does not call itself a transactionally consistent warehouse snapshot.

---

## 8. F — Retention relationship and purge boundary

### 8.1 Existing retention authority

The existing retention authority is `evidence_retention_policies` plus its application and due-execution services. It already establishes the correct governance patterns:

- Client-owned and optionally Building-scoped policy;
- effective windows and deterministic specificity;
- no guess on a top-score tie;
- policy identity and retention days frozen onto the governed row;
- policy edits do not rewrite existing snapshots;
- bounded due execution;
- hold-aware binary disposal;
- row-preserving purge tombstones;
- no infinite retry on storage failure.

That authority is currently constrained to evidence types/execution types and queries `evidence_submissions`. It cannot be referenced by a report archive as though the archive were evidence.

### 8.2 Decision: extend, do not fork

Before a report archive can be marked `COMPLETED`, the future implementation must either:

1. add report-artifact applicability to the **existing** retention policy authority and extend its application/execution seam to `report_archives`; or
2. obtain an explicitly approved equivalent extension of the same authority without creating a second policy table or purge engine.

The extension may add an artifact kind and governed report selectors (dataset/format where required), while retaining the existing Client/optional-Building policy, precedence, snapshot, hold, and due-execution rules. The implementation must not create `report_archive_retention_policies`, use `documents.expiry_date` as a purge substitute, or attach report bytes to `evidence_submissions` just to inherit retention.

### 8.3 Archive retention fields and lifecycle

The report archive should carry the same kind of frozen relationship used by evidence:

- selected retention policy ID/code;
- frozen retention-days snapshot;
- policy-applied timestamp;
- `retained_until` anchored to the generated artifact (with the policy selection frozen at the governed request/completion boundary);
- separate `retention_state` (`ACTIVE`, `RETENTION_DUE`, `PURGED`);
- `purged_at` when bytes are disposed;
- the existing hold semantics if the shared authority applies them to report artifacts.

No default retention period is invented. If policy resolution is absent or ambiguous, the safe behavior is no automatic purge and an auditable/configuration failure. For this CR, a `COMPLETED` archive should require an unambiguous retention snapshot; permitting an ungoverned completed artifact is a product decision that must be explicit and must leave it non-purgeable rather than silently assigning a period.

Purge is binary disposal plus a metadata tombstone:

- remove bytes through the shared storage abstraction;
- retain archive identity, source/filter provenance, file metadata, checksum, retention snapshot, and audit history;
- never hard-delete the `report_archives` row;
- a purged archive is not downloadable and is not regenerated in place;
- a new export request creates a new archive.

This is a dependency/blocker for runtime PART 01 because the current retention authority is evidence-only.

---

## 9. G — Client/Building isolation

### 9.1 Request-time scope

The future archive request must resolve scope using the existing authority before any source query:

- authenticate the caller;
- resolve the caller's effective active Building assignments and derived Client set;
- validate the requested Client, single Building, or list of Buildings against that effective context;
- compute the selected scope as `accessible Buildings ∩ requested Buildings` for a narrowing selector;
- reject an explicit inaccessible Building/Client combination with `403 BUILDING_ACCESS_DENIED`, rather than silently returning a partial report;
- preserve the existing well-formed zero/empty read-model behavior only for an unscoped request whose effective accessible set is empty and whose dataset contract supports an empty result.

A selected Building must belong to the selected Client. A Client selector narrows the accessible hierarchy; it never grants sibling Buildings or a different Client.

### 9.2 Single-Client archive rule

A single `report_archives.client_id` cannot safely represent a cross-Client artifact. The minimum foundation therefore requires one explicit/resolved Client per archive. A user with access to multiple Clients requests separate Client archives.

A future fan-out request that creates one archive per Client would need its own governed request aggregate and is not part of this minimum. It must never store a cross-Client financial rollup under one arbitrary Client.

For a same-Client multi-Building archive:

- `building_id` is null;
- `building_ids` contains the complete actual set;
- all financial/monetary output remains within that one Client and preserves the source authority's no-currency-conversion limitation;
- read/download authorization requires the caller to retain access to the full recorded set.

### 9.3 Generation/read/download rechecks

Authorization is not checked only when the POST is accepted:

- generation re-resolves the `requested_by_user_id`'s active permission and current Client/Building scope before reading source data;
- if the requester is deactivated or loses a required permission/scope before asynchronous generation, the archive fails without producing a completed artifact;
- archive list/detail queries are repository-scoped by accessible Client/Building sets;
- a single-Building archive requires current access to that Building;
- a multi-Building archive requires the recorded `building_ids` to be a subset of the caller's current accessible Building IDs; it is denied as a whole if any included Building is no longer accessible;
- the service never returns a partial multi-Building artifact or filters its bytes after generation;
- download repeats the same archive and scope authorization before serving or issuing any temporary URL.

No cross-Client archive retrieval, storage lookup, or download URL may be possible by guessing an archive UUID. Unknown and inaccessible archive identities should remain indistinguishable at the scoped read boundary where the existing error policy requires it.

### 9.4 Repository-level scope

List/detail/download repositories must apply Client/Building predicates at query time. The implementation must not fetch all archive rows and then filter them in application memory. For multi-Building rows, the persisted `building_ids` set must participate in the containment check or an equivalent database-level scope predicate.

---

## 10. H — RBAC and authority boundaries

### 10.1 Existing permissions

The existing live JSON route keeps its current `reporting_export.read` permission. The Management Operations Command Center export keeps its additional `management_read_model.read` requirement. Existing dataset/read-model permissions remain the source capability declarations for adapters.

The current controller's permission behavior is a compatibility fact, not a reason to grant source-domain manage permissions to an archive renderer.

### 10.2 Minimal future additive permissions

| Permission | Use | Does not imply |
|---|---|---|
| `report_export.generate` | Submit a durable export/archive request for an approved dataset and format. | Source-domain mutation, retention-policy administration, arbitrary SQL/HTML, or cross-Client access. |
| `report_archive.read` | List/detail/download governed archives after current scope checks. | Generate, regenerate, retry a failed execution, or read another Client's archive. |

The adapter registry must declare the existing read capability needed for its dataset. The future generation check is conjunctive: archive generation capability plus the dataset's approved read capability, plus the existing Management permission for management datasets. This closes the risk that a generic generation permission becomes an unreviewed data bypass while avoiding source-domain `manage` permissions.

The minimum model does not add a separate `report_archive.download`, `report_archive.retry`, or `report_export.override` permission. If a later security review requires a download-only distinction or privileged retry, it must be additive and separately justified; it is not assumed here.

Retention policy administration continues to use the existing `client_configuration.read/manage` authority and its Client/Building checks. No new retention-admin permission is added.

Permission registration/seed changes are future implementation work only. No permission is added or removed in this governance step.

---

## 11. I — Audit and provenance events

### 11.1 Existing audit authority

All archive business facts use `recordOperationalEvent` and `operational_events`:

- `client_id` is mandatory;
- `building_id` is the single-Building context when applicable and null for Client-level/multi-Building facts;
- `actor_user_id` is the authenticated requester for request facts and null for system/worker facts;
- HTTP, scheduler, and system correlation uses the existing request/run context;
- metadata is bounded and passed through the existing sensitive-key scrubber;
- event and archive state should commit atomically when the archive transaction authority allows it;
- no separate archive audit table or generic user event-injection route is created.

### 11.2 Required future event vocabulary

Use one meaningful event per governed fact, with `entity_type = 'REPORT_ARCHIVE'` and `entity_id = report_archives.id`:

| Event | When | Safe metadata examples |
|---|---|---|
| `REPORT_EXPORT_REQUESTED` | Archive request accepted and the durable row is created. | report type, format, Client, scope mode/count, filter fingerprint, request ID, status. |
| `REPORT_EXPORT_GENERATED` | Snapshot rendered, storage write completed, checksum verified, and archive transitioned to `COMPLETED`. | report type, format, `asOf`, generated time, file size, checksum/algorithm, renderer version. |
| `REPORT_EXPORT_FAILED` | Validation/configuration/source/render/storage failure ends an attempt or exhausts bounded retry. | safe failure code, phase, attempt/max attempts, status, report type, format, request ID/run ID. |
| `REPORT_ARCHIVE_DOWNLOADED` | Only if an approved audit policy later requires download/access events. | archive ID, caller, format, scope, issuance/stream time; never a signed URL or storage path. |

Ordinary `GET /reporting/archives`, `GET /reporting/exports/{id}`, and ordinary metadata reads are not automatically audited under the current policy. If downloads become mandatory audit facts, record issuance/authorized stream through the same event authority and document that a provider-issued signed URL may not give the backend a completion callback.

Never put in events:

- file bytes, raw report payloads, raw evidence, or full unbounded filter arrays;
- storage paths, bucket names, credentials, signed URLs, bearer tokens, or authorization headers;
- stack traces, SQL text, connection strings, or unsanitized provider errors.

The existing integration outbox may observe these operational events through its normal gate when configured. That is outbound integration behavior, not report generation work.

---

## 12. J — Security controls

### 12.1 Common controls

- **Allowlist fields, do not export raw rows.** Each adapter declares columns, types, sensitivity, labels, ordering, and allowed formats. Unknown source fields are omitted.
- **Sensitive-field policy.** Adapters classify fields and provide a mask/omit policy for the caller's approved read capability. Direct credentials, tokens, passwords, raw evidence, internal storage references, signed URLs, secret configuration, and unbounded metadata are never exportable. Existing JSON behavior is preserved; any new archive masking must be explicit in the adapter contract rather than an accidental renderer difference.
- **Financial scope.** Financial rows remain Client-partitioned. No cross-Client monetary sum, currency conversion, payroll, or unsupported accounting claim is introduced. The existing BE-19I amount semantics remain authoritative.
- **Authorization recheck.** Permission and complete scope are checked at request, asynchronous generation, archive read, and download time, as specified in §9.3.
- **Bounds.** Enforce date-range, row-count, scope, source query, renderer, and output-byte limits. Reject or queue over-budget work; do not truncate a completed report silently.
- **Safe failure.** Expose stable error codes and bounded safe messages only. Do not expose SQL, filesystem paths, stack traces, renderer internals, or provider credentials.
- **Storage isolation.** Only the storage adapter handles bytes. Database rows store opaque references and metadata, never binary content. Storage URLs are not persisted as public links or returned as raw provider URLs.

### 12.2 CSV formula injection and encoding

The CSV renderer must:

- escape delimiters, quotes, CR/LF, and other RFC-4180-sensitive content;
- emit UTF-8 with one deterministic header/column order;
- treat source numbers/booleans/dates according to the declared column type;
- for untrusted **string** values whose first non-whitespace character is `=`, `+`, `-`, or `@`, prefix a safe text marker (or equivalent text-only encoding) before serialization;
- not turn legitimate typed numeric negatives into formula strings;
- never accept a formula flag or spreadsheet expression from the request or source data.

The resulting CSV must be safe when opened by spreadsheet software, not merely valid when parsed as text.

### 12.3 XLSX formula injection and workbook safety

The XLSX renderer must:

- write untrusted values as explicit text/number/date/boolean cell types;
- never create formula cells from source strings and never evaluate source strings as formulas;
- apply the same dangerous-prefix treatment to untrusted text where spreadsheet clients may reinterpret it;
- use contract-defined, sanitized sheet names and stable sheet order;
- reject control characters, unsafe hyperlinks, and unsupported rich content;
- enforce workbook row/cell/byte bounds and avoid unbounded in-memory workbooks;
- not accept user-authored formulas, macros, external links, or workbook templates.

### 12.4 Unsafe filenames and download behavior

Filenames are generated by the backend from a fixed safe slug, report type, normalized date/scope token, archive ID, and fixed extension. The implementation must:

- strip or reject path separators, control characters, CR/LF, quotes, and traversal sequences;
- not use a caller-provided filename as the storage key or `Content-Disposition` value;
- use a safe ASCII fallback and standards-compliant encoded filename if a display label is included;
- set the content type from the stored archive metadata and format contract;
- never expose the internal storage key or local directory.

### 12.5 PDF/template safety and determinism

The PDF renderer must use server-owned versioned templates and a constrained token model. It must:

- HTML/text-escape every source value before template interpolation if HTML is used internally;
- reject arbitrary HTML, CSS, JavaScript, template names, external resource URLs, and user-supplied partials;
- disable scripts, network fetches, filesystem includes, and remote images/fonts unless a separately approved renderer policy permits a fixed allowlist;
- render only the canonical snapshot, not a live database query during pagination;
- include deterministic title, period, scope, filter/as-of provenance, and renderer version;
- pin or document locale, UTC/time-zone, number/date formatting, and template version so regeneration can be explained;
- not present itself as a raw database dump or a substitute for an approved signed/legal document process.

The absence of a current PDF renderer/library is a future implementation dependency, not a reason to permit arbitrary HTML.

### 12.6 Download URL exposure

The current storage abstraction does not provide signed/temporary URLs. The initial download implementation should therefore authorize the archive and stream bytes through the backend storage boundary without exposing the local path.

If a future storage driver supports signed temporary URLs, the adapter may issue a short-lived, archive-specific URL only after the same authorization check. The URL must not be stored in `report_archives`, returned in ordinary detail responses, written to audit metadata/logs, or usable for a different archive/Client. The download endpoint must not become an unguarded redirect.

---

## 13. K — Dataset integration strategy

### 13.1 Registry/adapter contract

Replace the current hard-coded switch only as part of future implementation with a registry/adapter boundary. The conceptual adapter owns:

- stable dataset/report key and label;
- accepted filter schema/parser, delegated to or wrapping the owning authority;
- required read permission(s);
- Client/Building scope mode and source scope resolver;
- canonical snapshot loader;
- typed table/column contract and deterministic ordering;
- allowed formats and format-specific mappings (CSV table, XLSX sheets, PDF template key);
- row/size/time bounds;
- field sensitivity/masking profile;
- source/as-of/contract provenance.

A renderer depends only on the canonical snapshot and the adapter's declared format contract. It does not import every domain repository and it does not know how a KPI was calculated.

### 13.2 Initial adapter map

| Adapter candidate | Existing owner to wrap | Initial rule |
|---|---|---|
| Security Patrol | BE-23F1 `security-patrol-kpi` plus current projection | Reuse current filter parser, UTC window, scope and typed `patrolDailyActivity` table. |
| Security Finding/Incident | BE-23F2 `security-finding-incident-kpi` plus current projection | Preserve source status/severity semantics and current typed tables. |
| Workforce | BE-23G `workforce-kpi` and, where approved, BE-03I workforce reporting | No new attendance/man-hour formula. Sensitive workforce detail must use the declared field policy. |
| Vendor/Tenant | BE-23H `vendor-tenant-kpi` plus current projection | Keep vendor/tenant and Work Order authority boundaries. |
| Utility | BE-23I `utility-kpi` over BE-18M | No new consumption/sub-meter/reconciliation formula. |
| Management Operations Command Center | BE-24 command-center facade plus management projection | Reuse `resolveManagementReadScope`, preserve Client-partitioned finance and all source `asOf`/UTC rules. |
| Engineering datasets | `engineering-reports` read services | Add only after each dataset declares a canonical table/format contract; do not rewrite engineering reporting. |
| Housekeeping datasets | `housekeeping-reports` read services | Same adapter approach; no new housekeeping calculations. |
| Basic financial summary | BE-19I `basic-financial-reporting` | Keep single-Building/current authority and no cross-Client currency claim. |
| Other report surfaces | Existing module authority, one at a time | Explicit registry adoption only; no automatic `SELECT *` exporter. |

The current six registered datasets remain compatible with the registry. Existing JSON projection functions are reusable adapters/projections, not permission to add binary rendering inside those modules.

### 13.3 No broad module rewrite

A dataset opts in by supplying an adapter around an existing service/read model. If a dataset lacks a governed CSV table, XLSX sheet contract, or PDF presentation contract, only that format is unavailable for that dataset; the dataset is not rewritten merely to satisfy a universal format claim.

This permits incremental adoption and keeps source calculation fixes in the owning module. A renderer bug is fixed in the renderer; a KPI bug is fixed in the source authority.

---

## 14. L — Future endpoints and OpenAPI boundary

No endpoint or OpenAPI file is changed now. The future contract should extend the existing route conventions and retain the existing live JSON route:

| Future endpoint | Purpose | Minimum authority |
|---|---|---|
| `GET /reports/export` | Existing synchronous/current-state JSON export. Keep existing behavior and path. | `reporting_export.read`; Management dataset also `management_read_model.read`; existing source scope rules. |
| `POST /reporting/exports` | Submit one normalized archive request. May return `REQUESTED` or a synchronously `COMPLETED` archive resource. | `report_export.generate` plus adapter-declared read permission and scope. Optional `Idempotency-Key` header. |
| `GET /reporting/exports/{id}` | Retrieve the request/execution status and immutable archive metadata. This may be a compatibility view over the archive resource. | `report_archive.read` plus full current scope recheck. |
| `GET /reporting/archives` | Bounded list of the caller's Client/Building-visible archive records with status/format/type/date filters and pagination. | `report_archive.read`. |
| `GET /reporting/archives/{id}` | Scoped archive detail, provenance, status, safe failure metadata, and file metadata. | `report_archive.read`. No raw storage reference or signed URL in the ordinary body. |
| `GET /reporting/archives/{id}/download` | Authorized binary stream or short-lived signed download issued by the existing storage boundary. | `report_archive.read` plus full current scope recheck. |

The future OpenAPI work must define:

- request body/format/dataset enums and adapter-specific filter rules;
- `REQUESTED`, `GENERATING`, `COMPLETED`, `FAILED` and retention-state semantics;
- idempotency behavior and regeneration/new-ID behavior;
- Client/Building scope errors and no cross-Client retrieval;
- JSON/CSV/XLSX/PDF content types and download response behavior;
- safe failure metadata and archive/file schemas;
- pagination and bounded list behavior;
- permission annotations, `x-building-scoped`/Client scope notes, provenance, immutability, and storage URL rules.

Do not add a POST to the existing live JSON path merely to avoid defining a durable archive resource, and do not expose a raw storage URL as an OpenAPI shortcut.

---

## 15. M — Migration strategy

- Highest ESG migration file inspected: `src/database/migrations/0329_create_esg_baselines_targets_verification.ts`.
- The migration list references the `0329` symbol, although the import inconsistency recorded in §2.5 is pre-existing and not changed here.
- Expected next free migration: **`0330`**.
- Future archive foundation: one justified `0330` migration for `report_archives` and any strictly necessary additive shared retention/storage metadata extension approved with PART 01.
- Do not create a migration in this governance step.
- Do not reserve `0331+` speculatively. Split a later migration only if implementation evidence requires a distinct, ordered schema change.
- No archive bytes, report payloads, or generated files are placed in PostgreSQL.
- No backfill of historical JSON responses, existing Documents, evidence rows, or old file references is authorized.

The existing `0329` migration-index defect is a prerequisite for safely running future migrations, but repairing it is outside this governance-only change.

---

## 16. N — Small PART breakdown

The preferred six-part breakdown remains the smallest coherent sequence:

| PART | Boundary | Reuse/dependency | Exit condition |
|---|---|---|---|
| **PART 01 — Export Request & Archive Foundation** | Define the canonical request/snapshot contract, adapter registry seam, `report_archives` identity/status/provenance/idempotency fields, single-Client/scope rules, storage namespace boundary, archive audit events, and shared retention applicability decision. Introduce only the one justified `0330` migration when implementation is authorized. | Existing reporting-export envelope/projections; KPI/BE-24 scope services; `contextAccessService`; existing storage interface/driver; `operational_events`; existing retention and due-job authority. | Durable archive rows can be accepted/claimed without a renderer, with immutable scope/filter/provenance and no cross-Client path. Runtime readiness remains conditional on the blockers in §18. |
| **PART 02 — CSV Renderer** | One governed tabular renderer over the canonical snapshot, including typed CSV, deterministic columns/order, bounds, safe filename, and formula-injection controls. | `ReportingExportColumn`/table contract; adapter CSV mapping. | Focused renderer contract covers single-table/declared flattening cases and rejects ambiguous multi-table datasets. |
| **PART 03 — XLSX Renderer** | Governed workbook/sheet renderer, stable sheet contract/order, explicit cell types, bounds, and formula-injection controls. | Same canonical snapshot; vetted dependency choice documented before install. | No formulas/macros/external links from source; multi-sheet behavior is adapter-declared and bounded. |
| **PART 04 — PDF Renderer** | Server-owned deterministic presentation templates, escaped values, no arbitrary HTML/networking, provenance headers/footers, and bounded pagination. | Same canonical snapshot; vetted PDF engine choice documented before install. | Presentation report is not a raw dump and is reproducible to snapshot/template versions. |
| **PART 05 — Dataset Integration + Archive/Download** | Adopt current datasets incrementally through adapters; add bounded async execution through the existing due dispatcher; persist checksums/file metadata; integrate retention due/purge and authorized download/temporary URL behavior. | Existing KPI/read models, management command center, storage boundary, retention executor, audit events, scheduler. | Existing and newly adopted datasets produce one immutable archive per execution; retries are bounded; no storage/document leakage. |
| **PART 06 — OpenAPI & Closure** | Add future endpoints/schemas/security/format/provenance documentation and focused contract validation; close governance gaps without broad regression/CI. | Existing `docs/api/openapi.yaml`, route/type conventions, this governance document. | OpenAPI matches implemented surfaces, all non-goals remain closed, and final review records commit/push/validation. |

Dependency shape:

```text
PART 01
  ├── PART 02 CSV
  ├── PART 03 XLSX
  ├── PART 04 PDF
  └── PART 05 Dataset Integration + Archive/Download
          └── PART 06 OpenAPI & Closure
```

JSON is not a seventh renderer implementation: the existing JSON envelope is the canonical machine-readable format and is reused by PART 01/05 where a durable JSON artifact is explicitly requested.

---

## 17. Risks and blockers

| ID | Risk/blocker | Mitigation / governance response |
|---|---|---|
| R1 | Current `EvidenceStorage` is evidence-namespaced and local-only. Reusing `evidence/<uuid>` for reports could collide with evidence retention and routes. | Generalize the existing storage boundary to a report/artifact namespace while retaining the same driver/root and path validation. No second storage engine; no direct reporting `fs`. **PART 01 dependency.** |
| R2 | Retention policy authority currently applies only to evidence. A direct FK/use would be semantically false and would not be purged by the current evidence executor. | Extend the existing policy/execution authority for report artifacts; no new policy table/engine. Require explicit policy decision before `COMPLETED`. **PART 01 blocker for a fully governed archive.** |
| R3 | No XLSX/PDF renderer dependency exists. | Select and review bounded, maintained libraries in PART 03/04. No dependency installation or runtime implementation in this CR. |
| R4 | Existing read models have different shapes and some detail sections can be large. | Adapter registry with explicit typed tables, row/byte/time budgets, deterministic ordering, and no broad fetch/post-filter. |
| R5 | Existing `GET /reports/export` uses a generic export permission rather than every source KPI permission. | Preserve existing JSON behavior. Make future archive adapter capabilities conjunctive and explicit; never grant source manage permissions. |
| R6 | A multi-Client current management read can be valid, but one archive row with one `client_id` cannot represent it safely. | Minimum archive is one Client. Request separate archives; a future fan-out aggregate is out of scope. |
| R7 | A caller may lose permission or Building access after an async request or after completion. | Recheck at generation and every archive/detail/download read. Deny a multi-Building artifact as a whole if the current caller cannot access every included Building. |
| R8 | Storage write can succeed while archive DB finalization fails, or a worker can crash in `GENERATING`. | Deterministic archive-ID storage key, claim/recovery guard, checksum reconciliation, bounded attempts, and no completed-row overwrite. |
| R9 | CSV/XLSX consumers can interpret strings as formulas; PDF HTML engines can interpret untrusted markup. | Explicit text typing/prefixing/escaping, server-owned templates, no arbitrary HTML/scripts/network resources, and focused renderer validation. |
| R10 | Temporary signed URLs are not supported by the current storage abstraction. | Initially stream through the authorized backend boundary. Add short-lived signed URLs only as a storage-adapter capability with no URL persistence/exposure. |
| R11 | The current migration index statically references `0329` without the visible import. | Repair/verify the pre-existing ESG migration index before running future migrations. Do not modify it in this governance CR. |
| R12 | Existing metadata-only file references in Documents/BAST/vendor/report modules are not proof that bytes are retrievable. | Do not use them as archive storage identity. Adopt them only through a future explicit storage/document authority extension. |
| R13 | Sensitive workforce, vendor, tenant, and financial fields may be present in source read models. | Adapter field allowlists/classification and permission-aware omit/mask rules. No raw source payload export; preserve source financial/client boundaries. |

---

## 18. PART 01 readiness

### Governance readiness

**YES — PART 01 governance is ready for implementation planning.** The existing JSON contract, source/read-model authorities, scope resolver, audit writer, storage boundary, due worker, retention dependency, archive identity, and future route boundary are identified.

### Runtime implementation readiness

**CONDITIONAL — not yet ready to implement as a fully governed runtime foundation.** Before PART 01 implementation starts, the following must be explicitly resolved in that PART's review:

1. Generalize the current evidence-only storage interface/driver to a report/artifact namespace without introducing a second backend or exposing paths.
2. Extend the existing evidence-only retention policy/execution authority to report artifacts, or record an approved equivalent extension of that same authority. A completed archive cannot silently have no retention governance.
3. Repair/verify the pre-existing missing `0329` migration import before running the future `0330` migration. This repair is outside the current change.
4. Freeze the single-Client archive rule and the adapter capability/permission matrix.
5. Set explicit bounded request/row/byte/time limits and the safe stale-claim/retry behavior.

XLSX/PDF library selection is a later PART 03/04 dependency, not a reason to create a second data contract or renderer engine.

---

## 19. Validation and stop state

Governance inspection only:

- `git status`/baseline verification performed;
- targeted repository authorities inspected for reporting-export, management scope/read models, documents, storage, evidence, retention, operational events/audit, RBAC, isolation, workers/outbox, routes, and existing downloadable artifacts;
- no dependencies installed;
- no database provisioned or migrated;
- no DB tests, broad tests, build, CI, or server run;
- no OpenAPI file modified;
- no dependency installed, database provisioned, migration executed, or worker/scheduler started;
- PART 01 runtime/migration/seed/route changes are limited to the implementation files recorded in §20; PART 02 renderer/test changes are recorded in §21.

The START GOVERNANCE step changed only `docs/CR-BE-EXP-01_START_GOVERNANCE.md`. PART 01 implementation changes are recorded in §20 below.

**STOP:** no PR and no merge are created by this PART. The current Arena branch remains `arena/01a0334b-asentra-backend`.

---

## 20. PART 01 implementation notes

**Implementation status:** PART 01 complete for the request/archive authority. CSV, XLSX, PDF, JSON rendering, artifact storage writes, download, retention execution, workers, retry processing, and OpenAPI remain deferred to later PARTs.

### 20.1 Delivered

- Added migration `0330_create_report_archives` and registered it after the existing `0329` entry. The new table stores Client/Building scope, current registry dataset, `JSON`/`CSV`/`XLSX`/`PDF` format identity, request/filter snapshot, source provenance, request/generation timestamps, nullable artifact metadata, safe failure/retry fields, idempotency fingerprinting, regeneration lineage, and retention snapshot/tombstone fields. It stores no file bytes.
- Added `src/modules/reporting-archives/` repository, service, controller, routes, types, validation, and errors.
- Added request/read surfaces only:
  - `POST /reporting/exports`
  - `GET /reporting/exports/:id`
  - `GET /reporting/archives`
  - `GET /reporting/archives/:id`
- Added only the frozen additive permissions `report_export.generate` and `report_archive.read`. Dataset generation requests also require the existing owning KPI/Management read permission; no manage or override permission was added.
- Reused `resolveManagementReadScope`/`contextAccessService` for current Client/Building authorization. Archive rows persist the complete resolved `building_ids` set, and reads require that set to remain within the caller's current accessible scope. Inaccessible archive IDs return the scoped not-found result; storage references are omitted from public responses.
- Added request-level idempotency using an `Idempotency-Key` hash plus canonical request fingerprint. Same key and fingerprint returns the existing request; same key with a different request conflicts; no-key requests remain distinct so deliberate regeneration creates a new archive request.
- Added the `REPORT_EXPORT_REQUESTED` operational event in the request transaction. No generated/failed event is emitted because PART 01 has no generation operation.
- Added database-level lifecycle/immutability guards for `REQUESTED`, `GENERATING`, `COMPLETED`, and `FAILED`, including immutable request identity and completed artifact fields. Regeneration is not an update path.

### 20.2 Explicit boundary/debt carried forward

- The pre-existing missing import for `0329_create_esg_baselines_targets_verification` was **not fixed**. It remains external baseline debt. `0330` was not renumbered or used to repair it.
- The existing evidence-only retention authority is referenced only as a future retention relationship; PART 01 does not create a retention engine or purge worker. A later PART must extend the existing authority before a report row can be completed with a retention snapshot.
- The existing evidence storage implementation is not used for report bytes. A later PART must add the governed report/artifact namespace through the existing storage boundary; no new storage engine was added.
- No renderer, source read-model execution, file generation, signed URL, download, queue, scheduler, retry processor, recurring report, notification, email, push, frontend, ESG, or OpenAPI change was added.

### 20.3 Validation and next steps

- `git diff --check`: **PASS**.
- Local `tsc`: **NOT RUN** — no local `node_modules/.bin/tsc` was available; dependencies were not installed. The known `0329` import debt was not troubleshot.
- Focused PART 01 database test: **NOT RUN** — no immediately available PostgreSQL/`psql` was present; PostgreSQL was not provisioned or started.
- Commit/push details are recorded in the delivery report.
- **Next migration:** `0331` (not reserved).
- **PART 02 readiness:** implemented; renderer notes are recorded in §21.

---

## 21. PART 02 implementation notes

**Implementation status:** PART 02 complete for deterministic, non-persistent CSV serialization over the canonical export snapshot. PARTs 03–06 remain deferred.

- Added `src/modules/reporting-export/csv-renderer.ts` and exported it through the existing `reporting-export` authority.
- The renderer accepts only supplied canonical snapshot/table data and governed columns. It performs no database query, authorization, scope resolution, KPI calculation, archive mutation, storage access, or persistence.
- Output is UTF-8 CSV with deterministic declared column order, supplied row order, CRLF line endings, RFC-style comma/quote/newline escaping, explicit null-as-empty handling, quoted empty strings, stable supplied date/time text, byte size, and SHA-256 checksum metadata.
- Formula-like string cells are neutralized with a leading apostrophe after inspecting leading whitespace/control characters for `=`, `+`, `-`, or `@`. Typed numeric negatives remain ordinary numeric values.
- Multiple-table snapshots require an explicit `tableKey`; missing tables, nested/non-scalar cells, unsafe/duplicate column definitions, and unsafe filenames fail explicitly. Filenames are normalized to a safe `.csv` name; no HTML, formulas, or executable content is accepted.
- Added non-DB focused coverage in `tests/reporting-export-csv.test.ts` for deterministic ordering, escaping, null/empty values, UTF-8, dates, formula injection, leading whitespace/control prefixes, negative numbers, nested data, non-tabular snapshots, and unsafe definitions/filenames.
- No migration, archive completion, storage write, download, worker/queue/scheduler, retry processor, OpenAPI, ESG, push, or `0329` change was made.

### PART 02 validation

- Focused CSV renderer test: **NOT RUN** — no local `node_modules/.bin/tsx` test runner was available; dependencies were not installed.
- Local `tsc`: **NOT RUN** — no local TypeScript compiler was available. The external `0329` baseline debt was not troubleshot.
- `git diff --check`: **PASS**.
- **Next migration:** `0331` remains next and was not used or reserved.
- **PART 03 readiness:** blocked; notes are recorded in §22.

---

## 22. PART 03 implementation notes

**Implementation status:** BLOCKED before implementation. The required first inspection found no suitable already-available XLSX-capable dependency in `package.json` or `package-lock.json`.

- The existing `reporting-export` contract and PART 02 CSV renderer were inspected only to confirm the shared canonical snapshot/column boundary.
- `package.json` contains no `xlsx`, `exceljs`, SheetJS, or equivalent XLSX-capable dependency; the lockfile contains no matching package entry. The `zip` text found in the lockfile is an integrity string, not an XLSX library.
- Per the PART 03 instruction, implementation stopped. No XLSX renderer, manual ZIP/XML implementation, dependency installation, package manifest/lockfile change, migration, archive completion, persistence, download, worker/queue/retry, OpenAPI, ESG, push, or `0329` change was made.
- No test file was added because there is no renderer implementation to exercise. The existing CSV renderer was not changed.
- The missing dependency is a **PART 03 blocker**. A future authorized dependency step must select and add a suitable deterministic XLSX library before renderer implementation can begin; this step must not install or introduce one.

### PART 03 validation and next step

- Focused XLSX renderer test: **NOT RUN** — PART 03 was stopped before implementation and local `tsx` is unavailable.
- Local `tsc`: **NOT RUN** — local TypeScript compiler is unavailable.
- `git diff --check`: **PASS**.
- External baseline debt: the pre-existing `0329` migration import was not changed.
- **Next migration:** `0331` remains unused and unreserved.
- **PART 04 readiness:** **BLOCKED** — the PDF dependency gate is recorded in §23; no PART 04 code was started.

---

## 23. PART 04 implementation notes

**Implementation status:** BLOCKED before implementation. The required first inspection found no suitable already-available PDF-capable dependency in `package.json` or `package-lock.json`.

- The inspection was limited to the existing canonical `reporting-export` snapshot contract, the existing PART 02 renderer exports, and the package manifest/lockfile.
- `package.json` contains no PDF renderer/engine such as `pdfkit`, `pdf-lib`, Puppeteer, Playwright, wkhtmltopdf, or an equivalent. The lockfile contains no matching PDF-capable package entry; the incidental `pdf` text is part of an integrity string.
- Per the PART 04 instruction, implementation stopped. No PDF renderer, manual PDF engine, dependency installation, migration, archive completion, persistence, download, storage, worker/queue/retry, OpenAPI, ESG, push, XLSX, or `0329` change was made.
- No PDF test was added because there is no renderer implementation to exercise. Existing CSV/XLSX work was not revisited or changed.
- The missing PDF dependency is a **PART 04 blocker**. A future authorized dependency step must select and add a suitable deterministic PDF library before renderer implementation can begin; this step must not install or introduce one.

### PART 04 validation and next step

- Focused PDF renderer test: **NOT RUN** — PART 04 was stopped before implementation and local `tsx` is unavailable.
- Local `tsc`: **NOT RUN** — local TypeScript compiler is unavailable.
- `git diff --check`: **PASS**.
- External baseline debt: the pre-existing `0329` migration import was not changed.
- **Next migration:** `0331` remains unused and unreserved.
- **PART 05 readiness:** **CONDITIONAL** — full dataset integration/archive-download work remains dependent on renderer implementation and the existing storage/retention boundaries; no PART 05 code was started.

---

## 24. Renderer dependency decision

**Owner decision recorded:** `exceljs` is approved for XLSX generation and `pdf-lib` is approved for PDF generation. No alternative XLSX/PDF library is approved.

- Added only the two approved runtime dependencies with `npm install --save`:
  - `exceljs`: declared `^4.4.0`, resolved `4.4.0` in `package-lock.json`.
  - `pdf-lib`: declared `^1.17.1`, resolved `1.17.1` in `package-lock.json`.
- Changed package files only: `package.json` and `package-lock.json`. No renderer, application behavior, migration, database, test, CI, OpenAPI, ESG, push, or `0329` change was made.
- PART 03 and PART 04 dependency gates are now **UNBLOCKED**. Renderer implementation remains reserved for the respective PARTs and must use only these approved libraries.
- `npm install` reported two moderate audit advisories; no `npm audit fix` or other dependency change was run.
- **Next migration:** `0331` remains unused and unreserved.

---

## 25. PART 03 resumed implementation notes

**Implementation status:** PART 03 complete. The previously approved `exceljs ^4.4.0` dependency was used; dependency selection and versions were not changed.

- Added `src/modules/reporting-export/xlsx-renderer.ts` and exported `renderReportingXlsx` through the existing `reporting-export` authority.
- The renderer accepts the canonical reporting snapshot and supplied governed tables only. It creates one workbook worksheet per supplied table, preserving supplied table, column, and row order. It performs no database access, authorization, KPI calculation, archive mutation, storage/document access, or operational-event emission.
- String, number, boolean, and null cells are supported. Dates/timestamps remain the supplied deterministic text representation; no locale formatting or formula inference is performed.
- Reused PART 02 table/column/row validation, filename normalization, checksum, and formula-neutralization helpers. Dangerous string prefixes, including leading whitespace/control characters before `=`, `+`, `-`, or `@`, are neutralized; typed negative numeric values remain numeric.
- Worksheet names are sanitized to Excel's safe length/character boundary with deterministic fallbacks and collision suffixes. Output returns XLSX bytes, content type, safe filename, byte size, and SHA-256 checksum. No files are persisted.
- Added non-DB ExcelJS logical-workbook tests in `tests/reporting-export-xlsx.test.ts`; tests do not require byte-for-byte ZIP equality.
- No migration, dependency version change, PDF/CSV behavior rewrite, archive completion, download, signed URL, worker/queue/retry, OpenAPI, ESG, push, or `0329` change was made.

### PART 03 resumed validation and next step

- Focused XLSX renderer test: **NOT RUN** — local `tsx`/`node_modules` was unavailable; dependencies were not installed in this resumed workspace.
- `npm run typecheck`: **NOT RUN** — local `tsc` was unavailable; no environment troubleshooting was performed.
- `git diff --check`: **PASS**.
- **PART 04 readiness:** implemented; renderer notes are recorded in §26.

---

## 26. PART 04 resumed implementation notes

**Implementation status:** PART 04 complete. The approved `pdf-lib ^1.17.1` dependency was used; dependency selection and versions were not changed.

- Added `src/modules/reporting-export/pdf-renderer.ts` and exported `renderReportingPdf` through the existing `reporting-export` authority.
- The renderer consumes only the canonical reporting snapshot and validated governed tables. It produces an in-memory `application/pdf` Buffer with a safe `.pdf` filename, byte size, and SHA-256 checksum. It performs no database access, authorization, scope resolution, KPI calculation, archive mutation, storage access, delivery, or operational-event emission.
- PDF v1 includes supplied report title/provenance (`generatedAt`, `asOf`, and period), table sections, headers, scalar rows, repeated continuation headers, bounded wrapping, automatic page continuation, and page numbers. It uses only public pdf-lib document/page/font APIs.
- User/business text is normalized to safe printable text for the built-in standard font; unsupported Unicode/control code points are replaced safely, whitespace is bounded, and no HTML, JavaScript, actions, attachments, remote fonts, images, or external resources are accepted.
- Reused PART 02/03 canonical flat-table validation, filename normalization, checksum, and formula-neutralization helpers. Strings remain text, numbers/booleans remain typed, null is blank, dates remain supplied deterministic text, and nested/array cells are rejected.
- Added non-DB structural coverage in `tests/reporting-export-pdf.test.ts` using pdf-lib to load generated documents. Tests cover valid signatures, multiple tables, logical determinism, primitive values/nulls, UTF-8-safe input, text escaping, long-table pagination, nested data rejection, safe filenames, content type, size, and checksum.
- No migration, dependency change, CSV/XLSX behavior change, archive completion, persistence, download, signed URL, worker/queue/retry, OpenAPI, ESG, push, or `0329` change was made.

### PART 04 resumed validation and next step

- Focused PDF renderer test: **NOT RUN** — local `tsx`/`node_modules` was unavailable; dependencies were not installed in this resumed workspace.
- `npm run typecheck`: **NOT RUN** — local `tsc` was unavailable; no environment troubleshooting was performed.
- `git diff --check`: **PASS**.
- **PART 05 readiness:** implemented; integration, completion, storage, download, and retention-boundary notes are recorded in §27.

---

## 27. PART 05 implementation notes

**Implementation status:** PART 05 complete for the synchronous dataset/renderer/storage/archive/download seam. No background worker, scheduler, retry processor, or OpenAPI closure was added.

- Added `reporting-export.registry.ts`, a single governed registry/dispatcher for the six datasets currently exposed by the canonical runtime registry. Each adapter delegates to the existing BE-23 KPI or BE-24 Management read-model authority and returns the canonical snapshot; ESG was not invented because no ESG dataset is currently exposed by that runtime registry.
- The archive POST path now accepts/creates the request, claims `REQUESTED → GENERATING`, resolves one current authorized scope, loads one canonical snapshot, dispatches exactly to JSON/CSV/XLSX/PDF, writes one artifact through the existing shared storage abstraction, persists filename/content type/size/checksum/completion metadata, and records `COMPLETED`. Renderer/storage/generation failures become `FAILED`; no fallback renderer is used.
- Extended the existing storage boundary with the backend-controlled `reports/<archive-id>` namespace. The local driver remains the only implementation; no report-specific storage engine was added and report bytes are never stored in `report_archives`.
- Added `GET /reporting/archives/:id/download`. It permits only current-scope `COMPLETED` archives, verifies the stored byte size and SHA-256 before serving, returns stored content type/safe filename, and never regenerates. Incomplete, failed, purged, missing, or integrity-mismatched artifacts are not served; raw storage references and permanent anonymous URLs remain private.
- Added `REPORT_EXPORT_GENERATING`, `REPORT_EXPORT_COMPLETED`, `REPORT_EXPORT_FAILED`, and `REPORT_ARCHIVE_DOWNLOADED` through `recordOperationalEvent`. Event metadata contains identity and safe file metadata only; no bytes, payloads, paths, URLs, or secrets are logged.
- Generation rechecks the requested user's current generation/read permissions and full recorded Client/Building scope. Multi-Building archives are denied as a whole if scope is no longer complete. Existing request idempotency and new-ID regeneration behavior remain unchanged.
- Current report retention remains explicitly deferred: the existing evidence-only retention executor is not applied to report archives, and no destructive cleanup was introduced. The existing `0330` completion invariant now requires artifact metadata but does not require an unsupported evidence retention snapshot; `report_archives` completes with `retention_state = ACTIVE` and no retention snapshot until the shared retention authority is extended for this artifact class.
- Added non-DB dispatcher/format coverage in `tests/reporting-export-part05.test.ts`. DB lifecycle, storage, isolation, idempotency, and download integration remain covered by the service/repository seams but were not run without an immediately available database.
- No migration was created, no `0331` was used/reserved, no renderer redesign or dependency change was made, and the external `0329` migration-import debt remains untouched.

### PART 05 validation and next step

- Focused PART 05 test: **NOT RUN** — local `tsx`/`node_modules` was unavailable; no dependency installation or environment troubleshooting was performed.
- `npm run typecheck`: **NOT RUN** — local `tsc` was unavailable.
- `git diff --check`: **PASS**.
- **Next migration:** `0331` remains unused and unreserved.
- **PART 06 readiness:** implemented; closure and final-review notes are recorded in §28.

---

## 28. PART 06 implementation notes

**Implementation status:** PART 06 complete for the public OpenAPI/contract closure. No runtime behavior, dependency, database, worker, scheduler, retention cleanup, or `0329` change was introduced.

- Extended `docs/api/openapi.yaml` with the actual runtime routes only: `POST /reporting/exports`, `GET /reporting/exports/{id}`, `GET /reporting/archives`, `GET /reporting/archives/{id}`, and `GET /reporting/archives/{id}/download`.
- Documented the runtime dataset enum, `JSON`/`CSV`/`XLSX`/`PDF` formats, request filters/scope, archive lifecycle, source/filter provenance, artifact metadata, safe failure metadata, idempotency behavior, permissions, no-oracle scope behavior, and no public storage reference/URL.
- Documented download media types for JSON, `text/csv`, XLSX, and PDF, including `Content-Disposition: attachment`, safe encoded filename behavior, verified `Content-Length`, and `X-Request-ID`.
- Reused the runtime constant values in the focused contract test rather than adding test-only enum copies. The OpenAPI dataset parameter and `ReportingExportMetadata.dataset` now reference the shared dataset schema.
- Added `tests/reporting-export-part06-contract.test.ts` for route presence/operation IDs, runtime enum alignment, permissions, archive response shape, idempotency header, download media types/headers, storage-reference omission, and route registration alignment.
- Retention cleanup remains deferred. Evidence retention is not treated as a report-archive retention authority; no cleanup, scheduler, deletion, or new retention engine was added.
- Existing migration `0330` remains the only CR migration used; no `0331` was created. The external missing `0329` import remains unchanged.

### PART 06 validation and final-review readiness

- Focused OpenAPI/contract test: **NOT RUN** — local `tsx`/`node_modules` was unavailable.
- Focused archive lifecycle/download tests: **NOT RUN** — PostgreSQL was not immediately available and was not provisioned.
- `npm run typecheck`: **NOT RUN** — local `tsc` was unavailable.
- `git diff --check`: **PASS**.
- No test or validation result is claimed as PASS unless it was actually executed; only the diff check executed successfully.
- **FINAL REVIEW readiness:** **CONDITIONAL** — public contract closure is documented and aligned by inspection, but focused contract/typecheck and DB-backed lifecycle/download validation remain outstanding. Renderer/archive functionality and retention boundaries remain otherwise closed to this CR.

---

## 29. FINAL REVIEW notes

**Review scope:** CR-BE-EXP-01 only. No whole-repository re-audit was performed.

- Confirmed migration `0330_create_report_archives` is registered after the existing `0329` entry. The external missing `0329` import remains unchanged; no `0331` was created.
- Confirmed the archive lifecycle/immutability guard, one canonical snapshot → exact format dispatch, current dataset registry, shared storage/download boundary, checksum/size verification, operational-event vocabulary, and absence of scheduler/worker, push/email, and new retention cleanup.
- Confirmed OpenAPI routes and schemas align with actual runtime registration. The Reporting Export tag description was corrected to include the now-supported archive formats/download boundary. No nonexistent route was documented and no storage reference/public URL was added.
- No direct CR-BE-EXP-01 defect requiring runtime redesign was found by this focused inspection. The only fix in this review is the OpenAPI description alignment above.
- Retention cleanup remains deferred because evidence-only retention is not automatically a report-archive retention authority. No cleanup, scheduler, deletion, or second retention engine was introduced.

### FINAL REVIEW validation

- `npm run typecheck`: **NOT RUN** — local `tsc`/`node_modules` unavailable; dependencies were not installed.
- Focused CSV/XLSX/PDF/Part 05/Part 06 tests: **NOT RUN** — local `tsx`/`node_modules` unavailable.
- PostgreSQL-backed archive lifecycle/download validation: **NOT RUN** — PostgreSQL was not immediately available and was not provisioned.
- `git diff --check`: **PASS**.
- No unexecuted test is claimed as PASS. Final review remains **CONDITIONAL** until executable focused/typecheck/DB validation is available or explicitly accepted as external validation debt.
