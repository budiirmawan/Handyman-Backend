import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityVisitorBindingService } from './security-visitor-binding.service';
import {
  parseCreateSecurityVisitorBindingBody,
  parseSecurityVisitorBindingIdParam,
  parseSecurityVisitorBindingListQuery,
  parseUpdateSecurityVisitorBindingBody,
} from './security-visitor-binding.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /security/visitor-bindings
 *
 * Creates a new Visitor / Security binding. The
 * `externalVisitReference` is a free-form string that a future
 * authoritative Visitor / Visit domain can later match against its
 * id. No visitor personal data is stored.
 */
export async function createSecurityVisitorBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateSecurityVisitorBindingBody(req.body);
    const result =
      await securityVisitorBindingService.createSecurityVisitorBinding(
        { ...body, createdByUserId: req.auth.userId },
        req.auth.userId,
      );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /security/visitor-bindings
 *   ?buildingId=&securityPostId=&securityWorkforceId=&externalVisitReference=&status=
 */
export async function listSecurityVisitorBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseSecurityVisitorBindingListQuery(
      req.query as Record<string, unknown>,
    );
    const results =
      await securityVisitorBindingService.listSecurityVisitorBindings(
        filters,
        req.auth.userId,
      );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /security/visitor-bindings/:id */
export async function getSecurityVisitorBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityVisitorBindingIdParam(paramString(req.params.id));
    const result =
      await securityVisitorBindingService.getSecurityVisitorBinding(
        id,
        req.auth.userId,
      );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /security/visitor-bindings/:id */
export async function updateSecurityVisitorBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityVisitorBindingIdParam(paramString(req.params.id));
    const body = parseUpdateSecurityVisitorBindingBody(req.body);
    const result =
      await securityVisitorBindingService.updateSecurityVisitorBinding(
        id,
        body,
        req.auth.userId,
      );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
