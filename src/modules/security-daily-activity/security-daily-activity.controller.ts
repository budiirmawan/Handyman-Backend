import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityDailyActivityService } from './security-daily-activity.service';
import { parseSecurityDailyActivityQuery } from './security-daily-activity.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * GET /buildings/:buildingId/security/daily-activity?date=&shiftId=&securityPostId=
 */
export async function getSecurityDailyActivityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const buildingId = paramString(req.params.buildingId);
    const filter = parseSecurityDailyActivityQuery(
      req.query as Record<string, unknown>,
    );
    const result =
      await securityDailyActivityService.getSecurityDailyActivity(
        buildingId,
        filter,
        req.auth.userId,
      );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
