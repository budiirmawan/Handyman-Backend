import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { cleaningAreaService } from '../cleaning-areas';
import { contextAccessService } from '../context-access';
import { toiletInspectionService } from './toilet-inspection.service';
import {
  parseCreateToiletInspectionBindingBody,
  parseToiletInspectionBindingFilter,
  parseToiletInspectionBindingIdParam,
  parseToiletInspectionExecutionIdParam,
  parseUpdateToiletInspectionBindingBody,
} from './toilet-inspection.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createToiletInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreateToiletInspectionBindingBody(req.body);
    const cleaningArea = await cleaningAreaService.getCleaningAreaById(
      input.cleaningAreaId,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      cleaningArea.buildingId,
    );

    const result =
      await toiletInspectionService.createToiletInspectionBinding({
        ...input,
        createdByUserId: req.auth.userId,
      });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listToiletInspectionBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseToiletInspectionBindingFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results =
      await toiletInspectionService.listToiletInspectionBindings(filter);

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getToiletInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseToiletInspectionBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding =
      await toiletInspectionService.getToiletInspectionBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      binding.buildingId,
    );

    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}

export async function updateToiletInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseToiletInspectionBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing =
      await toiletInspectionService.getToiletInspectionBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdateToiletInspectionBindingBody(req.body);
    const updated =
      await toiletInspectionService.updateToiletInspectionBinding(id, input);

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

export async function startToiletInspectionExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseToiletInspectionBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding =
      await toiletInspectionService.getToiletInspectionBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      binding.buildingId,
    );

    const result =
      await toiletInspectionService.startToiletInspectionExecution(id);

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function getToiletInspectionExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseToiletInspectionExecutionIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const result =
      await toiletInspectionService.getToiletInspectionExecutionContext(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      result.toiletInspectionBinding.buildingId,
    );

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
