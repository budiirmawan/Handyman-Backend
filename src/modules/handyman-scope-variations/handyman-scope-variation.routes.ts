import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { authenticationRequiredError } from '../auth/auth.errors';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { sendQuotationDocumentPdf } from '../handyman-quotations/handyman-quotation-document.routes';
import { downloadVariationOfferDocument } from './handyman-variation-offer-document.service';
import {
  authorizeVariationScope,
  confirmVariationFinalChargeEligibility,
  listFieldScopeVariations,
  listOperationsScopeVariations,
  prepareVariationRevisedQuotation,
  promoteFieldFindingToProposal,
  proposeScopeVariation,
  recordVariationExecution,
  recordVariationQc,
  recordVariationTenantDecision,
  reviewScopeVariation,
  submitFieldFindingVariation,
} from './handyman-scope-variation.service';

export const handymanScopeVariationRouter = Router();

export function createHandymanScopeVariationRouter(): Router {
  return handymanScopeVariationRouter;
}

// CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01 — scope the transport
// authentication wall to THIS router's own path families (see the
// field-evidence router note). A path-less router.use(auth) would
// 401 every later-mounted /api/v1 route, including unknown routes
// that must 404.
handymanScopeVariationRouter.use(
  '/handyman/field/execution-scopes/:executionScopeId/variations',
  authenticationMiddleware,
);
handymanScopeVariationRouter.use(
  '/handyman/execution-scopes/:executionScopeId/variations',
  authenticationMiddleware,
);

// ============================================================================
// Field Worker Variation Endpoints (/handyman/field/execution-scopes/:id/...)
// ============================================================================

handymanScopeVariationRouter.get(
  '/handyman/field/execution-scopes/:executionScopeId/variations',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await listFieldScopeVariations(
        req.auth.userId,
        req.params.executionScopeId,
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/variations/findings',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await submitFieldFindingVariation(
        req.auth.userId,
        req.params.executionScopeId,
        req.body ?? {},
      );
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/variations/proposals',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await proposeScopeVariation(
        req.auth.userId,
        req.params.executionScopeId,
        req.body ?? {},
      );
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/variations/:variationId/propose',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await promoteFieldFindingToProposal(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/variations/:variationId/execution',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordVariationExecution(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/variations/:variationId/qc',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordVariationQc(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================================
// Operations / Manager & Tenant Variation Endpoints
// (/handyman/execution-scopes/:executionScopeId/variations/...)
// ============================================================================

handymanScopeVariationRouter.get(
  '/handyman/execution-scopes/:executionScopeId/variations',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await listOperationsScopeVariations(
        req.auth.userId,
        req.params.executionScopeId,
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.get(
  '/handyman/execution-scopes/:executionScopeId/variations/:variationId/offer.pdf',
  async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (!req.auth) throw authenticationRequiredError();
      if (Object.keys(req.query).length || (req.body !== undefined &&
          (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
        throw AppError.validation('Variation offer download accepts no context fields.');
      }
      const document = await downloadVariationOfferDocument(req.auth.userId, req.params.executionScopeId, req.params.variationId);
      res.setHeader('X-Variation-Offer-Id', document.id);
      res.setHeader('X-Variation-Offer-Version', String(document.version));
      sendQuotationDocumentPdf(res, document);
    } catch (error) { next(error); }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/execution-scopes/:executionScopeId/variations/:variationId/operations-review',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await reviewScopeVariation(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/execution-scopes/:executionScopeId/variations/:variationId/revised-quotation',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await prepareVariationRevisedQuotation(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/execution-scopes/:executionScopeId/variations/:variationId/tenant-decision',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordVariationTenantDecision(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/execution-scopes/:executionScopeId/variations/:variationId/authorize-scope',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await authorizeVariationScope(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/execution-scopes/:executionScopeId/variations/:variationId/qc',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordVariationQc(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanScopeVariationRouter.post(
  '/handyman/execution-scopes/:executionScopeId/variations/:variationId/final-charge-eligibility',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await confirmVariationFinalChargeEligibility(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.variationId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);
