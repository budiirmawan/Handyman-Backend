import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelMaterialAddendumHandler,
  cancelMaterialDemandHandler,
  cancelMaterialReservationHandler,
  createCustomerSuppliedDemandHandler,
  createMaterialAddendumHandler,
  createOperationalDemandHandler,
  createQuotationIncludedDemandHandler,
  decideMaterialApprovalAssistedHandler,
  decideMaterialApprovalInAppHandler,
  getMaterialAddendumHandler,
  getMaterialApprovalHandler,
  getMaterialDemandFulfillmentHandler,
  getMaterialDemandHandler,
  getMaterialIssueHandler,
  issueMaterialHandler,
  listMaterialAddendaHandler,
  listMaterialApprovalsHandler,
  listMaterialDemandsHandler,
  listMaterialIssuesHandler,
  listMaterialReservationsHandler,
  listMaterialReturnsHandler,
  listMaterialUsagesHandler,
  recordMaterialUsageHandler,
  releaseMaterialReservationHandler,
  reserveMaterialHandler,
  returnMaterialHandler,
  supersedeMaterialDemandHandler,
} from './handyman-material-operations.controller';

/**
 * CR-HM-BE-07 RUN 3 — Material operations HTTP contract (material demands,
 * commercial addenda, customer approvals, inventory reservations,
 * controlled issues, actual usages, returns, derived fulfillment),
 * registered through the existing Asentra route composition (no separate
 * server/runtime). Every route requires an authenticated session; RBAC
 * then gates per route with the minimum correct permission:
 *
 * - `handyman_material.read`    → all operational reads (demands, addenda,
 *                                 approvals, reservations, issues, usages,
 *                                 returns, fulfillment projection).
 * - `handyman_material.manage`  → demand/addendum commands (create, cancel,
 *                                 supersede) and actual-use recording. The
 *                                 actor is attributed server-side; Run-2
 *                                 owns no lead-gate, so none is invented
 *                                 here (documented deviation from the
 *                                 aspirational lead composition).
 * - `handyman_material.approve` → ASSISTED approval decisions recorded by
 *                                 staff (the customer class is selected on
 *                                 the wire; every identity is derived
 *                                 server-side by the Run-1 service).
 * - IN_APP decision: authentication ONLY — deliberately NO manage/approve
 *   permission. The deciding party is the authorized tenant PIC/customer,
 *   resolved and verified exclusively by the Run-1 service through
 *   governed identity/context links (mirrors the quotation-approval
 *   precedent; no fabricated role, no staff-as-customer shortcut).
 * - Reserve/issue/return (and reservation release/cancel): composed
 *   `handyman_material.manage` AND the existing
 *   `inventory_stock.manage` — Handyman authority composed with, never
 *   duplicating, warehouse authority.
 *
 * There is deliberately NO generic CRUD: no PATCH/PUT/DELETE (facts are
 * append-only/converged, statuses server-managed), no pricing/invoice/
 * payment/BM-fee surface, no stock-balance or stock-movement endpoint, no
 * visit/session/arrival/presence lifecycle transition, and no Work Order
 * or vendor-work transition (material actions only reference a
 * visit/session where the services support it). All authorization beyond
 * RBAC (tenant-PIC relation, staff building scope, lead read allowance,
 * commercial basis, demand caps, allocation) stays service-owned —
 * controllers and routes decide nothing.
 */
export function createHandymanMaterialOperationsRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_material.read');
  const manage = requirePermission('handyman_material.manage');
  const approve = requirePermission('handyman_material.approve');
  const inventoryManage = requirePermission('inventory_stock.manage');

  // Material demands: job history, one demand, derived fulfillment, the
  // three creation lanes, cancel, and predecessor-addressed supersede.
  router.get('/handyman-jobs/:jobId/material-demands', auth, read, listMaterialDemandsHandler);
  router.get('/handyman-material-demands/:demandId', auth, read, getMaterialDemandHandler);
  router.get(
    '/handyman-material-demands/:demandId/fulfillment',
    auth,
    read,
    getMaterialDemandFulfillmentHandler,
  );
  router.post(
    '/handyman-jobs/:jobId/material-demands/quotation-included',
    auth,
    manage,
    createQuotationIncludedDemandHandler,
  );
  router.post(
    '/handyman-jobs/:jobId/material-demands/operational',
    auth,
    manage,
    createOperationalDemandHandler,
  );
  router.post(
    '/handyman-jobs/:jobId/material-demands/customer-supplied',
    auth,
    manage,
    createCustomerSuppliedDemandHandler,
  );
  router.post(
    '/handyman-material-demands/:demandId/cancel',
    auth,
    manage,
    cancelMaterialDemandHandler,
  );
  router.post(
    '/handyman-material-demands/:demandId/supersede',
    auth,
    manage,
    supersedeMaterialDemandHandler,
  );

  // Commercial addenda: job history, one addendum, create (with optional
  // governed supersession), cancel.
  router.get('/handyman-jobs/:jobId/material-addenda', auth, read, listMaterialAddendaHandler);
  router.get('/handyman-material-addenda/:addendumId', auth, read, getMaterialAddendumHandler);
  router.post(
    '/handyman-jobs/:jobId/material-addenda',
    auth,
    manage,
    createMaterialAddendumHandler,
  );
  router.post(
    '/handyman-material-addenda/:addendumId/cancel',
    auth,
    manage,
    cancelMaterialAddendumHandler,
  );

  // Material approvals: job history, one approval, direct (auth-only) and
  // assisted (approve permission) decisions. No anonymous/public surface.
  router.get('/handyman-jobs/:jobId/material-approvals', auth, read, listMaterialApprovalsHandler);
  router.get('/handyman-material-approvals/:approvalId', auth, read, getMaterialApprovalHandler);
  router.post(
    '/handyman-material-approvals/:approvalId/decision/in-app',
    auth,
    decideMaterialApprovalInAppHandler,
  );
  router.post(
    '/handyman-material-approvals/:approvalId/decision/assisted',
    auth,
    approve,
    decideMaterialApprovalAssistedHandler,
  );

  // Reservations: demand-scoped reserve/list plus terminal release/cancel.
  // No generic inventory reservation API is exposed.
  router.post(
    '/handyman-material-demands/:demandId/reservations',
    auth,
    manage,
    inventoryManage,
    reserveMaterialHandler,
  );
  router.get(
    '/handyman-material-demands/:demandId/reservations',
    auth,
    read,
    listMaterialReservationsHandler,
  );
  router.post(
    '/handyman-material-reservations/:reservationId/release',
    auth,
    manage,
    inventoryManage,
    releaseMaterialReservationHandler,
  );
  router.post(
    '/handyman-material-reservations/:reservationId/cancel',
    auth,
    manage,
    inventoryManage,
    cancelMaterialReservationHandler,
  );

  // Controlled issues: demand-scoped issue/list plus one issue by id.
  router.post(
    '/handyman-material-demands/:demandId/issues',
    auth,
    manage,
    inventoryManage,
    issueMaterialHandler,
  );
  router.get(
    '/handyman-material-demands/:demandId/issues',
    auth,
    read,
    listMaterialIssuesHandler,
  );
  router.get('/handyman-material-issues/:issueId', auth, read, getMaterialIssueHandler);

  // Actual usages: demand-scoped record/list (append-only field facts).
  router.post(
    '/handyman-material-demands/:demandId/usages',
    auth,
    manage,
    recordMaterialUsageHandler,
  );
  router.get('/handyman-material-demands/:demandId/usages', auth, read, listMaterialUsagesHandler);

  // Returns: issue-scoped return/list (routine STOCK_IN only).
  router.post(
    '/handyman-material-issues/:issueId/returns',
    auth,
    manage,
    inventoryManage,
    returnMaterialHandler,
  );
  router.get('/handyman-material-issues/:issueId/returns', auth, read, listMaterialReturnsHandler);

  return router;
}
