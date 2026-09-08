import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-ESG-01 PART 02 — Waste Operational Records.
 *
 * Building-scoped operational waste measurement, defined by
 * `docs/CR-BE-ESG-01_START_GOVERNANCE.md` §4.3 / §5:
 *
 * - Client ownership derived via Building → Property → Client (same as
 *   assets, utility meters), never from caller. `client_id` stored
 *   structurally for isolation and future composite FKs.
 * - Optional `functional_location_id` refinement, must belong to same Building.
 * - `waste_type` CHECK GENERAL/ORGANIC/RECYCLABLE/HAZARDOUS/E_WASTE/CONSTRUCTION/OTHER.
 * - `disposal_method` CHECK LANDFILL/RECYCLED/COMPOSTED/INCINERATED/REUSED/DONATED/OTHER.
 * - `quantity` NUMERIC >=0, governed `uom_id` FK (kg/ton/m3) NOT NULL, same
 *   Client + ACTIVE enforced in service layer.
 * - `period_date` DATE (operational date), source_type MANUAL/IMPORT/SYSTEM.
 * - Optional `vendor_id` FK vendors, same Client enforced in service layer.
 * - Lifecycle ACTIVE → INACTIVE terminal (reference operational pattern),
 *   no DRAFT, no scheduler, no backfill.
 *
 * No metric values, aggregation, recycling-rate KPI, baselines/targets,
 * verification workflow, evidence bindings, environmental records, emissions,
 * or reporting. Waste only.
 */
export const migration0327CreateEsgWasteRecords: Migration = {
  id: '0327_create_esg_waste_records',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE esg_waste_records (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        waste_type            TEXT NOT NULL,
        disposal_method       TEXT NOT NULL,
        quantity              NUMERIC NOT NULL,
        uom_id                UUID NOT NULL REFERENCES units_of_measure (id),
        period_date           DATE NOT NULL,
        source_type           TEXT NOT NULL DEFAULT 'MANUAL',
        vendor_id             UUID REFERENCES vendors (id),
        notes                 TEXT,
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT esg_waste_records_quantity_check
          CHECK (quantity >= 0),
        CONSTRAINT esg_waste_records_waste_type_check
          CHECK (waste_type IN ('GENERAL','ORGANIC','RECYCLABLE','HAZARDOUS','E_WASTE','CONSTRUCTION','OTHER')),
        CONSTRAINT esg_waste_records_disposal_method_check
          CHECK (disposal_method IN ('LANDFILL','RECYCLED','COMPOSTED','INCINERATED','REUSED','DONATED','OTHER')),
        CONSTRAINT esg_waste_records_source_type_check
          CHECK (source_type IN ('MANUAL','IMPORT','SYSTEM')),
        CONSTRAINT esg_waste_records_status_check
          CHECK (status IN ('ACTIVE','INACTIVE')),
        CONSTRAINT esg_waste_records_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
        CONSTRAINT esg_waste_records_period_date_check
          CHECK (period_date IS NOT NULL)
      )
    `);

    await client.query(`
      CREATE INDEX esg_waste_records_client_idx
        ON esg_waste_records (client_id, status);
      CREATE INDEX esg_waste_records_building_idx
        ON esg_waste_records (building_id, period_date DESC);
      CREATE INDEX esg_waste_records_building_type_idx
        ON esg_waste_records (building_id, waste_type, disposal_method, period_date DESC);
      CREATE INDEX esg_waste_records_vendor_idx
        ON esg_waste_records (vendor_id)
        WHERE vendor_id IS NOT NULL;
      CREATE INDEX esg_waste_records_uom_idx
        ON esg_waste_records (uom_id);
      CREATE INDEX esg_waste_records_floc_idx
        ON esg_waste_records (functional_location_id)
        WHERE functional_location_id IS NOT NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS esg_waste_records');
  },
};
