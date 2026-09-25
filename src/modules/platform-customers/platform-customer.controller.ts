import type { NextFunction, Request, Response } from 'express';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import {
  createSaaSCustomer,
  getSaaSCustomerDetail,
  listSaaSCustomers,
  updateSaaSCustomer,
} from './platform-customer.service';
import {
  parseCreateSaaSCustomerBody,
  parseCustomerIdParam,
  parseListSaaSCustomerFilters,
  parseUpdateSaaSCustomerBody,
} from './platform-customer.validation';

/** Express 5 types path params as `string | string[]`; normalize. */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * CR-BE-SAAS-01 PART 01 — SaaS Customer controllers (SaaS Control Plane).
 *
 * Authority for these routes is the EXPLICIT `platform.customer.*`
 * permission (enforced by `requirePlatformPermission` in the router) plus
 * the authenticated platform actor's identity (`req.auth.userId`) — never a
 * caller-supplied actor or scope. The actor id is recorded in canonical
 * audit as the SaaS authority for the mutation.
 */

export async function listSaaSCustomersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseListSaaSCustomerFilters(query);
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const result = await listSaaSCustomers({
      filters,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    sendSuccess(
      res,
      result.customers,
      200,
      usePagination
        ? buildPaginationMeta(result.page, result.pageSize, result.total)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

export async function createSaaSCustomerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const input = parseCreateSaaSCustomerBody(req.body);

    const result = await createSaaSCustomer(
      req.auth.userId,
      'platform.customer.manage',
      input,
      idempotencyKey,
    );

    sendSuccess(res, result.data, result.replayed ? 200 : 201, {
      replayed: result.replayed,
    });
  } catch (error) {
    next(error);
  }
}

export async function getSaaSCustomerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const customerId = parseCustomerIdParam(paramString(req.params.id));
    const detail = await getSaaSCustomerDetail(customerId);
    sendSuccess(res, detail);
  } catch (error) {
    next(error);
  }
}

export async function updateSaaSCustomerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const customerId = parseCustomerIdParam(paramString(req.params.id));
    const input = parseUpdateSaaSCustomerBody(req.body);

    const updated = await updateSaaSCustomer(
      req.auth.userId,
      'platform.customer.manage',
      customerId,
      input,
    );

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

export const platformCustomerController = {
  createSaaSCustomerHandler,
  getSaaSCustomerHandler,
  listSaaSCustomersHandler,
  updateSaaSCustomerHandler,
};
