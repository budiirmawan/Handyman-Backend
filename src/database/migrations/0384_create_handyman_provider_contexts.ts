import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-04 PART 01 — Handyman Provider Context (FROZEN F1/F8/F9/F10).
 *
 * Additive minimum (one new bounded table; reverting `down`; ZERO changes
 * to `vendors` or any other existing table).
 *
 *   handyman_provider_contexts   Handyman-owned operational context exactly
 *   once per vendor: `vendors` remains the provider identity master — this
 *   row carries ONLY Handyman eligibility/state (bounded status) + actor +
 *   timestamps. No vendor name/contact/PIC, compliance, capability, or
 *   commercial data is duplicated. Provider context != SaaS customer,
 *   != marketplace enablement (CR-HM-21), != provider assignment,
 *   != FM vendor workflow.
 *
 *   History of lifecycle state changes lives in the append-only
 *   operational-event authority (F10); the row's status/updated_at are
 *   the projection. Rows are never hard-deleted (INACTIVE = historical).
 */
export const migration0384CreateHandymanProviderContexts: Migration = {
  id: '0384_create_handyman_provider_contexts',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_provider_contexts (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        vendor_id          UUID NOT NULL,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_provider_contexts_vendor_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT handyman_provider_contexts_vendor_unique
          UNIQUE (vendor_id),
        CONSTRAINT handyman_provider_contexts_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_provider_contexts_scope_idx
        ON handyman_provider_contexts (client_id, created_at)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_provider_contexts CASCADE',
    );
  },
};
