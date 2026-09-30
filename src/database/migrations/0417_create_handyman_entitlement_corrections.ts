import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-HM-14 PART 02: forward-only corrections to an EARNED fact.
 * Cause ids come exclusively from the published CR-HM-13 PART 06 read;
 * no ledger table is modified and no ledger correction FK is introduced.
 * No lifecycle/settlement state lives here.
 */
export const migration0417CreateHandymanEntitlementCorrections: Migration = {
  id: '0417_create_handyman_entitlement_corrections',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_entitlement_corrections (
        id UUID PRIMARY KEY,
        entitlement_id UUID NOT NULL REFERENCES handyman_entitlement_facts (id),
        ledger_correction_id UUID NOT NULL,
        fact_kind TEXT NOT NULL CHECK (fact_kind IN (
          'ADJUSTED_INCREASE', 'ADJUSTED_DECREASE', 'REVERSED')),
        amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        actor_user_id UUID NOT NULL REFERENCES users (id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_entitlement_correction_cause_unique
          UNIQUE (entitlement_id, ledger_correction_id)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX hm_entitlement_one_reversal
        ON handyman_entitlement_corrections (entitlement_id)
        WHERE fact_kind = 'REVERSED'
    `);
    await client.query(`
      CREATE FUNCTION handyman_entitlement_correction_no_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman entitlement corrections are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER hm_entitlement_correction_immutable
        BEFORE UPDATE OR DELETE ON handyman_entitlement_corrections
        FOR EACH ROW EXECUTE FUNCTION handyman_entitlement_correction_no_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_entitlement_corrections');
    await client.query('DROP FUNCTION IF EXISTS handyman_entitlement_correction_no_mutation()');
  },
};
