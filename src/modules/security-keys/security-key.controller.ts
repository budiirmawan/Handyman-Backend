import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityKeyService } from './security-key.service';
import {
  parseCreateSecurityKeyBody,
  parseIssueSecurityKeyBody,
  parseMarkKeyLostBody,
  parseReturnSecurityKeyBody,
  parseSecurityKeyIdParam,
  parseSecurityKeyListQuery,
  parseUpdateSecurityKeyBody,
} from './security-key.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** POST /security/keys */
export async function createSecurityKeyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateSecurityKeyBody(req.body);
    const result = await securityKeyService.createSecurityKey(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /security/keys */
export async function listSecurityKeysHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseSecurityKeyListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await securityKeyService.listSecurityKeys(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /security/keys/:id */
export async function getSecurityKeyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityKeyIdParam(paramString(req.params.id));
    const result = await securityKeyService.getSecurityKey(id, req.auth.userId);
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /security/keys/:id */
export async function updateSecurityKeyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityKeyIdParam(paramString(req.params.id));
    const body = parseUpdateSecurityKeyBody(req.body);
    const result = await securityKeyService.updateSecurityKey(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /security/keys/:id/issue */
export async function issueSecurityKeyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityKeyIdParam(paramString(req.params.id));
    const body = parseIssueSecurityKeyBody(req.body, id);
    const result = await securityKeyService.issueSecurityKey(
      {
        keyId: id,
        issuedByUserId: req.auth.userId,
        ...body,
      },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/** POST /security/keys/:id/return */
export async function returnSecurityKeyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityKeyIdParam(paramString(req.params.id));
    const body = parseReturnSecurityKeyBody(req.body, id);
    const result = await securityKeyService.returnSecurityKey(
      { keyId: id, ...body },
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /security/keys/:id/mark-lost */
export async function markKeyLostHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityKeyIdParam(paramString(req.params.id));
    const body = parseMarkKeyLostBody(req.body);
    const result = await securityKeyService.markKeyLost(
      id,
      req.auth.userId,
      body.notes,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** GET /security/keys/:id/custody */
export async function getCurrentCustodyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityKeyIdParam(paramString(req.params.id));
    const result = await securityKeyService.getCurrentCustody(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** GET /security/keys/:id/history */
export async function getCustodyHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSecurityKeyIdParam(paramString(req.params.id));
    const result = await securityKeyService.getCustodyHistory(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
