import type { NextFunction, Request, Response } from 'express';
import { buildPaginationMeta } from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import { auditContextFromRequest } from '../audit';
import { invitationService } from './invitation.service';
import {
  parseAcceptInvitationBody,
  parseCreateInvitationBody,
  parseInvitationIdParam,
  parseListInvitationsQuery,
  parseValidateInvitationBody,
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

    // The raw token is returned exactly once. The `delivery` block tells the
    // caller whether automated email delivery succeeded; when `available` is
    // false (e.g. EMAIL_PROVIDER=noop), the operator must hand the token off
    // out-of-band rather than assume the candidate was emailed.
    sendSuccess(
      res,
      {
        id: result.invitation.id,
        email: result.invitation.email,
        status: result.invitation.status,
        expiresAt: result.invitation.expiresAt,
        invitationToken: result.invitationToken,
        delivery: result.delivery,
      },
      201,
    );
  } catch (error) {
    next(error);
  }
}

/**
 * Public (unauthenticated) endpoint — the candidate uses the one-time token
 * to confirm the invitation is still good before typing a password. Returns
 * a generic 404 for unknown tokens to avoid email enumeration.
 */
export async function validateInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { token } = parseValidateInvitationBody(req.body);
    const view = await invitationService.validateInvitationToken(token);
    sendSuccess(res, view);
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

export async function listInvitationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseListInvitationsQuery(req.query as Record<string, unknown>);
    const result = await invitationService.listInvitations(query);
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

export async function getInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseInvitationIdParam(paramString(req.params.id));
    const invitation = await invitationService.getInvitation(id);
    sendSuccess(res, invitation);
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
