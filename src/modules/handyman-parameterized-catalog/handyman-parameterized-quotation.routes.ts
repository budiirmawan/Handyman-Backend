import { Router, type NextFunction, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationRequiredError } from '../auth';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { isValidUuid } from '../clients';
import {
  addHandymanServiceRequestItem,
  listHandymanServiceRequestItems,
  removeHandymanServiceRequestItem,
  updateHandymanServiceRequestItem,
} from './handyman-request-items.service';
import {
  listHandymanServiceQuoteResolutions,
  prepareHandymanCatalogQuotation,
  reviseHandymanCatalogQuotation,
} from './handyman-parameterized-quotation.service';
import { isHandymanServiceAccessCondition } from './handyman-parameterized-catalog.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — the parameterized REQUEST / QUOTATION
 * transport.
 *
 *   POST   /handyman/requests/:handymanRequestId/items
 *   GET    /handyman/requests/:handymanRequestId/items
 *   PATCH  /handyman/requests/:handymanRequestId/items/:itemId
 *   DELETE /handyman/requests/:handymanRequestId/items/:itemId
 *   POST   /handyman/requests/:handymanRequestId/quotation/prepare
 *   POST   /handyman/requests/:handymanRequestId/quotation/revision
 *   GET    /handyman/requests/:handymanRequestId/price-resolution
 *
 * RBAC: reads `tenant_company.read`, mutations `tenant_company.manage` —
 * the EXISTING Handyman quotation permissions.
 *
 * Scope: every operation is Building-scoped through the parent request
 * (BE-02G exact-Building guard, no same-Client shortcut). The client /
 * building / tenant lineage is ALWAYS server-derived from the request.
 *
 * The quotation operations COMPOSE the existing quotation lifecycle — they
 * do not add a second one. Issuing stays on the existing
 * `/handyman/quotation-versions/:id/issue` route and the customer approval
 * stays on the existing `/handyman/quotation-versions/:id/decision` route.
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

function requireBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  return body;
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

export function createHandymanParameterizedQuotationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  router.post(
    '/handyman/requests/:handymanRequestId/items',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handymanRequestId = parseUuid(
          param(req.params.handymanRequestId),
          'handymanRequestId',
        );
        const body = requireBody(req.body);
        rejectUnknownKeys(body, [
          'serviceCatalogId',
          'serviceVariantId',
          'quantity',
          'attributeValues',
          'accessCondition',
        ]);
        const details: { field: string; message: string }[] = [];
        if (typeof body.serviceCatalogId !== 'string') {
          details.push({
            field: 'serviceCatalogId',
            message: 'serviceCatalogId is required.',
          });
        }
        const quantity = Number(body.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          details.push({
            field: 'quantity',
            message: 'quantity must be a positive number.',
          });
        }
        if (
          body.accessCondition !== undefined &&
          !isHandymanServiceAccessCondition(body.accessCondition)
        ) {
          details.push({
            field: 'accessCondition',
            message:
              'accessCondition must be STANDARD, DIFFICULT, HIGH_FLOOR, RESTRICTED or SPECIAL_EQUIPMENT.',
          });
        }
        if (
          body.attributeValues !== undefined &&
          (typeof body.attributeValues !== 'object' ||
            body.attributeValues === null ||
            Array.isArray(body.attributeValues))
        ) {
          details.push({
            field: 'attributeValues',
            message: 'attributeValues must be an object of code to value.',
          });
        }
        if (details.length) fail(details);
        sendSuccess(
          res,
          await addHandymanServiceRequestItem(
            handymanRequestId,
            {
              serviceCatalogId: String(body.serviceCatalogId),
              ...(body.serviceVariantId === undefined
                ? {}
                : { serviceVariantId: body.serviceVariantId as never }),
              quantity,
              ...(body.attributeValues === undefined
                ? {}
                : { attributeValues: body.attributeValues as never }),
              ...(body.accessCondition === undefined
                ? {}
                : { accessCondition: body.accessCondition as never }),
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

  router.get(
    '/handyman/requests/:handymanRequestId/items',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handymanRequestId = parseUuid(
          param(req.params.handymanRequestId),
          'handymanRequestId',
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
          fail([{ field: 'status', message: 'status must be ACTIVE or REMOVED.' }]);
        }
        sendSuccess(
          res,
          await listHandymanServiceRequestItems(
            handymanRequestId,
            actor(req),
            status === undefined
              ? undefined
              : (status as 'ACTIVE' | 'REMOVED'),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/handyman/requests/:handymanRequestId/items/:itemId',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handymanRequestId = parseUuid(
          param(req.params.handymanRequestId),
          'handymanRequestId',
        );
        const itemId = parseUuid(param(req.params.itemId), 'itemId');
        const body = requireBody(req.body);
        rejectUnknownKeys(body, [
          'serviceVariantId',
          'quantity',
          'attributeValues',
          'accessCondition',
        ]);
        const details: { field: string; message: string }[] = [];
        if (body.quantity !== undefined) {
          const quantity = Number(body.quantity);
          if (!Number.isFinite(quantity) || quantity <= 0) {
            details.push({
              field: 'quantity',
              message: 'quantity must be a positive number.',
            });
          }
        }
        if (
          body.accessCondition !== undefined &&
          !isHandymanServiceAccessCondition(body.accessCondition)
        ) {
          details.push({
            field: 'accessCondition',
            message:
              'accessCondition must be STANDARD, DIFFICULT, HIGH_FLOOR, RESTRICTED or SPECIAL_EQUIPMENT.',
          });
        }
        if (
          body.attributeValues !== undefined &&
          (typeof body.attributeValues !== 'object' ||
            body.attributeValues === null ||
            Array.isArray(body.attributeValues))
        ) {
          details.push({
            field: 'attributeValues',
            message: 'attributeValues must be an object of code to value.',
          });
        }
        if (details.length) fail(details);
        sendSuccess(
          res,
          await updateHandymanServiceRequestItem(
            handymanRequestId,
            itemId,
            {
              ...(body.serviceVariantId === undefined
                ? {}
                : { serviceVariantId: body.serviceVariantId as never }),
              ...(body.quantity === undefined
                ? {}
                : { quantity: Number(body.quantity) }),
              ...(body.attributeValues === undefined
                ? {}
                : { attributeValues: body.attributeValues as never }),
              ...(body.accessCondition === undefined
                ? {}
                : { accessCondition: body.accessCondition as never }),
            },
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/handyman/requests/:handymanRequestId/items/:itemId',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handymanRequestId = parseUuid(
          param(req.params.handymanRequestId),
          'handymanRequestId',
        );
        const itemId = parseUuid(param(req.params.itemId), 'itemId');
        sendSuccess(
          res,
          await removeHandymanServiceRequestItem(
            handymanRequestId,
            itemId,
            actor(req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/handyman/requests/:handymanRequestId/quotation/prepare',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handymanRequestId = parseUuid(
          param(req.params.handymanRequestId),
          'handymanRequestId',
        );
        const body = requireBody(req.body ?? {});
        rejectUnknownKeys(body, ['effectiveDate']);
        sendSuccess(
          res,
          await prepareHandymanCatalogQuotation(
            handymanRequestId,
            {
              ...(body.effectiveDate === undefined
                ? {}
                : { effectiveDate: String(body.effectiveDate) }),
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
    '/handyman/requests/:handymanRequestId/quotation/revision',
    auth,
    manage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handymanRequestId = parseUuid(
          param(req.params.handymanRequestId),
          'handymanRequestId',
        );
        const body = requireBody(req.body ?? {});
        rejectUnknownKeys(body, ['effectiveDate', 'validUntil', 'issue']);
        if (body.issue !== undefined && typeof body.issue !== 'boolean') {
          fail([{ field: 'issue', message: 'issue must be a boolean.' }]);
        }
        sendSuccess(
          res,
          await reviseHandymanCatalogQuotation(
            handymanRequestId,
            {
              ...(body.effectiveDate === undefined
                ? {}
                : { effectiveDate: String(body.effectiveDate) }),
              ...(body.validUntil === undefined
                ? {}
                : { validUntil: String(body.validUntil) }),
              ...(body.issue === undefined ? {} : { issue: Boolean(body.issue) }),
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
    '/handyman/requests/:handymanRequestId/price-resolution',
    auth,
    read,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handymanRequestId = parseUuid(
          param(req.params.handymanRequestId),
          'handymanRequestId',
        );
        sendSuccess(
          res,
          await listHandymanServiceQuoteResolutions(
            handymanRequestId,
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
