import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  listEvidenceByFiltersHandler,
  listEvidenceForWorkHandler,
  listRequirementsHandler,
  removeEvidenceHandler,
  submitEvidenceHandler,
} from './vendor-work-evidence.controller';

/**
 * BE-15E — Vendor Work Evidence Binding endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the service/controller after resolving
 * the Vendor Work's Building). Reuses the BE-07 shared evidence engine.
 *
 * Reads (`vendor.read`):
 *   GET  /vendor-works/:id/evidence-requirements
 *   GET  /vendor-works/:id/evidence
 *   GET  /vendor-work-evidence                 (?vendorWorkId= & ?vendorId= & ?buildingId=)
 * Management (`vendor.manage`):
 *   POST  /vendor-works/:id/evidence
 *   PATCH /vendor-work-evidence/:evidenceId    (soft remove)
 *
 * No Completion Report endpoints are exposed here.
 */
export function createVendorWorkEvidenceRouter(): Router {
  const router = Router();

  router.get(
    '/vendor-works/:id/evidence-requirements',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listRequirementsHandler,
  );
  router.post(
    '/vendor-works/:id/evidence',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    submitEvidenceHandler,
  );
  router.get(
    '/vendor-works/:id/evidence',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listEvidenceForWorkHandler,
  );
  router.get(
    '/vendor-work-evidence',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listEvidenceByFiltersHandler,
  );
  router.patch(
    '/vendor-work-evidence/:evidenceId',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    removeEvidenceHandler,
  );

  return router;
}
