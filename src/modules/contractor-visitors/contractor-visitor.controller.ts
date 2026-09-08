import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contractorVisitorService } from './contractor-visitor.service';
import {
  parseContractorVisitorIdParam,
  parseContractorVisitorListQuery,
  parseCreateContractorVisitorBody,
  parseUpdateContractorVisitorBody,
} from './contractor-visitor.validation';

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export async function createContractorVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateContractorVisitorBody(req.body);
    const result = await contractorVisitorService.createContractorVisitor(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listContractorVisitorsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseContractorVisitorListQuery(
      req.query as Record<string, unknown>,
    );
    const result = await contractorVisitorService.listContractorVisitors(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function getContractorVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseContractorVisitorIdParam(paramString(req.params.id));
    const result = await contractorVisitorService.getContractorVisitor(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function updateContractorVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseContractorVisitorIdParam(paramString(req.params.id));
    const body = parseUpdateContractorVisitorBody(req.body);
    const result = await contractorVisitorService.updateContractorVisitor(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
