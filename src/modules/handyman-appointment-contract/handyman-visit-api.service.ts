import type { Pool, PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess, canAccessBuildingScopedResource } from '../context-access';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { insertHandymanVisitProposal, listHandymanVisitAppointments, type HandymanAppointmentRecord } from './handyman-appointment.repository';
import { findEligibleHandymanWorker, assertHandymanCrewWorkerEligibility } from '../handyman-providers/handyman-worker-eligibility.repository';
import { recordOperationalEvent } from '../operational-events';
import { tenantSlotConsentAuthorityConfigured } from './handyman-tenant-slot-authority';
import {
  assertProposalMatchesPendingChoice, bindTenantSlotChoice, findPendingTenantSlotChoice,
} from './handyman-tenant-slot-binding.repository';
import { parseVisitWindow, type VisitProposalBody } from './handyman-visit-api.validation';
import { handymanSchedulingReadinessRepository } from '../handyman-scheduling/handyman-scheduling.repository';
import { getHandymanSchedulingReadiness } from '../handyman-scheduling/handyman-scheduling.service';
import { sameInstant } from './handyman-tenant-slot-assertion';

/**
 * Audit-only journal for visit PROPOSAL mutations. Written in the SAME
 * transaction as the mutation through the existing `recordOperationalEvent`
 * authority, so a failed audit rolls the proposal back. Metadata carries
 * Handyman identities and lifecycle facts only: no tenant consent, no
 * caller-supplied context, and no booking/capacity claim.
 */
export const HANDYMAN_VISIT_PROPOSED = 'HANDYMAN_VISIT_PROPOSED';
export const HANDYMAN_VISIT_PROPOSAL_CANCELLED = 'HANDYMAN_VISIT_PROPOSAL_CANCELLED';

/** R1C scoped operations proposal/read/cancel. Confirmation lives in the confirmation service. */
export const conflict = (message: string) => new AppError({code: ERROR_CODES.CONFLICT, message, statusCode: 409});
export const encode = (value: HandymanAppointmentRecord) => ({...value,
  startAt: value.startAt.toISOString(), endAt: value.endAt.toISOString(),
  confirmedBooking: ['CONFIRMED','IN_PROGRESS','COMPLETED'].includes(value.state)});
export type RequestScope = { id: string; clientId: string; buildingId: string; status: string; timezone: string | null };
export async function requestScope(queryable: Pool | PoolClient, requestId: string, lock = false): Promise<RequestScope> {
  const result = await queryable.query(`SELECT r.id, r.client_id AS "clientId", r.building_id AS "buildingId",
    r.status, b.timezone FROM handyman_service_requests r
    JOIN buildings b ON b.id = r.building_id
    WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [requestId]);
  if (!result.rows[0]) throw AppError.notFound('Handyman request not found.');
  return result.rows[0] as RequestScope;
}
export async function scoped(actorId: string, req: RequestScope) {
  await assertBuildingScopedResourceAccess(actorId, {clientId: req.clientId, buildingId: req.buildingId});
}
export type VisitResourceTarget = {
  kind: 'INSPECTION' | 'EXECUTION';
  resourceId: string;
  executionScopeId: string | null;
};
/**
 * Live eligibility of a proposed or to-be-confirmed resource, evaluated inside
 * the caller's transaction against the request's authoritative scope. Shared
 * by proposal (PROPOSED) and confirmation (CONFIRMED) so both paths apply the
 * exact same Inspector/Crew authority. Throws 409 on any ineligibility.
 */
export async function assertVisitResourceAdmission(
  tx: PoolClient, req: RequestScope, target: VisitResourceTarget,
): Promise<void> {
  if (target.kind === 'INSPECTION') {
    if (req.status !== 'INSPECTION_REQUIRED') throw conflict('Request is not awaiting onsite inspection.');
    const active = await tx.query(`SELECT id FROM users WHERE id=$1 AND status='ACTIVE'`, [target.resourceId]);
    // Apply the same exact Building + Client authority to the resource as to the
    // operator; a Building-only match is insufficient.
    if (!active.rows.length || !await canAccessBuildingScopedResource(target.resourceId, {
      clientId: req.clientId, buildingId: req.buildingId,
    })) {
      throw conflict('Proposed inspector is not an active user assigned to this building.');
    }
    if (!await findEligibleHandymanWorker(tx, {
      clientId: req.clientId, buildingId: req.buildingId, userId: target.resourceId, requireLogin: true,
    })) {
      throw conflict('Proposed inspector lacks active Handyman worker registration or building placement.');
    }
    // Inspector skill verification remains a confirmation prerequisite; no skill claim is made here.
    return;
  }
  const crewRows = await tx.query(`SELECT es.id FROM handyman_execution_scopes es
    JOIN handyman_execution_scope_assignments a ON a.execution_scope_id = es.id
      AND a.client_id=es.client_id AND a.status = 'ACTIVE' AND a.handyman_crew_id = $3
    JOIN handyman_work_crews c ON c.id = a.handyman_crew_id AND c.status = 'ACTIVE'
      AND c.client_id=es.client_id AND c.handyman_provider_context_id=a.handyman_provider_context_id
    WHERE es.id=$1 AND es.handyman_request_id=$2 AND es.client_id=$4
      AND es.status='AUTHORIZED'`, [target.executionScopeId, req.id, target.resourceId, req.clientId]);
  if (!crewRows.rows.length) throw conflict('No active authorized assignment for the proposed crew.');
  await assertHandymanCrewWorkerEligibility(tx, {
    clientId: req.clientId, buildingId: req.buildingId, crewId: target.resourceId,
  });
}
export async function readVisitProposals(requestId: string, actorId: string) {
  const db = getPool();
  const req = await requestScope(db, requestId);
  await scoped(actorId, req);
  const rows = await listHandymanVisitAppointments(db, req.clientId, req.id);
  // Existing recorded tenant coordination can be confirmed without API provisioning.
  // A configured tenant-choice producer is another availability signal, not a work permit.
  const enabled = rows.some(row => row.state === 'TENANT_SELECTED') ||
    await tenantSlotConsentAuthorityConfigured(db);
  // Existing preference/history stays separate from CONFIRMED visit dates.
  const schedulingReadiness = await getHandymanSchedulingReadiness(requestId, actorId);
  return {requestId, appointments: rows.map(encode), bookingEnabled: enabled, confirmationEnabled: enabled, schedulingReadiness};
}
export async function createVisitProposal(requestId: string, body: VisitProposalBody, actorId: string) {
  try {
    return await withTransaction(async tx => {
      const req = await requestScope(tx, requestId, true);
      await scoped(actorId, req);
      if (!req.timezone) throw conflict('Building timezone is not configured.');
      try { new Intl.DateTimeFormat('en', {timeZone: req.timezone}).format(new Date()); }
      catch { throw conflict('Building timezone is invalid.'); }
      await assertVisitResourceAdmission(tx, req, {
        kind: body.kind, resourceId: body.resourceId, executionScopeId: body.executionScopeId,
      });
      // A tenant-originated choice pending for this kind is authoritative for the time:
      // Operations matches an eligible resource to it and cannot move it.
      const pending = await findPendingTenantSlotChoice(tx, requestId, body.kind);
      const requested = body.kind === 'EXECUTION'
        ? await handymanSchedulingReadinessRepository.findActiveByRequest(tx, requestId) : null;
      // A coordinated tenant revision takes precedence over the original
      // preference; neither is overwritten. Inspection never borrows the
      // request's execution preference.
      const preferred = pending
        ? { startAt: pending.selectedStartAt.toISOString(), endAt: pending.selectedEndAt.toISOString() }
        : requested
          ? { startAt: requested.preferredWindowStart.toISOString(), endAt: requested.preferredWindowEnd.toISOString() }
          : null;
      if ((!body.startAt || !body.endAt) && !preferred) {
        throw conflict('No requested execution window is recorded. Reuse the existing request scheduling readiness; do not invent a date.');
      }
      const interval = parseVisitWindow(body.startAt ?? preferred?.startAt, body.endAt ?? preferred?.endAt);
      if (pending) assertProposalMatchesPendingChoice(pending, interval.startAt, interval.endAt);
      else if (requested && (!sameInstant(interval.startAt, requested.preferredWindowStart) ||
          !sameInstant(interval.endAt, requested.preferredWindowEnd))) {
        throw conflict('Execution proposal differs from the recorded requested window. Coordinate the revision with the tenant and preserve the existing scheduling history.');
      }
      const inserted = await insertHandymanVisitProposal(tx, {handymanRequestId: requestId,
        kind: body.kind, resourceId: body.resourceId, executionScopeId: body.executionScopeId,
        interval: {...interval, timezone: req.timezone}, createdByUserId: actorId});
      // Bind in the same transaction: PROPOSED → TENANT_SELECTED under the 0431 rules.
      let created: HandymanAppointmentRecord = inserted;
      if (pending) {
        const bound = await bindTenantSlotChoice(tx, {
          consentId: pending.id, appointmentId: inserted.id, clientId: req.clientId, requestId,
          kind: body.kind, appointmentVersion: inserted.version,
        });
        created = {...inserted, state: bound.state as HandymanAppointmentRecord['state'], version: bound.version};
      }
      await recordOperationalEvent({
        clientId: req.clientId, buildingId: req.buildingId, eventType: HANDYMAN_VISIT_PROPOSED,
        entityType: 'HANDYMAN_VISIT_APPOINTMENT', entityId: created.id, actorUserId: actorId,
        summary: pending
          ? `Handyman ${body.kind.toLowerCase()} visit proposed at the tenant-selected slot (TENANT_SELECTED; not confirmed).`
          : `Handyman ${body.kind.toLowerCase()} visit proposed (PROPOSED only; not confirmed).`,
        metadata: {handymanRequestId: requestId, kind: body.kind, resourceType: created.resourceType,
          resourceId: created.resourceId, executionScopeId: created.executionScopeId,
          startAt: created.startAt.toISOString(), endAt: created.endAt.toISOString(),
          state: created.state, version: created.version, tenantSlotConsentId: pending?.id ?? null,
          schedulingReadinessId: requested?.id ?? null},
      }, tx);
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
    await recordOperationalEvent({
      clientId: req.clientId, buildingId: req.buildingId, eventType: HANDYMAN_VISIT_PROPOSAL_CANCELLED,
      entityType: 'HANDYMAN_VISIT_APPOINTMENT', entityId: appointmentId, actorUserId: actorId,
      summary: 'Handyman visit proposal cancelled before any tenant selection or confirmation.',
      metadata: {handymanRequestId: requestId, state: 'CANCELLED', version: changed.rows[0].version},
    }, tx);
    return changed.rows[0];
  });
}
