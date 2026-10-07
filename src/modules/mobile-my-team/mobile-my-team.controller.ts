import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { mobileMyTeamService } from './mobile-my-team.service';

/**
 * BE-25N — Mobile My Team handler.
 *
 *   GET /mobile/my-team
 *
 * Authentication-only self-service: the response is the caller's own team and
 * its members, resolved from the authenticated session (`req.auth.userId`) —
 * never a caller-supplied workforceProfileId / teamId and never the generic
 * Team CRUD surface.
 */
export async function getMyTeamHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await mobileMyTeamService.resolveMyTeamContext(
      req.auth.userId,
    );
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}
