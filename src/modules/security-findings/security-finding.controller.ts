import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityFindingService } from './security-finding.service';
import {
  parseCreateSecurityFindingBody,
  parseListSecurityFindingsQuery,
  parseSecurityFindingIdParam,
} from './security-finding.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /security/findings
 *
 * Creates / links a BE-09 Finding from a Security operational source
 * (Patrol Execution / Patrol Checklist / Security Daily Activity /
 * Shift Handover / Security Post). The Finding is created in OPEN state
 * through BE-09; the Security context lives on the new link row only.
 */
export async function createSecurityFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateSecurityFindingBody(req.body);
    const result = await securityFindingService.createSecurityFinding(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /security/findings
 *   ?buildingId=&startSecurityPostId=&patrolRouteId=&sourceType=&status=
 */
export async function listSecurityFindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseListSecurityFindingsQuery(
      req.query as Record<string, unknown>,
    );
    const results = await securityFindingService.listSecurityFindings(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /security/findings/:id */
export async function getSecurityFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityFindingIdParam(paramString(req.params.id));
    const result = await securityFindingService.getSecurityFinding(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
