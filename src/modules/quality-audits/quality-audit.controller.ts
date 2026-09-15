import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { qualityAuditService } from './quality-audit.service';
import {
  parseCompleteQualityAuditBody,
  parseCreateQualityAuditBody,
  parseQualityAuditFilter,
  parseQualityAuditIdParam,
  parseUpdateQualityAuditBody,
} from './quality-audit.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createQualityAuditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreateQualityAuditBody(req.body);
    const audit = await qualityAuditService.createQualityAudit({
      ...input,
      auditorUserId: req.auth.userId,
    });

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      audit.buildingId,
    );

    sendSuccess(res, audit, 201);
  } catch (error) {
    next(error);
  }
}

export async function listQualityAuditsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseQualityAuditFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results = await qualityAuditService.listQualityAudits(filter);
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getQualityAuditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseQualityAuditIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const audit = await qualityAuditService.getQualityAuditById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      audit.buildingId,
    );

    sendSuccess(res, audit);
  } catch (error) {
    next(error);
  }
}

export async function updateQualityAuditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseQualityAuditIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await qualityAuditService.getQualityAuditById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdateQualityAuditBody(req.body);
    const updated = await qualityAuditService.updateQualityAudit(id, input);

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

export async function completeQualityAuditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseQualityAuditIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await qualityAuditService.getQualityAuditById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseCompleteQualityAuditBody(req.body);
    const completed = await qualityAuditService.completeQualityAudit(
      id,
      input,
    );

    sendSuccess(res, completed);
  } catch (error) {
    next(error);
  }
}
