import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { secureLinkService } from './secure-link.service';
import {
  parseCreateSecureLinkBody,
  parseResolveSecureLinkBody,
  parseSecureLinkIdParam,
} from './secure-link.validation';

/**
 * BE-26J — Notification secure link handlers.
 *
 *   POST /notification-links                     create (returns raw token once)
 *   POST /notification-links/resolve             resolve + consume (recipient)
 *   GET  /notification-links/:linkId             status (read)
 *   POST /notification-links/:linkId/revoke      revoke (manage)
 *
 * Resolution is authenticated but recipient-bound; creation/revocation are
 * RBAC-protected platform operations. No authorization/workflow bypass.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function createSecureLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSecureLinkBody(req.body ?? {});
    const created = await secureLinkService.createSecureLink(input);
    // The raw token is returned exactly once, alongside the public record.
    sendSuccess(res, { ...created.link, token: created.token }, 201);
  } catch (error) {
    next(error);
  }
}

export async function resolveSecureLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { token } = parseResolveSecureLinkBody(req.body ?? {});
    sendSuccess(res, await secureLinkService.resolveSecureLink(token, req.auth.userId));
  } catch (error) {
    next(error);
  }
}

export async function getSecureLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSecureLinkIdParam(param(req.params.linkId));
    sendSuccess(res, await secureLinkService.getSecureLink(id));
  } catch (error) {
    next(error);
  }
}

export async function revokeSecureLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSecureLinkIdParam(param(req.params.linkId));
    sendSuccess(res, await secureLinkService.revokeSecureLink(id));
  } catch (error) {
    next(error);
  }
}
