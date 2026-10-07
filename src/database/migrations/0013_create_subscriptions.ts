import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02B — Subscription foundation.
 *
 * A Subscription is the commercial state of an Asentra Client: the
 * company/customer's active commercial relationship. It belongs to exactly
 * one Client (commercial boundary, BE-02A). `code` is the stable business
 * identifier (e.g. `ASENTRA-2026-001`) and must be unique; `plan_code` is a
 * lightweight commercial reference only — never a driver of module
 * entitlement (that is BE-02C).
 *
 * Status lifecycle: PENDING → ACTIVE → SUSPENDED / EXPIRED / CANCELLED.
 */
export const migration0013CreateSubscriptions: Migration = {
  id: '0013_create_subscriptions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE subscriptions (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL,
        code TEXT NOT NULL,
        plan_code TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT subscriptions_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT subscriptions_code_unique UNIQUE (code),
        CONSTRAINT subscriptions_status_check
          CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED')),
        CONSTRAINT subscriptions_period_check
          CHECK (ends_at IS NULL OR ends_at > starts_at)
      )
    `);
    await client.query(
      `CREATE INDEX subscriptions_client_id_idx ON subscriptions (client_id)`,
    );
    await client.query(
      `CREATE INDEX subscriptions_status_idx ON subscriptions (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS subscriptions');
  },
};
