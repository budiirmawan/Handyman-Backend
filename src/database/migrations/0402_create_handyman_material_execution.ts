import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-09 Material Execution PART 01 — material execution
 * persistence foundation ONLY (FROZEN governance
 * `CR-HM-09_START_GOVERNANCE.md` D1–D7).
 *
 * TWO tables: the per-line aggregate projection and the append-only
 * execution event stream. NO lifecycle evaluator/commands, NO
 * HTTP/OpenAPI, NO pricing/currency/charge/billing/payment columns,
 * NO FM stock movement/reservation/purchase-order/material-request
 * logic anywhere (firewall §REUSE).
 *
 * Invariants (DB-enforced):
 *   1. execution_scope_id FKs handyman_execution_scopes ONLY;
 *      quotation_version_id / quotation_line_id FK the immutable
 *      CR-HM-06 quotation snapshot; source_item_id FKs the
 *      inventory_items master (nullable, read-only reference);
 *   2. client_id structurally consistent with the execution scope
 *      (same consistency-trigger pattern as 0396–0401);
 *   3. ALL quantity columns >= 0;
 *      used_qty <= issued_qty + purchased_qty - returned_qty;
 *      returned_qty <= issued_qty + purchased_qty - used_qty
 *      (RETURNED reduces final usage; it is NEVER a status);
 *   4. acquisition mode is mutually exclusive once quantities exist:
 *      issued_qty > 0 requires ISSUED, purchased_qty > 0 requires
 *      PURCHASED — a line NEVER carries both (governance D4);
 *   5. statuses are exactly ESTIMATED / APPROVED / ISSUED /
 *      PURCHASED / USED / FINAL_CHARGE_READY — RETURNED is NOT a
 *      sticky status (quantity adjustment only);
 *   6. quotation snapshot identity (client/scope/version/line/item)
 *      can never be rewritten once written (identity-immutability
 *      trigger); line DELETE is blocked — history lives in events;
 *   7. events are append-only: exactly seven event types; UNIQUE
 *      (line_id, event_type, idempotency_key) idempotency boundary
 *      (governance D7); ALL UPDATE/DELETE blocked; event
 *      client/scope must equal the parent line's.
 */
export const migration0402CreateHandymanMaterialExecution: Migration = {
  id: '0402_create_handyman_material_execution',
  async up(client: PoolClient): Promise<void> {
    // ---- LINE aggregate projection ------------------------------
    await client.query(`
      CREATE TABLE handyman_material_execution_lines (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id   UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        quotation_version_id UUID NOT NULL
          REFERENCES handyman_quotation_versions (id),
        quotation_line_id    UUID NOT NULL
          REFERENCES handyman_quotation_lines (id),
        source_item_id       UUID
          REFERENCES inventory_items (id),
        status               TEXT NOT NULL DEFAULT 'ESTIMATED',
        acquisition_mode     TEXT,
        estimated_qty        NUMERIC(14, 3) NOT NULL,
        approved_qty         NUMERIC(14, 3) NOT NULL DEFAULT 0,
        issued_qty           NUMERIC(14, 3) NOT NULL DEFAULT 0,
        purchased_qty        NUMERIC(14, 3) NOT NULL DEFAULT 0,
        used_qty             NUMERIC(14, 3) NOT NULL DEFAULT 0,
        returned_qty         NUMERIC(14, 3) NOT NULL DEFAULT 0,
        supplier_reference   VARCHAR(500),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_material_exec_status_check
          CHECK (status IN (
            'ESTIMATED', 'APPROVED', 'ISSUED', 'PURCHASED', 'USED',
            'FINAL_CHARGE_READY')),
        CONSTRAINT handyman_material_exec_acquisition_check
          CHECK (acquisition_mode IS NULL
            OR acquisition_mode IN ('ISSUED', 'PURCHASED')),
        CONSTRAINT handyman_material_exec_estimated_qty_check
          CHECK (estimated_qty >= 0),
        CONSTRAINT handyman_material_exec_approved_qty_check
          CHECK (approved_qty >= 0),
        CONSTRAINT handyman_material_exec_issued_qty_check
          CHECK (issued_qty >= 0),
        CONSTRAINT handyman_material_exec_purchased_qty_check
          CHECK (purchased_qty >= 0),
        CONSTRAINT handyman_material_exec_used_qty_check
          CHECK (used_qty >= 0),
        CONSTRAINT handyman_material_exec_returned_qty_check
          CHECK (returned_qty >= 0),
        CONSTRAINT handyman_material_exec_used_within_held_check
          CHECK (used_qty <= issued_qty + purchased_qty
                   - returned_qty),
        CONSTRAINT handyman_material_exec_returned_within_held_check
          CHECK (returned_qty <= issued_qty + purchased_qty
                   - used_qty),
        -- NULL-safe exclusivity: an unchosen acquisition mode (NULL)
        -- must FAIL when its quantity axis is non-zero; a plain
        -- x = 0 OR mode-equivalence passes on NULL semantics.
        CONSTRAINT handyman_material_exec_acquisition_unique_check
          CHECK (
            (issued_qty = 0
              OR (acquisition_mode IS NOT NULL
                  AND acquisition_mode = 'ISSUED'))
            AND
            (purchased_qty = 0
              OR (acquisition_mode IS NOT NULL
                  AND acquisition_mode = 'PURCHASED')))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_material_exec_lines_scope_idx
        ON handyman_material_execution_lines
        (execution_scope_id, created_at, id)
    `);
    await client.query(`
      CREATE INDEX handyman_material_exec_lines_quotation_idx
        ON handyman_material_execution_lines
        (quotation_version_id, quotation_line_id)
    `);

    // ---- EVENT stream (append-only) -----------------------------
    await client.query(`
      CREATE TABLE handyman_material_execution_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        line_id            UUID NOT NULL
          REFERENCES handyman_material_execution_lines (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        event_type         TEXT NOT NULL,
        idempotency_key    TEXT NOT NULL,
        actor_user_id      UUID NOT NULL
          REFERENCES users (id),
        occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_material_exec_event_type_check
          CHECK (event_type IN (
            'ESTIMATE', 'APPROVE', 'ISSUE', 'PURCHASE', 'USE',
            'RETURN', 'FINAL_CHARGE_READY'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_material_exec_events_idem_idx
        ON handyman_material_execution_events
        (line_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_material_exec_events_line_idx
        ON handyman_material_execution_events
        (line_id, occurred_at, id)
    `);

    // ---- Client/scope consistency (line) ------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_material_exec_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client UUID;
      BEGIN
        SELECT client_id INTO scope_client
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        IF scope_client IS NULL THEN
          -- Absent referent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client THEN
          RAISE EXCEPTION
            'Handyman material execution line client_id must match the execution scope client (cross-client binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_exec_line_client_check
        BEFORE INSERT OR UPDATE ON handyman_material_execution_lines
        FOR EACH ROW
        EXECUTE FUNCTION handyman_material_exec_client_consistency();
    `);

    // Event rows must sit INSIDE the parent line: the client AND the
    // scope must equal the line's (never merely "some consistent
    // triple").
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_material_exec_child_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client UUID;
        parent_scope  UUID;
      BEGIN
        SELECT client_id, execution_scope_id
          INTO parent_client, parent_scope
          FROM handyman_material_execution_lines
          WHERE id = NEW.line_id;
        IF parent_client IS NULL THEN
          -- Absent parent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client
           OR NEW.execution_scope_id IS DISTINCT FROM parent_scope THEN
          RAISE EXCEPTION
            'Handyman material execution event must share the parent line client and execution scope (cross-line/cross-scope binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_exec_event_child_check
        BEFORE INSERT OR UPDATE ON handyman_material_execution_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_material_exec_child_consistency();
    `);

    // ---- Identity immutability (line) ---------------------------
    // Quotation snapshot references and the scope/client binding are
    // written at creation and NEVER rewritten: execution truth must
    // stay anchored to the immutable CR-HM-06 authorized snapshot
    // (governance D3). DELETE is blocked: history lives in events.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_material_exec_line_block_identity_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman material execution lines cannot be deleted: execution history is immutable.';
        END IF;
        IF NEW.client_id IS DISTINCT FROM OLD.client_id
           OR NEW.execution_scope_id IS DISTINCT FROM
                OLD.execution_scope_id
           OR NEW.quotation_version_id IS DISTINCT FROM
                OLD.quotation_version_id
           OR NEW.quotation_line_id IS DISTINCT FROM
                OLD.quotation_line_id
           OR NEW.source_item_id IS DISTINCT FROM OLD.source_item_id
        THEN
          RAISE EXCEPTION
            'Handyman material execution identity references (client/scope/quotation snapshot/item) are immutable once written.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_exec_line_identity_guard
        BEFORE UPDATE OR DELETE ON handyman_material_execution_lines
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_material_exec_line_block_identity_mutation();
    `);

    // ---- Event append-only + identity guard ---------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_material_exec_event_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman material execution events are append-only: history rows cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_exec_event_no_write
        BEFORE UPDATE OR DELETE ON handyman_material_execution_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_material_exec_event_block_mutation();
    `);
  },
};
