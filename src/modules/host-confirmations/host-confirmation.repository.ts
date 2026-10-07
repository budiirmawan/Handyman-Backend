import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HostConfirmationListFilters,
  HostConfirmationRecord,
  HostConfirmationStatus,
} from './host-confirmation.types';

/**
 * BE-13F — Host / Tenant Confirmation repository.
 *
 * One confirmation row per visit context (Expected Visitor or Walk-In
 * entry). All access rules live in the service layer.
 */

type HostConfirmationRow = {
  id: string;
  client_id: string;
  building_id: string;
  expected_visitor_id: string | null;
  walk_in_visit_id: string | null;
  host_user_id: string | null;
  host_workforce_id: string | null;
  host_name: string | null;
  status: HostConfirmationStatus;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | null;
  rejection_reason: string | null;
  notes: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const HOST_CONFIRMATION_COLUMNS = `
  id, client_id, building_id, expected_visitor_id, walk_in_visit_id,
  host_user_id, host_workforce_id, host_name,
  status, confirmed_by_user_id, confirmed_at, rejection_reason, notes,
  created_by_user_id, created_at, updated_at
`;

function mapRow(row: HostConfirmationRow): HostConfirmationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    expectedVisitorId: row.expected_visitor_id,
    walkInVisitId: row.walk_in_visit_id,
    hostUserId: row.host_user_id,
    hostWorkforceId: row.host_workforce_id,
    hostName: row.host_name,
    status: row.status,
    confirmedByUserId: row.confirmed_by_user_id,
    confirmedAt: row.confirmed_at,
    rejectionReason: row.rejection_reason,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateHostConfirmationRow = {
  clientId: string;
  buildingId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  notes: string | null;
  createdByUserId: string;
};

export async function create(
  input: CreateHostConfirmationRow,
): Promise<HostConfirmationRecord> {
  const result = await getPool().query<HostConfirmationRow>(
    `INSERT INTO host_confirmations
       (id, client_id, building_id, expected_visitor_id, walk_in_visit_id,
        host_user_id, host_workforce_id, host_name, notes,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${HOST_CONFIRMATION_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.expectedVisitorId,
      input.walkInVisitId,
      input.hostUserId,
      input.hostWorkforceId,
      input.hostName,
      input.notes,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<HostConfirmationRecord | null> {
  const result = await getPool().query<HostConfirmationRow>(
    `SELECT ${HOST_CONFIRMATION_COLUMNS}
     FROM host_confirmations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByExpectedVisitor(
  expectedVisitorId: string,
): Promise<HostConfirmationRecord | null> {
  const result = await getPool().query<HostConfirmationRow>(
    `SELECT ${HOST_CONFIRMATION_COLUMNS}
     FROM host_confirmations WHERE expected_visitor_id = $1`,
    [expectedVisitorId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByWalkInVisit(
  walkInVisitId: string,
): Promise<HostConfirmationRecord | null> {
  const result = await getPool().query<HostConfirmationRow>(
    `SELECT ${HOST_CONFIRMATION_COLUMNS}
     FROM host_confirmations WHERE walk_in_visit_id = $1`,
    [walkInVisitId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: HostConfirmationListFilters = {},
): Promise<HostConfirmationRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filter.expectedVisitorId) {
    values.push(filter.expectedVisitorId);
    conditions.push(`expected_visitor_id = $${values.length}`);
  }
  if (filter.walkInVisitId) {
    values.push(filter.walkInVisitId);
    conditions.push(`walk_in_visit_id = $${values.length}`);
  }
  if (filter.hostUserId) {
    values.push(filter.hostUserId);
    conditions.push(`host_user_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<HostConfirmationRow>(
    `SELECT ${HOST_CONFIRMATION_COLUMNS}
     FROM host_confirmations
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

/**
 * Applies the single decision atomically: only a PENDING row can be
 * decided (guarded in the WHERE clause so concurrent decisions cannot
 * both win).
 */
export async function decide(
  id: string,
  decision: {
    status: 'CONFIRMED' | 'REJECTED';
    confirmedByUserId: string;
    rejectionReason: string | null;
    notes?: string | null;
  },
): Promise<HostConfirmationRecord | null> {
  const sets = [
    `status = $1`,
    `confirmed_by_user_id = $2`,
    `confirmed_at = NOW()`,
    `rejection_reason = $3`,
    `updated_at = NOW()`,
  ];
  const values: unknown[] = [
    decision.status,
    decision.confirmedByUserId,
    decision.rejectionReason,
  ];

  if (decision.notes !== undefined) {
    values.push(decision.notes);
    sets.push(`notes = $${values.length}`);
  }

  values.push(id);
  const result = await getPool().query<HostConfirmationRow>(
    `UPDATE host_confirmations
     SET ${sets.join(', ')}
     WHERE id = $${values.length} AND status = 'PENDING'
     RETURNING ${HOST_CONFIRMATION_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const hostConfirmationRepository = {
  create,
  decide,
  findByExpectedVisitor,
  findById,
  findByWalkInVisit,
  listByBuildingIds,
};
