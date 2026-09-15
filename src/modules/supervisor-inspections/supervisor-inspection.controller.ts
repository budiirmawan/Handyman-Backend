import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { supervisorInspectionService } from './supervisor-inspection.service';
import {
  parseCreateSupervisorInspectionBody,
  parseSubmitSupervisorDecisionBody,
  parseSupervisorInspectionFilter,
  parseSupervisorInspectionIdParam,
} from './supervisor-inspection.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createSupervisorInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreateSupervisorInspectionBody(req.body);
    const inspection =
      await supervisorInspectionService.createSupervisorInspection({
        ...input,
        supervisorUserId: req.auth.userId,
      });

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      inspection.buildingId,
    );

    sendSuccess(res, inspection, 201);
  } catch (error) {
    next(error);
  }
}

export async function listSupervisorInspectionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseSupervisorInspectionFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results =
      await supervisorInspectionService.listSupervisorInspections(filter);

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getSupervisorInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSupervisorInspectionIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const inspection =
      await supervisorInspectionService.getSupervisorInspectionById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      inspection.buildingId,
    );

    sendSuccess(res, inspection);
  } catch (error) {
    next(error);
  }
}

export async function submitSupervisorDecisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSupervisorInspectionIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing =
      await supervisorInspectionService.getSupervisorInspectionById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseSubmitSupervisorDecisionBody(req.body);
    const updated =
      await supervisorInspectionService.submitSupervisorDecision(id, input);

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
