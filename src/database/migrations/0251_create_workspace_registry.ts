import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-27F — scoped Workspace Registry metadata; no workspace UI. */
export const migration0251CreateWorkspaceRegistry: Migration = {
  id: '0251_create_workspace_registry',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE workspaces (
        id             UUID PRIMARY KEY,
        scope_type     TEXT NOT NULL,
        client_id      UUID REFERENCES clients (id),
        building_id    UUID REFERENCES buildings (id),
        workspace_key  TEXT NOT NULL,
        label          TEXT NOT NULL,
        description    TEXT,
        module_id      UUID REFERENCES modules (id),
        feature_key    TEXT,
        navigation_key TEXT,
        permission_id  UUID REFERENCES permissions (id),
        enabled        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workspaces_scope_type_check CHECK (scope_type IN ('CLIENT','BUILDING')),
        CONSTRAINT workspaces_scope_check CHECK (
          (scope_type='CLIENT' AND client_id IS NOT NULL AND building_id IS NULL)
          OR (scope_type='BUILDING' AND client_id IS NULL AND building_id IS NOT NULL)
        ),
        CONSTRAINT workspaces_key_check CHECK (
          workspace_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(workspace_key)<=100
        ),
        CONSTRAINT workspaces_feature_check CHECK (feature_key IS NULL OR module_id IS NOT NULL),
        CONSTRAINT workspaces_feature_key_check CHECK (feature_key IS NULL OR (
          feature_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(feature_key)<=100
        )),
        CONSTRAINT workspaces_navigation_key_check CHECK (navigation_key IS NULL OR (
          navigation_key ~ '^[A-Z][A-Z0-9_.-]*$' AND char_length(navigation_key)<=100
        ))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX workspaces_client_key_unique ON workspaces(client_id,workspace_key) WHERE scope_type='CLIENT';
      CREATE UNIQUE INDEX workspaces_building_key_unique ON workspaces(building_id,workspace_key) WHERE scope_type='BUILDING';
      CREATE INDEX workspaces_module_feature_idx ON workspaces(module_id,feature_key);
      CREATE INDEX workspaces_permission_idx ON workspaces(permission_id)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS workspaces');
  },
};
