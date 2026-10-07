import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  requestMobileReadingRecheckHandler,
  resolveMobileReadingRecheckHandler,
  submitMobileReadingRereadHandler,
} from './mobile-utility-meter-reading-lifecycle.controller';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — mobile field reading lifecycle.
 *
 *   POST /mobile/utility-reading-dues/:readingDueId/readings/:readingId/recheck
 *   POST .../readings/:readingId/recheck/:recheckId/reread
 *   POST .../readings/:readingId/recheck/:recheckId/resolve
 *
 * The minimum field commands that close the lifecycle: request a recheck, submit
 * the reread, and resolve it by confirming the original OR accepting the
 * replacement. There is no field route to list rechecks — the reading DETAIL
 * projects them, bounded, together with the caller-specific `availableActions`.
 *
 * ROUTE SHAPE
 * -----------
 * The PART 01 prefix, extended — addressed by the FIELD EXECUTION (the Reading
 * Due) and the reading it produced, then by the recheck itself. Never by a bare
 * meter id, and never by a bare exception id: the `:recheckId` segment is only
 * honoured when that register row is a `READING_RECHECK` of THIS reading.
 *
 * The reading detail route itself stays registered in PART 01's router (it is
 * PART 01's contract); PART 03 supplies its enriched handler, so there is exactly
 * one registration of that path and no duplicate route can shadow it.
 *
 * THREE GATES ON EVERY ROUTE
 * --------------------------
 *   1. `authenticationMiddleware` — an authenticated session.
 *   2. `requirePermission('utility_meter.field.record')` — PART 01's field WRITE
 *      code, reused rather than extended. Requesting a recheck, staging a reread
 *      and resolving it are acts of recording and correcting a field reading,
 *      which is exactly what that code already grants; PART 03 seeds no new
 *      permission. It is NOT `utility_meter.manage` (the register's management
 *      gate, which also owns severity re-triage and cancellation), NOT
 *      `utility_meter.field.evidence` (PART 02's evidence capability) and NOT
 *      `utility_meter.field.read` (which governs the detail projection, and must
 *      not grant a write).
 *   3. `authorizeFieldReading` in the service — PART 02's exported reading-keyed
 *      authority: the seam over PART 00's due-keyed field-actor rule, plus the
 *      requirement that the path's `:readingDueId` is the due that produced the
 *      reading. The SAME rule, in the SAME order, as every PART 02 route.
 *
 * A reading with no field due behind it is not field-accessible here, and no
 * weaker gate is substituted for the missing assignment.
 *
 * WHAT THIS SURFACE DELIBERATELY DOES NOT DO
 * ------------------------------------------
 * No edit and no delete of a reading — BE-18E readings stay append-only and
 * immutable. No new lifecycle state: OPEN / UNDER_REVIEW / RESOLVED / CANCELLED
 * are the exception register's own. No second workflow engine, no recheck table,
 * no consumption recalculation, no abnormality evaluation, no billing or tariff
 * involvement, no OCR, no QR, and no BE-25H `METER_READING` change. Client-side
 * inference is not required anywhere: the outcome of a resolution and the actions
 * a caller may take are both projected by the backend.
 */
export function createMobileUtilityMeterReadingLifecycleRouter(): Router {
  const router = Router();
  const fieldRecord = requirePermission('utility_meter.field.record');

  router.post(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/recheck',
    authenticationMiddleware,
    fieldRecord,
    requestMobileReadingRecheckHandler,
  );

  router.post(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/recheck/:recheckId/reread',
    authenticationMiddleware,
    fieldRecord,
    submitMobileReadingRereadHandler,
  );

  router.post(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId/recheck/:recheckId/resolve',
    authenticationMiddleware,
    fieldRecord,
    resolveMobileReadingRecheckHandler,
  );

  return router;
}
