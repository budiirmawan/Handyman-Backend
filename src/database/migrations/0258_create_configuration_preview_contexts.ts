import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-27P — caller-bound, expiring preview contexts for validated versions. */
export const migration0258CreateConfigurationPreviewContexts: Migration = {
  id: '0258_create_configuration_preview_contexts',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE configuration_preview_contexts (
        id UUID PRIMARY KEY,
        configuration_version_id UUID NOT NULL REFERENCES configuration_versions(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID REFERENCES buildings(id),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        revoked_by_user_id UUID REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT configuration_preview_context_status_check
          CHECK(status IN('ACTIVE','REVOKED')),
        CONSTRAINT configuration_preview_context_expiry_check
          CHECK(expires_at>created_at),
        CONSTRAINT configuration_preview_context_revocation_check CHECK(
          (status='ACTIVE' AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
          OR (status='REVOKED' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
        )
      );
      CREATE INDEX configuration_preview_context_version_idx
        ON configuration_preview_contexts(configuration_version_id);
      CREATE INDEX configuration_preview_context_owner_idx
        ON configuration_preview_contexts(created_by_user_id,status,expires_at);
      CREATE INDEX configuration_preview_context_scope_idx
        ON configuration_preview_contexts(client_id,building_id)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS configuration_preview_contexts');
  },
};
