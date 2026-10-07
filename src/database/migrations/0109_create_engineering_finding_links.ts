import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10H — Engineering Finding Binding.
 *
 * The minimal Engineering context record for a BE-09 Finding: which Asset /
 * Functional Location, Engineering operation type, and Engineering source
 * execution/binding produced it.
 *
 * The Finding itself lives exclusively in BE-09's `findings` table — its
 * lifecycle, source binding, classification/severity, assignment,
 * verification, rework, closure, and available actions all remain BE-09's.
 * This table holds references and context only; `finding_id` is UNIQUE so a
 * Finding has at most one Engineering context.
 *
 * Duplicate unintended Engineering Findings from the same source execution
 * are prevented by a partial UNIQUE index over (source_type, source_id).
 * `client_id` / `building_id` are stored directly but derived authoritatively
 * by the service from Building → Property → Client.
 */
export const migration0109CreateEngineeringFindingLinks: Migration = {
  id: '0109_create_engineering_finding_links',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE engineering_finding_links (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        finding_id             UUID NOT NULL UNIQUE REFERENCES findings (id),
        asset_id               UUID REFERENCES assets (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        operation_type         TEXT NOT NULL,
        source_type            TEXT,
        source_id              UUID,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT engineering_finding_operation_type
          CHECK (operation_type IN (
            'EQUIPMENT_INSPECTION', 'METER_READING', 'EQUIPMENT_LOG_SHEET',
            'ENGINEERING_CHECKLIST', 'BREAKDOWN', 'MAINTENANCE'
          )),
        CONSTRAINT engineering_finding_source_type
          CHECK (
            source_type IS NULL
            OR source_type IN ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER')
          ),
        CONSTRAINT engineering_finding_source_pair
          CHECK ((source_type IS NULL) = (source_id IS NULL))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX engineering_finding_source_unique
        ON engineering_finding_links (source_type, source_id)
        WHERE source_id IS NOT NULL;
      CREATE INDEX engineering_finding_links_building_idx
        ON engineering_finding_links (building_id);
      CREATE INDEX engineering_finding_links_asset_idx
        ON engineering_finding_links (asset_id);
      CREATE INDEX engineering_finding_links_finding_idx
        ON engineering_finding_links (finding_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS engineering_finding_links');
  },
};
