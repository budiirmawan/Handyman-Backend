import type { NextFunction, Request, Response } from 'express';
import { auditContextFromRequest, recordEvent } from '../audit';
import { sendSuccess } from '../../shared/api-response';
import { authService } from './auth.service';
import { parseLoginBody } from './auth.validation';
import { effectiveContextService } from './effective-context.service';
import { sessionService } from './session.service';

export async function loginHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseLoginBody(req.body);
    const result = await authService.login(body, auditContextFromRequest(req));

    sendSuccess(res, {
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt.toISOString(),
      user: result.user,
    });
  } catch (error) {
    next(error);
  }
}

export async function meHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await effectiveContextService.getEffectiveUserContext(
      req.auth.userId,
    );
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}

export async function logoutHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await sessionService.revokeSessionById(req.auth.sessionId);

    await recordEvent({
      eventType: 'LOGOUT',
      outcome: 'SUCCESS',
      userId: req.auth.userId,
      sessionId: req.auth.sessionId,
      requestId: req.requestId,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });

    sendSuccess(res, { revoked: true });
  } catch (error) {
    next(error);
  }
}
