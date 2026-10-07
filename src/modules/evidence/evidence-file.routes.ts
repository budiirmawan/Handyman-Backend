import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
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
import { loadEvidenceExecution, toPublicEvidence } from './evidence.service';
import { recordFindingEvent } from '../finding-history';
import { recordOperationalEvent } from '../operational-events';
import {
  computeEvidenceSha256,
  EVIDENCE_HASH_ALGORITHM,
} from './evidence-integrity';
import { verifyEvidenceIntegrity } from './evidence-integrity-verification.service';

/**
 * CR-BE-API-01 PART 03 — Evidence File API foundation.
 *
 *   POST /evidence/:evidenceId/file           upload (multipart field "file")
 *   GET  /evidence/:evidenceId/file           resolve evidence file metadata
 *   GET  /evidence/:evidenceId/file/content   download the stored file bytes
 *
 * Reuses the existing Evidence model (evidence_submissions): the submission
 * row IS the file metadata record and `file_reference` becomes the
 * backend-generated storage key after upload. No new table, no replacement of
 * the Evidence entity. Access is governed by the existing authentication,
 * RBAC permission and BE-02G Client-scope rules (evidence tables carry
 * client_id only, so the accessible-Client set is the authoritative scope).
 *
 * Security: storage keys are derived from the validated evidence UUID only —
 * no client-supplied path ever reaches the filesystem and internal storage
 * paths are never exposed.
 */

const p = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value);

export const MAX_EVIDENCE_FILE_BYTES = 52_428_800; // matches evidence_submissions.file_size constraint

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_FILE_BYTES, files: 1 },
});

export const MIME_BY_EVIDENCE_TYPE: Record<string, readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  SIGNATURE: ['image/png', 'image/svg+xml'],
  DOCUMENT: ['application/pdf', 'image/jpeg', 'image/png'],
};

// CR-BE-DOC-CONTROL-01 PART 05: the shared BE-07 mapper is the single
// public evidence shape (now including the additive integrity + retention
// fields) — the former local duplicate was removed to prevent drift.

async function loadEvidence(evidenceId: string, userId: string) {
  if (!isValidUuid(evidenceId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'evidenceId', message: 'Evidence id must be a valid UUID.' },
    ]);
  }

  const result = await getPool().query<Record<string, unknown>>(
    'SELECT * FROM evidence_submissions WHERE id = $1',
    [evidenceId],
  );
  if (result.rowCount === 0) {
    throw AppError.notFound('Evidence not found.');
  }

  const row = result.rows[0];
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id as string)) {
    throw buildingAccessDeniedError();
  }
  if (['FINDING', 'FINDING_REWORK', 'FINDING_VERIFICATION'].includes(row.execution_type as string)) {
    await loadEvidenceExecution(row.execution_type as string, row.execution_id as string, userId);
  }
  return row;
}

function runSingleFileUpload(
  req: Request,
  res: Response,
): Promise<Express.Multer.File> {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          reject(
            AppError.badRequest('Uploaded file exceeds the 50 MB limit.'),
          );
          return;
        }
        reject(AppError.badRequest('File upload failed.'));
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        reject(
          AppError.validation('Request validation failed.', [
            {
              field: 'file',
              message: 'Multipart field "file" is required.',
            },
          ]),
        );
        return;
      }
      resolve(file);
    });
  });
}

export function createEvidenceFileRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('evidence.read');
  const manage = requirePermission('evidence.manage');
  const storage = createEvidenceStorage();

  router.post(
    '/evidence/:evidenceId/file',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const evidenceId = p(req.params.evidenceId);
        const row = await loadEvidence(evidenceId, req.auth.userId);
        // CR-BE-DOC-CONTROL-01 PART 04: a purged tombstone is terminal —
        // it can never regain a stored file.
        if (row.retention_state === 'PURGED') {
          throw AppError.badRequest('Purged evidence cannot receive a file.');
        }

        const file = await runSingleFileUpload(req, res);
        const allowedMime =
          MIME_BY_EVIDENCE_TYPE[row.evidence_type as string] ?? [];
        if (!allowedMime.includes(file.mimetype)) {
          throw AppError.badRequest(
            `Evidence type ${row.evidence_type} does not accept MIME type ${file.mimetype}.`,
          );
        }

        const key = evidenceStorageKey(evidenceId);
        // CR-BE-DOC-CONTROL-01 PART 01: hash the EXACT buffer handed to
        // storage.put, server-side only, and persist it atomically with the
        // file metadata — evidence cannot gain a stored file without its
        // integrity metadata. No caller-supplied hash is accepted.
        const contentSha256 = computeEvidenceSha256(file.buffer);
        await storage.put(key, { buffer: file.buffer, mimeType: file.mimetype });

        const updated = await getPool().query(
          `UPDATE evidence_submissions
             SET file_reference = $1,
                 original_file_name = $2,
                 mime_type = $3,
                 file_size = $4,
                 content_sha256 = $5,
                 content_hashed_at = NOW(),
                 hash_algorithm = $6,
                 updated_at = NOW()
           WHERE id = $7
           RETURNING *`,
          [
            key,
            file.originalname,
            file.mimetype,
            file.size,
            contentSha256,
            EVIDENCE_HASH_ALGORITHM,
            evidenceId,
          ],
        );

        await recordOperationalEvent({
          clientId: row.client_id as string,
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
        if (['FINDING','FINDING_REWORK','FINDING_VERIFICATION'].includes(row.execution_type as string)) { const owner = await getPool().query(`SELECT f.id, f.client_id, f.building_id FROM findings f LEFT JOIN finding_rework_cycles rw ON rw.id=$1 LEFT JOIN reviews vr ON vr.id=$1 WHERE f.id=CASE WHEN $2='FINDING' THEN $1 WHEN $2='FINDING_REWORK' THEN rw.finding_id ELSE vr.target_id END`, [row.execution_id, row.execution_type]); const finding = owner.rows[0]; if (finding) await recordFindingEvent({findingId:finding.id,clientId:finding.client_id,buildingId:finding.building_id,actorUserId:req.auth.userId,eventType:'EVIDENCE_UPLOADED',summary:'Evidence file uploaded',metadata:{evidenceId,parentType:row.execution_type,parentId:row.execution_id}}); }
sendSuccess(res, toPublicEvidence(updated.rows[0]), 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/evidence/:evidenceId/file',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const row = await loadEvidence(p(req.params.evidenceId), req.auth.userId);
        sendSuccess(res, toPublicEvidence(row));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/evidence/:evidenceId/file/content',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const row = await loadEvidence(p(req.params.evidenceId), req.auth.userId);

        const key = row.file_reference as string | null;
        if (!key || !isEvidenceStorageKey(key)) {
          throw new AppError({
            code: ERROR_CODES.EVIDENCE_FILE_NOT_FOUND,
            message: 'Stored evidence file not found.',
            statusCode: 404,
          });
        }

        const stored = await storage.get(key);
        res
          .status(200)
          .set('Content-Type', (row.mime_type as string) || 'application/octet-stream')
          .set('Content-Length', String(stored.buffer.length))
          .set(
            'Content-Disposition',
            `inline; filename*=UTF-8''${encodeURIComponent(
              (row.original_file_name as string) || 'evidence',
            )}`,
          )
          .send(stored.buffer);
      } catch (error) {
        next(error);
      }
    },
  );

  // CR-BE-DOC-CONTROL-01 PART 03 — retention hold set/clear (minimal
  // legal/operational hold, START GOVERNANCE §6, §10). Reuses the exact
  // loadEvidence isolation seam; evidence.manage (evidence-lifecycle
  // action). A held row is never purged (enforced in PART 04). Holds are
  // fully audited; no other retention field is touchable through any API.
  router.post(
    '/evidence/:evidenceId/retention-hold',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const row = await loadEvidence(p(req.params.evidenceId), req.auth.userId);
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (!reason || reason.length > 500) {
          throw AppError.validation('Request validation failed.', [
            { field: 'reason', message: 'reason is required (at most 500 characters).' },
          ]);
        }
        if (row.retention_state === 'PURGED') {
          throw AppError.badRequest('Purged evidence cannot be placed on hold.');
        }
        if (row.retention_hold === true) {
          throw AppError.badRequest('Evidence is already on retention hold.');
        }
        const updated = await getPool().query(
          `UPDATE evidence_submissions
              SET retention_hold = true,
                  retention_hold_reason = $2,
                  retention_hold_set_by_user_id = $3,
                  retention_hold_set_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [row.id, reason, req.auth.userId],
        );
        await recordOperationalEvent({
          clientId: row.client_id as string,
          eventType: 'EVIDENCE_RETENTION_HOLD_SET',
          entityType: 'EVIDENCE_SUBMISSION',
          entityId: row.id as string,
          actorUserId: req.auth.userId,
          summary: 'Evidence retention hold set',
          metadata: { evidenceId: row.id, reason },
        });
        sendSuccess(res, toPublicEvidence(updated.rows[0]));
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/evidence/:evidenceId/retention-hold',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const row = await loadEvidence(p(req.params.evidenceId), req.auth.userId);
        if (row.retention_hold !== true) {
          throw AppError.badRequest('Evidence is not on retention hold.');
        }
        const updated = await getPool().query(
          `UPDATE evidence_submissions
              SET retention_hold = false,
                  retention_hold_reason = NULL,
                  retention_hold_set_by_user_id = NULL,
                  retention_hold_set_at = NULL,
                  updated_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [row.id],
        );
        await recordOperationalEvent({
          clientId: row.client_id as string,
          eventType: 'EVIDENCE_RETENTION_HOLD_CLEARED',
          entityType: 'EVIDENCE_SUBMISSION',
          entityId: row.id as string,
          actorUserId: req.auth.userId,
          summary: 'Evidence retention hold cleared',
          metadata: { evidenceId: row.id },
        });
        sendSuccess(res, toPublicEvidence(updated.rows[0]));
      } catch (error) {
        next(error);
      }
    },
  );

  // CR-BE-DOC-CONTROL-01 PART 02 — manual integrity verification.
  // Reuses the exact loadEvidence Client/Building isolation seam and the
  // PART 01 hash authority; requires evidence.manage because verification
  // causes a storage read plus persisted state and an audit event. The
  // caller supplies NOTHING but the evidence id — no client-supplied hash
  // is ever accepted, and no outcome mutates or deletes evidence.
  router.post(
    '/evidence/:evidenceId/integrity-verification',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const row = await loadEvidence(p(req.params.evidenceId), req.auth.userId);
        const result = await verifyEvidenceIntegrity(
          {
            id: row.id as string,
            client_id: row.client_id as string,
            file_reference: row.file_reference as string | null,
            content_sha256: row.content_sha256 as string | null,
            retention_state: row.retention_state as string,
          },
          req.auth.userId,
          storage,
        );
        sendSuccess(res, {
          evidenceId: result.evidenceId,
          outcome: result.outcome,
          algorithm: result.algorithm,
          expectedSha256: result.expectedSha256,
          computedSha256: result.computedSha256,
          checkedAt: result.checkedAt,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
