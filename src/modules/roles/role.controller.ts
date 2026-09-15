import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { roleService } from './role.service';
import {
  parseAssignRoleBody,
  parseCreateRoleBody,
  parseRoleIdParam,
  parseRoleUserIdParam,
} from './role.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createRoleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateRoleBody(req.body);
    const role = await roleService.createRole(input);
    sendSuccess(res, role, 201);
  } catch (error) {
    next(error);
  }
}

export async function listRolesHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const roles = await roleService.listRoles();
    sendSuccess(res, roles);
  } catch (error) {
    next(error);
  }
}

export async function getRoleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseRoleIdParam(paramString(req.params.id));
    const role = await roleService.getRoleById(id);
    sendSuccess(res, role);
  } catch (error) {
    next(error);
  }
}

export async function assignRoleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = parseRoleUserIdParam(paramString(req.params.userId));
    const { roleId } = parseAssignRoleBody(req.body);
    const role = await roleService.assignRoleToUser(userId, roleId);
    sendSuccess(res, role, 201);
  } catch (error) {
    next(error);
  }
}

export async function listUserRolesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = parseRoleUserIdParam(paramString(req.params.userId));
    const roles = await roleService.listRolesForUser(userId);
    sendSuccess(res, roles);
  } catch (error) {
    next(error);
  }
}
