import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { isValidUuid } from '../clients';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  createEvidenceStorage,
  evidenceStorageKey,
  isEvidenceStorageKey,
} from './storage';
import {
  MAX_EVIDENCE_FILE_BYTES,
  MIME_BY_EVIDENCE_TYPE,
} from './evidence-file.routes';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import {
  computeEvidenceSha256,
  EVIDENCE_HASH_ALGORITHM,
} from './evidence-integrity';
import { loadEvidenceExecution } from './evidence.service';
import { resolveBoundFormInstanceBuilding } from '../form-instances';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import {
  MOBILE_EVIDENCE_EXECUTION_TYPES,
  type MobileEvidenceBuilding,
  type MobileEvidenceContract,
  type MobileEvidenceExecutionType,
  type MobileEvidenceRequirementReference,
  type MobileEvidenceTarget,
} from './mobile-evidence.types';

/**
 * BE-25E / MOB-C06 PART 01 — Mobile Evidence Upload Contract.
 *
 *   POST /mobile/evidence   single-call evidence upload (multipart field
 *                           "file" + evidenceType / executionType /
 *                           executionId / evidenceRequirementId? /
 *                           capturedAt? / originalFileName?)
 *   GET  /mobile/evidence/:evidenceId   mobile evidence reference read model
 *
 * Reuses the BE-07 Evidence authority (evidence_submissions,
 * evidence_requirements) and the CR-BE-API-01 PART 03 storage abstraction —
 * no separate mobile evidence engine. File bytes never enter PostgreSQL and
 * internal storage paths are never exposed. Evidence requirement / type /
 * context are validated exactly like the existing submission endpoints;
 * the existing Web endpoints remain untouched.
 *
 * MOB-C06 PART 01 — the upload accepts the Finding evidence parents
 * (FINDING / FINDING_REWORK / FINDING_VERIFICATION) alongside the existing
 * FORM_INSTANCE / CHECKLIST_EXECUTION kinds:
 *   - the parent is resolved ONLY from executionType + executionId through
 *     the shared `loadEvidenceExecution` resolver (the same loader the
 *     generic Finding evidence endpoints use) — Building/Client scope is
 *     server-derived and no Finding/rework/review authority is re-implemented
 *     here,
 *   - the generic parent-state gates are preserved (rework cycle must be
 *     REQUESTED; verification review must be PENDING; terminal parents are
 *     rejected),
 *   - the upload permission is asserted EXACTLY per executionType after the
 *     multipart body is parsed (the same dynamic-permission pattern as the
 *     mobile verification contract): FORM_INSTANCE / CHECKLIST_EXECUTION /
 *     FINDING / FINDING_REWORK → evidence.manage (the existing mobile/Web
 *     authority); FINDING_VERIFICATION → finding.review (generic-route
 *     parity — evidence.manage alone must NOT grant verification evidence).
 *
 * MOB-C06 PART 02 — the shared read contract (GET /mobile/evidence/:evidenceId
 * and the upload response) enriches the Finding-related kinds with the
 * authoritative parent context, derived ONLY from the stored evidence's
 * execution_type + execution_id: a minimal Finding reference
 * (id/findingNumber/title/status), the rework/verification reference where
 * applicable, and the Building context of the parent Finding. A broken or
 * missing parent fails closed (404), and the parent Finding's Building must
 * be accessible before any enriched metadata is returned (403 otherwise) —
 * identical BE-02G semantics to the write side. Existing
 * FORM_INSTANCE / CHECKLIST_EXECUTION projections are unchanged apart from
 * the additive nullable finding/rework/verification fields (always null for
 * those kinds).
 */

const p = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_FILE_BYTES, files: 1 },
});

const EVIDENCE_TYPES = ['PHOTO', 'DOCUMENT', 'SIGNATURE'] as const;

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * MOB-C06 PART 01 — the EXACT upload permission per executionType
 * (generic-route parity; asserted in the handler because executionType is
 * only readable after the multipart body is parsed):
 *   - FORM_INSTANCE / CHECKLIST_EXECUTION → evidence.manage (the existing
 *     BE-25E mobile authority, unchanged),
 *   - FINDING / FINDING_REWORK            → evidence.manage (the same
 *     permission the generic Finding / rework evidence endpoints require),
 *   - FINDING_VERIFICATION                → finding.review (the generic
 *     verification-evidence authority; evidence.manage alone must NOT
 *     grant it, and a reviewer must NOT be forced to hold evidence.manage).
 */
const UPLOAD_PERMISSION: Record<MobileEvidenceExecutionType, string> = {
  FORM_INSTANCE: 'evidence.manage',
  CHECKLIST_EXECUTION: 'evidence.manage',
  FINDING: 'evidence.manage',
  FINDING_REWORK: 'evidence.manage',
  FINDING_VERIFICATION: 'finding.review',
};

function permissionDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message: 'You do not have permission to perform this action.',
    statusCode: 403,
  });
}

async function assertUploadPermission(
  userId: string,
  executionType: MobileEvidenceExecutionType,
): Promise<void> {
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  if (!permissions.includes(UPLOAD_PERMISSION[executionType])) {
    throw permissionDeniedError();
  }
}

function toRequirementReference(row: Record<string, unknown>): MobileEvidenceRequirementReference {
  return {
    id: row.id as string,
    evidenceType: row.evidence_type as 'PHOTO' | 'DOCUMENT' | 'SIGNATURE',
    required: row.required as boolean,
    minimumCount: row.minimum_count as number,
    maximumCount: (row.maximum_count as number | null) ?? null,
    description: (row.description as string | null) ?? null,
  };
}

/**
 * MOB-C06 PART 02 — authoritative Finding-parent context of Finding-related
 * evidence, resolved ONLY from the stored evidence's execution_type +
 * execution_id (never from client input):
 *   - FINDING             → findings (exact Finding),
 *   - FINDING_REWORK      → finding_rework_cycles ⋈ findings (the Finding
 *                           relationship comes from the authoritative cycle
 *                           row),
 *   - FINDING_VERIFICATION→ reviews (target_type = 'FINDING') ⋈ findings
 *                           (the Finding relationship comes from the
 *                           authoritative review row; a review targeting
 *                           anything else does not resolve).
 *
 * Fail-closed semantics: a missing parent (or a non-FINDING review target)
 * yields 404 — the read model never returns partial context with null
 * projections for a broken Finding-related parent. Before any enriched
 * parent metadata is returned, the parent Finding's Building must be inside
 * the caller's accessible Building set (the same BE-02G scope semantics the
 * shared write-side resolver enforces); otherwise 403.
 */
async function resolveFindingParentContext(
  executionType: 'FINDING' | 'FINDING_REWORK' | 'FINDING_VERIFICATION',
  executionId: string,
  userId: string,
): Promise<{ target: MobileEvidenceTarget; building: MobileEvidenceBuilding | null }> {
  type ParentRow = {
    finding_id: string;
    finding_number: string;
    title: string;
    finding_status: string;
    building_id: string;
    rework_status: string | null;
    verification_status: string | null;
  };

  const queryByType: Record<typeof executionType, { sql: string }> = {
    FINDING: {
      sql: `SELECT f.id AS finding_id, f.finding_number, f.title,
                   f.status AS finding_status, f.building_id,
                   NULL::text AS rework_status, NULL::text AS verification_status
              FROM findings f
             WHERE f.id = $1`,
    },
    FINDING_REWORK: {
      sql: `SELECT f.id AS finding_id, f.finding_number, f.title,
                   f.status AS finding_status, f.building_id,
                   r.status AS rework_status, NULL::text AS verification_status
              FROM finding_rework_cycles r
              JOIN findings f ON f.id = r.finding_id
             WHERE r.id = $1`,
    },
    FINDING_VERIFICATION: {
      sql: `SELECT f.id AS finding_id, f.finding_number, f.title,
                   f.status AS finding_status, f.building_id,
                   NULL::text AS rework_status, v.status AS verification_status
              FROM reviews v
              JOIN findings f ON f.id = v.target_id
             WHERE v.id = $1 AND v.target_type = 'FINDING'`,
    },
  };

  const result = await getPool().query<ParentRow>(
    queryByType[executionType].sql,
    [executionId],
  );
  const parent = result.rows[0];
  if (!parent) {
    // Broken/missing/non-FINDING parent — fail closed, no partial context.
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: 'Evidence parent not found.',
      statusCode: 404,
      resource: { type: executionType, id: executionId },
    });
  }

  // Building accessibility of the parent Finding (BE-02G) gates the enriched
  // parent metadata — identical semantics to the shared write-side resolver.
  const accessibleBuildingIds =
    await contextAccessService.getAccessibleBuildingIds(userId);
  if (!accessibleBuildingIds.includes(parent.building_id)) {
    throw buildingAccessDeniedError();
  }

  const buildingRow = await getPool().query<MobileEvidenceBuilding>(
    'SELECT id, code, name FROM buildings WHERE id = $1',
    [parent.building_id],
  );
  const building = buildingRow.rows[0];
  if (!building) {
    // The parent Finding's Building no longer resolves — broken parent.
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: 'Evidence parent not found.',
      statusCode: 404,
      resource: { type: executionType, id: executionId },
    });
  }

  return {
    target: {
      executionType,
      executionId,
      checklist: null,
      form: null,
      task: null,
      finding: {
        id: parent.finding_id,
        findingNumber: parent.finding_number,
        title: parent.title,
        status: parent.finding_status,
      },
      rework:
        executionType === 'FINDING_REWORK'
          ? { id: executionId, status: parent.rework_status ?? '' }
          : null,
      verification:
        executionType === 'FINDING_VERIFICATION'
          ? { id: executionId, status: parent.verification_status ?? '' }
          : null,
    },
    building,
  };
}

/**
 * Resolves the target task/checklist/work reference and the Building context
 * of an execution:
 *   - CHECKLIST_EXECUTION → checklist template + first generated task
 *     targeting it (task carries the Building context, when bound),
 *   - FORM_INSTANCE → owning form template; task-bound instances also
 *     project the exact generated task and its Building (MOB-C07 PART 05),
 *     never a template-first guess. Unbound generic instances stay
 *     client-scoped with building/task null,
 *   - FINDING / FINDING_REWORK / FINDING_VERIFICATION (MOB-C06 PART 02) →
 *     the Finding-parent kinds, resolved from the STORED evidence's
 *     execution_type + execution_id through the same authoritative joins the
 *     shared `loadEvidenceExecution` resolver uses (never from client
 *     input): FINDING → findings, FINDING_REWORK → finding_rework_cycles ⋈
 *     findings, FINDING_VERIFICATION → reviews (target_type = 'FINDING') ⋈
 *     findings. A broken/missing/non-FINDING parent fails closed (404 — no
 *     partial context with null projections), and the parent Finding's
 *     Building must be accessible to the caller (403 otherwise) before any
 *     enriched parent metadata is returned.
 */
async function resolveTargetContext(
  executionType: MobileEvidenceExecutionType,
  executionId: string,
  userId: string,
): Promise<{ target: MobileEvidenceTarget; building: MobileEvidenceBuilding | null }> {
  if (
    executionType === 'FINDING' ||
    executionType === 'FINDING_REWORK' ||
    executionType === 'FINDING_VERIFICATION'
  ) {
    return resolveFindingParentContext(executionType, executionId, userId);
  }

  if (executionType === 'CHECKLIST_EXECUTION') {
    const execution = await getPool().query<{
      checklist_template_id: string;
    }>(
      'SELECT checklist_template_id FROM checklist_executions WHERE id = $1',
      [executionId],
    );
    const templateId = execution.rows[0]?.checklist_template_id;
    if (!templateId) {
      return {
        target: {
          executionType,
          executionId,
          checklist: null,
          form: null,
          task: null,
          finding: null,
          rework: null,
          verification: null,
        },
        building: null,
      };
    }

    const template = await getPool().query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name FROM checklist_templates WHERE id = $1',
      [templateId],
    );
    const checklist = template.rows[0] ?? null;

    const task = await getPool().query<{
      id: string;
      occurrence_at: Date;
      building_id: string | null;
      status: string;
    }>(
      `SELECT id, occurrence_at, building_id, status FROM generated_tasks
        WHERE target_type = 'CHECKLIST_TEMPLATE' AND target_id = $1
        ORDER BY occurrence_at, id LIMIT 1`,
      [templateId],
    );
    const taskRow = task.rows[0] ?? null;

    let building: MobileEvidenceBuilding | null = null;
    if (taskRow?.building_id) {
      const buildingRow = await getPool().query<{ id: string; code: string; name: string }>(
        'SELECT id, code, name FROM buildings WHERE id = $1',
        [taskRow.building_id],
      );
      if (buildingRow.rows[0]) {
        building = buildingRow.rows[0];
      }
    }

    return {
      target: {
        executionType,
        executionId,
        checklist: checklist
          ? { id: checklist.id, code: checklist.code, name: checklist.name }
          : null,
        form: null,
        task: taskRow
          ? {
              taskId: taskRow.id,
              occurrenceAt: iso(taskRow.occurrence_at) ?? '',
              taskStatus: taskRow.status,
              buildingId: taskRow.building_id,
            }
          : null,
        finding: null,
        rework: null,
        verification: null,
      },
      building,
    };
  }

  // FORM_INSTANCE → owning form template; bound instances also project the
  // exact generated task + Building (never a template-first guess).
  const instance = await getPool().query<{
    form_template_version_id: string;
    generated_task_id: string | null;
    client_id: string;
  }>(
    `SELECT form_template_version_id, generated_task_id, client_id
       FROM form_instances WHERE id = $1`,
    [executionId],
  );
  const instanceRow = instance.rows[0];
  const form = instanceRow
    ? await getPool().query<{ id: string; code: string; name: string }>(
        `SELECT ft.id, ft.code, ft.name
           FROM form_template_versions ftv
           JOIN form_templates ft ON ft.id = ftv.form_template_id
          WHERE ftv.id = $1`,
        [instanceRow.form_template_version_id],
      )
    : { rows: [] as { id: string; code: string; name: string }[] };

  let taskProjection: MobileEvidenceTarget['task'] = null;
  let building: MobileEvidenceBuilding | null = null;
  if (instanceRow) {
    const buildingId = await resolveBoundFormInstanceBuilding(instanceRow);
    if (buildingId) {
      const accessibleBuildingIds =
        await contextAccessService.getAccessibleBuildingIds(userId);
      if (!accessibleBuildingIds.includes(buildingId)) {
        throw buildingAccessDeniedError();
      }
      const buildingRow = await getPool().query<MobileEvidenceBuilding>(
        'SELECT id, code, name FROM buildings WHERE id = $1',
        [buildingId],
      );
      building = buildingRow.rows[0] ?? null;
      const task = await getPool().query<{
        id: string;
        occurrence_at: Date;
        building_id: string | null;
        status: string;
      }>(
        `SELECT id, occurrence_at, building_id, status
           FROM generated_tasks WHERE id = $1`,
        [instanceRow.generated_task_id],
      );
      const taskRow = task.rows[0];
      if (taskRow) {
        taskProjection = {
          taskId: taskRow.id,
          occurrenceAt: iso(taskRow.occurrence_at) ?? '',
          taskStatus: taskRow.status,
          buildingId: taskRow.building_id,
        };
      }
    }
  }

  return {
    target: {
      executionType,
      executionId,
      checklist: null,
      form: form.rows[0] ?? null,
      task: taskProjection,
      finding: null,
      rework: null,
      verification: null,
    },
    building,
  };
}

async function loadEvidenceRow(evidenceId: string, userId: string): Promise<Record<string, unknown>> {
  const result = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM evidence_submissions WHERE id = $1',
    [evidenceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: 'Evidence not found.',
      statusCode: 404,
      resource: { type: 'EVIDENCE_SUBMISSION', id: evidenceId },
    });
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id as string)) {
    throw buildingAccessDeniedError();
  }
  return row;
}

async function buildContract(
  row: Record<string, unknown>,
  userId: string,
): Promise<MobileEvidenceContract> {
  const executionType = row.execution_type as MobileEvidenceExecutionType;
  const executionId = row.execution_id as string;
  const { target, building } = await resolveTargetContext(
    executionType,
    executionId,
    userId,
  );

  let requirement: MobileEvidenceRequirementReference | null = null;
  if (row.evidence_requirement_id) {
    const requirementRow = await getPool().query<Record<string, unknown>>(
      `SELECT id, evidence_type, required, minimum_count, maximum_count, description
         FROM evidence_requirements WHERE id = $1`,
      [row.evidence_requirement_id],
    );
    if (requirementRow.rows[0]) {
      requirement = toRequirementReference(requirementRow.rows[0]);
    }
  }

  const storageKey = row.file_reference as string | null;
  const storageBacked = storageKey !== null && isEvidenceStorageKey(storageKey);

  return {
    id: row.id as string,
    clientId: row.client_id as string,
    building,
    evidenceRequirement: requirement,
    target,
    evidenceType: row.evidence_type as 'PHOTO' | 'DOCUMENT' | 'SIGNATURE',
    file: {
      originalFileName: (row.original_file_name as string | null) ?? null,
      mimeType: (row.mime_type as string | null) ?? null,
      fileSize: Number(row.file_size),
      capturedAt: iso(row.captured_at as Date | null),
      uploadStatus: storageBacked ? 'UPLOADED' : 'PENDING',
      fileAvailable: storageBacked,
    },
    status: row.status as string,
    submittedByUserId: row.submitted_by_user_id as string,
    createdAt: iso(row.created_at as Date) ?? '',
    updatedAt: iso(row.updated_at as Date) ?? '',
  };
}

function runSingleFileUpload(
  req: Request,
  res: Response,
): Promise<Express.Multer.File> {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          reject(AppError.badRequest('Uploaded file exceeds the 50 MB limit.'));
          return;
        }
        reject(AppError.badRequest('File upload failed.'));
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        reject(
          AppError.validation('Request validation failed.', [
            { field: 'file', message: 'Multipart field "file" is required.' },
          ]),
        );
        return;
      }
      resolve(file);
    });
  });
}

export function createMobileEvidenceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('evidence.read');
  const storage = createEvidenceStorage();

  // NOTE (MOB-C06 PART 01): the upload route deliberately carries ONLY the
  // authentication middleware — the exact permission is asserted in the
  // handler per parsed executionType (`assertUploadPermission`), because the
  // permission differs by parent kind (evidence.manage vs finding.review for
  // FINDING_VERIFICATION). This is the same dynamic-permission pattern the
  // mobile verification contract uses; authorization is never skipped and
  // never reduced to parent scope alone.
  router.post(
    '/mobile/evidence',
    auth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Parse the multipart first: multer populates req.body with the
        // text fields, so the body must be read after runSingleFileUpload.
        const file = await runSingleFileUpload(req, res);

        const body = req.body ?? {};
        const evidenceType = p(body.evidenceType);
        const executionType = p(body.executionType);
        const executionId = p(body.executionId);
        const evidenceRequirementId = p(body.evidenceRequirementId) || null;
        const capturedAtRaw = p(body.capturedAt) || null;

        const details: { field: string; message: string }[] = [];
        if (!evidenceType || !EVIDENCE_TYPES.includes(evidenceType as any)) {
          details.push({ field: 'evidenceType', message: 'evidenceType must be PHOTO, DOCUMENT or SIGNATURE.' });
        }
        if (
          !executionType ||
          !MOBILE_EVIDENCE_EXECUTION_TYPES.includes(executionType as any)
        ) {
          details.push({
            field: 'executionType',
            message:
              'executionType must be FORM_INSTANCE, CHECKLIST_EXECUTION, FINDING, FINDING_REWORK or FINDING_VERIFICATION.',
          });
        }
        if (!executionId || !isValidUuid(executionId)) {
          details.push({ field: 'executionId', message: 'executionId must be a valid UUID.' });
        }
        if (evidenceRequirementId && !isValidUuid(evidenceRequirementId)) {
          details.push({ field: 'evidenceRequirementId', message: 'evidenceRequirementId must be a valid UUID.' });
        }
        let capturedAt: Date | null = null;
        if (capturedAtRaw) {
          const parsed = new Date(capturedAtRaw);
          if (Number.isNaN(parsed.getTime())) {
            details.push({ field: 'capturedAt', message: 'capturedAt must be an ISO-8601 timestamp.' });
          } else {
            capturedAt = parsed;
          }
        }
        if (details.length > 0) {
          throw AppError.validation('Request validation failed.', details);
        }

        const executionTypeValue = executionType as MobileEvidenceExecutionType;

        // MOB-C06 PART 01 — EXACT per-kind upload permission (dynamic, after
        // the multipart parse): evidence.manage for FORM_INSTANCE /
        // CHECKLIST_EXECUTION / FINDING / FINDING_REWORK; finding.review for
        // FINDING_VERIFICATION (generic-route parity).
        await assertUploadPermission(req.auth.userId, executionTypeValue);

        // MOB-C06 PART 01 — the parent is resolved ONLY from
        // executionType + executionId through the shared BE-07 evidence
        // execution loader (the same resolver the generic Finding evidence
        // endpoints use): Building/Client scope is server-derived, a
        // rework/review parent resolves through its Finding, and no second
        // mobile Finding authority engine exists. Client-supplied
        // building/client/finding references are never consulted.
        const execution = await loadEvidenceExecution(
          executionTypeValue,
          executionId as string,
          req.auth.userId,
        );

        // MOB-C06 PART 01 — generic parent-state gates (identical semantics
        // to the generic Finding evidence endpoints):
        //   - a rework cycle may only receive evidence while REQUESTED,
        //   - a verification review may only receive evidence while PENDING.
        if (
          executionTypeValue === 'FINDING_REWORK' &&
          execution.status !== 'REQUESTED'
        ) {
          throw AppError.badRequest(
            'Rework cycle cannot receive evidence in its current state.',
          );
        }
        if (
          executionTypeValue === 'FINDING_VERIFICATION' &&
          execution.status !== 'PENDING'
        ) {
          throw AppError.badRequest(
            'Verification cannot receive evidence in its current state.',
          );
        }
        if (execution.status === 'COMPLETED' || execution.status === 'CANCELLED') {
          throw AppError.badRequest('Terminal execution cannot receive evidence.');
        }

        // Evidence requirement validation (when provided).
        let requirementRow: Record<string, unknown> | null = null;
        if (evidenceRequirementId) {
          const requirement = await getPool().query<Record<string, unknown>>(
            `SELECT * FROM evidence_requirements WHERE id = $1 AND status = 'ACTIVE'`,
            [evidenceRequirementId],
          );
          requirementRow = requirement.rows[0] ?? null;
          if (!requirementRow) {
            throw AppError.badRequest('Evidence requirement does not exist.');
          }
          if (requirementRow.evidence_type !== evidenceType) {
            throw AppError.badRequest('Evidence type does not match requirement.');
          }
          if (requirementRow.client_id !== execution.client_id) {
            throw AppError.badRequest('Evidence requirement client mismatch.');
          }
          if (requirementRow.maximum_count !== null) {
            const count = await getPool().query<{ n: number }>(
              `SELECT count(*)::int AS n FROM evidence_submissions
                WHERE evidence_requirement_id = $1 AND status = 'ACTIVE'`,
              [evidenceRequirementId],
            );
            if (count.rows[0].n >= (requirementRow.maximum_count as number)) {
              throw AppError.badRequest('Evidence maximum count exceeded.');
            }
          }
        }

        const allowedMime = MIME_BY_EVIDENCE_TYPE[evidenceType as string] ?? [];
        if (!allowedMime.includes(file.mimetype)) {
          throw AppError.badRequest(
            `Evidence type ${evidenceType} does not accept MIME type ${file.mimetype}.`,
          );
        }

        // Store bytes via the single storage abstraction, then persist the
        // submission metadata (file_reference is the backend-generated key).
        // CR-BE-DOC-CONTROL-01 PART 01: the SHA-256 is computed server-side
        // from the EXACT buffer handed to storage.put and persisted in the
        // same INSERT as the file metadata — no caller-supplied hash.
        const evidenceId = randomUUID();
        const key = evidenceStorageKey(evidenceId);
        const contentSha256 = computeEvidenceSha256(file.buffer);
        await storage.put(key, { buffer: file.buffer, mimeType: file.mimetype });

        const inserted = await getPool().query(
          `INSERT INTO evidence_submissions (
             id, client_id, evidence_requirement_id, execution_type, execution_id,
             evidence_type, file_reference, original_file_name, mime_type,
             file_size, captured_at, submitted_by_user_id,
             content_sha256, content_hashed_at, hash_algorithm
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)
           RETURNING *`,
          [
            evidenceId,
            execution.client_id,
            requirementRow?.id ?? null,
            executionTypeValue,
            executionId,
            evidenceType,
            key,
            p(body.originalFileName) ?? file.originalname ?? null,
            file.mimetype,
            file.size,
            capturedAt,
            req.auth.userId,
            contentSha256,
            EVIDENCE_HASH_ALGORITHM,
          ],
        );

        // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance.
        await applyRetentionToEvidence(evidenceId, req.auth.userId);

        await recordOperationalEvent({
          clientId: execution.client_id,
          eventType: 'EVIDENCE_INTEGRITY_HASH_RECORDED',
          entityType: 'EVIDENCE_SUBMISSION',
          entityId: evidenceId,
          actorUserId: req.auth.userId,
          summary: 'Evidence integrity hash recorded',
          metadata: {
            evidenceId,
            algorithm: EVIDENCE_HASH_ALGORITHM,
            contentSha256,
            fileSize: file.size,
          },
        });

        sendSuccess(res, await buildContract(inserted.rows[0], req.auth.userId), 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/mobile/evidence/:evidenceId',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const evidenceId = p(req.params.evidenceId);
        if (!evidenceId || !isValidUuid(evidenceId)) {
          throw AppError.validation('Request validation failed.', [
            { field: 'evidenceId', message: 'Evidence id must be a valid UUID.' },
          ]);
        }
        const row = await loadEvidenceRow(evidenceId, req.auth.userId);
        sendSuccess(res, await buildContract(row, req.auth.userId));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
