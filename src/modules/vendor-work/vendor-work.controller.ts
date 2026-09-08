import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import {
  parseVendorAssignmentIdParam,
  vendorAssignmentService,
} from '../vendor-assignments';
import { vendorWorkService } from './vendor-work.service';
import {
  parseResolveVendorWorkBody,
  parseUpdateVendorWorkStatusBody,
  parseVendorWorkFilters,
  parseVendorWorkIdParam,
} from './vendor-work.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * BE-02 Building isolation for the resolve route: the BE-15A assignment is
 * loaded first (unknown id → 404), then the caller must hold an ACTIVE
 * assignment to its Building (otherwise 403 BUILDING_ACCESS_DENIED).
 */
async function assertAssignmentBuildingAccess(
  userId: string,
  assignmentId: string,
): Promise<void> {
  const assignment =
    await vendorAssignmentService.getVendorAssignment(assignmentId);
  await contextAccessService.assertBuildingAccess(userId, assignment.buildingId);
}

export async function resolveVendorWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assignmentId = parseVendorAssignmentIdParam(
      paramString(req.params.assignmentId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    await assertAssignmentBuildingAccess(req.auth.userId, assignmentId);
    const input = parseResolveVendorWorkBody(req.body);

    const { work, created } = await vendorWorkService.resolveVendorWork(
      assignmentId,
      input,
    );
    sendSuccess(res, work, created ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

export async function getVendorWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workId = parseVendorWorkIdParam(paramString(req.params.workId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const work = await vendorWorkService.getVendorWork(workId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      work.buildingId,
    );
    sendSuccess(res, work);
  } catch (error) {
    next(error);
  }
}

export async function listVendorWorksHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVendorWorkFilters(req.query as Record<string, unknown>);

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const works = await vendorWorkService.listVendorWorks(
      filters,
      accessibleBuildingIds,
    );
    sendSuccess(res, works);
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /vendor-works/:workId/status — applies an allowed lifecycle
 * transition (start / hold / complete). The backend transition table is the
 * authority; invalid transitions are rejected.
 */
export async function updateVendorWorkStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workId = parseVendorWorkIdParam(paramString(req.params.workId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const work = await vendorWorkService.getVendorWork(workId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      work.buildingId,
    );

    const input = parseUpdateVendorWorkStatusBody(req.body);
    const updated = await vendorWorkService.transitionVendorWorkStatus(
      workId,
      input,
    );
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
