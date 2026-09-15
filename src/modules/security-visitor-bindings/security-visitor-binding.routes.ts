import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSecurityVisitorBindingHandler,
  getSecurityVisitorBindingHandler,
  listSecurityVisitorBindingsHandler,
  updateSecurityVisitorBindingHandler,
} from './security-visitor-binding.controller';

/**
 * BE-12J — Visitor / Security Binding endpoints.
 *
 *   POST /security/visitor-bindings
 *   GET  /security/visitor-bindings
 *   GET  /security/visitor-bindings/:id
 *   PATCH /security/visitor-bindings/:id
 *
 * Operational-integration layer only — the authoritative Visitor /
 * Visit domain is not part of this PART. The binding carries an
 * opaque `external_visit_reference` that a future Visitor module
 * can later match against its id. No visitor personal data is
 * stored or exposed.
 */
export function createSecurityVisitorBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_visitor_binding.manage');
  const read = requirePermission('security_visitor_binding.read');

  router.post(
    '/security/visitor-bindings',
    auth,
    manage,
    createSecurityVisitorBindingHandler,
  );
  router.get(
    '/security/visitor-bindings',
    auth,
    read,
    listSecurityVisitorBindingsHandler,
  );
  router.get(
    '/security/visitor-bindings/:id',
    auth,
    read,
    getSecurityVisitorBindingHandler,
  );
  router.patch(
    '/security/visitor-bindings/:id',
    auth,
    manage,
    updateSecurityVisitorBindingHandler,
  );

  return router;
}
