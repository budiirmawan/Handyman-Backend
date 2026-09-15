import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-ESG-01 PART 01 — ESG Metric Definition Foundation.
 *
 * Governed reference master for ESG metrics, defined by
 * `docs/CR-BE-ESG-01_START_GOVERNANCE.md` §4.6 / §5:
 *
 * - ONE flat, Client-scoped reference master, same idiom as
 *   `service_catalog` (0321), `inventory_items` (0166), `skills` (0025).
 *   It is the stable governed identity for ENERGY/WATER/WASTE/EMISSIONS/OTHER
 *   metrics where today no ESG authority exists.
 * - `code` UNIQUE per Client, normalized to uppercase at write time,
 *   pattern `/^[A-Z][A-Z0-9_-]*$/` 2–64 chars (same grammar as service_catalog).
 *   Immutable once referenced (service-layer enforcement; future children use
 *   composite scope FK).
 * - `category` CHECK ENERGY/WATER/WASTE/EMISSIONS/OTHER.
 * - `calculation_method` CHECK CALCULATED/MANUAL/HYBRID.
 * - Optional governed UOM reference `uom_id` FK `units_of_measure` (same Client
 *   + ACTIVE enforced in service layer).
 * - Lifecycle ACTIVE → INACTIVE terminal (reference-master idiom), no DRAFT,
 *   no scheduler, no effective window (windows live on metric values/baselines).
 * - `UNIQUE (id, client_id)` for composite scope FK readiness (0313/0319 precedent).
 *
 * This table creates no metric values, waste records, baselines, targets,
 * evidence bindings, aggregation, reporting, emission factors, or certification.
 * It is identity only.
 */
export const migration0326CreateEsgMetricDefinitions: Migration = {
  id: '0326_create_esg_metric_definitions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE esg_metric_definitions (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        code               TEXT NOT NULL,
        name               TEXT NOT NULL,
        description        TEXT,
        category           TEXT NOT NULL,
        uom_id             UUID REFERENCES units_of_measure (id),
        calculation_method TEXT NOT NULL DEFAULT 'MANUAL',
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT esg_metric_definitions_client_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT esg_metric_definitions_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT esg_metric_definitions_code_check
          CHECK (code ~ '^[A-Z][A-Z0-9_-]*$'
            AND length(btrim(code)) BETWEEN 2 AND 64),
        CONSTRAINT esg_metric_definitions_name_check
          CHECK (length(btrim(name)) BETWEEN 1 AND 200),
        CONSTRAINT esg_metric_definitions_description_check
          CHECK (description IS NULL
            OR length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT esg_metric_definitions_category_check
          CHECK (category IN ('ENERGY', 'WATER', 'WASTE', 'EMISSIONS', 'OTHER')),
        CONSTRAINT esg_metric_definitions_calc_method_check
          CHECK (calculation_method IN ('CALCULATED', 'MANUAL', 'HYBRID')),
        CONSTRAINT esg_metric_definitions_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX esg_metric_definitions_client_idx
        ON esg_metric_definitions (client_id, status);
      CREATE INDEX esg_metric_definitions_client_code_idx
        ON esg_metric_definitions (client_id, code);
      CREATE INDEX esg_metric_definitions_category_idx
        ON esg_metric_definitions (client_id, category, status);
      CREATE INDEX esg_metric_definitions_uom_idx
        ON esg_metric_definitions (uom_id)
        WHERE uom_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS esg_metric_definitions');
  },
};
