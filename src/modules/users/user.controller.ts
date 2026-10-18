import type { NextFunction, Request, Response } from 'express';
import { auditContextFromRequest } from '../audit';
import { sendSuccess } from '../../shared/api-response';
import { buildPaginationMeta } from '../../shared/pagination';
import { userLifecycleService } from './user-lifecycle.service';
import { userService } from './user.service';
import {
  parseCreateUserBody,
  parseListUsersQuery,
  parsePasswordResetBody,
  parseUpdateUserWhatsAppContactBody,
  parseUserIdParam,
} from './user.validation';

function lifecycleAudit(req: Request) {
  return { ...auditContextFromRequest(req), actorUserId: req.auth.userId };
}

export async function createUserHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateUserBody(req.body);
    const user = await userService.createUser(input);
    sendSuccess(res, user, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 — bounded user listing (`user.read`).
 * Pagination metadata is always present; the identity table is never returned
 * unbounded and credentials are never part of the projection.
 */
export async function listUsersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseListUsersQuery(req.query as Record<string, unknown>);
    const result = await userService.listUsers(query);
    sendSuccess(
      res,
      result.items,
      200,
      buildPaginationMeta(query.page, query.pageSize, result.total),
    );
  } catch (error) {
    next(error);
  }
}

export async function getUserHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = parseUserIdParam(Array.isArray(rawId) ? '' : rawId);
    const user = await userService.getUserById(id);
    sendSuccess(res, user);
  } catch (error) {
    next(error);
  }
}

export async function deactivateUserHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUserIdParam(Array.isArray(req.params.id) ? '' : req.params.id);
    const user = await userLifecycleService.deactivateUser(id, lifecycleAudit(req));
    sendSuccess(res, user);
  } catch (error) {
    next(error);
  }
}

export async function suspendUserHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUserIdParam(Array.isArray(req.params.id) ? '' : req.params.id);
    const user = await userLifecycleService.suspendUser(id, lifecycleAudit(req));
    sendSuccess(res, user);
  } catch (error) {
    next(error);
  }
}

export async function reactivateUserHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUserIdParam(Array.isArray(req.params.id) ? '' : req.params.id);
    const user = await userLifecycleService.reactivateUser(id, lifecycleAudit(req));
    sendSuccess(res, user);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 — administrative password reset (`user.manage`).
 * Returns only the lifecycle acknowledgement; the plaintext and hash are
 * never part of the response.
 */
export async function resetUserPasswordHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUserIdParam(Array.isArray(req.params.id) ? '' : req.params.id);
    const { newPassword } = parsePasswordResetBody(req.body);
    const result = await userLifecycleService.resetUserPassword(
      id,
      newPassword,
      lifecycleAudit(req),
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — WhatsApp contact + explicit consent update
 * (authoritative E.164 number + OPT_IN/OPT_OUT stamps).
 */
export async function updateUserWhatsAppContactHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseUserIdParam(Array.isArray(req.params.id) ? '' : req.params.id);
    const input = parseUpdateUserWhatsAppContactBody(req.body);
    const user = await userService.updateUserWhatsAppContact(
      id,
      input,
      req.auth.userId,
    );
    sendSuccess(res, user);
  } catch (error) {
    next(error);
  }
}
