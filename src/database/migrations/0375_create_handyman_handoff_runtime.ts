import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-01 PART 03 — Secure handoff runtime foundation (frozen D1/D2).
 *
 * Three minimal stores, no generic integration framework:
 *
 * 1. handyman_handoff_integrations — BM integration TRUST METADATA only.
 *    Secret/key material is never persisted here (environment-config scoped
 *    per integration, following the whatsapp-callback secret boundary), so
 *    no plaintext secret can ever be stored or logged from this table.
 * 2. handyman_handoff_assertions — append-only replay-prevention record of
 *    accepted assertions (one assertion id per integration, ever).
 * 3. handyman_handoff_exchanges — short-lived single-use exchange state
 *    (D2): hash-only token plus a canonical resolved context snapshot. An
 *    exchange is NOT a standard user session and creates none.
 */
export const migration0375CreateHandymanHandoffRuntime: Migration = {
  id: '0375_create_handyman_handoff_runtime',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_handoff_integrations (
        id               UUID PRIMARY KEY,
        integration_code TEXT NOT NULL,
        display_name     TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_handoff_integrations_code_unique
          UNIQUE (integration_code),
        CONSTRAINT handyman_handoff_integrations_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_handoff_integrations_code_length_check
          CHECK (char_length(integration_code) BETWEEN 1 AND 64)
      )
    `);

    await client.query(`
      CREATE TABLE handyman_handoff_assertions (
        id              UUID PRIMARY KEY,
        integration_id  UUID NOT NULL REFERENCES handyman_handoff_integrations (id),
        assertion_id    TEXT NOT NULL,
        assertion_hash  TEXT NOT NULL,
        expires_at      TIMESTAMPTZ NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_handoff_assertions_unique_per_integration
          UNIQUE (integration_id, assertion_id),
        CONSTRAINT handyman_handoff_assertions_hash_check
          CHECK (assertion_hash ~ '^[0-9a-f]{64}$')
      )
    `);

    await client.query(`
      CREATE TABLE handyman_handoff_exchanges (
        id                            UUID PRIMARY KEY,
        integration_id                UUID NOT NULL REFERENCES handyman_handoff_integrations (id),
        handoff_assertion_id          UUID NOT NULL REFERENCES handyman_handoff_assertions (id),
        token_hash                    TEXT NOT NULL,
        client_id                     UUID NOT NULL REFERENCES clients (id),
        tenant_company_id             UUID NOT NULL REFERENCES tenant_companies (id),
        tenant_pic_id                 UUID REFERENCES tenant_pics (id),
        building_id                   UUID NOT NULL REFERENCES buildings (id),
        space_id                      UUID REFERENCES spaces (id),
        tenant_building_context_id    UUID NOT NULL REFERENCES tenant_building_contexts (id),
        tenant_space_relationship_id  UUID REFERENCES tenant_space_relationships (id),
        resolved_user_id              UUID REFERENCES users (id),
        status                        TEXT NOT NULL DEFAULT 'ACTIVE',
        expires_at                    TIMESTAMPTZ NOT NULL,
        used_at                       TIMESTAMPTZ,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_handoff_exchanges_token_hash_unique
          UNIQUE (token_hash),
        CONSTRAINT handyman_handoff_exchanges_token_hash_check
          CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT handyman_handoff_exchanges_status_check
          CHECK (status IN ('ACTIVE', 'USED')),
        CONSTRAINT handyman_handoff_exchanges_used_at_check
          CHECK (status = 'USED' OR used_at IS NULL)
      )
    `);

    await client.query(`
      CREATE INDEX handyman_handoff_exchanges_client_idx
        ON handyman_handoff_exchanges (client_id, status);
      CREATE INDEX handyman_handoff_exchanges_expiry_idx
        ON handyman_handoff_exchanges (expires_at);
      CREATE INDEX handyman_handoff_assertions_integration_idx
        ON handyman_handoff_assertions (integration_id, created_at);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_handoff_assertions_append_only()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $handyman_handoff_assertions_append_only$
      BEGIN
        RAISE EXCEPTION 'handyman_handoff_assertions is append-only; % is not permitted.', TG_OP
          USING ERRCODE = '23514';
      END;
      $handyman_handoff_assertions_append_only$;

      CREATE TRIGGER handyman_handoff_assertions_no_update
        BEFORE UPDATE ON handyman_handoff_assertions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_handoff_assertions_append_only();

      CREATE TRIGGER handyman_handoff_assertions_no_delete
        BEFORE DELETE ON handyman_handoff_assertions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_handoff_assertions_append_only();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_handoff_exchanges');
    await client.query('DROP TABLE IF EXISTS handyman_handoff_assertions');
    await client.query('DROP TABLE IF EXISTS handyman_handoff_integrations');
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_handoff_assertions_append_only()',
    );
  },
};
