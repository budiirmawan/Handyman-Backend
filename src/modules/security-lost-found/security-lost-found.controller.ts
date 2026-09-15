import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityLostFoundService } from './security-lost-found.service';
import {
  parseCloseBody,
  parseCreateSecurityLostFoundBody,
  parsePlaceCustodyBody,
  parseRegisterClaimBody,
  parseReturnBody,
  parseSecurityLostFoundIdParam,
  parseSecurityLostFoundListQuery,
  parseUpdateSecurityLostFoundBody,
} from './security-lost-found.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** POST /security/lost-found */
export async function createSecurityLostFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateSecurityLostFoundBody(req.body);
    const result = await securityLostFoundService.createSecurityLostFound(
      { ...body, foundByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /security/lost-found */
export async function listSecurityLostFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseSecurityLostFoundListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await securityLostFoundService.listSecurityLostFound(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /security/lost-found/:id */
export async function getSecurityLostFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityLostFoundIdParam(paramString(req.params.id));
    const result = await securityLostFoundService.getSecurityLostFound(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /security/lost-found/:id */
export async function updateSecurityLostFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityLostFoundIdParam(paramString(req.params.id));
    const body = parseUpdateSecurityLostFoundBody(req.body);
    const result = await securityLostFoundService.updateSecurityLostFound(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /security/lost-found/:id/custody */
export async function placeInCustodyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityLostFoundIdParam(paramString(req.params.id));
    const body = parsePlaceCustodyBody(req.body);
    const result = await securityLostFoundService.placeInCustody(
      { lostFoundId: id, notes: body.notes, actorUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /security/lost-found/:id/claim */
export async function registerClaimHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityLostFoundIdParam(paramString(req.params.id));
    const body = parseRegisterClaimBody(req.body);
    const result = await securityLostFoundService.registerClaim(
      { lostFoundId: id, actorUserId: req.auth.userId, ...body },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/** POST /security/lost-found/:id/return */
export async function returnSecurityLostFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityLostFoundIdParam(paramString(req.params.id));
    const body = parseReturnBody(req.body);
    const result = await securityLostFoundService.returnSecurityLostFound(
      { lostFoundId: id, ...body },
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /security/lost-found/:id/close */
export async function closeSecurityLostFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityLostFoundIdParam(paramString(req.params.id));
    const body = parseCloseBody(req.body);
    const result = await securityLostFoundService.closeSecurityLostFound(
      { lostFoundId: id, notes: body.notes, actorUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** GET /security/lost-found/:id/history */
export async function getSecurityLostFoundHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityLostFoundIdParam(paramString(req.params.id));
    const result = await securityLostFoundService.getSecurityLostFoundHistory(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
