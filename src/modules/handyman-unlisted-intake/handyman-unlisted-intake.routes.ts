import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../handyman-care-authority';
import {
  createBuildingCareUnlistedIntakeCase,
  createCareWorkspaceUnlistedIntakeCase,
  getBuildingCareUnlistedIntakeCase,
  getCareWorkspaceUnlistedIntakeCase,
  getUnlistedIntakeCase,
  listBuildingCareUnlistedIntakeCases,
  listCareWorkspaceUnlistedIntakeCases,
  listOperationsUnlistedIntakeCases,
} from './handyman-unlisted-intake.service';

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

export function createHandymanUnlistedIntakeRouter(): Router {
  const router = Router();
  const careBuildingAuthz = [
    authenticationMiddleware,
    requirePermission(HANDYMAN_CARE_BUILDING_PERMISSION),
  ];

  router.post(
    '/handyman/care/buildings/:buildingId/unlisted-intake-cases',
    ...careBuildingAuthz,
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const result = await createBuildingCareUnlistedIntakeCase({
          actorUserId: req.auth.userId,
          buildingId: param(req.params.buildingId),
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
    '/handyman/care/buildings/:buildingId/unlisted-intake-cases',
    ...careBuildingAuthz,
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const page = await listBuildingCareUnlistedIntakeCases({
          actorUserId: req.auth.userId,
          buildingId: param(req.params.buildingId),
          query: req.query,
        });
        sendSuccess(res, page);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/buildings/:buildingId/unlisted-intake-cases/:intakeCaseId',
    ...careBuildingAuthz,
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const item = await getBuildingCareUnlistedIntakeCase({
          actorUserId: req.auth.userId,
          buildingId: param(req.params.buildingId),
          intakeCaseId: param(req.params.intakeCaseId),
        });
        sendSuccess(res, item);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/handyman/care/unlisted-intake-cases',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const result = await createCareWorkspaceUnlistedIntakeCase({
          bearerToken: bearer(req),
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
    '/handyman/care/unlisted-intake-cases',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const page = await listCareWorkspaceUnlistedIntakeCases({
          bearerToken: bearer(req),
          query: req.query,
        });
        sendSuccess(res, page);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/unlisted-intake-cases/:intakeCaseId',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const item = await getCareWorkspaceUnlistedIntakeCase({
          bearerToken: bearer(req),
          intakeCaseId: param(req.params.intakeCaseId),
          query: req.query,
        });
        sendSuccess(res, item);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/operations/unlisted-intake-cases',
    authenticationMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const page = await listOperationsUnlistedIntakeCases({
          actorUserId: req.auth.userId,
          query: req.query,
        });
        sendSuccess(res, page);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/unlisted-intake-cases/:intakeCaseId',
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const item = await getUnlistedIntakeCase({
          bearerToken: bearer(req),
          intakeCaseId: param(req.params.intakeCaseId),
          query: req.query,
        });
        sendSuccess(res, item);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
