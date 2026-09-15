import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { assertFindingActionAllowed, assertFindingTransitionAllowed } from './finding-action.authority';
import { findingActionService } from './finding-action.service';
import { findingSourceService } from './finding-source.service';
import { parseUpdateFindingSourceBody } from './finding-source.validation';
import { findingStateService } from './finding-state.service';
import { parseTransitionFindingStateBody } from './finding-state.validation';
import { findingService } from './finding.service';
import {
  parseCreateFindingBody,
  parseFindingBuildingIdParam,
  parseFindingFilters,
  parseFindingIdParam,
  parseUpdateFindingBody,
} from './finding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const buildingId = parseFindingBuildingIdParam(paramString(req.params.buildingId));
    const input = parseCreateFindingBody(req.body);
    const finding = await findingService.createFinding({
      ...input,
      buildingId,
      reportedByUserId: req.auth.userId,
    });
    sendSuccess(res, finding, 201);
  } catch (error) {
    next(error);
  }
}

export async function listFindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseFindingBuildingIdParam(paramString(req.params.buildingId));
    const findings = await findingService.listFindingsByBuilding(
      buildingId,
      parseFindingFilters(req.query),
    );
    sendSuccess(res, findings);
  } catch (error) {
    next(error);
  }
}

async function loadAuthorizedFinding(req: Request) {
  if (!req.auth) throw authenticationRequiredError();
  const id = parseFindingIdParam(paramString(req.params.id));
  const finding = await findingService.getFindingById(id);
  await contextAccessService.assertBuildingAccess(req.auth.userId, finding.buildingId);
  return finding;
}

export async function getFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await loadAuthorizedFinding(req));
  } catch (error) {
    next(error);
  }
}

export async function updateFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const finding = await loadAuthorizedFinding(req);
    if (!req.auth) throw authenticationRequiredError();
    const input = parseUpdateFindingBody(req.body);
    sendSuccess(
      res,
      await findingService.updateFinding(finding.id, input, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

export async function getFindingAvailableActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const finding = await loadAuthorizedFinding(req);
    sendSuccess(
      res,
      await findingActionService.resolveAvailableActions(finding.id, {
        userId: req.auth.userId,
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function getFindingStateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const finding = await loadAuthorizedFinding(req);
    sendSuccess(res, await findingStateService.getFindingState(finding.id));
  } catch (error) {
    next(error);
  }
}

export async function transitionFindingStateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const finding = await loadAuthorizedFinding(req);
    if (!req.auth) throw authenticationRequiredError();
    const input = parseTransitionFindingStateBody(req.body);
    await assertFindingTransitionAllowed(
      finding.id,
      req.auth.userId,
      finding.status,
      input.state,
    );
    sendSuccess(
      res,
      await findingStateService.transitionFindingState(
        finding.id,
        input,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getFindingSourceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const finding = await loadAuthorizedFinding(req);
    sendSuccess(res, await findingSourceService.getFindingSource(finding.id));
  } catch (error) {
    next(error);
  }
}

export async function updateFindingSourceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const finding = await loadAuthorizedFinding(req);
    if (!req.auth) throw authenticationRequiredError();
    const input = parseUpdateFindingSourceBody(req.body);
    sendSuccess(
      res,
      await findingSourceService.updateFindingSource(
        finding.id,
        input,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const finding = await loadAuthorizedFinding(req);
    if (!req.auth) throw authenticationRequiredError();
    await assertFindingActionAllowed(finding.id, req.auth.userId, 'CANCEL');
    sendSuccess(
      res,
      await findingService.cancelFinding(finding.id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
