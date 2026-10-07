import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { cleaningAreaService } from '../cleaning-areas';
import { cleaningScheduleBindingService } from './cleaning-schedule-binding.service';
import {
  parseCleaningAreaIdParam,
  parseCleaningScheduleBindingFilter,
  parseCleaningScheduleBindingIdParam,
  parseCreateCleaningScheduleBindingBody,
  parseUpdateCleaningScheduleBindingBody,
} from './cleaning-schedule-binding.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createCleaningScheduleBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cleaningAreaId = parseCleaningAreaIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const cleaningArea =
      await cleaningAreaService.getCleaningAreaById(cleaningAreaId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      cleaningArea.buildingId,
    );

    const input = parseCreateCleaningScheduleBindingBody(req.body);
    const result =
      await cleaningScheduleBindingService.createCleaningScheduleBinding({
        ...input,
        cleaningAreaId,
        createdByUserId: req.auth.userId,
      });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listAreaCleaningScheduleBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cleaningAreaId = parseCleaningAreaIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const cleaningArea =
      await cleaningAreaService.getCleaningAreaById(cleaningAreaId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      cleaningArea.buildingId,
    );

    const filter = parseCleaningScheduleBindingFilter(
      req.query as Record<string, unknown>,
    );
    const results =
      await cleaningScheduleBindingService.listCleaningScheduleBindingsByArea(
        cleaningAreaId,
        filter,
      );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getCleaningScheduleBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseCleaningScheduleBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding =
      await cleaningScheduleBindingService.getCleaningScheduleBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      binding.buildingId,
    );

    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}

export async function updateCleaningScheduleBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseCleaningScheduleBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing =
      await cleaningScheduleBindingService.getCleaningScheduleBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdateCleaningScheduleBindingBody(req.body);
    const updated =
      await cleaningScheduleBindingService.updateCleaningScheduleBinding(
        id,
        input,
      );

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
