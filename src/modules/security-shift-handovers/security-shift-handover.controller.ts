import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { securityShiftHandoverBindingService } from './security-shift-handover.service';
import {
  parseBindingIdParam,
  parseBuildingIdParam,
  parseCreateSecurityShiftHandoverBindingBody,
  parseSecurityShiftHandoverBindingFilter,
  parseUpdateSecurityShiftHandoverBindingBody,
} from './security-shift-handover.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /buildings/:buildingId/security/shift-handovers
 *
 * Creates a new Security Shift Handover binding in the Building.
 * The BE-10J shift_handovers row must already exist; the binding just
 * attaches the Security operational context to it.
 */
export async function createSecurityShiftHandoverBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const body = parseCreateSecurityShiftHandoverBindingBody(req.body);
    const binding =
      await securityShiftHandoverBindingService.createSecurityShiftHandoverBinding(
        {
          ...body,
          buildingId,
          createdByUserId: req.auth.userId,
        },
        req.auth.userId,
      );
    sendSuccess(res, binding, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /buildings/:buildingId/security/shift-handovers
 *
 * Lists the Security Shift Handover bindings for one Building. Optional
 * `shiftHandoverId`, `startSecurityPostId`, `patrolRouteId`, and `status`
 * filters narrow the result. When `buildingId` is omitted the listing
 * scope is the caller's accessible Buildings.
 */
export async function listSecurityShiftHandoverBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const rawBuilding = paramString(req.params.buildingId);
    const buildingId =
      rawBuilding === '' ? undefined : parseBuildingIdParam(rawBuilding);
    const filters = parseSecurityShiftHandoverBindingFilter({
      ...(req.query as Record<string, unknown>),
      ...(buildingId ? { buildingId } : {}),
    });
    const bindings =
      await securityShiftHandoverBindingService.listSecurityShiftHandoverBindings(
        filters,
        req.auth.userId,
      );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /security/shift-handovers/:id */
export async function getSecurityShiftHandoverBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseBindingIdParam(paramString(req.params.id));
    const binding =
      await securityShiftHandoverBindingService.getSecurityShiftHandoverBinding(
        id,
        req.auth.userId,
      );
    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}

/** PATCH /security/shift-handovers/:id */
export async function updateSecurityShiftHandoverBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseUpdateSecurityShiftHandoverBindingBody(req.body);
    const binding =
      await securityShiftHandoverBindingService.updateSecurityShiftHandoverBinding(
        id,
        body,
        req.auth.userId,
      );
    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}
