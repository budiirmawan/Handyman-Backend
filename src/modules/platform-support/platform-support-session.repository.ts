import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  PlatformSupportSessionRecord,
  SupportSessionStorageStatus,
} from './platform-support-session.types';

type Executor = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;
function executor(q?: Executor): Executor {
  return q ?? getPool();
}

type SessionRow = {
  id: string;
  supportActorUserId: string;
  customerId: string;
  buildingId: string | null;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endedByUserId: string | null;
  status: string;
};

const SELECT = `
  id,
  support_actor_user_id AS "supportActorUserId",
  customer_id           AS "customerId",
  building_id           AS "buildingId",
  reason,
  started_at            AS "startedAt",
  expires_at            AS "expiresAt",
  ended_at              AS "endedAt",
  ended_by_user_id      AS "endedByUserId",
  status
`;

function mapRow(row: SessionRow): PlatformSupportSessionRecord {
  return {
    id: row.id,
    supportActorUserId: row.supportActorUserId,
    customerId: row.customerId,
    buildingId: row.buildingId,
    reason: row.reason,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    endedAt: row.endedAt,
    endedByUserId: row.endedByUserId,
    status: row.status as SupportSessionStorageStatus,
  };
}

export const platformSupportSessionRepository = {
  /**
   * Insert a new ACTIVE session. The DB enforces:
   *   - the (support_actor_user_id, customer_id) uniqueness on ACTIVE
   *     rows via the partial unique index in migration 0372;
   *   - non-empty reason (§19.1 — `reason TEXT NOT NULL` + length check);
   *   - expires_at > started_at (§19.1 — check constraint).
   *
   * Callers MUST already have validated `reason` length and
   * `durationMinutes` bounds before invoking the repository.
   */
  async insert(
    params: {
      supportActorUserId: string;
      customerId: string;
      buildingId: string | null;
      reason: string;
      startedAt: Date;
      expiresAt: Date;
    },
    q?: Executor,
  ): Promise<PlatformSupportSessionRecord> {
    const id = randomUUID();
    const result = await executor(q).query<SessionRow>(
      `INSERT INTO platform_support_sessions
         (id, support_actor_user_id, customer_id, building_id,
          reason, started_at, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
       RETURNING ${SELECT}`,
      [
        id,
        params.supportActorUserId,
        params.customerId,
        params.buildingId,
        params.reason,
        params.startedAt,
        params.expiresAt,
      ],
    );
    return mapRow(result.rows[0]);
  },

  async findById(
    id: string,
    q?: Executor,
  ): Promise<PlatformSupportSessionRecord | null> {
    const result = await executor(q).query<SessionRow>(
      `SELECT ${SELECT}
       FROM platform_support_sessions
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },

  /**
   * Returns the single EFFECTIVE session for `(support_actor_user_id,
   * customer_id)` at `now`. "Effective" = storage `status='ACTIVE'`
   * AND `expires_at > now`. There can be at most one (enforced by
   * advisory transaction lock in `openSupportSession`).
   *
   * Used inside the lock to read-check before insert.
   */
  async findEffectiveByActorCustomer(
    supportActorUserId: string,
    customerId: string,
    now: Date,
    q?: Executor,
  ): Promise<PlatformSupportSessionRecord | null> {
    const result = await executor(q).query<SessionRow>(
      `SELECT ${SELECT}
       FROM platform_support_sessions
       WHERE support_actor_user_id = $1
         AND customer_id = $2
         AND status = 'ACTIVE'
         AND expires_at > $3
       ORDER BY expires_at DESC
       LIMIT 1`,
      [supportActorUserId, customerId, now],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },

  /** Verify that a building exists and its property belongs to the customer. */
  async findBuildingClientId(
    buildingId: string,
    q?: Executor,
  ): Promise<string | null> {
    const result = await executor(q).query<{ clientId: string }>(
      `SELECT p.client_id AS "clientId"
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
       WHERE b.id = $1
         AND b.status = 'ACTIVE'
       LIMIT 1`,
      [buildingId],
    );
    return result.rows[0]?.clientId ?? null;
  },

  /**
   * Reads `saas.support_session_max_minutes` from the canonical
   * `platform_configurations` table (§20.2). Mirrors the PART 08
   * `readConfigNumber` convention: missing key OR malformed value
   * (non-numeric, non-finite, non-positive integer) returns `null`
   * and the caller is responsible for substituting the frozen
   * default. PART 11A does NOT seed or mutate the key — PART 12
   * owns the configuration lifecycle (§20, §22 endpoints).
   *
   * Accepted JSONB shapes: native number, string-encoded number.
   */
  async readMaxMinutes(q?: Executor): Promise<number | null> {
    const result = await executor(q).query<{ value: unknown }>(
      `SELECT value FROM platform_configurations WHERE key = $1`,
      ['saas.support_session_max_minutes'],
    );
    const raw = result.rows[0]?.value;
    if (raw === null || raw === undefined) return null;
    let parsed: number;
    if (typeof raw === 'number') {
      parsed = raw;
    } else if (typeof raw === 'string') {
      parsed = Number(raw);
    } else {
      return null;
    }
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  },

  /**
   * List for `GET /platform/support-sessions` (PART 11B will plumb
   * filters). Restricted to a specific actor by default to support
   * per-actor history lookups. Status filter is `ACTIVE` (live) or
   * `ENDED` (revoked); pass `null` to fetch both.
   */
  async listForActor(
    supportActorUserId: string,
    statusFilter: 'ACTIVE' | 'ENDED' | null,
    q?: Executor,
  ): Promise<PlatformSupportSessionRecord[]> {
    const params: unknown[] = [supportActorUserId];
    let where = 'support_actor_user_id = $1';
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND status = $${params.length}`;
    }
    const result = await executor(q).query<SessionRow>(
      `SELECT ${SELECT}
       FROM platform_support_sessions
       WHERE ${where}
       ORDER BY started_at DESC`,
      params,
    );
    return result.rows.map(mapRow);
  },

  /**
   * Mark an ACTIVE session as ENDED. Idempotent at the row layer:
   * if the session is already ENDED, returns 0. Combined with the
   * (actor, customer) partial-unique index, the only way to open
   * another session for the same actor+customer is to end or expire
   * the previous one first.
   *
   * The `expectedStatus` argument is `'ACTIVE'` so an explicit
   * revoked-on-already-ENDED can be detected.
   */
  async markEnded(
    id: string,
    endedByUserId: string,
    q?: Executor,
  ): Promise<{ updated: boolean }> {
    const result = await executor(q).query(
      `UPDATE platform_support_sessions
       SET status = 'ENDED',
           ended_at = NOW(),
           ended_by_user_id = $2
       WHERE id = $1
         AND status = 'ACTIVE'
         AND ended_at IS NULL`,
      [id, endedByUserId],
    );
    return { updated: (result.rowCount ?? 0) > 0 };
  },
};
