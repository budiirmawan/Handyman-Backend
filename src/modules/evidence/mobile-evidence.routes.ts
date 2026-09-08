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
import {
  computeEvidenceSha256,
  EVIDENCE_HASH_ALGORITHM,
} from './evidence-integrity';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import type {
  MobileEvidenceBuilding,
  MobileEvidenceContract,
  MobileEvidenceRequirementReference,
  MobileEvidenceTarget,
} from './mobile-evidence.types';

/**
 * BE-25E — Mobile Evidence Upload Contract.
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
 */

const p = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_FILE_BYTES, files: 1 },
});

const EVIDENCE_TYPES = ['PHOTO', 'DOCUMENT', 'SIGNATURE'] as const;
const EXECUTION_TYPES = ['FORM_INSTANCE', 'CHECKLIST_EXECUTION'] as const;

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
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
 * Resolves the target task/checklist/work reference and the Building context
 * of an execution:
 *   - CHECKLIST_EXECUTION → checklist template + first generated task
 *     targeting it (task carries the Building context, when bound),
 *   - FORM_INSTANCE → owning form template (Building context not resolvable —
 *     form instances are client-scoped only).
 */
async function resolveTargetContext(
  executionType: 'FORM_INSTANCE' | 'CHECKLIST_EXECUTION',
  executionId: string,
): Promise<{ target: MobileEvidenceTarget; building: MobileEvidenceBuilding | null }> {
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
        target: { executionType, executionId, checklist: null, form: null, task: null },
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
      },
      building,
    };
  }

  // FORM_INSTANCE → owning form template.
  const form = await getPool().query<{ id: string; code: string; name: string }>(
    `SELECT ft.id, ft.code, ft.name
       FROM form_instances fi
       JOIN form_template_versions ftv ON ftv.id = fi.form_template_version_id
       JOIN form_templates ft ON ft.id = ftv.form_template_id
      WHERE fi.id = $1`,
    [executionId],
  );
  return {
    target: {
      executionType,
      executionId,
      checklist: null,
      form: form.rows[0] ?? null,
      task: null,
    },
    building: null,
  };
}

/** Loads an execution and enforces the BE-02G accessible-Client scope. */
async function loadExecution(
  executionType: 'FORM_INSTANCE' | 'CHECKLIST_EXECUTION',
  executionId: string,
  userId: string,
): Promise<{ client_id: string; status: string }> {
  const table = executionType === 'FORM_INSTANCE' ? 'form_instances' : 'checklist_executions';
  const result = await getPool().query<{ client_id: string; status: string }>(
    `SELECT client_id, status FROM ${table} WHERE id = $1`,
    [executionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.badRequest('Execution does not exist.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) {
    throw buildingAccessDeniedError();
  }
  return row;
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
): Promise<MobileEvidenceContract> {
  const executionType = row.execution_type as 'FORM_INSTANCE' | 'CHECKLIST_EXECUTION';
  const executionId = row.execution_id as string;
  const { target, building } = await resolveTargetContext(executionType, executionId);

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
  const manage = requirePermission('evidence.manage');
  const storage = createEvidenceStorage();

  router.post(
    '/mobile/evidence',
    auth,
    manage,
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
        if (!executionType || !EXECUTION_TYPES.includes(executionType as any)) {
          details.push({ field: 'executionType', message: 'executionType must be FORM_INSTANCE or CHECKLIST_EXECUTION.' });
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

        const execution = await loadExecution(
          executionType as 'FORM_INSTANCE' | 'CHECKLIST_EXECUTION',
          executionId as string,
          req.auth.userId,
        );
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
            executionType,
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

        sendSuccess(res, await buildContract(inserted.rows[0]), 201);
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
        sendSuccess(res, await buildContract(row));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
