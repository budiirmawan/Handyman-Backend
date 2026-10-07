import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-02 PART 04 — Handyman request-intake evidence admission (frozen
 * D1/D2). Minimum, Handyman-bounded schema change following the documented
 * evidence parent-admission convention (the same mechanism that admitted
 * e.g. UTILITY_METER_READING / DAILY_CLEANING):
 *
 *   - `evidence_submission_execution` CHECK gains `HANDYMAN_REQUEST` — the
 *     bounded Handyman request-intake PARENT kind only;
 *   - `evidence_submission_type` CHECK gains `VIDEO` — registered ONLY for
 *     the bounded Handyman intake capability (frozen D2). This is a
 *     deliberate type registration through the sanctioned extension
 *     mechanism, not a global semantic expansion: the application's MIME/
 *     size policy binds VIDEO exclusively to the HANDYMAN_REQUEST parent,
 *     and no other parent creates VIDEO rows.
 *
 * Everything else is untouched: the shared 50 MB storage-size CHECK, hash
 * consistency, integrity metadata, retention machinery, and every existing
 * parent/type contract stay exactly as they are. Down restores both CHECKs
 * to today's exact definition lists.
 */
export const migration0379AdmitHandymanRequestEvidence: Migration = {
  id: '0379_admit_handyman_request_evidence',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution
          CHECK (execution_type IN (
            'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
            'VENDOR_WORK', 'UTILITY_METER_READING', 'PERMIT', 'FINDING',
            'FINDING_REWORK', 'FINDING_VERIFICATION', 'HANDYMAN_REQUEST'))
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_type,
        ADD CONSTRAINT evidence_submission_type
          CHECK (evidence_type IN ('PHOTO', 'DOCUMENT', 'SIGNATURE', 'VIDEO'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_type,
        ADD CONSTRAINT evidence_submission_type
          CHECK (evidence_type IN ('PHOTO', 'DOCUMENT', 'SIGNATURE'))
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution
          CHECK (execution_type IN (
            'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
            'VENDOR_WORK', 'UTILITY_METER_READING', 'PERMIT', 'FINDING',
            'FINDING_REWORK', 'FINDING_VERIFICATION'))
    `);
  },
};
