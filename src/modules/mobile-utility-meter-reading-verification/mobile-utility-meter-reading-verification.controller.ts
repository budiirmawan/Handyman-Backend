import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationRequiredError } from '../auth';
import { MAX_EVIDENCE_FILE_BYTES } from '../evidence/evidence-file.routes';
import {
  parseMobileReadingDueIdParam,
  parseMobileReadingIdParam,
} from '../mobile-utility-meter-reading/mobile-utility-meter-reading.validation';
import {
  mobileUtilityMeterReadingVerificationService as service,
  type MobileReadingEvidenceFile,
} from './mobile-utility-meter-reading-verification.service';
import {
  parseMobileOcrCandidateIdParam,
  parseMobileReadingEvidenceIdParam,
  parseMobileReadingEvidenceUploadFields,
  parseMobileReadingOcrConfirmBody,
  parseMobileReadingOcrRejectBody,
} from './mobile-utility-meter-reading-verification.validation';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — mobile field reading-verification
 * handlers.
 *
 * The actor comes from the authenticated session only; the reading, its due, the
 * evidence id and the candidate id come from the path only. Nothing about the
 * meter, the Client, the Building, the storage location or the accepted reading
 * is accepted from the caller.
 *
 * Every handler runs the field-authority seam inside the service before touching
 * a row, so authorization is never reduced to the permission on the route.
 */

function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * Multipart handling for the field evidence upload, on the BE-25E / CR-BE-API-01
 * convention: one file, in memory, under the shared 50 MB evidence ceiling.
 *
 * Memory storage is what both existing evidence doors use, so bytes land in the
 * same storage abstraction the same way; nothing is written to PostgreSQL and no
 * temporary file path is involved.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_FILE_BYTES, files: 1 },
});

function runSingleFileUpload(
  req: Request,
  res: Response,
): Promise<Express.Multer.File> {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error) {
        if (
          error instanceof multer.MulterError &&
          error.code === 'LIMIT_FILE_SIZE'
        ) {
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

/**
 * POST /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence
 *
 * Single-call field upload: the multipart `file` plus the text fields
 * `evidenceType` (required), `evidenceRequirementId?`, `capturedAt?` and
 * `originalFileName?`. The multipart body must be parsed before the text fields
 * are readable, which is why the file is consumed first.
 */
export async function uploadMobileReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const file = await runSingleFileUpload(req, res);
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const fields = parseMobileReadingEvidenceUploadFields(req.body);
    const evidenceFile: MobileReadingEvidenceFile = {
      buffer: file.buffer,
      mimeType: file.mimetype,
      size: file.size,
      originalName: file.originalname,
    };
    const evidence = await service.submitMobileReadingEvidenceFile({
      readingDueId,
      readingId,
      actorUserId: req.auth.userId,
      file: evidenceFile,
      fields,
    });
    sendSuccess(res, evidence, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence
 *
 * The ACTIVE evidence of this reading. REMOVED rows are preserved history and
 * are not listed here.
 */
export async function listMobileReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const evidence = await service.listMobileReadingEvidence(
      readingDueId,
      readingId,
      req.auth.userId,
    );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence-validation
 *
 * Canonical BE-18F readiness, verbatim. Reported only — it never gates the
 * reading.
 */
export async function validateMobileReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const readiness = await service.validateMobileReadingEvidence(
      readingDueId,
      readingId,
      req.auth.userId,
    );
    sendSuccess(res, readiness);
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence/:evidenceId
 *
 * BE-07 soft remove (`status → 'REMOVED'`) of one of THIS reading's submissions.
 * An evidence id belonging to another reading is 404.
 */
export async function removeMobileReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const evidenceId = parseMobileReadingEvidenceIdParam(
      param(req.params.evidenceId),
    );
    const removed = await service.removeMobileReadingEvidence(
      readingDueId,
      readingId,
      evidenceId,
      req.auth.userId,
    );
    sendSuccess(res, removed);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings/:readingId/ocr-candidates
 *
 * The EXISTING candidates staged from this reading's PHOTO evidence, as
 * suggestions. Bounded, newest first. No candidate is created here.
 */
export async function listMobileReadingOcrCandidatesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const candidates = await service.listMobileReadingOcrCandidates(
      readingDueId,
      readingId,
      req.auth.userId,
    );
    sendSuccess(res, candidates);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /mobile/utility-reading-dues/:readingDueId/readings/:readingId/ocr-candidates/:candidateId/confirm
 *
 * Confirms a suggestion against the reading already recorded for this due. Body
 * is `{ notes? }` only — `readingAt`, `meterReadingId` and `readingDueId` are
 * refused explicitly, so a confirmation can never create a reading, point a
 * candidate at another reading, or complete a due twice.
 */
export async function confirmMobileReadingOcrCandidateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const candidateId = parseMobileOcrCandidateIdParam(
      param(req.params.candidateId),
    );
    const input = parseMobileReadingOcrConfirmBody(req.body);
    const result = await service.confirmMobileReadingOcrCandidate(
      readingDueId,
      readingId,
      candidateId,
      req.auth.userId,
      input,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /mobile/utility-reading-dues/:readingDueId/readings/:readingId/ocr-candidates/:candidateId/reject
 *
 * Rejects a suggestion. Body is `{ decisionNotes }`, required — BE-18's decision
 * constraint makes a rejection reason mandatory. The reading is not mutated.
 */
export async function rejectMobileReadingOcrCandidateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const candidateId = parseMobileOcrCandidateIdParam(
      param(req.params.candidateId),
    );
    const input = parseMobileReadingOcrRejectBody(req.body);
    const result = await service.rejectMobileReadingOcrCandidate(
      readingDueId,
      readingId,
      candidateId,
      req.auth.userId,
      input,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings/:readingId/abnormal-signals
 *
 * The persisted BE-18G → BE-18J signal linked to this reading. Read-only: no
 * consumption is calculated and no abnormality is evaluated by this call.
 */
export async function listMobileReadingAbnormalSignalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const projection = await service.listMobileReadingAbnormalSignals(
      readingDueId,
      readingId,
      req.auth.userId,
    );
    sendSuccess(res, projection);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings/:readingId
 *
 * The PART 01 detail route, extended: PART 01's bounded reading plus
 * `evidenceValidation`, `evidenceSummary`, `ocrCandidates` and `abnormalSignals`.
 * Strictly additive, so a client built against PART 01 reads it unchanged.
 *
 * Authorized by `utility_meter.field.read` (the PART 01 read authority) — the
 * detail is a read, and the four projections are read projections of the same
 * reading the actor is already authorized on.
 */
export async function getMobileUtilityMeterReadingDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const detail = await service.getMobileUtilityMeterReadingDetail(
      readingDueId,
      readingId,
      req.auth.userId,
    );
    sendSuccess(res, detail);
  } catch (error) {
    next(error);
  }
}
