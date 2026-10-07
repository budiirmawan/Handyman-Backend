import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02C — Module catalogue foundation.
 *
 * A lightweight authoritative catalogue of commercially entitleable Asentra
 * modules. `code` is the stable, unique, machine-readable identifier
 * (e.g. `ENGINEERING`, `HOUSEKEEPING`) independent of display name. The
 * database/catalogue is authoritative — module codes are never hardcoded into
 * authorization logic.
 *
 * An INACTIVE module must not resolve as effectively entitled, and modules are
 * not physically deleted through normal lifecycle operations.
 */
export const migration0015CreateModules: Migration = {
  id: '0015_create_modules',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE modules (
        id UUID PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT modules_code_unique UNIQUE (code),
        CONSTRAINT modules_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS modules');
  },
};
