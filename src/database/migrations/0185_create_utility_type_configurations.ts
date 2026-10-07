import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18B — Electricity / Water / Gas utility type configuration.
 *
 * Utility behavior stays DATA, not code. Rather than branching on
 * `if utilityType === 'ELECTRICITY'`, each Client configures the three
 * supported utility types and declares which BE-07 units of measure are valid
 * for each one. BE-18A's Meter Master then validates its
 * (utility type, UOM) pair against this configuration.
 *
 * Two tables, no new engine:
 *
 *   `utility_type_configurations` — one row per (Client, utility type):
 *     the display metadata (`name`, `description`), optional reading
 *     precision (`decimal_precision`), and lifecycle `status`. Unique per
 *     (client_id, utility_type), so a Client configures ELECTRICITY / WATER /
 *     GAS at most once each.
 *
 *   `utility_type_uoms` — the allowed UOM mapping for a configuration.
 *     References the BE-07 `units_of_measure` master by id only; no unit,
 *     symbol, or measurement data is copied. At most one ACTIVE default UOM
 *     per configuration is enforced by a partial unique index (the same
 *     idiom BE-07 / BE-10C use for "one active" rules), while non-default and
 *     INACTIVE mappings are retained as configuration history.
 *
 * `utility_meters` is deliberately NOT altered: a Meter already carries its
 * `utility_type` and `uom_id` from BE-18A, and its configuration is resolved
 * through (client_id, utility_type). Storing a configuration FK on the Meter
 * would duplicate that relationship and allow it to drift.
 *
 * Out of scope here (later parts): main/sub meter hierarchy (BE-18C), tenant
 * meter (BE-18D), readings (BE-18E), consumption (BE-18G). Billing and
 * accounting never live in BE-18.
 */
export const migration0185CreateUtilityTypeConfigurations: Migration = {
  id: '0185_create_utility_type_configurations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_type_configurations (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        utility_type      TEXT NOT NULL,
        name              TEXT NOT NULL,
        description       TEXT,
        decimal_precision INTEGER,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_type_configurations_client_type_unique
          UNIQUE (client_id, utility_type),
        CONSTRAINT utility_type_configurations_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_type_configurations_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT utility_type_configurations_precision_check
          CHECK (decimal_precision IS NULL OR decimal_precision >= 0)
      )
    `);

    await client.query(`
      CREATE TABLE utility_type_uoms (
        id                            UUID PRIMARY KEY,
        utility_type_configuration_id UUID NOT NULL
          REFERENCES utility_type_configurations (id),
        uom_id                        UUID NOT NULL
          REFERENCES units_of_measure (id),
        is_default                    BOOLEAN NOT NULL DEFAULT FALSE,
        status                        TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_type_uoms_configuration_uom_unique
          UNIQUE (utility_type_configuration_id, uom_id),
        CONSTRAINT utility_type_uoms_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX utility_type_configurations_client_idx
        ON utility_type_configurations (client_id, status, utility_type);
      CREATE UNIQUE INDEX utility_type_uoms_default_unique
        ON utility_type_uoms (utility_type_configuration_id)
        WHERE is_default AND status = 'ACTIVE';
      CREATE INDEX utility_type_uoms_configuration_idx
        ON utility_type_uoms (utility_type_configuration_id, status);
      CREATE INDEX utility_type_uoms_uom_idx
        ON utility_type_uoms (uom_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_type_uoms');
    await client.query('DROP TABLE IF EXISTS utility_type_configurations');
  },
};
