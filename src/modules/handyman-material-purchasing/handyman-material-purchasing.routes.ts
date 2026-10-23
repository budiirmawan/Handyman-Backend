import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { authenticationRequiredError } from '../auth/auth.errors';
import { sendSuccess } from '../../shared/api-response';
import {
  approveMaterialPurchaseReimbursement,
  approveMaterialPurchaseRequest,
  disburseMaterialPurchaseReimbursement,
  getFieldMaterialPurchase,
  getOperationsMaterialPurchase,
  listFieldMaterialPurchases,
  listFinanceMaterialReimbursements,
  listOperationsMaterialPurchases,
  listScopeFinanceMaterialReimbursements,
  reconcileMaterialPurchase,
  recordMaterialPurchaseReturn,
  recordMaterialPurchaseUsage,
  recordMaterialSupplierPurchase,
  recordMaterialWarehouseIssue,
  rejectMaterialPurchaseReimbursement,
  submitMaterialPurchaseRequest,
} from './handyman-material-purchasing.service';

export const handymanMaterialPurchasingRouter = Router();

export function createHandymanMaterialPurchasingRouter(): Router {
  return handymanMaterialPurchasingRouter;
}

// CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01 — scope the transport
// authentication wall to THIS router's own path families (see the
// field-evidence router note). A path-less router.use(auth) would
// 401 every later-mounted /api/v1 route, including unknown routes
// that must 404.
handymanMaterialPurchasingRouter.use(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases',
  authenticationMiddleware,
);
handymanMaterialPurchasingRouter.use(
  '/handyman/execution-scopes/:executionScopeId/material-purchases',
  authenticationMiddleware,
);
handymanMaterialPurchasingRouter.use(
  '/handyman/execution-scopes/:executionScopeId/material-reimbursements',
  authenticationMiddleware,
);
handymanMaterialPurchasingRouter.use(
  '/handyman/material-reimbursements',
  authenticationMiddleware,
);

// ============================================================================
// Field Worker Material & Purchasing Endpoints
// (/handyman/field/execution-scopes/:executionScopeId/material-purchases/...)
// ============================================================================

handymanMaterialPurchasingRouter.get(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await listFieldMaterialPurchases(
        req.auth.userId,
        req.params.executionScopeId,
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.get(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await getFieldMaterialPurchase(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases/requests',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await submitMaterialPurchaseRequest(
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

handymanMaterialPurchasingRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/issue',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordMaterialWarehouseIssue(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/purchase',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordMaterialSupplierPurchase(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/usage',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordMaterialPurchaseUsage(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/return',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordMaterialPurchaseReturn(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================================
// Operations / Manager Material & Purchasing Endpoints
// (/handyman/execution-scopes/:executionScopeId/material-purchases/...)
// ============================================================================

handymanMaterialPurchasingRouter.get(
  '/handyman/execution-scopes/:executionScopeId/material-purchases',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await listOperationsMaterialPurchases(
        req.auth.userId,
        req.params.executionScopeId,
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.get(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId',
  requirePermission('tenant_company.read'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await getOperationsMaterialPurchase(
        req.auth.userId,
        req.params.executionScopeId as string,
        req.params.purchaseRecordId as string,
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/approve',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await approveMaterialPurchaseRequest(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/issue',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordMaterialWarehouseIssue(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/purchase',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordMaterialSupplierPurchase(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/return',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await recordMaterialPurchaseReturn(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reconcile',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await reconcileMaterialPurchase(
        req.auth.userId,
        req.params.executionScopeId,
        req.params.purchaseRecordId,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

// ============================================================================
// Finance Worker Reimbursement Authority Endpoints (CR-HM-FIELD-EXPENSE-HELPER-01 PART 01)
// ============================================================================

handymanMaterialPurchasingRouter.get(
  '/handyman/material-reimbursements',
  requirePermission('handyman.finance.read'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await listFinanceMaterialReimbursements(
        req.auth.userId,
        req.query ?? {},
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.get(
  '/handyman/execution-scopes/:executionScopeId/material-reimbursements',
  requirePermission('handyman.finance.read'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const data = await listScopeFinanceMaterialReimbursements(
        req.auth.userId,
        req.params.executionScopeId as string,
      );
      sendSuccess(res, data, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reimbursement/approve',
  requirePermission('handyman.finance.manage'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await approveMaterialPurchaseReimbursement(
        req.auth.userId,
        req.params.executionScopeId as string,
        req.params.purchaseRecordId as string,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reimbursement/reject',
  requirePermission('handyman.finance.manage'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await rejectMaterialPurchaseReimbursement(
        req.auth.userId,
        req.params.executionScopeId as string,
        req.params.purchaseRecordId as string,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanMaterialPurchasingRouter.post(
  '/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reimbursement/disburse',
  requirePermission('handyman.finance.manage'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await disburseMaterialPurchaseReimbursement(
        req.auth.userId,
        req.params.executionScopeId as string,
        req.params.purchaseRecordId as string,
        req.body ?? {},
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);
