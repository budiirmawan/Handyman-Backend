import type { NextFunction, Request, Response } from 'express';
import { auditContextFromRequest } from '../audit';
import { sendSuccess } from '../../shared/api-response';
import { invitationService } from './invitation.service';
import {
  parseAcceptInvitationBody,
  parseCreateInvitationBody,
  parseInvitationIdParam,
} from './invitation.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { email } = parseCreateInvitationBody(req.body);
    const result = await invitationService.createInvitation(
      email,
      req.auth.userId,
      auditContextFromRequest(req),
    );

    // The raw token is returned exactly once (no email delivery yet).
    sendSuccess(
      res,
      {
        id: result.invitation.id,
        email: result.invitation.email,
        status: result.invitation.status,
        expiresAt: result.invitation.expiresAt,
        invitationToken: result.invitationToken,
      },
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function acceptInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseAcceptInvitationBody(req.body);
    const result = await invitationService.acceptInvitation(
      input,
      auditContextFromRequest(req),
    );
    sendSuccess(res, { user: result.user });
  } catch (error) {
    next(error);
  }
}

export async function revokeInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseInvitationIdParam(paramString(req.params.id));
    const invitation = await invitationService.revokeInvitation(
      id,
      req.auth.userId,
      auditContextFromRequest(req),
    );
    sendSuccess(res, invitation);
  } catch (error) {
    next(error);
  }
}
