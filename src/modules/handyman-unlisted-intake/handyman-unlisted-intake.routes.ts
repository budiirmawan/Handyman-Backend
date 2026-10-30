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
  convertUnlistedIntakeCaseToServiceRequest,
  listUnlistedIntakeTriageDecisions,
  recordUnlistedIntakeTriageDecision,
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

  // ==========================================================================
  // CR-HM-MANUAL-QUOTATION-01 PART 01 — Operations triage authority.
  //
  // The WRITE is Operations-only: an explicit `tenant_company.manage` route
  // guard (the vocabulary every other Handyman quotation write uses) PLUS the
  // service-side active-user / not-customer-facing / exact-Building checks.
  // Customer Care mediation authority (`handyman.care.building`) can create
  // and annotate an intake case but NEVER classify it, and a customer-facing
  // Tenant PIC is refused in both layers and again in the database trigger.
  // The READ stays on the composite Operations/Care read authority already
  // used by the triage queue.
  // ==========================================================================
  router.post(
    '/handyman/operations/unlisted-intake-cases/:intakeCaseId/triage-decisions',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const result = await recordUnlistedIntakeTriageDecision({
          actorUserId: req.auth.userId,
          intakeCaseId: param(req.params.intakeCaseId),
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
    '/handyman/operations/unlisted-intake-cases/:intakeCaseId/triage-decisions',
    authenticationMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const items = await listUnlistedIntakeTriageDecisions({
          actorUserId: req.auth.userId,
          intakeCaseId: param(req.params.intakeCaseId),
        });
        sendSuccess(res, items);
      } catch (error) {
        next(error);
      }
    },
  );

  // ==========================================================================
  // CR-HM-MANUAL-QUOTATION-01 PART 02 — one triaged case -> one formal
  // manual-origin Service Request. Same Operations authority as triage (the
  // conversion is a management write on commercial intake), and the ONLY
  // accepted field is the idempotency key: scope, verified parties, complaint
  // and provenance are read from the case, never supplied. No catalog anchor,
  // quotation price or approval is implied — the request is born in 'INTAKE'
  // and every downstream quotation/assignment gate stays exactly as it was.
  // ==========================================================================
  router.post(
    '/handyman/operations/unlisted-intake-cases/:intakeCaseId/service-request',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!req.auth?.userId) throw authenticationRequiredError();
        const result = await convertUnlistedIntakeCaseToServiceRequest({
          actorUserId: req.auth.userId,
          intakeCaseId: param(req.params.intakeCaseId),
          body: req.body,
          headerIdempotencyKey: readIdempotencyHeader(req),
        });
        sendSuccess(res, result, result.replayed ? 200 : 201);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
