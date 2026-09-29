import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-01 PART 01 — Handyman Channel Attribution foundation.
 *
 * Append-only store for trusted Handyman channel attribution, created from
 * server-side resolved context only (tenant company / PIC, building, optional
 * space, originating channel + external origin reference). No UPDATE or
 * DELETE path exists: a future privileged correction mechanism, if ever
 * approved, would be a separately governed change.
 *
 * Audit-compatible creation semantics: server-generated id and created_at,
 * nullable created_by_user_id attribution; actual audit/operational-event
 * recording is added by the binding/handler PARTs.
 *
 * Channel Attribution != BM financial entitlement != SaaS entitlement.
 */
export const migration0374CreateHandymanChannelAttributions: Migration = {
  id: '0374_create_handyman_channel_attributions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_channel_attributions (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        tenant_company_id  UUID NOT NULL REFERENCES tenant_companies (id),
        tenant_pic_id      UUID REFERENCES tenant_pics (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        space_id           UUID REFERENCES spaces (id),
        origin_channel     TEXT NOT NULL,
        origin_reference   TEXT,
        created_by_user_id UUID REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_channel_attributions_origin_channel_check
          CHECK (origin_channel IN ('BM_SUPER_APP')),
        CONSTRAINT handyman_channel_attributions_origin_reference_check
          CHECK (
            origin_reference IS NULL
            OR char_length(origin_reference) BETWEEN 1 AND 255
          )
      )
    `);

    await client.query(`
      -- One external origin reference can bind to at most one attribution:
      -- prevents accidental duplicate/conflicting binding of the same
      -- originating context. Rows without a reference cannot conflict.
      CREATE UNIQUE INDEX handyman_channel_attributions_origin_reference_unique
        ON handyman_channel_attributions (origin_channel, origin_reference)
        WHERE origin_reference IS NOT NULL;
      CREATE INDEX handyman_channel_attributions_client_idx
        ON handyman_channel_attributions (client_id);
      CREATE INDEX handyman_channel_attributions_tenant_building_idx
        ON handyman_channel_attributions (tenant_company_id, building_id);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_channel_attributions_append_only()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $handyman_channel_attributions_append_only$
      BEGIN
        RAISE EXCEPTION 'handyman_channel_attributions is append-only; % is not permitted.', TG_OP
          USING ERRCODE = '23514';
      END;
      $handyman_channel_attributions_append_only$;

      CREATE TRIGGER handyman_channel_attributions_no_update
        BEFORE UPDATE ON handyman_channel_attributions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_channel_attributions_append_only();

      CREATE TRIGGER handyman_channel_attributions_no_delete
        BEFORE DELETE ON handyman_channel_attributions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_channel_attributions_append_only();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_channel_attributions');
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_channel_attributions_append_only()',
    );
  },
};
