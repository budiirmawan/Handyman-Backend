import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicSecurityLogbookEntry,
  SecurityLogbookCategory,
  SecurityLogbookListFilters,
  SecurityLogbookStatus,
} from './security-logbook.types';

/**
 * CR-BE-MOB-05 PART 03 — Security Logbook repository.
 *
 * `recorded_at` is set ONLY here with the database clock (NOW()) —
 * client-supplied timestamps never reach the storage layer. All access
 * rules (Building isolation, handover same-Building rule) live in the
 * service layer.
 */

type LogbookDisplayRow = {
  id: string;
  client_id: string;
  building_id: string;
  building_code: string;
  building_name: string;
  workforce_profile_id: string;
  employee_code: string;
  shift_handover_id: string | null;
  category: SecurityLogbookCategory;
  summary: string;
  detail: string | null;
  status: SecurityLogbookStatus;
  recorded_at: Date;
  created_at: Date;
  updated_at: Date;
};

const LOGBOOK_SELECT = `
  SELECT
    le.id,
    le.client_id,
    le.building_id,
    b.code            AS building_code,
    b.name            AS building_name,
    le.workforce_profile_id,
    wp.employee_code,
    le.shift_handover_id,
    le.category,
    le.summary,
    le.detail,
    le.status,
    le.recorded_at,
    le.created_at,
    le.updated_at
  FROM security_logbook_entries le
  JOIN buildings b          ON b.id = le.building_id
  JOIN workforce_profiles wp ON wp.id = le.workforce_profile_id
`;

function mapPublicRow(row: LogbookDisplayRow): PublicSecurityLogbookEntry {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    buildingCode: row.building_code,
    buildingName: row.building_name,
    workforceProfileId: row.workforce_profile_id,
    employeeCode: row.employee_code,
    shiftHandoverId: row.shift_handover_id,
    category: row.category,
    summary: row.summary,
    detail: row.detail,
    status: row.status,
    recordedAt: row.recorded_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findByIdJoined(
  id: string,
): Promise<PublicSecurityLogbookEntry | null> {
  const result = await getPool().query<LogbookDisplayRow>(
    `${LOGBOOK_SELECT} WHERE le.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapPublicRow(row) : null;
}

/**
 * Inserts an entry with the database clock (`recorded_at = NOW()`). Returns
 * the joined public record.
 */
export async function createLogbookEntry(input: {
  clientId: string;
  buildingId: string;
  workforceProfileId: string;
  shiftHandoverId: string | null;
  category: SecurityLogbookCategory;
  summary: string;
  detail: string | null;
}): Promise<PublicSecurityLogbookEntry> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO security_logbook_entries
       (id, client_id, building_id, workforce_profile_id,
        shift_handover_id, category, summary, detail, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN')`,
    [
      id,
      input.clientId,
      input.buildingId,
      input.workforceProfileId,
      input.shiftHandoverId,
      input.category,
      input.summary,
      input.detail,
    ],
  );
  const record = await findByIdJoined(id);
  if (!record) {
    // The INSERT succeeded; the join can only fail on a data-integrity fault.
    throw new Error('Security logbook entry created but could not be resolved.');
  }
  return record;
}

/** Lists entries of one Building, newest first, with optional filters. */
export async function listLogbookEntriesByBuilding(
  buildingId: string,
  filters: SecurityLogbookListFilters,
  range: { start: Date | null; end: Date | null },
): Promise<PublicSecurityLogbookEntry[]> {
  const conditions: string[] = ['le.building_id = $1'];
  const params: unknown[] = [buildingId];
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`le.status = $${params.length}`);
  }
  if (filters.category) {
    params.push(filters.category);
    conditions.push(`le.category = $${params.length}`);
  }
  if (range.start) {
    params.push(range.start);
    conditions.push(`le.recorded_at >= $${params.length}`);
  }
  if (range.end) {
    params.push(range.end);
    conditions.push(`le.recorded_at < $${params.length}`);
  }
  const result = await getPool().query<LogbookDisplayRow>(
    `${LOGBOOK_SELECT}
     WHERE ${conditions.join(' AND ')}
     ORDER BY le.recorded_at DESC, le.created_at DESC`,
    params,
  );
  return result.rows.map(mapPublicRow);
}

/**
 * Updates an OPEN entry (CLOSED is terminal — the service enforces it
 * before calling here). Returns the updated public record, or null when the
 * entry does not exist.
 */
export async function updateLogbookEntry(
  id: string,
  input: {
    category?: SecurityLogbookCategory;
    summary?: string;
    detail?: string | null;
    status?: SecurityLogbookStatus;
    shiftHandoverId?: string | null;
  },
): Promise<PublicSecurityLogbookEntry | null> {
  const assignments: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [id];
  const setField = (column: string, value: unknown): void => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };
  if (input.category !== undefined) setField('category', input.category);
  if (input.summary !== undefined) setField('summary', input.summary);
  if (input.detail !== undefined) setField('detail', input.detail);
  if (input.status !== undefined) setField('status', input.status);
  if (input.shiftHandoverId !== undefined) {
    setField('shift_handover_id', input.shiftHandoverId);
  }

  const update = await getPool().query<{ id: string }>(
    `UPDATE security_logbook_entries
     SET ${assignments.join(', ')}
     WHERE id = $1
     RETURNING id`,
    params,
  );
  if (!update.rows[0]) {
    return null;
  }
  return findByIdJoined(update.rows[0].id);
}

export const securityLogbookRepository = {
  createLogbookEntry,
  findByIdJoined,
  listLogbookEntriesByBuilding,
  updateLogbookEntry,
};
