import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { authenticationRequiredError } from '../auth';
import { evidenceRetentionPolicyService } from './evidence-retention-policy.service';
import {
  parseCreateBody,
  parseFilters,
  parseUpdateBody,
  parseUuid,
} from './evidence-retention-policy.validation';

/**
 * CR-BE-DOC-CONTROL-01 PART 03 — retention policy administration routes.
 *
 * Same shape and permissions as the SLA-definition precedent: retention
 * policy is Client-scoped operational configuration, so administration is
 * governed by the existing `client_configuration.read` / `.manage`
 * permissions — NO new permission (START GOVERNANCE §9).
 */

const p = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '');
const u = (req: Request): string => {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
};

export function createEvidenceRetentionPolicyRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('client_configuration.read');
  const manage = requirePermission('client_configuration.manage');

  router.post(
    '/clients/:clientId/evidence-retention-policies',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        sendSuccess(
          res,
          await evidenceRetentionPolicyService.create(
            {
              ...parseCreateBody(req.body),
              clientId: parseUuid(p(req.params.clientId), 'clientId'),
            },
            u(req),
          ),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/clients/:clientId/evidence-retention-policies',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        sendSuccess(
          res,
          await evidenceRetentionPolicyService.list(
            parseUuid(p(req.params.clientId), 'clientId'),
            parseFilters(req.query as Record<string, unknown>),
            u(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/evidence-retention-policies/:id',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        sendSuccess(
          res,
          await evidenceRetentionPolicyService.get(
            parseUuid(p(req.params.id), 'evidenceRetentionPolicyId'),
            u(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/evidence-retention-policies/:id',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        sendSuccess(
          res,
          await evidenceRetentionPolicyService.update(
            parseUuid(p(req.params.id), 'evidenceRetentionPolicyId'),
            parseUpdateBody(req.body),
            u(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
