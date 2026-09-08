import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { permissionService } from './permission.service';
import {
  parseAssignPermissionBody,
  parseCreatePermissionBody,
  parsePermissionIdParam,
  parseRoleIdParam,
} from './permission.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createPermissionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreatePermissionBody(req.body);
    const permission = await permissionService.createPermission(input);
    sendSuccess(res, permission, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPermissionsHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const permissions = await permissionService.listPermissions();
    sendSuccess(res, permissions);
  } catch (error) {
    next(error);
  }
}

export async function getPermissionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePermissionIdParam(paramString(req.params.id));
    const permission = await permissionService.getPermissionById(id);
    sendSuccess(res, permission);
  } catch (error) {
    next(error);
  }
}

export async function assignPermissionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const roleId = parseRoleIdParam(paramString(req.params.roleId));
    const { permissionId } = parseAssignPermissionBody(req.body);
    const permission = await permissionService.assignPermissionToRole(
      roleId,
      permissionId,
    );
    sendSuccess(res, permission, 201);
  } catch (error) {
    next(error);
  }
}

export async function listRolePermissionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const roleId = parseRoleIdParam(paramString(req.params.roleId));
    const permissions = await permissionService.listPermissionsForRole(roleId);
    sendSuccess(res, permissions);
  } catch (error) {
    next(error);
  }
}
