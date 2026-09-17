import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  assessHandymanServiceVisitExecutionReadiness,
  cancelHandymanServiceVisitSchedule,
  createHandymanServiceVisit,
  getHandymanServiceVisitById,
  listHandymanServiceVisitSchedules,
  listHandymanServiceVisitsByJob,
  rescheduleHandymanServiceVisit,
} from './handyman-service-visit.service';
import { parseHandymanJobIdParam } from './handyman-job.validation';
import {
  assertEmptyCancelHandymanServiceVisitHttpBody,
  parseCreateHandymanServiceVisitHttpBody,
  parseHandymanServiceVisitIdParam,
  parseRescheduleHandymanServiceVisitHttpBody,
} from './handyman-service-visit.validation';

/**
 * CR-HM-BE-05 RUN 3 — Thin HTTP handlers for Handyman Service Visit
 * scheduling: occurrence creation, versioned schedule windows (reschedule /
 * cancel), the visit + schedule-history reads and the pure execution-readiness
 * assessment. All authority lives in the Run-2 service: schedule-time
 * revalidation, temporal crew/worker conflict protection, one-ACTIVE-window
 * invariants, guarded closure and the BE-15D permit-readiness passthrough.
 * These handlers ONLY parse governed inputs, derive the actor from the
 * authenticated session (never from the body), and delegate — no schedule-row
 * CRUD, no execution transition and no event side effect is introduced here.
 * Errors flow to the shared Express error pipeline via `next(error)` with
 * their domain codes and statuses intact.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createHandymanServiceVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const body = parseCreateHandymanServiceVisitHttpBody(req.body);
    const result = await createHandymanServiceVisit(
      {
        handymanJobId: jobId,
        plannedStartAt: body.plannedStartAt,
        plannedEndAt: body.plannedEndAt,
      },
      actor(req),
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanJobServiceVisitsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const visits = await listHandymanServiceVisitsByJob(jobId, actor(req));
    sendSuccess(res, visits);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanServiceVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const visit = await getHandymanServiceVisitById(visitId, actor(req));
    sendSuccess(res, visit);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanServiceVisitSchedulesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const schedules = await listHandymanServiceVisitSchedules(
      visitId,
      actor(req),
    );
    sendSuccess(res, schedules);
  } catch (error) {
    next(error);
  }
}

export async function rescheduleHandymanServiceVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const body = parseRescheduleHandymanServiceVisitHttpBody(req.body);
    const result = await rescheduleHandymanServiceVisit(
      visitId,
      {
        plannedStartAt: body.plannedStartAt,
        plannedEndAt: body.plannedEndAt,
      },
      actor(req),
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function cancelHandymanServiceVisitScheduleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    assertEmptyCancelHandymanServiceVisitHttpBody(req.body);
    const result = await cancelHandymanServiceVisitSchedule(
      visitId,
      actor(req),
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function assessHandymanServiceVisitExecutionReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const readiness = await assessHandymanServiceVisitExecutionReadiness(
      visitId,
      actor(req),
    );
    sendSuccess(res, readiness);
  } catch (error) {
    next(error);
  }
}
