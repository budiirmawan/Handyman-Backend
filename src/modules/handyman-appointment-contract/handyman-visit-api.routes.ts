import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { parseCancelBody, parseHandymanVisitProposal, parseVisitParam } from './handyman-visit-api.validation';
import { readVisitProposals, createVisitProposal, cancelVisitProposal } from './handyman-visit-api.service';
const p = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v;
const wrap = (handler: (req:Request,res:Response)=>Promise<void>) => async(req:Request,res:Response,next:NextFunction) => {
  try { if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not supported.');
    await handler(req,res);
  } catch(error) { if (error instanceof Error && /^(INVALID_|PROPOSAL_)/.test(error.message))
      return next(AppError.validation('Invalid visit appointment input.',[{code:error.message}])); next(error); }
};
/** Only proposing/cancelling proposals. Never grants tenant choice or confirmation. */
export function createHandymanVisitApiRouter(): Router {
  const r = Router(); const base = '/handyman/requests/:handymanRequestId/visits';
  r.get(base, authenticationMiddleware, requirePermission('tenant_company.read'), wrap(async (req,res) => {
    if (req.body !== undefined && req.body !== null && Object.keys(req.body).length) throw AppError.validation('GET body not accepted.');
    sendSuccess(res, await readVisitProposals(parseVisitParam(p(req.params.handymanRequestId)), req.auth.userId));
  }));
  r.post(base, authenticationMiddleware, requirePermission('tenant_company.manage'), wrap(async (req,res) => {
    sendSuccess(res, await createVisitProposal(parseVisitParam(p(req.params.handymanRequestId)),
      parseHandymanVisitProposal(req.body), req.auth.userId), 201);
  }));
  r.post(`${base}/:appointmentId/cancel-proposal`, authenticationMiddleware, requirePermission('tenant_company.manage'), wrap(async(req,res) => {
    sendSuccess(res, await cancelVisitProposal(parseVisitParam(p(req.params.handymanRequestId)),
      parseVisitParam(p(req.params.appointmentId)),parseCancelBody(req.body).version,req.auth.userId));
  }));
  return r;
}
