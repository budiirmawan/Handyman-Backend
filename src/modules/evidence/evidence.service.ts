import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { permissionDeniedError } from '../auth/auth.errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { permissionService } from '../permissions';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import { resolveBoundFormInstanceBuilding } from '../form-instances';
import { dailyCleaningRepository } from '../daily-cleaning';

/**
 * BE-07 evidence submission logic extracted as the single shared service used
 * by BOTH the REST submission endpoint and the BE-25G offline sync batch —
 * the sync contract never re-implements business rules.
 */

const EVIDENCE_TYPES = ['PHOTO', 'DOCUMENT', 'SIGNATURE'] as const;
const EXECUTION_TYPES = [
  'FORM_INSTANCE',
  'CHECKLIST_EXECUTION',
  'FINDING',
  'FINDING_REWORK',
  'FINDING_VERIFICATION',
  /**
   * CR-BE-RN12-METER-FIELD-01 PART 02 — the BE-18F Reading Evidence parent.
   *
   * This is an ADMISSION, not an invention. BE-18F has always written
   * `evidence_submissions` rows with `execution_type = 'UTILITY_METER_READING'`
   * and `execution_id = utility_meter_readings.id`, and migration 0281 restored
   * exactly that value to the `evidence_submission_execution` CHECK constraint
   * ("OCR depends on the already-published Utility PHOTO evidence path"). What
   * was missing is the APPLICATION-level union this shared engine validates and
   * resolves against — so the parent kind existed in the database and in BE-18F
   * but was unknown to the generic resolver.
   *
   * Consequence of the gap, and why closing it matters: any BE-18F reading
   * evidence row read through the generic/mobile evidence contract fell into
   * `loadEvidenceExecution`'s trailing branch (the FINDING_VERIFICATION `reviews`
   * join) or, on the mobile side, into the FORM_INSTANCE fallback — i.e. it
   * resolved as a broken parent instead of as the reading it belongs to. Every
   * existing kind above is preserved unchanged; no type is removed, reordered or
   * reinterpreted, and no second evidence model is introduced.
   */
  'UTILITY_METER_READING',
  /**
   * CR-BE-RN13-CLEANING-EVIDENCE-MOBILE-01 — Daily Cleaning task parent.
   */
  'DAILY_CLEANING',
] as const;

export type EvidenceExecutionType = (typeof EXECUTION_TYPES)[number];

/**
 * MOB-C06 PART 01A — the EXACT evidence-upload permission per
 * executionType, shared by the generic metadata endpoint
 * (`POST /evidence`) and the offline EVIDENCE_SUBMISSION sync kind so a
 * FINDING_VERIFICATION parent always requires `finding.review` — the same
 * authority as the dedicated Finding verification evidence route and the
 * MOB-C06 PART 01 mobile upload — while every other kind keeps
 * `evidence.manage`. `finding.review` ALONE is sufficient for
 * FINDING_VERIFICATION (no evidence.manage is also required); no
 * reviewer-identity rule is added (generic parity: permission + scope +
 * PENDING review).
 */
export const EVIDENCE_UPLOAD_PERMISSION: Record<EvidenceExecutionType, string> = {
  FORM_INSTANCE: 'evidence.manage',
  CHECKLIST_EXECUTION: 'evidence.manage',
  FINDING: 'evidence.manage',
  FINDING_REWORK: 'evidence.manage',
  FINDING_VERIFICATION: 'finding.review',
  /**
   * CR-BE-RN12-METER-FIELD-01 PART 02 — dedicated-route parity with BE-18F,
   * whose own reading-evidence write (`POST /utility/meter-readings/:id/evidence`)
   * requires `utility_meter.manage`. The same reasoning that made
   * FINDING_VERIFICATION adopt `finding.review` applies: the generic door must
   * not be a cheaper way in than the door that owns the parent.
   *
   * This is deliberately NOT `utility_meter.field.evidence`. That code is the
   * FIELD authority, and the field authority is only meaningful together with
   * `assertUtilityMeterReadingFieldActor` (assignment to the reading's generated
   * task). This shared service — and therefore also the BE-25G offline
   * EVIDENCE_SUBMISSION batch, which derives its required permission from
   * exactly this map — has no place to run that seam. Mapping the field code
   * here would have turned the generic/offline door into a way to write reading
   * evidence WITHOUT proving field authority. Requiring `utility_meter.manage`
   * keeps the two doors honest: management authority on the generic door, field
   * authority (permission + seam) on the mobile/field doors.
   */
  UTILITY_METER_READING: 'utility_meter.manage',
  DAILY_CLEANING: 'housekeeping_evidence.manage',
};

/** Whether the value is a known evidence execution/parent kind. */
export function isEvidenceExecutionType(
  value: unknown,
): value is EvidenceExecutionType {
  return (
    typeof value === 'string' &&
    (EXECUTION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The exact upload permission for a KNOWN executionType; null for an
 * unknown one (the shared service validation then fails closed with no
 * mutation).
 */
export function evidenceUploadPermissionFor(executionType: unknown): string | null {
  return isEvidenceExecutionType(executionType)
    ? EVIDENCE_UPLOAD_PERMISSION[executionType]
    : null;
}

/**
 * Asserts the exact per-executionType upload permission for the user
 * (same error semantics as `requirePermission`). Callers must validate the
 * executionType first; this never authorizes an unknown kind.
 */
export async function assertEvidenceUploadPermission(
  userId: string,
  executionType: EvidenceExecutionType,
): Promise<void> {
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  if (!permissions.includes(EVIDENCE_UPLOAD_PERMISSION[executionType])) {
    throw permissionDeniedError();
  }
}

export type EvidenceSubmissionRow = Record<string, unknown>;

export function toPublicEvidence(row: Record<string, unknown>) {
  return {
    id: row.id,
    clientId: row.client_id,
    evidenceRequirementId: row.evidence_requirement_id,
    executionType: row.execution_type,
    executionId: row.execution_id,
    evidenceType: row.evidence_type,
    fileReference: row.file_reference,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    capturedAt: row.captured_at,
    submittedByUserId: row.submitted_by_user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // CR-BE-DOC-CONTROL-01 PART 05 — additive integrity metadata (PART 01/02).
    contentSha256: row.content_sha256 ?? null,
    contentHashedAt: row.content_hashed_at ?? null,
    hashAlgorithm: row.hash_algorithm ?? null,
    lastIntegrityStatus: row.last_integrity_status ?? null,
    lastIntegrityCheckedAt: row.last_integrity_checked_at ?? null,
    // CR-BE-DOC-CONTROL-01 PART 05 — additive retention snapshot/state (PART 03/04).
    retentionPolicyId: row.retention_policy_id ?? null,
    retentionPolicyCode: row.retention_policy_code ?? null,
    retentionDaysSnapshot: row.retention_days_snapshot ?? null,
    retentionAppliedAt: row.retention_applied_at ?? null,
    retainedUntil: row.retained_until ?? null,
    retentionState: row.retention_state ?? 'ACTIVE',
    retentionHold: row.retention_hold ?? false,
    retentionHoldReason: row.retention_hold_reason ?? null,
    purgedAt: row.purged_at ?? null,
  };
}

/** Loads an execution and enforces the BE-02G accessible-Client scope. */
export async function loadEvidenceExecution(
  executionType: string,
  executionId: string,
  userId: string,
): Promise<{ client_id: string; status: string }> {
  let result;
  if (executionType === 'FORM_INSTANCE') {
    // MOB-C07 PART 05 — unbound instances stay Client-scoped; task-bound
    // instances derive Building from generated_task_id (never from input).
    result = await getPool().query<{
      client_id: string;
      status: string;
      form_template_version_id: string;
      generated_task_id: string | null;
      building_id?: string | null;
    }>(
      `SELECT client_id, status, form_template_version_id, generated_task_id
         FROM form_instances WHERE id = $1`,
      [executionId],
    );
  } else if (executionType === 'CHECKLIST_EXECUTION') {
    result = await getPool().query<{ client_id: string; status: string; building_id?: string }>(
      `SELECT client_id, status, NULL::uuid AS building_id FROM checklist_executions WHERE id = $1`,
      [executionId],
    );
  } else if (executionType === 'FINDING') {
    result = await getPool().query<{ client_id: string; status: string; building_id: string }>(
      `SELECT client_id, status, building_id FROM findings WHERE id = $1`, [executionId]);
  } else if (executionType === 'FINDING_REWORK') {
    result = await getPool().query<{ client_id: string; status: string; building_id: string }>(
      `SELECT f.client_id, r.status, f.building_id
       FROM finding_rework_cycles r JOIN findings f ON f.id = r.finding_id WHERE r.id = $1`, [executionId]);
  } else if (executionType === 'UTILITY_METER_READING') {
    /**
     * CR-BE-RN12-METER-FIELD-01 PART 02 — the BE-18F Reading Evidence parent.
     *
     * Placed BEFORE the trailing branch on purpose: that branch is the
     * FINDING_VERIFICATION `reviews` join, so without an explicit case a reading
     * id would have been looked up as a review id and reported as a
     * non-existent execution.
     *
     * `status` is projected as the constant `'ACTIVE'` because BE-18E readings
     * have NO status column at all — they are append-only and immutable
     * (`utilityMeterReadingImmutableError`, and no UPDATE/DELETE input exists in
     * the module). The loader's contract needs a status so callers can apply the
     * generic terminal-parent gate (`COMPLETED` / `CANCELLED` are refused), and
     * the faithful projection of "a persisted reading is never terminal" is a
     * constant non-terminal value. This reproduces BE-18F's own rule rather than
     * inventing one: BE-18F imposes no state gate on reading evidence, because a
     * reading that was genuinely taken must keep being able to receive its photo
     * no matter what happened downstream. Nothing here mutates the reading.
     *
     * `building_id` is returned so the BE-02G Building check below applies to
     * reading evidence exactly as it does to Finding evidence. Client scope is
     * the reading's own `client_id`, and the reading↔meter Building agreement is
     * BE-18F's `resolveReading` concern, asserted on its own routes.
     */
    result = await getPool().query<{ client_id: string; status: string; building_id: string }>(
      `SELECT client_id, 'ACTIVE'::text AS status, building_id
       FROM utility_meter_readings WHERE id = $1`, [executionId]);
  } else if (executionType === 'DAILY_CLEANING') {
    const task = await dailyCleaningRepository.findById(executionId);
    if (!task) {
      throw AppError.notFound('Daily cleaning task not found.');
    }
    result = {
      rows: [
        {
          client_id: task.client_id,
          status: task.status,
          building_id: task.building_id,
        },
      ],
    };
  } else {
    result = await getPool().query<{ client_id: string; status: string; building_id: string }>(
      `SELECT f.client_id, r.status, f.building_id
       FROM reviews r JOIN findings f ON f.id = r.target_id
       WHERE r.id = $1 AND r.target_type = 'FINDING'`, [executionId]);
  }
  const row = result.rows[0];
  if (!row) {
    throw AppError.badRequest('Execution does not exist.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) throw buildingAccessDeniedError();
  if (executionType === 'FORM_INSTANCE') {
    row.building_id = await resolveBoundFormInstanceBuilding(
      row as {
        client_id: string;
        form_template_version_id: string;
        generated_task_id: string | null;
      },
    );
  }
  if (row.building_id) {
    const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
    if (!buildingIds.includes(row.building_id)) throw buildingAccessDeniedError();
  }
  return row;
}

export type SubmitEvidenceMetadataInput = Record<string, unknown>;

/**
 * Creates an evidence submission (metadata contract), with the exact
 * validation of the submission endpoint: body shape, execution existence +
 * scope, terminal execution, requirement type/client/count, and MIME
 * alignment with the evidence type.
 */
export async function submitEvidenceMetadata(
  body: SubmitEvidenceMetadataInput,
  userId: string,
): Promise<ReturnType<typeof toPublicEvidence>> {
  const evidenceType = body.evidenceType;
  const executionType = body.executionType;
  const executionId = body.executionId;

  if (
    typeof evidenceType !== 'string' ||
    !EVIDENCE_TYPES.includes(evidenceType as (typeof EVIDENCE_TYPES)[number]) ||
    typeof executionType !== 'string' ||
    !EXECUTION_TYPES.includes(executionType as (typeof EXECUTION_TYPES)[number]) ||
    typeof executionId !== 'string' ||
    !body.fileReference ||
    !body.originalFileName ||
    !body.mimeType ||
    !Number.isInteger(body.fileSize) ||
    (body.fileSize as number) < 0 ||
    (body.fileSize as number) > 52428800
  ) {
    throw AppError.validation();
  }

  const execution = await loadEvidenceExecution(
    executionType as string,
    executionId as string,
    userId,
  );
  if (execution.status === 'COMPLETED' || execution.status === 'CANCELLED') {
    throw AppError.badRequest('Terminal execution cannot receive evidence.');
  }

  let requirement: EvidenceSubmissionRow | null = null;
  if (body.evidenceRequirementId) {
    const requirementResult = await getPool().query<EvidenceSubmissionRow>(
      `SELECT * FROM evidence_requirements WHERE id = $1 AND status = 'ACTIVE'`,
      [body.evidenceRequirementId],
    );
    requirement = requirementResult.rows[0] ?? null;
    if (!requirement) {
      throw AppError.badRequest('Evidence requirement does not exist.');
    }
    if (requirement.evidence_type !== evidenceType) {
      throw AppError.badRequest('Evidence type does not match requirement.');
    }
    if (requirement.client_id !== execution.client_id) {
      throw AppError.badRequest('Evidence requirement client mismatch.');
    }
  }

  const allowed =
    evidenceType === 'PHOTO'
      ? ['image/jpeg', 'image/png', 'image/webp']
      : evidenceType === 'SIGNATURE'
        ? ['image/png', 'image/svg+xml']
        : ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowed.includes(body.mimeType as string)) {
    throw AppError.badRequest('Unsupported evidence MIME type.');
  }

  if (requirement && requirement.maximum_count !== null) {
    const count = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM evidence_submissions
        WHERE evidence_requirement_id = $1 AND status = 'ACTIVE'`,
      [requirement.id],
    );
    if (count.rows[0].n >= (requirement.maximum_count as number)) {
      throw AppError.badRequest('Evidence maximum count exceeded.');
    }
  }

  const inserted = await getPool().query<EvidenceSubmissionRow>(
    `INSERT INTO evidence_submissions (
       id, client_id, evidence_requirement_id, execution_type, execution_id,
       evidence_type, file_reference, original_file_name, mime_type,
       file_size, captured_at, submitted_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      randomUUID(),
      execution.client_id,
      requirement?.id ?? null,
      executionType,
      executionId,
      evidenceType,
      body.fileReference,
      body.originalFileName,
      body.mimeType,
      body.fileSize,
      body.capturedAt ?? null,
      userId,
    ],
  );
  // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance at creation.
  await applyRetentionToEvidence(inserted.rows[0].id as string, userId);
  return toPublicEvidence(inserted.rows[0]);
}

export const evidenceSubmissionService = {
  loadEvidenceExecution,
  submitEvidenceMetadata,
  toPublicEvidence,
};
