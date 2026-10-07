import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { mobileUtilityMeterContextService } from './mobile-utility-meter-context.service';
import { parseMobileMeterContextReadingDueId } from './mobile-utility-meter-context.validation';

/** CR-BE-RN12-METER-FIELD-01 PART 00 — mobile field meter-context handler. */

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * GET /mobile/utility-reading-dues/:readingDueId/meter-context
 *
 * The actor comes from the authenticated session only. Every other input is
 * derived server-side from the Reading Due: meter, client, Building, generated
 * task and assignment authority. The caller cannot steer the target.
 */
export async function getMobileUtilityMeterContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const readingDueId = parseMobileMeterContextReadingDueId(
      paramString(req.params.readingDueId),
    );
    const context =
      await mobileUtilityMeterContextService.getMobileUtilityMeterContext(
        readingDueId,
        req.auth!.userId,
      );
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}
