import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { notificationEscalationService } from './notification-escalation.service';
import {
  parseCreateEscalationBody,
  parseEscalationIdParam,
  parseEscalationStatusFilter,
  parseUpdateEscalationBody,
} from './notification-escalation.validation';

/**
 * BE-26I — Notification escalation handlers.
 *
 *   POST  /notification-escalations           create an escalation
 *   GET   /notification-escalations           list (optional ?status=)
 *   GET   /notification-escalations/:id       get an escalation
 *   PATCH /notification-escalations/:id       update (PENDING only)
 *   POST  /notification-escalations/:id/cancel  cancel a PENDING escalation
 *
 * Platform configuration, RBAC-protected. Triggering is internal (the
 * `findDueEscalations` / `triggerDueEscalations` scheduler seam) — no trigger
 * endpoint and no scheduler engine is exposed here.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function createEscalationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateEscalationBody(req.body ?? {});
    sendSuccess(res, await notificationEscalationService.createEscalation(input), 201);
  } catch (error) {
    next(error);
  }
}

export async function listEscalationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const status = parseEscalationStatusFilter(req.query.status);
    sendSuccess(res, await notificationEscalationService.listEscalations(status));
  } catch (error) {
    next(error);
  }
}

export async function getEscalationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseEscalationIdParam(param(req.params.id));
    sendSuccess(res, await notificationEscalationService.getEscalation(id));
  } catch (error) {
    next(error);
  }
}

export async function updateEscalationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseEscalationIdParam(param(req.params.id));
    const input = parseUpdateEscalationBody(req.body ?? {});
    sendSuccess(res, await notificationEscalationService.updateEscalation(id, input));
  } catch (error) {
    next(error);
  }
}

export async function cancelEscalationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseEscalationIdParam(param(req.params.id));
    sendSuccess(res, await notificationEscalationService.cancelEscalation(id));
  } catch (error) {
    next(error);
  }
}
