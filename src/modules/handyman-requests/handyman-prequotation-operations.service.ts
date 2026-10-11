import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { permissionDeniedError } from '../auth/auth.errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository as requests } from './handyman-service-request.repository';
import { handymanRequestInspectionAssignmentRepository as assignments } from './handyman-request-inspection-assignment.repository';

export function prequotationConflict(message: string): AppError {
  return new AppError({ code: ERROR_CODES.HANDYMAN_PREQUOTATION_CONFLICT, statusCode: 409, message });
}
export function assertRequestOpen(request: { status: string }) {
  if (request.status === 'CANCELLED_PRE_QUOTATION') throw prequotationConflict('This request is irreversibly cancelled before quotation.');
}
export function requireUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation('Request validation failed.', [{ field, message: 'A valid UUID is required.' }]);
}
export function requireReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (reason.length < 10 || reason.length > 500) throw AppError.validation('Request validation failed.', [{ field: 'reason', message: 'Provide a specific reason (10-500 characters).' }]);
  return reason;
}
export async function requireOperations(tx: PoolClient, actor: string, permissions: string[]) {
  requireUuid(actor, 'actorUserId');
  if (!(await assignments.isActiveUser(tx, actor))) throw permissionDeniedError();
  for (const permission of permissions) if (!(await assignments.hasActivePermission(tx, actor, permission))) throw permissionDeniedError();
}
export async function lockScopedRequest(tx: PoolClient, id: string, actor: string) {
  requireUuid(id, 'handymanRequestId');
  const request = await requests.lockById(tx, id);
  if (!request) throw AppError.notFound('Handyman request not found.');
  await assertBuildingScopedResourceAccess(actor, { clientId: request.clientId, buildingId: request.buildingId });
  return request;
}
export async function assertPrequotation(tx: PoolClient, request: { id: string; status: string }) {
  assertRequestOpen(request);
  const existing = await tx.query(`SELECT 1 FROM handyman_quotations WHERE handyman_request_id=$1
    UNION ALL SELECT 1 FROM handyman_execution_scopes WHERE handyman_request_id=$1 LIMIT 1`, [request.id]);
  if (request.status === 'REFERRED' || existing.rowCount) throw prequotationConflict('An open pre-quotation request is required.');
}

export async function cancelHandymanPrequotation(id: string, reasonInput: unknown, actor: string) {
  const reason = requireReason(reasonInput);
  return withTransaction(async tx => {
    await requireOperations(tx, actor, ['handyman.operations.request.triage']);
    const request = await lockScopedRequest(tx, id, actor);
    await assertPrequotation(tx, request);
    const result = await tx.query(`INSERT INTO handyman_prequotation_cancellations
      (handyman_request_id, reason, cancelled_by_user_id) VALUES ($1,$2,$3)
      RETURNING handyman_request_id AS "handymanRequestId", reason,
        cancelled_by_user_id AS "cancelledByUserId", cancelled_at AS "cancelledAt"`, [id, reason, actor]);
    await recordOperationalEvent({ clientId: request.clientId, buildingId: request.buildingId,
      entityType: 'HANDYMAN_SERVICE_REQUEST', entityId: id, actorUserId: actor,
      eventType: 'HANDYMAN_PREQUOTATION_CANCELLED', summary: 'Operations cancelled the request before quotation.',
      metadata: { reason, disposition: 'CANCELLED_PRE_QUOTATION' } }, tx);
    return { ...result.rows[0], status: 'CANCELLED_PRE_QUOTATION' };
  });
}

/** A new intake can refer to history, never inherit approval, triage or scope. */
export async function linkCancelledPredecessor(id: string, predecessor: string, actor: string) {
  requireUuid(predecessor, 'cancelledRequestId');
  return withTransaction(async tx => {
    await requireOperations(tx, actor, ['handyman.operations.request.triage']);
    const request = await lockScopedRequest(tx, id, actor);
    assertRequestOpen(request);
    const previous = await requests.findById(tx, predecessor);
    if (request.status !== 'INTAKE' || !previous || previous.status !== 'CANCELLED_PRE_QUOTATION' ||
        previous.clientId !== request.clientId || previous.buildingId !== request.buildingId) {
      throw prequotationConflict('A new intake may reference only a cancelled request in its exact scope.');
    }
    if ((await tx.query('SELECT 1 FROM handyman_cancelled_request_predecessors WHERE handyman_request_id=$1', [id])).rowCount) {
      throw prequotationConflict('This intake already has a cancelled predecessor.');
    }
    await tx.query(`INSERT INTO handyman_cancelled_request_predecessors
      (handyman_request_id,cancelled_request_id,linked_by_user_id) VALUES ($1,$2,$3)`, [id, predecessor, actor]);
    await recordOperationalEvent({ clientId: request.clientId, buildingId: request.buildingId,
      entityType: 'HANDYMAN_SERVICE_REQUEST', entityId: id, actorUserId: actor,
      eventType: 'HANDYMAN_CANCELLED_PREDECESSOR_LINKED', summary: 'New intake references a cancelled request.',
      metadata: { cancelledRequestId: predecessor } }, tx);
    return { handymanRequestId: id, cancelledRequestId: predecessor };
  });
}

export async function getHandymanPrequotationHistory(id: string, actor: string) {
  return withTransaction(async tx => {
    await lockScopedRequest(tx, id, actor);
    const cancellations = await tx.query('SELECT * FROM handyman_prequotation_cancellations WHERE handyman_request_id=$1', [id]);
    const predecessor = await tx.query('SELECT * FROM handyman_cancelled_request_predecessors WHERE handyman_request_id=$1', [id]);
    return { cancellation: cancellations.rows[0] ?? null, predecessor: predecessor.rows[0] ?? null };
  });
}
