import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRO-02 PART 01 — RFQ foundation and typed demand lineage.
 *
 * This is a sourcing record only. RFQ rows contain no quotation, vendor
 * invitation, comparison, award, PO, budget, or commitment value. Material
 * and Service demand share the RFQ authority but are explicitly typed and
 * cannot be mixed on one RFQ.
 *
 * Client / Building / Purchase Request values are immutable snapshots derived
 * from the existing Purchase Request. RFQ lines keep the typed demand-line
 * snapshot needed to preserve what was sourced while the Material Request or
 * Service Request remains authoritative for demand and fulfilment.
 */
export const migration0313CreateRfqs: Migration = {
  id: '0313_create_rfqs',

  async up(client: PoolClient): Promise<void> {
    // Composite keys let the new RFQ records prove scope against the existing
    // demand authorities without creating a second Client/Building source.
    await client.query(`
      ALTER TABLE purchase_requests
        ADD CONSTRAINT purchase_requests_rfq_scope_unique
          UNIQUE (id, client_id, building_id);
      ALTER TABLE material_requests
        ADD CONSTRAINT material_requests_rfq_scope_unique
          UNIQUE (id, client_id, building_id, purchase_request_id);
      ALTER TABLE service_requests
        ADD CONSTRAINT service_requests_rfq_scope_unique
          UNIQUE (id, client_id, building_id, purchase_request_id)
    `);

    await client.query(`
      CREATE TABLE rfqs (
        id                           UUID PRIMARY KEY,
        client_id                    UUID NOT NULL,
        building_id                  UUID NOT NULL,
        purchase_request_id          UUID NOT NULL,
        source_mode                  TEXT NOT NULL,
        rfq_number                   TEXT NOT NULL,
        title                        TEXT NOT NULL,
        description                  TEXT,
        currency                     VARCHAR(3) NOT NULL,
        required_date                TIMESTAMPTZ,
        response_deadline            TIMESTAMPTZ,

        -- Immutable source/context snapshots. The referenced authorities stay
        -- authoritative; these columns preserve the sourcing-time view.
        source_request_number        TEXT NOT NULL,
        source_request_title         TEXT NOT NULL,
        source_request_status        TEXT NOT NULL,

        status                       TEXT NOT NULL DEFAULT 'DRAFT',
        opened_at                    TIMESTAMPTZ,
        opened_by_user_id            UUID REFERENCES users (id),
        closed_at                    TIMESTAMPTZ,
        closed_by_user_id            UUID REFERENCES users (id),
        cancelled_at                 TIMESTAMPTZ,
        cancelled_by_user_id         UUID REFERENCES users (id),
        idempotency_key              TEXT NOT NULL,
        idempotency_fingerprint      TEXT NOT NULL,
        created_by_user_id           UUID NOT NULL REFERENCES users (id),
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfqs_purchase_request_scope_fk
          FOREIGN KEY (purchase_request_id, client_id, building_id)
          REFERENCES purchase_requests (id, client_id, building_id),
        CONSTRAINT rfqs_source_mode_check
          CHECK (source_mode IN ('MATERIAL', 'SERVICE')),
        CONSTRAINT rfqs_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT rfqs_number_check
          CHECK (rfq_number ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
        CONSTRAINT rfqs_title_check
          CHECK (length(btrim(title)) BETWEEN 1 AND 200),
        CONSTRAINT rfqs_status_check
          CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED')),
        CONSTRAINT rfqs_idempotency_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT rfqs_idempotency_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rfqs_scope_key_unique
          UNIQUE (id, source_mode, client_id, building_id, purchase_request_id),
        CONSTRAINT rfqs_client_number_unique
          UNIQUE (client_id, rfq_number),
        CONSTRAINT rfqs_client_idempotency_unique
          UNIQUE (client_id, idempotency_key),
        CONSTRAINT rfqs_open_state_check
          CHECK (
            (status = 'DRAFT' AND opened_at IS NULL AND opened_by_user_id IS NULL
              AND closed_at IS NULL AND closed_by_user_id IS NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
            OR (status = 'OPEN' AND opened_at IS NOT NULL AND opened_by_user_id IS NOT NULL
              AND closed_at IS NULL AND closed_by_user_id IS NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
            OR (status = 'CLOSED' AND opened_at IS NOT NULL AND opened_by_user_id IS NOT NULL
              AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
            OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX rfqs_client_status_idx
        ON rfqs (client_id, status, created_at DESC);
      CREATE INDEX rfqs_building_status_idx
        ON rfqs (building_id, status, created_at DESC);
      CREATE INDEX rfqs_purchase_request_idx
        ON rfqs (purchase_request_id, status, created_at DESC);
      CREATE INDEX rfqs_source_mode_idx
        ON rfqs (source_mode, status, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE rfq_lines (
        id                      UUID PRIMARY KEY,
        rfq_id                  UUID NOT NULL,
        source_mode             TEXT NOT NULL,
        client_id               UUID NOT NULL,
        building_id             UUID NOT NULL,
        purchase_request_id     UUID NOT NULL,
        line_number             INTEGER NOT NULL,
        material_request_id     UUID,
        service_request_id      UUID,

        -- Immutable sourcing-time demand snapshot. These are not demand or
        -- fulfilment authorities and contain no price.
        source_description      TEXT NOT NULL,
        source_item_id          UUID REFERENCES inventory_items (id),
        source_uom_id           UUID REFERENCES units_of_measure (id),
        quantity_snapshot       NUMERIC,
        source_required_date    TIMESTAMPTZ,
        source_claim_status     TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT rfq_lines_rfq_scope_fk
          FOREIGN KEY (rfq_id, source_mode, client_id, building_id,
                       purchase_request_id)
          REFERENCES rfqs (id, source_mode, client_id, building_id,
                            purchase_request_id),
        CONSTRAINT rfq_lines_source_mode_check
          CHECK (source_mode IN ('MATERIAL', 'SERVICE')),
        CONSTRAINT rfq_lines_source_reference_check
          CHECK (
            (material_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT rfq_lines_source_type_check
          CHECK (
            (source_mode = 'MATERIAL' AND material_request_id IS NOT NULL
              AND service_request_id IS NULL)
            OR (source_mode = 'SERVICE' AND service_request_id IS NOT NULL
              AND material_request_id IS NULL)
          ),
        CONSTRAINT rfq_lines_material_scope_fk
          FOREIGN KEY (material_request_id, client_id, building_id,
                       purchase_request_id)
          REFERENCES material_requests (id, client_id, building_id,
                                         purchase_request_id),
        CONSTRAINT rfq_lines_service_scope_fk
          FOREIGN KEY (service_request_id, client_id, building_id,
                       purchase_request_id)
          REFERENCES service_requests (id, client_id, building_id,
                                        purchase_request_id),
        CONSTRAINT rfq_lines_line_number_check
          CHECK (line_number >= 1),
        CONSTRAINT rfq_lines_description_check
          CHECK (length(btrim(source_description)) BETWEEN 1 AND 500),
        CONSTRAINT rfq_lines_material_shape_check
          CHECK (
            source_mode <> 'MATERIAL'
            OR (source_item_id IS NOT NULL AND quantity_snapshot IS NOT NULL
              AND quantity_snapshot > 0)
          ),
        CONSTRAINT rfq_lines_service_shape_check
          CHECK (
            source_mode <> 'SERVICE'
            OR (source_item_id IS NULL AND source_uom_id IS NULL
              AND quantity_snapshot IS NULL)
          ),
        CONSTRAINT rfq_lines_source_claim_status_check
          CHECK (source_claim_status IN ('ACTIVE', 'RELEASED')),
        CONSTRAINT rfq_lines_rfq_line_number_unique
          UNIQUE (rfq_id, line_number)
      )
    `);

    await client.query(`
      CREATE INDEX rfq_lines_rfq_idx
        ON rfq_lines (rfq_id, line_number);
      CREATE UNIQUE INDEX rfq_lines_material_source_unique
        ON rfq_lines (material_request_id)
        WHERE material_request_id IS NOT NULL AND source_claim_status = 'ACTIVE';
      CREATE UNIQUE INDEX rfq_lines_service_source_unique
        ON rfq_lines (service_request_id)
        WHERE service_request_id IS NOT NULL AND source_claim_status = 'ACTIVE';
      CREATE INDEX rfq_lines_scope_idx
        ON rfq_lines (client_id, building_id, source_mode)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS rfq_lines');
    await client.query('DROP TABLE IF EXISTS rfqs');
    await client.query(`
      ALTER TABLE service_requests
        DROP CONSTRAINT IF EXISTS service_requests_rfq_scope_unique;
      ALTER TABLE material_requests
        DROP CONSTRAINT IF EXISTS material_requests_rfq_scope_unique;
      ALTER TABLE purchase_requests
        DROP CONSTRAINT IF EXISTS purchase_requests_rfq_scope_unique
    `);
  },
};
