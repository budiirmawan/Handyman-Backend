import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getOperationalBudgetAggregationHandler } from './operational-finance-aggregation.controller';
import {
  getOperationalBudgetTraceabilityHandler,
  getOperationalBudgetVarianceHandler,
  listOperationalBudgetVarianceHandler,
} from './operational-variance.controller';
import {
  adjustOperationalCommitmentHandler,
  cancelOperationalCommitmentHandler,
  changeOperationalBudgetOverspendPolicyHandler,
  createOperationalCommitmentHandler,
  createPurchaseOrderLineCommitmentHandler,
  getOperationalCommitmentHandler,
  listOperationalCommitmentsHandler,
  releaseOperationalCommitmentHandler,
} from './operational-commitment.controller';
import {
  createOperationalBudgetSourceBindingHandler,
  getOperationalBudgetSourceBindingHandler,
  listOperationalBudgetSourceBindingsHandler,
  removeOperationalBudgetSourceBindingHandler,
} from './operational-finance-binding.controller';
import {
  activateOperationalBudgetHandler,
  cancelOperationalBudgetHandler,
  closeOperationalBudgetHandler,
  createOperationalBudgetCategoryHandler,
  createOperationalBudgetHandler,
  deleteOperationalBudgetCategoryHandler,
  getOperationalBudgetCategoryHandler,
  getOperationalBudgetHandler,
  listOperationalBudgetCategoriesHandler,
  listOperationalBudgetsHandler,
  updateOperationalBudgetCategoryHandler,
  updateOperationalBudgetHandler,
} from './operational-finance.controller';

/**
 * CR-BE-FIN-01 PART 01–04 — Operational Finance budget, lineage and read-time controls.
 *
 * This route surface owns budget/category control and typed source lineage
 * metadata only. It has no source amount aggregation, variance, approval
 * workflow, or accounting behavior. All routes are protected by RBAC and the
 * service resolves the authoritative Client through the requested Building.
 */
export function createOperationalFinanceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('operational_budget.read');
  const manage = requirePermission('operational_budget.manage');
  // CR-BE-COMM-VAR-01 PART 02 — exceeding approved spending authority is a
  // separate permission from administering a budget.
  const override = requirePermission('operational_budget.override');

  router.post(
    '/buildings/:buildingId/operational-budgets',
    auth,
    manage,
    createOperationalBudgetHandler,
  );
  router.get(
    '/buildings/:buildingId/operational-budgets',
    auth,
    read,
    listOperationalBudgetsHandler,
  );
  router.get('/operational-budgets', auth, read, listOperationalBudgetsHandler);
  router.get('/operational-budgets/:id', auth, read, getOperationalBudgetHandler);
  router.patch(
    '/operational-budgets/:id',
    auth,
    manage,
    updateOperationalBudgetHandler,
  );
  router.post(
    '/operational-budgets/:id/activate',
    auth,
    manage,
    activateOperationalBudgetHandler,
  );
  router.post(
    '/operational-budgets/:id/close',
    auth,
    manage,
    closeOperationalBudgetHandler,
  );
  router.post(
    '/operational-budgets/:id/cancel',
    auth,
    manage,
    cancelOperationalBudgetHandler,
  );

  router.post(
    '/operational-budgets/:budgetId/categories',
    auth,
    manage,
    createOperationalBudgetCategoryHandler,
  );
  router.get(
    '/operational-budgets/:budgetId/categories',
    auth,
    read,
    listOperationalBudgetCategoriesHandler,
  );
  router.get(
    '/operational-budget-categories/:id',
    auth,
    read,
    getOperationalBudgetCategoryHandler,
  );
  router.patch(
    '/operational-budget-categories/:id',
    auth,
    manage,
    updateOperationalBudgetCategoryHandler,
  );
  router.delete(
    '/operational-budget-categories/:id',
    auth,
    manage,
    deleteOperationalBudgetCategoryHandler,
  );

  // CR-BE-FIN-01 PART 04 — read-time aggregation; no persisted monetary snapshots.
  router.get(
    '/operational-budgets/:budgetId/aggregation',
    auth,
    read,
    getOperationalBudgetAggregationHandler,
  );
  router.get(
    '/operational-budgets/:budgetId/summary',
    auth,
    read,
    getOperationalBudgetAggregationHandler,
  );

  // CR-BE-FIN-01 PART 03 — typed lineage only; no source amount aggregation.
  router.post(
    '/operational-budgets/:budgetId/source-bindings',
    auth,
    manage,
    createOperationalBudgetSourceBindingHandler,
  );
  router.get(
    '/operational-budgets/:budgetId/source-bindings',
    auth,
    read,
    listOperationalBudgetSourceBindingsHandler,
  );
  router.get(
    '/operational-budget-source-bindings/:id',
    auth,
    read,
    getOperationalBudgetSourceBindingHandler,
  );
  router.post(
    '/operational-budget-source-bindings/:id/remove',
    auth,
    manage,
    removeOperationalBudgetSourceBindingHandler,
  );

  // CR-BE-COMM-VAR-01 PART 02 — commitment ledger. There is no endpoint that
  // writes an actual amount or edits a commitment amount in place: correction
  // is an append-only adjustment, release, or cancellation.
  router.post(
    '/operational-budgets/:budgetId/commitments',
    auth,
    manage,
    createOperationalCommitmentHandler,
  createPurchaseOrderLineCommitmentHandler,
  );
  // CR-BE-COMM-VAR-01 PART 03 — the ISSUED Purchase Order line is the only
  // automatic commitment authority in the repository. The amount is derived
  // from the line; only the explicit cost category is supplied.
  router.post(
    '/operational-budgets/:budgetId/commitments/from-purchase-order-line',
    auth,
    manage,
    createPurchaseOrderLineCommitmentHandler,
  );
  router.get(
    '/operational-budgets/:budgetId/commitments',
    auth,
    read,
    listOperationalCommitmentsHandler,
  );
  router.get(
    '/operational-commitments/:id',
    auth,
    read,
    getOperationalCommitmentHandler,
  );
  router.post(
    '/operational-commitments/:id/adjust',
    auth,
    manage,
    adjustOperationalCommitmentHandler,
  );
  router.post(
    '/operational-commitments/:id/release',
    auth,
    manage,
    releaseOperationalCommitmentHandler,
  );
  router.post(
    '/operational-commitments/:id/cancel',
    auth,
    manage,
    cancelOperationalCommitmentHandler,
  );

  // Narrow, separately authorised overspend-policy transition for a DRAFT or
  // ACTIVE budget. The generic budget PATCH stays DRAFT-only.
  router.post(
    '/operational-budgets/:id/overspend-policy',
    auth,
    manage,
    override,
    changeOperationalBudgetOverspendPolicyHandler,
  );

  // CR-BE-COMM-VAR-01 PART 05 — derived variance + traceability read model.
  // Read-only: no financial mutation surface is added here.
  router.get(
    '/operational-budget-variance',
    auth,
    read,
    listOperationalBudgetVarianceHandler,
  );
  router.get(
    '/buildings/:buildingId/operational-budget-variance',
    auth,
    read,
    listOperationalBudgetVarianceHandler,
  );
  router.get(
    '/operational-budgets/:budgetId/variance',
    auth,
    read,
    getOperationalBudgetVarianceHandler,
  );
  router.get(
    '/operational-budgets/:budgetId/traceability',
    auth,
    read,
    getOperationalBudgetTraceabilityHandler,
  );

  return router;
}
