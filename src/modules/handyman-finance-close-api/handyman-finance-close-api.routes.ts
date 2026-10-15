import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getBmFeeConfigurationHandler,
  getFinancialClientHandler,
  getFinancialTransactionHandler,
  getPricingContractHandler,
  postAdjustCustomerLedgerHandler,
  postAllocateCustomerPaymentHandler,
  postBmFeeBeneficiaryHandler,
  postBmFeeRuleHandler,
  postBmFeeTermHandler,
  postCommercialAgreementHandler,
  postCommercialAgreementVersionActivateHandler,
  postCommercialAgreementVersionSupersedeHandler,
  postCompleteServiceWarrantyReworkHandler,
  postComposeChargeLineHandler,
  postDeriveEntitlementsHandler,
  postExpireServiceWarrantyHandler,
  postIncludeSettlementHandler,
  postLaborPricingBasisHandler,
  postMaterialPricingBasisHandler,
  postOpenCustomerTransactionHandler,
  postPrepareSettlementHandler,
  postProposeServiceWarrantyReworkHandler,
  postReconcileSettlementHandler,
  postRefundCustomerPaymentHandler,
  postReverseCustomerPaymentHandler,
  postReversePaymentAllocationHandler,
  postSettlementCorrectionHandler,
  postSettlementDisputeHandler,
  postSettleSettlementHandler,
  postStartServiceWarrantyHandler,
  postStartServiceWarrantyReworkHandler,
  postVerifyServiceWarrantyReworkHandler,
} from './handyman-finance-close-api.controller';

/**
 * CR-HM-E2E-LIFECYCLE-01 — finance close HTTP seams for the merged
 * J10–J12 engines that previously had service-only surfaces:
 *
 *   J12 commercial/pricing authoring + published pricing reads
 *   J10 customer transaction open / charge composition / allocation /
 *       forward-only ledger corrections
 *   J12 entitlement derivation / settlement ladder / financial reads
 *   J11 service-warranty start/expire + field free-rework ladder
 *
 * Authority law:
 *  - commercial/pricing authoring is a client-scoped aggregate: RBAC
 *    `tenant_company.manage` plus a client-access guard in the
 *    controller (the authoring services own no Building guard);
 *  - scope-bound finance commands use RBAC `tenant_company.manage` and
 *    delegate exact-Building / ledger authority to the owning services;
 *  - financial/pricing reads use RBAC `tenant_company.read`;
 *  - field rework propose/start/complete/verify are authentication-only
 *    at transport (mirroring work-sessions / evidence-QC): Crew Leads
 *    hold no tenant RBAC permissions, and the rework service enforces
 *    CURRENT Crew Lead authority for the rework's original scope.
 *    Rework authorization (ACCEPT) remains the existing customer-side
 *    command on the service-warranty API.
 */
export function createHandymanFinanceCloseApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  /* J12 — commercial agreement + pricing/BM-fee authoring */
  router.post(
    '/handyman/commercial-agreements',
    auth,
    manage,
    postCommercialAgreementHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/activate',
    auth,
    manage,
    postCommercialAgreementVersionActivateHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/supersede',
    auth,
    manage,
    postCommercialAgreementVersionSupersedeHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/labor-pricing-basis',
    auth,
    manage,
    postLaborPricingBasisHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/material-pricing-basis',
    auth,
    manage,
    postMaterialPricingBasisHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/bm-fee-rule',
    auth,
    manage,
    postBmFeeRuleHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/bm-fee-term',
    auth,
    manage,
    postBmFeeTermHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/bm-fee-beneficiary',
    auth,
    manage,
    postBmFeeBeneficiaryHandler,
  );
  router.get(
    '/handyman/pricing-contract',
    auth,
    read,
    getPricingContractHandler,
  );
  router.get(
    '/handyman/bm-fee-configuration',
    auth,
    read,
    getBmFeeConfigurationHandler,
  );

  /* J10 — customer transaction, charges, allocations, corrections */
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-transaction',
    auth,
    manage,
    postOpenCustomerTransactionHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-charge-lines',
    auth,
    manage,
    postComposeChargeLineHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/payment-allocations',
    auth,
    manage,
    postAllocateCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-refunds',
    auth,
    manage,
    postRefundCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-reversals/allocation',
    auth,
    manage,
    postReversePaymentAllocationHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-reversals/payment',
    auth,
    manage,
    postReverseCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-adjustments',
    auth,
    manage,
    postAdjustCustomerLedgerHandler,
  );

  /* J12 — entitlements, settlement ladder, financial reads */
  router.post(
    '/handyman/execution-scopes/:executionScopeId/financial-entitlements/derive',
    auth,
    manage,
    postDeriveEntitlementsHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/prepare',
    auth,
    manage,
    postPrepareSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/include',
    auth,
    manage,
    postIncludeSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/reconcile',
    auth,
    manage,
    postReconcileSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/settle',
    auth,
    manage,
    postSettleSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/correction',
    auth,
    manage,
    postSettlementCorrectionHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/dispute',
    auth,
    manage,
    postSettlementDisputeHandler,
  );
  router.get(
    '/handyman/execution-scopes/:executionScopeId/financial-transaction',
    auth,
    read,
    getFinancialTransactionHandler,
  );
  router.get(
    '/handyman/financial-transactions',
    auth,
    read,
    getFinancialClientHandler,
  );

  /* J11 — service warranty start/expire */
  router.post(
    '/handyman/execution-scopes/:executionScopeId/service-warranty/start',
    auth,
    manage,
    postStartServiceWarrantyHandler,
  );
  router.post(
    '/handyman/service-warranties/:warrantyId/expire',
    auth,
    manage,
    postExpireServiceWarrantyHandler,
  );

  /* J11 — field free-rework ladder (service-enforced Crew Lead authority) */
  router.post(
    '/handyman/service-warranty-claims/:claimId/reworks',
    auth,
    postProposeServiceWarrantyReworkHandler,
  );
  router.post(
    '/handyman/service-warranty-reworks/:reworkId/start',
    auth,
    postStartServiceWarrantyReworkHandler,
  );
  router.post(
    '/handyman/service-warranty-reworks/:reworkId/complete',
    auth,
    postCompleteServiceWarrantyReworkHandler,
  );
  router.post(
    '/handyman/service-warranty-reworks/:reworkId/verify',
    auth,
    postVerifyServiceWarrantyReworkHandler,
  );

  return router;
}
