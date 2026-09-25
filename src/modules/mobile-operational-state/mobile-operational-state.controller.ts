import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseAssetIdParam } from '../assets';
import { getMobileAssetOperationalState } from './mobile-operational-state.service';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — mobile operational-state read.
 *
 *   GET /mobile/assets/:assetId/operational-state
 *
 * The ONLY mobile RN-10 operational-state operation. It is READ ONLY: it
 * returns the canonical PART 02 operational-state view plus the caller's
 * `availableActions` snapshot, and it never mutates anything. The mutations
 * those tokens name already exist as canonical operations:
 *
 *   MARK_*            → PATCH /assets/:assetId/operational-state
 *   RETURN_TO_SERVICE → POST /assets/:assetId/operational-state/return-to-service
 *   REPORT_UNSAFE_CONDITION
 *                    → POST /mobile/assets/:assetId/unsafe-condition
 *
 * No mobile mutation endpoint is registered for operational state — that
 * would be a second, unversioned door onto safety state.
 *
 * The route requires `asset_operational_state.read` (enforced on the route,
 * so a caller without it is refused BEFORE any Asset row is touched) and
 * Building access to the Asset's Building (asserted in the service, in the
 * same order as the PART 02 handlers: unknown Asset → 404, then access →
 * 403). The Asset id comes from the path and is validated by the existing
 * BE-05 Asset param parser; the acting user is the session's, never the
 * body's. There is no request body at all.
 */
export async function getMobileAssetOperationalStateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();

    const assetId = parseAssetIdParam(param(req.params.assetId));

    sendSuccess(
      res,
      await getMobileAssetOperationalState(assetId, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
