import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-03 RUN 2 — Customer quotation authority.
 *
 * The BM→customer commercial offer for one Handyman Request, built only on
 * governed foundations:
 *
 *   Request → ACTIVE request-service selections (Run 1) → Quotation
 *           → immutable Revisions → Lines (LABOR/MATERIAL/OTHER)
 *           → backend reference-price resolution (CR-BE-PRICE-01/SVC-01)
 *           → SENT exact-revision binding
 *
 * Governance decisions encoded here:
 * - ONE quotation identity supports the whole commercial revision loop
 *   (DRAFT → SENT → WITHDRAWN → new revision → SENT again). The full
 *   governed envelope (APPROVED / REJECTED / EXPIRED / CANCELLED) is encoded
 *   in the status CHECK now; those transitions belong to later CR03 runs —
 *   this migration creates NO approval or link tables.
 * - Revisions are immutable once SUBMITTED (DRAFT → SUBMITTED → SUPERSEDED,
 *   at most one DRAFT per quotation, sequential server-authoritative
 *   revision numbers, no destructive replacement) — the CR-BE-PRO-02
 *   vendor-quotation revision idiom WITHOUT its RFQ/invitation/session
 *   coupling, which belongs to procurement, not customer commerce.
 * - `sent_revision_id` binds a SENT quotation to exactly one SUBMITTED
 *   revision (cross-table FK DEFERRABLE — the 0319 lineage-FK idiom). The
 *   binding is a fact of the SENT state; withdrawal preserves `sent_at` /
 *   `sent_revision_id` as last-sent history.
 * - Lines use the 0325 discriminated-union idiom: LABOR ⇒ governed
 *   service_catalog identity (composite client-scope FK) and NO quantity
 *   (SERVICE pricing has no governed quantity — labor quantities are never
 *   invented); MATERIAL ⇒ inventory item + UOM (composite client-scope FKs
 *   from 0319) + positive quantity; OTHER ⇒ governed description + manual
 *   price. `line_total` is a GENERATED column — totals are derived from
 *   governed lines, never caller-authoritative.
 * - Reference-price provenance is snapshotted on the line
 *   (entry id, scope tier, unit price, as-of, resolution) so the authored
 *   commercial fact is explainable; deviations from a MATCHED reference and
 *   manual prices without a reference REQUIRE a deviation note (CHECKs).
 *   AMBIGUOUS / UOM_INCOMPATIBLE / CURRENCY_INCOMPATIBLE lookups fail closed
 *   in the service and are not representable here (resolution CHECK admits
 *   only MATCHED / NO_REFERENCE_PRICE).
 * - Tenant/customer identity is FROZEN from the request at creation
 *   (snapshot columns); derived authority fields are never caller-supplied.
 * - Idempotency follows the CR-HM-BE-01 key+fingerprint convention.
 * - No pricing engine, discount engine, FX, BM fee, settlement, invoice,
 *   approval, notification, or assignment behavior is created.
 */
export const migration0351CreateHandymanQuotations: Migration = {
  id: '0351_create_handyman_quotations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_quotations (
        id                 UUID PRIMARY KEY,
        request_id         UUID NOT NULL REFERENCES handyman_requests (id),
        client_id          UUID NOT NULL REFERENCES clients (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        quotation_number   TEXT NOT NULL,
        currency           VARCHAR(3) NOT NULL,
        status             TEXT NOT NULL DEFAULT 'DRAFT',
        -- Frozen tenant/customer identity snapshot from the request.
        tenant_company_id  UUID REFERENCES tenant_companies (id),
        tenant_pic_id      UUID REFERENCES tenant_pics (id),
        customer_name      TEXT NOT NULL,
        customer_phone     TEXT,
        customer_email     TEXT,
        -- SENT binds exactly one SUBMITTED revision (FK added below, after
        -- the revisions table exists — DEFERRABLE per the 0319 idiom).
        sent_revision_id   UUID,
        sent_at            TIMESTAMPTZ,
        withdrawn_at       TIMESTAMPTZ,
        idempotency_key    TEXT,
        idempotency_fingerprint TEXT,
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_quotations_number_check
          CHECK (length(btrim(quotation_number)) BETWEEN 1 AND 64),
        CONSTRAINT handyman_quotations_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT handyman_quotations_status_check
          CHECK (status IN (
            'DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED',
            'WITHDRAWN', 'CANCELLED'
          )),
        CONSTRAINT handyman_quotations_customer_name_check
          CHECK (length(btrim(customer_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_quotations_sent_state_check
          CHECK (
            status <> 'SENT'
            OR (sent_revision_id IS NOT NULL AND sent_at IS NOT NULL)
          ),
        CONSTRAINT handyman_quotations_draft_state_check
          CHECK (
            status <> 'DRAFT'
            OR (sent_revision_id IS NULL AND sent_at IS NULL)
          ),
        CONSTRAINT handyman_quotations_withdrawn_state_check
          CHECK (status <> 'WITHDRAWN' OR sent_at IS NOT NULL),
        CONSTRAINT handyman_quotations_idempotency_key_check
          CHECK (idempotency_key IS NULL
            OR length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_quotations_fingerprint_check
          CHECK (idempotency_fingerprint IS NULL
            OR idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT handyman_quotations_idempotency_pair_check
          CHECK (
            (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
          ),
        CONSTRAINT handyman_quotations_client_number_unique
          UNIQUE (client_id, quotation_number),
        -- Composite scope proof for child rows (0313/0319/0321 precedent).
        CONSTRAINT handyman_quotations_scope_unique
          UNIQUE (id, client_id, building_id)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_quotations_client_idempotency_unique
        ON handyman_quotations (client_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX handyman_quotations_request_idx
        ON handyman_quotations (request_id, status, created_at DESC);
      CREATE INDEX handyman_quotations_client_idx
        ON handyman_quotations (client_id, status);
      CREATE INDEX handyman_quotations_building_idx
        ON handyman_quotations (building_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE handyman_quotation_revisions (
        id                  UUID PRIMARY KEY,
        quotation_id        UUID NOT NULL,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        revision_number     INTEGER NOT NULL,
        status              TEXT NOT NULL DEFAULT 'DRAFT',
        notes               TEXT,
        valid_until         DATE,
        submitted_at        TIMESTAMPTZ,
        submitted_by_user_id UUID REFERENCES users (id),
        superseded_at       TIMESTAMPTZ,
        superseded_by_user_id UUID REFERENCES users (id),
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_quotation_revisions_quotation_scope_fk
          FOREIGN KEY (quotation_id, client_id, building_id)
          REFERENCES handyman_quotations (id, client_id, building_id),
        CONSTRAINT handyman_quotation_revisions_status_check
          CHECK (status IN ('DRAFT', 'SUBMITTED', 'SUPERSEDED')),
        CONSTRAINT handyman_quotation_revisions_number_check
          CHECK (revision_number >= 1),
        CONSTRAINT handyman_quotation_revisions_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
        CONSTRAINT handyman_quotation_revisions_state_check
          CHECK (
            (status = 'DRAFT'
              AND submitted_at IS NULL AND submitted_by_user_id IS NULL
              AND superseded_at IS NULL AND superseded_by_user_id IS NULL)
            OR (status = 'SUBMITTED'
              AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
              AND superseded_at IS NULL AND superseded_by_user_id IS NULL)
            OR (status = 'SUPERSEDED'
              AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
              AND superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL)
          ),
        CONSTRAINT handyman_quotation_revisions_number_unique
          UNIQUE (quotation_id, revision_number),
        -- Sent-binding target scope proof.
        CONSTRAINT handyman_quotation_revisions_scope_unique
          UNIQUE (id, quotation_id)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_quotation_revisions_one_draft_unique
        ON handyman_quotation_revisions (quotation_id)
        WHERE status = 'DRAFT'
    `);
    await client.query(`
      CREATE INDEX handyman_quotation_revisions_quotation_idx
        ON handyman_quotation_revisions (quotation_id, revision_number DESC)
    `);

    // Cross-table SENT binding (quotation ↔ revision are mutually aware;
    // DEFERRABLE so send can bind inside one transaction).
    await client.query(`
      ALTER TABLE handyman_quotations
        ADD CONSTRAINT handyman_quotations_sent_revision_fk
        FOREIGN KEY (sent_revision_id)
        REFERENCES handyman_quotation_revisions (id)
        DEFERRABLE INITIALLY DEFERRED
    `);

    await client.query(`
      CREATE TABLE handyman_quotation_lines (
        id                     UUID PRIMARY KEY,
        quotation_revision_id  UUID NOT NULL REFERENCES handyman_quotation_revisions (id),
        quotation_id           UUID NOT NULL,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        line_number            INTEGER NOT NULL,
        line_type              TEXT NOT NULL,
        -- LABOR subject (governed service_catalog identity + snapshot).
        service_catalog_id     UUID,
        -- MATERIAL subject (inventory item + UOM + snapshot).
        inventory_item_id      UUID,
        uom_id                 UUID,
        quantity               NUMERIC(18, 3),
        -- OTHER: governed description (required); LABOR/MATERIAL: optional
        -- customer-facing wording on top of the subject snapshot.
        subject_code           TEXT,
        subject_name           TEXT,
        uom_code               TEXT,
        description            TEXT,
        unit_price             NUMERIC(18, 2) NOT NULL,
        line_total             NUMERIC(18, 2)
          GENERATED ALWAYS AS (
            ROUND(
              CASE WHEN quantity IS NULL THEN unit_price
                   ELSE quantity * unit_price
              END,
            2)
          ) STORED,
        -- Reference-price provenance snapshot (CR-BE-PRICE-01 lookup facts).
        reference_resolution   TEXT,
        reference_price_entry_id UUID REFERENCES price_catalog_entries (id),
        reference_scope_tier   TEXT,
        reference_unit_price   NUMERIC(18, 2),
        reference_as_of        TIMESTAMPTZ,
        deviation_note         TEXT,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_quotation_lines_revision_scope_fk
          FOREIGN KEY (quotation_revision_id, quotation_id)
          REFERENCES handyman_quotation_revisions (id, quotation_id),
        CONSTRAINT handyman_quotation_lines_service_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
          REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_quotation_lines_item_scope_fk
          FOREIGN KEY (inventory_item_id, client_id)
          REFERENCES inventory_items (id, client_id),
        CONSTRAINT handyman_quotation_lines_uom_scope_fk
          FOREIGN KEY (uom_id, client_id)
          REFERENCES units_of_measure (id, client_id),
        CONSTRAINT handyman_quotation_lines_type_check
          CHECK (line_type IN ('LABOR', 'MATERIAL', 'OTHER')),
        CONSTRAINT handyman_quotation_lines_number_check
          CHECK (line_number >= 1),
        CONSTRAINT handyman_quotation_lines_price_check
          CHECK (unit_price > 0),
        CONSTRAINT handyman_quotation_lines_quantity_check
          CHECK (quantity IS NULL OR quantity > 0),
        -- 0325 discriminated-union shape: mode-correct nullness.
        CONSTRAINT handyman_quotation_lines_labor_shape_check
          CHECK (
            line_type <> 'LABOR'
            OR (service_catalog_id IS NOT NULL AND subject_code IS NOT NULL
              AND subject_name IS NOT NULL
              AND inventory_item_id IS NULL AND uom_id IS NULL
              AND uom_code IS NULL
              -- SERVICE pricing has no governed quantity: labor quantities
              -- are never invented.
              AND quantity IS NULL)
          ),
        CONSTRAINT handyman_quotation_lines_material_shape_check
          CHECK (
            line_type <> 'MATERIAL'
            OR (inventory_item_id IS NOT NULL AND uom_id IS NOT NULL
              AND quantity IS NOT NULL
              AND subject_code IS NOT NULL AND subject_name IS NOT NULL
              AND uom_code IS NOT NULL
              AND service_catalog_id IS NULL)
          ),
        CONSTRAINT handyman_quotation_lines_other_shape_check
          CHECK (
            line_type <> 'OTHER'
            OR (service_catalog_id IS NULL AND inventory_item_id IS NULL
              AND uom_id IS NULL AND quantity IS NULL
              AND subject_code IS NULL AND subject_name IS NULL
              AND uom_code IS NULL
              AND description IS NOT NULL
              AND length(btrim(description)) BETWEEN 1 AND 1000)
          ),
        CONSTRAINT handyman_quotation_lines_description_check
          CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
        -- Provenance shape: only governable resolutions are representable;
        -- AMBIGUOUS / incompatible lookups fail closed in the service.
        CONSTRAINT handyman_quotation_lines_reference_resolution_check
          CHECK (reference_resolution IN ('MATCHED', 'NO_REFERENCE_PRICE')),
        CONSTRAINT handyman_quotation_lines_priced_reference_check
          CHECK (
            line_type = 'OTHER'
            OR reference_resolution IS NOT NULL
          ),
        CONSTRAINT handyman_quotation_lines_matched_reference_check
          CHECK (
            reference_resolution <> 'MATCHED'
            OR (reference_price_entry_id IS NOT NULL
              AND reference_scope_tier IS NOT NULL
              AND reference_unit_price IS NOT NULL
              AND reference_as_of IS NOT NULL)
          ),
        CONSTRAINT handyman_quotation_lines_manual_reference_check
          CHECK (
            reference_resolution <> 'NO_REFERENCE_PRICE'
            OR (reference_price_entry_id IS NULL
              AND reference_scope_tier IS NULL
              AND reference_unit_price IS NULL
              AND reference_as_of IS NOT NULL
              -- manual price without a reference REQUIRES a note
              AND deviation_note IS NOT NULL
              AND length(btrim(deviation_note)) BETWEEN 1 AND 1000)
          ),
        CONSTRAINT handyman_quotation_lines_scope_tier_check
          CHECK (reference_scope_tier IS NULL OR reference_scope_tier IN (
            'VENDOR_BUILDING', 'VENDOR', 'BUILDING', 'CLIENT_WIDE'
          )),
        -- Deviation from a MATCHED reference REQUIRES a note.
        CONSTRAINT handyman_quotation_lines_deviation_note_check
          CHECK (
            reference_unit_price IS NULL
            OR reference_unit_price = unit_price
            OR (deviation_note IS NOT NULL
              AND length(btrim(deviation_note)) BETWEEN 1 AND 1000)
          ),
        CONSTRAINT handyman_quotation_lines_deviation_note_length_check
          CHECK (deviation_note IS NULL OR length(btrim(deviation_note)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_quotation_lines_revision_number_unique
          UNIQUE (quotation_revision_id, line_number)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_quotation_lines_revision_idx
        ON handyman_quotation_lines (quotation_revision_id, line_number);
      CREATE INDEX handyman_quotation_lines_quotation_idx
        ON handyman_quotation_lines (quotation_id);
      CREATE INDEX handyman_quotation_lines_service_idx
        ON handyman_quotation_lines (service_catalog_id)
        WHERE service_catalog_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // The cross-table SENT binding must go first: handyman_quotations still
    // depends on handyman_quotation_revisions through the deferred FK.
    await client.query(`
      ALTER TABLE handyman_quotations
        DROP CONSTRAINT IF EXISTS handyman_quotations_sent_revision_fk
    `);
    await client.query('DROP TABLE IF EXISTS handyman_quotation_lines');
    await client.query('DROP TABLE IF EXISTS handyman_quotation_revisions');
    await client.query('DROP TABLE IF EXISTS handyman_quotations');
  },
};
