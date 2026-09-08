import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27N — immutable snapshots for existing BE-27 configuration records.
 * Status is the source record's status at capture time, not the BE-27O
 * Draft/Validate/Publish lifecycle.
 */
export const migration0256CreateConfigurationVersions: Migration = {
  id: '0256_create_configuration_versions',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE configuration_versions (
        id                     UUID PRIMARY KEY,
        source_type            TEXT NOT NULL,
        source_configuration_id UUID NOT NULL,
        client_id              UUID NOT NULL REFERENCES clients(id),
        building_id            UUID REFERENCES buildings(id),
        version_number         INTEGER NOT NULL,
        status                 TEXT NOT NULL,
        previous_version_id    UUID REFERENCES configuration_versions(id),
        snapshot               JSONB NOT NULL,
        created_by_user_id     UUID NOT NULL REFERENCES users(id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT configuration_versions_source_type_check CHECK (
          source_type IN (
            'CLIENT_CONFIGURATION','BUILDING_CONFIGURATION',
            'MODULE_CONFIGURATION','FEATURE_ENTITLEMENT_CONFIGURATION',
            'NAVIGATION_ITEM','WORKSPACE','DASHBOARD','DASHBOARD_WIDGET',
            'CMS_CONTENT'
          )
        ),
        CONSTRAINT configuration_versions_number_check CHECK (version_number >= 1),
        CONSTRAINT configuration_versions_status_check CHECK (
          char_length(status) BETWEEN 1 AND 64
          AND status ~ '^[A-Z][A-Z0-9_-]*$'
        ),
        CONSTRAINT configuration_versions_previous_check CHECK (
          previous_version_id IS NULL OR previous_version_id <> id
        ),
        CONSTRAINT configuration_versions_source_number_unique
          UNIQUE(source_type,source_configuration_id,version_number)
      )
    `);
    await client.query(`
      CREATE INDEX configuration_versions_source_idx
        ON configuration_versions(source_type,source_configuration_id,version_number DESC);
      CREATE INDEX configuration_versions_client_idx
        ON configuration_versions(client_id,created_at DESC);
      CREATE INDEX configuration_versions_building_idx
        ON configuration_versions(building_id,created_at DESC)
    `);
    await client.query(`
      CREATE FUNCTION prevent_configuration_version_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'configuration versions are immutable' USING ERRCODE='55000';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER configuration_versions_immutable
        BEFORE UPDATE OR DELETE ON configuration_versions
        FOR EACH ROW EXECUTE FUNCTION prevent_configuration_version_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS configuration_versions');
    await client.query('DROP FUNCTION IF EXISTS prevent_configuration_version_mutation()');
  },
};
