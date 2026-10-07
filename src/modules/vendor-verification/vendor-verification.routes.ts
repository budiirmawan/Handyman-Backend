import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getVerificationHandler,
  submitVerificationHandler,
} from './vendor-verification.controller';

/**
 * BE-15I — Vendor Work Verification endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the service after resolving the Vendor
 * Work's Building). Reuses the BE-07 review primitive.
 *
 * Reads (`vendor.read`):
 *   GET  /vendor-works/:id/verification   (context + latest + history)
 * Management (`vendor.manage`):
 *   POST /vendor-works/:id/verification   (submit APPROVED / REJECTED / REWORK_REQUIRED)
 *
 * No Rework endpoints are exposed here (BE-15J owns them).
 */
export function createVendorVerificationRouter(): Router {
  const router = Router();

  router.get(
    '/vendor-works/:id/verification',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVerificationHandler,
  );
  router.post(
    '/vendor-works/:id/verification',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    submitVerificationHandler,
  );

  return router;
}
