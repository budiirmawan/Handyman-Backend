import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { handymanDispatchService } from '../handyman-dispatch';
import { handymanIdentityProjectionService } from '../handyman-identity-projection';
import {
  parseCancelBody,
  parseReleaseBody,
  parseRequestParam,
  parseScopeParam,
} from './handyman-dispatch-api.validation';

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getDispatchReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const scopeId = parseScopeParam(req.params.executionScopeId);
    sendSuccess(
      res,
      await handymanDispatchService.evaluateDispatchReadiness(
        scopeId,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function postDispatchReleaseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const scopeId = parseScopeParam(req.params.executionScopeId);
    const body = parseReleaseBody(req.body);
    sendSuccess(
      res,
      await handymanDispatchService.releaseHandymanDispatch(
        { executionScopeId: scopeId, appointmentId: body.appointmentId },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getDispatchReleaseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const scopeId = parseScopeParam(req.params.executionScopeId);
    const release = await handymanDispatchService.getActiveDispatchRelease(
      scopeId,
      actor(req),
    );
    if (!release) {
      const { handymanDispatchReleaseNotFoundError } = await import(
        '../handyman-dispatch'
      );
      throw handymanDispatchReleaseNotFoundError();
    }
    sendSuccess(res, release);
  } catch (error) {
    next(error);
  }
}

export async function postDispatchCancelHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const scopeId = parseScopeParam(req.params.executionScopeId);
    const { reason } = parseCancelBody(req.body);
    sendSuccess(
      res,
      await handymanDispatchService.cancelDispatchRelease(
        scopeId,
        reason,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getCanonicalIdentityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseRequestParam(req.params.handymanRequestId);
    sendSuccess(
      res,
      await handymanIdentityProjectionService.projectHandymanCanonicalIdentity(
        requestId,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
