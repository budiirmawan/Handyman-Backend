import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  HandymanAppointmentKind,
  HandymanAppointmentInterval,
  HandymanVisitAttemptOutcome,
} from './handyman-appointment-core';

/**
 * R1B transaction-bound persistence adapter, NOT a public API.
 * All callers MUST acquire server-verified request/building authorization
 * and eligibility first. No code in this module can confirm a booking,
 * reserve capacity, or spoof tenant assent. That wiring awaits an approved
 * authenticated tenant choice authority. The migration guards structural
 * scope; application RBAC must never be inferred from FKs.
 */

export type HandymanAppointmentRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  tenantCompanyId: string;
  buildingId: string;
  kind: HandymanAppointmentKind;
  executionScopeId: string | null;
  resourceType: 'INSPECTOR_USER' | 'CREW';
  resourceId: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  state: 'PROPOSED' | 'TENANT_SELECTED' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  version: number;
};

export type NewHandymanVisitProposal = {
  handymanRequestId: string;
  kind: HandymanAppointmentKind;
  resourceId: string;
  interval: HandymanAppointmentInterval;
  executionScopeId?: string | null;
  createdByUserId: string;
  warrantyReworkKey?: string | null;
  supersedesAppointmentId?: string | null;
};

const SELECT = `id, client_id AS "clientId", handyman_request_id AS "handymanRequestId",
  tenant_company_id AS "tenantCompanyId", building_id AS "buildingId",
  kind, execution_scope_id AS "executionScopeId",
  resource_type AS "resourceType", resource_id AS "resourceId",
  start_at AS "startAt", end_at AS "endAt", timezone, state, version`;

/** Proposal only: rows in this state cannot reserve capacity. */
export async function insertHandymanVisitProposal(
  tx: Pick<PoolClient, 'query'>,
  input: NewHandymanVisitProposal,
): Promise<HandymanAppointmentRecord> {
  if (input.kind !== 'INSPECTION' && input.kind !== 'EXECUTION') {
    throw new Error('INVALID_APPOINTMENT_KIND');
  }
  if ((input.kind === 'EXECUTION') !== Boolean(input.executionScopeId)) {
    throw new Error('APPOINTMENT_SCOPE_KIND_MISMATCH');
  }
  const request = await tx.query<{
    clientId: string; buildingId: string; tenantCompanyId: string;
  }>(`SELECT client_id AS "clientId", building_id AS "buildingId",
          tenant_company_id AS "tenantCompanyId"
         FROM handyman_service_requests WHERE id = $1 FOR UPDATE`,
  [input.handymanRequestId]);
  if (!request.rows[0]) throw new Error('HANDYMAN_REQUEST_NOT_FOUND');
  const parent = request.rows[0];
  const result = await tx.query<HandymanAppointmentRecord>(`
    INSERT INTO handyman_visit_appointments
      (id, client_id, handyman_request_id, tenant_company_id, building_id,
       kind, execution_scope_id, resource_type, resource_id, start_at,
       end_at, timezone, state, created_by_user_id, warranty_rework_key, supersedes_appointment_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PROPOSED', $13, $14, $15)
    RETURNING ${SELECT}`,
    [randomUUID(), parent.clientId, input.handymanRequestId,
      parent.tenantCompanyId, parent.buildingId, input.kind,
      input.executionScopeId ?? null,
      input.kind === 'INSPECTION' ? 'INSPECTOR_USER' : 'CREW',
      input.resourceId, input.interval.startAt, input.interval.endAt,
      input.interval.timezone, input.createdByUserId, input.warrantyReworkKey ?? null, input.supersedesAppointmentId ?? null]);
  return result.rows[0];
}

/** Scoped internal read; the service MUST authorize the actor first. */
export async function listHandymanVisitAppointments(
  tx: Pick<PoolClient, 'query'>,
  clientId: string,
  handymanRequestId: string,
): Promise<HandymanAppointmentRecord[]> {
  const result = await tx.query<HandymanAppointmentRecord>(`
    SELECT ${SELECT} FROM handyman_visit_appointments
    WHERE client_id = $1 AND handyman_request_id = $2
    ORDER BY created_at DESC, id DESC`, [clientId, handymanRequestId]);
  return result.rows;
}

/**
 * Internal append primitive; caller MUST verify the actual assigned inspector
 * or Crew and effective permit/site access first. A NO_SHOW or blocked attempt
 * is never an insertion into frozen handyman_request_inspections.
 */
export async function appendHandymanVisitAttempt(
  tx: Pick<PoolClient, 'query'>,
  input: {
    appointmentId: string;
    actorUserId: string;
    outcome: HandymanVisitAttemptOutcome;
    idempotencyKey: string;
    evidenceReference?: string | null;
    reason?: string | null;
  },
): Promise<{ id: string; outcome: HandymanVisitAttemptOutcome; reused: boolean }> {
  const inserted = await tx.query<{ id: string; outcome: HandymanVisitAttemptOutcome }>(`
    INSERT INTO handyman_visit_attempts
      (id, appointment_id, actor_user_id, outcome, evidence_reference, reason, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (appointment_id, idempotency_key) DO NOTHING
    RETURNING id, outcome`, [randomUUID(), input.appointmentId,
    input.actorUserId, input.outcome, input.evidenceReference ?? null,
    input.reason ?? null, input.idempotencyKey]);
  if (inserted.rows[0]) return { ...inserted.rows[0], reused: false };

  const previous = await tx.query<{
    id: string; outcome: HandymanVisitAttemptOutcome; actorUserId: string;
    evidenceReference: string | null; reason: string | null;
  }>(`SELECT id, outcome, actor_user_id AS "actorUserId",
          evidence_reference AS "evidenceReference", reason
        FROM handyman_visit_attempts
        WHERE appointment_id = $1 AND idempotency_key = $2`,
  [input.appointmentId, input.idempotencyKey]);
  const row = previous.rows[0];
  if (!row || row.outcome !== input.outcome || row.actorUserId !== input.actorUserId ||
      row.evidenceReference !== (input.evidenceReference ?? null) ||
      row.reason !== (input.reason ?? null)) {
    throw new Error('HANDYMAN_VISIT_IDEMPOTENCY_CONFLICT');
  }
  return { id: row.id, outcome: row.outcome, reused: true };
}
