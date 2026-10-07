import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15C — Vendor Checklist Binding.
 *
 * The minimal binding that associates a BE-07 Checklist Template with a
 * Vendor operational context: a BE-15B Vendor Work (which itself references
 * the BE-06 Vendor master and the BE-08 Work Order). Executions stay BE-07's
 * `checklist_executions` rows — no Vendor checklist engine exists here.
 *
 *   Vendor Work → Vendor Checklist Binding → Checklist Template
 *                    ↘ Checklist Execution (BE-07)
 *
 * `client_id`, `building_id`, and `work_order_id` are stored directly but
 * derived authoritatively by the service from the Vendor Work → Work Order,
 * so isolation can never drift from BE-08 / BE-02.
 *
 * `checklist_execution_id` is set when an execution is started from the
 * binding and is NULL before then. It is UNIQUE so one BE-07 execution is
 * never claimed by two bindings (PostgreSQL permits multiple NULLs).
 *
 * One ACTIVE binding per (Vendor Work, Template) is enforced by a partial
 * unique index over ACTIVE rows, following the BE-06D / BE-07 idiom.
 */
export const migration0157CreateVendorChecklistBindings: Migration = {
  id: '0157_create_vendor_checklist_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_checklist_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        vendor_work_id         UUID NOT NULL REFERENCES vendor_works (id),
        checklist_template_id  UUID NOT NULL REFERENCES checklist_templates (id),
        checklist_execution_id UUID REFERENCES checklist_executions (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        work_order_id          UUID NOT NULL REFERENCES work_orders (id),
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_checklist_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT vendor_checklist_binding_execution_unique
          UNIQUE (checklist_execution_id)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX vendor_checklist_binding_active_unique
        ON vendor_checklist_bindings (vendor_work_id, checklist_template_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX vendor_checklist_bindings_work_idx
        ON vendor_checklist_bindings (vendor_work_id, status);
      CREATE INDEX vendor_checklist_bindings_template_idx
        ON vendor_checklist_bindings (checklist_template_id, status);
      CREATE INDEX vendor_checklist_bindings_building_idx
        ON vendor_checklist_bindings (building_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_checklist_bindings');
  },
};
