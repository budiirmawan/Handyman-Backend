import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { sameInstant } from './handyman-tenant-slot-assertion';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2A — tenant slot consent binding.
 *
 * A tenant-originated slot choice is REQUEST-level consent. It names no
 * appointment. It is bound to exactly one PROPOSED appointment of the same
 * request and kind, with the exact slot, and the binding moves that visit to
 * TENANT_SELECTED under the existing 0431 transition rules. Operations cannot
 * change the tenant's time: a proposal must match the pending choice exactly.
 *
 * Every write here runs inside the caller's transaction, after the request row
 * is locked, so ingest and proposal serialize on the same request.
 */

export function choiceConflict(message: string): AppError {
  return new AppError({code: ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT, message, statusCode: 409});
}
export function stateConflict(message: string): AppError {
  return new AppError({code: ERROR_CODES.HANDYMAN_VISIT_STATE_CONFLICT, message, statusCode: 409});
}

export type PendingTenantSlotChoice = {
  id: string;
  kind: 'INSPECTION' | 'EXECUTION';
  selectedStartAt: Date;
  selectedEndAt: Date;
  tenantCompanyId: string;
  buildingId: string;
};

/** The newest consent for this request+kind that has no binding yet, if any. */
export async function findPendingTenantSlotChoice(
  tx: Pick<PoolClient, 'query'>, requestId: string, kind: string,
): Promise<PendingTenantSlotChoice | null> {
  const result = await tx.query<PendingTenantSlotChoice>(
    `SELECT c.id, c.kind, c.selected_start_at AS "selectedStartAt", c.selected_end_at AS "selectedEndAt",
            c.tenant_company_id AS "tenantCompanyId", c.building_id AS "buildingId"
       FROM handyman_visit_tenant_slot_consents c
      WHERE c.handyman_request_id = $1 AND c.kind = $2
        AND NOT EXISTS (SELECT 1 FROM handyman_visit_tenant_slot_bindings b WHERE b.consent_id = c.id)
      ORDER BY c.accepted_at DESC LIMIT 1`,
    [requestId, kind],
  );
  return result.rows[0] ?? null;
}

/** A pending choice must be matched by the proposal exactly; Operations cannot move it. */
export function assertProposalMatchesPendingChoice(
  pending: PendingTenantSlotChoice, startAt: string, endAt: string,
): void {
  if (!sameInstant(startAt, pending.selectedStartAt) || !sameInstant(endAt, pending.selectedEndAt)) {
    throw choiceConflict('The tenant has selected a different slot. The proposal must use the tenant-selected slot.');
  }
}

export type BoundVisit = {
  id: string;
  version: number;
  state: string;
};

/**
 * Bind a consent to a PROPOSED appointment and move it to TENANT_SELECTED.
 * The binding guard checks the slot and scope; the 0431 transition guard checks
 * the state change; the deferred commit guard checks the evidence reference.
 */
export async function bindTenantSlotChoice(
  tx: Pick<PoolClient, 'query'>,
  input: {consentId: string; appointmentId: string; clientId: string; requestId: string;
    kind: 'INSPECTION' | 'EXECUTION'; appointmentVersion: number},
): Promise<BoundVisit> {
  await tx.query(
    `INSERT INTO handyman_visit_tenant_slot_bindings
       (consent_id, appointment_id, handyman_request_id, client_id, kind, appointment_version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.consentId, input.appointmentId, input.requestId, input.clientId, input.kind, input.appointmentVersion],
  );
  const moved = await tx.query<{id: string; version: number; state: string}>(
    `UPDATE handyman_visit_appointments
        SET state = 'TENANT_SELECTED', tenant_choice_evidence_ref = $2,
            version = version + 1, updated_at = NOW()
      WHERE id = $1 AND version = $3 AND state = 'PROPOSED'
      RETURNING id, version, state`,
    [input.appointmentId, input.consentId, input.appointmentVersion],
  );
  if (moved.rowCount !== 1) throw stateConflict('Visit changed while binding the tenant slot choice.');
  return moved.rows[0];
}

/** Map one-time-use and guard violations on consent/binding inserts to stable errors. */
export function mapTenantSlotWriteError(error: unknown, replayed: () => AppError): never {
  const candidate = error as {code?: string; constraint?: string};
  if (candidate.code === '23505') {
    if (candidate.constraint === 'handyman_visit_consents_jti_unique' ||
        candidate.constraint === 'handyman_visit_consents_evidence_unique') throw replayed();
    if (candidate.constraint === 'handyman_visit_tenant_slot_bindings_pkey' ||
        candidate.constraint === 'handyman_visit_tenant_slot_bindings_appointment_id_key') {
      throw choiceConflict('This visit is already bound to a tenant slot choice.');
    }
  }
  if (candidate.code === '23514') {
    throw choiceConflict('The tenant slot choice does not match the request or visit state.');
  }
  throw error;
}
