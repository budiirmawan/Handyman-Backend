import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-09C — one generic primary operational source per Finding. */
export const migration0092AddFindingSourceBinding: Migration = {
  id: '0092_add_finding_source_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE findings
        ADD COLUMN source_type TEXT,
        ADD COLUMN source_id UUID,
        ADD CONSTRAINT finding_source_type CHECK (
          source_type IS NULL OR source_type IN (
            'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER'
          )
        ),
        ADD CONSTRAINT finding_source_complete CHECK (
          (source_type IS NULL AND source_id IS NULL) OR
          (source_type IS NOT NULL AND source_id IS NOT NULL)
        );

      CREATE INDEX findings_source_idx
        ON findings (source_type, source_id)
        WHERE source_type IS NOT NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE findings
        DROP COLUMN IF EXISTS source_id,
        DROP COLUMN IF EXISTS source_type
    `);
  },
};
