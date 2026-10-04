import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  getHandymanLeadAssignedScope,
  listHandymanLeadAssignedScopes,
} from '../handyman-lead-assigned-scopes';
import {
  parseHandymanLeadAssignedScopesPagination,
  parseHandymanLeadExecutionScopeId,
} from './handyman-lead-assigned-scopes-api.validation';

export async function listHandymanLeadAssignedScopesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = await listHandymanLeadAssignedScopes(
      req.auth.userId,
      parseHandymanLeadAssignedScopesPagination(req.query),
    );
    sendSuccess(res, page.data, 200, page.meta);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanLeadAssignedScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseHandymanLeadExecutionScopeId(
      req.params.executionScopeId,
    );
    const detail = await getHandymanLeadAssignedScope(
      req.auth.userId,
      executionScopeId,
    );
    sendSuccess(res, detail);
  } catch (error) {
    next(error);
  }
}
