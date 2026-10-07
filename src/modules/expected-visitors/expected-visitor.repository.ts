import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ExpectedVisitorListFilters,
  ExpectedVisitorRecord,
  ExpectedVisitorStatus,
  UpdateExpectedVisitorInput,
} from './expected-visitor.types';

/**
 * BE-13C — Expected Visitor repository.
 *
 * Holds front-desk expectation rows referencing the shared BE-13A
 * visitor identity and (optionally) the BE-13B invitation. All access
 * rules live in the service layer.
 */

type ExpectedVisitorRow = {
  id: string;
  client_id: string;
  building_id: string;
  visitor_id: string;
  visitor_invitation_id: string | null;
  host_user_id: string | null;
  host_workforce_id: string | null;
  host_name: string | null;
  expected_arrival_at: Date;
  expected_departure_at: Date | null;
  purpose: string;
  notes: string | null;
  status: ExpectedVisitorStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const EXPECTED_VISITOR_COLUMNS = `
  id, client_id, building_id, visitor_id, visitor_invitation_id,
  host_user_id, host_workforce_id, host_name,
  expected_arrival_at, expected_departure_at,
  purpose, notes, status,
  created_by_user_id, created_at, updated_at
`;

function mapRow(row: ExpectedVisitorRow): ExpectedVisitorRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitorId: row.visitor_id,
    visitorInvitationId: row.visitor_invitation_id,
    hostUserId: row.host_user_id,
    hostWorkforceId: row.host_workforce_id,
    hostName: row.host_name,
    expectedArrivalAt: row.expected_arrival_at,
    expectedDepartureAt: row.expected_departure_at,
    purpose: row.purpose,
    notes: row.notes,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateExpectedVisitorRow = {
  clientId: string;
  buildingId: string;
  visitorId: string;
  visitorInvitationId: string | null;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  expectedArrivalAt: string;
  expectedDepartureAt: string | null;
  purpose: string;
  notes: string | null;
  createdByUserId: string;
};

export async function create(
  input: CreateExpectedVisitorRow,
): Promise<ExpectedVisitorRecord> {
  const result = await getPool().query<ExpectedVisitorRow>(
    `INSERT INTO expected_visitors
       (id, client_id, building_id, visitor_id, visitor_invitation_id,
        host_user_id, host_workforce_id, host_name,
        expected_arrival_at, expected_departure_at,
        purpose, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${EXPECTED_VISITOR_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.visitorId,
      input.visitorInvitationId,
      input.hostUserId,
      input.hostWorkforceId,
      input.hostName,
      input.expectedArrivalAt,
      input.expectedDepartureAt,
      input.purpose,
      input.notes,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<ExpectedVisitorRecord | null> {
  const result = await getPool().query<ExpectedVisitorRow>(
    `SELECT ${EXPECTED_VISITOR_COLUMNS}
     FROM expected_visitors WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** The non-cancelled expectation for an invitation (at most one). */
export async function findActiveByInvitation(
  visitorInvitationId: string,
): Promise<ExpectedVisitorRecord | null> {
  const result = await getPool().query<ExpectedVisitorRow>(
    `SELECT ${EXPECTED_VISITOR_COLUMNS}
     FROM expected_visitors
     WHERE visitor_invitation_id = $1
       AND status = 'EXPECTED'`,
    [visitorInvitationId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: ExpectedVisitorListFilters = {},
): Promise<ExpectedVisitorRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filter.visitorId) {
    values.push(filter.visitorId);
    conditions.push(`visitor_id = $${values.length}`);
  }
  if (filter.visitorInvitationId) {
    values.push(filter.visitorInvitationId);
    conditions.push(`visitor_invitation_id = $${values.length}`);
  }
  if (filter.hostUserId) {
    values.push(filter.hostUserId);
    conditions.push(`host_user_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.expectedFrom) {
    values.push(filter.expectedFrom);
    conditions.push(`expected_arrival_at >= $${values.length}`);
  }
  if (filter.expectedTo) {
    values.push(filter.expectedTo);
    conditions.push(`expected_arrival_at <= $${values.length}`);
  }

  const result = await getPool().query<ExpectedVisitorRow>(
    `SELECT ${EXPECTED_VISITOR_COLUMNS}
     FROM expected_visitors
     WHERE ${conditions.join(' AND ')}
     ORDER BY expected_arrival_at ASC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateExpectedVisitorInput & { status?: ExpectedVisitorStatus },
): Promise<ExpectedVisitorRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.hostUserId !== undefined) {
    values.push(input.hostUserId);
    sets.push(`host_user_id = $${values.length}`);
  }
  if (input.hostWorkforceId !== undefined) {
    values.push(input.hostWorkforceId);
    sets.push(`host_workforce_id = $${values.length}`);
  }
  if (input.hostName !== undefined) {
    values.push(input.hostName);
    sets.push(`host_name = $${values.length}`);
  }
  if (input.expectedArrivalAt !== undefined) {
    values.push(input.expectedArrivalAt);
    sets.push(`expected_arrival_at = $${values.length}`);
  }
  if (input.expectedDepartureAt !== undefined) {
    values.push(input.expectedDepartureAt);
    sets.push(`expected_departure_at = $${values.length}`);
  }
  if (input.purpose !== undefined) {
    values.push(input.purpose);
    sets.push(`purpose = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<ExpectedVisitorRow>(
    `UPDATE expected_visitors
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${EXPECTED_VISITOR_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const expectedVisitorRepository = {
  create,
  findActiveByInvitation,
  findById,
  listByBuildingIds,
  update,
};
