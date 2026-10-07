import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  acceptBastHandler,
  createBastHandler,
  getBastHandler,
  listBastsHandler,
  rejectBastHandler,
  submitBastHandler,
} from './vendor-bast-binding.controller';

/**
 * BE-15H — BAST Binding endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation (enforced in the service/controller after resolving the BAST's /
 * vendor work's Building).
 *
 * Deprecated create (`vendor.manage`) is explicitly restricted.
 * Linked lifecycle commands delegate to canonical permissions/behavior:
 *   POST  /vendor-basts/:bastId/submit  (`document.manage`)
 *   POST  /vendor-basts/:bastId/accept  (`bast.accept`)
 *   POST  /vendor-basts/:bastId/reject  (`bast.accept`)
 * Reads (`vendor.read`):
 *   GET   /vendor-basts                    (?vendorWorkId= & ?vendorId= & ?buildingId=)
 *   GET   /vendor-basts/:bastId
 *
 * Acceptance is backend-authoritative — no Verification endpoints here.
 */
export function createVendorBastRouter(): Router {
  const router = Router();

  router.post(
    '/vendor-basts',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createBastHandler,
  );
  router.get(
    '/vendor-basts',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listBastsHandler,
  );
  router.get(
    '/vendor-basts/:bastId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getBastHandler,
  );
  router.post(
    '/vendor-basts/:bastId/submit',
    authenticationMiddleware,
    requirePermission('document.manage'),
    submitBastHandler,
  );
  router.post(
    '/vendor-basts/:bastId/accept',
    authenticationMiddleware,
    requirePermission('bast.accept'),
    acceptBastHandler,
  );
  router.post(
    '/vendor-basts/:bastId/reject',
    authenticationMiddleware,
    requirePermission('bast.accept'),
    rejectBastHandler,
  );

  return router;
}
