import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18E — Meter Reading.
 *
 * BE-18 is authoritative for Meter Reading data:
 *
 *   Meter → reading (value + UOM + reading_at + recorded_by)
 *
 * The reading references an existing BE-18A Meter and an existing BE-07
 * `units_of_measure` row; no meter or measurement master data is copied.
 *
 * BE-10C integration — NOT a second source of truth
 * -------------------------------------------------
 * BE-10C owns the *engineering* meter-reading workflow: an Asset plus a BE-07
 * numeric Form Field, executed as a shared BE-07 Form Instance whose captured
 * number lives in BE-07 `form_responses`. That workflow keeps its store and is
 * not duplicated or migrated here.
 *
 * BE-18E is the utility-meter reading ledger, a different subject (BE-18A
 * `utility_meters`, not BE-05 assets). Where an engineering round produces a
 * utility reading, the BE-18E row *links back* to that context through
 * `meter_reading_binding_id` and `form_instance_id` instead of re-recording
 * the workflow. A partial unique index on `form_instance_id` guarantees one
 * engineering execution can post at most one utility reading, so the two
 * stores can never disagree about how many readings an execution produced.
 *
 * History and immutability
 * ------------------------
 * Readings are append-only: there is no update or delete path in BE-18E, so a
 * posted reading can never be silently overwritten or removed. A correction is
 * a new reading, and the chronological trail is preserved in full. A unique
 * index on (meter_id, reading_at) keeps the timeline unambiguous — one reading
 * per meter per instant.
 *
 * Tenant context (BE-18D) is captured as it stood when the reading was taken:
 * `tenant_assignment_id` links the assignment, and `tenant_company_id` records
 * which tenant it actually was. That is a point-in-time fact, not duplicated
 * master data — after a tenancy turnover it can no longer be re-derived, and
 * later billing must not silently re-attribute historical readings.
 *
 * Out of scope here: consumption / delta calculation (BE-18G) and Reading
 * Evidence (BE-18F). Billing and accounting never live in BE-18.
 */
export const migration0188CreateUtilityMeterReadings: Migration = {
  id: '0188_create_utility_meter_readings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_meter_readings (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        meter_id                 UUID NOT NULL REFERENCES utility_meters (id),
        uom_id                   UUID NOT NULL REFERENCES units_of_measure (id),
        reading_value            NUMERIC NOT NULL,
        reading_at               TIMESTAMPTZ NOT NULL,
        source                   TEXT NOT NULL DEFAULT 'MANUAL',
        reading_type             TEXT NOT NULL DEFAULT 'ACTUAL',
        notes                    TEXT,
        recorded_by_user_id      UUID NOT NULL REFERENCES users (id),
        tenant_assignment_id     UUID
          REFERENCES utility_meter_tenant_assignments (id),
        tenant_company_id        UUID REFERENCES tenant_companies (id),
        meter_reading_binding_id UUID REFERENCES meter_reading_bindings (id),
        form_instance_id         UUID REFERENCES form_instances (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_meter_readings_source_check
          CHECK (source IN ('MANUAL', 'ENGINEERING', 'IMPORT', 'SYSTEM')),
        CONSTRAINT utility_meter_readings_type_check
          CHECK (reading_type IN ('ACTUAL', 'ESTIMATED')),
        CONSTRAINT utility_meter_readings_value_check
          CHECK (reading_value >= 0)
      )
    `);

    // One reading per meter per instant: a repeated timestamp is a duplicate
    // submission, not a second measurement.
    await client.query(`
      CREATE UNIQUE INDEX utility_meter_readings_meter_instant_unique
        ON utility_meter_readings (meter_id, reading_at)
    `);

    // A BE-10C engineering execution may post at most one utility reading.
    await client.query(`
      CREATE UNIQUE INDEX utility_meter_readings_form_instance_unique
        ON utility_meter_readings (form_instance_id)
        WHERE form_instance_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX utility_meter_readings_meter_chronology_idx
        ON utility_meter_readings (meter_id, reading_at DESC);
      CREATE INDEX utility_meter_readings_building_idx
        ON utility_meter_readings (building_id, reading_at DESC);
      CREATE INDEX utility_meter_readings_client_idx
        ON utility_meter_readings (client_id, reading_at DESC);
      CREATE INDEX utility_meter_readings_tenant_idx
        ON utility_meter_readings (tenant_company_id, reading_at DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_meter_readings');
  },
};
