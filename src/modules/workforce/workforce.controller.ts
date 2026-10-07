import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { workforceService } from './workforce.service';
import {
  parseCreateWorkforceProfileBody,
  parseDepartmentIdParam,
  parseOrganizationIdParam,
  parseTeamIdParam,
  parseUpdateWorkforceProfileBody,
  parseWorkforceProfileIdParam,
} from './workforce.validation';

/** Extract a string from Express v5 route params (typed as string|string[]). */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createWorkforceProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const organizationId = parseOrganizationIdParam(
      paramString(req.params.organizationId),
    );
    const input = parseCreateWorkforceProfileBody(req.body);
    const profile = await workforceService.createWorkforceProfile({
      ...input,
      organizationId,
    });
    sendSuccess(res, profile, 201);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceProfilesByOrgHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const organizationId = parseOrganizationIdParam(
      paramString(req.params.organizationId),
    );
    const profiles =
      await workforceService.listWorkforceProfilesByOrganization(organizationId);
    sendSuccess(res, profiles);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceProfilesByDeptHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const departmentId = parseDepartmentIdParam(
      paramString(req.params.departmentId),
    );
    const profiles =
      await workforceService.listWorkforceProfilesByDepartment(departmentId);
    sendSuccess(res, profiles);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceProfilesByTeamHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const teamId = parseTeamIdParam(paramString(req.params.teamId));
    const profiles = await workforceService.listWorkforceProfilesByTeam(teamId);
    sendSuccess(res, profiles);
  } catch (error) {
    next(error);
  }
}

export async function getWorkforceProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkforceProfileIdParam(paramString(req.params.id));
    const profile = await workforceService.getWorkforceProfileById(id);
    sendSuccess(res, profile);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkforceProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkforceProfileIdParam(paramString(req.params.id));
    const input = parseUpdateWorkforceProfileBody(req.body);
    const profile = await workforceService.updateWorkforceProfile(id, input);
    sendSuccess(res, profile);
  } catch (error) {
    next(error);
  }
}
