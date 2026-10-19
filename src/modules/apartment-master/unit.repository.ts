import { getPool } from '../../database';
import type {
  ApartmentUnitFilters,
  ApartmentUnitOccupancyFilters,
  ApartmentUnitOccupancyRecord,
  ApartmentUnitPage,
  ApartmentUnitRecord,
} from './unit.types';

/**
 * CR-HM-MASTER-IND-01 — Unit (existing `spaces`) reads.
 *
 * The FROM chain itself is the isolation proof: a Unit is only reachable when
 * its complete Space → Room → Area → Floor → Building → Property → Client
 * chain resolves to the Server-derived Client AND the requested Building.
 * An unknown, foreign-Client or foreign-Building Unit therefore yields an
 * empty page / 404, never a cross-Building disclosure.
 */
const UNIT_FROM = `
  FROM spaces s
  JOIN rooms r ON r.id = s.room_id
  JOIN areas a ON a.id = r.area_id
  JOIN floors f ON f.id = a.floor_id
  JOIN buildings b ON b.id = f.building_id AND f.building_id = b.id
  JOIN properties p ON p.id = b.property_id
`;

const UNIT_SELECT = `
  SELECT s.id,
         s.code,
         s.name,
         s.description,
         s.status,
         s.area_sqm::float8 AS "areaSqm",
         p.client_id AS "clientId",
         b.id AS "buildingId",
         b.code AS "buildingCode",
         f.id AS "floorId",
         f.code AS "floorCode",
         f.name AS "floorName",
         f.level_number AS "levelNumber",
         r.id AS "roomId",
         r.code AS "roomCode",
         a.id AS "areaId",
         a.code AS "areaCode"
  ${UNIT_FROM}
  WHERE p.client_id = $1
    AND b.id = $2
    AND b.status = 'ACTIVE'
    AND p.status = 'ACTIVE'
`;

type UnitConditions = { sql: string; values: unknown[] };

function unitConditions(
  clientId: string,
  buildingId: string,
  filters: ApartmentUnitFilters,
): UnitConditions {
  const conditions: string[] = [];
  const values: unknown[] = [clientId, buildingId];

  if (filters.floorId !== undefined) {
    values.push(filters.floorId);
    conditions.push(`f.id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`s.status = $${values.length}`);
  }
  if (filters.search !== undefined) {
    values.push(`%${filters.search.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(
      `(s.code ILIKE $${values.length} ESCAPE '\\' OR s.name ILIKE $${values.length} ESCAPE '\\')`,
    );
  }

  return {
    sql: conditions.length === 0 ? '' : ` AND ${conditions.join(' AND ')}`,
    values,
  };
}

async function listUnits(input: {
  clientId: string;
  buildingId: string;
  filters: ApartmentUnitFilters;
  page: ApartmentUnitPage;
}): Promise<{ items: ApartmentUnitRecord[]; total: number }> {
  const { sql, values } = unitConditions(
    input.clientId,
    input.buildingId,
    input.filters,
  );

  const counted = await getPool().query<{ total: number }>(
    `SELECT count(*)::int AS total ${UNIT_FROM}
      WHERE p.client_id = $1 AND b.id = $2
        AND b.status = 'ACTIVE' AND p.status = 'ACTIVE'${sql}`,
    values,
  );

  const pageValues = [...values, input.page.limit, input.page.offset];
  const result = await getPool().query<ApartmentUnitRecord>(
    `${UNIT_SELECT}${sql}
      ORDER BY f.level_number ASC, s.code ASC, s.id ASC
      LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );

  return { items: result.rows, total: counted.rows[0]?.total ?? 0 };
}

async function findUnit(input: {
  clientId: string;
  buildingId: string;
  unitId: string;
}): Promise<ApartmentUnitRecord | null> {
  const result = await getPool().query<ApartmentUnitRecord>(
    `${UNIT_SELECT} AND s.id = $3 LIMIT 1`,
    [input.clientId, input.buildingId, input.unitId],
  );
  return result.rows[0] ?? null;
}

/**
 * Effective-dated occupancy HISTORY for one Unit. Both ACTIVE and INACTIVE
 * relationship rows are returned so a Tenant change never erases who occupied
 * the Unit before. `current` is a statement-time evaluation of the effective
 * window — never a stored flag.
 */
async function listUnitOccupancies(input: {
  clientId: string;
  buildingId: string;
  unitId: string;
  filters: ApartmentUnitOccupancyFilters;
  page: ApartmentUnitPage;
}): Promise<{ items: ApartmentUnitOccupancyRecord[]; total: number }> {
  const conditions = ['tsr.client_id_derived = $1'];
  const values: unknown[] = [input.clientId];

  const base = `
    FROM (
      SELECT tsr.*, p.client_id AS client_id_derived
        FROM tenant_space_relationships tsr
        JOIN buildings b ON b.id = tsr.building_id
        JOIN properties p ON p.id = b.property_id
       WHERE tsr.building_id = $2 AND tsr.space_id = $3
    ) tsr
    JOIN tenant_companies tc
      ON tc.id = tsr.tenant_company_id AND tc.client_id = tsr.client_id_derived
  `;
  values.push(input.buildingId, input.unitId);

  if (input.filters.status !== undefined) {
    values.push(input.filters.status);
    conditions.push(`tsr.status = $${values.length}`);
  }

  const counted = await getPool().query<{ total: number }>(
    `SELECT count(*)::int AS total ${base} WHERE ${conditions.join(' AND ')}`,
    values,
  );

  const pageValues = [...values, input.page.limit, input.page.offset];
  const result = await getPool().query<ApartmentUnitOccupancyRecord>(
    `SELECT tsr.id,
            tsr.tenant_company_id AS "tenantCompanyId",
            tc.tenant_code AS "tenantCode",
            tc.tenant_name AS "tenantName",
            tc.party_kind AS "partyKind",
            tsr.effective_from AS "effectiveFrom",
            tsr.effective_until AS "effectiveUntil",
            tsr.status,
            tsr.created_at AS "createdAt",
            tsr.updated_at AS "updatedAt",
            (tsr.status = 'ACTIVE'
             AND (tsr.effective_from IS NULL
                  OR tsr.effective_from <= statement_timestamp())
             AND (tsr.effective_until IS NULL
                  OR tsr.effective_until >= statement_timestamp())) AS "current"
     ${base}
     WHERE ${conditions.join(' AND ')}
     ORDER BY tsr.effective_from DESC NULLS LAST, tsr.created_at DESC, tsr.id DESC
     LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );

  return { items: result.rows, total: counted.rows[0]?.total ?? 0 };
}

export const apartmentUnitRepository = {
  findUnit,
  listUnitOccupancies,
  listUnits,
};
