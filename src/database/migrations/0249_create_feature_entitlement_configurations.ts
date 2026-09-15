import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27D — Client / Building scoped Feature Entitlement Configuration.
 *
 * A feature is a stable configuration key under an existing BE-02C Module.
 * This is not a second commercial entitlement engine: effective reads require
 * the parent Module to remain effective under BE-27C, which already composes
 * Subscription, License and Module Entitlement authority.
 */
export const migration0249CreateFeatureEntitlementConfigurations: Migration = {
  id: '0249_create_feature_entitlement_configurations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE feature_entitlement_configurations (
        id          UUID PRIMARY KEY,
        scope_type  TEXT NOT NULL,
        client_id   UUID REFERENCES clients (id),
        building_id UUID REFERENCES buildings (id),
        module_id   UUID NOT NULL REFERENCES modules (id),
        feature_key TEXT NOT NULL,
        state       TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT feature_entitlement_configurations_scope_type_check
          CHECK (scope_type IN ('CLIENT', 'BUILDING')),
        CONSTRAINT feature_entitlement_configurations_scope_check
          CHECK (
            (scope_type = 'CLIENT' AND client_id IS NOT NULL AND building_id IS NULL)
            OR
            (scope_type = 'BUILDING' AND client_id IS NULL AND building_id IS NOT NULL)
          ),
        CONSTRAINT feature_entitlement_configurations_key_check
          CHECK (
            char_length(feature_key) BETWEEN 1 AND 100
            AND feature_key ~ '^[A-Z][A-Z0-9_.-]*$'
          ),
        CONSTRAINT feature_entitlement_configurations_state_check
          CHECK (state IN ('ENABLED', 'DISABLED'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX feature_entitlement_configurations_client_unique
        ON feature_entitlement_configurations (client_id, module_id, feature_key)
        WHERE scope_type = 'CLIENT';
      CREATE UNIQUE INDEX feature_entitlement_configurations_building_unique
        ON feature_entitlement_configurations (building_id, module_id, feature_key)
        WHERE scope_type = 'BUILDING';
      CREATE INDEX feature_entitlement_configurations_module_idx
        ON feature_entitlement_configurations (module_id, feature_key)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS feature_entitlement_configurations');
  },
};
