import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — field reading recheck / correction.
 *
 * ONE EXISTING PRIMITIVE, EXTENDED — NOT A SECOND WORKFLOW ENGINE
 * ---------------------------------------------------------------
 * BE-18E Meter Readings are append-only and immutable: there is no UPDATE or
 * DELETE path for a reading anywhere in this repository, and PART 03 does not
 * add one. A correction therefore cannot be expressed on the reading row. It is
 * expressed on the EXISTING cross-Utility operational exception register
 * (CR-BE-UTL-01 PART 15, migration 0282), which already:
 *
 *   - references a Meter Reading AND its Reading Due (`meter_reading_id`,
 *     `reading_due_id`), so a recheck is explicitly linked to the original
 *     reading rather than floating free;
 *   - owns exactly the lifecycle a recheck needs — OPEN → UNDER_REVIEW →
 *     RESOLVED, plus terminal CANCELLED — with database-enforced stamps for
 *     reviewer, resolution and cancellation;
 *   - enforces ONE active exception per (type, source), so a reading can never
 *     accumulate two live rechecks while resolved history stays append-only;
 *   - writes canonical `UTILITY_EXCEPTION_*` operational events.
 *
 * NO NEW LIFECYCLE STATE is introduced. The four columns below carry the
 * recheck's PAYLOAD — the measurement the technician re-read, and the reading
 * that payload became if it was accepted — and the `READING_RECHECK` exception
 * type names the concern. States remain the register's own.
 *
 *   proposed_reading_value / _at / _notes
 *       The reread, STAGED. A reread is not a reading: it becomes one only when
 *       a human accepts the replacement, and a rejected or cancelled recheck
 *       leaves the canonical reading history exactly as it was. Staging it here
 *       is what makes "creates a NEW reading only when the replacement is
 *       accepted" enforceable — an immutable reading can never be un-created,
 *       so a speculative one must never be created in the first place.
 *
 *   replacement_meter_reading_id
 *       Set at resolution, in the SAME transaction that creates the replacement
 *       through the canonical BE-18E application service. It makes the
 *       original ↔ replacement relation auditable in both directions from the
 *       one row that already holds `meter_reading_id` (the original), and the
 *       unique partial index below makes a replacement belong to exactly one
 *       recheck. The original reading is never edited, never deleted and never
 *       unlinked from its Reading Due.
 *
 * The `READING_RECHECK` type is admitted by replacing the register's own type
 * CHECK with the identical list plus one token: no existing type is renamed,
 * removed or reinterpreted, and every existing row keeps its meaning.
 */
export const migration0351AddUtilityExceptionReadingRecheck: Migration = {
  id: '0351_add_utility_exception_reading_recheck',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE utility_operational_exceptions
        ADD COLUMN replacement_meter_reading_id UUID
          REFERENCES utility_meter_readings (id),
        ADD COLUMN proposed_reading_value NUMERIC,
        ADD COLUMN proposed_reading_at TIMESTAMPTZ,
        ADD COLUMN proposed_reading_notes TEXT
    `);

    await client.query(`
      ALTER TABLE utility_operational_exceptions
        DROP CONSTRAINT utility_exception_type_check
    `);
    await client.query(`
      ALTER TABLE utility_operational_exceptions
        ADD CONSTRAINT utility_exception_type_check CHECK (exception_type IN (
          'ABNORMAL_CONSUMPTION', 'MISSING_OR_LATE_READING',
          'OCR_MANUAL_FOLLOW_UP', 'RECONCILIATION_VARIANCE',
          'UNALLOCATED_CONSUMPTION', 'OTHER', 'READING_RECHECK'
        ))
    `);

    // The recheck payload belongs to a recheck, is staged as one unit, mirrors
    // BE-18E's own non-negative value rule, and a replacement reading exists
    // only on a RESOLVED recheck that actually staged a reread.
    await client.query(`
      ALTER TABLE utility_operational_exceptions
        ADD CONSTRAINT utility_exception_recheck_check CHECK (
          (proposed_reading_value IS NULL OR exception_type = 'READING_RECHECK')
          AND (proposed_reading_value IS NULL OR proposed_reading_value >= 0)
          AND (proposed_reading_at IS NULL OR proposed_reading_value IS NOT NULL)
          AND (proposed_reading_notes IS NULL OR proposed_reading_value IS NOT NULL)
          AND (replacement_meter_reading_id IS NULL
            OR (exception_type = 'READING_RECHECK'
                AND status = 'RESOLVED'
                AND proposed_reading_value IS NOT NULL))
        )
    `);

    // One recheck owns a replacement reading, and the field projection of a
    // reading's rechecks is an index lookup rather than a scan.
    await client.query(`
      CREATE UNIQUE INDEX utility_exception_replacement_unique
        ON utility_operational_exceptions (replacement_meter_reading_id)
        WHERE replacement_meter_reading_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX utility_exception_meter_reading_idx
        ON utility_operational_exceptions (meter_reading_id, exception_type, status)
        WHERE meter_reading_id IS NOT NULL
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP INDEX IF EXISTS utility_exception_meter_reading_idx',
    );
    await client.query('DROP INDEX IF EXISTS utility_exception_replacement_unique');
    await client.query(
      'ALTER TABLE utility_operational_exceptions DROP CONSTRAINT IF EXISTS utility_exception_recheck_check',
    );
    await client.query(
      'ALTER TABLE utility_operational_exceptions DROP CONSTRAINT IF EXISTS utility_exception_type_check',
    );
    await client.query(`
      ALTER TABLE utility_operational_exceptions
        ADD CONSTRAINT utility_exception_type_check CHECK (exception_type IN (
          'ABNORMAL_CONSUMPTION', 'MISSING_OR_LATE_READING',
          'OCR_MANUAL_FOLLOW_UP', 'RECONCILIATION_VARIANCE',
          'UNALLOCATED_CONSUMPTION', 'OTHER'
        ))
    `);
    await client.query(`
      ALTER TABLE utility_operational_exceptions
        DROP COLUMN IF EXISTS proposed_reading_notes,
        DROP COLUMN IF EXISTS proposed_reading_at,
        DROP COLUMN IF EXISTS proposed_reading_value,
        DROP COLUMN IF EXISTS replacement_meter_reading_id
    `);
  },
};
