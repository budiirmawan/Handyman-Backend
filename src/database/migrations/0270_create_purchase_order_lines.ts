import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-R2P-01 PART 02 — PO Line & Request Linkage.
 *
 * A Purchase Order Line is the COMMERCIAL COMMITMENT over exactly one
 * originating request line:
 *
 *   Material Request line (BE-17B) ─┐
 *                                   ├─► purchase_order_lines ─► purchase_orders
 *   Service Request      (BE-17C) ─┘
 *
 * QUANTITY AUTHORITY IS UNCHANGED. `material_requests` remains the single
 * quantity authority (requested / approved quantity, the cumulative
 * over-receipt guard and every receiving rule stay exactly where they are).
 * This table therefore deliberately contains:
 *
 *   - NO ordered quantity ledger
 *   - NO received quantity ledger
 *   - NO remaining/outstanding quantity ledger
 *   - NO inventory ledger or stock movement linkage
 *
 * `quantity_snapshot` is a FROZEN COPY of the originating Material Request
 * line's authoritative quantity (`approved_quantity ?? quantity`), captured
 * at commit time purely so the commercial amount can be priced and audited.
 * It is derived by the backend (never client-supplied), never recomputed, and
 * never updated afterwards — reading it is history, not authority. Fulfilment
 * continues to consult `material_requests` alone. It is NULL for a Service
 * Request line, which carries no quantity in BE-17C.
 *
 * `uom_id` preserves the UOM that applied at commit time, following the
 * established snapshot convention (`material_requests.uom_id`,
 * `receivings.uom_id`, `inventory_stock_movements.uom_id` — stable
 * `units_of_measure` FK ids, no conversion engine, no UOM master duplication).
 *
 * `line_number` gives deterministic ordering within a Purchase Order and is
 * unique per PO, following the existing `sequence` / `display_order`
 * convention (patrol_route_points, form_sections, checklist_items).
 */
export const migration0270CreatePurchaseOrderLines: Migration = {
  id: '0270_create_purchase_order_lines',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE purchase_order_lines (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        purchase_order_id     UUID NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        line_number           INTEGER NOT NULL,
        request_line_type     TEXT NOT NULL,

        -- Exactly one originating request line.
        material_request_id   UUID REFERENCES material_requests (id),
        service_request_id    UUID REFERENCES service_requests (id),

        -- Context snapshots (identity references only; the masters stay
        -- authoritative and are never duplicated here).
        item_id               UUID REFERENCES inventory_items (id),
        uom_id                UUID REFERENCES units_of_measure (id),
        description           TEXT NOT NULL,

        -- Frozen copy of the request line's authoritative quantity. NOT a
        -- quantity authority and NOT a ledger: derived at commit time from
        -- material_requests and never mutated. NULL for SERVICE_REQUEST.
        quantity_snapshot     NUMERIC,

        -- Commercial terms committed to the Vendor.
        unit_price            NUMERIC(18, 2) NOT NULL,
        line_amount           NUMERIC(18, 2) NOT NULL,

        notes                 TEXT,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT purchase_order_lines_request_line_type_check
          CHECK (request_line_type IN ('MATERIAL_REQUEST', 'SERVICE_REQUEST')),

        CONSTRAINT purchase_order_lines_request_reference_check
          CHECK (
            (material_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT purchase_order_lines_type_reference_check
          CHECK (
            (request_line_type = 'MATERIAL_REQUEST' AND material_request_id IS NOT NULL)
            OR (request_line_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
          ),

        -- A material line snapshots item + quantity; a service line has
        -- neither (BE-17C carries no item and no quantity).
        CONSTRAINT purchase_order_lines_material_shape_check
          CHECK (
            request_line_type <> 'MATERIAL_REQUEST'
            OR (item_id IS NOT NULL AND quantity_snapshot IS NOT NULL)
          ),
        CONSTRAINT purchase_order_lines_service_shape_check
          CHECK (
            request_line_type <> 'SERVICE_REQUEST'
            OR (item_id IS NULL AND quantity_snapshot IS NULL AND uom_id IS NULL)
          ),

        CONSTRAINT purchase_order_lines_quantity_snapshot_positive
          CHECK (quantity_snapshot IS NULL OR quantity_snapshot > 0),
        CONSTRAINT purchase_order_lines_unit_price_non_negative
          CHECK (unit_price >= 0),
        CONSTRAINT purchase_order_lines_line_amount_non_negative
          CHECK (line_amount >= 0),

        CONSTRAINT purchase_order_lines_line_number_positive
          CHECK (line_number >= 1),

        -- Deterministic ordering: one line number per Purchase Order.
        CONSTRAINT purchase_order_lines_po_line_number_unique
          UNIQUE (purchase_order_id, line_number),

        -- Duplicate linkage protection within one Purchase Order: the same
        -- originating request line is never committed twice on one PO.
        CONSTRAINT purchase_order_lines_po_material_request_unique
          UNIQUE (purchase_order_id, material_request_id),
        CONSTRAINT purchase_order_lines_po_service_request_unique
          UNIQUE (purchase_order_id, service_request_id)
      )
    `);

    await client.query(`
      CREATE INDEX purchase_order_lines_po_idx
        ON purchase_order_lines (purchase_order_id, line_number);
      CREATE INDEX purchase_order_lines_material_request_idx
        ON purchase_order_lines (material_request_id)
        WHERE material_request_id IS NOT NULL;
      CREATE INDEX purchase_order_lines_service_request_idx
        ON purchase_order_lines (service_request_id)
        WHERE service_request_id IS NOT NULL;
      CREATE INDEX purchase_order_lines_building_idx
        ON purchase_order_lines (building_id);
      CREATE INDEX purchase_order_lines_item_idx
        ON purchase_order_lines (item_id)
        WHERE item_id IS NOT NULL
    `);

    // Append-only audit trail, mirroring purchase_order_history (0269).
    await client.query(`
      CREATE TABLE purchase_order_line_history (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        purchase_order_line_id  UUID NOT NULL REFERENCES purchase_order_lines (id) ON DELETE CASCADE,
        purchase_order_id       UUID NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
        action                  TEXT NOT NULL,
        line_number             INTEGER,
        quantity_snapshot       NUMERIC,
        unit_price              NUMERIC(18, 2),
        line_amount             NUMERIC(18, 2),
        notes                   TEXT,
        changed_by_user_id      UUID REFERENCES users (id),
        changed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT purchase_order_line_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED', 'REMOVED'))
      )
    `);

    await client.query(`
      CREATE INDEX purchase_order_line_history_line_idx
        ON purchase_order_line_history (purchase_order_line_id, changed_at);
      CREATE INDEX purchase_order_line_history_po_idx
        ON purchase_order_line_history (purchase_order_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS purchase_order_line_history');
    await client.query('DROP TABLE IF EXISTS purchase_order_lines');
  },
};
