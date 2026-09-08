import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createEsgWasteRecordHandler,
  deactivateEsgWasteRecordHandler,
  getEsgWasteRecordHandler,
  listEsgWasteRecordsHandler,
  updateEsgWasteRecordHandler,
} from './esg-waste-record.controller';

/**
 * CR-BE-ESG-01 PART 02 — Waste Operational Records endpoints,
 * protected by BE-01 RBAC and BE-02 Building isolation.
 *
 * Reads (`esg.read`):
 *   GET /esg/waste-records
 *   GET /esg/waste-records/:id
 * Management (`esg.manage`):
 *   POST   /esg/waste-records
 *   PATCH  /esg/waste-records/:id
 *   POST   /esg/waste-records/:id/deactivate
 *
 * Building isolation via `canAccessBuilding` / `getAccessibleBuildingIds`.
 * Vendor same-Client enforced in service. UOM same-Client ACTIVE.
 * Functional location same-Building.
 *
 * No metric values, aggregation, recycling KPI, baselines/targets,
 * verification, evidence bindings, environmental records, emissions.
 */
export function createEsgWasteRecordRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('esg.read');
  const manage = requirePermission('esg.manage');

  router.post('/esg/waste-records', auth, manage, createEsgWasteRecordHandler);
  router.get('/esg/waste-records', auth, read, listEsgWasteRecordsHandler);
  router.get('/esg/waste-records/:id', auth, read, getEsgWasteRecordHandler);
  router.patch('/esg/waste-records/:id', auth, manage, updateEsgWasteRecordHandler);
  router.post(
    '/esg/waste-records/:id/deactivate',
    auth,
    manage,
    deactivateEsgWasteRecordHandler,
  );

  return router;
}
