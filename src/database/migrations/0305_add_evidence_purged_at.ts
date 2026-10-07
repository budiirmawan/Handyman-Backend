import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-DOC-CONTROL-01 PART 04 — purge tombstone timestamp.
 *
 * `purged_at` records WHEN the stored binary of a governed evidence
 * submission was disposed. The row itself is NEVER deleted (START GOVERNANCE
 * §7): it survives as a metadata tombstone (hash, size, MIME, original file
 * name, retention snapshot all retained) so existing FKs
 * (`bast_evidence_bindings`, `utility_meter_ocr_candidates`) and external
 * references never dangle.
 *
 * The consistency CHECK makes a tombstone impossible without its timestamp
 * and vice versa.
 */
export const migration0305AddEvidencePurgedAt: Migration = {
  id: '0305_add_evidence_purged_at',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions
        ADD COLUMN purged_at TIMESTAMPTZ,
        ADD CONSTRAINT evidence_purged_at_consistency CHECK (
          (retention_state = 'PURGED' AND purged_at IS NOT NULL)
          OR
          (retention_state <> 'PURGED' AND purged_at IS NULL)
        )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT IF EXISTS evidence_purged_at_consistency,
        DROP COLUMN IF EXISTS purged_at
    `);
  },
};
