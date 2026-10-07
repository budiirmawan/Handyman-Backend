import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10D — Equipment Log Sheet Binding.
 *
 * The minimal Engineering binding that associates a BE-05 Asset / Equipment
 * with a BE-07 Form Template (the log sheet definition), an optional
 * published Template Version snapshot, and an optional BE-04 Functional
 * Location refinement.
 *
 * This table holds references only — Asset, Form Template / Version,
 * responses, UOM, evidence, and workflow state masters are never duplicated.
 * Log sheet rows are BE-07 Form Instances whose responses live in BE-07's
 * own `form_responses` store.
 *
 * `client_id` / `building_id` are stored directly but derived authoritatively
 * by the service from Asset → Building → Property → Client, so isolation can
 * never drift from BE-02.
 *
 * One ACTIVE binding per (Asset, Template) is enforced by a partial unique
 * index — the same BE-07 idiom — so duplicate active bindings are impossible
 * while INACTIVE history is retained.
 */
export const migration0102CreateLogSheetBindings: Migration = {
  id: '0102_create_log_sheet_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE log_sheet_bindings (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        asset_id                UUID NOT NULL REFERENCES assets (id),
        form_template_id        UUID NOT NULL REFERENCES form_templates (id),
        form_template_version_id UUID REFERENCES form_template_versions (id),
        functional_location_id  UUID REFERENCES functional_locations (id),
        status                  TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT log_sheet_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX log_sheet_binding_active_unique
        ON log_sheet_bindings (asset_id, form_template_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX log_sheet_bindings_asset_idx
        ON log_sheet_bindings (asset_id, status);
      CREATE INDEX log_sheet_bindings_building_idx
        ON log_sheet_bindings (building_id, status);
      CREATE INDEX log_sheet_bindings_template_idx
        ON log_sheet_bindings (form_template_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS log_sheet_bindings');
  },
};
