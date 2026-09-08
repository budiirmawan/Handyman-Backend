import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18C — Main / Sub Meter hierarchy.
 *
 * Records which BE-18A Meter feeds which other BE-18A Meter:
 *
 *   Main Meter → relationship → Sub Meter
 *
 * Both sides are existing `utility_meters` rows — no meter data is copied or
 * re-declared here, and `utility_meters` itself is deliberately NOT altered.
 * Putting a `main_meter_id` column on the Meter would allow only one parent
 * ever, would lose the relationship's own lifecycle, and would silently
 * overwrite history on every re-bind. A relationship table keeps the
 * hierarchy addressable, dateable, and auditable.
 *
 * `client_id` is denormalised in from the Meters so hierarchy queries can be
 * Client-scoped at the database level (docs/data-isolation.md) instead of
 * being filtered in memory after a global fetch. The service derives it —
 * it is never accepted from a caller.
 *
 * Constraints encoded here:
 *   - self-reference is impossible at the storage layer,
 *   - the effective window must not end before it starts,
 *   - a *partial* unique index gives each Sub Meter at most one ACTIVE Main
 *     Meter at a time, while deactivated rows are retained as history.
 *
 * Rules the schema cannot express — utility type compatibility, cross-Client
 * and cross-Building rejection, INACTIVE meters, and circular hierarchies of
 * any depth (A → B → C → A) — live in the service layer.
 *
 * Out of scope (later parts): Tenant Meter (BE-18D), readings (BE-18E),
 * consumption (BE-18G). Billing and accounting never live in BE-18.
 */
export const migration0186CreateUtilityMeterHierarchies: Migration = {
  id: '0186_create_utility_meter_hierarchies',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_meter_hierarchies (
        id              UUID PRIMARY KEY,
        client_id       UUID NOT NULL REFERENCES clients (id),
        main_meter_id   UUID NOT NULL REFERENCES utility_meters (id),
        sub_meter_id    UUID NOT NULL REFERENCES utility_meters (id),
        effective_from  TIMESTAMPTZ,
        effective_until TIMESTAMPTZ,
        status          TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_meter_hierarchies_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT utility_meter_hierarchies_no_self_reference_check
          CHECK (main_meter_id <> sub_meter_id),
        CONSTRAINT utility_meter_hierarchies_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    // At most one ACTIVE Main Meter per Sub Meter; INACTIVE history is kept so
    // a re-bind stays auditable.
    await client.query(`
      CREATE UNIQUE INDEX utility_meter_hierarchies_active_sub_unique
        ON utility_meter_hierarchies (sub_meter_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX utility_meter_hierarchies_main_idx
        ON utility_meter_hierarchies (main_meter_id, status);
      CREATE INDEX utility_meter_hierarchies_sub_idx
        ON utility_meter_hierarchies (sub_meter_id, status);
      CREATE INDEX utility_meter_hierarchies_client_idx
        ON utility_meter_hierarchies (client_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_meter_hierarchies');
  },
};
