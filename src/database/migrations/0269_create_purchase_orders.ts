import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-R2P-01 PART 01 — Purchase Order Foundation.
 *
 * The Purchase Order is the authoritative COMMITMENT in the R2P chain:
 *
 *   Request → PO Readiness (may commit) → PO (committed) → … → Settlement
 *
 * Frozen PART 01 decisions encoded by this schema:
 *
 *  1. PO Readiness is a PRECONDITION, not a second readiness authority.
 *     `po_readiness_id` is NOT NULL and references BE-17F
 *     `purchase_order_readiness`. The service additionally requires that
 *     readiness to be READY at commit time. This table therefore stores NO
 *     readiness/checks columns of its own — readiness stays owned by BE-17F.
 *
 *  2. Material Request (BE-17B) / Service Request (BE-17C) remain the
 *     quantity authority. This table carries NO quantity, NO ordered/received
 *     ledger and NO amount total. PO Lines (PART 02) will reference request
 *     lines and snapshot commercial terms only.
 *
 *  3. SPK / Work Contract is its own entity (PART 04) and its Work Order
 *     linkage lands in PART 05. Nothing here duplicates BE-17H
 *     `work_order_procurement_bindings`.
 *
 * Client/Building/Vendor and the request reference are DERIVED from the
 * referenced readiness row by the service — never supplied by the caller —
 * so BE-02 isolation and request↔vendor consistency hold structurally.
 *
 * Lifecycle vocabulary: DRAFT, ISSUED, CANCELLED.
 *   - Authoritative API transitions are DRAFT → ISSUED and
 *     DRAFT → CANCELLED; ISSUED and CANCELLED have no outgoing API command.
 *   - DRAFT → ISSUED (issuance / approval readiness) is PART 03 and adds its
 *     own columns additively, mirroring how 0262/0263 extended
 *     `vendor_invoices`. No issuance column is pre-created here.
 */
export const migration0269CreatePurchaseOrders: Migration = {
  id: '0269_create_purchase_orders',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE purchase_orders (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        po_number             TEXT NOT NULL,
        po_date               DATE NOT NULL,
        vendor_id             UUID NOT NULL REFERENCES vendors (id),
        request_type          TEXT NOT NULL,
        purchase_request_id   UUID REFERENCES purchase_requests (id),
        service_request_id    UUID REFERENCES service_requests (id),
        po_readiness_id       UUID NOT NULL REFERENCES purchase_order_readiness (id),
        currency              TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'DRAFT',
        vendor_reference      TEXT,
        required_date         DATE,
        notes                 TEXT,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        cancelled_at          TIMESTAMPTZ,
        cancelled_by_user_id  UUID REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT purchase_orders_request_type_check
          CHECK (request_type IN ('PURCHASE_REQUEST', 'SERVICE_REQUEST')),

        -- Exactly one request reference, consistent with request_type.
        CONSTRAINT purchase_orders_request_reference_check
          CHECK (
            (purchase_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT purchase_orders_request_type_reference_check
          CHECK (
            (request_type = 'PURCHASE_REQUEST' AND purchase_request_id IS NOT NULL)
            OR (request_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
          ),

        CONSTRAINT purchase_orders_status_check
          CHECK (status IN ('DRAFT', 'ISSUED', 'CANCELLED')),

        -- Cancellation actor/timestamp are set together, and only when
        -- CANCELLED. ISSUED state columns arrive with PART 03.
        CONSTRAINT purchase_orders_cancel_state_check
          CHECK (
            (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
            OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)
          ),

        CONSTRAINT purchase_orders_currency_check
          CHECK (currency IN ('IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY')),

        -- PO identity foundation: the PO number is unique within a Client.
        CONSTRAINT purchase_orders_client_number_unique
          UNIQUE (client_id, po_number)
      )
    `);

    // One live commitment per qualifying readiness. A CANCELLED PO releases
    // the readiness so a corrected PO can be raised against it again.
    await client.query(`
      CREATE UNIQUE INDEX purchase_orders_readiness_active_unique
        ON purchase_orders (po_readiness_id)
        WHERE status <> 'CANCELLED'
    `);

    await client.query(`
      CREATE INDEX purchase_orders_vendor_idx
        ON purchase_orders (vendor_id, status, po_date DESC);
      CREATE INDEX purchase_orders_building_idx
        ON purchase_orders (building_id, status, po_date DESC);
      CREATE INDEX purchase_orders_readiness_idx
        ON purchase_orders (po_readiness_id);
      CREATE INDEX purchase_orders_purchase_request_idx
        ON purchase_orders (purchase_request_id)
        WHERE purchase_request_id IS NOT NULL;
      CREATE INDEX purchase_orders_service_request_idx
        ON purchase_orders (service_request_id)
        WHERE service_request_id IS NOT NULL
    `);

    // Append-only audit trail, mirroring vendor_invoice_history (0261).
    await client.query(`
      CREATE TABLE purchase_order_history (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        purchase_order_id   UUID NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
        action              TEXT NOT NULL,
        po_date             DATE,
        currency            TEXT,
        status              TEXT,
        vendor_reference    TEXT,
        required_date       DATE,
        notes               TEXT,
        changed_by_user_id  UUID REFERENCES users (id),
        changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT purchase_order_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED', 'CANCELLED'))
      )
    `);

    await client.query(`
      CREATE INDEX purchase_order_history_po_idx
        ON purchase_order_history (purchase_order_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS purchase_order_history');
    await client.query('DROP TABLE IF EXISTS purchase_orders');
  },
};
