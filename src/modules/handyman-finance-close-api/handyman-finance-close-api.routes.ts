import { createHandymanFinancialReconciliationRouter } from './handyman-financial-reconciliation.routes';
import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getBmFeeConfigurationHandler,
  getFinalCloseReadinessHandler,
  getFinanceActionInboxHandler,
  getFinancialClientHandler,
  getFinancialTransactionHandler,
  getWarrantyReworkExecutionHandler,
  getInvoiceReconciliationSummaryHandler,
  getPricingContractHandler,
  postAdjustCustomerLedgerHandler,
  postReduceFinancialCorrectionHandler,
  postAllocateCustomerPaymentHandler,
  postBmFeeBeneficiaryHandler,
  postBmFeeRuleHandler,
  postBmFeeTermHandler,
  postCommercialAgreementHandler,
  postCommercialAgreementVersionActivateHandler,
  postCommercialAgreementVersionSupersedeHandler,
  postCompleteServiceWarrantyReworkHandler,
  postCreateWarrantyReworkExecutionHandler,
  postComposeChargeLineHandler,
  postDeriveEntitlementsHandler,
  postExecuteManagerFinalCloseHandler,
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
  postSettlementDisputeResolutionHandler,
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
 * Authority law (CR-HM-FIN-AUTH-01):
 *  - commercial agreement / pricing / BM-fee authoring and warranty
 *    start/expire require `handyman.commercial.manage` plus Client
 *    access (controller guard / scope guard in the services);
 *  - ledger open/charge/allocation/corrections and entitlement
 *    derivation require `handyman.finance.manage` plus exact-Building
 *    scope in the owning services; settlement ladder commands require
 *    `handyman.settlement.manage` (never implies refund authority);
 *  - financial/pricing reads require `handyman.finance.read`;
 *  - generic `tenant_company.manage` alone authorizes none of these;
 *  - field rework propose/start/complete/verify are authentication-only
 *    at transport (mirroring work-sessions / evidence-QC): Crew Leads
 *    hold no tenant RBAC permissions, and the rework service enforces
 *    CURRENT Crew Lead authority for the separate rework scope.
 *    Rework authorization (ACCEPT) remains the existing customer-side
 *    command on the service-warranty API.
 */
export function createHandymanFinanceCloseApiRouter(): Router {
  const router = Router();
  router.use(createHandymanFinancialReconciliationRouter());
  const auth = authenticationMiddleware;
  // CR-HM-FIN-AUTH-01 — explicit domain authorities. Generic
  // `tenant_company.manage` alone authorizes none of these commands;
  // Client / exact-Building scope is still enforced by the services.
  const commercial = requirePermission('handyman.commercial.manage');
  const financeRead = requirePermission('handyman.finance.read');
  const finance = requirePermission('handyman.finance.manage');
  const settlement = requirePermission('handyman.settlement.manage');
  const managerClose = requirePermission('finding.close');

  /* J10/J11 — Invoice & DP reconciliation summary + Manager FINAL CLOSE */
  router.get(
    '/handyman/execution-scopes/:executionScopeId/invoice-reconciliation',
    auth,
    financeRead,
    getInvoiceReconciliationSummaryHandler,
  );
  router.get(
    '/handyman/execution-scopes/:executionScopeId/final-close/readiness',
    auth,
    financeRead,
    getFinalCloseReadinessHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/final-close',
    auth,
    managerClose,
    financeRead,
    postExecuteManagerFinalCloseHandler,
  );

  /* J12 — commercial agreement + pricing/BM-fee authoring */
  router.post(
    '/handyman/commercial-agreements',
    auth,
    commercial,
    postCommercialAgreementHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/activate',
    auth,
    commercial,
    postCommercialAgreementVersionActivateHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/supersede',
    auth,
    commercial,
    postCommercialAgreementVersionSupersedeHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/labor-pricing-basis',
    auth,
    commercial,
    postLaborPricingBasisHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/material-pricing-basis',
    auth,
    commercial,
    postMaterialPricingBasisHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/bm-fee-rule',
    auth,
    commercial,
    postBmFeeRuleHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/bm-fee-term',
    auth,
    commercial,
    postBmFeeTermHandler,
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/bm-fee-beneficiary',
    auth,
    commercial,
    postBmFeeBeneficiaryHandler,
  );
  router.get(
    '/handyman/pricing-contract',
    auth,
    financeRead,
    getPricingContractHandler,
  );
  router.get(
    '/handyman/bm-fee-configuration',
    auth,
    financeRead,
    getBmFeeConfigurationHandler,
  );

  /* J10 — customer transaction, charges, allocations, corrections */
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-transaction',
    auth,
    finance,
    postOpenCustomerTransactionHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-charge-lines',
    auth,
    finance,
    postComposeChargeLineHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/payment-allocations',
    auth,
    finance,
    postAllocateCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-refunds',
    auth,
    finance,
    postRefundCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-reversals/allocation',
    auth,
    finance,
    postReversePaymentAllocationHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-reversals/payment',
    auth,
    finance,
    postReverseCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/variations/:variationId/financial-correction',
    auth,
    finance,
    postReduceFinancialCorrectionHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/ledger-adjustments',
    auth,
    finance,
    postAdjustCustomerLedgerHandler,
  );

  /* J12 — entitlements, settlement ladder, financial reads */
  router.post(
    '/handyman/execution-scopes/:executionScopeId/financial-entitlements/derive',
    auth,
    finance,
    postDeriveEntitlementsHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/prepare',
    auth,
    settlement,
    postPrepareSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/include',
    auth,
    settlement,
    postIncludeSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/reconcile',
    auth,
    settlement,
    postReconcileSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/settle',
    auth,
    settlement,
    postSettleSettlementHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/correction',
    auth,
    settlement,
    postSettlementCorrectionHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/dispute',
    auth,
    settlement,
    postSettlementDisputeHandler,
  );

  router.post(
    '/handyman/execution-scopes/:executionScopeId/settlement/dispute/resolution',
    auth,
    settlement,
    postSettlementDisputeResolutionHandler,
  );
  router.get(
    '/handyman/execution-scopes/:executionScopeId/financial-transaction',
    auth,
    financeRead,
    getFinancialTransactionHandler,
  );
  router.get(
    '/handyman/financial-transactions',
    auth,
    financeRead,
    getFinancialClientHandler,
  );
  router.get(
    '/handyman/finance/action-inbox',
    auth,
    financeRead,
    getFinanceActionInboxHandler,
  );

  /* J11 — service warranty start/expire */
  router.post(
    '/handyman/execution-scopes/:executionScopeId/service-warranty/start',
    auth,
    commercial,
    postStartServiceWarrantyHandler,
  );
  router.post(
    '/handyman/service-warranties/:warrantyId/expire',
    auth,
    commercial,
    postExpireServiceWarrantyHandler,
  );

  /* J11 — field free-rework ladder (service-enforced Crew Lead authority) */
  router.post(
    '/handyman/service-warranty-claims/:claimId/reworks',
    auth,
    postProposeServiceWarrantyReworkHandler,
  );
  router.post(
    '/handyman/service-warranty-reworks/:reworkId/execution',
    auth,
    postCreateWarrantyReworkExecutionHandler,
  );
  router.get(
    '/handyman/service-warranty-reworks/:reworkId/execution',
    auth,
    getWarrantyReworkExecutionHandler,
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
