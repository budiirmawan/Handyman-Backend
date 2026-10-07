import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  addRfqLineHandler,
  cancelRfqHandler,
  closeRfqHandler,
  createRfqHandler,
  getRfqAvailableActionsHandler,
  getRfqHandler,
  getRfqLineHandler,
  listRfqLinesHandler,
  listRfqsHandler,
  openRfqHandler,
  updateRfqHandler,
} from './rfq.controller';

/**
 * CR-BE-PRO-02 PART 01 — RFQ foundation and typed demand lineage.
 *
 * This surface intentionally stops before Vendor Invitations, Quotations,
 * Comparison, Evaluation, Recommendation, Approval/Award, PO conversion, and
 * finance. Every route is internal and Building-scoped through the RFQ source.
 */
export function createRfqRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('rfq.read');
  const manage = requirePermission('rfq.manage');

  router.post('/rfqs', auth, manage, createRfqHandler);
  router.get('/rfqs', auth, read, listRfqsHandler);
  router.get('/rfqs/:id', auth, read, getRfqHandler);
  router.patch('/rfqs/:id', auth, manage, updateRfqHandler);
  router.get('/rfqs/:id/available-actions', auth, read, getRfqAvailableActionsHandler);
  router.post('/rfqs/:id/open', auth, manage, openRfqHandler);
  router.post('/rfqs/:id/close', auth, manage, closeRfqHandler);
  router.post('/rfqs/:id/cancel', auth, manage, cancelRfqHandler);

  router.post('/rfqs/:id/lines', auth, manage, addRfqLineHandler);
  router.get('/rfqs/:id/lines', auth, read, listRfqLinesHandler);
  router.get('/rfq-lines/:lineId', auth, read, getRfqLineHandler);

  return router;
}
