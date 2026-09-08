import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateSecurityLostFoundInput,
  SecurityLostFoundHistoryEventType,
  SecurityLostFoundHistoryRecord,
  SecurityLostFoundListFilters,
  SecurityLostFoundRecord,
  SecurityLostFoundStatus,
  UpdateSecurityLostFoundInput,
} from './security-lost-found.types';

/**
 * BE-12L — Security Lost & Found repository.
 *
 * Holds the Lost & Found master row and the append-oriented history.
 * The master row's `custody_status` is updated in place as custody /
 * claim / return events occur; history rows are NEVER updated or
 * deleted — they are append-only event records.
 */

type SecurityLostFoundRow = {
  id: string;
  client_id: string;
  building_id: string;
  security_post_id: string | null;
  functional_location_id: string | null;
  item_code: string;
  item_name: string;
  description: string | null;
  found_at: Date;
  found_by_user_id: string;
  custody_status: SecurityLostFoundStatus;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

const SECURITY_LOST_FOUND_COLUMNS = `
  id, client_id, building_id, security_post_id, functional_location_id,
  item_code, item_name, description, found_at, found_by_user_id,
  custody_status, notes, created_at, updated_at
`;

function mapRow(row: SecurityLostFoundRow): SecurityLostFoundRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    securityPostId: row.security_post_id,
    functionalLocationId: row.functional_location_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    description: row.description,
    foundAt: row.found_at,
    foundByUserId: row.found_by_user_id,
    custodyStatus: row.custody_status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type SecurityLostFoundHistoryRow = {
  id: string;
  lost_found_id: string;
  event_type: SecurityLostFoundHistoryEventType;
  claimant_name: string | null;
  claimant_reference: string | null;
  claim_notes: string | null;
  verified_by_user_id: string | null;
  returned_by_user_id: string | null;
  returned_at: Date | null;
  occurred_at: Date;
  notes: string | null;
  created_at: Date;
};

const SECURITY_LOST_FOUND_HISTORY_COLUMNS = `
  id, lost_found_id, event_type, claimant_name, claimant_reference,
  claim_notes, verified_by_user_id, returned_by_user_id, returned_at,
  occurred_at, notes, created_at
`;

function mapHistoryRow(
  row: SecurityLostFoundHistoryRow,
): SecurityLostFoundHistoryRecord {
  return {
    id: row.id,
    lostFoundId: row.lost_found_id,
    eventType: row.event_type,
    claimantName: row.claimant_name,
    claimantReference: row.claimant_reference,
    claimNotes: row.claim_notes,
    verifiedByUserId: row.verified_by_user_id,
    returnedByUserId: row.returned_by_user_id,
    returnedAt: row.returned_at,
    occurredAt: row.occurred_at,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/*  Master CRUD                                                        */
/* ------------------------------------------------------------------ */

export async function create(
  input: CreateSecurityLostFoundInput & { clientId: string },
): Promise<SecurityLostFoundRecord> {
  const result = await getPool().query<SecurityLostFoundRow>(
    `INSERT INTO security_lost_found
       (id, client_id, building_id, security_post_id, functional_location_id,
        item_code, item_name, description, found_at, found_by_user_id,
        custody_status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'FOUND', $11)
     RETURNING ${SECURITY_LOST_FOUND_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.securityPostId ?? null,
      input.functionalLocationId ?? null,
      input.itemCode,
      input.itemName,
      input.description ?? null,
      input.foundAt ? new Date(input.foundAt) : new Date(),
      input.foundByUserId,
      input.notes ?? null,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SecurityLostFoundRecord | null> {
  const result = await getPool().query<SecurityLostFoundRow>(
    `SELECT ${SECURITY_LOST_FOUND_COLUMNS}
     FROM security_lost_found WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByBuildingAndItemCode(
  buildingId: string,
  itemCode: string,
): Promise<SecurityLostFoundRecord | null> {
  const result = await getPool().query<SecurityLostFoundRow>(
    `SELECT ${SECURITY_LOST_FOUND_COLUMNS}
     FROM security_lost_found WHERE building_id = $1 AND item_code = $2`,
    [buildingId, itemCode],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: SecurityLostFoundListFilters = {},
): Promise<SecurityLostFoundRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`security_post_id = $${values.length}`);
  }
  if (filter.custodyStatus) {
    values.push(filter.custodyStatus);
    conditions.push(`custody_status = $${values.length}`);
  }
  if (filter.fromDate) {
    values.push(new Date(filter.fromDate));
    conditions.push(`found_at >= $${values.length}`);
  }
  if (filter.toDate) {
    values.push(new Date(filter.toDate));
    conditions.push(`found_at <= $${values.length}`);
  }

  const result = await getPool().query<SecurityLostFoundRow>(
    `SELECT ${SECURITY_LOST_FOUND_COLUMNS}
     FROM security_lost_found
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY found_at DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: SecurityLostFoundListFilters = {},
): Promise<SecurityLostFoundRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = [`building_id = ANY($1::uuid[])`];
  const values: unknown[] = [buildingIds];

  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`security_post_id = $${values.length}`);
  }
  if (filter.custodyStatus) {
    values.push(filter.custodyStatus);
    conditions.push(`custody_status = $${values.length}`);
  }
  if (filter.fromDate) {
    values.push(new Date(filter.fromDate));
    conditions.push(`found_at >= $${values.length}`);
  }
  if (filter.toDate) {
    values.push(new Date(filter.toDate));
    conditions.push(`found_at <= $${values.length}`);
  }

  const result = await getPool().query<SecurityLostFoundRow>(
    `SELECT ${SECURITY_LOST_FOUND_COLUMNS}
     FROM security_lost_found
     WHERE ${conditions.join(' AND ')}
     ORDER BY found_at DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateSecurityLostFoundInput,
): Promise<SecurityLostFoundRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.securityPostId !== undefined) {
    values.push(input.securityPostId);
    sets.push(`security_post_id = $${values.length}`);
  }
  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }
  if (input.itemName !== undefined) {
    values.push(input.itemName);
    sets.push(`item_name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<SecurityLostFoundRow>(
    `UPDATE security_lost_found
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${SECURITY_LOST_FOUND_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Update only the custody_status. Used by the lifecycle transitions. */
export async function updateCustodyStatus(
  id: string,
  custodyStatus: SecurityLostFoundStatus,
): Promise<SecurityLostFoundRecord | null> {
  const result = await getPool().query<SecurityLostFoundRow>(
    `UPDATE security_lost_found
     SET custody_status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SECURITY_LOST_FOUND_COLUMNS}`,
    [id, custodyStatus],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/*  History                                                             */
/* ------------------------------------------------------------------ */

export async function insertHistory(
  input: {
    lostFoundId: string;
    eventType: SecurityLostFoundHistoryEventType;
    claimantName: string | null;
    claimantReference: string | null;
    claimNotes: string | null;
    verifiedByUserId: string | null;
    returnedByUserId: string | null;
    returnedAt: Date | null;
    occurredAt: Date;
    notes: string | null;
  },
): Promise<SecurityLostFoundHistoryRecord> {
  const result = await getPool().query<SecurityLostFoundHistoryRow>(
    `INSERT INTO security_lost_found_history
       (id, lost_found_id, event_type, claimant_name, claimant_reference,
        claim_notes, verified_by_user_id, returned_by_user_id, returned_at,
        occurred_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${SECURITY_LOST_FOUND_HISTORY_COLUMNS}`,
    [
      randomUUID(),
      input.lostFoundId,
      input.eventType,
      input.claimantName,
      input.claimantReference,
      input.claimNotes,
      input.verifiedByUserId,
      input.returnedByUserId,
      input.returnedAt,
      input.occurredAt,
      input.notes,
    ],
  );
  return mapHistoryRow(result.rows[0]);
}

export async function listHistory(
  lostFoundId: string,
): Promise<SecurityLostFoundHistoryRecord[]> {
  const result = await getPool().query<SecurityLostFoundHistoryRow>(
    `SELECT ${SECURITY_LOST_FOUND_HISTORY_COLUMNS}
     FROM security_lost_found_history
     WHERE lost_found_id = $1
     ORDER BY occurred_at ASC, created_at ASC`,
    [lostFoundId],
  );
  return result.rows.map(mapHistoryRow);
}

export async function findActiveClaim(
  lostFoundId: string,
): Promise<SecurityLostFoundHistoryRecord | null> {
  const result = await getPool().query<SecurityLostFoundHistoryRow>(
    `SELECT ${SECURITY_LOST_FOUND_HISTORY_COLUMNS}
     FROM security_lost_found_history
     WHERE lost_found_id = $1
       AND event_type = 'CLAIM_REGISTER'
       AND NOT EXISTS (
         SELECT 1 FROM security_lost_found_history h2
         WHERE h2.lost_found_id = security_lost_found_history.lost_found_id
           AND h2.event_type IN ('RETURN', 'DISPOSE', 'CLOSE')
           AND h2.occurred_at >= security_lost_found_history.occurred_at
       )
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [lostFoundId],
  );
  return result.rows[0] ? mapHistoryRow(result.rows[0]) : null;
}

export const securityLostFoundRepository = {
  create,
  findActiveClaim,
  findByBuildingAndItemCode,
  findById,
  insertHistory,
  list,
  listByBuildingIds,
  listHistory,
  update,
  updateCustodyStatus,
};
