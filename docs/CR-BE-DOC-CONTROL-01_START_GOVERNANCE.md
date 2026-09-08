# CR-BE-DOC-CONTROL-01 — START GOVERNANCE

**Title:** Evidence Integrity Hash + Retention
**Repository:** `asentra-backend`
**Branch:** `arena/01a02d64-asentra-backend` (from `main` @ `6b998bcaaa7d27c0935271cc4e55411e83d46632`)
**Inspection date:** 2026-08-23
**Status:** PART 01–05 implemented (see §15–§16). This document is the CR authority: §0–§14 record the START
GOVERNANCE decisions; §15 records per-PART implementation notes; §16 records governance closure.

---

## 0. Decision summary

Asentra already has ONE shared evidence engine (`evidence_requirements` + `evidence_submissions`, BE-07) and ONE
storage abstraction (`EvidenceStorage`, CR-BE-API-01 PART 03). This CR extends that engine with additive integrity
metadata (server-computed SHA-256 over stored bytes, size, MIME snapshot, hashed-at), a reusable verification seam
with persisted last-verification outcome, a Client-scoped/optionally-Building-scoped retention policy authority
modeled on the proven `sla_definitions` precedence/snapshot pattern, an immutable retention snapshot on the evidence
row, and a `PURGED` tombstone lifecycle executed by the existing due-job dispatcher.

No parallel document/evidence platform, no new storage system, no second scheduler, no blockchain/notarization/
signatures, no manual hash-setting API, and no silent backfill of historical evidence.

---

## 1. Existing authority map

### 1.1 The authoritative evidence engine (in scope)

| Authority | Location | Facts relevant to this CR |
|---|---|---|
| Evidence submissions | `evidence_submissions` (migration `0073`) | Client-owned rows: `client_id`, `execution_type` + `execution_id` parent binding, `evidence_type` (PHOTO/DOCUMENT/SIGNATURE), `file_reference`, `original_file_name`, `mime_type`, `file_size` (≤ 52 428 800), `captured_at`, `submitted_by_user_id`, `status` ACTIVE/REMOVED. Soft-remove only; rows are never hard-deleted. |
| Evidence requirements | `evidence_requirements` (migration `0072`) | Requirement/count/type rules per target. Not a file authority; unaffected by integrity metadata. |
| Parent (execution) union | migrations `0087`, `0159`, `0189`, `0211`, `0277`, restored/final in `0281` | `FORM_INSTANCE`, `CHECKLIST_EXECUTION`, `WORK_ORDER`, `VENDOR_WORK`, `UTILITY_METER_READING`, `PERMIT`, `FINDING`, `FINDING_REWORK`, `FINDING_VERIFICATION`. Every widening reused the single engine — the repository's explicit precedent against parallel evidence engines. |
| Storage abstraction | `src/modules/evidence/storage/` (`EvidenceStorage`: `put`/`get`/`remove`; `local` driver; `EVIDENCE_STORAGE_DRIVER` / `EVIDENCE_STORAGE_DIR`) | Keys are backend-generated `evidence/<uuid>` only; no client path reaches the filesystem. `get` throws `EVIDENCE_FILE_NOT_FOUND`; `remove` is a no-op when absent. This is the ONLY place evidence bytes flow through the backend. |
| Byte-upload flows | `POST /evidence/:evidenceId/file` (`evidence-file.routes.ts`) and single-call `POST /mobile/evidence` (`mobile-evidence.routes.ts`) | Both buffer the multipart file in memory (multer, 50 MB cap), MIME-check it against the evidence type, call `storage.put`, then persist metadata. These are the only two authoritative places where the server possesses the binary at write time. |
| Metadata-contract submission | `submitEvidenceMetadata` (`evidence.service.ts`) + domain repositories (`work-order-evidence`, `housekeeping-evidence`, `permit-evidence`, `vendor-work-evidence`, `utility-meter-reading-evidence`) | These insert `evidence_submissions` rows with a caller-supplied opaque `file_reference` and NO bytes. The server cannot compute a truthful hash on this path. |
| Evidence read/serve | `GET /evidence/:id/file`, `GET /evidence/:id/file/content` | Bytes are read back through `storage.get` — the natural verification read seam. |
| FK references INTO evidence | `bast_evidence_bindings.evidence_submission_id` (migration `0259`), `utility_ocr_candidates.evidence_id` (migration `0281`) | Hard FKs to `evidence_submissions(id)`. Physical row deletion would break them — decisive for the tombstone decision (§7). |

### 1.2 Other file-metadata authorities (out of scope v1 — recorded so scope is explicit)

`documents` + `document_versions` + `supporting_documents` (BE-22), `tenant_documents`, `vendor_compliance_documents`,
`vendor_licenses_certifications`, `bast_documents`, `handover_documents`, `visitor_photos`. All follow the BE-07
convention of storing an opaque `file_reference` plus metadata and never a binary, and none of them pass bytes
through the backend today (no `createEvidenceStorage` usage outside `src/modules/evidence`). Because a server-side
hash must represent stored binary content the server actually received, these authorities are **excluded from v1
governance**: assigning them hashes would fabricate integrity claims. They remain candidates for a later CR once (if
ever) their upload flows route bytes through the shared storage abstraction. This CR must not fork a second
document-control platform for them.

### 1.3 Supporting authorities to reuse

| Authority | Location | Reuse |
|---|---|---|
| Operational events | `operational_events` + `recordOperationalEvent` (sensitive-key scrubbing, append-only, optional tx client) | All integrity/retention audit events (§8). |
| Due execution | `due-job-scheduler` (single guarded `setInterval`) → `due-job-dispatcher.processDueOperationalJobs` (per-domain results: reminders, escalations, slaClocks, slaEscalations, outboundDeliveries) | Add ONE retention domain to the existing dispatcher (§7). No new scheduler. |
| Client/Building isolation | `contextAccessService.getAccessibleClientIds/BuildingIds`, `buildingAccessDeniedError`; evidence routes already enforce Client scope + Finding-parent Building scope | Reuse verbatim for every new read/verify/admin surface (§9). |
| RBAC | Seeded permissions incl. `evidence.read`, `evidence.manage`, `housekeeping_evidence.*`, `client_configuration.read/manage`, `operational_event.read` | §9. Precedent: SLA definition administration reuses `client_configuration.read/manage` (`sla-definition.routes.ts`). |
| Scoped policy + precedence + snapshot precedent | `sla_definitions` (client + optional building, ACTIVE/INACTIVE, `effective_from/to`, additive specificity score, ambiguity → 409) and `applied_slas` (immutable snapshot of the selected definition) | Direct template for the retention policy authority (§5) and retention snapshot (§6). |
| Archive precedent | `documents` archive (`document.archive` permission, `archived_at/by/reason`) | Confirms the repository convention: lifecycle end-states are metadata, never row deletion. |
| Existing retention/purge behavior | — | **None found.** No retention, purge, legal-hold, or lifecycle-deletion authority exists anywhere in migrations or modules. This CR creates the first one; nothing must be migrated away from. |

---

## 2. Evidence integrity model

Smallest reusable mechanism: **additive nullable columns on `evidence_submissions`** (the single shared engine), not
a new table. A side-table would add a join and an FK for a strict 1:1 that every read path needs; columns follow the
repository's additive-migration style and keep the row the one authoritative metadata record.

| Field | Meaning |
|---|---|
| `content_sha256` | Lowercase hex SHA-256 of the exact stored bytes (`file.buffer` handed to `storage.put`). `NULL` = not hashed (legacy or metadata-contract row). Hash of content only — never of filename, metadata, or a concatenation. |
| `content_hashed_at` | Instant the hash was computed and persisted. |
| `hash_algorithm` | Constant `'SHA-256'` (CHECK-constrained). Cheap future-proofing; no algorithm negotiation is built. |
| `last_integrity_status` | `VERIFIED` / `MISMATCH` / `NOT_HASHED` / `FILE_UNAVAILABLE` — outcome of the most recent verification (§4). `NULL` = never verified. |
| `last_integrity_checked_at` | Instant of the most recent verification. |

Size and MIME snapshots already exist authoritatively (`file_size`, `mime_type` are set from the actual multer file
in the upload flow) and are NOT duplicated. The storage/object reference already exists (`file_reference`).
`captured_at`/`created_at` already exist. Explicitly rejected: blockchain, external notarization, digital
signatures, per-chunk Merkle schemes, a new storage system, client-supplied hashes.

---

## 3. Hash creation boundary

**Where:** inside the two authoritative byte-upload flows, at the `storage.put` seam — compute
`sha256(file.buffer)` and persist `content_sha256`/`content_hashed_at`/`hash_algorithm` in the SAME statement that
persists the file metadata (`UPDATE` in `POST /evidence/:id/file`, `INSERT` in `POST /mobile/evidence`). The buffer
is already fully in memory (multer memory storage, 50 MB cap), so hashing is a single synchronous
`createHash('sha256')` pass with no streaming complexity and no extra read. Implementation shape: one shared helper
(e.g. `computeEvidenceSha256(buffer)`) used by both routes so PART 01 cannot drift; alternatively a thin
`hashingEvidenceStoragePut` wrapper — decided in PART 01, but the hash MUST come from the same buffer given to
`storage.put`.

Consequences:

- Evidence uploaded through the byte flows can never reach an accepted state without integrity metadata — the hash
  is persisted atomically with the file metadata; if the UPDATE/INSERT fails, no hashed-but-unrecorded state exists.
- **Metadata-contract submissions** (REST metadata endpoint, offline sync, domain evidence modules) carry no bytes,
  so the server persists `content_sha256 = NULL`. If the file is later attached through
  `POST /evidence/:id/file`, the hash is computed then. No fabricated hash, ever.
- **Legacy/unhashed evidence:** all pre-existing rows keep `content_sha256 = NULL` and verify as `NOT_HASHED` (§4).
  No migration touches their values. Re-upload through the authoritative flow is the only way a legacy row gains a
  hash (and that is an ordinary, audited upload).
- No API accepts a caller-supplied hash, and no endpoint writes `content_sha256` outside the upload seam.

---

## 4. Integrity verification

One reusable service seam, e.g. `verifyEvidenceIntegrity(evidenceId, { actorUserId | system })`:

1. Load the row (existing Client/Building scope checks for user-initiated calls).
2. If retention state is `PURGED` → verification is not applicable (the binary was intentionally removed); reject
   with a domain error rather than reporting `FILE_UNAVAILABLE`.
3. If `content_sha256 IS NULL` → outcome `NOT_HASHED` (no storage read needed).
4. Else `storage.get(file_reference)`; absence → `FILE_UNAVAILABLE`.
5. Else recompute SHA-256 over the returned bytes; equal → `VERIFIED`, different → `MISMATCH`.

Persist `last_integrity_status` + `last_integrity_checked_at` on every outcome, and record an operational event
(§8). Verification NEVER mutates, quarantines, or deletes the evidence row, its file, its `status`, or its
retention state — `MISMATCH`/`FILE_UNAVAILABLE` are auditable facts for humans to act on. The seam is callable by
the manual API (§10) and reusable by any future scheduled sweep (explicitly out of scope in this CR — no automatic
verification domain is added to the dispatcher in v1, keeping large-file read cost out of the tick loop).

---

## 5. Retention policy model

New Client-owned configuration authority `evidence_retention_policies`, modeled directly on `sla_definitions`:

| Field | Rule |
|---|---|
| `client_id` (NOT NULL), `building_id` (NULL = whole client) | Building must belong to the Client (existing hierarchy validation). |
| `code`, `name` | `UNIQUE (client_id, code)`, same code CHECK pattern as SLA definitions. |
| `evidence_type` (NULL = any) | Applicability over the existing PHOTO/DOCUMENT/SIGNATURE vocabulary. |
| `execution_type` (NULL = any) | Applicability over the existing execution union (§1.1) — category = the vocabulary the engine already has; no new taxonomy is invented. |
| `retention_days` (INTEGER > 0) | Duration from the anchor instant (§6). Per-policy — **no global hard-coded period anywhere**. |
| `effective_from` / `effective_to` | Same semantics/CHECK as SLA definitions. |
| `status` | `ACTIVE` / `INACTIVE`. |

**Deterministic precedence** (same additive-specificity technique as `applied-sla.repository.selectApplicable`):
among ACTIVE policies of the evidence's Client that are effective at the anchor instant and whose
`building_id/evidence_type/execution_type` are each NULL or equal to the evidence's values, score
`building_id +4`, `execution_type +2`, `evidence_type +1`; highest score wins.

**Ambiguity handling:** two matching policies with the same top score is an ambiguity. Unlike SLA application
(inline in a user transaction, 409), retention application also runs in background execution, so ambiguity must
never fabricate a choice: the evidence row is left ungoverned (no snapshot), and an
`EVIDENCE_RETENTION_AMBIGUOUS` operational event records the candidate policy ids. Administrators resolve it by
deactivating/adjusting a policy. **No matching policy** is a valid state: the evidence simply remains ungoverned
(`retained_until IS NULL`) and is never purged.

---

## 6. Evidence retention snapshot

**Decision: snapshot is required.** The repository's own precedent (`applied_slas`) is explicit that later edits to
a configuration authority must not rewrite already-governed history. Editing or deactivating a policy affects only
evidence governed after the change.

Additive columns on `evidence_submissions`:

| Field | Meaning |
|---|---|
| `retained_until` | Anchor + `retention_days`. Anchor = `captured_at` when present, else `created_at` (capture time is the operational fact; creation time is the fallback the engine already guarantees). `NULL` = ungoverned. |
| `retention_policy_id` (FK) + `retention_policy_code` + `retention_days_snapshot` + `retention_applied_at` | Identity AND frozen content of the applied rule — `retained_until` stays explainable even after the source policy row is edited. |
| `retention_state` | `ACTIVE` → `RETENTION_DUE` → `PURGED` (§7). Ungoverned rows stay `ACTIVE` with `retained_until IS NULL`. |
| `retention_hold` (BOOLEAN NOT NULL DEFAULT false) + `retention_hold_reason` + `retention_hold_set_by_user_id` + `retention_hold_set_at` | Minimal legal/operational hold. No hold engine exists in the repository, so this is deliberately a flag on the row (mirroring the `documents` archive metadata convention: `archived_at/by/reason`), not a new case-management authority. A held row is never purged (§7). |

**When governance attaches:** at evidence creation (both byte-upload and metadata-contract paths) the applicable
policy is resolved and snapshotted in the same transaction. Policy activation is prospective only — activating a
policy does NOT sweep existing ungoverned evidence in this CR (that is the deferred backfill decision, §11).
Snapshots are immutable except for the hold fields and the state transitions in §7.

---

## 7. Retention execution

Lifecycle: `ACTIVE → RETENTION_DUE → PURGED`, with `retention_hold` blocking the final transition.

**Physical row deletion is unsafe** — `bast_evidence_bindings` and `utility_ocr_candidates` hold hard FKs into
`evidence_submissions`, unknown external readers hold evidence ids, and the engine's own rule is
soft-remove/append-only. Therefore **purge = binary disposal + metadata tombstone**:

- `storage.remove(file_reference)` deletes the stored bytes (idempotent no-op when already absent).
- The row survives with `retention_state = 'PURGED'` + `purged_at`; `content_sha256`, `file_size`, `mime_type`,
  `original_file_name`, and the snapshot fields are retained as the auditable tombstone. `file_reference` is kept
  (the key is opaque and non-sensitive) so the tombstone still explains what was disposed; the content endpoint
  returns the existing `EVIDENCE_FILE_NOT_FOUND`/domain error for purged rows.
- No FK ever dangles; readers see an explicit purged tombstone instead of a vanished row.

**Execution reuses the existing dispatcher — no new scheduler.** One new domain function (e.g.
`processDueEvidenceRetention(before)`) added to `processDueOperationalJobs`, returning an additive per-domain
result like every prior domain (SLA, outbound deliveries precedent):

1. `RETENTION_DUE` marking: governed `ACTIVE` rows with `retained_until <= before` →
   `retention_state = 'RETENTION_DUE'` + `EVIDENCE_RETENTION_DUE` event. Held rows are also marked due (due-ness is
   a fact; the hold blocks only purging).
2. Purge: `RETENTION_DUE` rows with `retention_hold = false` → remove binary, set `PURGED`, record
   `EVIDENCE_PURGED`. Rows with `retention_hold = true` are skipped with an `EVIDENCE_PURGE_HELD` event (emitted
   once per hold, not per tick). Failures (storage error) are isolated per row, leave the row `RETENTION_DUE`, and
   record `EVIDENCE_PURGE_FAILED` — the next tick retries naturally. Both steps are idempotent: state predicates
   make re-processing a claimed/processed row a no-op, matching the dispatcher's per-item isolation convention.

Whether the due-marking step batches with a claim (`FOR UPDATE SKIP LOCKED`, as outbound deliveries do) is a PART 04
implementation detail; single-process deployment plus state predicates already make it safe.

---

## 8. Auditability

All via the existing `recordOperationalEvent` helper (append-only, sensitive-key scrubbing), `entity_type =
'EVIDENCE_SUBMISSION'` (policy admin events use `'EVIDENCE_RETENTION_POLICY'`), with the evidence row's
`client_id` (and Building where the parent provides one, per the existing finding-event precedent):

| Event | When | Metadata (never binary, secrets, signed URLs, storage credentials, or full storage paths beyond the opaque key) |
|---|---|---|
| `EVIDENCE_INTEGRITY_HASH_RECORDED` | Hash persisted at upload | evidenceId, algorithm, fileSize. (Hash digest itself may be included — it is public integrity metadata, not a secret.) |
| `EVIDENCE_INTEGRITY_VERIFIED` | Manual/system verification → `VERIFIED` | evidenceId, outcome, checkedAt. Success events are appropriate here because verification is explicit/on-demand, not a high-frequency sweep. |
| `EVIDENCE_INTEGRITY_FAILED` | Outcome `MISMATCH` / `FILE_UNAVAILABLE` / `NOT_HASHED` | evidenceId, outcome, expected vs computed digest (MISMATCH only). |
| `EVIDENCE_RETENTION_APPLIED` | Snapshot attached | evidenceId, policyId, policyCode, retentionDays, retainedUntil. |
| `EVIDENCE_RETENTION_AMBIGUOUS` | Tied precedence at application time | evidenceId, candidate policy ids. |
| `EVIDENCE_RETENTION_DUE` | `ACTIVE → RETENTION_DUE` | evidenceId, retainedUntil, policy snapshot identity. |
| `EVIDENCE_PURGED` | Binary disposed, tombstone set | evidenceId, policy snapshot identity, purgedAt. |
| `EVIDENCE_PURGE_FAILED` | Storage disposal failed | evidenceId, safe error summary. |
| `EVIDENCE_PURGE_HELD` | Hold prevented purge | evidenceId, holdReason, holdSetBy. |
| `EVIDENCE_RETENTION_HOLD_SET` / `_CLEARED` | Hold toggled | evidenceId, reason, actor. |
| Policy CRUD | create/update/status change | policyId, changed fields (values only, no secrets). |

---

## 9. Isolation and RBAC

**Isolation:** reuse the existing seams verbatim. Evidence reads/verification/hold go through the existing
`loadEvidence` scope logic (accessible-Client set, plus Building isolation through the parent where the parent is
Building-scoped, e.g. Findings). Retention policies are Client-owned rows validated exactly like SLA definitions
(client in accessible set; `building_id` must belong to the client and be accessible). The dispatcher runs as
system without a user context, like every existing due domain.

**RBAC — no new permission is proposed.** Inspection of the seeded permission catalog (274 entries):

| Surface | Permission | Justification |
|---|---|---|
| Retention policy CRUD/read | `client_configuration.manage` / `client_configuration.read` | Exact precedent: SLA definitions (a Client-scoped, optionally Building-scoped operational configuration authority) are administered under these permissions. Retention policy is semantically the same class of object. |
| Evidence integrity read (fields on evidence payloads) | existing `evidence.read` (and existing domain evidence read permissions on their routes) | Integrity/retention metadata is evidence metadata. |
| Manual verification trigger | `evidence.manage` | It causes a storage read + persisted state + event; write-side of the evidence domain. |
| Hold set/clear | `evidence.manage` | Evidence-lifecycle action, mirrors upload/remove authority. If governance later demands a stricter separation (cf. `document.archive`), a dedicated permission can be added in a follow-up CR; not justified to invent one now. |
| Purge | none — no API | Purge is exclusively dispatcher-executed lifecycle (§7, §10). |

---

## 10. API boundary (minimum)

| Surface | Verdict |
|---|---|
| Retention policy CRUD/read — `POST/GET /clients/:clientId/evidence-retention-policies`, `GET/PATCH /evidence-retention-policies/:id` | **Justified** (policies are per-Client data; without CRUD the feature is inert). Mirrors the SLA-definition route shape and permissions. |
| Manual verification — `POST /evidence/:evidenceId/integrity-verification` → returns outcome | **Justified**: MISMATCH/FILE_UNAVAILABLE are only discoverable by reading storage; auditors need an on-demand check. |
| Integrity/retention fields added to existing evidence read payloads (`GET /evidence/:id/file` etc.) | **Justified, additive only.** |
| Hold — `POST/DELETE /evidence/:evidenceId/retention-hold` (or PATCH-style equivalent) | **Justified minimally**: without it the hold columns are unreachable and purge is unconditional. |
| Manual hash-setting API / caller-supplied SHA-256 accepted as trusted | **Rejected.** Hashing happens only server-side at the upload seam. (A future client-supplied hash could at most be an advisory cross-check, never a substitute; not in this CR.) |
| Manual purge API, bulk verification API, legacy backfill API | **Rejected in this CR** (§7, §11). |

OpenAPI (`docs/api/openapi.yaml`) is updated additively in PART 05 for exactly these surfaces and the new evidence
payload fields.

---

## 11. Historical data / backfill

- The integrity/retention columns are added nullable with **no data backfill**. Every pre-existing row remains
  `content_sha256 = NULL`, ungoverned, `retention_state = 'ACTIVE'`.
- **No automatic hash backfill**: the repository provides no proof that stored objects still match what was
  originally uploaded (objects live on a plain filesystem outside transactional control), so hashing them now would
  merely notarize the current state, not the original upload. Verification reports such rows as `NOT_HASHED` —
  honest and auditable.
- **No automatic retention backfill**: applying a new policy to years of existing evidence is a destructive
  business decision, not a migration side-effect.
- **Deferred strategy (separate future CR, not scheduled here):** (a) an explicit, administrator-triggered,
  Client-scoped "adopt current bytes" hashing job that marks rows with a distinct provenance (e.g.
  `hashed_from = 'ADOPTED'`) so adopted hashes are never presented as upload-time hashes; (b) an explicit
  administrator-confirmed retention application sweep per policy with a dry-run count. Both require product
  sign-off and are intentionally excluded from PART 01–05.

---

## 12. Risks / gaps

| # | Risk | Mitigation in this design |
|---|---|---|
| 1 | Legacy evidence without hashes | Explicit `NOT_HASHED` outcome; never fabricated; deferred opt-in adoption (§11). |
| 2 | Storage object missing | `FILE_UNAVAILABLE` outcome + audit event; no auto-mutation; purge's `storage.remove` is idempotent. |
| 3 | Object changed outside Asentra (filesystem-level tampering) | Exactly what `MISMATCH` detects; local driver has no transactional coupling, so verification is the only tamper-evidence seam. |
| 4 | Large-file hashing cost | Upload path already buffers ≤ 50 MB in memory; one SHA-256 pass is negligible vs. the existing buffering. Verification reads the whole object — acceptable on-demand; that is why no automatic verification sweep is added to the tick loop in v1. |
| 5 | Duplicate evidence (same bytes, many rows) | Hash enables detection but this CR imposes NO dedup/uniqueness — each row keeps its own object (`evidence/<uuid>`), so purging one row can never orphan another row's bytes. |
| 6 | Retention-policy ambiguity | Deterministic specificity score; ties never guessed — ungoverned + `EVIDENCE_RETENTION_AMBIGUOUS` event (§5). |
| 7 | References to purged evidence (`bast_evidence_bindings`, `utility_ocr_candidates`, external ids) | Tombstone row preserved with metadata + hash; FKs never dangle; content endpoints return explicit not-found/domain errors (§7). |
| 8 | Scheduler retries / idempotency | State-predicate transitions are naturally idempotent; per-row failure isolation matches existing dispatcher domains; failed purges stay `RETENTION_DUE` and retry next tick. |
| 9 | Purge failure (storage error) | Row remains `RETENTION_DUE`, `EVIDENCE_PURGE_FAILED` event; no partial tombstone (state set only after successful removal). |
| 10 | Legal/operational hold | Minimal row-level hold blocks purge and is fully audited; deliberately not a case-management engine (no existing authority to anchor one). |
| 11 | Multi-tenant isolation | All new reads/writes reuse `contextAccessService` scope checks; policies are Client-owned with validated Building linkage; events carry `client_id` and flow through the already-scoped operational-events API. |
| 12 | Hash-at-upload vs. metadata-contract gap | Metadata-only submissions legitimately stay `NOT_HASHED` until bytes pass the authoritative upload seam; documented as engine behavior, not silently "fixed". |
| 13 | Constraint-widening regression precedent | Migration `0281` shows the execution-union CHECK was once accidentally narrowed; retention `execution_type` applicability must reference the same single vocabulary and PART 03 must not add another parallel CHECK to drift. |
| 14 | Clock/timezone | `retained_until` computed and compared in UTC (`TIMESTAMPTZ`), consistent with SLA-01's 24×7 decision. |

---

## 13. PART breakdown

Repository inspection confirms the proposed five-PART decomposition is already minimal and safe; no re-cutting is
needed. Each PART is independently shippable and additive.

| PART | Scope | Contents |
|---|---|---|
| **PART 01 — Evidence Integrity Metadata + Hash Foundation** | Migration + upload seam | Additive nullable integrity columns on `evidence_submissions` (`content_sha256`, `content_hashed_at`, `hash_algorithm`, `last_integrity_status`, `last_integrity_checked_at`); shared SHA-256 helper; hash persisted atomically in BOTH byte-upload flows; `EVIDENCE_INTEGRITY_HASH_RECORDED` event; tests. No verification, no retention. |
| **PART 02 — Integrity Verification + Audit** | Service seam + one route | `verifyEvidenceIntegrity` with the four outcomes; persisted last-status/time; `POST /evidence/:evidenceId/integrity-verification` (`evidence.manage`); verification events; tests incl. tamper/missing-file cases. |
| **PART 03 — Retention Policy + Deterministic Application** | Config authority + snapshot | `evidence_retention_policies` migration; CRUD/read routes under `client_configuration.*`; specificity resolution + ambiguity event; snapshot columns on `evidence_submissions`; snapshot-at-creation wiring in all submission paths; hold set/clear surface + events; tests. No execution yet. |
| **PART 04 — Retention Lifecycle + Due Execution** | Dispatcher domain | `ACTIVE → RETENTION_DUE → PURGED` transitions; `processDueEvidenceRetention` added to `processDueOperationalJobs` (additive result key); binary disposal + tombstone; hold skip; failure isolation + retry; due/purged/failed/held events; tests. |
| **PART 05 — Read/API/OpenAPI + Governance Closure** | Contract closure | Integrity/retention fields on evidence read payloads; OpenAPI additions for all new/changed surfaces; purged-tombstone read behavior documented; governance closure notes (incl. deferred backfill CR pointer); contract tests. |

---

## 14. Report

| Item | Value |
|---|---|
| Current branch | `arena/01a02d64-asentra-backend` |
| Existing evidence/storage authorities found | Single shared engine `evidence_requirements`/`evidence_submissions` with 9-kind execution union; single `EvidenceStorage` abstraction (local driver) used only by the two byte-upload flows; five domain evidence modules all writing the shared tables; metadata-only `file_reference` authorities (documents, tenant/vendor documents, visitor photos, BAST/handover/supporting) explicitly out of v1 scope; FKs into evidence from BAST bindings and utility OCR candidates; no existing retention/purge/hold authority (§1) |
| Proposed integrity model | Additive nullable columns on `evidence_submissions`: server-computed SHA-256 of stored bytes at the authoritative upload seam, hashed-at, algorithm constant, last verification status/time; no fabricated hashes; no client-supplied hashes (§2–§3) |
| Proposed retention model | `evidence_retention_policies` (Client + optional Building, evidence/execution-type applicability, `retention_days`, effective window, ACTIVE/INACTIVE, additive-specificity precedence, ambiguity → ungoverned + event) with immutable per-evidence snapshot (`retained_until`, policy identity + frozen days, state, minimal hold) (§5–§6) |
| Scheduler/reuse decision | Reuse the existing due-job dispatcher/scheduler; one additive retention domain; NO new scheduler (§7) |
| RBAC/isolation decision | No new permissions: `client_configuration.read/manage` for policy administration (SLA-definition precedent), `evidence.read`/`evidence.manage` for read/verify/hold; existing `contextAccessService` Client/Building isolation reused everywhere (§9) |
| Historical evidence decision | No silent/automatic backfill of hashes or retention; legacy rows report `NOT_HASHED` and stay ungoverned; explicit administrator-driven adoption strategy deferred to a separate future CR (§3, §11) |
| Proposed PARTs | PART 01–05 as specified, confirmed minimal by inspection (§13) |
| Risks/gaps | 14 recorded concrete risks with mitigations (§12) |
| Files changed | `docs/CR-BE-DOC-CONTROL-01_START_GOVERNANCE.md` (this document only) |
| Commit hash | recorded in the delivery report after commit |
| Push status | recorded in the delivery report after push |
| Worktree status | recorded in the delivery report after push |
| PART 01 readiness | **READY** — target tables/flows identified (`evidence_submissions`, `evidence-file.routes.ts`, `mobile-evidence.routes.ts`, `storage.put` seam), migration slot after `0302`, no blocking unknowns |

---

## 15. Implementation notes

### PART 01 — Evidence Integrity Metadata + Hash Foundation (commit `1e935aa`)

- Migration `0303_add_evidence_integrity_metadata`: additive nullable columns on `evidence_submissions`
  (`content_sha256`, `content_hashed_at`, `hash_algorithm`, `last_integrity_status`, `last_integrity_checked_at`)
  with format/consistency/vocabulary CHECK constraints. No backfill; the 0281 execution-union constraint untouched.
- Shared helper `src/modules/evidence/evidence-integrity.ts` (`computeEvidenceSha256`, `EVIDENCE_HASH_ALGORITHM`)
  used by BOTH authoritative byte-upload flows; hash persisted atomically with file metadata;
  `EVIDENCE_INTEGRITY_HASH_RECORDED` operational event on both paths. Legacy rows remain `NULL`/unhashed.
- Focused tests: `tests/evidence-integrity-hash.test.ts` (6/6) + affected upload suites (20/20).

### PART 02 — Integrity Verification + Audit (commit `d5cf54b`)

- Verification seam `src/modules/evidence/evidence-integrity-verification.service.ts`
  (`verifyEvidenceIntegrity`): reads the stored binary via the single storage abstraction, recomputes SHA-256 with
  the PART 01 helper, and resolves `VERIFIED` / `MISMATCH` / `NOT_HASHED` (no storage read) / `FILE_UNAVAILABLE`
  (missing object, non-storage reference, or storage error). Every outcome persists
  `last_integrity_status` + `last_integrity_checked_at`; nothing else on the row, the stored object, or the
  evidence status is ever mutated — MISMATCH/FILE_UNAVAILABLE remain auditable facts only.
- Audit: `EVIDENCE_INTEGRITY_VERIFIED` on success, `EVIDENCE_INTEGRITY_FAILED` on any non-VERIFIED outcome, via
  `recordOperationalEvent` (`entity_type = 'EVIDENCE_SUBMISSION'`); metadata carries outcome + expected/computed
  digests and the opaque check timestamp only — no binary, secrets, or storage internals.
- API: `POST /evidence/:evidenceId/integrity-verification` on the existing evidence file router, guarded by
  `evidence.manage` and the exact existing `loadEvidence` Client/Building isolation seam (§9, §10). The caller
  supplies only the evidence id — no client-supplied hash is accepted anywhere.
- The seam is reusable for any future governed sweep; no scheduler/dispatcher work was added (deferred by design).
- Focused tests: `tests/evidence-integrity-verification.test.ts` (6/6) + affected evidence suites (26/26).
- §4 note: the purged-evidence guard ("PURGED → verification not applicable") activates in PART 04 when the
  retention state exists; until then all rows are verifiable, which is consistent because no row can be purged yet.

### PART 03 — Retention Policy + Deterministic Application (commit `f52f010`)

- Migration `0304_create_evidence_retention_policies`:
  - `evidence_retention_policies` — Client-owned + optional Building scope, `code`/`name`, applicability over the
    EXISTING evidence/execution vocabularies (execution CHECK mirrors the 0281 union; must be widened in lockstep),
    `retention_days > 0` (no global hard-coded period), effective window, ACTIVE/INACTIVE — the exact
    `sla_definitions` template.
  - Additive snapshot columns on `evidence_submissions`: `retention_policy_id/-code`, `retention_days_snapshot`,
    `retention_applied_at`, `retained_until`, `retention_state` (`ACTIVE`/`RETENTION_DUE`/`PURGED`,
    default `ACTIVE`), and the minimal audited hold (`retention_hold` + reason/set-by/set-at). CHECK constraints
    enforce all-or-nothing snapshots, the state vocabulary, "non-ACTIVE state requires governance", and hold
    consistency. Partial `evidence_submissions_retention_due_idx` prepared for the PART 04 due scan. NO backfill.
- Module `src/modules/evidence-retention-policies/`:
  - Policy CRUD/read under the existing `client_configuration.read/manage` permissions (SLA-definition route shape:
    `POST/GET /clients/:clientId/evidence-retention-policies`, `GET/PATCH /evidence-retention-policies/:id`),
    with Client existence/access + ACTIVE check, Building-to-Client hierarchy validation, duplicate code → 409,
    and `EVIDENCE_RETENTION_POLICY_CREATED/UPDATED` audit events. No new permission.
  - `applyRetentionToEvidence` — the deterministic application seam invoked by ALL seven submission paths
    (metadata contract, both byte uploads, WO/housekeeping/permit/vendor-work/utility domain services) right after
    row creation. Specificity building +4, execution_type +2, evidence_type +1; highest wins; anchor =
    `captured_at ?? created_at`; `retained_until = anchor + retention_days`; snapshot written once
    (`WHERE retention_policy_id IS NULL` — immutable, never re-applied); `EVIDENCE_RETENTION_APPLIED` event.
    Tie at the top score → NO application + `EVIDENCE_RETENTION_AMBIGUOUS` event with candidate ids. No match →
    ungoverned (valid state, never purged). Building scope is derived from the evidence PARENT (WO/vendor
    work/reading/permit/finding chain); FORM_INSTANCE/CHECKLIST_EXECUTION parents carry no building and match
    client-wide policies only. Application is prospective — activating a policy never sweeps existing evidence.
- Hold surface: `POST/DELETE /evidence/:evidenceId/retention-hold` on the evidence file router (`evidence.manage`,
  same `loadEvidence` isolation), reason required, purged rows not holdable, fully audited
  (`EVIDENCE_RETENTION_HOLD_SET/_CLEARED`).
- NOT implemented here by design: purge execution, `RETENTION_DUE`/`PURGED` transitions, scheduler integration,
  any legacy adoption/backfill (PART 04+/deferred CR).
- Focused tests: `tests/evidence-retention-policies.test.ts` (9/9) + directly affected evidence suites
  (integrity/upload 32/32; five domain evidence suites 81/81).

### PART 04 — Retention Lifecycle + Due Execution (commit `b7aa676`)

- Migration `0305_add_evidence_purged_at`: additive `purged_at` timestamp with a consistency CHECK
  (`PURGED ⇔ purged_at IS NOT NULL`). No row deletion anywhere.
- Execution seam `src/modules/evidence-retention-policies/evidence-retention-execution.service.ts`
  (`processDueEvidenceRetention`):
  - Due marking: governed `ACTIVE` rows with elapsed `retained_until` → `RETENTION_DUE` via a bounded
    (`DUE_ITEM_RETRIEVAL_LIMIT`) `FOR UPDATE SKIP LOCKED` + state-predicated UPDATE; `EVIDENCE_RETENTION_DUE`
    event per row. Held rows are also marked due (due-ness is a fact; the hold blocks only purging).
  - Purge: binary disposed FIRST through the single existing storage abstraction (`storage.remove` is an
    idempotent no-op when absent), then the tombstone is set by a guarded UPDATE
    (`WHERE retention_state='RETENTION_DUE' AND retention_hold=false`) — the row survives with the retention
    snapshot, hash, size, MIME, original file name and opaque key retained; `EVIDENCE_PURGED` event. Existing FKs
    (`bast_evidence_bindings`, `utility_meter_ocr_candidates`) never dangle (proven by test join through the real
    FK).
  - Hold: skipped with `EVIDENCE_PURGE_HELD` recorded once per hold (deduplicated against events since
    `retention_hold_set_at`), never per tick; clearing the hold releases the next pass.
  - Failure: per-row isolation; storage errors leave the row `RETENTION_DUE` with NO partial tombstone,
    record `EVIDENCE_PURGE_FAILED`, and the next tick retries naturally (proven with an injected failing storage).
  - Idempotency: state predicates make a second pass mark/purge nothing; a crash between removal and the state
    UPDATE is healed by the retry.
- Dispatcher integration: one additive `evidenceRetention` domain
  (`dueMarked`/`purged`/`held`/`failures`) in `processDueOperationalJobs`, batch-throw isolated like every prior
  domain — NO new scheduler; the CR-BE-STAB-01 scheduler cadence executes it. The existing dispatcher key-set
  contract test was extended additively.
- Purged-tombstone guards activated (deferred from PART 02 §15): integrity verification of a `PURGED` row → 400
  (not `FILE_UNAVAILABLE`), re-upload to a purged tombstone → 400, hold on purged → 400 (from PART 03), content
  download → existing not-found behavior. Tombstone metadata stays readable; BE-07 `status` untouched.
- Focused tests: `tests/evidence-retention-execution.test.ts` (6/6) + dispatcher/scheduler suites (30/30) +
  evidence suites (41/41).

### PART 05 — Read API + OpenAPI + Governance Closure (commit `53fa60e`)

- Read model: the shared BE-07 `toPublicEvidence` mapper (single mapper — the former local duplicate in
  `evidence-file.routes.ts` was removed to prevent drift) now exposes the additive governance fields on every
  evidence metadata read (upload responses, `GET /evidence/:id/file`, `GET /evidence/:id`, finding evidence reads):
  `contentSha256`, `contentHashedAt`, `hashAlgorithm`, `lastIntegrityStatus`, `lastIntegrityCheckedAt`,
  `retentionPolicyId/-Code`, `retentionDaysSnapshot`, `retentionAppliedAt`, `retainedUntil`, `retentionState`,
  `retentionHold`, `retentionHoldReason`, `purgedAt`. Legacy/ungoverned rows read null defaults with
  `retentionState: ACTIVE` / `retentionHold: false` — purely additive, no existing field changed.
- OpenAPI (`docs/api/openapi.yaml`), all additive:
  - `EvidenceFileMetadata` extended with the fields above, including the PURGED tombstone semantics
    (metadata stays readable; content 404; re-upload/verification/hold 400) and the server-side-hash-only rule.
  - New schemas `EvidenceIntegrityVerification`, `EvidenceRetentionPolicy`,
    `EvidenceRetentionPolicyCreateRequest/UpdateRequest`.
  - New paths documented and runtime-aligned: `POST /evidence/{evidenceId}/integrity-verification` (no request
    body — no trusted-hash input), `POST/DELETE /evidence/{evidenceId}/retention-hold`,
    `POST/GET /clients/{clientId}/evidence-retention-policies`, `GET/PATCH /evidence-retention-policies/{id}`.
  - Existing upload/content path descriptions annotated with hash-at-upload and tombstone behavior.
- No behavior change: retention execution, purge, policy selection, hashing and verification semantics are
  untouched (contract/read/documentation layer only).
- Focused tests: `tests/evidence-governance-read-contract.test.ts` (5/5 — governed read fields, legacy null
  defaults, tombstone reads, OpenAPI field/schema/path alignment incl. no-request-body assertion, live-router
  probes for every documented new operation) + directly affected evidence/OpenAPI suites.
- Pre-existing, unrelated debt (NOT introduced here; reproduced identically on the base commit): the
  `mobile-openapi-completeness` suite's `operationId` subtest fails on earlier-CR SLA operations
  (`/clients/{clientId}/sla-definitions` etc.). All CR-BE-DOC-CONTROL-01 operations carry `operationId`s and pass
  the router-alignment checks. Left to the existing CI-debt governance track (CR-BE-CI-01), per the no-KI-003 rule.

## 16. Governance closure

- PART 01–05 are implemented, validated and pushed; the CR is complete pending FINAL REVIEW.
- **Deferred legacy backfill boundary (unchanged from §11, reaffirmed at closure):** no hash or retention backfill
  of historical evidence was performed anywhere in this CR. Legacy rows verify as `NOT_HASHED` and remain
  ungoverned/never purged. Any future adoption — (a) administrator-triggered, Client-scoped "adopt current bytes"
  hashing with distinct provenance marking, and (b) explicit administrator-confirmed retention application sweeps
  with dry-run counts — requires a separate CR with product sign-off. Nothing in the shipped runtime performs or
  schedules such adoption.
- Boundary reaffirmations: one evidence engine, one storage abstraction, one scheduler; no blockchain/signatures/
  notarization; no manual hash-setting API; no client-supplied trusted hashes; no purge API (dispatcher-only
  lifecycle); no new permissions; evidence rows are never deleted.
