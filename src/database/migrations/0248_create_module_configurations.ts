import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27C — Client / Building scoped Module Configuration.
 *
 * This table references the existing BE-02C Module catalogue; it does not
 * create a second module or entitlement engine. A row belongs to exactly one
 * scope:
 *
 * - CLIENT: `client_id` is set and `building_id` is null.
 * - BUILDING: `building_id` is set and `client_id` is null. Client ownership
 *   is derived through Building → Property → Client, exactly as in BE-27B.
 *
 * `enabled` is configuration intent. Effective reads still intersect it with
 * the existing Subscription/License/Module Entitlement resolver, so
 * configuration can narrow commercial availability but never grant it.
 */
export const migration0248CreateModuleConfigurations: Migration = {
  id: '0248_create_module_configurations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE module_configurations (
        id          UUID PRIMARY KEY,
        scope_type  TEXT NOT NULL,
        client_id   UUID REFERENCES clients (id),
        building_id UUID REFERENCES buildings (id),
        module_id   UUID NOT NULL REFERENCES modules (id),
        enabled     BOOLEAN NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT module_configurations_scope_type_check
          CHECK (scope_type IN ('CLIENT', 'BUILDING')),
        CONSTRAINT module_configurations_scope_check
          CHECK (
            (scope_type = 'CLIENT' AND client_id IS NOT NULL AND building_id IS NULL)
            OR
            (scope_type = 'BUILDING' AND client_id IS NULL AND building_id IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX module_configurations_client_module_unique
        ON module_configurations (client_id, module_id)
        WHERE scope_type = 'CLIENT';
      CREATE UNIQUE INDEX module_configurations_building_module_unique
        ON module_configurations (building_id, module_id)
        WHERE scope_type = 'BUILDING';
      CREATE INDEX module_configurations_module_idx
        ON module_configurations (module_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS module_configurations');
  },
};
