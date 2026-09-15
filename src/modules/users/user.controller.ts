import type { NextFunction, Request, Response } from 'express';
import { auditContextFromRequest } from '../audit';
import { sendSuccess } from '../../shared/api-response';
import { userLifecycleService } from './user-lifecycle.service';
import { userService } from './user.service';
import {
  parseCreateUserBody,
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
    const user = await userService.updateUserWhatsAppContact(id, input);
    sendSuccess(res, user);
  } catch (error) {
    next(error);
  }
}
