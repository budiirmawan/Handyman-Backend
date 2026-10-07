import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27L — bounded CMS content records.
 *
 * Content is plain text / safe Markdown only; no executable HTML, script,
 * binary, file-storage key, template, or configuration-version lifecycle is
 * introduced. Building ownership remains derived through Property → Client.
 */
export const migration0255CreateCmsContent: Migration = {
  id: '0255_create_cms_content',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE cms_content (
        id                   UUID PRIMARY KEY,
        scope_type           TEXT NOT NULL,
        client_id            UUID REFERENCES clients(id),
        building_id          UUID REFERENCES buildings(id),
        content_type         TEXT NOT NULL,
        slug                 TEXT NOT NULL,
        title                TEXT NOT NULL,
        body                 TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'DRAFT',
        created_by_user_id   UUID NOT NULL REFERENCES users(id),
        published_at         TIMESTAMPTZ,
        published_by_user_id UUID REFERENCES users(id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT cms_content_scope_type_check
          CHECK (scope_type IN ('CLIENT','BUILDING')),
        CONSTRAINT cms_content_scope_check CHECK (
          (scope_type='CLIENT' AND client_id IS NOT NULL AND building_id IS NULL)
          OR (scope_type='BUILDING' AND client_id IS NULL AND building_id IS NOT NULL)
        ),
        CONSTRAINT cms_content_type_check CHECK (
          content_type IN (
            'ANNOUNCEMENT','HELP','FAQ','KNOWLEDGE','PORTAL_CONTENT','RELEASE_INFORMATION'
          )
        ),
        CONSTRAINT cms_content_slug_check CHECK (
          char_length(slug) BETWEEN 1 AND 120
          AND slug ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
        ),
        CONSTRAINT cms_content_title_check CHECK (char_length(title) BETWEEN 1 AND 240),
        CONSTRAINT cms_content_body_check CHECK (char_length(body) BETWEEN 1 AND 100000),
        CONSTRAINT cms_content_status_check
          CHECK (status IN ('DRAFT','PUBLISHED','INACTIVE')),
        CONSTRAINT cms_content_publish_metadata_check CHECK (
          status <> 'PUBLISHED'
          OR (published_at IS NOT NULL AND published_by_user_id IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX cms_content_client_key_unique
        ON cms_content(client_id,content_type,slug) WHERE scope_type='CLIENT';
      CREATE UNIQUE INDEX cms_content_building_key_unique
        ON cms_content(building_id,content_type,slug) WHERE scope_type='BUILDING';
      CREATE INDEX cms_content_client_effective_idx
        ON cms_content(client_id,status,content_type,slug) WHERE scope_type='CLIENT';
      CREATE INDEX cms_content_building_effective_idx
        ON cms_content(building_id,status,content_type,slug) WHERE scope_type='BUILDING'
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS cms_content');
  },
};
