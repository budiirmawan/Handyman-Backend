import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorChecklistBindingHandler,
  getVendorChecklistBindingHandler,
  getVendorChecklistExecutionContextHandler,
  listVendorChecklistBindingsHandler,
  startVendorChecklistExecutionHandler,
} from './vendor-checklist-binding.controller';

/**
 * BE-15C — Vendor Checklist Binding endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the service/controller after
 * resolving the binding's / vendor work's Building).
 *
 * Management (`vendor.manage`):
 *   POST /vendor-checklist-bindings
 *   POST /vendor-checklist-bindings/:bindingId/start
 * Reads (`vendor.read`):
 *   GET  /vendor-checklist-bindings                (?vendorWorkId= & ?vendorId= & ?buildingId=)
 *   GET  /vendor-checklist-bindings/:bindingId
 *   GET  /vendor-checklist-executions/:executionId
 *
 * Execution stays BE-07's: the start endpoint only creates the shared
 * checklist execution row for the binding — responses, completion, evidence,
 * and verification continue through BE-07's own endpoints.
 */
export function createVendorChecklistBindingRouter(): Router {
  const router = Router();

  router.post(
    '/vendor-checklist-bindings',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    createVendorChecklistBindingHandler,
  );
  router.get(
    '/vendor-checklist-bindings',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorChecklistBindingsHandler,
  );
  router.get(
    '/vendor-checklist-bindings/:bindingId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorChecklistBindingHandler,
  );
  router.post(
    '/vendor-checklist-bindings/:bindingId/start',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    startVendorChecklistExecutionHandler,
  );
  router.get(
    '/vendor-checklist-executions/:executionId',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    getVendorChecklistExecutionContextHandler,
  );

  return router;
}
