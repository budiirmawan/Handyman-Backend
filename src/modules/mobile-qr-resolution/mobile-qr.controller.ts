import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { resolveMobileQr } from './mobile-qr.service';

const IDENTIFIER_VALUE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{5,63}$/;

/**
 * BE-25F — Mobile QR resolution handler.
 *
 *   GET /mobile/qr/resolve/:identifier
 *
 * Requires `asset_identifier.read`. The identifier pattern mirrors the
 * existing BE-05H value contract (6-64 chars, uppercase letters, digits,
 * hyphens, underscores).
 */
export async function resolveMobileQrHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = Array.isArray(req.params.identifier) ? '' : req.params.identifier;
    const identifierValue = raw.trim().toUpperCase();
    if (!IDENTIFIER_VALUE_PATTERN.test(identifierValue)) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'identifier',
          message:
            'Identifier value must be 6-64 characters of uppercase letters, digits, hyphens, and underscores.',
        },
      ]);
    }

    const resolution = await resolveMobileQr(identifierValue, req.auth.userId);
    sendSuccess(res, resolution);
  } catch (error) {
    next(error);
  }
}
