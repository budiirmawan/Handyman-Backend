import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { proposeClaimResolution, respondClaimResolution, finalizeClaimResolution, readClaimResolution }
  from '../handyman-service-warranty-claims/handyman-warranty-claim-resolution.service';
import {
  getChargeableAdditionalWorkByIdHandler,
  getExecutionScopeServiceWarrantyHandler,
  getServiceWarrantyByIdHandler,
  getServiceWarrantyClaimByIdHandler,
  getServiceWarrantyClaimAssessmentHandler,
  postServiceWarrantyClaimAssessmentHandler,
  getServiceWarrantyReworkByIdHandler,
  postAcceptChargeableAdditionalWorkHandler,
  postApproveServiceWarrantyClaimHandler,
  postAuthorizeServiceWarrantyReworkHandler,
  postOpenServiceWarrantyClaimHandler,
  postRejectChargeableAdditionalWorkHandler,
  postRejectServiceWarrantyClaimHandler,
  postSubmitServiceWarrantyClaimHandler,
  postWithdrawServiceWarrantyClaimHandler,
} from './handyman-service-warranty-api.controller';

/**
 * CR-HM-17 GAP PART 06 — CR-HM-15 Service Warranty, Claim, Free Rework &
 * Chargeable Additional Work Customer Care HTTP surface:
 *
 *   GET  /handyman/execution-scopes/:executionScopeId/service-warranty
 *   GET  /handyman/service-warranties/:warrantyId
 *   GET  /handyman/service-warranty-claims/:claimId
 *   GET  /handyman/service-warranty-reworks/:reworkId
 *   GET  /handyman/chargeable-additional-works/:workId
 *   POST /handyman/service-warranties/:warrantyId/claims
 *   POST /handyman/service-warranty-claims/:claimId/submit
 *   GET  /handyman/service-warranty-claims/:claimId/assessments
 *   POST /handyman/service-warranty-claims/:claimId/assessments
 *   POST /handyman/service-warranty-claims/:claimId/approve
 *   POST /handyman/service-warranty-claims/:claimId/reject
 *   POST /handyman/service-warranty-claims/:claimId/withdraw
 *   POST /handyman/service-warranty-reworks/:reworkId/authorize
 *   POST /handyman/chargeable-additional-works/:workId/accept
 *   POST /handyman/chargeable-additional-works/:workId/reject
 *
 * Reads require `tenant_company.read` + exact-Building access to the
 * warranty scope's server-derived Building (BE-02G — the former
 * client-level `canAccessClient` wall was replaced by CR-HM-SEC-01
 * PART 06D-1; a same-Client sibling-Building assignment does NOT
 * suffice). Intake and submission require `tenant_company.manage` and
 * the same exact-Building wall. Assessment and claim approval/rejection
 * require the separately granted `handyman.warranty.assess` capability,
 * independent reviewer identity and exact-Building access. The recorded
 * actor is the authenticated local user; no Tenant PIC is impersonated.
 * Field-worker rework execution commands (`propose`, `start`, `complete`,
 * `verify`) and warranty lifecycle calculation commands (`start`, `expire`)
 * are NOT exposed.
 */
export function createHandymanServiceWarrantyApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  const assess = requirePermission('handyman.warranty.assess');
  const param = (v:string|string[]) => Array.isArray(v) ? v[0] : v;
  const resolution='/handyman/service-warranty-claims/:claimId/resolution';
  const noStore = (_req:import('express').Request,res:import('express').Response,next:import('express').NextFunction) => {
    res.set('Cache-Control','private, no-store'); next();
  };
  router.get(resolution,noStore,auth,async(req,res,next)=>{
    try {
      if (Object.keys(req.query).length || (req.body && Object.keys(req.body).length)) throw AppError.validation('No selectors or body are accepted.');
      sendSuccess(res,await readClaimResolution(req.auth,param(req.params.claimId)));
    } catch(error) { next(error); }
  });
  router.post(`${resolution}/proposals`,noStore,auth,async(req,res,next)=>{
    try {
      if (Object.keys(req.query).length) throw AppError.validation('No query parameters are accepted.');
      const result=await proposeClaimResolution(req.auth,param(req.params.claimId),req.body);
      sendSuccess(res,result,result.replayed?200:201);
    } catch(error) { next(error); }
  });
  router.post(`${resolution}/proposals/:proposalId/response`,noStore,auth,async(req,res,next)=>{
    try {
      if (Object.keys(req.query).length) throw AppError.validation('No query parameters are accepted.');
      const result=await respondClaimResolution(req.auth,param(req.params.claimId),param(req.params.proposalId),req.body);
      sendSuccess(res,result,result.replayed?200:201);
    } catch(error) { next(error); }
  });
  router.post(`${resolution}/proposals/:proposalId/finalize`,noStore,auth,async(req,res,next)=>{
    try {
      if (Object.keys(req.query).length) throw AppError.validation('No query parameters are accepted.');
      const result=await finalizeClaimResolution(req.auth,param(req.params.claimId),param(req.params.proposalId),req.body);
      sendSuccess(res,result,result.replayed?200:201);
    } catch(error) { next(error); }
  });

  router.get(
    '/handyman/execution-scopes/:executionScopeId/service-warranty',
    auth,
    read,
    getExecutionScopeServiceWarrantyHandler,
  );
  router.get(
    '/handyman/service-warranties/:warrantyId',
    auth,
    read,
    getServiceWarrantyByIdHandler,
  );
  router.get(
    '/handyman/service-warranty-claims/:claimId',
    auth,
    read,
    getServiceWarrantyClaimByIdHandler,
  );
  router.get(
    '/handyman/service-warranty-claims/:claimId/assessments',
    auth,
    getServiceWarrantyClaimAssessmentHandler,
  );
  router.get(
    '/handyman/service-warranty-reworks/:reworkId',
    auth,
    read,
    getServiceWarrantyReworkByIdHandler,
  );
  router.get(
    '/handyman/chargeable-additional-works/:workId',
    auth,
    read,
    getChargeableAdditionalWorkByIdHandler,
  );

  router.post(
    '/handyman/service-warranties/:warrantyId/claims',
    auth,
    manage,
    postOpenServiceWarrantyClaimHandler,
  );
  router.post(
    '/handyman/service-warranty-claims/:claimId/submit',
    auth,
    manage,
    postSubmitServiceWarrantyClaimHandler,
  );
  router.post(
    '/handyman/service-warranty-claims/:claimId/assessments',
    auth,
    assess,
    postServiceWarrantyClaimAssessmentHandler,
  );
  router.post(
    '/handyman/service-warranty-claims/:claimId/approve',
    auth,
    assess,
    postApproveServiceWarrantyClaimHandler,
  );
  router.post(
    '/handyman/service-warranty-claims/:claimId/reject',
    auth,
    assess,
    postRejectServiceWarrantyClaimHandler,
  );
  router.post(
    '/handyman/service-warranty-claims/:claimId/withdraw',
    auth,
    manage,
    postWithdrawServiceWarrantyClaimHandler,
  );
  router.post(
    '/handyman/service-warranty-reworks/:reworkId/authorize',
    auth,
    manage,
    postAuthorizeServiceWarrantyReworkHandler,
  );
  router.post(
    '/handyman/chargeable-additional-works/:workId/accept',
    auth,
    manage,
    postAcceptChargeableAdditionalWorkHandler,
  );
  router.post(
    '/handyman/chargeable-additional-works/:workId/reject',
    auth,
    manage,
    postRejectChargeableAdditionalWorkHandler,
  );

  return router;
}
