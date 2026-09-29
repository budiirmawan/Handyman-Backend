# CR-HM-10 — Evidence, QC & Rectification — START GOVERNANCE

Date: 2026-09-29 (Asia/Jakarta)
Branch: `arena/01a0e01e-handyman-backend`
Base commit: `91d9ee0` (CR-HM-09 certified COMPLETE —
`CR_HM_10_PREREQUISITE=MATERIAL_EXECUTION_COMPLETE`)

Governance ONLY. NO migration, NO runtime/API/OpenAPI/tests in this
PART. This document freezes ownership, aggregate, lifecycle,
authority, blockers, and the smallest legal PART split for CR-HM-10.
Does not invent runtime.

## §1 Position in the frozen roadmap

Roadmap row 10: **Evidence, QC & Rectification** — no upstream
dependency, unblocks CR-HM-02 (intake seam closure), CR-HM-17,
CR-HM-18. Scope vocabulary: *staged evidence; dynamic checklist/QC;
PASS/DEFECT/N/A/NOT CHECKED; defect; rectification; reinspection*.
Primary authority: **Handyman-Backend**.

Roadmap completion row (contract):
> Staged evidence, QC checklist outcomes, defect/rectification/
> reinspection contracts published; evidence intake seam binding for
> CR-HM-02 closed; Handyman QC templates remain separate from FM
> checklists.

Upstream verified READ-ONLY prerequisites (never reopened, never
mutated — CR-HM-06..09 modules are consumed exclusively through
their committed, certified surfaces):

- **CR-HM-04/06** `handyman_execution_scopes` (deterministic
  PHASE of MAINTAINER request; the ONLY execution target — a
  scope-referencing row pointing to any non-handed scope is
  impossible) + `handyman_execution_scope_assignments` (CURRENT
  authoritative Crew Lead binding — the authority preamble).
- **CR-HM-08** `handyman_work_sessions(
  ...)` + append-only `handyman_work_session_events` — READ-ONLY
  context: a QC run may reference the session it was captured in;
  CR-HM-10 NEVER writes sessions, NEVER blocks the
  COMPLETE/CHECK_OUT ladder (already certified; frozen read-only).
- **CR-HM-09** `handyman_material_execution_lines` +
  `handyman_material_execution_events` — READ-ONLY context: a
  MATERIAL-stage evidence record may reference a settled line;
  CR-HM-10 NEVER re-opens settled material state (SETTLED remains
  CR-HM-13-owned downstream settlement territory).
- **CR-HM-02** evidence INTAKE seam (migration 0379 parent
  admission `HANDYMAN_REQUEST`; evidence engine in
  `src/modules/evidence`: requirements/submissions, MIME allowlists,
  ≤50MB, SHA-256 integrity, retention/hold/purge, storage
  abstraction). CR-HM-10 CLOSES this seam: the full Handyman
  evidence lifecycle authority arrives here — CR-HM-02 is
  preserved READ-ONLY (intake flow is never re-authored).

## §2 FROZEN decisions

### D1 — Ownership (ONE authority, infra reuse ≠ authority transfer)

- CR-HM-10 is the SOLE authoritative owner of Handyman evidence
  stages/types/lifecycle, Handyman QC templates/criteria/execution
  outcomes, and Handyman defect/rectification/reinspection
  lifecycle.
- Reuse rows from CR-HM-00 (`evidence` engine EXTEND;
  `checklist-templates`/`checklist-executions` REUSE;
  `findings`/`finding-rework` REUSE) are INFRASTRUCTURE: accepting
  bytes/outcomes via existing primitives never makes those modules
  the domain authority. The domain state machines, stages, and
  lifecycle vocabulary live EXCLUSIVELY in new `handyman_*` tables.
- Handyman QC templates/criteria stay SEPARATE from FM checklists
  in name, in data (zero cross-joins), and in navigation (any UI
  hyperlink-in is presentation-only).
- **FK discipline (frozen across all handyman migrations):**
  new FKs point to Handyman tables (`handyman_execution_scopes`,
  `handyman_work_sessions`, `handyman_material_execution_lines`,
  clients) and generic realm (users, clients) ONLY — NEVER to FM/
  HRM tables. The evidence engine seam is a VALUE binding
  (`execution_type='HANDYMAN_*'` + `execution_id`), mirroring
  migration 0379, not an ORM relationship.

### D2 — THREE aggregates + append-only event evidence (each with
an events sibling)

1. **`handyman_evidence_records`** — ONE row per captured evidence
   unit. Columns (exact): `id uuid PK`; `client_id uuid NOT NULL
   REFERENCES clients (id) → immutable tenant watermark`;
   `execution_scope_id uuid NOT NULL REFERENCES
   handyman_execution_scopes (id)`; `session_id uuid REFERENCES
   handyman_work_sessions (id) NULLABLE` (capture context, never a
   gate); `stage text NOT NULL CHECK (stage IN (
   'BEFORE','DURING','AFTER','QC','DEFECT','RECTIFICATION',
   'MATERIAL'))`; `description text NULL`; `created_at timestamptz`;
   `updated_at timestamptz`. Stage vocabulary is frozen
   (governance D2.4 about BAST/WARRANTY below).
2. **`handyman_evidence_record_files`** — ONE
   row per media file stitched to a record: `id`, `record_id uuid
   NOT NULL REFERENCES handyman_evidence_records (id)`;
   `media_kind text NOT NULL CHECK (media_kind IN (
   'PHOTO','DOCUMENT','VIDEO'))`; `storage_key text NOT NULL UNIQUE`;
   `content_type text NOT NULL`; `byte_size bigint NOT NULL`;
   `sha256_digest text NOT NULL`; `capture_time timestamptz NULLABLE`
   (claimed-by-caller capture clock, server-validated as not in the
   future); `created_at`. NO file bytes in PostgreSQL — storage
   reference only; MIME/size/MIME-allowlist rules mirror the
   evidence engine's frozen policy (jpeg/png/webp; ≤50MB; VIDEO
   admitted under the same bounded policy as CR-HM-02 D2; NO svg —
   the frozen engine excludes it for photos, and this module does
   not re-admit it).
3. **`handyman_evidence_record_events`** — append-only: `id`;
   `record_id`; `client_id`; `event_type text CHECK
   (event_type IN ('CREATE','FILE_ADD','FINALIZE'))`;
   `idempotency_key`; `actor_user_id`; `occurred_at`;
   UNIQUE(record_id,event_type,idempotency_key).
4. **`handyman_qc_runs`** — ONE row per QC execution against ONE
   execution scope: `id`; `client_id`; `execution_scope_id`;
   `session_id uuid REFERENCES handyman_work_sessions (id)
   NULLABLE` (provenance only, never a session gate);
   `checklist_identity text NOT NULL` (bounded free-text checklist
   name + revision, e.g. "plumbing-final-v3" — Handyman templates,
   NEVER an FM checklist FK); `status text NOT NULL CHECK (status
   IN ('OPEN','FAILED','PASSED'))`; `created_at`, `updated_at`
   (exactly ONE OPEN run per scope: partial UNIQUE index).
5. **`handyman_qc_run_items`** — one row per check-item outcome:
   `id`; `run_id uuid NOT NULL REFERENCES handyman_qc_runs (id)`;
   `item_key text NOT NULL` (bounded); `outcome text NOT NULL CHECK
   (outcome IN ('PASS','DEFECT','NA','NOT_CHECKED'))`; `note text
   NULL`; `created_at`; `updated_at`; UNIQUE(run_id,item_key).
6. **`handyman_qc_run_events`** — append-only: `OPEN`,
   `ITEM_SET`, `FINISH`.
7. **`handyman_defect_records`** — ONE row per defect found on a
   scope (possibly via a DEFECT-outcome QC item): `id`; `client_id`;
   `execution_scope_id`; `run_id uuid REFERENCES
   handyman_qc_runs (id) NULLABLE`; `item_id uuid REFERENCES
   handyman_qc_run_items (id) NULLABLE`; `description text
   NOT NULL`; `status text NOT NULL CHECK (status IN (
   'OPENED','RECTIFYING','RECTIFIED','VERIFIED'))`;
   `created_at`, `updated_at`.
8. **`handyman_defect_events`** — append-only: `OPEN_DEFECT`,
   `START_RECTIFICATION`, `RECORD_RECTIFICATION`,
   `REQUEST_REINSPECTION`, `PASS_REINSPECTION` (terminal VERIFIED).

Tables 4/5/7 carry their own `handyman_d_*` event siblings per the
frozen append-only pattern (idempotency-unique per (parent,
event_type, idempotency_key); foresight-immutable triggers
blocking UPDATE/DELETE, mirroring the CR-HM-08/09
`_block_mutation()` precedent). The per-table event rows carry
`client_id` for the client-consistency trigger.

### D3 — Lifecycle state models (frozen — transitions only via
commands with server timestamps)

- **Evidence record**: implicit (no status column — a record
  exists upon CREATE; files append while record is pre-finalize;
  FINALIZE locks the file set). FREEZE: files may be added until
  FINALIZE only (bounded 409); NOTHING is deleted or rewritten
  afterwards (D6 evidence discipline).
- **QC run**: `OPEN → PASSED | FAILED` (FINISH command evaluates
  ALL items server-side: PASSED iff every item outcome is
  PASS or NA; any DEFECT or remaining NOT_CHECKED → FAILED).
  REOPENING IS FORBIDDEN — a new run is a fresh OPEN row
  (history is additive; never soft-delete).
- **Defect**: `OPENED → RECTIFYING → RECTIFIED → VERIFIED` (via
  REINSPECTION pass). REINSPECTION can loop
  RECTIFIED → RECTIFYING (fail) or RECTIFIED → VERIFIED (pass);
  POST-VERIFIED = locked (page mutation attempts bounded 409) —
  D5's warranty-correction branch lives outside this module.

### D4 — Authority/locking/idempotency (PART-reused stack)

- EVERY command/projection: authenticated actor → client-
  access wall → scope 404 → Lead-authority wall (CURRENT
  authoritative `handyman_execution_scope_assignments` binding;
  helper members insufficient) — mirroring PART 03–06 preambles.
  SAME rules for reads (projections/read models Lead-gated).
- Row-lock serialization (`SELECT ... FOR UPDATE on the aggregate
  head`) inside the SAME transaction as head update + event append
  — mirroring the PART 03–05 command architecture; NO advisory
  locking/no out-of-band reconciliation.
- Idempotency-unique event replay per (parent, event_type,
  idempotency_key) — replay returns the SAME rows (`replayed:
  true`), never re-applies mutations.
- Bounded error map: 400 VALIDATION_ERROR / domain-quantity-style
  400s; 401 AUTHENTICATION_REQUIRED / SESSION_REQUIRED; 403
  BUILDING_ACCESS_DENIED / *_NOT_AUTHORIZED; 404 *_NOT_FOUND;
  409 *_ILLEGAL_TRANSITION / *_CONFLICT / *_ALREADY_*.

### D5 — FINAL_CHARGE/QC cross-boundary

- QC outcomes and defect state are SEQUENCED truth ONLY: this CR
  never computes amounts/pricing/charging; ZERO amount/currency/
  price columns on any table (DB column firewall scan must find 0
  tokens, mirroring the certified CR-HM-09 firewall sweep). A
  defect NEVER adjusts the CR-HM-09 settled final usage basis
  (that stays CR-HM-13 territory).
- A FAILED QC run (or RECTIFIED-NOT-YET-VERIFIED defect) BLOCKS
  nothing in CR-HM-08/09 (frozen read-only criteria) — customer
  acceptance semantics (BAST) are CR-HM-11's job; this CR merely
  PUBLISHES the truthful QC/defect state read models CR-HM-11/17/18
  consume.
- BAST/WARRANTY evidence stages: RESERVED vocabulary only —
  the D2 stage CHECK lists exactly 7 stages; values
  BAST/WARRANTY are NOT in the CHECK (neither accepting nor
  rejecting: the CHECK freezes the boundary; adding those
  stages later is a new migration at their CRs, never a string
  mutation here).

### D6 — Evidence/audit discipline

- Records and files are append-only evidence chains
  (create/finalize events only — NEVER update, NEVER delete;
  mimic the `_block_mutation()` trigger precedent on
  evidence_record_files to make the persisted file-set immutable
  post-FINALIZE).
- Sha-256 integrity digest per file (mirroring the evidence
  engine's integrity mechanism) — tamper-evident at read time.
- `capture_time` is a CALLER-CLAIMED timestamp bounded by
  reasonability (≤ server-now + 5 minutes skew — server-side
  assert; the module persists BOTH `capture_time` and
  server `created_at`; autority stays server-side).
- No OCR/EXIF/AI enrichment (mirroring CR-HM-07 04A/04B
  exclusion discipline); nothing is fabricated for absent fields.

### D7 — Idempotency approval + publication (server-side)

All mutations flow through: parse → authority preamble →
transaction (row-lock → replay-check → stable-state check →
head-write → event-append) → commit. Readers (per-scope listing
of evidence records/files, QC runs with items, defects with
current state) are READ-ONLY queries over committed state —
zero stateful projections, zero fabrication, Lead-gated.

### D8 — Existing reusable primitives vs required extensions

- REUSED (read-only surface):
  `evidence/storage` abstraction (storage-key discipline only —
  no new bucket), evidence engine MIME/size policy characterization
  (for the bounded mirror policy), `handyman-lineage` tenancy
  (client consistency triggers), `users`, `handyman_execution_scopes`
  + `handyman_execution_scope_assignments` (authority preamble),
  `handyman_work_sessions` (provenance FK target), error
  vocabulary/AppError raised-module pattern, idempotency-unique
  index shape from `_events` tables, `_block_mutation()` trigger
  function family.
- NEW (this CR's own): 8 tables (D2), trigger fns
  (`handyman_evidence_client_consistency`,
  `handyman_qc_client_consistency`,
  `handyman_defect_client_consistency`,
  `handyman_evidence_file_block_mutation`,
  `handyman_*_event_block_mutation`, partial-OPEN-unique index),
  domain module `src/modules/handyman-evidence-qc/`
  (not `handyman-qc`: the aggregate covers ALL THREE —
  evidence, QC, and defect/rectification — with one module
  owning the shared authority preamble), HTTP sibling
  `src/modules/handyman-evidence-qc-api/`.
- ZERO FM extension (no FK to FM checklists/findings, no
  FM table mutation, no FM code import besides generic
  evidence/storage infra which remains a dependency boundary,
  not a semantic adoption).

### D9 — Blockers (closed by this CR)

CR-HM-00 cross-repo matrix classifies rows 14 (Evidence), 16
(QC/Checklist), and 17 (Defect/Rectification/Reinspection) as
**A — BACKEND CONTRACT BLOCKER**:

- Row 14 closes here: staged evidence lifecycle for Handyman is
  authoritative (all 7 frozen stages admitted).
- Row 16 closes here: Handyman QC template/criteria vocabulary +
  per-item outcomes authoritative (not the FM checklist engine).
- Row 17 closes here: Handyman defect/rectification/reinspection
  lifecycle authoritative.

Open blockers found while writing this document: **0**.

### D10 — Smallest legal PART split

```text
THIS PART — governance freeze (THIS DOCUMENT)
PART 01 — persistence foundation: ONE migration (8 tables,
          stage/outcome/status CHECKs, partial-OPEN-QC unique
          index, idempotency-unique events, append-only triggers,
          client-consistency triggers, provenance FKs) +
          types/errors/repository; domain-table firewall
          sweeps = 0. NO runtime service.
PART 02 — EVIDENCE commands: CREATE record (stage-bounded),
          FILE_ADD (MIME/size/IMGN-DIGEST server-validated;
          pre-finalize only), FINALIZE (lock file set) +
          per-scope/lifecycle reads. Idempotent replay; Lead-only.
PART 03 — QC commands: OPEN run, ITEM_SET (PASS/DEFECT/NA/
          NOT_CHECKED), FINISH (server-evaluated PASSED/FAILED),
          run+item read models; ONE OPEN per scope (409 on second);
          terminal-run reads.
PART 04 — DEFECT commands: OPEN_DEFECT (optional run/item link),
          START_RECTIFICATION / RECORD_RECTIFICATION /
          REQUEST_REINSPECTION (loop), PASS_REINSPECTION
          (terminal VERIFIED); defect read models; zero commercial
          coupling.
PART 05 — thin HTTP/OpenAPI exposure (bounded endpoints mirroring
          CR-HM-09 PART 06 shape: ~12 routes, authentication-only,
          whitelist body validation, exact parity, forbidden
          financial/ownership surface absent).
PART 06 — FINAL CERTIFICATION (focused suites, firewalls,
          final doc; mirrors CR-HM-08/09 certification records:
          CR_HM_10_STATUS=COMPLETE / _BLOCKERS=0 /
          _IMPLEMENTATION_DEFECTS=0 /
          EVIDENCE_STAGE_CHECK_BOUNDARY=FROZEN-7 / FM_COUPLING=NO).
```

## §3 Handoff

- **CR-HM-02 closure** — the evidence intake seam's forward
  binding lands here: a HANDYMAN_REQUEST row may reference an
  intake-stage Handyman evidence record (BEFORE) once this CR's
  evidence aggregate exists (value binding only — CR-HM-02 stays
  READ-ONLY; closure is declared here, implemented when the PART 02
  evidence surface exists).
- **CR-HM-11 BAST & Customer Acceptance** — consumes the
  published QC/defect read models: a BAST can bind evidence
  records with zero ownership transfer (CR-HM-11 gates acceptance
  on PASSED QC iff its own frozen policy declares so — outside
  this CR).
- **CR-HM-17 warranty** — consumes the VERIFIED defect stream
  for warranty-decision marshalling (the warranty-correction
  branch that may re-open rectification is ITS CR's authority —
  CR-HM-10 obliges only to provide an append-only,
  tamper-evident defect history).
- **CR-HM-18** — consumes QC PASSED and all-defects-VERIFIED
  terminal truth for settlement eligibility policy (again: CR-HM-10
  guarantees only faithful publication of the state; the
  eligibility RULE is downstream).

FROZEN boundary for THIS CR: evidence/QC/defect are CORE "evidence &
quality execution truth" — the moments the customer saw and the
verdicts reached. NOT billing. NOT (re)pricing inputs. NOT BAST or
acceptance themselves. NOT warranty. ONLY the Handyman-scoped
quality record, rendered to customers faithfully.
