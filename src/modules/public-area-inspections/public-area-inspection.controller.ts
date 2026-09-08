import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { cleaningAreaService } from '../cleaning-areas';
import { contextAccessService } from '../context-access';
import { publicAreaInspectionService } from './public-area-inspection.service';
import {
  parseCreatePublicAreaInspectionBindingBody,
  parsePublicAreaInspectionBindingFilter,
  parsePublicAreaInspectionBindingIdParam,
  parsePublicAreaInspectionExecutionIdParam,
  parseUpdatePublicAreaInspectionBindingBody,
} from './public-area-inspection.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createPublicAreaInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreatePublicAreaInspectionBindingBody(req.body);
    const cleaningArea = await cleaningAreaService.getCleaningAreaById(
      input.cleaningAreaId,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      cleaningArea.buildingId,
    );

    const result =
      await publicAreaInspectionService.createPublicAreaInspectionBinding({
        ...input,
        createdByUserId: req.auth.userId,
      });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPublicAreaInspectionBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parsePublicAreaInspectionBindingFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results =
      await publicAreaInspectionService.listPublicAreaInspectionBindings(
        filter,
      );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getPublicAreaInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePublicAreaInspectionBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding =
      await publicAreaInspectionService.getPublicAreaInspectionBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      binding.buildingId,
    );

    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}

export async function updatePublicAreaInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePublicAreaInspectionBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing =
      await publicAreaInspectionService.getPublicAreaInspectionBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdatePublicAreaInspectionBindingBody(req.body);
    const updated =
      await publicAreaInspectionService.updatePublicAreaInspectionBinding(
        id,
        input,
      );

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

export async function startPublicAreaInspectionExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePublicAreaInspectionBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding =
      await publicAreaInspectionService.getPublicAreaInspectionBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      binding.buildingId,
    );

    const result =
      await publicAreaInspectionService.startPublicAreaInspectionExecution(id);

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function getPublicAreaInspectionExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePublicAreaInspectionExecutionIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const result =
      await publicAreaInspectionService.getPublicAreaInspectionExecutionContext(
        id,
      );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      result.publicAreaInspectionBinding.buildingId,
    );

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
