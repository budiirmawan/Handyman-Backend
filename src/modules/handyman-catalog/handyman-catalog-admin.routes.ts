import { Router, type NextFunction, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationRequiredError } from '../auth';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { isValidUuid } from '../clients';
import {
  serviceCatalogNotActiveError,
  serviceCatalogNotFoundError,
  serviceCatalogService,
} from '../service-catalog';
import {
  createHandymanCommonMaterialProfile,
  listHandymanCommonMaterialProfiles,
} from './handyman-common-material-profile.service';
import {
  HANDYMAN_COMMON_MATERIAL_PROFILE_STATUSES,
  HANDYMAN_CUSTOMER_MATERIAL_OPTIONS,
  HANDYMAN_MATERIAL_COMMONALITIES,
  isHandymanCommonMaterialProfileStatus,
  isHandymanCustomerMaterialOption,
  isHandymanMaterialCommonality,
} from './handyman-common-material-profile.types';
import {
  createHandymanServiceVariant,
  listHandymanServiceVariants,
} from './handyman-service-variant.service';
import {
  HANDYMAN_SERVICE_VARIANT_STATUSES,
  isHandymanServiceVariantStatus,
} from './handyman-service-variant.types';

/**
 * CR-HM-MASTER-IND-01 — Handyman catalogue administration transport.
 *
 * The service/variant/material services already existed (CR-HM-02) but were
 * reachable only from backend composition, so the catalogue could not be
 * administered through the API. This router exposes the EXISTING, already
 * validated services — it adds no new catalogue semantics:
 *
 *   GET  /service-catalog/categories                          service_catalog.read
 *   GET  /service-catalog/entries/:serviceCatalogId/variants   service_catalog.read
 *   POST /service-catalog/entries/:serviceCatalogId/variants   service_catalog.manage
 *   GET  /service-catalog/entries/:serviceCatalogId/material-profiles
 *                                                              service_catalog.read
 *   POST /service-catalog/entries/:serviceCatalogId/material-profiles
 *                                                              service_catalog.manage
 *
 * Client scope is NEVER caller-supplied for the child endpoints: the parent
 * service entry is read through the existing service-catalog access rule and
 * its Client is used for the delegated service call. Inactive parent services
 * cannot gain new variants/materials. Material references remain references to
 * the existing inventory-item master; reference pricing remains the existing
 * price-catalog authority (reused, not duplicated).
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function fail(details: { field: string; message: string }[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function parseUuid(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) {
    fail([
      {
        field: unknown,
        message: 'Unexpected request field; see the documented body contract.',
      },
    ]);
  }
}

function optionalString(
  value: unknown,
  field: string,
  max: number,
  details: { field: string; message: string }[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function parseVariantBody(body: unknown): {
  code: string;
  name: string;
  description?: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  rejectUnknownKeys(body, ['code', 'name', 'description']);
  const details: { field: string; message: string }[] = [];
  const code = optionalString(body.code, 'code', 64, details);
  const name = optionalString(body.name, 'name', 200, details);
  const description = optionalString(body.description, 'description', 1000, details);
  if (!code) details.push({ field: 'code', message: 'code is required.' });
  if (!name) details.push({ field: 'name', message: 'name is required.' });
  if (details.length) fail(details);
  return {
    code: code as string,
    name: name as string,
    ...(description === undefined ? {} : { description }),
  };
}

function parseMaterialProfileBody(body: unknown): {
  inventoryItemId: string;
  serviceVariantId?: string;
  specification?: string;
  compatibility?: string;
  typicalQuantity?: number;
  commonality: 'COMMON' | 'OCCASIONAL' | 'RARE';
  customerMaterialOption:
    | 'PROVIDER_SUPPLIED'
    | 'CUSTOMER_SUPPLIED'
    | 'CUSTOMER_CHOICE';
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  rejectUnknownKeys(body, [
    'inventoryItemId',
    'serviceVariantId',
    'specification',
    'compatibility',
    'typicalQuantity',
    'commonality',
    'customerMaterialOption',
  ]);
  const details: { field: string; message: string }[] = [];
  let inventoryItemId = '';
  if (typeof body.inventoryItemId !== 'string' || !isValidUuid(body.inventoryItemId)) {
    details.push({
      field: 'inventoryItemId',
      message: 'inventoryItemId is required and must be a valid UUID.',
    });
  } else {
    inventoryItemId = body.inventoryItemId.trim().toLowerCase();
  }
  let serviceVariantId: string | undefined;
  if (body.serviceVariantId !== undefined && body.serviceVariantId !== null) {
    if (typeof body.serviceVariantId !== 'string' || !isValidUuid(body.serviceVariantId)) {
      details.push({
        field: 'serviceVariantId',
        message: 'serviceVariantId must be a valid UUID.',
      });
    } else {
      serviceVariantId = body.serviceVariantId.trim().toLowerCase();
    }
  }
  const specification = optionalString(body.specification, 'specification', 1000, details);
  const compatibility = optionalString(body.compatibility, 'compatibility', 1000, details);
  let typicalQuantity: number | undefined;
  if (body.typicalQuantity !== undefined && body.typicalQuantity !== null) {
    if (
      typeof body.typicalQuantity !== 'number' ||
      !Number.isFinite(body.typicalQuantity) ||
      body.typicalQuantity <= 0
    ) {
      details.push({
        field: 'typicalQuantity',
        message: 'typicalQuantity must be a positive number.',
      });
    } else {
      typicalQuantity = body.typicalQuantity;
    }
  }
  if (!isHandymanMaterialCommonality(body.commonality)) {
    details.push({
      field: 'commonality',
      message: `commonality must be one of: ${HANDYMAN_MATERIAL_COMMONALITIES.join(', ')}.`,
    });
  }
  if (!isHandymanCustomerMaterialOption(body.customerMaterialOption)) {
    details.push({
      field: 'customerMaterialOption',
      message: `customerMaterialOption must be one of: ${HANDYMAN_CUSTOMER_MATERIAL_OPTIONS.join(', ')}.`,
    });
  }
  if (details.length) fail(details);
  return {
    inventoryItemId,
    ...(serviceVariantId === undefined ? {} : { serviceVariantId }),
    ...(specification === undefined ? {} : { specification }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(typicalQuantity === undefined ? {} : { typicalQuantity }),
    commonality: body.commonality as 'COMMON' | 'OCCASIONAL' | 'RARE',
    customerMaterialOption: body.customerMaterialOption as
      | 'PROVIDER_SUPPLIED'
      | 'CUSTOMER_SUPPLIED'
      | 'CUSTOMER_CHOICE',
  };
}

/** Server-derived parent: unknown → 404, foreign Client → 403 (existing rule). */
async function requireServiceEntry(req: Request, serviceCatalogId: string) {
  const entry = await serviceCatalogService.getServiceCatalogEntry(
    serviceCatalogId,
    actor(req),
  );
  if (!entry) throw serviceCatalogNotFoundError();
  return entry;
}

export function createHandymanCatalogueAdminRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('service_catalog.read');
  const manage = requirePermission('service_catalog.manage');

  router.get('/service-catalog/categories', auth, read, async (req, res, next) => {
    try {
      const query = req.query as Record<string, unknown>;
      const unsupported = Object.keys(query).find(
        (key) => !['clientId', 'status'].includes(key),
      );
      if (unsupported) {
        fail([
          { field: unsupported, message: 'This query parameter is not accepted.' },
        ]);
      }
      if (
        query.status !== undefined &&
        query.status !== 'ACTIVE' &&
        query.status !== 'INACTIVE'
      ) {
        fail([{ field: 'status', message: 'status must be ACTIVE or INACTIVE.' }]);
      }
      sendSuccess(
        res,
        await serviceCatalogService.listServiceCatalogCategories(
          {
            ...(typeof query.clientId === 'string'
              ? { clientId: parseUuid(query.clientId, 'clientId') }
              : {}),
            ...(query.status === undefined
              ? {}
              : { status: query.status as 'ACTIVE' | 'INACTIVE' }),
          },
          actor(req),
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/service-catalog/entries/:serviceCatalogId/variants',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const entry = await requireServiceEntry(req, serviceCatalogId);
        const status = req.query.status;
        if (
          status !== undefined &&
          !isHandymanServiceVariantStatus(status)
        ) {
          fail([
            {
              field: 'status',
              message: `status must be one of: ${HANDYMAN_SERVICE_VARIANT_STATUSES.join(', ')}.`,
            },
          ]);
        }
        sendSuccess(
          res,
          await listHandymanServiceVariants(
            {
              clientId: entry.clientId,
              serviceCatalogId,
              ...(status === undefined
                ? {}
                : { status: status as 'ACTIVE' | 'INACTIVE' }),
            },
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/service-catalog/entries/:serviceCatalogId/variants',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const entry = await requireServiceEntry(req, serviceCatalogId);
        if (entry.status !== 'ACTIVE') throw serviceCatalogNotActiveError();
        sendSuccess(
          res,
          await createHandymanServiceVariant(
            { serviceCatalogId, ...parseVariantBody(req.body) },
            actor(req),
          ),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/service-catalog/entries/:serviceCatalogId/material-profiles',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const entry = await requireServiceEntry(req, serviceCatalogId);
        const query = req.query as Record<string, unknown>;
        const unsupported = Object.keys(query).find(
          (key) => !['status', 'serviceVariantId'].includes(key),
        );
        if (unsupported) {
          fail([
            { field: unsupported, message: 'This query parameter is not accepted.' },
          ]);
        }
        if (
          query.status !== undefined &&
          !isHandymanCommonMaterialProfileStatus(query.status)
        ) {
          fail([
            {
              field: 'status',
              message: `status must be one of: ${HANDYMAN_COMMON_MATERIAL_PROFILE_STATUSES.join(', ')}.`,
            },
          ]);
        }
        sendSuccess(
          res,
          await listHandymanCommonMaterialProfiles(
            {
              clientId: entry.clientId,
              serviceCatalogId,
              ...(query.serviceVariantId === undefined
                ? {}
                : {
                  serviceVariantId: parseUuid(
                    String(query.serviceVariantId),
                    'serviceVariantId',
                  ),
                }),
              ...(query.status === undefined
                ? {}
                : { status: query.status as 'ACTIVE' | 'INACTIVE' }),
            },
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/service-catalog/entries/:serviceCatalogId/material-profiles',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const entry = await requireServiceEntry(req, serviceCatalogId);
        if (entry.status !== 'ACTIVE') throw serviceCatalogNotActiveError();
        sendSuccess(
          res,
          await createHandymanCommonMaterialProfile(
            { serviceCatalogId, ...parseMaterialProfileBody(req.body) },
            actor(req),
          ),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
