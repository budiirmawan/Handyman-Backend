import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10C — Meter Reading Binding.
 *
 * The minimal Engineering binding that associates a BE-05 Asset / Equipment
 * with a BE-07 numeric Form Field (the meter-reading definition, which itself
 * carries UOM / min / max / precision through BE-07's measurement config),
 * a BE-07 UOM, and an optional BE-04 Functional Location refinement.
 *
 * This table holds references only — Asset, Form, UOM, Evidence, and
 * Verification masters are never duplicated. Readings are submitted into
 * BE-07's own `form_responses` store.
 *
 * `client_id` / `building_id` are stored directly but derived authoritatively
 * by the service from Asset → Building → Property → Client, so isolation can
 * never drift from BE-02.
 *
 * The binding may tighten (never widen) the field's configured range:
 * `minimum_value` / `maximum_value` here must sit within the Form Field's own
 * measurement range, which the service enforces.
 *
 * One ACTIVE binding per (Asset, Field) is enforced by a partial unique index
 * — the same BE-07 idiom — so duplicate active bindings are impossible while
 * INACTIVE history is retained.
 */
export const migration0100CreateMeterReadingBindings: Migration = {
  id: '0100_create_meter_reading_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE meter_reading_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        asset_id               UUID NOT NULL REFERENCES assets (id),
        form_field_id          UUID NOT NULL REFERENCES form_fields (id),
        uom_id                 UUID NOT NULL REFERENCES units_of_measure (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        minimum_value          NUMERIC,
        maximum_value          NUMERIC,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT meter_reading_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT meter_reading_binding_range
          CHECK (
            minimum_value IS NULL
            OR maximum_value IS NULL
            OR minimum_value <= maximum_value
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX meter_reading_binding_active_unique
        ON meter_reading_bindings (asset_id, form_field_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX meter_reading_bindings_asset_idx
        ON meter_reading_bindings (asset_id, status);
      CREATE INDEX meter_reading_bindings_building_idx
        ON meter_reading_bindings (building_id, status);
      CREATE INDEX meter_reading_bindings_field_idx
        ON meter_reading_bindings (form_field_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS meter_reading_bindings');
  },
};
