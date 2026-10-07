import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityIncidentReadinessService } from './security-incident-readiness.service';
import {
  parseCreateSecurityIncidentReadinessBody,
  parseSecurityIncidentReadinessIdParam,
  parseSecurityIncidentReadinessListQuery,
  parseUpdateSecurityIncidentReadinessBody,
} from './security-incident-readiness.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** POST /security/incident-readiness */
export async function createSecurityIncidentReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateSecurityIncidentReadinessBody(req.body);
    const result =
      await securityIncidentReadinessService.createSecurityIncidentReadiness(
        { ...body, createdByUserId: req.auth.userId },
        req.auth.userId,
      );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /security/incident-readiness */
export async function listSecurityIncidentReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseSecurityIncidentReadinessListQuery(
      req.query as Record<string, unknown>,
    );
    const results =
      await securityIncidentReadinessService.listSecurityIncidentReadiness(
        filters,
        req.auth.userId,
      );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /security/incident-readiness/:id */
export async function getSecurityIncidentReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityIncidentReadinessIdParam(
      paramString(req.params.id),
    );
    const result =
      await securityIncidentReadinessService.getSecurityIncidentReadiness(
        id,
        req.auth.userId,
      );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /security/incident-readiness/:id */
export async function updateSecurityIncidentReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityIncidentReadinessIdParam(
      paramString(req.params.id),
    );
    const body = parseUpdateSecurityIncidentReadinessBody(req.body);
    const result =
      await securityIncidentReadinessService.updateSecurityIncidentReadiness(
        id,
        body,
        req.auth.userId,
      );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
