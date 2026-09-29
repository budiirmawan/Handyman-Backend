import type { PoolClient } from 'pg';
import type { QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanArrivalLocationIdentifierRecord,
  HandymanArrivalLocationIdentifierStatus,
} from './handyman-arrival-location.types';

/**
 * CR-HM-07 PART 02 — location identifier repository. ONLY writer of
 * `handyman_arrival_location_identifiers`: ACTIVE insert + the single
 * ACTIVE -> INACTIVE projection permitted by the 0398 trigger.
 * Read-only master/scope lookups stay here (authorities are consumed,
 * never mutated).
 */

type Row = QueryResultRow;

const IDENTIFIER_SELECT = `
  SELECT id, client_id, opaque_code_hash, building_id, floor_id,
         area_id, room_id, space_id, status, created_at, updated_at
    FROM handyman_arrival_location_identifiers`;

function map(row: Row): HandymanArrivalLocationIdentifierRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    opaqueCodeHash: row.opaque_code_hash,
    buildingId: row.building_id,
    floorId: row.floor_id,
    areaId: row.area_id,
    roomId: row.room_id,
    spaceId: row.space_id,
    status: row.status as HandymanArrivalLocationIdentifierStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Building read incl. its property Client (identifier authority). */
async function findBuildingAuthority(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await executor.query(
    `SELECT b.id, p.client_id, b.status
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, clientId: row.client_id, status: row.status }
    : null;
}

/** Master link validation reads (existence + parent links). */
async function masterParent(
  executor: Pick<PoolClient, 'query'> = getPool(),
  table: 'floors' | 'areas' | 'rooms' | 'spaces',
  parentColumn: 'building_id' | 'floor_id' | 'area_id' | 'room_id',
  id: string,
): Promise<{ id: string; parentId: string; status: string } | null> {
  const result = await executor.query(
    `SELECT id, ${parentColumn} AS parent_id, status
       FROM ${table} WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, parentId: row.parent_id, status: row.status }
    : null;
}

/** Insert ACTIVE (hash + chain pre-verified by service AND triggers). */
async function insertIdentifier(
  executor: Pick<PoolClient, 'query'>,
  record: {
    clientId: string;
    opaqueCodeHash: string;
    buildingId: string;
    floorId: string | null;
    areaId: string | null;
    roomId: string | null;
    spaceId: string | null;
  },
): Promise<HandymanArrivalLocationIdentifierRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_arrival_location_identifiers (
       id, client_id, opaque_code_hash, building_id, floor_id,
       area_id, room_id, space_id, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
     RETURNING id, client_id, opaque_code_hash, building_id, floor_id,
               area_id, room_id, space_id, status, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.opaqueCodeHash,
      record.buildingId,
      record.floorId,
      record.areaId,
      record.roomId,
      record.spaceId,
    ],
  );
  return map(result.rows[0]);
}

/** Exact opaque-code lookup (QR scan boundary). */
async function findByOpaqueCodeHash(
  executor: Pick<PoolClient, 'query'> = getPool(),
  opaqueCodeHash: string,
): Promise<HandymanArrivalLocationIdentifierRecord | null> {
  const result = await executor.query(
    `${IDENTIFIER_SELECT}
      WHERE opaque_code_hash = $1`,
    [opaqueCodeHash],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Registry row read (management/test paths). */
async function findIdentifierById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanArrivalLocationIdentifierRecord | null> {
  const result = await executor.query(
    `${IDENTIFIER_SELECT}
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** The single permitted lifecycle projection: ACTIVE -> INACTIVE. */
async function deactivateIdentifier(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanArrivalLocationIdentifierRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_arrival_location_identifiers
        SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id, client_id, opaque_code_hash, building_id, floor_id,
               area_id, room_id, space_id, status, created_at, updated_at`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanArrivalLocationRepository = {
  findBuildingAuthority,
  masterParent,
  insertIdentifier,
  findByOpaqueCodeHash,
  findIdentifierById,
  deactivateIdentifier,
};
