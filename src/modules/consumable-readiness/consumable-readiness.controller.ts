import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { consumableReadinessService } from './consumable-readiness.service';
import {
  parseConsumableReadinessFilter,
  parseConsumableRequirementFilter,
  parseConsumableRequirementIdParam,
  parseCreateConsumableRequirementBody,
  parseRecordConsumableReadinessBody,
  parseUpdateConsumableRequirementBody,
} from './consumable-readiness.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createConsumableRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreateConsumableRequirementBody(req.body);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      input.buildingId,
    );

    const result =
      await consumableReadinessService.createConsumableRequirement(input);

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listConsumableRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseConsumableRequirementFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results =
      await consumableReadinessService.listConsumableRequirements(filter);

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getConsumableRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseConsumableRequirementIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const requirement =
      await consumableReadinessService.getConsumableRequirementById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      requirement.buildingId,
    );

    sendSuccess(res, requirement);
  } catch (error) {
    next(error);
  }
}

export async function updateConsumableRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseConsumableRequirementIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing =
      await consumableReadinessService.getConsumableRequirementById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdateConsumableRequirementBody(req.body);
    const updated =
      await consumableReadinessService.updateConsumableRequirement(id, input);

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

export async function recordConsumableReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseConsumableRequirementIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const requirement =
      await consumableReadinessService.getConsumableRequirementById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      requirement.buildingId,
    );

    const input = parseRecordConsumableReadinessBody(req.body);
    const result = await consumableReadinessService.recordConsumableReadiness({
      ...input,
      requirementId: id,
      checkedByUserId: req.auth.userId,
    });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listConsumableReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseConsumableReadinessFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results =
      await consumableReadinessService.listConsumableReadiness(filter);

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}
