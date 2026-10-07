import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';

/**
 * R08 PART 01B — Operational Detail Evidence child projection (types).
 *
 * READ MODEL ONLY. Backend-owned, read-only, internal (no HTTP endpoint).
 *
 * GRAIN
 *   ONE ROW per `evidence_submissions.id`.
 *   PARENT KEY = (engine, executionId) where engine is the R07 vocabulary
 *   CHECKLIST_EXECUTION | FORM_INSTANCE and executionId is the authoritative
 *   `checklist_executions.id` / `form_instances.id`.
 *
 *   There is NO detail attribution: `evidence_submissions` stores no
 *   checklist_item_id, version_field_id, form_field_id, response_id or
 *   occurrence_id (verified across every migration touching the table), so
 *   R08 PART 00 §13 classifies item/field/occurrence attribution as UNSAFE.
 *   `evidenceRequirementId` is lineage metadata ONLY and must never be used to
 *   infer an item/field/occurrence (R08 PART 01A §12).
 *
 * HISTORICAL / LINEAGE VISIBILITY (R08 PART 01A §1 — decision A)
 *   The DEFAULT read applies NO status predicate and NO retentionState
 *   predicate, so withdrawn and disposed evidence remain visible as lineage:
 *     status         = ACTIVE | REMOVED          (REMOVED is terminal; no restore path)
 *     retentionState = ACTIVE | RETENTION_DUE | PURGED
 *                      (PURGED keeps a metadata tombstone; the row is never deleted)
 *   These are TWO INDEPENDENT stored dimensions — the database has no constraint
 *   linking them, the retention due-scan ignores `status`, and the purge/remove
 *   writes each touch only their own dimension. Never infer one from the other.
 *   Both are narrowed only by OPTIONAL LITERAL filters. No derived lifecycle mode
 *   (history / includeRemoved / available / valid / verified / compliant /
 *   current) exists or may be added.
 *
 * R04 RECONCILIATION RULE (R08 PART 01A §14) — intentional, do not "fix"
 *   R04 `checklist-execution-summary.evidenceCount` is an OPERATIONAL count:
 *   COUNT(*) over evidence_submissions WHERE execution_type = engine AND
 *   execution_id = execution AND status = 'ACTIVE'.
 *   This child DEFAULTS TO ALL historical rows. Therefore this child's row count
 *   MAY BE GREATER THAN R04's evidenceCount for the same execution, and the two
 *   are NOT required to be equal. Only when this child is explicitly filtered to
 *   status = 'ACTIVE' may its population be compared with the same
 *   execution-level ACTIVE evidence authority, subject to this child's own
 *   filters and scope. R04 must never be changed to make counts match.
 *
 * INTEGRITY SEMANTICS (R08 PART 01A §5, §11)
 *   Stored integrity facts are projected VERBATIM. `contentSha256` NULL stays
 *   NULL and means "not hashed / hash not available" — NEVER "verified". Hash
 *   coverage is partial by design (migration 0303 performs no backfill), so no
 *   dataset-wide integrity claim is expressible. `lastIntegrityStatus` is a
 *   MUTABLE CURRENT result and is only meaningful together with
 *   `lastIntegrityCheckedAt`; on a PURGED row it may be a stale pre-purge value
 *   (integrity verification is refused once purged) and is never reinterpreted.
 *   No derived integrityVerified / isValid / isTamperProof / isAvailable /
 *   isCompliant field exists or may be added.
 *
 * ATTRIBUTION (R08 PART 01A §19)
 *   `submittedByUserId` means SUBMITTED BY, only. It is never an executor: not
 *   Executed By / Performed By / Completed By / Captured By / Actual Executor.
 *   `capturedAt` is a nullable device timestamp, not an actor and not a stable
 *   lineage sequence. No display-name joins in this PART.
 *
 * EXCLUDED BY CONTRACT (R08 PART 01A §10, §15)
 *   fileReference (backend storage key), any storage/filesystem path, bucket,
 *   token, signed URL, and file bytes are NEVER exposed: reporting consumes
 *   metadata only and never invokes the storage abstraction. Deferred hold
 *   metadata (retentionHoldReason / retentionHoldSetByUserId /
 *   retentionHoldSetAt) and the LIVE retention_policy_id pointer are also out of
 *   this PART; the frozen retention snapshot is the historical authority.
 */

/**
 * `evidence_submissions.status` — authoritative CHECK vocabulary
 * (`evidence_submission_status`, migration 0073). Literal values only.
 */
export const EVIDENCE_CHILD_STATUSES = ['ACTIVE', 'REMOVED'] as const;
export type EvidenceChildStatus = (typeof EVIDENCE_CHILD_STATUSES)[number];

export function isEvidenceChildStatus(value: unknown): value is EvidenceChildStatus {
  return (
    typeof value === 'string' &&
    (EVIDENCE_CHILD_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * `evidence_submissions.retention_state` — authoritative CHECK vocabulary
 * (`evidence_retention_state_check`, migration 0304). Literal values only.
 * Independent of `status`; note both dimensions use the literal 'ACTIVE'.
 */
export const EVIDENCE_CHILD_RETENTION_STATES = [
  'ACTIVE',
  'RETENTION_DUE',
  'PURGED',
] as const;
export type EvidenceChildRetentionState =
  (typeof EVIDENCE_CHILD_RETENTION_STATES)[number];

export function isEvidenceChildRetentionState(
  value: unknown,
): value is EvidenceChildRetentionState {
  return (
    typeof value === 'string' &&
    (EVIDENCE_CHILD_RETENTION_STATES as readonly string[]).includes(value)
  );
}

/** `evidence_submissions.last_integrity_status` CHECK vocabulary (migration 0303). */
export type EvidenceChildIntegrityStatus =
  | 'VERIFIED'
  | 'MISMATCH'
  | 'NOT_HASHED'
  | 'FILE_UNAVAILABLE';

/** One evidence lineage row. Every field is copied verbatim; NULLs preserved. */
export type PublicOperationalDetailEvidenceRow = {
  /* Identity + parent key */
  evidenceId: string; // evidence_submissions.id — the row grain and only locator
  engine: OperationalDetailEngine; // = execution_type, R07 vocabulary reused
  executionId: string; // = execution_id, authoritative parent execution/instance
  clientId: string; // client-consistency anchor; a scope FACT, never a caller filter

  /* File metadata — never the file */
  evidenceType: string; // PHOTO | DOCUMENT | SIGNATURE (verbatim)
  mimeType: string;
  originalFileName: string;
  fileSize: number;

  /* Time + actor */
  capturedAt: string | null; // nullable device time — a TIME, never an actor
  createdAt: string; // submission created_at (NOT NULL) — the lineage sequence
  updatedAt: string | null; // MIXED: moves on status, retention AND integrity writes
  submittedByUserId: string | null; // SUBMITTED BY only — never an executor

  /* Lifecycle — two independent stored dimensions, verbatim */
  status: EvidenceChildStatus; // ACTIVE | REMOVED
  retentionState: EvidenceChildRetentionState; // ACTIVE | RETENTION_DUE | PURGED

  /* Lineage */
  evidenceRequirementId: string | null; // lineage ONLY — never detail attribution

  /* Integrity (migration 0303) — verbatim, no derivation */
  contentSha256: string | null; // NULL = NOT HASHED (never "verified")
  contentHashedAt: string | null;
  hashAlgorithm: string | null; // 'SHA-256' or NULL
  lastIntegrityStatus: EvidenceChildIntegrityStatus | null; // NULL = never verified
  lastIntegrityCheckedAt: string | null; // mandatory companion to the above

  /* Retention snapshot + state (migrations 0304/0305) — verbatim */
  retentionPolicyCode: string | null; // FROZEN snapshot — later policy edits never rewrite it
  retentionDaysSnapshot: number | null; // FROZEN snapshot
  retentionAppliedAt: string | null;
  retainedUntil: string | null; // NULL = UNGOVERNED (no match or ambiguous tie)
  retentionHold: boolean; // explains a RETENTION_DUE row that was never purged
  purgedAt: string | null; // CHECK-pinned ⟺ retentionState = 'PURGED'
};

/**
 * Filters. `engine` is REQUIRED (R07 PART 02C parity — an explicit engine keeps
 * pagination honest and selects the single authoritative parent table).
 *
 * dateFrom/dateTo apply to the PARENT EXECUTION's created_at using R07/R04
 * half-open [start, end) semantics, so this child's population is exactly
 * "evidence belonging to executions R07 would return for that range". There is
 * deliberately NO competing evidence-created_at population filter.
 */
export type OperationalDetailEvidenceFilters = {
  engine: OperationalDetailEngine;
  buildingId?: string;
  executionId?: string; // narrowing only — never bypasses authorized building scope
  templateId?: string; // owning template (checklist_templates.id | form_templates.id)
  dateFrom?: string;
  dateTo?: string;
  status?: EvidenceChildStatus; // optional LITERAL filter
  retentionState?: EvidenceChildRetentionState; // optional LITERAL filter
};

export type OperationalDetailEvidencePagination = {
  limit?: number;
  offset?: number;
};

export type OperationalDetailEvidenceQuery = OperationalDetailEvidenceFilters &
  OperationalDetailEvidencePagination;

/** Envelope mirrors the closed R07 read-model contract. */
export type PublicOperationalDetailEvidence = {
  engine: OperationalDetailEngine;
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  rows: PublicOperationalDetailEvidenceRow[];
};
