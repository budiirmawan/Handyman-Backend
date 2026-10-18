import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { auditContextFromRequest } from '../audit';
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

function roleAudit(req: Request) {
  return { ...auditContextFromRequest(req), actorUserId: req.auth.userId };
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
    const role = await roleService.assignRoleToUser(
      userId,
      roleId,
      req.auth.userId,
      roleAudit(req),
    );
    sendSuccess(res, role, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 — revoke a single ACTIVE role assignment.
 * The last ACTIVE PLATFORM_ADMIN assignment is protected in the service.
 */
export async function revokeRoleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = parseRoleUserIdParam(paramString(req.params.userId));
    const roleId = parseRoleIdParam(paramString(req.params.roleId));
    const role = await roleService.revokeRoleFromUser(
      userId,
      roleId,
      req.auth.userId,
      roleAudit(req),
    );
    sendSuccess(res, role);
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
