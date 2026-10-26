import { Router, type NextFunction, type Request, type Response } from 'express';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  financialQuotation,
  financialId,
} from '../handyman-customer-transactions/handyman-financial-integration-access';
import {
  agreeInspectionFee,
  creditPaidInspection,
  prepareInspectionFeeOffer,
  readInspectionFee,
} from '../handyman-customer-transactions/handyman-inspection-fee.service';
import {
  applyHandymanWithholdingCredit,
  prepareHandymanTaxProfile,
  readHandymanTaxReconciliation,
  reconcileHandymanPayment,
  recordHandymanBmFiscalDocument,
  recordHandymanFiscalDocument,
} from '../handyman-customer-transactions/handyman-financial-tax.service';
import { financialConflict } from '../handyman-pricing-contract/handyman-indonesia-tax';

/** Thin transport on the existing Finance family. No financial status/amount,
 * actor, Client, Building, beneficiary or fee rate is accepted as authority. */
export function createHandymanFinancialReconciliationRouter(): Router {
  const router = Router(),
    auth = authenticationMiddleware,
    finance = requirePermission('handyman.finance.manage'),
    read = requirePermission('handyman.finance.read');
  function body(req: Request, keys: string[]) {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((k) => !keys.includes(k))
    )
      throw AppError.validation('Unexpected/malformed financial command fields.');
    return req.body;
  }
  function handle(work: (req: Request) => Promise<unknown>) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, await work(req), 200);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          try {
            financialConflict('An immutable financial reference or source was already used.');
          } catch (error) {
            next(error);
          }
          return;
        }
        next(e);
      }
    };
  }
  const id = (req: Request, k: string) => financialId(req.params[k]);
  router.post(
    '/handyman/quotation-versions/:quotationVersionId/inspection-fee-offer',
    auth,
    finance,
    handle((req) =>
      prepareInspectionFeeOffer(
        id(req, 'quotationVersionId'),
        body(req, ['handymanRequestId', 'treatment', 'noProceedTreatment', 'creditMode']),
        req.auth.userId,
      ),
    ),
  );
  router.post(
    '/handyman/requests/:handymanRequestId/inspection-fee',
    auth,
    finance,
    handle((req) =>
      agreeInspectionFee(
        id(req, 'handymanRequestId'),
        body(req, ['treatment', 'feeExecutionScopeId', 'idempotencyKey']),
        req.auth.userId,
      ),
    ),
  );
  router.get(
    '/handyman/requests/:handymanRequestId/inspection-fee',
    auth,
    requirePermission('tenant_company.read'),
    handle((req) => readInspectionFee(id(req, 'handymanRequestId'), req.auth.userId)),
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/inspection-credit',
    auth,
    finance,
    handle((req) =>
      creditPaidInspection(
        id(req, 'executionScopeId'),
        body(req, ['chargeLineId', 'idempotencyKey']),
        req.auth.userId,
      ),
    ),
  );
  router.post(
    '/handyman/quotation-versions/:quotationVersionId/tax-profile',
    auth,
    finance,
    handle((req) =>
      prepareHandymanTaxProfile(
        { quotationVersionId: id(req, 'quotationVersionId') },
        body(req, ['facts']).facts,
        req.auth.userId,
      ),
    ),
  );
  router.post(
    '/handyman/commercial-agreement-versions/:agreementVersionId/tax-profile',
    auth,
    requirePermission('handyman.commercial.manage'),
    handle((req) =>
      prepareHandymanTaxProfile(
        { agreementVersionId: id(req, 'agreementVersionId') },
        body(req, ['facts']).facts,
        req.auth.userId,
      ),
    ),
  );
  router.get(
    '/handyman/quotation-versions/:quotationVersionId/financial-terms',
    auth,
    requirePermission('tenant_company.read'),
    handle(async (req) => {
      const version = id(req, 'quotationVersionId'),
        db = getPool();
      await financialQuotation(db, version, req.auth.userId);
      const tax = (
        await db.query(
          'SELECT facts FROM handyman_financial_tax_profiles WHERE quotation_version_id=$1',
          [version],
        )
      ).rows[0]?.facts;
      const offer = (
        await db.query(
          'SELECT handyman_request_id,treatment,no_proceed_treatment,credit_mode FROM handyman_inspection_fee_offers WHERE quotation_version_id=$1',
          [version],
        )
      ).rows[0];
      return {
        quotationVersionId: version,
        inspectionOffer: offer ?? null,
        tax: tax
          ? {
              priceBasis: tax.priceBasis,
              providerStatus: tax.providerStatus,
              vatRegime: tax.vatRegime,
              incomeTax: tax.incomeTax,
              payerIsWithholder: tax.payerIsWithholder,
              serviceClass: tax.serviceClass,
            }
          : null,
        unconfiguredTaxIsExempt: false,
      };
    }),
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reconciliation',
    auth,
    finance,
    handle((req) =>
      reconcileHandymanPayment(
        id(req, 'executionScopeId'),
        id(req, 'paymentId'),
        body(req, ['bankReference', 'actualReceivedAt', 'idempotencyKey']),
        req.auth.userId,
      ),
    ),
  );
  router.get(
    '/handyman/execution-scopes/:executionScopeId/tax-reconciliation',
    auth,
    read,
    handle((req) => readHandymanTaxReconciliation(id(req, 'executionScopeId'), req.auth.userId)),
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/fiscal-documents',
    auth,
    finance,
    handle((req) =>
      recordHandymanFiscalDocument(
        id(req, 'executionScopeId'),
        body(req, [
          'kind',
          'paymentId',
          'grossLabor',
          'grossMaterial',
          'taxPointAt',
          'documentDate',
          'externalReference',
          'withholdingReference',
          'previousDocumentId',
          'idempotencyKey',
        ]),
        req.auth.userId,
      ),
    ),
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/fiscal-documents/:documentId/withholding-credit',
    auth,
    finance,
    handle((req) => {
      body(req, []);
      return applyHandymanWithholdingCredit(
        id(req, 'executionScopeId'),
        id(req, 'documentId'),
        req.auth.userId,
      );
    }),
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/bm-fiscal-document',
    auth,
    requirePermission('handyman.settlement.manage'),
    handle((req) =>
      recordHandymanBmFiscalDocument(
        id(req, 'executionScopeId'),
        body(req, [
          'taxPointAt',
          'documentDate',
          'externalReference',
          'withholdingReference',
          'reconciliationReference',
          'idempotencyKey',
        ]),
        req.auth.userId,
      ),
    ),
  );
  return router;
}
