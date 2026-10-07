import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRICE-01 PART 01 — Price Authority Foundation.
 *
 * `price_catalog_entries` is the governed reference-price authority defined by
 * `docs/CR-BE-PRICE-01_START_GOVERNANCE.md` (§4–§11):
 *
 *   - ONE flat, Client-scoped authority. No catalogs header table.
 *   - v1 is MATERIAL-only (`source_mode = 'MATERIAL'` fail closed at the DB
 *     level; SERVICE widening is a deliberate future migration once a governed
 *     service identity exists — governance §6 / blocker B-01).
 *   - Subject is exactly one Inventory Item, priced per 1 unit of an explicit
 *     UOM, in one supported currency.
 *   - Scope tiers via nullable keys: Client-wide (both NULL), Building, Vendor,
 *     Vendor+Building. Nullable GiST keys let the four tiers coexist while the
 *     exclusion constraint structurally rejects overlapping ACTIVE windows
 *     within one exact tier (utility-tariff precedent, `0278`).
 *   - Lifecycle DRAFT → ACTIVE → INACTIVE (terminal). No additional states.
 *   - Non-destructive history: price facts are never updated once ACTIVE;
 *     replacement closes the predecessor and points at its successor
 *     (`replaced_by_entry_id`, one successor per predecessor). No deletes.
 *   - Provenance is explicit human provenance only in v1
 *     (`source_type = 'MANUAL'`); silent backfill/adoption is prohibited.
 *
 * This table creates no RFQ, quotation, award, PO, commitment, or actual-cost
 * behavior and is not a commitment origin.
 */
export const migration0319CreatePriceCatalogEntries: Migration = {
  id: '0319_create_price_catalog_entries',

  async up(client: PoolClient): Promise<void> {
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    // Composite scope keys let entries prove Client scope structurally for the
    // item and UOM masters, following the CR-BE-PRO-02 (`0313`) precedent.
    // `vendors` already carries `vendors_rfq_invitation_scope_unique
    // UNIQUE (id, client_id)` from `0314`, so no vendor alter is needed.
    await client.query(`
      ALTER TABLE inventory_items
        ADD CONSTRAINT inventory_items_price_scope_unique
          UNIQUE (id, client_id);
      ALTER TABLE units_of_measure
        ADD CONSTRAINT units_of_measure_price_scope_unique
          UNIQUE (id, client_id)
    `);

    await client.query(`
      CREATE TABLE price_catalog_entries (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID REFERENCES buildings (id),
        vendor_id                UUID,

        -- v1: MATERIAL only. SERVICE activation is blocked at the DB level
        -- until a governed service identity exists (governance §6).
        source_mode              TEXT NOT NULL,
        entry_kind               TEXT NOT NULL,
        item_id                  UUID NOT NULL,
        uom_id                   UUID NOT NULL,

        currency                 VARCHAR(3) NOT NULL,
        -- Positive reference price per 1 unit of the entry UOM (existing
        -- NUMERIC(18,2) monetary convention; strictly greater than zero).
        unit_price               NUMERIC(18, 2) NOT NULL,

        -- Half-open window: [effective_from, effective_to); NULL end = open.
        effective_from           TIMESTAMPTZ NOT NULL,
        effective_to             TIMESTAMPTZ,

        status                   TEXT NOT NULL DEFAULT 'DRAFT',
        activated_at             TIMESTAMPTZ,
        activated_by_user_id     UUID REFERENCES users (id),
        deactivated_at           TIMESTAMPTZ,
        deactivated_by_user_id   UUID REFERENCES users (id),
        -- Self lineage, DEFERRABLE: a replacement closes the predecessor
        -- before inserting its successor inside the same transaction, so the
        -- FK is only satisfiable at commit time.
        replaced_by_entry_id     UUID REFERENCES price_catalog_entries (id)
          DEFERRABLE INITIALLY DEFERRED,

        -- Provenance: v1 admits explicit human maintenance only.
        source_type              TEXT NOT NULL DEFAULT 'MANUAL',
        source_reference         TEXT,
        notes                    TEXT,

        -- Optional human approval attribution (not an approval engine).
        approved_by_user_id      UUID REFERENCES users (id),
        approved_at              TIMESTAMPTZ,

        idempotency_key          TEXT NOT NULL,
        idempotency_fingerprint  TEXT NOT NULL,
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Structural Client-scope proof for the item and UOM masters.
        CONSTRAINT price_catalog_entries_item_scope_fk
          FOREIGN KEY (item_id, client_id)
          REFERENCES inventory_items (id, client_id),
        CONSTRAINT price_catalog_entries_uom_scope_fk
          FOREIGN KEY (uom_id, client_id)
          REFERENCES units_of_measure (id, client_id),
        CONSTRAINT price_catalog_entries_vendor_scope_fk
          FOREIGN KEY (vendor_id, client_id)
          REFERENCES vendors (id, client_id),

        CONSTRAINT price_catalog_entries_source_mode_check
          CHECK (source_mode = 'MATERIAL'),
        CONSTRAINT price_catalog_entries_entry_kind_check
          CHECK (entry_kind IN ('REFERENCE', 'VENDOR_CONTRACT')),
        CONSTRAINT price_catalog_entries_kind_vendor_check
          CHECK ((entry_kind = 'VENDOR_CONTRACT') = (vendor_id IS NOT NULL)),
        CONSTRAINT price_catalog_entries_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'
          )),
        CONSTRAINT price_catalog_entries_unit_price_check
          CHECK (unit_price > 0),
        CONSTRAINT price_catalog_entries_window_check
          CHECK (effective_to IS NULL OR effective_to > effective_from),
        CONSTRAINT price_catalog_entries_status_check
          CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),

        -- Lifecycle correlation: DRAFT untouched, ACTIVE activated only,
        -- INACTIVE activated then terminally deactivated/replaced.
        CONSTRAINT price_catalog_entries_state_check
          CHECK (
            (status = 'DRAFT'
              AND activated_at IS NULL AND activated_by_user_id IS NULL
              AND deactivated_at IS NULL AND deactivated_by_user_id IS NULL
              AND replaced_by_entry_id IS NULL)
            OR (status = 'ACTIVE'
              AND activated_at IS NOT NULL AND activated_by_user_id IS NOT NULL
              AND deactivated_at IS NULL AND deactivated_by_user_id IS NULL
              AND replaced_by_entry_id IS NULL)
            OR (status = 'INACTIVE'
              AND activated_at IS NOT NULL AND activated_by_user_id IS NOT NULL
              AND deactivated_at IS NOT NULL
              AND deactivated_by_user_id IS NOT NULL)
          ),

        CONSTRAINT price_catalog_entries_source_type_check
          CHECK (source_type IN ('MANUAL')),
        CONSTRAINT price_catalog_entries_source_reference_check
          CHECK (
            source_reference IS NULL
              OR length(btrim(source_reference)) BETWEEN 1 AND 200
          ),
        CONSTRAINT price_catalog_entries_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
        CONSTRAINT price_catalog_entries_approval_check
          CHECK (
            (approved_by_user_id IS NULL) = (approved_at IS NULL)
          ),
        CONSTRAINT price_catalog_entries_idempotency_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT price_catalog_entries_idempotency_fingerprint_check
          CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT price_catalog_entries_scope_unique
          UNIQUE (id, client_id),
        CONSTRAINT price_catalog_entries_idempotency_unique
          UNIQUE (client_id, idempotency_key)
      )
    `);

    // Non-destructive replacement: at most one successor may ever point at a
    // predecessor, so a replayed or concurrent replace cannot fork history.
    await client.query(`
      CREATE UNIQUE INDEX price_catalog_entries_successor_unique
        ON price_catalog_entries (replaced_by_entry_id)
        WHERE replaced_by_entry_id IS NOT NULL
    `);

    // Structural fail-closed overlap prevention: two ACTIVE rows with the
    // same exact tier key (item, UOM, currency, building key, vendor key)
    // can never have overlapping half-open windows. NULL keys never collide
    // under GiST equality, so nullable tier keys are COALESCEd to a sentinel:
    // the Client-wide tier (NULL, NULL) collides with itself, while each
    // Building / Vendor / Vendor+Building tier stays a distinct key space
    // and never conflicts with another tier.
    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_active_window_exclusion
        EXCLUDE USING gist (
          client_id WITH =,
          item_id   WITH =,
          uom_id    WITH =,
          currency  WITH =,
          COALESCE(building_id,
            '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          COALESCE(vendor_id,
            '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
        WHERE (status = 'ACTIVE')
    `);

    await client.query(`
      CREATE INDEX price_catalog_entries_client_status_idx
        ON price_catalog_entries (client_id, status, effective_from DESC);
      CREATE INDEX price_catalog_entries_client_item_idx
        ON price_catalog_entries (client_id, item_id, status);
      CREATE INDEX price_catalog_entries_building_idx
        ON price_catalog_entries (building_id, status)
        WHERE building_id IS NOT NULL;
      CREATE INDEX price_catalog_entries_vendor_idx
        ON price_catalog_entries (vendor_id, status)
        WHERE vendor_id IS NOT NULL;
      CREATE INDEX price_catalog_entries_resolution_idx
        ON price_catalog_entries
          (client_id, item_id, currency, uom_id, building_id, vendor_id,
           effective_from DESC)
        WHERE status = 'ACTIVE'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS price_catalog_entries');
    await client.query(`
      ALTER TABLE units_of_measure
        DROP CONSTRAINT IF EXISTS units_of_measure_price_scope_unique;
      ALTER TABLE inventory_items
        DROP CONSTRAINT IF EXISTS inventory_items_price_scope_unique
    `);
  },
};
