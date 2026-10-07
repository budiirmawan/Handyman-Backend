import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  activateWorkContractHandler,
  cancelWorkContractHandler,
  completeWorkContractHandler,
  createWorkContractHandler,
  getWorkContractAvailableActionsHandler,
  getWorkContractHandler,
  listWorkContractsHandler,
  updateWorkContractHandler,
} from './work-contract.controller';

/**
 * CR-BE-R2P-01 PART 04 — SPK / Work Contract endpoints.
 *
 * The SPK is the EXECUTION MANDATE that follows a committed Purchase Order.
 * It is its own entity: it does not duplicate the BE-17H Work Order
 * Procurement Binding domain, and it holds no Work Order linkage — that is
 * PART 05.
 *
 * Management (`work_contract.manage`):
 *   POST  /work-contracts              (raise against an ISSUED PO)
 *   PATCH /work-contracts/:id          (DRAFT only)
 *   POST  /work-contracts/:id/activate (DRAFT → ACTIVE)
 *   POST  /work-contracts/:id/complete (ACTIVE → COMPLETED)
 *   POST  /work-contracts/:id/cancel   (DRAFT | ACTIVE → CANCELLED)
 *
 * Reads (`work_contract.read`):
 *   GET   /work-contracts              (?purchaseOrderId= & ?vendorId= &
 *                                       ?buildingId= & ?status= &
 *                                       ?spkDateFrom= & ?spkDateTo=)
 *   GET   /work-contracts/:id
 *   GET   /work-contracts/:id/available-actions
 *         (caller-specific; manage permission + existing command authority)
 *
 * BE-02 Building isolation is enforced in the service after resolving the
 * Purchase Order / record Building, so these routes inherit BE-02G rather
 * than opening a side channel around it.
 *
 * Deliberately NOT here: SPK ↔ Work Order linkage (PART 05). No PO issuance,
 * material-quantity, receiving, invoice or payment behavior changes.
 */
export function createWorkContractRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('work_contract.read');
  const manage = requirePermission('work_contract.manage');

  router.post('/work-contracts', auth, manage, createWorkContractHandler);
  router.get('/work-contracts', auth, read, listWorkContractsHandler);
  router.get('/work-contracts/:id', auth, read, getWorkContractHandler);
  router.get(
    '/work-contracts/:id/available-actions',
    auth,
    read,
    getWorkContractAvailableActionsHandler,
  );
  router.patch('/work-contracts/:id', auth, manage, updateWorkContractHandler);
  router.post(
    '/work-contracts/:id/activate',
    auth,
    manage,
    activateWorkContractHandler,
  );
  router.post(
    '/work-contracts/:id/complete',
    auth,
    manage,
    completeWorkContractHandler,
  );
  router.post(
    '/work-contracts/:id/cancel',
    auth,
    manage,
    cancelWorkContractHandler,
  );

  return router;
}
