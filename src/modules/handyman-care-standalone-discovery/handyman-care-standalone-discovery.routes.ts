import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  HANDYMAN_CARE_BUILDING_PERMISSION,
} from '../handyman-care-authority';
import { isValidUuid } from '../clients';
import { handymanIntakeEvidenceService } from '../handyman-evidence';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import { parseHandymanIntakeEvidenceKindField } from '../handyman-api/handyman-api.validation';
import { runSingleFileUpload } from '../handyman-api/handyman-api.controller';
import {
  assertStandaloneCareRequestStatus,
  getStandaloneCareRequestDetail,
  getStandaloneCareRequestProgress,
  listStandaloneCareBuildings,
  listStandaloneCareRequests,
} from './handyman-care-standalone-discovery.service';
import {
  assertBuildingCareRequest,
  createBuildingCareRequest,
  listBuildingCareCatalogueServices,
  listBuildingCareFloors,
  listBuildingCareTenants,
  listBuildingCareUnits,
} from './handyman-care-tenant-request-gateway.service';
import { parseCreateBuildingCareRequestBody } from './handyman-care-tenant-request-gateway.validation';

const AUTHZ = [
  authenticationMiddleware,
  requirePermission(HANDYMAN_CARE_BUILDING_PERMISSION),
] as const;

function noStore(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function assertAllowedQuery(
  query: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unsupported = Object.keys(query).find((key) => !allowed.includes(key));
  if (unsupported) {
    throw AppError.validation('Request validation failed.', [
      { field: unsupported, message: 'This query parameter is not accepted.' },
    ]);
  }
}

function assertEmptyReadBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  ) {
    return;
  }
  throw AppError.validation('GET endpoints do not accept a request body.');
}

function parseUuid(value: string | string[], field: string): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!isValidUuid(candidate)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return candidate;
}

function parseCarePagination(query: Record<string, unknown>) {
  const page = parsePagination(query);
  if (!Number.isSafeInteger(page.page) || !Number.isSafeInteger(page.offset)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'page', message: 'page and its offset must be safe integers.' },
    ]);
  }
  return page;
}

function parseQueryUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value;
}

export function createHandymanCareStandaloneDiscoveryRouter(): Router {
  const router = Router();

  /**
   * CR-HM-CC-TENANT-REQUEST-GATEWAY-01 — staff-assisted Tenant request
   * creation gateway. Same AUTHZ chain as the discovery reads (Backend
   * Bearer session + dedicated `handyman.care.building`), plus the
   * server-side Authority A/lineage/tenant-scope resolution in the service.
   * Requires the standard `Idempotency-Key` header. The response is the
   * canonical Backend-issued request id + INTAKE projection — the same row
   * the Operations queue discovers.
   */
  router.post(
    '/handyman/care/buildings/:buildingId/requests',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        const buildingId = parseUuid(req.params.buildingId, 'buildingId');
        const body = parseCreateBuildingCareRequestBody(req.body);
        const idempotencyKey = parseIdempotencyKeyRequired(
          req.header('Idempotency-Key'),
        );
        const result = await createBuildingCareRequest({
          actorUserId: req.auth?.userId ?? '',
          buildingId,
          idempotencyKey,
          body,
        });
        sendSuccess(res, result.responseBody, result.responseStatus);
      } catch (error) {
        next(error);
      }
    },
  );

  /** Tenant/PIC discovery for the authorized Building (selection step). */
  router.get(
    '/handyman/care/buildings/:buildingId/tenants',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        assertAllowedQuery(req.query as Record<string, unknown>, []);
        assertEmptyReadBody(req.body);
        sendSuccess(
          res,
          await listBuildingCareTenants({
            actorUserId: req.auth?.userId ?? '',
            buildingId: parseUuid(req.params.buildingId, 'buildingId'),
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  /** Floor selection for the authorized Building. */
  router.get(
    '/handyman/care/buildings/:buildingId/floors',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        assertAllowedQuery(req.query as Record<string, unknown>, []);
        assertEmptyReadBody(req.body);
        sendSuccess(
          res,
          await listBuildingCareFloors({
            actorUserId: req.auth?.userId ?? '',
            buildingId: parseUuid(req.params.buildingId, 'buildingId'),
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  /** Eligible Unit (= tenant Space) selection: `tenantCompanyId` required,
   * optional `floorId` narrows the Tower -> Floor -> Unit cascade. */
  router.get(
    '/handyman/care/buildings/:buildingId/units',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        const query = req.query as Record<string, unknown>;
        assertAllowedQuery(query, ['tenantCompanyId', 'floorId']);
        assertEmptyReadBody(req.body);
        const buildingId = parseUuid(req.params.buildingId, 'buildingId');
        if (typeof query.tenantCompanyId !== 'string') {
          throw AppError.validation('Request validation failed.', [
            {
              field: 'tenantCompanyId',
              message: 'tenantCompanyId is required.',
            },
          ]);
        }
        const floorId = parseQueryUuid(query.floorId, 'floorId');
        sendSuccess(
          res,
          await listBuildingCareUnits({
            actorUserId: req.auth?.userId ?? '',
            buildingId,
            tenantCompanyId: query.tenantCompanyId.trim().toLowerCase(),
            ...(floorId === undefined ? {} : { floorId }),
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  /** Building-scoped ACTIVE service catalogue for the derived Client. */
  router.get(
    '/handyman/care/buildings/:buildingId/catalogue/services',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        assertAllowedQuery(req.query as Record<string, unknown>, []);
        assertEmptyReadBody(req.body);
        sendSuccess(
          res,
          await listBuildingCareCatalogueServices({
            actorUserId: req.auth?.userId ?? '',
            buildingId: parseUuid(req.params.buildingId, 'buildingId'),
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  /** Bounded intake-evidence metadata for one request in this Building. */
  router.get(
    '/handyman/care/buildings/:buildingId/requests/:requestId/intake-evidence',
    ...AUTHZ,
    async (req, res, next) => {
      try {
        assertAllowedQuery(req.query as Record<string, unknown>, []);
        assertEmptyReadBody(req.body);
        const actorUserId = req.auth?.userId ?? '';
        const { requestId } = await assertBuildingCareRequest({
          actorUserId,
          buildingId: parseUuid(req.params.buildingId, 'buildingId'),
          requestId: parseUuid(req.params.requestId, 'requestId'),
        });
        sendSuccess(
          res,
          await handymanIntakeEvidenceService.listHandymanIntakeEvidence(
            requestId,
            actorUserId,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  /** Bounded PHOTO/VIDEO intake attachment — same evidence convention as
   * the customer-facing surface, reached through the Care Building
   * authority; the request lifecycle is never mutated. */
  router.post(
    '/handyman/care/buildings/:buildingId/requests/:requestId/intake-evidence',
    ...AUTHZ,
    async (req, res, next) => {
      try {
        const actorUserId = req.auth?.userId ?? '';
        // Exact-Building authority BEFORE the upload is consumed.
        const { requestId } = await assertBuildingCareRequest({
          actorUserId,
          buildingId: parseUuid(req.params.buildingId, 'buildingId'),
          requestId: parseUuid(req.params.requestId, 'requestId'),
        });
        const file = await runSingleFileUpload(req, res);
        const evidenceKind = parseHandymanIntakeEvidenceKindField(
          req.body?.evidenceKind,
        );
        sendSuccess(
          res,
          await handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
            {
              handymanRequestId: requestId,
              evidenceKind,
              fileName: file.originalname,
              mimeType: file.mimetype,
              content: file.buffer,
            },
            actorUserId,
          ),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/buildings',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        assertAllowedQuery(req.query as Record<string, unknown>, []);
        assertEmptyReadBody(req.body);
        sendSuccess(
          res,
          await listStandaloneCareBuildings(req.auth?.userId ?? ''),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/buildings/:buildingId/requests',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        const query = req.query as Record<string, unknown>;
        assertAllowedQuery(query, ['status', 'spaceId', 'page', 'pageSize']);
        assertEmptyReadBody(req.body);
        const buildingId = parseUuid(req.params.buildingId, 'buildingId');
        const status = query.status;
        if (
          status !== undefined &&
          !assertStandaloneCareRequestStatus(status)
        ) {
          throw AppError.validation('Request validation failed.', [
            {
              field: 'status',
              message: 'status must be a known Handyman request status.',
            },
          ]);
        }
        const spaceId = parseQueryUuid(query.spaceId, 'spaceId');
        const page = hasPaginationParams(query)
          ? parseCarePagination(query)
          : undefined;
        const result = await listStandaloneCareRequests({
          actorUserId: req.auth?.userId ?? '',
          buildingId,
          filters: {
            ...(status === undefined ? {} : { status }),
            ...(spaceId === undefined ? {} : { spaceId }),
          },
          ...(page === undefined
            ? {}
            : { page: { limit: page.limit, offset: page.offset } }),
        });
        sendSuccess(
          res,
          result.items,
          200,
          page === undefined
            ? {}
            : buildPaginationMeta(page.page, page.pageSize, result.total ?? 0),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/buildings/:buildingId/requests/:requestId/progress',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        assertAllowedQuery(req.query as Record<string, unknown>, []);
        assertEmptyReadBody(req.body);
        const buildingId = parseUuid(req.params.buildingId, 'buildingId');
        const requestId = parseUuid(req.params.requestId, 'requestId');
        sendSuccess(
          res,
          await getStandaloneCareRequestProgress({
            actorUserId: req.auth?.userId ?? '',
            buildingId,
            requestId,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/care/buildings/:buildingId/requests/:requestId',
    noStore,
    ...AUTHZ,
    async (req, res, next) => {
      try {
        assertAllowedQuery(req.query as Record<string, unknown>, []);
        assertEmptyReadBody(req.body);
        const buildingId = parseUuid(req.params.buildingId, 'buildingId');
        const requestId = parseUuid(req.params.requestId, 'requestId');
        sendSuccess(
          res,
          await getStandaloneCareRequestDetail({
            actorUserId: req.auth?.userId ?? '',
            buildingId,
            requestId,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
