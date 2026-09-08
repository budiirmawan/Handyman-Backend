import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorComplianceDocumentHandler,
  getVendorComplianceDocumentHandler,
  listVendorComplianceDocumentsHandler,
  updateVendorComplianceDocumentHandler,
} from './vendor-compliance-document.controller';

/**
 * BE-06G — Vendor Compliance Document endpoints, protected by BE-01 RBAC.
 *
 * Reads (`vendor.read`):        GET   /vendors/:vendorId/compliance-documents
 *                               GET   /vendor-compliance-documents/:id
 * Management (`vendor.manage`): POST  /vendors/:vendorId/compliance-documents
 *                               PATCH /vendor-compliance-documents/:id
 *
 * Compliance documents are metadata of the Vendor domain, so they reuse the
 * BE-06A `vendor.*` permissions. Writes and Vendor-scoped reads are nested
 * under the Vendor, so the owning Vendor is always taken from the URL —
 * Client isolation is inherited through the Vendor (Document → Vendor →
 * Client).
 *
 * Status changes (ACTIVE/EXPIRED/INACTIVE) travel through the general
 * `PATCH /vendor-compliance-documents/:id` (which accepts `status`); no
 * document row is ever deleted, so compliance history stays auditable.
 */
export function createVendorComplianceDocumentRouter(): Router {
  const router = Router();

  router.post(
    '/vendors/:vendorId/compliance-documents',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorComplianceDocumentHandler,
  );
  router.get(
    '/vendors/:vendorId/compliance-documents',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorComplianceDocumentsHandler,
  );
  router.get(
    '/vendor-compliance-documents/:id',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorComplianceDocumentHandler,
  );
  router.patch(
    '/vendor-compliance-documents/:id',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorComplianceDocumentHandler,
  );

  return router;
}
