import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  confirmMobileReadingOcrCandidateHandler,
  listMobileReadingAbnormalSignalsHandler,
  listMobileReadingEvidenceHandler,
  listMobileReadingOcrCandidatesHandler,
  rejectMobileReadingOcrCandidateHandler,
  removeMobileReadingEvidenceHandler,
  uploadMobileReadingEvidenceHandler,
  validateMobileReadingEvidenceHandler,
} from './mobile-utility-meter-reading-verification.controller';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — mobile field reading evidence and
 * verification.
 *
 * Evidence (BE-18F is the authority, this is its field-safe door):
 *   POST  /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence
 *   GET   /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence
 *   GET   /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence-validation
 *   PATCH /mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence/:evidenceId
 * OCR suggestions and the human decision on them (BE-18 is the authority):
 *   GET   /mobile/utility-reading-dues/:readingDueId/readings/:readingId/ocr-candidates
 *   POST  .../readings/:readingId/ocr-candidates/:candidateId/confirm
 *   POST  .../readings/:readingId/ocr-candidates/:candidateId/reject
 * Persisted downstream signal (BE-18G → BE-18J, read only):
 *   GET   /mobile/utility-reading-dues/:readingDueId/readings/:readingId/abnormal-signals
 *
 * All eight require `utility_meter.field.evidence`.
 *
 * ROUTE SHAPE
 * -----------
 * The PART 01 prefix, extended — addressed by the FIELD EXECUTION (the Reading
 * Due) and the reading it produced, never by a bare meter id. The reading detail
 * route itself stays registered in PART 01's router (it is PART 01's contract);
 * PART 02 supplies its enriched handler, so there is exactly one registration of
 * that path and no duplicate route can shadow it.
 *
 * THREE GATES ON EVERY ROUTE
 * --------------------------
 *   1. `authenticationMiddleware` — an authenticated session.
 *   2. `requirePermission('utility_meter.field.evidence')` — a DEDICATED field
 *      code, separate from PART 00's `utility_meter.field.read` and PART 01's
 *      `utility_meter.field.record` so the three capabilities can be granted and
 *      revoked independently. It is NOT `utility_meter.manage` (meter
 *      administration, and the authority behind the BE-18F management evidence
 *      routes and the BE-18 OCR routes), NOT `utility_meter.read` (dashboard
 *      visibility), NOT `evidence.manage` / `evidence.read` (the generic BE-07
 *      engine, which is Client-scoped and has no notion of a field execution)
 *      and NOT `meter_reading_binding.manage` (BE-10C engineering bindings).
 *      No role name is consulted anywhere in this chain.
 *   3. `assertUtilityMeterReadingFieldActor(readingId, actorUserId)` in the
 *      service — the reading-keyed seam that resolves the reading's uniquely
 *      linked Reading Due and delegates to the PART 00 authority (assignment to
 *      that due's generated task, then BE-02G Building access), then re-asserts
 *      that the path's `readingDueId` is that due. Gate 3 is what makes the
 *      permission safe: `utility_meter.field.evidence` alone grants nothing on
 *      any particular reading.
 *
 * A reading with no field due behind it — posted through a management route, the
 * BE-10C engineering workflow, an import, or an OCR acceptance that supplied
 * `readingAt` — is NOT field-accessible through any route here, and no weaker
 * gate is substituted for the missing assignment.
 *
 * WHAT THIS SURFACE DELIBERATELY DOES NOT DO
 * ------------------------------------------
 * No OCR or vision engine, and no candidate creation: candidates are only read
 * and decided, never produced from an image. No abnormality rule engine,
 * threshold or evaluation, and no consumption creation: signals are only read.
 * No recheck or correction lifecycle, no `availableActions` for a reading, no QR
 * resolution, no mobile-sync resource kind, no BE-25H `METER_READING` change and
 * no billing or tariff involvement. No second evidence table and no second upload
 * path: writes go through BE-18F and the shared storage abstraction, and removal
 * is BE-07's soft remove. A missing required photo changes
 * `evidence-validation` and nothing else — it never rejects, reopens or deletes a
 * genuine reading.
 */
export function createMobileUtilityMeterReadingVerificationRouter(): Router {
  const router = Router();
  const fieldEvidence = requirePermission('utility_meter.field.evidence');

  router.post(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence',
    authenticationMiddleware,
    fieldEvidence,
    uploadMobileReadingEvidenceHandler,
  );

  router.get(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence',
    authenticationMiddleware,
    fieldEvidence,
    listMobileReadingEvidenceHandler,
  );

  router.get(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence-validation',
    authenticationMiddleware,
    fieldEvidence,
    validateMobileReadingEvidenceHandler,
  );

  router.patch(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/evidence/:evidenceId',
    authenticationMiddleware,
    fieldEvidence,
    removeMobileReadingEvidenceHandler,
  );

  router.get(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/ocr-candidates',
    authenticationMiddleware,
    fieldEvidence,
    listMobileReadingOcrCandidatesHandler,
  );

  router.post(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/ocr-candidates/:candidateId/confirm',
    authenticationMiddleware,
    fieldEvidence,
    confirmMobileReadingOcrCandidateHandler,
  );

  router.post(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/ocr-candidates/:candidateId/reject',
    authenticationMiddleware,
    fieldEvidence,
    rejectMobileReadingOcrCandidateHandler,
  );

  router.get(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/abnormal-signals',
    authenticationMiddleware,
    fieldEvidence,
    listMobileReadingAbnormalSignalsHandler,
  );

  return router;
}
