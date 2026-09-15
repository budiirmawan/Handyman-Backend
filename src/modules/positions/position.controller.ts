import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { positionService } from './position.service';
import {
  parseDepartmentIdParam,
  parseOrganizationIdParam,
  parsePositionIdParam,
  parseCreatePositionBody,
  parseUpdatePositionBody,
} from './position.validation';

/** Extract a string from Express v5 route params (typed as string|string[]). */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createPositionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const organizationId = parseOrganizationIdParam(paramString(req.params.organizationId));
    const input = parseCreatePositionBody(req.body);
    const position = await positionService.createPosition({ ...input, organizationId });
    sendSuccess(res, position, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPositionsByOrgHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const organizationId = parseOrganizationIdParam(paramString(req.params.organizationId));
    const positions = await positionService.listPositionsByOrganization(organizationId);
    sendSuccess(res, positions);
  } catch (error) {
    next(error);
  }
}

export async function listPositionsByDeptHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const departmentId = parseDepartmentIdParam(paramString(req.params.departmentId));
    const positions = await positionService.listPositionsByDepartment(departmentId);
    sendSuccess(res, positions);
  } catch (error) {
    next(error);
  }
}

export async function getPositionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePositionIdParam(paramString(req.params.id));
    const position = await positionService.getPositionById(id);
    sendSuccess(res, position);
  } catch (error) {
    next(error);
  }
}

export async function updatePositionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePositionIdParam(paramString(req.params.id));
    const input = parseUpdatePositionBody(req.body);
    const position = await positionService.updatePosition(id, input);
    sendSuccess(res, position);
  } catch (error) {
    next(error);
  }
}
