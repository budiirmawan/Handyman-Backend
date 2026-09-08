import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Operational Commitment header.
 *
 * A commitment is an approved obligation, denominated in its budget's
 * currency, that consumes available budget from the moment it is created and
 * stops consuming it only when it is released or cancelled. Actualization
 * moves value from `open_amount` to `actualized_amount` WITHOUT freeing
 * budget — that is the structural no-double-counting foundation for PART 03+.
 *
 * Snapshots are immutable: `budget_id`, `budget_category_id`, `client_id`,
 * `building_id`, `currency`, `origin` and the typed source reference are set
 * once at creation and are never rewritten. Amount changes are only ever
 * expressed as new append-only ledger entries (migration 0312).
 *
 * Composite foreign keys follow the CR-BE-FIN-01 PART 03 (0284) precedent so
 * a commitment can never drift from its budget's Client/Building or from its
 * category's budget.
 *
 * The typed Purchase Order columns exist so the later material/vendor PARTs
 * cannot introduce a second commitment authority, and so an authoritative
 * source can be committed at most once. PART 02 creates NO commitment from a
 * Purchase Order: only `MANUAL` origin is reachable from the service layer.
 */
export const migration0311CreateOperationalCommitments: Migration = {
  id: '0311_create_operational_commitments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE operational_commitments (
        id                            UUID PRIMARY KEY,
        client_id                     UUID NOT NULL REFERENCES clients (id),
        building_id                   UUID NOT NULL REFERENCES buildings (id),
        budget_id                     UUID NOT NULL,
        budget_category_id            UUID NOT NULL,

        origin                        TEXT NOT NULL,
        source_type                   TEXT,
        purchase_order_id             UUID REFERENCES purchase_orders (id),
        purchase_order_line_id        UUID REFERENCES purchase_order_lines (id),

        -- Traceability references only. They confer no amount authority and
        -- are never used to derive a commitment.
        work_order_id                 UUID REFERENCES work_orders (id),
        vendor_id                     UUID REFERENCES vendors (id),
        material_request_id           UUID REFERENCES material_requests (id),

        currency                      VARCHAR(3) NOT NULL,
        committed_amount              NUMERIC(18, 2) NOT NULL,
        actualized_amount             NUMERIC(18, 2) NOT NULL DEFAULT 0,
        released_amount               NUMERIC(18, 2) NOT NULL DEFAULT 0,
        open_amount                   NUMERIC(18, 2)
          GENERATED ALWAYS AS (committed_amount - actualized_amount - released_amount) STORED,

        status                        TEXT NOT NULL DEFAULT 'COMMITTED',
        title                         TEXT NOT NULL,
        reason                        TEXT,

        -- Overspend override provenance (only meaningful for a budget whose
        -- policy is ALLOW_WITH_OVERRIDE at creation/increase time).
        overspend_override_reason     TEXT,
        overspend_override_by_user_id UUID REFERENCES users (id),
        overspend_override_at         TIMESTAMPTZ,

        idempotency_key               TEXT NOT NULL,
        created_by_user_id            UUID NOT NULL REFERENCES users (id),
        closed_at                     TIMESTAMPTZ,
        closed_by_user_id             UUID REFERENCES users (id),
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT operational_commitments_budget_scope_fk
          FOREIGN KEY (budget_id, client_id, building_id)
          REFERENCES operational_budgets (id, client_id, building_id),
        CONSTRAINT operational_commitments_category_fk
          FOREIGN KEY (budget_category_id, budget_id)
          REFERENCES operational_budget_categories (id, budget_id),

        CONSTRAINT operational_commitments_origin_check
          CHECK (origin IN ('MANUAL', 'PO_LINE', 'PO_HEADER')),
        CONSTRAINT operational_commitments_source_type_check
          CHECK (source_type IS NULL OR source_type IN ('PURCHASE_ORDER', 'PO_LINE')),

        -- Exactly one typed source for a source-derived origin; none at all
        -- for MANUAL. A manual estimate must state why it exists.
        CONSTRAINT operational_commitments_origin_source_check
          CHECK (
            (
              origin = 'MANUAL'
              AND source_type IS NULL
              AND purchase_order_id IS NULL
              AND purchase_order_line_id IS NULL
              AND reason IS NOT NULL
              AND length(btrim(reason)) > 0
            )
            OR (
              origin = 'PO_HEADER'
              AND source_type = 'PURCHASE_ORDER'
              AND purchase_order_id IS NOT NULL
              AND purchase_order_line_id IS NULL
            )
            OR (
              origin = 'PO_LINE'
              AND source_type = 'PO_LINE'
              AND purchase_order_line_id IS NOT NULL
              AND purchase_order_id IS NULL
            )
          ),

        CONSTRAINT operational_commitments_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),

        CONSTRAINT operational_commitments_title_check
          CHECK (length(btrim(title)) BETWEEN 1 AND 160),

        -- A zero-amount obligation is not an obligation.
        CONSTRAINT operational_commitments_committed_amount_check
          CHECK (committed_amount > 0),
        CONSTRAINT operational_commitments_actualized_amount_check
          CHECK (actualized_amount >= 0),
        CONSTRAINT operational_commitments_released_amount_check
          CHECK (released_amount >= 0),
        CONSTRAINT operational_commitments_consumption_check
          CHECK (actualized_amount + released_amount <= committed_amount),

        CONSTRAINT operational_commitments_status_check
          CHECK (status IN (
            'COMMITTED', 'PARTIALLY_ACTUALIZED',
            'ACTUALIZED', 'RELEASED', 'CANCELLED'
          )),

        -- Status is a pure function of the three amounts. Release closes the
        -- whole remainder, so a released commitment is always terminal.
        CONSTRAINT operational_commitments_status_consistency_check
          CHECK (
            (
              status = 'COMMITTED'
              AND actualized_amount = 0 AND released_amount = 0
              AND closed_at IS NULL
            )
            OR (
              status = 'PARTIALLY_ACTUALIZED'
              AND actualized_amount > 0 AND released_amount = 0
              AND actualized_amount < committed_amount
              AND closed_at IS NULL
            )
            OR (
              status = 'ACTUALIZED'
              AND actualized_amount = committed_amount AND released_amount = 0
              AND closed_at IS NOT NULL
            )
            OR (
              status = 'RELEASED'
              AND released_amount > 0
              AND actualized_amount + released_amount = committed_amount
              AND closed_at IS NOT NULL
            )
            OR (
              status = 'CANCELLED'
              AND actualized_amount = 0 AND released_amount = 0
              AND closed_at IS NOT NULL
            )
          ),

        CONSTRAINT operational_commitments_closure_actor_check
          CHECK ((closed_at IS NULL) = (closed_by_user_id IS NULL)),

        CONSTRAINT operational_commitments_override_check
          CHECK (
            (
              overspend_override_reason IS NULL
              AND overspend_override_by_user_id IS NULL
              AND overspend_override_at IS NULL
            )
            OR (
              overspend_override_reason IS NOT NULL
              AND length(btrim(overspend_override_reason)) > 0
              AND overspend_override_by_user_id IS NOT NULL
              AND overspend_override_at IS NOT NULL
            )
          ),

        -- Creation idempotency: a replayed create resolves to the same row.
        CONSTRAINT operational_commitments_idempotency_unique
          UNIQUE (budget_id, idempotency_key)
      )
    `);

    // An authoritative source may back at most one live commitment. A
    // cancelled commitment releases the source so a corrected one can be
    // raised. These indexes are the structural no-double-counting guard for
    // the later PARTs; PART 02 never populates them.
    await client.query(`
      CREATE UNIQUE INDEX operational_commitments_purchase_order_unique
        ON operational_commitments (purchase_order_id)
        WHERE purchase_order_id IS NOT NULL AND status <> 'CANCELLED';
      CREATE UNIQUE INDEX operational_commitments_po_line_unique
        ON operational_commitments (purchase_order_line_id)
        WHERE purchase_order_line_id IS NOT NULL AND status <> 'CANCELLED'
    `);

    await client.query(`
      CREATE INDEX operational_commitments_budget_idx
        ON operational_commitments (budget_id, status, created_at);
      CREATE INDEX operational_commitments_category_idx
        ON operational_commitments (budget_category_id, status);
      CREATE INDEX operational_commitments_client_building_idx
        ON operational_commitments (client_id, building_id, status);
      CREATE INDEX operational_commitments_work_order_idx
        ON operational_commitments (work_order_id)
        WHERE work_order_id IS NOT NULL;
      CREATE INDEX operational_commitments_vendor_idx
        ON operational_commitments (vendor_id)
        WHERE vendor_id IS NOT NULL;
      CREATE INDEX operational_commitments_material_request_idx
        ON operational_commitments (material_request_id)
        WHERE material_request_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS operational_commitments');
  },
};
