import { Router, type NextFunction, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../handyman-care-authority';
import {
  createBuildingCareInternalNote,
  createCareWorkspaceInternalNote,
  createServiceRequestInternalNote,
  listBuildingCareInternalNotes,
  listCareWorkspaceInternalNotes,
  listServiceRequestInternalNotes,
} from './handyman-internal-notes.service';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function bearer(req: Request): string {
  const header = req.header('authorization') ?? '';
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
}

function readIdempotencyHeader(req: Request): string | undefined {
  const raw =
    req.header('idempotency-key') ?? req.header('x-idempotency-key');
  return typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

export function createHandymanInternalNotesRouter(): Router {
  const router = Router();
  const careBuildingAuthz = [
    authenticationMiddleware,
    requirePermission(HANDYMAN_CARE_BUILDING_PERMISSION),
  ];

  router.post(
    '/handyman/care/buildings/:buildingId/requests/:requestId/internal-notes',
    ...careBuildingAuthz,
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const result = await createBuildingCareInternalNote({
          actorUserId: req.auth.userId,
          buildingId: param(req.params.buildingId),
          requestId: param(req.params.requestId),
          body: req.body,
          headerIdempotencyKey: readIdempotencyHeader(req),
        });
        sendSuccess(res, result, result.replayed ? 200 : 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/buildings/:buildingId/requests/:requestId/internal-notes',
    ...careBuildingAuthz,
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const items = await listBuildingCareInternalNotes({
          actorUserId: req.auth.userId,
          buildingId: param(req.params.buildingId),
          requestId: param(req.params.requestId),
        });
        sendSuccess(res, items);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/handyman/care/requests/:requestId/internal-notes',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const result = await createCareWorkspaceInternalNote({
          bearerToken: bearer(req),
          requestId: param(req.params.requestId),
          body: req.body,
          headerIdempotencyKey: readIdempotencyHeader(req),
        });
        sendSuccess(res, result, result.replayed ? 200 : 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/requests/:requestId/internal-notes',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const items = await listCareWorkspaceInternalNotes({
          bearerToken: bearer(req),
          requestId: param(req.params.requestId),
          query: req.query,
        });
        sendSuccess(res, items);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/handyman/requests/:handymanRequestId/internal-notes',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const result = await createServiceRequestInternalNote({
          bearerToken: bearer(req),
          handymanRequestId: param(req.params.handymanRequestId),
          body: req.body,
          headerIdempotencyKey: readIdempotencyHeader(req),
        });
        sendSuccess(res, result, result.replayed ? 200 : 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/requests/:handymanRequestId/internal-notes',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const items = await listServiceRequestInternalNotes({
          bearerToken: bearer(req),
          handymanRequestId: param(req.params.handymanRequestId),
          query: req.query,
        });
        sendSuccess(res, items);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
