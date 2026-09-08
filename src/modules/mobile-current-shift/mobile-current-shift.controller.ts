import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { mobileCurrentShiftService } from './mobile-current-shift.service';
import { parseUpcomingShiftsQuery } from './mobile-current-shift.validation';

/**
 * BE-25M — Mobile Current Shift handler.
 *
 *   GET /mobile/current-shift
 *
 * Authentication-only self-service: the response is the caller's own roster
 * resolved from the authenticated session (`req.auth.userId`) — never a
 * caller-supplied identity and never the generic Shift CRUD surface.
 */
export async function getCurrentShiftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await mobileCurrentShiftService.resolveCurrentShifts(
      req.auth.userId,
    );
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-MOB-05 PART 01 — Mobile Upcoming Shifts handler.
 *
 *   GET /mobile/upcoming-shifts?dateFrom=&dateTo=
 *
 * Authentication-only self-service: the response is the caller's own
 * current/future shift schedule resolved from the authenticated session
 * (`req.auth.userId`) — never a caller-supplied identity, never the generic
 * Shift CRUD surface, and never attendance/roster state invented here. The
 * optional `dateFrom` / `dateTo` query parameters bound the roster effective
 * window and are validated exactly like the BE-23G reporting window.
 */
export async function getUpcomingShiftsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseUpcomingShiftsQuery(
      req.query as Record<string, unknown>,
    );
    const context = await mobileCurrentShiftService.resolveUpcomingShifts(
      req.auth.userId,
      filters,
    );
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}
