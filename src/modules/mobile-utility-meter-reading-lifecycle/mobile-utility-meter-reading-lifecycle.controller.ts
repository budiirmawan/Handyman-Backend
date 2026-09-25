import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  parseMobileReadingDueIdParam,
  parseMobileReadingIdParam,
  parseMobileUtilityMeterReadingBody,
} from '../mobile-utility-meter-reading/mobile-utility-meter-reading.validation';
import { mobileUtilityMeterReadingLifecycleService as service } from './mobile-utility-meter-reading-lifecycle.service';
import {
  parseMobileReadingRecheckIdParam,
  parseMobileReadingRecheckRequestBody,
  parseMobileReadingRecheckResolveBody,
} from './mobile-utility-meter-reading-lifecycle.validation';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — mobile field reading lifecycle handlers.
 *
 * The actor comes from the authenticated session only; the reading, its Reading
 * Due and the recheck come from the path only; the measurement facts of a reread
 * come from the body and are parsed by PART 01's own parser. Nothing about the
 * meter, the Client, the Building, the exception type, the severity, the status
 * or the replacement reading is accepted from the caller.
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
 * POST /mobile/utility-reading-dues/:readingDueId/readings/:readingId/recheck
 *
 * Files the recheck (register status OPEN). 201: a new authoritative row exists.
 */
export async function requestMobileReadingRecheckHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(param(req.params.readingDueId));
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const input = parseMobileReadingRecheckRequestBody(req.body);
    const result = await service.requestMobileReadingRecheck(
      readingDueId,
      readingId,
      req.auth.userId,
      input,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * POST .../readings/:readingId/recheck/:recheckId/reread
 *
 * Stages the re-read measurement and opens the review (OPEN → UNDER_REVIEW). 200:
 * an existing authoritative row transitioned. NO reading is created here.
 */
export async function submitMobileReadingRereadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(param(req.params.readingDueId));
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const recheckId = parseMobileReadingRecheckIdParam(param(req.params.recheckId));
    // PART 01's own parser: a reread states exactly what an online field submit
    // states, and is held to exactly the same rule.
    const input = parseMobileUtilityMeterReadingBody(req.body);
    const result = await service.submitMobileReadingReread(
      readingDueId,
      readingId,
      recheckId,
      req.auth.userId,
      input,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST .../readings/:readingId/recheck/:recheckId/resolve
 *
 * CONFIRM_ORIGINAL closes the recheck and creates nothing; ACCEPT_REPLACEMENT
 * creates the canonical replacement reading and links it, atomically. 200.
 */
export async function resolveMobileReadingRecheckHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(param(req.params.readingDueId));
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const recheckId = parseMobileReadingRecheckIdParam(param(req.params.recheckId));
    const input = parseMobileReadingRecheckResolveBody(req.body);
    const result = await service.resolveMobileReadingRecheck(
      readingDueId,
      readingId,
      recheckId,
      req.auth.userId,
      input,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings/:readingId
 *
 * The reading DETAIL: PART 02's enriched projection plus `rechecks` and the
 * caller-specific `availableActions`. Registered in PART 01's router, so the path
 * has exactly one registration.
 */
export async function getMobileUtilityMeterReadingLifecycleDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(param(req.params.readingDueId));
    const readingId = parseMobileReadingIdParam(param(req.params.readingId));
    const detail = await service.getMobileUtilityMeterReadingLifecycleDetail(
      readingDueId,
      readingId,
      req.auth.userId,
    );
    sendSuccess(res, detail);
  } catch (error) {
    next(error);
  }
}
