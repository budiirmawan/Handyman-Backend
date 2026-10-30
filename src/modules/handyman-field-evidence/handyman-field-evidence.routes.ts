import express, { Router } from 'express';
import multer from 'multer';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { authenticationRequiredError } from '../auth/auth.errors';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import {
  confirmFieldEvidenceUpload,
  createPresignedFieldEvidenceIntent,
  getFieldEvidenceMetadata,
  listScopeFieldEvidence,
  putStagedFieldEvidenceBytes,
  readFieldEvidenceBytes,
  uploadFieldEvidenceBinary,
} from './handyman-field-evidence.service';
import { HANDYMAN_FIELD_EVIDENCE_MAX_BYTES } from './handyman-field-evidence.types';

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: HANDYMAN_FIELD_EVIDENCE_MAX_BYTES,
    files: 1,
  },
});

function singleFileMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  uploadMiddleware.single('file')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          AppError.validation(
            `Evidence file exceeds maximum allowed size (${HANDYMAN_FIELD_EVIDENCE_MAX_BYTES} bytes).`,
          ),
        );
        return;
      }
      next(AppError.validation(`Multipart upload error: ${err.message}`));
      return;
    }
    next(err);
  });
}

export const handymanFieldEvidenceRouter = Router();

export function createHandymanFieldEvidenceRouter(): Router {
  return handymanFieldEvidenceRouter;
}

// CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01 — scope the transport
// authentication wall to THIS router's own path families. A path-less
// router.use(auth) intercepts every later-mounted /api/v1 route:
// unknown routes must 404 (frozen error contract), not 401, and
// per-route auth is the codebase convention.
handymanFieldEvidenceRouter.use(
  '/handyman/field/evidence',
  authenticationMiddleware,
);
handymanFieldEvidenceRouter.use(
  '/handyman/field/execution-scopes/:executionScopeId/evidence',
  authenticationMiddleware,
);
handymanFieldEvidenceRouter.use(
  '/handyman/field/requests/:handymanRequestId/evidence',
  authenticationMiddleware,
);

handymanFieldEvidenceRouter.post(
  '/handyman/field/evidence/upload',
  singleFileMiddleware,
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await uploadFieldEvidenceBinary(req.auth.userId, {
        ...body,
        file: req.file ?? null,
      });
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) {
      next(error);
    }
  },
);

handymanFieldEvidenceRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/evidence/upload',
  singleFileMiddleware,
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await uploadFieldEvidenceBinary(req.auth.userId, {
        ...body,
        executionScopeId: req.params.executionScopeId,
        file: req.file ?? null,
      });
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) {
      next(error);
    }
  },
);

handymanFieldEvidenceRouter.post(
  '/handyman/field/requests/:handymanRequestId/evidence/upload',
  singleFileMiddleware,
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await uploadFieldEvidenceBinary(req.auth.userId, {
        ...body,
        handymanRequestId: req.params.handymanRequestId,
        file: req.file ?? null,
      });
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) {
      next(error);
    }
  },
);

// CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01B-BE — read-only discovery of
// CONFIRMED field evidence for one exact execution scope. Route-level
// authentication only; field authority (Operations / Crew Leader /
// Inspector / appointed QC Supervisor) is service-enforced with exact
// Client/Building/scope checks. No bytes, storage keys or uploads here.
handymanFieldEvidenceRouter.get(
  '/handyman/field/execution-scopes/:executionScopeId/evidence',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await listScopeFieldEvidence(
        req.auth.userId,
        req.params.executionScopeId,
        req.query as Record<string, unknown>,
      );
      sendSuccess(res, { evidence: result.evidence }, 200, result.pagination);
    } catch (error) {
      next(error);
    }
  },
);

handymanFieldEvidenceRouter.post(
  '/handyman/field/evidence/presign',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await createPresignedFieldEvidenceIntent(
        req.auth.userId,
        req.body ?? {},
      );
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) {
      next(error);
    }
  },
);

handymanFieldEvidenceRouter.put(
  '/handyman/field/evidence/:evidenceId/bytes',
  express.raw({
    type: '*/*',
    limit: HANDYMAN_FIELD_EVIDENCE_MAX_BYTES,
  }),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const rawBuffer = Buffer.isBuffer(req.body) ? req.body : undefined;
      const evidence = await putStagedFieldEvidenceBytes(
        req.auth.userId,
        String(req.params.evidenceId),
        rawBuffer,
      );
      sendSuccess(res, { evidence }, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanFieldEvidenceRouter.post(
  '/handyman/field/evidence/:evidenceId/confirm',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const evidence = await confirmFieldEvidenceUpload(
        req.auth.userId,
        String(req.params.evidenceId),
      );
      sendSuccess(res, { evidence }, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanFieldEvidenceRouter.get(
  '/handyman/field/evidence/:evidenceId',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const evidence = await getFieldEvidenceMetadata(
        req.auth.userId,
        String(req.params.evidenceId),
      );
      sendSuccess(res, { evidence }, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanFieldEvidenceRouter.get(
  '/handyman/field/evidence/:evidenceId/content',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const { record, buffer } = await readFieldEvidenceBytes(
        req.auth.userId,
        String(req.params.evidenceId),
      );
      res.setHeader('Content-Type', record.mimeType);
      res.setHeader('Content-Length', String(buffer.byteLength));
      if (record.sha256Checksum) {
        res.setHeader('X-Content-SHA256', record.sha256Checksum);
      }
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${record.originalFileName.replace(/"/g, '')}"`,
      );
      res.status(200).send(buffer);
    } catch (error) {
      next(error);
    }
  },
);
