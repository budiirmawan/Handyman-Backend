import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateVisitorInvitationInput,
  UpdateVisitorInvitationInput,
  VisitorInvitationListFilters,
  VisitorInvitationRecord,
  VisitorInvitationStatus,
} from './visitor-invitation.types';

/**
 * BE-13B — Visitor Invitation repository.
 *
 * Holds visit-planning rows referencing the shared BE-13A visitor
 * identity master. All access rules live in the service layer.
 */

type VisitorInvitationRow = {
  id: string;
  client_id: string;
  building_id: string;
  visitor_id: string;
  host_user_id: string | null;
  host_workforce_id: string | null;
  host_name: string | null;
  expected_arrival_at: Date;
  expected_departure_at: Date | null;
  purpose: string;
  notes: string | null;
  status: VisitorInvitationStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const VISITOR_INVITATION_COLUMNS = `
  id, client_id, building_id, visitor_id,
  host_user_id, host_workforce_id, host_name,
  expected_arrival_at, expected_departure_at,
  purpose, notes, status,
  created_by_user_id, created_at, updated_at
`;

function mapRow(row: VisitorInvitationRow): VisitorInvitationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitorId: row.visitor_id,
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

export async function create(
  input: CreateVisitorInvitationInput & { clientId: string },
): Promise<VisitorInvitationRecord> {
  const result = await getPool().query<VisitorInvitationRow>(
    `INSERT INTO visitor_invitations
       (id, client_id, building_id, visitor_id,
        host_user_id, host_workforce_id, host_name,
        expected_arrival_at, expected_departure_at,
        purpose, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${VISITOR_INVITATION_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.visitorId,
      input.hostUserId ?? null,
      input.hostWorkforceId ?? null,
      input.hostName ?? null,
      input.expectedArrivalAt,
      input.expectedDepartureAt ?? null,
      input.purpose,
      input.notes ?? null,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<VisitorInvitationRecord | null> {
  const result = await getPool().query<VisitorInvitationRow>(
    `SELECT ${VISITOR_INVITATION_COLUMNS}
     FROM visitor_invitations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: VisitorInvitationListFilters = {},
): Promise<VisitorInvitationRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filter.visitorId) {
    values.push(filter.visitorId);
    conditions.push(`visitor_id = $${values.length}`);
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

  const result = await getPool().query<VisitorInvitationRow>(
    `SELECT ${VISITOR_INVITATION_COLUMNS}
     FROM visitor_invitations
     WHERE ${conditions.join(' AND ')}
     ORDER BY expected_arrival_at ASC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateVisitorInvitationInput & {
    status?: VisitorInvitationStatus;
  },
): Promise<VisitorInvitationRecord | null> {
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
  const result = await getPool().query<VisitorInvitationRow>(
    `UPDATE visitor_invitations
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${VISITOR_INVITATION_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const visitorInvitationRepository = {
  create,
  findById,
  listByBuildingIds,
  update,
};
