import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { visitorInvitationService } from './visitor-invitation.service';
import {
  parseCreateVisitorInvitationBody,
  parseUpdateVisitorInvitationBody,
  parseVisitorInvitationIdParam,
  parseVisitorInvitationListQuery,
} from './visitor-invitation.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /visitor-invitations
 *
 * Creates a visit-planning invitation for an existing BE-13A visitor
 * identity. No visitor personal data is duplicated onto the record.
 */
export async function createVisitorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateVisitorInvitationBody(req.body);
    const result = await visitorInvitationService.createVisitorInvitation(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /visitor-invitations
 *   ?buildingId=&visitorId=&hostUserId=&status=&expectedFrom=&expectedTo=
 */
export async function listVisitorInvitationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVisitorInvitationListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await visitorInvitationService.listVisitorInvitations(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /visitor-invitations/:id */
export async function getVisitorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorInvitationIdParam(paramString(req.params.id));
    const result = await visitorInvitationService.getVisitorInvitation(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /visitor-invitations/:id */
export async function updateVisitorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorInvitationIdParam(paramString(req.params.id));
    const body = parseUpdateVisitorInvitationBody(req.body);
    const result = await visitorInvitationService.updateVisitorInvitation(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /visitor-invitations/:id/cancel */
export async function cancelVisitorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorInvitationIdParam(paramString(req.params.id));
    const result = await visitorInvitationService.cancelVisitorInvitation(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
