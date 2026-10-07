import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createRfqComparisonEvaluationHandler,
  createRfqComparisonHandler,
  getRfqComparisonEvaluationHandler,
  getRfqComparisonHandler,
  listRfqComparisonEvaluationsHandler,
  listRfqComparisonsHandler,
  updateRfqComparisonEvaluationHandler,
} from './rfq-comparison.controller';

/**
 * CR-BE-PRO-02 PART 04 — internal-only immutable comparison runs and explicit
 * human evaluation notes. No Vendor RFQ session route is mounted here.
 */
export function createRfqComparisonRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('rfq.read');
  const manage = requirePermission('rfq.manage');

  router.post('/rfqs/:rfqId/comparisons', auth, manage, createRfqComparisonHandler);
  router.get('/rfqs/:rfqId/comparisons', auth, read, listRfqComparisonsHandler);
  router.get('/rfq-comparisons/:comparisonId', auth, read, getRfqComparisonHandler);
  router.get('/rfq-comparisons/:comparisonId/evaluations', auth, read, listRfqComparisonEvaluationsHandler);
  router.post('/rfq-comparisons/:comparisonId/evaluations', auth, manage, createRfqComparisonEvaluationHandler);

  router.get('/rfq-comparison-evaluations/:evaluationId', auth, read, getRfqComparisonEvaluationHandler);
  router.patch('/rfq-comparison-evaluations/:evaluationId', auth, manage, updateRfqComparisonEvaluationHandler);

  return router;
}
