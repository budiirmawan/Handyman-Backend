import type { Pool, PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess, canAccessBuildingScopedResource } from '../context-access';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { insertHandymanVisitProposal, listHandymanVisitAppointments, type HandymanAppointmentRecord } from './handyman-appointment.repository';
import { findEligibleHandymanWorker, assertHandymanCrewWorkerEligibility } from '../handyman-providers/handyman-worker-eligibility.repository';
import type { VisitProposalBody } from './handyman-visit-api.validation';

/** R1C scoped operations proposal/read/cancel. No appointment confirmation or visit start here. */
const conflict = (message: string) => new AppError({code: ERROR_CODES.CONFLICT, message, statusCode: 409});
const encode = (value: HandymanAppointmentRecord) => ({...value,
  startAt: value.startAt.toISOString(), endAt: value.endAt.toISOString(),
  confirmedBooking: ['CONFIRMED','IN_PROGRESS','COMPLETED'].includes(value.state)});
type RequestScope = { id: string; clientId: string; buildingId: string; status: string; timezone: string | null };
async function requestScope(queryable: Pool | PoolClient, requestId: string, lock = false): Promise<RequestScope> {
  const result = await queryable.query(`SELECT r.id, r.client_id AS "clientId", r.building_id AS "buildingId",
    r.status, b.timezone FROM handyman_service_requests r
    JOIN buildings b ON b.id = r.building_id
    WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [requestId]);
  if (!result.rows[0]) throw AppError.notFound('Handyman request not found.');
  return result.rows[0] as RequestScope;
}
async function scoped(actorId: string, req: RequestScope) {
  await assertBuildingScopedResourceAccess(actorId, {clientId: req.clientId, buildingId: req.buildingId});
}
export async function readVisitProposals(requestId: string, actorId: string) {
  const db = getPool();
  const req = await requestScope(db, requestId);
  await scoped(actorId, req);
  const rows = await listHandymanVisitAppointments(db, req.clientId, req.id);
  return {requestId, appointments: rows.map(encode), bookingEnabled: false, confirmationEnabled: false};
}
export async function createVisitProposal(requestId: string, body: VisitProposalBody, actorId: string) {
  try {
    return await withTransaction(async tx => {
      const req = await requestScope(tx, requestId, true);
      await scoped(actorId, req);
      if (!req.timezone) throw conflict('Building timezone is not configured.');
      try { new Intl.DateTimeFormat('en', {timeZone: req.timezone}).format(new Date()); }
      catch { throw conflict('Building timezone is invalid.'); }
      if (body.kind === 'INSPECTION') {
        if (req.status !== 'INSPECTION_REQUIRED') throw conflict('Request is not awaiting onsite inspection.');
        const active = await tx.query(`SELECT id FROM users WHERE id=$1 AND status='ACTIVE'`, [body.resourceId]);
        // Apply the same exact Building + Client authority to the proposed
        // resource as to the operator; a Building-only match is insufficient.
        if (!active.rows.length || !await canAccessBuildingScopedResource(body.resourceId, {
          clientId: req.clientId, buildingId: req.buildingId,
        })) {
          throw conflict('Proposed inspector is not an active user assigned to this building.');
        }
        if (!await findEligibleHandymanWorker(tx, {
          clientId: req.clientId, buildingId: req.buildingId, userId: body.resourceId, requireLogin: true,
        })) {
          throw conflict('Proposed inspector lacks active Handyman worker registration or building placement.');
        }
        // Inspector skill verification remains a confirmation prerequisite; this is only a proposal.
      } else {
        const target = await tx.query(`SELECT es.id FROM handyman_execution_scopes es
          JOIN handyman_execution_scope_assignments a ON a.execution_scope_id = es.id
            AND a.client_id=es.client_id AND a.status = 'ACTIVE' AND a.handyman_crew_id = $3
          JOIN handyman_work_crews c ON c.id = a.handyman_crew_id AND c.status = 'ACTIVE'
            AND c.client_id=es.client_id AND c.handyman_provider_context_id=a.handyman_provider_context_id
          WHERE es.id=$1 AND es.handyman_request_id=$2 AND es.client_id=$4
            AND es.status='AUTHORIZED'`, [body.executionScopeId, requestId, body.resourceId, req.clientId]);
        if (!target.rows.length) throw conflict('No active authorized assignment for the proposed crew.');
        await assertHandymanCrewWorkerEligibility(tx, {
          clientId: req.clientId, buildingId: req.buildingId, crewId: body.resourceId,
        });
      }
      const created = await insertHandymanVisitProposal(tx, {handymanRequestId: requestId,
        kind: body.kind, resourceId: body.resourceId, executionScopeId: body.executionScopeId,
        interval: {startAt: body.startAt, endAt: body.endAt, timezone: req.timezone}, createdByUserId: actorId});
      return encode(created);
    });
  } catch(error) {
    if ((error as {code?: string}).code === '23505') throw conflict('A live appointment proposal already exists for this request and visit kind.');
    throw error;
  }
}
export async function cancelVisitProposal(requestId: string, appointmentId: string, version: number, actorId: string) {
  return withTransaction(async tx => {
    const req = await requestScope(tx, requestId, true);
    await scoped(actorId, req);
    const changed = await tx.query(`UPDATE handyman_visit_appointments SET
      state='CANCELLED', cancelled_by_user_id=$4, cancelled_at=NOW(), version=version+1,
      updated_at=NOW() WHERE id=$1 AND handyman_request_id=$2 AND client_id=$3
        AND state='PROPOSED' AND version=$5 RETURNING id, state, version`,
      [appointmentId, requestId, req.clientId, actorId, version]);
    if (!changed.rows.length) throw conflict('Only the current PROPOSED appointment can be cancelled. Reload before retry.');
    return changed.rows[0];
  });
}
