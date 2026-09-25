import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import { mobileUtilityMeterReadingService } from './mobile-utility-meter-reading.service';
import {
  parseMobileReadingDueIdParam,
  parseMobileReadingIdParam,
  parseMobileReadingLimitQuery,
  parseMobileUtilityMeterReadingBody,
} from './mobile-utility-meter-reading.validation';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 01 — mobile field meter-reading handlers.
 *
 * The actor comes from the authenticated session only, and the target comes from
 * the `readingDueId` path parameter only. Nothing about the meter, its unit, the
 * client, the Building or the reading's provenance is accepted from the caller.
 */

function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /mobile/utility-reading-dues/:readingDueId/readings
 *
 * `Idempotency-Key` is REQUIRED. It is parsed before the service is entered, so
 * a missing or malformed key is a 400 that cannot poison any key namespace and
 * cannot reach the database. The raw key is never logged, stored or echoed: only
 * its SHA-256 hash is persisted, by the generic idempotency core.
 *
 * A first execution and a same-key replay both return 201 with the identical
 * stored body, so a client retrying an ambiguous outcome needs no special case.
 */
export async function recordMobileUtilityMeterReadingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const input = parseMobileUtilityMeterReadingBody(req.body);
    const rawHeader = req.headers['idempotency-key'];
    const idempotencyKey = parseIdempotencyKeyRequired(
      Array.isArray(rawHeader) ? rawHeader[0] : rawHeader,
    );
    const result =
      await mobileUtilityMeterReadingService.recordMobileUtilityMeterReading(
        readingDueId,
        req.auth.userId,
        input,
        idempotencyKey,
      );
    sendSuccess(res, result.data, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings
 *
 * Bounded canonical history of the DUE'S meter, newest first. The meter is
 * resolved from the Reading Due, so a field caller cannot point this list at an
 * arbitrary meter.
 */
export async function listMobileUtilityMeterReadingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const readingDueId = parseMobileReadingDueIdParam(
      param(req.params.readingDueId),
    );
    const limit = parseMobileReadingLimitQuery(req.query.limit);
    const readings =
      await mobileUtilityMeterReadingService.listMobileUtilityMeterReadings(
        readingDueId,
        req.auth.userId,
        limit,
      );
    sendSuccess(res, readings);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/readings/:readingId
 *
 * One canonical reading under its Reading Due context. A reading belonging to a
 * different meter is 404, never 403: a context mismatch does not confirm that
 * the row exists.
 */
export async function getMobileUtilityMeterReadingHandler(
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
    const reading =
      await mobileUtilityMeterReadingService.getMobileUtilityMeterReading(
        readingDueId,
        readingId,
        req.auth.userId,
      );
    sendSuccess(res, reading);
  } catch (error) {
    next(error);
  }
}
