import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** The variation QC event records the same Supervisor authority as the QC run.
 * Historical Operations labels remain readable; only NEW QC events are
 * constrained, with no rewrite of any previously recorded event. */
export const migration0443SeparateHandymanVariationQcAuthority: Migration = {
  id: '0443_separate_handyman_variation_qc_authority',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE handyman_scope_variation_events
        DROP CONSTRAINT handyman_scope_variation_events_actor_role_check,
        ADD CONSTRAINT handyman_scope_variation_events_actor_role_check
          CHECK (actor_role IN (
            'PIC_PEKERJAAN', 'INSPECTOR', 'OPERATIONS_MANAGER',
            'TENANT', 'SUPERVISOR'
          ));
      -- NOT VALID exempts historical Operations-labelled QC events but
      -- prohibits another one being inserted after this migration.
      ALTER TABLE handyman_scope_variation_events
        ADD CONSTRAINT handyman_scope_variation_qc_supervisor_event_check
          CHECK (event_type <> 'QC' OR actor_role = 'SUPERVISOR') NOT VALID;
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_scope_variation_events
                   WHERE actor_role = 'SUPERVISOR') THEN
          RAISE EXCEPTION 'Cannot remove Supervisor QC role while variation audit events use it';
        END IF;
      END $$;
      ALTER TABLE handyman_scope_variation_events
        DROP CONSTRAINT handyman_scope_variation_qc_supervisor_event_check,
        DROP CONSTRAINT handyman_scope_variation_events_actor_role_check,
        ADD CONSTRAINT handyman_scope_variation_events_actor_role_check
          CHECK (actor_role IN (
            'PIC_PEKERJAAN', 'INSPECTOR', 'OPERATIONS_MANAGER', 'TENANT'
          ));
    `);
  },
};
