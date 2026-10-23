import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { isActorAuthorizedForWorkOrderAssignment } from '../work-order-actions/work-order-action.service';
import { handymanAssignmentResponseService } from './handyman-assignment-response.service';
import {
  parseAcknowledgeAssignmentBody,
  parseDeadlinePolicyQuery,
  parseDeclineAssignmentBody,
  parseUpsertDeadlinePolicyBody,
  parseUuidParam,
} from './handyman-assignment-response.validation';

export async function acknowledgeExecutionScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseUuidParam(
      req.params.executionScopeId,
      'executionScopeId',
    );
    const body = parseAcknowledgeAssignmentBody(req.body);
    const data =
      await handymanAssignmentResponseService.acknowledgeExecutionScopeAssignment(
        executionScopeId,
        req.auth.userId,
        body,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function declineExecutionScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseUuidParam(
      req.params.executionScopeId,
      'executionScopeId',
    );
    const body = parseDeclineAssignmentBody(req.body);
    const data =
      await handymanAssignmentResponseService.declineExecutionScopeAssignment(
        executionScopeId,
        req.auth.userId,
        body,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function acknowledgeInspectorVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitAppointmentId = parseUuidParam(
      req.params.visitAppointmentId,
      'visitAppointmentId',
    );
    const body = parseAcknowledgeAssignmentBody(req.body);
    const data =
      await handymanAssignmentResponseService.acknowledgeInspectorVisitAssignment(
        visitAppointmentId,
        req.auth.userId,
        body,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function declineInspectorVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitAppointmentId = parseUuidParam(
      req.params.visitAppointmentId,
      'visitAppointmentId',
    );
    const body = parseDeclineAssignmentBody(req.body);
    const data =
      await handymanAssignmentResponseService.declineInspectorVisitAssignment(
        visitAppointmentId,
        req.auth.userId,
        body,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function declineWorkOrderAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseUuidParam(req.params.id, 'id');
    const body = parseDeclineAssignmentBody(req.body);
    const data =
      await handymanAssignmentResponseService.declineWorkOrderAssignment(
        workOrderId,
        req.auth.userId,
        body,
        isActorAuthorizedForWorkOrderAssignment,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function getExecutionScopeWorkerResponseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseUuidParam(
      req.params.executionScopeId,
      'executionScopeId',
    );
    const data =
      await handymanAssignmentResponseService.getOperationsExecutionScopeResponseVisibility(
        executionScopeId,
        req.auth.userId,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function getInspectorVisitWorkerResponseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitAppointmentId = parseUuidParam(
      req.params.visitAppointmentId,
      'visitAppointmentId',
    );
    const data =
      await handymanAssignmentResponseService.getOperationsInspectorVisitResponseVisibility(
        visitAppointmentId,
        req.auth.userId,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function getWorkOrderWorkerResponseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseUuidParam(req.params.id, 'id');
    const data =
      await handymanAssignmentResponseService.getOperationsWorkOrderResponseVisibility(
        workOrderId,
        req.auth.userId,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function getResponseDeadlinePolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseDeadlinePolicyQuery(req.query);
    const data =
      await handymanAssignmentResponseService.getAssignmentDeadlinePolicy(
        req.auth.userId,
        query,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}

export async function upsertResponseDeadlinePolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseUpsertDeadlinePolicyBody(req.body);
    const data =
      await handymanAssignmentResponseService.configureAssignmentDeadlinePolicy(
        req.auth.userId,
        body,
      );
    sendSuccess(res, data, 200);
  } catch (error) {
    next(error);
  }
}
