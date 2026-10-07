import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  assignHandymanExecutionScopeCrew,
  getHandymanExecutionScopeAssignment,
  handymanAssignmentNotFoundError,
  reassignHandymanExecutionScopeCrew,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import {
  parseAssignmentBody,
  parseAssignmentScopeParam,
} from './handyman-scope-assignments-api.validation';

/**
 * CR-HM-04 activation PART C — Execution Scope assignment HTTP
 * handlers (thin shells). Actor = authenticated session only;
 * PART A/B runtime is the sole authority for eligibility, locking,
 * lifecycle and one-ACTIVE invariants. ZERO scheduling/arrival/
 * challenge/QR/geofence/work-session/attendance/payment/BAST/FM
 * handlers. The internal Lead resolver is composed ONLY into the
 * bounded current-assignment view (no standalone "resolve actor"
 * endpoint — CR-HM-07 consumes the resolver internally).
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function postHandymanExecutionScopeAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseAssignmentScopeParam(
      p(req.params.executionScopeId),
    );
    sendSuccess(
      res,
      await assignHandymanExecutionScopeCrew(
        { executionScopeId, ...parseAssignmentBody(req.body) },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanExecutionScopeAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseAssignmentScopeParam(
      p(req.params.executionScopeId),
    );
    const actorUserId = actor(req);
    const assignment = await getHandymanExecutionScopeAssignment(
      executionScopeId,
      actorUserId,
    );
    if (!assignment) throw handymanAssignmentNotFoundError();
    // Bounded operational view: assignment facts + lead identity
    // composed dynamically from the PART B resolver (never a snapshot,
    // never a second authority).
    const lead = await resolveHandymanAssignmentLead(
      executionScopeId,
      actorUserId,
    );
    sendSuccess(res, {
      assignmentId: assignment.id,
      executionScopeId: assignment.executionScopeId,
      providerContextId: assignment.handymanProviderContextId,
      crewId: assignment.handymanCrewId,
      status: assignment.status,
      assignedByUserId: assignment.assignedByUserId,
      assignedAt: assignment.assignedAt,
      supersedesAssignmentId: assignment.supersedesAssignmentId,
      leadWorkerContextId: lead?.leadWorkerContextId ?? null,
      leadUserId: lead?.leadUserId ?? null,
    });
  } catch (error) {
    next(error);
  }
}

export async function postHandymanExecutionScopeReassignHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseAssignmentScopeParam(
      p(req.params.executionScopeId),
    );
    sendSuccess(
      res,
      await reassignHandymanExecutionScopeCrew(
        { executionScopeId, ...parseAssignmentBody(req.body) },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}
