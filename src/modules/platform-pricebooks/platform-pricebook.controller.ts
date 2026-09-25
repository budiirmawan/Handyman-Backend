import type { NextFunction, Request, Response } from 'express';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import {
  createSaasPricebook,
  createSaasPricebookVersion,
  getSaasPricebookDetail,
  listSaasPricebooks,
  publishSaasPricebookVersion,
} from './platform-pricebook.service';
import {
  parseCreateSaasPricebookBody,
  parseCreateSaasPricebookVersionBody,
  parseListSaasPricebookFilters,
  parsePricebookIdParam,
  parsePricebookVersionIdParam,
} from './platform-pricebook.validation';

/**
 * CR-BE-SAAS-01 PART 02 — SaaS Pricebook controllers (SaaS Control Plane).
 *
 * Authority: explicit `platform.pricebook.*` permission (router) + the
 * authenticated platform actor (`req.auth.userId`) recorded in canonical
 * audit. Only the publish command takes `Idempotency-Key` (frozen §22
 * "Idem."). No expectedVersion: pricebook versions are not §17.3 OCC
 * aggregates — published versions are immutable rather than last-write-wins.
 */

export async function listSaasPricebooksHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseListSaasPricebookFilters(query);
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const result = await listSaasPricebooks({
      filters,
      withTotal: usePagination,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    sendSuccess(
      res,
      result.records,
      200,
      usePagination
        ? buildPaginationMeta(pagination.page, pagination.pageSize, result.total ?? 0)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

export async function createSaasPricebookHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSaasPricebookBody(req.body);
    const record = await createSaasPricebook(
      req.auth.userId,
      'platform.pricebook.manage',
      input,
    );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

export async function getSaasPricebookHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePricebookIdParam(req.params.id);
    const detail = await getSaasPricebookDetail(id);
    sendSuccess(res, detail, 200);
  } catch (error) {
    next(error);
  }
}

export async function createSaasPricebookVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const pricebookId = parsePricebookIdParam(req.params.id);
    const input = parseCreateSaasPricebookVersionBody(req.body);
    const detail = await createSaasPricebookVersion(
      req.auth.userId,
      'platform.pricebook.manage',
      pricebookId,
      input,
    );
    sendSuccess(res, detail, 201);
  } catch (error) {
    next(error);
  }
}

export async function publishSaasPricebookVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const versionId = parsePricebookVersionIdParam(req.params.id);
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );

    const result = await publishSaasPricebookVersion(
      req.auth.userId,
      'platform.pricebook.manage',
      versionId,
      idempotencyKey,
    );

    sendSuccess(res, result.data, result.replayed ? 200 : 201, {
      replayed: result.replayed,
    });
  } catch (error) {
    next(error);
  }
}
