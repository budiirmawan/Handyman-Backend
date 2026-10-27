import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** ADD material execution is anchored to an existing, consented revised line;
 * original material lines and all existing history remain unchanged. */
export const migration0511HandymanAddMaterialExecutionBinding: Migration = {
  id: '0511_handyman_add_material_execution_binding',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE handyman_material_execution_lines
        ADD COLUMN variation_id UUID REFERENCES handyman_scope_variations(id),
        ADD COLUMN approved_variation_version INTEGER,
        ADD COLUMN work_order_id UUID REFERENCES work_orders(id),
        ADD CONSTRAINT hm_material_add_binding_complete CHECK (
          (variation_id IS NULL AND approved_variation_version IS NULL AND work_order_id IS NULL)
          OR (variation_id IS NOT NULL AND approved_variation_version IS NOT NULL
              AND approved_variation_version > 0 AND work_order_id IS NOT NULL)
        ),
        ADD CONSTRAINT hm_material_add_quantity_cap CHECK (
          variation_id IS NULL OR
          (issued_qty + purchased_qty - returned_qty <= approved_qty AND used_qty <= approved_qty)
        );
      ALTER TABLE handyman_material_execution_events
        ADD COLUMN quantity_delta NUMERIC(14,3) CHECK (quantity_delta IS NULL OR quantity_delta > 0);
      CREATE UNIQUE INDEX hm_material_add_one_execution_per_variation
        ON handyman_material_execution_lines(variation_id) WHERE variation_id IS NOT NULL;
      CREATE UNIQUE INDEX hm_material_add_one_execution_per_quote_line
        ON handyman_material_execution_lines(quotation_line_id) WHERE variation_id IS NOT NULL;

      CREATE FUNCTION hm_material_add_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.variation_id IS DISTINCT FROM OLD.variation_id
            OR NEW.approved_variation_version IS DISTINCT FROM OLD.approved_variation_version
            OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
            OR (OLD.variation_id IS NOT NULL AND
                (NEW.approved_qty IS DISTINCT FROM OLD.approved_qty OR NEW.estimated_qty IS DISTINCT FROM OLD.estimated_qty))
          THEN
            RAISE EXCEPTION 'ADD material execution authority and quantities are immutable' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.variation_id IS NULL THEN RETURN NEW; END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM handyman_scope_variations v
            JOIN handyman_execution_scopes s ON s.id=v.execution_scope_id
              AND s.client_id=v.client_id AND s.handyman_request_id=v.handyman_request_id
              AND s.building_id=v.building_id AND s.tenant_company_id=v.tenant_company_id
            JOIN handyman_quotation_versions qv ON qv.id=v.revised_quotation_version_id
              AND qv.quotation_id=s.quotation_id
            JOIN handyman_quotation_lines ql ON ql.id=NEW.quotation_line_id
              AND ql.quotation_version_id=qv.id
            JOIN work_orders wo ON wo.id=NEW.work_order_id
              AND wo.client_id=s.client_id AND wo.building_id=s.building_id
            JOIN handyman_scope_variation_events r ON r.variation_id=v.id
              AND r.execution_scope_id=s.id AND r.event_type='REVISED_QUOTATION'
              AND r.actor_role='OPERATIONS_MANAGER'
            JOIN handyman_scope_variation_events d ON d.variation_id=v.id
              AND d.execution_scope_id=s.id AND d.event_type='TENANT_DECISION'
              AND d.actor_role='TENANT' AND d.actor_user_id=v.tenant_decided_by_user_id
            JOIN handyman_scope_variation_events a ON a.variation_id=v.id
              AND a.execution_scope_id=s.id AND a.event_type='AUTHORIZED_SCOPE'
              AND a.actor_role='OPERATIONS_MANAGER'
           WHERE v.id=NEW.variation_id AND s.id=NEW.execution_scope_id AND s.client_id=NEW.client_id
             AND v.variation_type='ADD' AND v.line_type='MATERIAL'
             AND v.tenant_decision_outcome='APPROVED' AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION')
             AND NEW.quotation_version_id=qv.id AND ql.line_type='MATERIAL'
             AND ql.quantity=v.quantity AND ql.uom_id=v.uom_id
             AND ql.final_quoted_unit_amount=v.quoted_unit_amount AND ql.currency=v.currency
             AND ql.source_item_id IS NOT DISTINCT FROM NEW.source_item_id
             AND NEW.approved_qty=v.quantity AND NEW.estimated_qty>0 AND NEW.estimated_qty<=v.quantity
             AND wo.status NOT IN ('COMPLETED','CLOSED','CANCELLED','ON_HOLD')
             AND r.metadata->>'revisedQuotationVersionId'=qv.id::text
             AND r.metadata->>'revisedQuotationLineId'=ql.id::text
             AND r.metadata->>'workOrderId'=wo.id::text
             AND d.metadata->>'decisionOutcome'='APPROVED'
             AND d.metadata->'consentSnapshot'->>'version'=NEW.approved_variation_version::text
             AND d.metadata->'consentSnapshot'->>'revisedQuotationVersionId'=qv.id::text
             AND d.metadata->'consentSnapshot'->>'revisedQuotationLineId'=ql.id::text
             AND d.metadata->'consentSnapshot'->>'workOrderId'=wo.id::text
             AND d.metadata->'consentSnapshot'->>'quantity'=v.quantity::text
             AND d.metadata->'consentSnapshot'->>'uomId'=v.uom_id::text
        ) THEN
          RAISE EXCEPTION 'ADD material execution requires an exact approved variation, quote line and Work Order binding' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER hm_material_add_binding_guard_trg
        BEFORE INSERT OR UPDATE ON handyman_material_execution_lines
        FOR EACH ROW EXECUTE FUNCTION hm_material_add_binding_guard();

      CREATE FUNCTION hm_material_add_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE add_variation UUID;
      BEGIN
        SELECT variation_id INTO add_variation FROM handyman_material_execution_lines WHERE id=NEW.line_id;
        IF add_variation IS NOT NULL AND
          ((NEW.event_type IN ('ESTIMATE','ISSUE','PURCHASE','USE','RETURN') AND NEW.quantity_delta IS NULL)
           OR (NEW.event_type IN ('APPROVE','FINAL_CHARGE_READY') AND NEW.quantity_delta IS NOT NULL)) THEN
          RAISE EXCEPTION 'ADD material quantity events require their immutable delta' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER hm_material_add_event_guard_trg
        BEFORE INSERT ON handyman_material_execution_events
        FOR EACH ROW EXECUTE FUNCTION hm_material_add_event_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_material_execution_lines WHERE variation_id IS NOT NULL) THEN
          RAISE EXCEPTION 'Cannot remove ADD material execution authority while execution history exists';
        END IF;
      END $$;
      DROP TRIGGER hm_material_add_event_guard_trg ON handyman_material_execution_events;
      DROP FUNCTION hm_material_add_event_guard();
      DROP TRIGGER hm_material_add_binding_guard_trg ON handyman_material_execution_lines;
      DROP FUNCTION hm_material_add_binding_guard();
      DROP INDEX hm_material_add_one_execution_per_quote_line;
      DROP INDEX hm_material_add_one_execution_per_variation;
      ALTER TABLE handyman_material_execution_events DROP COLUMN quantity_delta;
      ALTER TABLE handyman_material_execution_lines
        DROP CONSTRAINT hm_material_add_quantity_cap,
        DROP CONSTRAINT hm_material_add_binding_complete,
        DROP COLUMN work_order_id,
        DROP COLUMN approved_variation_version,
        DROP COLUMN variation_id;
    `);
  },
};
