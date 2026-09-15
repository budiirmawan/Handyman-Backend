import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { attendanceService } from './attendance.service';
import { parseClockInBody } from './attendance.validation';

/**
 * CR-BE-MOB-05 PART 02 — Attendance controllers.
 *
 * All three endpoints are self-service: identity is resolved from the
 * authenticated session (`req.auth.userId`) and never accepted from the
 * body. Timestamps are set by the backend — no clock field is ever read
 * from the request.
 */

/** POST /attendance/clock-in */
export async function clockInHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseClockInBody(req.body as Record<string, unknown>);
    const record = await attendanceService.clockInAttendance(
      input,
      req.auth.userId,
    );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** POST /attendance/clock-out — no payload; the open record is session-resolved. */
export async function clockOutHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const record = await attendanceService.clockOutAttendance(req.auth.userId);
    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}

/** GET /attendance/current — the caller's open record, or null. */
export async function getCurrentAttendanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const record = await attendanceService.getCurrentAttendance(
      req.auth.userId,
    );
    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}
