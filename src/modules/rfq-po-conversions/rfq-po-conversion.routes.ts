import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createRfqPoConversionHandler,
  getRfqPoConversionHandler,
  getRfqPoProvenanceHandler,
} from './rfq-po-conversion.controller';

/**
 * CR-BE-PRO-02 PART 06 — internal conversion only. The command uses existing
 * PO Readiness, Purchase Order, PO Line, and issuance authorities. No Vendor
 * session or Vendor Portal route is exposed.
 */
export function createRfqPoConversionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('rfq.read');
  const award = requirePermission('rfq.award');

  router.post('/rfq-awards/:awardId/convert-to-po', auth, award, createRfqPoConversionHandler);
  router.get('/rfq-po-conversions/:conversionId', auth, read, getRfqPoConversionHandler);
  router.get('/purchase-orders/:purchaseOrderId/rfq-provenance', auth, read, getRfqPoProvenanceHandler);

  return router;
}
