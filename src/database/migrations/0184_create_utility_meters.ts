import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18A — Meter Master.
 *
 * The authoritative Utility Meter master record. A Meter is a physical
 * measuring device installed in exactly one Building
 * (Client → Property → Building → Meter). `client_id` is denormalized for
 * isolation but derived authoritatively by the service through
 * Building → Property → Client, so it can never drift from BE-02.
 *
 * Reuse, never duplicate:
 *   - Building / Space / Functional Location remain BE-04's masters; this
 *     table stores references only (`building_id` required, `space_id` /
 *     `functional_location_id` optional finer placement, both validated by
 *     the service to resolve to the SAME Building).
 *   - `uom_id` reuses the BE-07 `units_of_measure` foundation (same Client +
 *     ACTIVE, enforced by the service). No unit/measurement master is
 *     re-created here.
 *
 * `code` is the stable machine-readable identifier, normalized to uppercase
 * by the service, and unique per Client (`client_id + code`) — the Client
 * scope required by BE-18A, matching the inventory-item / asset precedent.
 *
 * `serial_number` holds the manufacturer serial / utility reference number
 * where applicable (optional; not every meter exposes one).
 *
 * `utility_type` is constrained to ELECTRICITY / WATER / GAS. Type-specific
 * behavior is deliberately NOT branched here — BE-18B owns that.
 *
 * Deliberately absent (later BE-18 parts): main/sub meter hierarchy (BE-18C),
 * tenant meter binding (BE-18D), readings (BE-18E), evidence (BE-18F),
 * consumption (BE-18G). No billing or accounting data ever lives in BE-18.
 *
 * INACTIVE meters remain persisted — never hard-deleted through normal
 * lifecycle operations.
 */
export const migration0184CreateUtilityMeters: Migration = {
  id: '0184_create_utility_meters',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_meters (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        space_id               UUID REFERENCES spaces (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        code                   TEXT NOT NULL,
        name                   TEXT NOT NULL,
        utility_type           TEXT NOT NULL,
        uom_id                 UUID NOT NULL REFERENCES units_of_measure (id),
        serial_number          TEXT,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_meters_client_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT utility_meters_utility_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_meters_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX utility_meters_client_idx
        ON utility_meters (client_id, status);
      CREATE INDEX utility_meters_building_idx
        ON utility_meters (building_id, status);
      CREATE INDEX utility_meters_utility_type_idx
        ON utility_meters (utility_type, status);
      CREATE INDEX utility_meters_uom_idx
        ON utility_meters (uom_id);
      CREATE INDEX utility_meters_space_idx
        ON utility_meters (space_id)
        WHERE space_id IS NOT NULL;
      CREATE INDEX utility_meters_location_idx
        ON utility_meters (functional_location_id)
        WHERE functional_location_id IS NOT NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_meters');
  },
};
