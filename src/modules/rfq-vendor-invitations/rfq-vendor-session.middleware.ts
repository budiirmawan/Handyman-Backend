import type { NextFunction, Request, Response } from 'express';
import { rfqVendorSessionRequiredError } from './rfq-vendor-invitation.errors';
import { rfqVendorInvitationService } from './rfq-vendor-invitation.service';

declare global {
  namespace Express {
    interface Request {
      vendorRfqSession?: import('./rfq-vendor-invitation.types').RfqVendorSessionContext;
    }
  }
}

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/**
 * Resolves the dedicated external Vendor RFQ session. This middleware is
 * deliberately separate from internal authentication/RBAC middleware: a
 * Vendor session is bound to one invitation and never resolves to a User.
 */
export async function rfqVendorSessionMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.header('authorization');
    const match = header ? BEARER_PATTERN.exec(header.trim()) : null;
    if (!match) throw rfqVendorSessionRequiredError();

    req.vendorRfqSession = await rfqVendorInvitationService.resolveRfqVendorSession(
      match[1],
    );
    next();
  } catch (error) {
    next(error);
  }
}
