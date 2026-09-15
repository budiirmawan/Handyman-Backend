import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getManagementOperationalBudgetCategoriesHandler,
  getManagementOperationalBudgetSummaryHandler,
} from './management-operational-finance.controller';

/**
 * CR-BE-FIN-01 PART 05 — additive management API contract over PART 04.
 *
 * These routes are read-only facades. They delegate all monetary classification
 * and calculation to PART 04 and never alter /management/financial-summary.
 */
export function createManagementOperationalFinanceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('management_read_model.read');

  router.get(
    '/management/operational-finance/budgets/:budgetId/summary',
    auth,
    read,
    getManagementOperationalBudgetSummaryHandler,
  );
  router.get(
    '/management/operational-finance/budgets/:budgetId/categories',
    auth,
    read,
    getManagementOperationalBudgetCategoriesHandler,
  );

  return router;
}
