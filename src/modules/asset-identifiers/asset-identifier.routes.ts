import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAssetIdentifierHandler,
  listAssetIdentifiersHandler,
  resolveAssetIdentifierHandler,
  updateAssetIdentifierHandler,
} from './asset-identifier.controller';

/**
 * BE-05H — Asset Identifier endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`asset_identifier.read`):
 *   GET   /assets/:assetId/identifiers
 *   GET   /assets/resolve/:identifier      (QR-ready lookup)
 * Management (`asset_identifier.manage`):
 *   POST  /assets/:assetId/identifiers
 *   PATCH /assets/:assetId/identifiers/:identifierId
 *
 * The resolve route is a three-segment literal path
 * (`/assets/resolve/:identifier`) so it cannot collide with the BE-05A
 * `/assets/:id` routes or the `/assets/:id/{location,status}` sub-resources,
 * whose third segment is a fixed literal.
 *
 * Resolution requires only the READ capability: identifying equipment from a
 * label is a read, not asset administration. It stays authenticated and
 * Building-scoped — no anonymous public scan endpoint is exposed here.
 *
 * No QR image is generated or stored; this PART provides only the identifier
 * value that a renderer can later encode.
 */
export function createAssetIdentifierRouter(): Router {
  const router = Router();

  router.get(
    '/assets/resolve/:identifier',
    authenticationMiddleware,
    requirePermission('asset_identifier.read'),
    resolveAssetIdentifierHandler,
  );
  router.post(
    '/assets/:assetId/identifiers',
    authenticationMiddleware,
    requirePermission('asset_identifier.manage'),
    createAssetIdentifierHandler,
  );
  router.get(
    '/assets/:assetId/identifiers',
    authenticationMiddleware,
    requirePermission('asset_identifier.read'),
    listAssetIdentifiersHandler,
  );
  router.patch(
    '/assets/:assetId/identifiers/:identifierId',
    authenticationMiddleware,
    requirePermission('asset_identifier.manage'),
    updateAssetIdentifierHandler,
  );

  return router;
}
