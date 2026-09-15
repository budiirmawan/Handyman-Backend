import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * Proves the migration runner. Does not create Asentra business tables.
 */
export const migration0001InitialFoundation: Migration = {
  id: '0001_initial_foundation',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE schema_foundation (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        established_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('INSERT INTO schema_foundation DEFAULT VALUES');
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS schema_foundation');
  },
};
