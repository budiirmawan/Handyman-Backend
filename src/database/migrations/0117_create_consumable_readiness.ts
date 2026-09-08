import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11J — Consumable Readiness.
 *
 * Provides operational consumable requirement definitions and readiness checks
 * for Housekeeping operations.
 */
export const migration0117CreateConsumableReadiness: Migration = {
  id: '0117_create_consumable_readiness',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE consumable_requirements (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        cleaning_area_id  UUID REFERENCES cleaning_areas (id),
        code              TEXT NOT NULL,
        name              TEXT NOT NULL,
        required_quantity NUMERIC NOT NULL DEFAULT 1,
        unit              TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT consumable_requirements_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT consumable_requirements_quantity
          CHECK (required_quantity >= 0),
        CONSTRAINT consumable_requirements_code_unique
          UNIQUE (building_id, code)
      )
    `);

    await client.query(`
      CREATE INDEX consumable_requirements_building_idx
        ON consumable_requirements (building_id, status);
      CREATE INDEX consumable_requirements_area_idx
        ON consumable_requirements (cleaning_area_id, status);
      CREATE INDEX consumable_requirements_client_idx
        ON consumable_requirements (client_id, status);
    `);

    await client.query(`
      CREATE TABLE consumable_readiness_checks (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        requirement_id     UUID NOT NULL REFERENCES consumable_requirements (id),
        operational_date   DATE NOT NULL,
        readiness_status   TEXT NOT NULL,
        available_quantity NUMERIC,
        checked_by_user_id UUID NOT NULL REFERENCES users (id),
        checked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes              TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT consumable_readiness_status
          CHECK (readiness_status IN ('READY', 'LOW', 'NOT_READY', 'UNKNOWN')),
        CONSTRAINT consumable_readiness_quantity
          CHECK (available_quantity IS NULL OR available_quantity >= 0)
      )
    `);

    await client.query(`
      CREATE INDEX consumable_readiness_requirement_idx
        ON consumable_readiness_checks (requirement_id, checked_at DESC);
      CREATE INDEX consumable_readiness_building_idx
        ON consumable_readiness_checks (building_id, readiness_status);
      CREATE INDEX consumable_readiness_date_idx
        ON consumable_readiness_checks (operational_date);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS consumable_readiness_checks;
      DROP TABLE IF EXISTS consumable_requirements;
    `);
  },
};
