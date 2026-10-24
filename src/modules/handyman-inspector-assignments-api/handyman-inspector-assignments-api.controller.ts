import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseAssignmentResponseIdempotencyKey } from '../assignment-responses';
import { handymanInspectorAssignmentService } from '../handyman-inspector-assignments';
import {
  parseAssignInspectorBody,
  parseAssignmentIdParam,
  parseReassignInspectorBody,
  parseRequestIdParam,
  parseRespondInspectorBody,
  parseRevokeInspectorBody,
  parseVisitIdParam,
} from './handyman-inspector-assignments-api.validation';

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getEligibleInspectorsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseVisitIdParam(req.params.visitAppointmentId);
    sendSuccess(
      res,
      await handymanInspectorAssignmentService.listEligibleInspectorsForVisit(
        visitId,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getInspectorAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseVisitIdParam(req.params.visitAppointmentId);
    const current =
      await handymanInspectorAssignmentService.getInspectorAssignmentForVisit(
        visitId,
        actor(req),
      );
    if (!current) {
      const { handymanInspectorAssignmentNotFoundError } =
        await import('../handyman-inspector-assignments');
      throw handymanInspectorAssignmentNotFoundError();
    }
    sendSuccess(res, current);
  } catch (error) {
    next(error);
  }
}

export async function assignInspectorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseVisitIdParam(req.params.visitAppointmentId);
    const body = parseAssignInspectorBody(req.body);
    sendSuccess(
      res,
      await handymanInspectorAssignmentService.assignInspectorToVisit(
        { visitAppointmentId: visitId, ...body },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function reassignInspectorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseVisitIdParam(req.params.visitAppointmentId);
    const body = parseReassignInspectorBody(req.body);
    sendSuccess(
      res,
      await handymanInspectorAssignmentService.reassignInspectorForVisit(
        { visitAppointmentId: visitId, ...body },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function revokeInspectorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseVisitIdParam(req.params.visitAppointmentId);
    const body = parseRevokeInspectorBody(req.body);
    sendSuccess(
      res,
      await handymanInspectorAssignmentService.revokeInspectorAssignment(
        visitId,
        body.expectedVersion,
        body.reason,
        actor(req),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}

export async function getInspectorHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseRequestIdParam(req.params.handymanRequestId);
    sendSuccess(
      res,
      await handymanInspectorAssignmentService.listInspectorAssignmentHistory(
        requestId,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function respondInspectorAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseVisitIdParam(req.params.visitAppointmentId);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    const body = parseRespondInspectorBody(req.body);
    const idempotencyKey = parseAssignmentResponseIdempotencyKey(
      req.header('Idempotency-Key'),
      req.body,
    );
    sendSuccess(
      res,
      await handymanInspectorAssignmentService.respondToInspectorVisitAssignment(
        {
          visitAppointmentId: visitId,
          assignmentId,
          ...body,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        },
        actor(req),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}

export async function listInspectorAssignmentResponseHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseVisitIdParam(req.params.visitAppointmentId);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    sendSuccess(
      res,
      await handymanInspectorAssignmentService.listInspectorVisitAssignmentResponseHistory(
        visitId,
        assignmentId,
        actor(req),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}
