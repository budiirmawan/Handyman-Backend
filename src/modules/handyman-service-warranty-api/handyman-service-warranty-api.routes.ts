import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getChargeableAdditionalWorkByIdHandler,
  getExecutionScopeServiceWarrantyHandler,
  getServiceWarrantyByIdHandler,
  getServiceWarrantyClaimByIdHandler,
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
 *   POST /handyman/service-warranty-claims/:claimId/approve
 *   POST /handyman/service-warranty-claims/:claimId/reject
 *   POST /handyman/service-warranty-claims/:claimId/withdraw
 *   POST /handyman/service-warranty-reworks/:reworkId/authorize
 *   POST /handyman/chargeable-additional-works/:workId/accept
 *   POST /handyman/chargeable-additional-works/:workId/reject
 *
 * Reads require `tenant_company.read` + `canAccessClient`.
 * Customer claim & decision commands require `tenant_company.manage` +
 * `canAccessClient` + `idempotencyKey`.
 * Field-worker rework execution commands (`propose`, `start`, `complete`,
 * `verify`) and warranty lifecycle calculation commands (`start`, `expire`)
 * are NOT exposed.
 */
export function createHandymanServiceWarrantyApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

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
    '/handyman/service-warranty-claims/:claimId/approve',
    auth,
    manage,
    postApproveServiceWarrantyClaimHandler,
  );
  router.post(
    '/handyman/service-warranty-claims/:claimId/reject',
    auth,
    manage,
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
