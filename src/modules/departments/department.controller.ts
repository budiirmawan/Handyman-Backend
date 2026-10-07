import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { departmentService } from './department.service';
import {
  parseDepartmentIdParam,
  parseOrganizationIdParam,
  parseCreateDepartmentBody,
  parseUpdateDepartmentBody,
} from './department.validation';

/** Extract a string from Express v5 route params (typed as string|string[]). */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** Extract a string from Express v5 query params (typed as ParsedQs). */
function queryString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return '';
}

export async function createDepartmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateDepartmentBody(req.body);
    const dept = await departmentService.createDepartment(input);
    sendSuccess(res, dept, 201);
  } catch (error) {
    next(error);
  }
}

export async function listDepartmentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const organizationId = parseOrganizationIdParam(queryString(req.query.organizationId));
    const depts = await departmentService.listDepartmentsByOrganization(organizationId);
    sendSuccess(res, depts);
  } catch (error) {
    next(error);
  }
}

export async function getDepartmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseDepartmentIdParam(paramString(req.params.id));
    const dept = await departmentService.getDepartmentById(id);
    sendSuccess(res, dept);
  } catch (error) {
    next(error);
  }
}

export async function updateDepartmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseDepartmentIdParam(paramString(req.params.id));
    const input = parseUpdateDepartmentBody(req.body);
    const dept = await departmentService.updateDepartment(id, input);
    sendSuccess(res, dept);
  } catch (error) {
    next(error);
  }
}
