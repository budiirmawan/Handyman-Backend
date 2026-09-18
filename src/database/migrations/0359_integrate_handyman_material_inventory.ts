import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-07 RUN 2 — connect approved Handyman material demand to the
 * existing inventory authorities only.
 *
 * - `inventory_material_reservations` remains the one allocation engine; this
 *   migration gives it a typed Handyman-demand source alongside its immutable
 *   procurement Material Request source.
 * - `inventory_stock_movements` remains the sole physical ledger. A thin
 *   controlled issue links exactly one Provider-stock STOCK_OUT, and a thin
 *   return links exactly one routine STOCK_IN.
 * - Actual use/install is an append-only operational fact, never a stock
 *   movement. Provider use names its original controlled issue; customer-
 *   supplied use names no inventory source at all.
 *
 * Lock order is implemented by the services and repeated by the integrity
 * triggers where a raw write needs serialization:
 *   demand → reservation (if any) → stock balance for reserve/issue/release;
 *   original controlled issue → stock balance for return;
 *   original controlled issue for Provider use/return aggregation.
 * No Handyman balance, warehouse, item master, ledger, or synthetic Material
 * Request is introduced here.
 */
export const migration0359IntegrateHandymanMaterialInventory: Migration = {
  id: '0359_integrate_handyman_material_inventory',

  async up(client: PoolClient): Promise<void> {
    // The Run-1 demand table intentionally did not need a compound scope key.
    // Reservation source FKs use this one to make cross-client demand links
    // structurally impossible.
    await client.query(`
      ALTER TABLE handyman_material_demands
        ADD CONSTRAINT hm_mat_demands_inventory_scope_unique
          UNIQUE (id, client_id)
    `);

    // Preserve the legacy Material Request path as the default source. Its
    // existing rows retain a non-null material_request_id; Handyman rows use
    // the same allocation/consumption columns with the alternate typed source.
    await client.query(`
      ALTER TABLE inventory_material_reservations
        ADD COLUMN source_type TEXT NOT NULL DEFAULT 'MATERIAL_REQUEST',
        ADD COLUMN handyman_material_demand_id UUID,
        ADD COLUMN idempotency_key TEXT,
        ADD COLUMN idempotency_fingerprint CHAR(64),
        ADD COLUMN terminal_idempotency_key TEXT,
        ADD COLUMN terminal_idempotency_fingerprint CHAR(64)
    `);
    await client.query(`
      ALTER TABLE inventory_material_reservations
        ALTER COLUMN material_request_id DROP NOT NULL
    `);
    await client.query(`
      ALTER TABLE inventory_material_reservations
        ADD CONSTRAINT inventory_material_reservation_source_type_check
          CHECK (source_type IN ('MATERIAL_REQUEST', 'HANDYMAN_MATERIAL_DEMAND')),
        ADD CONSTRAINT inventory_material_reservation_source_shape_check
          CHECK (
            (source_type = 'MATERIAL_REQUEST'
              AND material_request_id IS NOT NULL
              AND handyman_material_demand_id IS NULL)
            OR
            (source_type = 'HANDYMAN_MATERIAL_DEMAND'
              AND material_request_id IS NULL
              AND handyman_material_demand_id IS NOT NULL)
          ),
        ADD CONSTRAINT inventory_material_reservation_handyman_demand_scope_fk
          FOREIGN KEY (handyman_material_demand_id, client_id)
          REFERENCES handyman_material_demands (id, client_id),
        ADD CONSTRAINT inventory_material_reservation_idempotency_key_check
          CHECK (idempotency_key IS NULL
            OR length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        ADD CONSTRAINT inventory_material_reservation_idempotency_fingerprint_check
          CHECK (idempotency_fingerprint IS NULL
            OR idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT inventory_material_reservation_idempotency_pair_check
          CHECK (
            (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
          ),
        ADD CONSTRAINT inventory_material_reservation_handyman_creation_key_check
          CHECK (
            source_type <> 'HANDYMAN_MATERIAL_DEMAND'
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
          ),
        ADD CONSTRAINT inventory_material_reservation_terminal_key_check
          CHECK (terminal_idempotency_key IS NULL
            OR length(btrim(terminal_idempotency_key)) BETWEEN 1 AND 200),
        ADD CONSTRAINT inventory_material_reservation_terminal_fingerprint_check
          CHECK (terminal_idempotency_fingerprint IS NULL
            OR terminal_idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT inventory_material_reservation_terminal_idempotency_pair_check
          CHECK (
            (terminal_idempotency_key IS NULL
              AND terminal_idempotency_fingerprint IS NULL)
            OR (terminal_idempotency_key IS NOT NULL
              AND terminal_idempotency_fingerprint IS NOT NULL)
          ),
        ADD CONSTRAINT inventory_material_reservation_handyman_terminal_shape_check
          CHECK (
            source_type <> 'HANDYMAN_MATERIAL_DEMAND'
            OR (
              status IN ('ACTIVE', 'CONSUMED')
              AND terminal_idempotency_key IS NULL
              AND terminal_idempotency_fingerprint IS NULL
            )
            OR (
              status IN ('RELEASED', 'CANCELLED')
              AND terminal_idempotency_key IS NOT NULL
              AND terminal_idempotency_fingerprint IS NOT NULL
            )
          )
    `);
    await client.query(`
      CREATE INDEX inventory_material_reservations_handyman_demand_idx
        ON inventory_material_reservations
          (handyman_material_demand_id, status, created_at DESC)
        WHERE source_type = 'HANDYMAN_MATERIAL_DEMAND';
      CREATE UNIQUE INDEX inventory_material_reservations_client_key_unique
        ON inventory_material_reservations (client_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX inventory_material_reservations_client_terminal_key_unique
        ON inventory_material_reservations (client_id, terminal_idempotency_key)
        WHERE terminal_idempotency_key IS NOT NULL
    `);

    // Thin typed Provider-stock hand-off. The movement link is one-to-one, so
    // a stock movement cannot support two Handyman controlled issues.
    await client.query(`
      CREATE TABLE handyman_material_controlled_issues (
        id                                  UUID PRIMARY KEY,
        client_id                           UUID NOT NULL REFERENCES clients (id),
        building_id                         UUID NOT NULL REFERENCES buildings (id),
        handyman_material_demand_id         UUID NOT NULL,
        handyman_job_id                     UUID NOT NULL REFERENCES handyman_jobs (id),
        work_order_id                       UUID NOT NULL REFERENCES work_orders (id),
        inventory_material_reservation_id   UUID REFERENCES inventory_material_reservations (id),
        warehouse_id                        UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id                             UUID NOT NULL,
        uom_id                              UUID NOT NULL,
        handyman_service_visit_id           UUID REFERENCES handyman_service_visits (id),
        handyman_work_session_id            UUID REFERENCES handyman_work_sessions (id),
        inventory_stock_movement_id         UUID NOT NULL
          REFERENCES inventory_stock_movements (id),
        quantity                            NUMERIC(18, 4) NOT NULL,
        issued_by_user_id                   UUID NOT NULL REFERENCES users (id),
        issued_at                           TIMESTAMPTZ NOT NULL,
        reference                           TEXT,
        notes                               TEXT,
        idempotency_key                     TEXT NOT NULL,
        idempotency_fingerprint             CHAR(64) NOT NULL,
        created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_mat_controlled_issues_demand_scope_fk
          FOREIGN KEY (handyman_material_demand_id, client_id)
          REFERENCES handyman_material_demands (id, client_id),
        CONSTRAINT hm_mat_controlled_issues_item_scope_fk
          FOREIGN KEY (item_id, client_id)
          REFERENCES inventory_items (id, client_id),
        CONSTRAINT hm_mat_controlled_issues_uom_scope_fk
          FOREIGN KEY (uom_id, client_id)
          REFERENCES units_of_measure (id, client_id),
        CONSTRAINT hm_mat_controlled_issues_movement_unique
          UNIQUE (inventory_stock_movement_id),
        CONSTRAINT hm_mat_controlled_issues_quantity_positive
          CHECK (quantity > 0),
        CONSTRAINT hm_mat_controlled_issues_session_visit_shape_check
          CHECK (handyman_work_session_id IS NULL
            OR handyman_service_visit_id IS NOT NULL),
        CONSTRAINT hm_mat_controlled_issues_reference_check
          CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_controlled_issues_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
        CONSTRAINT hm_mat_controlled_issues_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_controlled_issues_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_controlled_issues_client_key_unique
          UNIQUE (client_id, idempotency_key)
      )
    `);

    // Append-only actual use/install fact. It intentionally has no stock
    // movement field: only a controlled Provider issue or a customer-supplied
    // demand may be its authority.
    await client.query(`
      CREATE TABLE handyman_material_actual_usages (
        id                                  UUID PRIMARY KEY,
        client_id                           UUID NOT NULL REFERENCES clients (id),
        building_id                         UUID NOT NULL REFERENCES buildings (id),
        handyman_material_demand_id         UUID NOT NULL,
        handyman_job_id                     UUID NOT NULL REFERENCES handyman_jobs (id),
        work_order_id                       UUID NOT NULL REFERENCES work_orders (id),
        handyman_material_controlled_issue_id UUID
          REFERENCES handyman_material_controlled_issues (id),
        inventory_item_id                   UUID,
        uom_id                              UUID NOT NULL,
        handyman_service_visit_id           UUID REFERENCES handyman_service_visits (id),
        handyman_work_session_id            UUID REFERENCES handyman_work_sessions (id),
        usage_kind                          TEXT NOT NULL DEFAULT 'USED',
        quantity                            NUMERIC(18, 4) NOT NULL,
        used_by_user_id                     UUID NOT NULL REFERENCES users (id),
        used_at                             TIMESTAMPTZ NOT NULL,
        notes                               TEXT,
        idempotency_key                     TEXT NOT NULL,
        idempotency_fingerprint             CHAR(64) NOT NULL,
        created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_mat_actual_usages_demand_scope_fk
          FOREIGN KEY (handyman_material_demand_id, client_id)
          REFERENCES handyman_material_demands (id, client_id),
        CONSTRAINT hm_mat_actual_usages_item_scope_fk
          FOREIGN KEY (inventory_item_id, client_id)
          REFERENCES inventory_items (id, client_id),
        CONSTRAINT hm_mat_actual_usages_uom_scope_fk
          FOREIGN KEY (uom_id, client_id)
          REFERENCES units_of_measure (id, client_id),
        CONSTRAINT hm_mat_actual_usages_kind_check
          CHECK (usage_kind IN ('USED', 'INSTALLED')),
        CONSTRAINT hm_mat_actual_usages_quantity_positive
          CHECK (quantity > 0),
        CONSTRAINT hm_mat_actual_usages_session_visit_shape_check
          CHECK (handyman_work_session_id IS NULL
            OR handyman_service_visit_id IS NOT NULL),
        CONSTRAINT hm_mat_actual_usages_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
        CONSTRAINT hm_mat_actual_usages_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_actual_usages_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_actual_usages_client_key_unique
          UNIQUE (client_id, idempotency_key)
      )
    `);

    // Routine unused return is a normal STOCK_IN back to the original issue's
    // warehouse. No stock-adjustment path is involved.
    await client.query(`
      CREATE TABLE handyman_material_returns (
        id                                  UUID PRIMARY KEY,
        client_id                           UUID NOT NULL REFERENCES clients (id),
        building_id                         UUID NOT NULL REFERENCES buildings (id),
        handyman_material_controlled_issue_id UUID NOT NULL
          REFERENCES handyman_material_controlled_issues (id),
        handyman_material_demand_id         UUID NOT NULL,
        handyman_job_id                     UUID NOT NULL REFERENCES handyman_jobs (id),
        work_order_id                       UUID NOT NULL REFERENCES work_orders (id),
        warehouse_id                        UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id                             UUID NOT NULL,
        uom_id                              UUID NOT NULL,
        inventory_stock_movement_id         UUID NOT NULL
          REFERENCES inventory_stock_movements (id),
        quantity                            NUMERIC(18, 4) NOT NULL,
        returned_by_user_id                 UUID NOT NULL REFERENCES users (id),
        returned_at                         TIMESTAMPTZ NOT NULL,
        reference                           TEXT,
        notes                               TEXT,
        idempotency_key                     TEXT NOT NULL,
        idempotency_fingerprint             CHAR(64) NOT NULL,
        created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT hm_mat_returns_demand_scope_fk
          FOREIGN KEY (handyman_material_demand_id, client_id)
          REFERENCES handyman_material_demands (id, client_id),
        CONSTRAINT hm_mat_returns_item_scope_fk
          FOREIGN KEY (item_id, client_id)
          REFERENCES inventory_items (id, client_id),
        CONSTRAINT hm_mat_returns_uom_scope_fk
          FOREIGN KEY (uom_id, client_id)
          REFERENCES units_of_measure (id, client_id),
        CONSTRAINT hm_mat_returns_movement_unique
          UNIQUE (inventory_stock_movement_id),
        CONSTRAINT hm_mat_returns_quantity_positive
          CHECK (quantity > 0),
        CONSTRAINT hm_mat_returns_reference_check
          CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_returns_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
        CONSTRAINT hm_mat_returns_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT hm_mat_returns_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_mat_returns_client_key_unique
          UNIQUE (client_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX hm_mat_controlled_issues_demand_idx
        ON handyman_material_controlled_issues
          (handyman_material_demand_id, issued_at DESC);
      CREATE INDEX hm_mat_controlled_issues_reservation_idx
        ON handyman_material_controlled_issues
          (inventory_material_reservation_id, issued_at DESC)
        WHERE inventory_material_reservation_id IS NOT NULL;
      CREATE INDEX hm_mat_controlled_issues_job_idx
        ON handyman_material_controlled_issues (handyman_job_id, issued_at DESC);
      CREATE INDEX hm_mat_actual_usages_demand_idx
        ON handyman_material_actual_usages
          (handyman_material_demand_id, used_at DESC);
      CREATE INDEX hm_mat_actual_usages_issue_idx
        ON handyman_material_actual_usages
          (handyman_material_controlled_issue_id, used_at DESC)
        WHERE handyman_material_controlled_issue_id IS NOT NULL;
      CREATE INDEX hm_mat_returns_issue_idx
        ON handyman_material_returns
          (handyman_material_controlled_issue_id, returned_at DESC)
    `);

    // Typed source rows cannot be silently repointed. The INSERT proof binds a
    // Handyman reservation to an active Provider-stock demand with exactly the
    // demand's client/building/item/UOM facts.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_inventory_material_reservation_source_integrity()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.source_type IS DISTINCT FROM OLD.source_type THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_RESERVATION_INVALID: reservation source type is immutable';
        END IF;

        IF NEW.source_type = 'HANDYMAN_MATERIAL_DEMAND' THEN
          IF TG_OP = 'UPDATE' AND (
            NEW.material_request_id IS DISTINCT FROM OLD.material_request_id
            OR NEW.handyman_material_demand_id IS DISTINCT FROM OLD.handyman_material_demand_id
            OR NEW.client_id <> OLD.client_id
            OR NEW.building_id <> OLD.building_id
            OR NEW.warehouse_id <> OLD.warehouse_id
            OR NEW.item_id <> OLD.item_id
            OR NEW.uom_id IS DISTINCT FROM OLD.uom_id
            OR NEW.reserved_quantity <> OLD.reserved_quantity
            OR NEW.created_by_user_id <> OLD.created_by_user_id
            OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
            OR NEW.idempotency_fingerprint IS DISTINCT FROM OLD.idempotency_fingerprint
            OR NEW.created_at <> OLD.created_at
          ) THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_RESERVATION_INVALID: Handyman reservation source facts are immutable';
          END IF;

          IF TG_OP = 'INSERT' THEN
            PERFORM 1
              FROM handyman_material_demands d
              JOIN handyman_jobs j ON j.id = d.handyman_job_id
              JOIN handyman_requests r ON r.id = j.handyman_request_id
             WHERE d.id = NEW.handyman_material_demand_id
               AND d.client_id = NEW.client_id
               AND d.status = 'ACTIVE'
               AND d.supply_source = 'PROVIDER_STOCK'
               AND d.building_id = NEW.building_id
               AND d.inventory_item_id = NEW.item_id
               AND d.uom_id = NEW.uom_id
               AND j.client_id = NEW.client_id
               AND r.id = d.handyman_request_id
               AND r.client_id = NEW.client_id
               AND r.building_id = NEW.building_id
             FOR UPDATE OF d;
            IF NOT FOUND THEN
              RAISE EXCEPTION
                'HANDYMAN_MATERIAL_INVENTORY_RESERVATION_INVALID: Handyman reservation must match an active Provider-stock demand';
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER inventory_material_reservation_source_integrity
        BEFORE INSERT OR UPDATE ON inventory_material_reservations
        FOR EACH ROW EXECUTE FUNCTION assert_inventory_material_reservation_source_integrity()
    `);

    // Run-1 closes an active demand by cancellation or supersession. An active
    // stock allocation is a separate inventory fact and must be deliberately
    // released/cancelled first; this database guard complements the service
    // check and protects raw writes too.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_material_demand_no_active_reservation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status = 'ACTIVE'
          AND NEW.status IN ('SUPERSEDED', 'CANCELLED') THEN
          PERFORM 1
            FROM inventory_material_reservations r
           WHERE r.source_type = 'HANDYMAN_MATERIAL_DEMAND'
             AND r.handyman_material_demand_id = OLD.id
             AND r.status = 'ACTIVE'
             AND r.remaining_quantity > 0;
          IF FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_DEMAND_ACTIVE_RESERVATION: active inventory reservation must be released or cancelled first';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_demand_reservation_guard
        BEFORE UPDATE ON handyman_material_demands
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_material_demand_no_active_reservation()
    `);

    // This trigger is the structural backstop for the controlled STOCK_OUT:
    // it locks the demand, proves all copied context, verifies any reservation
    // consumption linkage, and preserves issued + active allocation <= demand.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_material_controlled_issue_integrity()
      RETURNS TRIGGER AS $$
      DECLARE
        authorized_quantity NUMERIC;
        issued_quantity NUMERIC;
        active_reservation_quantity NUMERIC;
        reservation_consumed_quantity NUMERIC;
        reservation_linked_issue_quantity NUMERIC;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: controlled issue facts are append-only';
        END IF;

        SELECT d.quantity
          INTO authorized_quantity
          FROM handyman_material_demands d
          JOIN handyman_jobs j ON j.id = d.handyman_job_id
          JOIN handyman_requests r ON r.id = j.handyman_request_id
         WHERE d.id = NEW.handyman_material_demand_id
           AND d.client_id = NEW.client_id
           AND d.status = 'ACTIVE'
           AND d.supply_source = 'PROVIDER_STOCK'
           AND d.handyman_job_id = NEW.handyman_job_id
           AND d.building_id = NEW.building_id
           AND d.inventory_item_id = NEW.item_id
           AND d.uom_id = NEW.uom_id
           AND j.client_id = NEW.client_id
           AND j.handyman_request_id = d.handyman_request_id
           AND j.work_order_id = NEW.work_order_id
           AND r.client_id = NEW.client_id
           AND r.building_id = NEW.building_id
         FOR UPDATE OF d;
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: issue does not match active Provider-stock demand/job/work-order context';
        END IF;

        IF NEW.handyman_service_visit_id IS NOT NULL THEN
          PERFORM 1
            FROM handyman_service_visits v
           WHERE v.id = NEW.handyman_service_visit_id
             AND v.client_id = NEW.client_id
             AND v.handyman_job_id = NEW.handyman_job_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: issue visit does not belong to its job';
          END IF;
        END IF;

        IF NEW.handyman_work_session_id IS NOT NULL THEN
          PERFORM 1
            FROM handyman_work_sessions s
            JOIN handyman_service_visits v ON v.id = s.visit_id
           WHERE s.id = NEW.handyman_work_session_id
             AND s.client_id = NEW.client_id
             AND v.id = NEW.handyman_service_visit_id
             AND v.handyman_job_id = NEW.handyman_job_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: issue work session is not coherent with its visit/job';
          END IF;
        END IF;

        IF NEW.inventory_material_reservation_id IS NOT NULL THEN
          SELECT r.consumed_quantity,
                 COALESCE((
                   SELECT SUM(i.quantity)
                     FROM handyman_material_controlled_issues i
                    WHERE i.inventory_material_reservation_id = r.id
                 ), 0)::numeric
            INTO reservation_consumed_quantity,
                 reservation_linked_issue_quantity
            FROM inventory_material_reservations r
           WHERE r.id = NEW.inventory_material_reservation_id
             AND r.source_type = 'HANDYMAN_MATERIAL_DEMAND'
             AND r.handyman_material_demand_id = NEW.handyman_material_demand_id
             AND r.client_id = NEW.client_id
             AND r.building_id = NEW.building_id
             AND r.warehouse_id = NEW.warehouse_id
             AND r.item_id = NEW.item_id
             AND r.uom_id = NEW.uom_id
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: issue reservation does not match its demand/stock context';
          END IF;
          IF reservation_linked_issue_quantity + NEW.quantity
             > reservation_consumed_quantity THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: issue exceeds consumed reservation allocation';
          END IF;
        END IF;

        SELECT COALESCE(SUM(quantity), 0)::numeric
          INTO issued_quantity
          FROM handyman_material_controlled_issues
         WHERE handyman_material_demand_id = NEW.handyman_material_demand_id;
        SELECT COALESCE(SUM(remaining_quantity), 0)::numeric
          INTO active_reservation_quantity
          FROM inventory_material_reservations
         WHERE handyman_material_demand_id = NEW.handyman_material_demand_id
           AND source_type = 'HANDYMAN_MATERIAL_DEMAND'
           AND status = 'ACTIVE';
        IF issued_quantity + active_reservation_quantity + NEW.quantity
           > authorized_quantity THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: issued and active allocation exceed approved demand';
        END IF;

        PERFORM 1
          FROM inventory_stock_movements m
         WHERE m.id = NEW.inventory_stock_movement_id
           AND m.client_id = NEW.client_id
           AND m.building_id = NEW.building_id
           AND m.warehouse_id = NEW.warehouse_id
           AND m.item_id = NEW.item_id
           AND m.uom_id = NEW.uom_id
           AND m.movement_type = 'STOCK_OUT'
           AND m.quantity = NEW.quantity
           AND m.source = ('HANDYMAN_MATERIAL_ISSUE:' || NEW.id::text);
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_ISSUE_INVALID: issue must reference its matching STOCK_OUT';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_controlled_issue_integrity
        BEFORE INSERT ON handyman_material_controlled_issues
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_material_controlled_issue_integrity()
    `);

    // Provider actual use and normal return serialize on the same original
    // issue row. Customer-supplied use serializes on its demand and remains
    // entirely outside inventory reservation/movement authority.
    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_material_actual_usage_integrity()
      RETURNS TRIGGER AS $$
      DECLARE
        demand_source TEXT;
        demand_quantity NUMERIC;
        issue_quantity NUMERIC;
        used_quantity NUMERIC;
        returned_quantity NUMERIC;
      BEGIN
        SELECT d.supply_source, d.quantity
          INTO demand_source, demand_quantity
          FROM handyman_material_demands d
          JOIN handyman_jobs j ON j.id = d.handyman_job_id
          JOIN handyman_requests r ON r.id = j.handyman_request_id
         WHERE d.id = NEW.handyman_material_demand_id
           AND d.client_id = NEW.client_id
           AND d.handyman_job_id = NEW.handyman_job_id
           AND d.building_id = NEW.building_id
           AND d.inventory_item_id IS NOT DISTINCT FROM NEW.inventory_item_id
           AND d.uom_id = NEW.uom_id
           AND j.client_id = NEW.client_id
           AND j.handyman_request_id = d.handyman_request_id
           AND j.work_order_id = NEW.work_order_id
           AND r.client_id = NEW.client_id
           AND r.building_id = NEW.building_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: actual use does not match demand/job/work-order subject';
        END IF;

        IF NEW.handyman_service_visit_id IS NOT NULL THEN
          PERFORM 1
            FROM handyman_service_visits v
           WHERE v.id = NEW.handyman_service_visit_id
             AND v.client_id = NEW.client_id
             AND v.handyman_job_id = NEW.handyman_job_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: actual-use visit does not belong to its job';
          END IF;
        END IF;
        IF NEW.handyman_work_session_id IS NOT NULL THEN
          PERFORM 1
            FROM handyman_work_sessions s
            JOIN handyman_service_visits v ON v.id = s.visit_id
           WHERE s.id = NEW.handyman_work_session_id
             AND s.client_id = NEW.client_id
             AND v.id = NEW.handyman_service_visit_id
             AND v.handyman_job_id = NEW.handyman_job_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: actual-use work session is not coherent with its visit/job';
          END IF;
        END IF;

        IF demand_source = 'PROVIDER_STOCK' THEN
          IF NEW.handyman_material_controlled_issue_id IS NULL THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: Provider-stock actual use requires controlled issue';
          END IF;
          SELECT i.quantity
            INTO issue_quantity
            FROM handyman_material_controlled_issues i
           WHERE i.id = NEW.handyman_material_controlled_issue_id
             AND i.client_id = NEW.client_id
             AND i.building_id = NEW.building_id
             AND i.handyman_material_demand_id = NEW.handyman_material_demand_id
             AND i.handyman_job_id = NEW.handyman_job_id
             AND i.work_order_id = NEW.work_order_id
             AND i.item_id = NEW.inventory_item_id
             AND i.uom_id = NEW.uom_id
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: controlled issue does not match Provider-stock actual use';
          END IF;
          SELECT COALESCE(SUM(quantity), 0)::numeric
            INTO used_quantity
            FROM handyman_material_actual_usages
           WHERE handyman_material_controlled_issue_id = NEW.handyman_material_controlled_issue_id;
          SELECT COALESCE(SUM(quantity), 0)::numeric
            INTO returned_quantity
            FROM handyman_material_returns
           WHERE handyman_material_controlled_issue_id = NEW.handyman_material_controlled_issue_id;
          IF used_quantity + returned_quantity + NEW.quantity > issue_quantity THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: cumulative usage and return exceed controlled issue';
          END IF;
        ELSIF demand_source = 'CUSTOMER_SUPPLIED' THEN
          IF NEW.handyman_material_controlled_issue_id IS NOT NULL THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: customer-supplied use must not reference inventory issue';
          END IF;
          SELECT d.quantity
            INTO demand_quantity
            FROM handyman_material_demands d
           WHERE d.id = NEW.handyman_material_demand_id
             AND d.status = 'ACTIVE'
             AND d.supply_source = 'CUSTOMER_SUPPLIED'
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: customer-supplied demand is not active';
          END IF;
          SELECT COALESCE(SUM(quantity), 0)::numeric
            INTO used_quantity
            FROM handyman_material_actual_usages
           WHERE handyman_material_demand_id = NEW.handyman_material_demand_id
             AND handyman_material_controlled_issue_id IS NULL;
          IF used_quantity + NEW.quantity > demand_quantity THEN
            RAISE EXCEPTION
              'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: actual use exceeds customer-supplied demand';
          END IF;
        ELSE
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_USAGE_INVALID: unknown material supply source';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_actual_usage_integrity
        BEFORE INSERT ON handyman_material_actual_usages
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_material_actual_usage_integrity()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION assert_handyman_material_return_integrity()
      RETURNS TRIGGER AS $$
      DECLARE
        issue_quantity NUMERIC;
        used_quantity NUMERIC;
        returned_quantity NUMERIC;
      BEGIN
        SELECT i.quantity
          INTO issue_quantity
          FROM handyman_material_controlled_issues i
         WHERE i.id = NEW.handyman_material_controlled_issue_id
           AND i.client_id = NEW.client_id
           AND i.building_id = NEW.building_id
           AND i.handyman_material_demand_id = NEW.handyman_material_demand_id
           AND i.handyman_job_id = NEW.handyman_job_id
           AND i.work_order_id = NEW.work_order_id
           AND i.warehouse_id = NEW.warehouse_id
           AND i.item_id = NEW.item_id
           AND i.uom_id = NEW.uom_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_RETURN_INVALID: return does not match originating controlled issue';
        END IF;

        SELECT COALESCE(SUM(quantity), 0)::numeric
          INTO used_quantity
          FROM handyman_material_actual_usages
         WHERE handyman_material_controlled_issue_id = NEW.handyman_material_controlled_issue_id;
        SELECT COALESCE(SUM(quantity), 0)::numeric
          INTO returned_quantity
          FROM handyman_material_returns
         WHERE handyman_material_controlled_issue_id = NEW.handyman_material_controlled_issue_id;
        IF used_quantity + returned_quantity + NEW.quantity > issue_quantity THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_RETURN_INVALID: cumulative usage and return exceed controlled issue';
        END IF;

        PERFORM 1
          FROM inventory_stock_movements m
         WHERE m.id = NEW.inventory_stock_movement_id
           AND m.client_id = NEW.client_id
           AND m.building_id = NEW.building_id
           AND m.warehouse_id = NEW.warehouse_id
           AND m.item_id = NEW.item_id
           AND m.uom_id = NEW.uom_id
           AND m.movement_type = 'STOCK_IN'
           AND m.quantity = NEW.quantity
           AND m.source = ('HANDYMAN_MATERIAL_RETURN:' || NEW.id::text);
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'HANDYMAN_MATERIAL_INVENTORY_RETURN_INVALID: return must reference its matching STOCK_IN';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_return_integrity
        BEFORE INSERT ON handyman_material_returns
        FOR EACH ROW EXECUTE FUNCTION assert_handyman_material_return_integrity()
    `);

    // All Run-2 fulfilment facts are append-only. The only mutable source row
    // remains the existing reservation lifecycle/consumption row.
    await client.query(`
      CREATE OR REPLACE FUNCTION reject_handyman_material_inventory_fact_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'HANDYMAN_MATERIAL_INVENTORY_FACT_IMMUTABLE: % records are append-only',
          TG_TABLE_NAME;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_controlled_issue_immutable
        BEFORE UPDATE OR DELETE ON handyman_material_controlled_issues
        FOR EACH ROW EXECUTE FUNCTION reject_handyman_material_inventory_fact_mutation();
      CREATE TRIGGER handyman_material_actual_usage_immutable
        BEFORE UPDATE OR DELETE ON handyman_material_actual_usages
        FOR EACH ROW EXECUTE FUNCTION reject_handyman_material_inventory_fact_mutation();
      CREATE TRIGGER handyman_material_return_immutable
        BEFORE UPDATE OR DELETE ON handyman_material_returns
        FOR EACH ROW EXECUTE FUNCTION reject_handyman_material_inventory_fact_mutation()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_material_return_immutable
        ON handyman_material_returns;
      DROP TRIGGER IF EXISTS handyman_material_actual_usage_immutable
        ON handyman_material_actual_usages;
      DROP TRIGGER IF EXISTS handyman_material_controlled_issue_immutable
        ON handyman_material_controlled_issues;
      DROP TRIGGER IF EXISTS handyman_material_return_integrity
        ON handyman_material_returns;
      DROP TRIGGER IF EXISTS handyman_material_actual_usage_integrity
        ON handyman_material_actual_usages;
      DROP TRIGGER IF EXISTS handyman_material_controlled_issue_integrity
        ON handyman_material_controlled_issues;
      DROP TRIGGER IF EXISTS handyman_material_demand_reservation_guard
        ON handyman_material_demands;
      DROP TRIGGER IF EXISTS inventory_material_reservation_source_integrity
        ON inventory_material_reservations
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS reject_handyman_material_inventory_fact_mutation();
      DROP FUNCTION IF EXISTS assert_handyman_material_return_integrity();
      DROP FUNCTION IF EXISTS assert_handyman_material_actual_usage_integrity();
      DROP FUNCTION IF EXISTS assert_handyman_material_controlled_issue_integrity();
      DROP FUNCTION IF EXISTS assert_handyman_material_demand_no_active_reservation();
      DROP FUNCTION IF EXISTS assert_inventory_material_reservation_source_integrity()
    `);

    await client.query('DROP TABLE IF EXISTS handyman_material_returns');
    await client.query('DROP TABLE IF EXISTS handyman_material_actual_usages');
    await client.query('DROP TABLE IF EXISTS handyman_material_controlled_issues');

    // Restore the legacy schema without leaving an active reservation amount
    // stranded on an inventory balance during a development downgrade.
    await client.query(`
      WITH released AS (
        SELECT warehouse_id, item_id, SUM(remaining_quantity)::numeric AS quantity
          FROM inventory_material_reservations
         WHERE source_type = 'HANDYMAN_MATERIAL_DEMAND'
           AND status = 'ACTIVE'
         GROUP BY warehouse_id, item_id
      )
      UPDATE inventory_stock_balances b
         SET reserved_quantity = b.reserved_quantity - released.quantity,
             updated_at = NOW()
        FROM released
       WHERE b.warehouse_id = released.warehouse_id
         AND b.item_id = released.item_id
    `);
    await client.query(`
      DELETE FROM inventory_material_reservations
       WHERE source_type = 'HANDYMAN_MATERIAL_DEMAND'
    `);
    await client.query(`
      DROP INDEX IF EXISTS inventory_material_reservations_client_terminal_key_unique;
      DROP INDEX IF EXISTS inventory_material_reservations_client_key_unique;
      DROP INDEX IF EXISTS inventory_material_reservations_handyman_demand_idx
    `);
    await client.query(`
      ALTER TABLE inventory_material_reservations
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_handyman_terminal_shape_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_terminal_idempotency_pair_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_terminal_fingerprint_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_terminal_key_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_handyman_creation_key_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_idempotency_pair_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_idempotency_fingerprint_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_idempotency_key_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_handyman_demand_scope_fk,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_source_shape_check,
        DROP CONSTRAINT IF EXISTS inventory_material_reservation_source_type_check,
        DROP COLUMN IF EXISTS terminal_idempotency_fingerprint,
        DROP COLUMN IF EXISTS terminal_idempotency_key,
        DROP COLUMN IF EXISTS idempotency_fingerprint,
        DROP COLUMN IF EXISTS idempotency_key,
        DROP COLUMN IF EXISTS handyman_material_demand_id,
        DROP COLUMN IF EXISTS source_type
    `);
    await client.query(`
      ALTER TABLE inventory_material_reservations
        ALTER COLUMN material_request_id SET NOT NULL
    `);
    await client.query(`
      ALTER TABLE handyman_material_demands
        DROP CONSTRAINT IF EXISTS hm_mat_demands_inventory_scope_unique
    `);
  },
};
