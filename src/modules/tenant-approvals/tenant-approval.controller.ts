import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantApprovalService } from './tenant-approval.service';
import {
  parseCreateTenantApprovalBody,
  parseTenantApprovalDecisionBody,
  parseTenantApprovalIdParam,
  parseTenantApprovalPendingFilters,
} from './tenant-approval.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantApprovalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantApprovalService.createTenantApproval(
      parseCreateTenantApprovalBody(req.body), actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getTenantApprovalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantApprovalService.getTenantApproval(
      parseTenantApprovalIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listPendingTenantApprovalsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantApprovalService.listPendingTenantApprovals(
      parseTenantApprovalPendingFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
/** BE-18L — GET /utility/calculations/:id/tenant-approvals. */
export async function getUtilityCalculationApprovalContextHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantApprovalService.getUtilityCalculationApprovalContext(
      parseTenantApprovalIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function approveTenantApprovalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantApprovalService.approveTenantApproval(
      parseTenantApprovalIdParam(param(req.params.id)),
      parseTenantApprovalDecisionBody(req.body, false), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function rejectTenantApprovalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantApprovalService.rejectTenantApproval(
      parseTenantApprovalIdParam(param(req.params.id)),
      parseTenantApprovalDecisionBody(req.body, true), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function getTenantApprovalActionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantApprovalService.resolveTenantApprovalAvailableActions(
      parseTenantApprovalIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
