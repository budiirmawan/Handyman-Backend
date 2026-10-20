import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { parsePagination } from '../../shared/pagination';
import { AppError } from '../../shared/errors';
import { auditContextFromRequest } from '../audit';
import { authenticationRequiredError } from '../auth';
import { isValidUuid } from '../clients';
import { tenantImportService } from './tenant-import.service';
import { isTenantImportRowStatus, type TenantImportRowStatus } from './tenant-import.types';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function uuidParam(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value;
}

export async function uploadTenantImportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const clientId = uuidParam(param(req.params.clientId), 'clientId');
    const result = await tenantImportService.uploadTenantImport(
      { clientId, body: req.body },
      req.auth.userId,
      { ...auditContextFromRequest(req), actorUserId: req.auth.userId },
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function listTenantImportsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const clientId = uuidParam(param(req.params.clientId), 'clientId');
    const page = parsePagination(req.query as Record<string, unknown>);
    const result = await tenantImportService.listTenantImports(
      { clientId, page },
      req.auth.userId,
    );
    sendSuccess(res, result.batches, 200, result.meta);
  } catch (error) {
    next(error);
  }
}

export async function getTenantImportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const clientId = uuidParam(param(req.params.clientId), 'clientId');
    const batchId = uuidParam(param(req.params.batchId), 'batchId');
    const query = (req.query ?? {}) as Record<string, unknown>;
    const statusRaw = typeof query.status === 'string' ? query.status : undefined;
    if (statusRaw !== undefined && !isTenantImportRowStatus(statusRaw)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'status', message: 'status must be a valid row status.' },
      ]);
    }
    const rowStatus: TenantImportRowStatus | undefined =
      statusRaw !== undefined && isTenantImportRowStatus(statusRaw)
        ? statusRaw
        : undefined;
    const page = parsePagination(query);
    const result = await tenantImportService.getTenantImport(
      {
        clientId,
        batchId,
        rowFilters: rowStatus ? { status: rowStatus } : {},
        page,
      },
      req.auth.userId,
    );
    sendSuccess(res, { batch: result.batch, rows: result.rows }, 200, result.meta);
  } catch (error) {
    next(error);
  }
}

function phaseHandler(
  action: 'validate' | 'confirm' | 'commit' | 'abort',
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const clientId = uuidParam(param(req.params.clientId), 'clientId');
      const batchId = uuidParam(param(req.params.batchId), 'batchId');
      const audit = { ...auditContextFromRequest(req), actorUserId: req.auth.userId };
      if (action === 'validate') {
        const result = await tenantImportService.validateTenantImport(
          { clientId, batchId },
          req.auth.userId,
          audit,
        );
        sendSuccess(res, result);
        return;
      }
      if (action === 'confirm') {
        const batch = await tenantImportService.confirmTenantImport(
          { clientId, batchId },
          req.auth.userId,
          audit,
        );
        sendSuccess(res, { batch });
        return;
      }
      if (action === 'commit') {
        const result = await tenantImportService.commitTenantImport(
          { clientId, batchId },
          req.auth.userId,
          audit,
        );
        sendSuccess(res, result);
        return;
      }
      const batch = await tenantImportService.abortTenantImport(
        { clientId, batchId },
        req.auth.userId,
        audit,
      );
      sendSuccess(res, { batch });
    } catch (error) {
      next(error);
    }
  };
}

export const validateTenantImportHandler = phaseHandler('validate');
export const confirmTenantImportHandler = phaseHandler('confirm');
export const commitTenantImportHandler = phaseHandler('commit');
export const abortTenantImportHandler = phaseHandler('abort');
