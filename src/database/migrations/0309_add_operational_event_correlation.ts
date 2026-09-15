import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-AUDIT-01 PART 02 — additive operational-event correlation.
 *
 * `request_id` is nullable so every historical BE-07 event remains valid and
 * is never assigned a fabricated identifier. New HTTP events receive the
 * server-generated request UUID from the request-local context; future
 * scheduler/system execution will use the same column with its own source.
 * `source` is nullable for the same historical/standalone compatibility
 * boundary and is constrained to the governed vocabulary when present.
 */
export const migration0309AddOperationalEventCorrelation: Migration = {
  id: '0309_add_operational_event_correlation',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_events
        ADD COLUMN request_id UUID,
        ADD COLUMN source TEXT,
        ADD CONSTRAINT operational_events_source_check
          CHECK (source IS NULL OR source IN ('HTTP', 'SCHEDULER', 'SYSTEM'))
    `);

    // Exact request/correlation lookup is the new access pattern. Existing
    // Client/Building/entity indexes remain the authorities for their filters;
    // source is a low-cardinality discriminator and is deliberately not
    // indexed independently.
    await client.query(`
      CREATE INDEX operational_events_request_id_idx
        ON operational_events (request_id)
        WHERE request_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS operational_events_request_id_idx;
      ALTER TABLE operational_events
        DROP CONSTRAINT IF EXISTS operational_events_source_check,
        DROP COLUMN IF EXISTS request_id,
        DROP COLUMN IF EXISTS source
    `);
  },
};
