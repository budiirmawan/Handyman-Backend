import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-SLA-01 PART 04 — durable first-breach history. */
export const migration0294AddSlaClockBreach: Migration = {
  id: '0294_add_sla_clock_breach',
  async up(c: PoolClient): Promise<void> {
    await c.query(`ALTER TABLE sla_clocks ADD COLUMN breached_at TIMESTAMPTZ`);
    await c.query(`CREATE INDEX sla_clocks_breach_due_idx ON sla_clocks(status, breached_at) WHERE status='RUNNING' AND breached_at IS NULL`);
  },
  async down(c: PoolClient): Promise<void> { await c.query('DROP INDEX IF EXISTS sla_clocks_breach_due_idx; ALTER TABLE sla_clocks DROP COLUMN IF EXISTS breached_at'); },
};
