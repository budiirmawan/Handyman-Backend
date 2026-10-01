import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  readHandymanExecutionScopeStatusVisibility,
  readHandymanProviderPerformanceView,
  readHandymanRequestStatusVisibility,
  readHandymanSubjectSlaView,
} from './handyman-sla-status-api.service';

/**
 * CR-HM-17 GAP PART 07 — Thin Customer Care GET handlers over CR-HM-16
 * SLA subject/milestone/provider-performance contracts and CR-HM-02..16
 * authoritative stage/status visibility.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getHandymanSubjectSlaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readHandymanSubjectSlaView(
      actor(req),
      p(req.params.subjectType),
      p(req.params.subjectId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanProviderPerformanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readHandymanProviderPerformanceView(actor(req), {
      clientId: req.query.clientId,
      buildingId: req.query.buildingId,
      from: req.query.from,
      to: req.query.to,
    });
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanRequestStatusVisibilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readHandymanRequestStatusVisibility(
      actor(req),
      p(req.params.id ?? req.params.handymanRequestId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanExecutionScopeStatusVisibilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readHandymanExecutionScopeStatusVisibility(
      actor(req),
      p(req.params.id ?? req.params.executionScopeId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}
