import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  assignHandymanJobProviderAndCrew,
  createHandymanJob,
  getHandymanJobById,
  listHandymanJobAssignments,
  listHandymanJobs,
  reassignHandymanJobProviderAndCrew,
} from './handyman-job.service';
import {
  parseAssignHandymanJobHttpBody,
  parseCreateHandymanJobHttpBody,
  parseHandymanJobIdParam,
  parseListHandymanJobsHttpQuery,
} from './handyman-job.validation';

/**
 * CR-HM-BE-05 RUN 3 — Thin HTTP handlers for Handyman Job creation/reads and
 * the governed provider+crew composition commands. All authority lives in the
 * Run-1 service: request-approval binding, idempotent creation, the atomic
 * BE-15A/BE-15B composition, time-of-use eligibility revalidation and the
 * pre-execution reassignment guards. These handlers ONLY parse governed
 * inputs, derive the actor from the authenticated session (never from the
 * body/query), and delegate; the controller never composes BE-15A/BE-15B
 * itself and never exposes Work Order lifecycle mutation. Errors flow to the
 * shared Express error pipeline via `next(error)` with their domain codes
 * and statuses intact.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createHandymanJobHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateHandymanJobHttpBody(req.body);
    const result = await createHandymanJob(
      { handymanRequestId: body.handymanRequestId },
      actor(req),
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanJobsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseListHandymanJobsHttpQuery(req.query);
    const jobs = await listHandymanJobs(
      query.clientId,
      actor(req),
      {
        ...(query.handymanRequestId
          ? { handymanRequestId: query.handymanRequestId }
          : {}),
        ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}),
      },
    );
    sendSuccess(res, jobs);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanJobHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const job = await getHandymanJobById(jobId, actor(req));
    sendSuccess(res, job);
  } catch (error) {
    next(error);
  }
}

export async function assignHandymanJobHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const body = parseAssignHandymanJobHttpBody(req.body);
    const result = await assignHandymanJobProviderAndCrew(
      jobId,
      {
        handymanProviderId: body.handymanProviderId,
        handymanWorkCrewId: body.handymanWorkCrewId,
      },
      actor(req),
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function reassignHandymanJobHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const body = parseAssignHandymanJobHttpBody(req.body);
    const result = await reassignHandymanJobProviderAndCrew(
      jobId,
      {
        handymanProviderId: body.handymanProviderId,
        handymanWorkCrewId: body.handymanWorkCrewId,
      },
      actor(req),
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanJobAssignmentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const assignments = await listHandymanJobAssignments(jobId, actor(req));
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}
