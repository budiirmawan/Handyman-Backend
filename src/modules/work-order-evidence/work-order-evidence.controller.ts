import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workOrderService } from '../work-orders';
import { workOrderEvidenceService } from './work-order-evidence.service';
import {
  parseEvidenceIdParam,
  parseSubmitEvidenceBody,
  parseWorkOrderIdParam,
} from './work-order-evidence.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

async function assertWorkOrderBuildingAccess(
  userId: string,
  workOrderId: string,
): Promise<void> {
  const workOrder = await workOrderService.getWorkOrderById(workOrderId);
  await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);
}

export async function listRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const requirements =
      await workOrderEvidenceService.listWorkOrderEvidenceRequirements(
        workOrderId,
      );
    sendSuccess(res, requirements);
  } catch (error) {
    next(error);
  }
}

export async function submitEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const input = parseSubmitEvidenceBody(req.body);
    const evidence = await workOrderEvidenceService.submitWorkOrderEvidence({
      ...input,
      workOrderId,
      submittedByUserId: req.auth.userId,
    });
    sendSuccess(res, evidence, 201);
  } catch (error) {
    next(error);
  }
}

export async function listEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const evidence = await workOrderEvidenceService.listWorkOrderEvidence(
      workOrderId,
    );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}

export async function removeEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    const evidenceId = parseEvidenceIdParam(paramString(req.params.evidenceId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const evidence = await workOrderEvidenceService.removeWorkOrderEvidence(
      workOrderId,
      evidenceId,
    );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}
