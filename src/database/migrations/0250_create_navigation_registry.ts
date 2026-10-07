import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27E — Client / Building scoped Navigation Registry.
 * Registry metadata only: no frontend UI, role menus, or authorization bypass.
 */
export const migration0250CreateNavigationRegistry: Migration = {
  id: '0250_create_navigation_registry',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE navigation_items (
        id                   UUID PRIMARY KEY,
        scope_type           TEXT NOT NULL,
        client_id            UUID REFERENCES clients (id),
        building_id          UUID REFERENCES buildings (id),
        navigation_key       TEXT NOT NULL,
        label                TEXT NOT NULL,
        route_reference      TEXT NOT NULL,
        parent_navigation_key TEXT,
        display_order        INTEGER NOT NULL DEFAULT 0,
        module_id            UUID REFERENCES modules (id),
        feature_key          TEXT,
        permission_id        UUID REFERENCES permissions (id),
        enabled              BOOLEAN NOT NULL DEFAULT TRUE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT navigation_items_scope_type_check
          CHECK (scope_type IN ('CLIENT', 'BUILDING')),
        CONSTRAINT navigation_items_scope_check
          CHECK (
            (scope_type = 'CLIENT' AND client_id IS NOT NULL AND building_id IS NULL)
            OR
            (scope_type = 'BUILDING' AND client_id IS NULL AND building_id IS NOT NULL)
          ),
        CONSTRAINT navigation_items_key_check
          CHECK (navigation_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(navigation_key) <= 100),
        CONSTRAINT navigation_items_parent_key_check
          CHECK (parent_navigation_key IS NULL OR (
            parent_navigation_key ~ '^[A-Z][A-Z0-9_.-]*$'
            AND char_length(parent_navigation_key) <= 100
            AND parent_navigation_key <> navigation_key
          )),
        CONSTRAINT navigation_items_feature_check
          CHECK (feature_key IS NULL OR module_id IS NOT NULL),
        CONSTRAINT navigation_items_feature_key_check
          CHECK (feature_key IS NULL OR (
            feature_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(feature_key) <= 100
          )),
        CONSTRAINT navigation_items_order_check CHECK (display_order >= 0)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX navigation_items_client_key_unique
        ON navigation_items (client_id, navigation_key)
        WHERE scope_type = 'CLIENT';
      CREATE UNIQUE INDEX navigation_items_building_key_unique
        ON navigation_items (building_id, navigation_key)
        WHERE scope_type = 'BUILDING';
      CREATE INDEX navigation_items_module_feature_idx
        ON navigation_items (module_id, feature_key);
      CREATE INDEX navigation_items_permission_idx
        ON navigation_items (permission_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS navigation_items');
  },
};
