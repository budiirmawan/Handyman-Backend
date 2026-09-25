import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  PlatformConfigurationRecord,
  SaaSPlatformConfigurationKey,
} from './platform-configuration.types';

type Executor = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;
function executor(q?: Executor): Executor {
  return q ?? getPool();
}

type ConfigRow = {
  key: string;
  value: unknown;
  version: number;
  description: string | null;
  updatedByUserId: string | null;
  updatedAt: Date;
  createdAt: Date;
};

const SELECT = `
  key,
  value,
  version,
  description,
  updated_by_user_id AS "updatedByUserId",
  updated_at        AS "updatedAt",
  created_at        AS "createdAt"
`;

function mapRow(row: ConfigRow): PlatformConfigurationRecord {
  return {
    key: row.key as SaaSPlatformConfigurationKey,
    value: row.value,
    version: row.version,
    description: row.description,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export const platformConfigurationRepository = {
  /**
   * Read a single configuration row, if it exists. The authoritative
   * resolver lives in the service — this just returns the raw
   * persisted row.
   */
  async findByKey(
    key: SaaSPlatformConfigurationKey,
    q?: Executor,
  ): Promise<PlatformConfigurationRecord | null> {
    const result = await executor(q).query<ConfigRow>(
      `SELECT ${SELECT}
       FROM platform_configurations
       WHERE key = $1`,
      [key],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },

  /**
   * List all configuration rows. Read-only.
   */
  async listAll(
    q?: Executor,
  ): Promise<PlatformConfigurationRecord[]> {
    const result = await executor(q).query<ConfigRow>(
      `SELECT ${SELECT}
       FROM platform_configurations
       ORDER BY key ASC`,
    );
    return result.rows.map(mapRow);
  },

  /**
   * Insert a brand-new key. INSERT-level UNIQUE collision on the
   * `key` column is the DB-source-of-truth signal for "already
   * exists" — the service maps that to a 409 `SAAS_PLATFORM_CONFIG_NOT_FOUND`
   * is the wrong code; we use a generic 409 conflict.
   */
  async insert(
    params: {
      key: SaaSPlatformConfigurationKey;
      value: unknown;
      description: string | null;
      updatedByUserId: string;
    },
    q?: Executor,
  ): Promise<PlatformConfigurationRecord> {
    const id = randomUUID();
    const result = await executor(q).query<ConfigRow>(
      `INSERT INTO platform_configurations
         (id, key, value, description, version, updated_by_user_id,
          created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, 1, $5, NOW(), NOW())
       RETURNING ${SELECT}`,
      [
        id,
        params.key,
        JSON.stringify(params.value),
        params.description,
        params.updatedByUserId,
      ],
    );
    return mapRow(result.rows[0]);
  },

  /**
   * Update an existing row with OCC (§17.3 + §20.2). Returns
   * `{updated, record}` — `updated=false` when no row matched the
   * expectedVersion (409 conflict).
   */
  async update(
    params: {
      key: SaaSPlatformConfigurationKey;
      value: unknown;
      description: string | null;
      expectedVersion: number;
      updatedByUserId: string;
    },
    q?: Executor,
  ): Promise<{
    updated: boolean;
    record: PlatformConfigurationRecord | null;
  }> {
    const result = await executor(q).query<ConfigRow>(
      `UPDATE platform_configurations
       SET value             = $1::jsonb,
           description       = $2,
           version           = version + 1,
           updated_by_user_id = $3,
           updated_at        = NOW()
       WHERE key = $4
         AND version = $5
       RETURNING ${SELECT}`,
      [
        JSON.stringify(params.value),
        params.description,
        params.updatedByUserId,
        params.key,
        params.expectedVersion,
      ],
    );
    return {
      updated: (result.rowCount ?? 0) > 0,
      record: result.rows[0] ? mapRow(result.rows[0]) : null,
    };
  },

  /**
   * List active currency codes (used to resolve
   * `saas.supported_currencies` default). Read-only — does not
   * touch `platform_configurations`.
   */
  async listActiveCurrencyCodes(
    q?: Executor,
  ): Promise<string[]> {
    const result = await executor(q).query<{ code: string }>(
      `SELECT code FROM currencies WHERE status = 'ACTIVE' ORDER BY code ASC`,
    );
    return result.rows.map((r) => r.code);
  },

  /**
   * List active product ids (used to resolve
   * `saas.product_availability` default). Read-only.
   */
  async listActiveProductIds(q?: Executor): Promise<string[]> {
    const result = await executor(q).query<{ id: string }>(
      `SELECT id FROM saas_products WHERE status = 'ACTIVE' ORDER BY id ASC`,
    );
    return result.rows.map((r) => r.id);
  },
};
