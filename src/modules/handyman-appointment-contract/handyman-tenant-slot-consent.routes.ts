import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { parseCancelBody, parseVisitParam } from './handyman-visit-api.validation';
import { confirmTenantSlotVisit } from './handyman-visit-confirmation.service';
import { acceptTenantSlotChoice, tenantSlotAssertionInvalidError } from './handyman-tenant-slot-consent.service';
import { TENANT_SLOT_SIGNATURE_HEADER } from './handyman-tenant-slot-assertion';

const p = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v;
const wrap = (handler: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not supported.');
      await handler(req, res);
    } catch (error) {
      if (error instanceof Error && /^INVALID_/.test(error.message)) {
        return next(AppError.validation('Invalid tenant slot choice input.', [{code: error.message}]));
      }
      next(error);
    }
  };

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — tenant slot choice ingest + confirmation.
 *
 * Kept OUT of the R1C visit router, which must never expose a confirm/select
 * path. Two endpoints only:
 * - POST /handyman/integrations/tenant-slot-choices: server-to-server. No user
 *   session. Trust is the HMAC-verified BM assertion; any failure is one 401.
 * - POST .../visits/:appointmentId/confirm: Operations. Session + building scope
 *   and fail-closed while BM consent authority is not provisioned (409).
 */
export function createHandymanTenantSlotConsentRouter(): Router {
  const r = Router();
  r.post('/handyman/integrations/tenant-slot-choices', wrap(async (req, res) => {
    const signature = req.get(TENANT_SLOT_SIGNATURE_HEADER);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw tenantSlotAssertionInvalidError();
    }
    sendSuccess(res, await acceptTenantSlotChoice(req.body, signature), 200);
  }));
  r.post('/handyman/requests/:handymanRequestId/visits/:appointmentId/confirm',
    authenticationMiddleware, requirePermission('tenant_company.manage'), wrap(async (req, res) => {
      const body = parseCancelBody(req.body);
      sendSuccess(res, await confirmTenantSlotVisit(
        parseVisitParam(p(req.params.handymanRequestId)), parseVisitParam(p(req.params.appointmentId)),
        body.version, req.auth.userId));
    }));
  return r;
}
