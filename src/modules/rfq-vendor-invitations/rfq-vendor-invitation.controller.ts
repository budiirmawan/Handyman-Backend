import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { rfqVendorInvitationService } from './rfq-vendor-invitation.service';
import {
  parseCreateRfqVendorInvitationBody,
  parseResendRfqVendorInvitationBody,
  parseRfqIdParam,
  parseRfqVendorIdParam,
  parseRfqVendorInvitationActionBody,
  parseRfqVendorInvitationFilters,
  parseRfqVendorInvitationIdParam,
  parseRfqVendorInvitationTokenBody,
} from './rfq-vendor-invitation.validation';
import { rfqVendorSessionInvitationMismatchError } from './rfq-vendor-invitation.errors';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function internalActor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function idempotencyHeader(req: Request): string | undefined {
  const value = req.header('Idempotency-Key');
  return value?.trim() || undefined;
}

export async function createRfqVendorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await rfqVendorInvitationService.createRfqVendorInvitation(
      {
        ...parseCreateRfqVendorInvitationBody(req.body, idempotencyHeader(req)),
        rfqId: parseRfqIdParam(param(req.params.rfqId)),
      },
      internalActor(req),
    );
    sendSuccess(
      res,
      { ...result.invitation, invitationToken: result.invitationToken },
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listRfqVendorInvitationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rfqId = parseRfqIdParam(param(req.params.rfqId));
    sendSuccess(
      res,
      await rfqVendorInvitationService.listRfqVendorInvitations(
        rfqId,
        parseRfqVendorInvitationFilters(req.query),
        internalActor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listAccessibleRfqVendorInvitationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqVendorInvitationService.listAccessibleRfqVendorInvitations(
        parseRfqVendorInvitationFilters(req.query),
        internalActor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getRfqVendorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqVendorInvitationService.getRfqVendorInvitation(
        parseRfqVendorInvitationIdParam(param(req.params.id)),
        internalActor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function resendRfqVendorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await rfqVendorInvitationService.resendRfqVendorInvitation(
      {
        ...parseResendRfqVendorInvitationBody(req.body, idempotencyHeader(req)),
        invitationId: parseRfqVendorInvitationIdParam(param(req.params.id)),
      },
      internalActor(req),
    );
    sendSuccess(
      res,
      { ...result.invitation, invitationToken: result.invitationToken },
    );
  } catch (error) {
    next(error);
  }
}

export async function revokeRfqVendorInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqVendorInvitationService.revokeRfqVendorInvitation(
        parseRfqVendorInvitationIdParam(param(req.params.id)),
        internalActor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function exchangeRfqVendorInvitationTokenHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await rfqVendorInvitationService.exchangeRfqVendorInvitationToken(
      parseRfqVendorInvitationTokenBody(req.body).token,
    );
    sendSuccess(res, {
      sessionToken: result.sessionToken,
      session: result.session,
      access: result.access,
    });
  } catch (error) {
    next(error);
  }
}

export async function getVendorRfqMeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = req.vendorRfqSession!;
    sendSuccess(res, {
      sessionId: context.sessionId,
      invitationId: context.invitationId,
      rfqId: context.rfqId,
      vendorId: context.vendorId,
    });
  } catch (error) {
    next(error);
  }
}

export async function getVendorSafeRfqHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqVendorInvitationService.getVendorSafeRfq(
        req.vendorRfqSession!,
        parseRfqIdParam(param(req.params.rfqId)),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getVendorSafeInvitationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqVendorInvitationService.getVendorSafeInvitation(
        req.vendorRfqSession!,
        parseRfqVendorInvitationIdParam(param(req.params.invitationId)),
      ),
    );
  } catch (error) {
    next(error);
  }
}

async function vendorAction(
  req: Request,
  res: Response,
  next: NextFunction,
  action: 'ACCEPT' | 'DECLINE' | 'NO_BID',
): Promise<void> {
  try {
    const context = req.vendorRfqSession!;
    const invitationId = parseRfqVendorInvitationIdParam(param(req.params.invitationId));
    if (context.invitationId !== invitationId) {
      throw rfqVendorSessionInvitationMismatchError();
    }
    const { reason } = parseRfqVendorInvitationActionBody(req.body);
    const invitation = action === 'ACCEPT'
      ? await rfqVendorInvitationService.acceptVendorRfqInvitation(context)
      : action === 'DECLINE'
        ? await rfqVendorInvitationService.declineVendorRfqInvitation(context, reason)
        : await rfqVendorInvitationService.recordVendorRfqNoBid(context, reason);
    sendSuccess(res, {
      invitationId: invitation.id,
      status: invitation.status,
      responseReason: invitation.responseReason,
    });
  } catch (error) {
    next(error);
  }
}

export function acceptVendorRfqInvitationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  return vendorAction(req, res, next, 'ACCEPT');
}

export function declineVendorRfqInvitationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  return vendorAction(req, res, next, 'DECLINE');
}

export function noBidVendorRfqInvitationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  return vendorAction(req, res, next, 'NO_BID');
}
