import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanVisitPresenceRecord,
  HandymanVisitPresenceRecordedVia,
  HandymanVisitPresenceStatus,
  NewHandymanVisitPresence,
} from './handyman-visit-presence.types';

/**
 * CR-HM-BE-06 RUN 1 — crew presence snapshot persistence.
 *
 * The snapshot is INSERT-ONLY at VERIFIED-arrival time (one row per
 * visit+binding, structural UNIQUE — arbitrary bindings can never be added
 * later); the only mutation surface afterwards is the governed presence
 * mark (status + full recorder attribution). There is no delete.
 */

type Executor = Pick<PoolClient, 'query'>;

const PRESENCE_SELECT = `
  id,
  client_id                   AS "clientId",
  handyman_service_visit_id   AS "handymanServiceVisitId",
  handyman_visit_arrival_id   AS "handymanVisitArrivalId",
  handyman_job_assignment_id  AS "handymanJobAssignmentId",
  handyman_work_crew_id       AS "handymanWorkCrewId",
  vendor_workforce_binding_id AS "vendorWorkforceBindingId",
  crew_role                   AS "crewRole",
  presence_status             AS "presenceStatus",
  recorded_via                AS "recordedVia",
  recorded_by_user_id         AS "recordedByUserId",
  recorded_at                 AS "recordedAt",
  assisted_reason             AS "assistedReason",
  created_at                  AS "createdAt",
  updated_at                  AS "updatedAt"
`;

/**
 * Inserts the snapshot rows of one VERIFIED arrival. Runs in the SAME
 * transaction as the arrival insert: any failure here rolls the VERIFIED
 * arrival back with it (a VERIFIED arrival never survives without its
 * snapshot). A UNIQUE violation is structurally impossible under the visit
 * row lock and deliberately propagates (never guess).
 */
async function createSnapshot(
  rows: NewHandymanVisitPresence[],
  executor: Executor,
): Promise<HandymanVisitPresenceRecord[]> {
  if (rows.length === 0) {
    return [];
  }
  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const base = index * 8;
    values.push(
      randomUUID(),
      row.clientId,
      row.handymanServiceVisitId,
      row.handymanVisitArrivalId,
      row.handymanJobAssignmentId,
      row.handymanWorkCrewId,
      row.vendorWorkforceBindingId,
      row.crewRole,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  });
  const result = await executor.query<HandymanVisitPresenceRecord>(
    `INSERT INTO handyman_visit_presence
       (id, client_id, handyman_service_visit_id, handyman_visit_arrival_id,
        handyman_job_assignment_id, handyman_work_crew_id,
        vendor_workforce_binding_id, crew_role)
     VALUES ${placeholders.join(', ')}
     RETURNING ${PRESENCE_SELECT}`,
    values,
  );
  return result.rows;
}

async function listByVisitId(
  handymanServiceVisitId: string,
  executor: Executor = getPool(),
): Promise<HandymanVisitPresenceRecord[]> {
  const result = await executor.query<HandymanVisitPresenceRecord>(
    `SELECT ${PRESENCE_SELECT} FROM handyman_visit_presence
     WHERE handyman_service_visit_id = $1
     ORDER BY crew_role ASC, vendor_workforce_binding_id ASC`,
    [handymanServiceVisitId],
  );
  return result.rows;
}

async function findByVisitAndBinding(
  handymanServiceVisitId: string,
  vendorWorkforceBindingId: string,
  executor: Executor = getPool(),
): Promise<HandymanVisitPresenceRecord | null> {
  const result = await executor.query<HandymanVisitPresenceRecord>(
    `SELECT ${PRESENCE_SELECT} FROM handyman_visit_presence
     WHERE handyman_service_visit_id = $1
       AND vendor_workforce_binding_id = $2`,
    [handymanServiceVisitId, vendorWorkforceBindingId],
  );
  return result.rows[0] ?? null;
}

/** Locks one snapshot row (presence-mark serialization point). */
async function lockByVisitAndBinding(
  handymanServiceVisitId: string,
  vendorWorkforceBindingId: string,
  executor: Executor,
): Promise<HandymanVisitPresenceRecord | null> {
  const result = await executor.query<HandymanVisitPresenceRecord>(
    `SELECT ${PRESENCE_SELECT} FROM handyman_visit_presence
     WHERE handyman_service_visit_id = $1
       AND vendor_workforce_binding_id = $2
     FOR UPDATE`,
    [handymanServiceVisitId, vendorWorkforceBindingId],
  );
  return result.rows[0] ?? null;
}

/**
 * The governed presence mark: status + full attribution in one guarded
 * write. Snapshot identity columns (binding, role, composition, arrival)
 * are never mutable.
 */
async function markPresence(
  id: string,
  input: {
    presenceStatus: HandymanVisitPresenceStatus;
    recordedVia: HandymanVisitPresenceRecordedVia;
    recordedByUserId: string;
    assistedReason: string | null;
  },
  executor: Executor,
): Promise<HandymanVisitPresenceRecord | null> {
  const result = await executor.query<HandymanVisitPresenceRecord>(
    `UPDATE handyman_visit_presence
     SET presence_status = $2,
         recorded_via = $3,
         recorded_by_user_id = $4,
         recorded_at = NOW(),
         assisted_reason = $5,
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${PRESENCE_SELECT}`,
    [
      id,
      input.presenceStatus,
      input.recordedVia,
      input.recordedByUserId,
      input.assistedReason,
    ],
  );
  return result.rows[0] ?? null;
}

export const handymanVisitPresenceRepository = {
  createSnapshot,
  findByVisitAndBinding,
  listByVisitId,
  lockByVisitAndBinding,
  markPresence,
};
