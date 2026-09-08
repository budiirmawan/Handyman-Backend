import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03H — External / Vendor Workforce: extend the Workforce Profile type.
 *
 * The BE-03C enum recognised INTERNAL | OUTSOURCED | CONTRACT. External /
 * Vendor Workforce (BE-03H) needs its own authoritative value so the rest of
 * the domain can say "this profile is EXTERNAL" without overloading the other
 * two non-internal values:
 *
 *   INTERNAL   → the Client's own staff.
 *   OUTSOURCED → labour provided under an outsourcing agreement.
 *   CONTRACT   → a person engaged directly under a contract.
 *   EXTERNAL   → personnel supplied by an external organization / vendor,
 *                linked through `external_workforce_links` (BE-03H).
 *
 * Only the CHECK constraint widens here. No column is added, dropped, or
 * renamed, and existing rows keep their values — so no data is rewritten.
 */
export const migration0031AddExternalWorkforceType: Migration = {
  id: '0031_add_external_workforce_type',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE workforce_profiles
        DROP CONSTRAINT workforce_profiles_workforce_type_check
    `);

    await client.query(`
      ALTER TABLE workforce_profiles
        ADD CONSTRAINT workforce_profiles_workforce_type_check
          CHECK (workforce_type IN ('INTERNAL', 'OUTSOURCED', 'CONTRACT', 'EXTERNAL'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE workforce_profiles
        DROP CONSTRAINT workforce_profiles_workforce_type_check
    `);

    await client.query(`
      ALTER TABLE workforce_profiles
        ADD CONSTRAINT workforce_profiles_workforce_type_check
          CHECK (workforce_type IN ('INTERNAL', 'OUTSOURCED', 'CONTRACT'))
    `);
  },
};
