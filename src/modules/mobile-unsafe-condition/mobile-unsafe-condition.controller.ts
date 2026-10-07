import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseAssetIdParam } from '../assets';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import { reportMobileUnsafeCondition } from './mobile-unsafe-condition.service';
import { parseMobileUnsafeConditionBody } from './mobile-unsafe-condition.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — mobile unsafe condition report handler.
 *
 *   POST /mobile/assets/:assetId/unsafe-condition
 *
 * Requires `asset_failure.report` (enforced on the route). The Asset id comes
 * from the path and is validated by the existing BE-05 Asset param parser; the
 * body is parsed by the strict field-report DTO. The acting user is the
 * session's, never the body's.
 *
 * 201 with the reporting acknowledgement — the record itself is canonical
 * BE-21C and is read back through `GET /asset-failures/{incidentId}`.
 */
export async function reportMobileUnsafeConditionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();

    const assetId = parseAssetIdParam(param(req.params.assetId));
    const input = parseMobileUnsafeConditionBody(req.body);
    const rawHeader = req.headers['idempotency-key'];
    const rawValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const idempotencyKey = parseIdempotencyKeyRequired(rawValue);

    sendSuccess(
      res,
      await reportMobileUnsafeCondition(
        assetId,
        req.auth.userId,
        input,
        idempotencyKey,
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}
