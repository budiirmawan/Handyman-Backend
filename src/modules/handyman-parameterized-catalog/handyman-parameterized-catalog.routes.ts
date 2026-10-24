import { Router, type NextFunction, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationRequiredError } from '../auth';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { isValidUuid } from '../clients';
import {
  createHandymanServiceAttribute,
  createHandymanServicePriceRule,
  getHandymanServiceCommercialProfile,
  listHandymanServiceAttributes,
  listHandymanServiceCatalogProjection,
  listHandymanServiceCategories,
  listHandymanServicePriceRules,
  updateHandymanServiceAttribute,
  updateHandymanServicePriceRule,
  upsertHandymanServiceCommercialProfile,
} from './handyman-parameterized-catalog.service';
import { importHandymanServiceCatalogStarter } from './handyman-parameterized-catalog-import.service';
import {
  isHandymanServiceAttributeDataType,
  isHandymanServicePriceBasis,
  isHandymanServicePricingMode,
} from './handyman-parameterized-catalog.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Admin CRUD transport for the
 * PARAMETERIZED Handyman service catalogue.
 *
 *   GET   /service-catalog/parameterized/categories
 *   GET   /service-catalog/parameterized/services
 *   POST  /service-catalog/parameterized/starter-import
 *   GET   /service-catalog/parameterized/entries/:serviceCatalogId/attributes
 *   POST  /service-catalog/parameterized/entries/:serviceCatalogId/attributes
 *   PATCH /service-catalog/parameterized/attributes/:attributeId
 *   GET   /service-catalog/parameterized/entries/:serviceCatalogId/commercial-profile
 *   PUT   /service-catalog/parameterized/entries/:serviceCatalogId/commercial-profile
 *   GET   /service-catalog/parameterized/price-rules
 *   POST  /service-catalog/parameterized/entries/:serviceCatalogId/price-rules
 *   PATCH /service-catalog/parameterized/price-rules/:priceRuleId
 *
 * RBAC: reads `service_catalog.read`, writes `service_catalog.manage` —
 * the EXISTING catalogue permissions (no new permission code, no widened
 * capability).
 *
 * Tenant isolation: the Client is NEVER taken from the request body for
 * the catalogue reads/writes except for the starter import, which derives
 * its Client scope from the addressed Client and then proves the caller's
 * Client reach before touching anything. The addressed service entry always
 * determines the Client of its children.
 *
 * This router exposes NO amount: a price rule only points at the existing
 * governed price authority (`price_catalog_entries`).
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

function requireBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  return body;
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

export function createHandymanParameterizedCatalogRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('service_catalog.read');
  const manage = requirePermission('service_catalog.manage');

  router.get(
    '/service-catalog/parameterized/categories',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = req.query as Record<string, unknown>;
        const unsupported = Object.keys(query).find(
          (key) => key !== 'clientId',
        );
        if (unsupported) {
          fail([
            { field: unsupported, message: 'This query parameter is not accepted.' },
          ]);
        }
        sendSuccess(
          res,
          await listHandymanServiceCategories(
            parseUuid(String(query.clientId ?? ''), 'clientId'),
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/service-catalog/parameterized/services',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = req.query as Record<string, unknown>;
        const unsupported = Object.keys(query).find(
          (key) => !['clientId', 'category'].includes(key),
        );
        if (unsupported) {
          fail([
            { field: unsupported, message: 'This query parameter is not accepted.' },
          ]);
        }
        const category =
          typeof query.category === 'string' && query.category.trim().length > 0
            ? query.category.trim().toUpperCase()
            : undefined;
        sendSuccess(
          res,
          await listHandymanServiceCatalogProjection(
            parseUuid(String(query.clientId ?? ''), 'clientId'),
            actor(req),
            category ? { category } : {},
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/service-catalog/parameterized/starter-import',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = requireBody(req.body);
        rejectUnknownKeys(body, ['clientId']);
        const clientId = parseUuid(String(body.clientId ?? ''), 'clientId');
        sendSuccess(
          res,
          await importHandymanServiceCatalogStarter(clientId, actor(req)),
          200,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/service-catalog/parameterized/entries/:serviceCatalogId/attributes',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const query = req.query as Record<string, unknown>;
        const unsupported = Object.keys(query).find((key) => key !== 'status');
        if (unsupported) {
          fail([
            { field: unsupported, message: 'This query parameter is not accepted.' },
          ]);
        }
        const status =
          query.status === undefined ? undefined : String(query.status);
        if (status !== undefined && status !== 'ACTIVE' && status !== 'INACTIVE') {
          fail([{ field: 'status', message: 'status must be ACTIVE or INACTIVE.' }]);
        }
        sendSuccess(
          res,
          await listHandymanServiceAttributes(
            serviceCatalogId,
            actor(req),
            status as 'ACTIVE' | 'INACTIVE' | undefined,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/service-catalog/parameterized/entries/:serviceCatalogId/attributes',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const body = requireBody(req.body);
        rejectUnknownKeys(body, [
          'code',
          'name',
          'description',
          'dataType',
          'unit',
          'required',
          'allowFreeValue',
          'allowedValues',
          'sortOrder',
        ]);
        const details: { field: string; message: string }[] = [];
        const code = optionalString(body.code, 'code', 64, details);
        const name = optionalString(body.name, 'name', 200, details);
        const description = optionalString(
          body.description,
          'description',
          1000,
          details,
        );
        const unit = optionalString(body.unit, 'unit', 32, details);
        if (!code) details.push({ field: 'code', message: 'code is required.' });
        if (!name) details.push({ field: 'name', message: 'name is required.' });
        if (!isHandymanServiceAttributeDataType(body.dataType)) {
          details.push({
            field: 'dataType',
            message: 'dataType must be NUMBER, TEXT, ENUM or BOOLEAN.',
          });
        }
        if (body.required !== undefined && typeof body.required !== 'boolean') {
          details.push({ field: 'required', message: 'required must be a boolean.' });
        }
        if (
          body.allowFreeValue !== undefined &&
          typeof body.allowFreeValue !== 'boolean'
        ) {
          details.push({
            field: 'allowFreeValue',
            message: 'allowFreeValue must be a boolean.',
          });
        }
        if (
          body.sortOrder !== undefined &&
          !Number.isInteger(Number(body.sortOrder))
        ) {
          details.push({ field: 'sortOrder', message: 'sortOrder must be an integer.' });
        }
        if (details.length) fail(details);
        sendSuccess(
          res,
          await createHandymanServiceAttribute(
            serviceCatalogId,
            {
              code: code as string,
              name: name as string,
              ...(description === undefined ? {} : { description }),
              dataType: body.dataType as never,
              ...(unit === undefined ? {} : { unit }),
              ...(body.required === undefined
                ? {}
                : { required: Boolean(body.required) }),
              ...(body.allowFreeValue === undefined
                ? {}
                : { allowFreeValue: Boolean(body.allowFreeValue) }),
              ...(body.allowedValues === undefined
                ? {}
                : { allowedValues: body.allowedValues as never }),
              ...(body.sortOrder === undefined
                ? {}
                : { sortOrder: Number(body.sortOrder) }),
            },
            actor(req),
          ),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/service-catalog/parameterized/attributes/:attributeId',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const attributeId = parseUuid(
          param(req.params.attributeId),
          'attributeId',
        );
        const body = requireBody(req.body);
        rejectUnknownKeys(body, [
          'name',
          'description',
          'unit',
          'required',
          'allowFreeValue',
          'allowedValues',
          'sortOrder',
          'status',
        ]);
        const details: { field: string; message: string }[] = [];
        const name = optionalString(body.name, 'name', 200, details);
        const description = optionalString(
          body.description,
          'description',
          1000,
          details,
        );
        const unit = optionalString(body.unit, 'unit', 32, details);
        if (body.status !== undefined && body.status !== 'ACTIVE' && body.status !== 'INACTIVE') {
          details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
        }
        if (details.length) fail(details);
        sendSuccess(
          res,
          await updateHandymanServiceAttribute(
            attributeId,
            {
              ...(name === undefined ? {} : { name }),
              ...(description === undefined ? {} : { description }),
              ...(unit === undefined ? {} : { unit }),
              ...(body.required === undefined
                ? {}
                : { required: Boolean(body.required) }),
              ...(body.allowFreeValue === undefined
                ? {}
                : { allowFreeValue: Boolean(body.allowFreeValue) }),
              ...(body.allowedValues === undefined
                ? {}
                : { allowedValues: body.allowedValues as never }),
              ...(body.sortOrder === undefined
                ? {}
                : { sortOrder: Number(body.sortOrder) }),
              ...(body.status === undefined ? {} : { status: body.status as never }),
            },
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/service-catalog/parameterized/entries/:serviceCatalogId/commercial-profile',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        sendSuccess(
          res,
          await getHandymanServiceCommercialProfile(serviceCatalogId, actor(req)),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/service-catalog/parameterized/entries/:serviceCatalogId/commercial-profile',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const body = requireBody(req.body);
        rejectUnknownKeys(body, ['pricingMode', 'notes']);
        const details: { field: string; message: string }[] = [];
        const notes = optionalString(body.notes, 'notes', 1000, details);
        if (!isHandymanServicePricingMode(body.pricingMode)) {
          details.push({
            field: 'pricingMode',
            message:
              'pricingMode must be FIXED, ESTIMATED or INSPECTION_FIRST.',
          });
        }
        if (details.length) fail(details);
        sendSuccess(
          res,
          await upsertHandymanServiceCommercialProfile(
            serviceCatalogId,
            {
              pricingMode: body.pricingMode as never,
              ...(notes === undefined ? {} : { notes }),
            },
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/service-catalog/parameterized/price-rules',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = req.query as Record<string, unknown>;
        const unsupported = Object.keys(query).find(
          (key) => !['clientId', 'serviceCatalogId', 'status'].includes(key),
        );
        if (unsupported) {
          fail([
            { field: unsupported, message: 'This query parameter is not accepted.' },
          ]);
        }
        const status =
          query.status === undefined ? undefined : String(query.status);
        if (status !== undefined && status !== 'ACTIVE' && status !== 'INACTIVE') {
          fail([{ field: 'status', message: 'status must be ACTIVE or INACTIVE.' }]);
        }
        sendSuccess(
          res,
          await listHandymanServicePriceRules(
            parseUuid(String(query.clientId ?? ''), 'clientId'),
            actor(req),
            {
              ...(query.serviceCatalogId === undefined
                ? {}
                : {
                    serviceCatalogId: parseUuid(
                      String(query.serviceCatalogId),
                      'serviceCatalogId',
                    ),
                  }),
              ...(status === undefined ? {} : { status: status as never }),
            },
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/service-catalog/parameterized/entries/:serviceCatalogId/price-rules',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serviceCatalogId = parseUuid(
          param(req.params.serviceCatalogId),
          'serviceCatalogId',
        );
        const body = requireBody(req.body);
        rejectUnknownKeys(body, [
          'ruleCode',
          'priceCatalogEntryId',
          'priceBasis',
          'serviceVariantId',
          'attributeSelector',
          'minQuantity',
          'maxQuantity',
        ]);
        const details: { field: string; message: string }[] = [];
        const ruleCode = optionalString(body.ruleCode, 'ruleCode', 64, details);
        if (!ruleCode) {
          details.push({ field: 'ruleCode', message: 'ruleCode is required.' });
        }
        if (!isHandymanServicePriceBasis(body.priceBasis)) {
          details.push({
            field: 'priceBasis',
            message: 'priceBasis must be UNIT, POINT, METER, SQM or VISIT.',
          });
        }
        if (details.length) fail(details);
        sendSuccess(
          res,
          await createHandymanServicePriceRule(
            serviceCatalogId,
            {
              ruleCode: ruleCode as string,
              priceCatalogEntryId: String(body.priceCatalogEntryId ?? ''),
              priceBasis: body.priceBasis as never,
              ...(body.serviceVariantId === undefined
                ? {}
                : { serviceVariantId: body.serviceVariantId as never }),
              ...(body.attributeSelector === undefined
                ? {}
                : { attributeSelector: body.attributeSelector as never }),
              ...(body.minQuantity === undefined
                ? {}
                : { minQuantity: body.minQuantity as never }),
              ...(body.maxQuantity === undefined
                ? {}
                : { maxQuantity: body.maxQuantity as never }),
            },
            actor(req),
          ),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/service-catalog/parameterized/price-rules/:priceRuleId',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const priceRuleId = parseUuid(
          param(req.params.priceRuleId),
          'priceRuleId',
        );
        const body = requireBody(req.body);
        rejectUnknownKeys(body, [
          'priceCatalogEntryId',
          'priceBasis',
          'serviceVariantId',
          'attributeSelector',
          'minQuantity',
          'maxQuantity',
          'status',
        ]);
        const details: { field: string; message: string }[] = [];
        if (
          body.priceBasis !== undefined &&
          !isHandymanServicePriceBasis(body.priceBasis)
        ) {
          details.push({
            field: 'priceBasis',
            message: 'priceBasis must be UNIT, POINT, METER, SQM or VISIT.',
          });
        }
        if (
          body.status !== undefined &&
          body.status !== 'ACTIVE' &&
          body.status !== 'INACTIVE'
        ) {
          details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
        }
        if (details.length) fail(details);
        sendSuccess(
          res,
          await updateHandymanServicePriceRule(
            priceRuleId,
            {
              ...(body.priceCatalogEntryId === undefined
                ? {}
                : { priceCatalogEntryId: String(body.priceCatalogEntryId) }),
              ...(body.priceBasis === undefined
                ? {}
                : { priceBasis: body.priceBasis as never }),
              ...(body.serviceVariantId === undefined
                ? {}
                : { serviceVariantId: body.serviceVariantId as never }),
              ...(body.attributeSelector === undefined
                ? {}
                : { attributeSelector: body.attributeSelector as never }),
              ...(body.minQuantity === undefined
                ? {}
                : { minQuantity: body.minQuantity as never }),
              ...(body.maxQuantity === undefined
                ? {}
                : { maxQuantity: body.maxQuantity as never }),
              ...(body.status === undefined ? {} : { status: body.status as never }),
            },
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
