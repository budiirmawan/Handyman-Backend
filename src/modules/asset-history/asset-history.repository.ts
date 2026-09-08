import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AssetHistoryEventRecord,
  AssetHistoryListFilters,
  AssetHistoryMetadata,
  NewAssetHistoryEvent,
} from './asset-history.types';

type AssetHistoryEventRow = {
  id: string;
  assetId: string;
  eventType: string;
  actorUserId: string | null;
  summary: string;
  metadata: AssetHistoryMetadata;
  createdAt: Date;
};

const ASSET_HISTORY_SELECT = `
  id,
  asset_id AS "assetId",
  event_type AS "eventType",
  actor_user_id AS "actorUserId",
  summary,
  metadata,
  created_at AS "createdAt"
`;

function mapRow(row: AssetHistoryEventRow): AssetHistoryEventRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    eventType: row.eventType,
    actorUserId: row.actorUserId,
    summary: row.summary,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
  };
}

/** Append only: there is deliberately no update or delete operation here. */
async function insertEvent(
  input: NewAssetHistoryEvent,
): Promise<AssetHistoryEventRecord> {
  const result = await getPool().query<AssetHistoryEventRow>(
    `INSERT INTO asset_history_events
       (id, asset_id, event_type, actor_user_id, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING ${ASSET_HISTORY_SELECT}`,
    [
      randomUUID(),
      input.assetId,
      input.eventType,
      input.actorUserId,
      input.summary,
      JSON.stringify(input.metadata),
    ],
  );

  return mapRow(result.rows[0]);
}

/**
 * One Asset's timeline, newest first, with a stable tiebreak on `id` so
 * events written inside the same transaction paginate deterministically.
 */
async function listByAssetId(
  assetId: string,
  filters: AssetHistoryListFilters,
): Promise<{ events: AssetHistoryEventRecord[]; total: number }> {
  const eventType = filters.eventType ?? null;

  const totalResult = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM asset_history_events
     WHERE asset_id = $1 AND ($2::text IS NULL OR event_type = $2::text)`,
    [assetId, eventType],
  );

  const result = await getPool().query<AssetHistoryEventRow>(
    `SELECT ${ASSET_HISTORY_SELECT} FROM asset_history_events
     WHERE asset_id = $1 AND ($2::text IS NULL OR event_type = $2::text)
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [assetId, eventType, filters.limit, filters.offset],
  );

  return {
    events: result.rows.map(mapRow),
    total: Number(totalResult.rows[0]?.count ?? '0'),
  };
}

export const assetHistoryRepository = {
  insertEvent,
  listByAssetId,
};
