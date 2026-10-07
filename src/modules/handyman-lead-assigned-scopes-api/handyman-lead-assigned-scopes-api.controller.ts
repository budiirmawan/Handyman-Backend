import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { createHandymanArrivalChallenge }
  from '../handyman-arrival-challenges';
import { getHandymanMaterialProgressProjection }
  from '../handyman-material-execution';
import {
  getHandymanLeadAssignedScope,
  listHandymanLeadAssignedScopes,
} from '../handyman-lead-assigned-scopes';
import {
  parseHandymanLeadArrivalChallengeBody,
  parseHandymanLeadAssignedScopesPagination,
  parseHandymanLeadExecutionScopeId,
} from './handyman-lead-assigned-scopes-api.validation';

export async function createHandymanLeadArrivalChallengeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseHandymanLeadExecutionScopeId(
      req.params.executionScopeId,
    );
    parseHandymanLeadArrivalChallengeBody(req.body);
    const created = await createHandymanArrivalChallenge(
      { executionScopeId },
      req.auth.userId,
    );
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, {
      challengeId: created.challenge.id,
      executionScopeId: created.challenge.executionScopeId,
      challengeToken: created.token,
      expiresAt: created.challenge.expiresAt,
    }, 201);
  } catch (error) {
    next(error);
  }
}

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

/** Read current material quantities for a scope assigned to this Lead. */
export async function getHandymanLeadMaterialProgressHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseHandymanLeadExecutionScopeId(
      req.params.executionScopeId,
    );
    const progress = await getHandymanMaterialProgressProjection(
      executionScopeId,
      req.auth.userId,
    );
    sendSuccess(res, progress);
  } catch (error) {
    next(error);
  }
}
