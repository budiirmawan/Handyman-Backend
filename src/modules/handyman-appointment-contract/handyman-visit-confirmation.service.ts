import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { recordOperationalEvent } from '../operational-events';
import { assertWarrantyReworkOperations } from '../handyman-service-warranty-reworks/handyman-warranty-rework-authority';
import { assertReworkVisitCurrent } from './handyman-warranty-rework-visit.service';
import {
  assertVisitResourceAdmission,
  encode,
  requestScope,
  scoped,
  type VisitResourceTarget,
} from './handyman-visit-api.service';
import type { HandymanAppointmentRecord } from './handyman-appointment.repository';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — atomic booking confirmation (Operations).
 *
 * TENANT_SELECTED → CONFIRMED only when ALL of the following hold in ONE
 * transaction: the operator is
 * scoped to the exact request Building + Client; the row-locked visit is at the
 * exact TENANT_SELECTED version; its consent provenance exists and matches;
 * the Inspector/Crew is still eligible under the shared admission authority;
 * the visit is still in the future; and the capacity reservation is inserted.
 * The 0431 exclusion constraint serialises overlapping capacity and maps to 409.
 * The deferred DB guards then require the reservation to commit with CONFIRMED.
 *
 * Idempotent replay: a repeat call at version+1 on an already-CONFIRMED visit
 * returns the current record without a second reservation or audit row.
 */

export const HANDYMAN_VISIT_CONFIRMED = 'HANDYMAN_VISIT_CONFIRMED';

export type VisitConfirmationPorts = {
  admitResource: (tx: PoolClient, req: Awaited<ReturnType<typeof requestScope>>, target: VisitResourceTarget) => Promise<void>;
  /** Legacy injection retained for callers; API provisioning is not booking authority. */
  authorityConfigured?: () => Promise<boolean>;
  scope: (actorId: string, req: Awaited<ReturnType<typeof requestScope>>) => Promise<void>;
};
export const defaultVisitConfirmationPorts: VisitConfirmationPorts = {
  admitResource: assertVisitResourceAdmission,
  scope: scoped,
};

type LockedAppointment = HandymanAppointmentRecord & { evidenceRef: string | null; reworkId: string | null };

const APPOINTMENT_COLUMNS = `a.id, a.client_id AS "clientId", a.handyman_request_id AS "handymanRequestId",
  a.tenant_company_id AS "tenantCompanyId", a.building_id AS "buildingId", a.kind,
  a.execution_scope_id AS "executionScopeId", a.resource_type AS "resourceType",
  a.resource_id AS "resourceId", a.start_at AS "startAt", a.end_at AS "endAt",
  a.timezone, a.state, a.version`;
const LOCKED_COLUMNS = `${APPOINTMENT_COLUMNS}, a.tenant_choice_evidence_ref AS "evidenceRef", a.warranty_rework_id AS "reworkId"`;

export async function confirmTenantSlotVisit(
  requestId: string,
  appointmentId: string,
  version: number,
  actorId: string,
  ports: VisitConfirmationPorts = defaultVisitConfirmationPorts,
): Promise<ReturnType<typeof encode> & { replayed: boolean }> {
  // Authority is the exact stored tenant choice, not whether a BM API/secret
  // happens to be configured now. No preference becomes consent here: the
  // state/version/provenance, eligibility and atomic capacity guards below
  // remain mandatory, including when coordinating outside the platform.

  return withTransaction(async (tx: PoolClient) => {
    const req = await requestScope(tx, requestId, true);
    await ports.scope(actorId, req);

    const locked = (await tx.query<LockedAppointment>(
      `SELECT ${LOCKED_COLUMNS} FROM handyman_visit_appointments a
        WHERE a.id = $1 AND a.handyman_request_id = $2 AND a.client_id = $3 FOR UPDATE`,
      [appointmentId, req.id, req.clientId],
    )).rows[0];
    if (!locked) throw AppError.notFound('Visit appointment not found.');
    if (locked.reworkId) {
      const {ctx}=await assertReworkVisitCurrent(tx,locked.id,actorId);
      await assertWarrantyReworkOperations(tx,{clientId:ctx.client_id,buildingId:ctx.building_id,
        handymanRequestId:ctx.handyman_request_id},actorId);
    }

    // Idempotent replay of an already-applied confirmation for the same version.
    if (locked.state === 'CONFIRMED' && locked.version === version + 1) {
      const current = (await tx.query<HandymanAppointmentRecord>(
        `SELECT ${APPOINTMENT_COLUMNS} FROM handyman_visit_appointments a WHERE a.id = $1`, [locked.id],
      )).rows[0];
      return { ...encode(current), replayed: true };
    }
    if (locked.state !== 'TENANT_SELECTED' || locked.version !== version) {
      throw new AppError({
        code: ERROR_CODES.HANDYMAN_VISIT_STATE_CONFLICT,
        message: 'Only the current TENANT_SELECTED visit version can be confirmed. Reload before retry.',
        statusCode: 409,
      });
    }
    if (locked.startAt.getTime() <= Date.now()) {
      throw new AppError({code: ERROR_CODES.HANDYMAN_VISIT_STATE_CONFLICT,
        message: 'The selected slot has already started and cannot be confirmed.', statusCode: 409});
    }

    // Consent provenance must be the consent bound to this exact visit, at the PROPOSED version.
    const consent = locked.reworkId
      ? (await tx.query<{id:string}>(`SELECT id FROM handyman_warranty_rework_visit_consents
          WHERE appointment_id=$1 AND id::text=$2 AND appointment_version=$3
            AND rework_id=$4 AND execution_scope_id=$5 AND start_at=$6 AND end_at=$7`,
          [locked.id,locked.evidenceRef,locked.version-1,locked.reworkId,locked.executionScopeId,locked.startAt,locked.endAt])).rows[0]
      : (await tx.query<{ id: string }>(
          `SELECT c.id FROM handyman_visit_tenant_slot_bindings b
             JOIN handyman_visit_tenant_slot_consents c ON c.id = b.consent_id
            WHERE b.appointment_id = $1 AND c.id::text = $2 AND b.appointment_version = $3`,
          [locked.id, locked.evidenceRef, locked.version - 1],
        )).rows[0];
    if (!consent) {
      throw new AppError({
        code: ERROR_CODES.HANDYMAN_VISIT_SLOT_CONSENT_MISSING,
        message: 'Verified tenant slot consent is missing for this visit.',
        statusCode: 409,
      });
    }

    // Live eligibility of the resource under the same authority as proposal.
    await ports.admitResource(tx, req, {
      kind: locked.kind,
      resourceId: locked.resourceId,
      executionScopeId: locked.executionScopeId,
    });

    const confirmed = await tx.query(
      `UPDATE handyman_visit_appointments
          SET state = 'CONFIRMED', confirmed_by_user_id = $2, confirmed_at = NOW(),
              version = version + 1, updated_at = NOW()
        WHERE id = $1 AND version = $3 AND state = 'TENANT_SELECTED'`,
      [locked.id, actorId, locked.version],
    );
    if (confirmed.rowCount !== 1) throw new AppError({code: ERROR_CODES.HANDYMAN_VISIT_STATE_CONFLICT,
      message: 'Visit changed during confirmation. Reload before retry.', statusCode: 409});

    // Atomic capacity reservation. The exclusion constraint serialises overlaps.
    try {
      await tx.query(
        `INSERT INTO handyman_visit_capacity_reservations
           (id, appointment_id, client_id, resource_type, resource_id, start_at, end_at, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
        [randomUUID(), locked.id, locked.clientId, locked.resourceType, locked.resourceId,
          locked.startAt, locked.endAt],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23P01') {
        throw new AppError({
          code: ERROR_CODES.HANDYMAN_VISIT_CAPACITY_CONFLICT,
          message: 'The resource is already reserved for an overlapping visit.',
          statusCode: 409,
        });
      }
      throw error;
    }

    const after = (await tx.query<HandymanAppointmentRecord>(
      `SELECT ${APPOINTMENT_COLUMNS} FROM handyman_visit_appointments a WHERE a.id = $1`,
      [locked.id],
    )).rows[0];

    await recordOperationalEvent({
      clientId: locked.clientId, buildingId: locked.buildingId, eventType: HANDYMAN_VISIT_CONFIRMED,
      entityType: 'HANDYMAN_VISIT_APPOINTMENT', entityId: locked.id, actorUserId: actorId,
      summary: 'Handyman visit confirmed from verified tenant slot consent with atomic capacity reservation.',
      metadata: {
        handymanRequestId: locked.handymanRequestId, kind: locked.kind, resourceType: locked.resourceType,
        resourceId: locked.resourceId, consentId: consent.id, appointmentVersion: locked.version,
        newVersion: locked.version + 1, startAt: locked.startAt.toISOString(), endAt: locked.endAt.toISOString(),
      },
    }, tx);

    return { ...encode(after), replayed: false };
  });
}
