import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-06 PART 03 — quotation lifecycle integrity (FROZEN F2/F3).
 *
 * Smallest additive change required to enforce the PART 03 invariant
 * "at most one current ISSUED version per quotation thread" at the
 * database level (replacement issuance is atomic but concurrent ISO
 * transactions still need the backstop): a partial unique index over
 * currently-ISSUED rows only. NO new table, NO history table, NO new
 * columns (PART 01 already reserved status/valid_until projection).
 */
export const migration0393HandymanQuotationIssuedUniqueness: Migration = {
  id: '0393_handyman_quotation_issued_uniqueness',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE UNIQUE INDEX handyman_quotation_versions_one_issued_idx
        ON handyman_quotation_versions (quotation_id)
        WHERE status = 'ISSUED'
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS handyman_quotation_versions_one_issued_idx
    `);
  },
};
