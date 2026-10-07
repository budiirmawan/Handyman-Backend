import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { housekeepingComplaintService } from './housekeeping-complaint.service';
import {
  parseCreateHousekeepingComplaintBindingBody,
  parseHousekeepingComplaintBindingFilter,
  parseHousekeepingComplaintBindingIdParam,
  parseUpdateHousekeepingComplaintBindingBody,
} from './housekeeping-complaint.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createHousekeepingComplaintBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreateHousekeepingComplaintBindingBody(req.body);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      input.buildingId,
    );

    const result =
      await housekeepingComplaintService.createHousekeepingComplaintBinding({
        ...input,
        createdByUserId: req.auth.userId,
      });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listHousekeepingComplaintBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseHousekeepingComplaintBindingFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results =
      await housekeepingComplaintService.listHousekeepingComplaintBindings(
        filter,
      );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getHousekeepingComplaintBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHousekeepingComplaintBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const result =
      await housekeepingComplaintService.getHousekeepingComplaintBindingById(
        id,
      );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      result.buildingId,
    );

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function updateHousekeepingComplaintBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHousekeepingComplaintBindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing =
      await housekeepingComplaintService.getHousekeepingComplaintBindingById(
        id,
      );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdateHousekeepingComplaintBindingBody(req.body);
    const updated =
      await housekeepingComplaintService.updateHousekeepingComplaintBinding(
        id,
        input,
      );

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
