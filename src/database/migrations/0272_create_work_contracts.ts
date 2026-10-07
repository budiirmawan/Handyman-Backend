import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-R2P-01 PART 04 — SPK / Work Contract Foundation.
 *
 * The SPK (Surat Perintah Kerja / Work Contract) is the EXECUTION MANDATE
 * that follows a committed Purchase Order in the R2P chain:
 *
 *   Request → PO Readiness → PO (committed) → **SPK** → Work Order → BAST
 *           → Vendor Invoice → Verification → Payment → Settlement
 *
 * Frozen decisions encoded by this schema:
 *
 *  1. SPK is its OWN entity. It does NOT duplicate the BE-17H
 *     `work_order_procurement_bindings` domain, and it adds NO column to
 *     `work_orders`. SPK → Work Order linkage is PART 05 and lands additively
 *     there; nothing here anticipates it.
 *
 *  2. The SPK hangs off an ISSUED Purchase Order. `purchase_order_id` is NOT
 *     NULL; the service additionally requires that PO to be ISSUED at
 *     creation time — a DRAFT commitment is not yet a mandate to execute, and
 *     a CANCELLED one never will be.
 *
 *  3. Client / Building / Vendor are INHERITED from the Purchase Order by the
 *     service and are never caller-supplied. They are denormalized onto this
 *     table so BE-02 Building isolation and vendor consistency can be
 *     enforced structurally (and cheaply) on every read — the composite FK
 *     below guarantees they can never drift from the PO.
 *
 *  4. PO issuance, MR/SR quantity authority, receiving/inventory and
 *     invoice/payment/settlement are untouched. This table carries no
 *     quantity, no amount ledger and no readiness verdict.
 *
 * Lifecycle: DRAFT → ACTIVE → COMPLETED / CANCELLED.
 *   - DRAFT     — mandate prepared; still editable.
 *   - ACTIVE    — work authorized; the SPK is in force.
 *   - COMPLETED — terminal, reached only from ACTIVE.
 *   - CANCELLED — terminal, reachable from DRAFT or ACTIVE.
 */
export const migration0272CreateWorkContracts: Migration = {
  id: '0272_create_work_contracts',

  async up(client: PoolClient): Promise<void> {
    // Composite uniqueness on the PO's own scope. This is the target of the
    // work_contracts composite FK below: it makes "the SPK's client/building/
    // vendor equals its PO's client/building/vendor" a database guarantee
    // rather than an application convention.
    await client.query(`
      ALTER TABLE purchase_orders
        ADD CONSTRAINT purchase_orders_scope_unique
          UNIQUE (id, client_id, building_id, vendor_id)
    `);

    await client.query(`
      CREATE TABLE work_contracts (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- Inherited from the Purchase Order; never caller-supplied.
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        vendor_id             UUID NOT NULL REFERENCES vendors (id),

        -- The committed Purchase Order this mandate executes.
        purchase_order_id     UUID NOT NULL REFERENCES purchase_orders (id),

        -- Deterministic SPK identity, unique within a Client.
        spk_number            TEXT NOT NULL,
        spk_date              DATE NOT NULL,

        title                 TEXT NOT NULL,
        scope_description     TEXT,
        start_date            DATE,
        end_date              DATE,
        notes                 TEXT,

        status                TEXT NOT NULL DEFAULT 'DRAFT',

        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        activated_at          TIMESTAMPTZ,
        activated_by_user_id  UUID REFERENCES users (id),
        completed_at          TIMESTAMPTZ,
        completed_by_user_id  UUID REFERENCES users (id),
        cancelled_at          TIMESTAMPTZ,
        cancelled_by_user_id  UUID REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT work_contracts_status_check
          CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED')),

        -- SPK identity foundation: the SPK number is unique within a Client.
        CONSTRAINT work_contracts_client_number_unique
          UNIQUE (client_id, spk_number),

        -- Inherited scope can never drift from the Purchase Order's own.
        CONSTRAINT work_contracts_po_scope_fk
          FOREIGN KEY (purchase_order_id, client_id, building_id, vendor_id)
          REFERENCES purchase_orders (id, client_id, building_id, vendor_id),

        -- A work window must be coherent when both ends are known.
        CONSTRAINT work_contracts_date_window_check
          CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),

        -- Lifecycle provenance is set together with the state it records.
        -- ACTIVE is a prerequisite of COMPLETED, so a completed SPK keeps its
        -- activation stamp; a cancelled SPK keeps whatever it had reached.
        CONSTRAINT work_contracts_activate_state_check
          CHECK (
            (activated_at IS NULL) = (activated_by_user_id IS NULL)
          ),
        CONSTRAINT work_contracts_complete_state_check
          CHECK (
            (completed_at IS NULL) = (completed_by_user_id IS NULL)
          ),
        CONSTRAINT work_contracts_cancel_state_check
          CHECK (
            (cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)
          ),
        CONSTRAINT work_contracts_status_provenance_check
          CHECK (
            (status = 'DRAFT'
              AND activated_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
            OR (status = 'ACTIVE'
              AND activated_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL)
            OR (status = 'COMPLETED'
              AND activated_at IS NOT NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL)
            OR (status = 'CANCELLED'
              AND completed_at IS NULL AND cancelled_at IS NOT NULL)
          )
      )
    `);

    // Duplicate protection: at most ONE live (DRAFT or ACTIVE) SPK per
    // Purchase Order. Completing or cancelling an SPK releases the PO so a
    // corrected or follow-up mandate can be raised against it.
    await client.query(`
      CREATE UNIQUE INDEX work_contracts_po_live_unique
        ON work_contracts (purchase_order_id)
        WHERE status IN ('DRAFT', 'ACTIVE')
    `);

    await client.query(`
      CREATE INDEX work_contracts_building_idx
        ON work_contracts (building_id, status, spk_date DESC);
      CREATE INDEX work_contracts_vendor_idx
        ON work_contracts (vendor_id, status, spk_date DESC);
      CREATE INDEX work_contracts_purchase_order_idx
        ON work_contracts (purchase_order_id);
      CREATE INDEX work_contracts_client_idx
        ON work_contracts (client_id, status, spk_date DESC)
    `);

    // Append-only audit trail, mirroring purchase_order_history (0269).
    await client.query(`
      CREATE TABLE work_contract_history (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        work_contract_id    UUID NOT NULL REFERENCES work_contracts (id) ON DELETE CASCADE,
        action              TEXT NOT NULL,
        spk_date            DATE,
        title               TEXT,
        scope_description   TEXT,
        start_date          DATE,
        end_date            DATE,
        status              TEXT,
        notes               TEXT,
        changed_by_user_id  UUID REFERENCES users (id),
        changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT work_contract_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED', 'ACTIVATED', 'COMPLETED', 'CANCELLED'))
      )
    `);

    await client.query(`
      CREATE INDEX work_contract_history_contract_idx
        ON work_contract_history (work_contract_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_contract_history');
    await client.query('DROP TABLE IF EXISTS work_contracts');
    // Dropped last: the composite unique was only needed as the SPK FK target.
    await client.query(`
      ALTER TABLE purchase_orders
        DROP CONSTRAINT IF EXISTS purchase_orders_scope_unique
    `);
  },
};
