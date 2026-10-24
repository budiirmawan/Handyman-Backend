import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Parameterized Handyman Service
 * Catalog foundation.
 *
 * The catalog was already split across two authorities:
 *   - `service_catalog` (0321) — the governed Service MASTER (Client-scoped,
 *     `code/name/description/category`, ACTIVE/INACTIVE);
 *   - `handyman_service_variants` (0376) — the Handyman-governed Variant
 *     child (identity/presentation only).
 *
 * This migration adds the PARAMETERIZED layer those two masters cannot
 * express, without touching either of them:
 *
 *   handyman_service_categories
 *       The governed 8-category vocabulary used by the starter import. The
 *       existing `service_catalog.category` column stays the free-text
 *       classification (CR-BE-SVC-01 §4.3); this master simply gives the
 *       24 generic services a governed, Client-scoped category vocabulary
 *       with its own lifecycle. `service_catalog.category` is written with
 *       the category CODE so the two stay reconcilable.
 *
 *   handyman_service_attributes
 *       Configurable technical attribute DEFINITION bound to one service
 *       (data type, unit, required flag, allowed values, free-value flag).
 *       AC capacity / type / drive type are ordinary rows here — nothing
 *       about them is hard-coded in the engine.
 *
 *   handyman_service_variant_attributes
 *       The configured attribute VALUE of one variant — this is what makes a
 *       variant "configurable" rather than a bare label.
 *
 *   handyman_service_commercial_profiles
 *       The per-service commercial posture: FIXED | ESTIMATED |
 *       INSPECTION_FIRST. This is the switch that decides whether a request
 *       may be quoted immediately or must be inspected first.
 *
 *   handyman_service_price_rules
 *       The PRICE RULE: a governed selection rule (service + optional
 *       variant + attribute selector + quantity band + price basis) that
 *       POINTS AT the EXISTING pricing authority
 *       (`price_catalog_entries`, SERVICE mode, migration 0325). The amount,
 *       currency, effective window and scope tier are NEVER duplicated here
 *       — the rule only selects which governed price fact applies. This is
 *       what keeps "one pricing authority" true: no second price table,
 *       no second amount, no second effective-date rule.
 *
 *   handyman_service_request_items
 *       The MIXED item list of one Handyman Service Request: one row per
 *       service/variant/attribute-combination with its own quantity and
 *       access condition. This is what lets ONE request carry several AC
 *       types and several AC capacities at once.
 *
 *   handyman_service_quote_resolutions
 *       The append-only PRICE SNAPSHOT / readiness record of one item at
 *       one effective date. It records the outcome (PRICED |
 *       INSPECTION_REQUIRED | MANUAL_REVIEW), the reason, and — only when
 *       a governed price fact actually resolved — the immutable snapshot of
 *       rule, price-catalog entry, currency, unit amount, quantity, basis
 *       and effective window. A row is written once and never updated:
 *       later price-catalog changes can never rewrite an earlier quote.
 *
 * Isolation law: every table carries `client_id` and proves its Client scope
 * structurally through composite scope-FKs (the 0313/0319/0321/0376
 * precedent). Reads are always Client-scoped.
 *
 * This migration creates NO quotation engine, NO price amount of its own, NO
 * request lifecycle, NO approval and NO customer-facing surface.
 */
export const migration0476HandymanParameterizedServiceCatalog: Migration = {
  id: '0476_handyman_parameterized_service_catalog',

  async up(client: PoolClient): Promise<void> {
    // ------------------------------------------------------------------
    // Governed service categories.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_categories (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        code               TEXT NOT NULL,
        name               TEXT NOT NULL,
        description        TEXT,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_categories_client_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT handyman_service_categories_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_categories_code_check
          CHECK (code ~ '^[A-Z][A-Z0-9_-]*$'
            AND length(btrim(code)) BETWEEN 2 AND 64),
        CONSTRAINT handyman_service_categories_name_check
          CHECK (length(btrim(name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_service_categories_description_check
          CHECK (description IS NULL
            OR length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_service_categories_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_categories_client_idx
        ON handyman_service_categories (client_id, status, code)
    `);

    // ------------------------------------------------------------------
    // Configurable technical attribute definitions.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_attributes (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        service_catalog_id UUID NOT NULL,
        code               TEXT NOT NULL,
        name               TEXT NOT NULL,
        description        TEXT,
        data_type          TEXT NOT NULL,
        unit               TEXT,
        required           BOOLEAN NOT NULL DEFAULT FALSE,
        allow_free_value   BOOLEAN NOT NULL DEFAULT FALSE,
        allowed_values     JSONB NOT NULL DEFAULT '[]'::jsonb,
        sort_order         INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_attributes_service_code_unique
          UNIQUE (service_catalog_id, code),
        CONSTRAINT handyman_service_attributes_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_attributes_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_service_attributes_code_check
          CHECK (code ~ '^[A-Z][A-Z0-9_-]*$'
            AND length(btrim(code)) BETWEEN 2 AND 64),
        CONSTRAINT handyman_service_attributes_name_check
          CHECK (length(btrim(name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_service_attributes_description_check
          CHECK (description IS NULL
            OR length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_service_attributes_data_type_check
          CHECK (data_type IN ('NUMBER', 'TEXT', 'ENUM', 'BOOLEAN')),
        CONSTRAINT handyman_service_attributes_unit_check
          CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 32),
        CONSTRAINT handyman_service_attributes_allowed_values_check
          CHECK (jsonb_typeof(allowed_values) = 'array'),
        CONSTRAINT handyman_service_attributes_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_attributes_service_idx
        ON handyman_service_attributes (service_catalog_id, status, sort_order)
    `);

    // ------------------------------------------------------------------
    // Configured attribute values of a variant.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_variant_attributes (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        service_variant_id UUID NOT NULL,
        attribute_id       UUID NOT NULL,
        value_text         TEXT,
        value_number       NUMERIC(18, 4),
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_variant_attributes_unique
          UNIQUE (service_variant_id, attribute_id),
        CONSTRAINT handyman_service_variant_attributes_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_variant_attributes_variant_scope_fk
          FOREIGN KEY (service_variant_id, client_id)
            REFERENCES handyman_service_variants (id, client_id),
        CONSTRAINT handyman_service_variant_attributes_attribute_scope_fk
          FOREIGN KEY (attribute_id, client_id)
            REFERENCES handyman_service_attributes (id, client_id),
        CONSTRAINT handyman_service_variant_attributes_value_check
          CHECK ((value_text IS NULL) <> (value_number IS NULL)),
        CONSTRAINT handyman_service_variant_attributes_value_text_check
          CHECK (value_text IS NULL OR length(btrim(value_text)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_variant_attributes_variant_idx
        ON handyman_service_variant_attributes (service_variant_id)
    `);

    // ------------------------------------------------------------------
    // Per-service commercial posture (FIXED / ESTIMATED / INSPECTION_FIRST).
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_commercial_profiles (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        service_catalog_id UUID NOT NULL,
        pricing_mode       TEXT NOT NULL,
        notes              TEXT,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_commercial_profiles_service_unique
          UNIQUE (service_catalog_id),
        CONSTRAINT handyman_service_commercial_profiles_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_commercial_profiles_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_service_commercial_profiles_pricing_mode_check
          CHECK (pricing_mode IN ('FIXED', 'ESTIMATED', 'INSPECTION_FIRST')),
        CONSTRAINT handyman_service_commercial_profiles_notes_check
          CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_service_commercial_profiles_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    // ------------------------------------------------------------------
    // Price rules — selection rules over the EXISTING pricing authority.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_price_rules (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        service_catalog_id    UUID NOT NULL,
        service_variant_id    UUID,
        rule_code             TEXT NOT NULL,
        price_catalog_entry_id UUID NOT NULL,
        price_basis           TEXT NOT NULL,
        attribute_selector    JSONB NOT NULL DEFAULT '{}'::jsonb,
        min_quantity          NUMERIC(18, 4),
        max_quantity          NUMERIC(18, 4),
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_price_rules_client_rule_unique
          UNIQUE (client_id, rule_code),
        CONSTRAINT handyman_service_price_rules_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_price_rules_service_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_service_price_rules_variant_scope_fk
          FOREIGN KEY (service_variant_id, client_id)
            REFERENCES handyman_service_variants (id, client_id),
        CONSTRAINT handyman_service_price_rules_entry_scope_fk
          FOREIGN KEY (price_catalog_entry_id, client_id)
            REFERENCES price_catalog_entries (id, client_id),
        CONSTRAINT handyman_service_price_rules_rule_code_check
          CHECK (rule_code ~ '^[A-Z][A-Z0-9_-]*$'
            AND length(btrim(rule_code)) BETWEEN 2 AND 64),
        CONSTRAINT handyman_service_price_rules_basis_check
          CHECK (price_basis IN ('UNIT', 'POINT', 'METER', 'SQM', 'VISIT')),
        CONSTRAINT handyman_service_price_rules_selector_check
          CHECK (jsonb_typeof(attribute_selector) = 'object'),
        CONSTRAINT handyman_service_price_rules_quantity_check
          CHECK (
            (min_quantity IS NULL OR min_quantity > 0)
            AND (max_quantity IS NULL OR max_quantity > 0)
            AND (min_quantity IS NULL OR max_quantity IS NULL
              OR max_quantity >= min_quantity)
          ),
        CONSTRAINT handyman_service_price_rules_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_price_rules_service_idx
        ON handyman_service_price_rules
          (client_id, service_catalog_id, status, min_quantity)
    `);

    // ------------------------------------------------------------------
    // Mixed request items — several services / sizes inside ONE request.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_request_items (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        handyman_request_id UUID NOT NULL,
        service_catalog_id UUID NOT NULL,
        service_variant_id UUID,
        quantity           NUMERIC(18, 4) NOT NULL,
        attribute_values   JSONB NOT NULL DEFAULT '{}'::jsonb,
        access_condition   TEXT NOT NULL DEFAULT 'STANDARD',
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_request_items_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_request_items_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id),
        CONSTRAINT handyman_service_request_items_service_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_service_request_items_variant_scope_fk
          FOREIGN KEY (service_variant_id, client_id)
            REFERENCES handyman_service_variants (id, client_id),
        CONSTRAINT handyman_service_request_items_quantity_check
          CHECK (quantity > 0),
        CONSTRAINT handyman_service_request_items_access_check
          CHECK (access_condition IN
            ('STANDARD', 'DIFFICULT', 'HIGH_FLOOR', 'RESTRICTED')),
        CONSTRAINT handyman_service_request_items_status_check
          CHECK (status IN ('ACTIVE', 'REMOVED')),
        CONSTRAINT handyman_service_request_items_attributes_check
          CHECK (jsonb_typeof(attribute_values) = 'object')
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_request_items_request_idx
        ON handyman_service_request_items
          (handyman_request_id, status, created_at)
    `);

    // ------------------------------------------------------------------
    // Append-only price snapshot / readiness record.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE handyman_service_quote_resolutions (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        handyman_request_id     UUID NOT NULL,
        request_item_id         UUID,
        outcome                 TEXT NOT NULL,
        reason_code             TEXT NOT NULL,
        reason_detail           TEXT,
        price_rule_id           UUID,
        price_catalog_entry_id  UUID,
        currency                VARCHAR(3),
        unit_amount             NUMERIC(18, 2),
        quantity                NUMERIC(18, 4),
        price_basis             TEXT,
        effective_from          TIMESTAMPTZ,
        effective_to            TIMESTAMPTZ,
        computed_total          NUMERIC(18, 2),
        quotation_id            UUID REFERENCES handyman_quotations (id),
        quotation_version_id    UUID REFERENCES handyman_quotation_versions (id),
        quotation_line_id       UUID REFERENCES handyman_quotation_lines (id),
        resolved_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_quote_resolutions_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_quote_resolutions_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id),
        CONSTRAINT handyman_service_quote_resolutions_item_scope_fk
          FOREIGN KEY (request_item_id, client_id)
            REFERENCES handyman_service_request_items (id, client_id),
        CONSTRAINT handyman_service_quote_resolutions_rule_scope_fk
          FOREIGN KEY (price_rule_id, client_id)
            REFERENCES handyman_service_price_rules (id, client_id),
        CONSTRAINT handyman_service_quote_resolutions_entry_scope_fk
          FOREIGN KEY (price_catalog_entry_id, client_id)
            REFERENCES price_catalog_entries (id, client_id),
        CONSTRAINT handyman_service_quote_resolutions_outcome_check
          CHECK (outcome IN
            ('PRICED', 'INSPECTION_REQUIRED', 'MANUAL_REVIEW')),
        CONSTRAINT handyman_service_quote_resolutions_reason_check
          CHECK (reason_code ~ '^[A-Z][A-Z0-9_]*$'
            AND length(btrim(reason_code)) BETWEEN 2 AND 64),
        CONSTRAINT handyman_service_quote_resolutions_detail_check
          CHECK (reason_detail IS NULL
            OR length(btrim(reason_detail)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_service_quote_resolutions_basis_check
          CHECK (price_basis IS NULL
            OR price_basis IN ('UNIT', 'POINT', 'METER', 'SQM', 'VISIT')),
        CONSTRAINT handyman_service_quote_resolutions_currency_check
          CHECK (currency IS NULL OR currency IN
            ('IDR', 'USD', 'SGD', 'MYR', 'AUD',
             'EUR', 'GBP', 'JPY', 'CNY')),
        -- A PRICED row always carries the complete governed snapshot; a
        -- non-priced row NEVER carries an amount (no fictional price).
        CONSTRAINT handyman_service_quote_resolutions_snapshot_check
          CHECK (
            (outcome = 'PRICED'
              AND price_rule_id IS NOT NULL
              AND price_catalog_entry_id IS NOT NULL
              AND currency IS NOT NULL
              AND unit_amount IS NOT NULL
              AND unit_amount >= 0
              AND quantity IS NOT NULL
              AND quantity > 0
              AND price_basis IS NOT NULL
              AND effective_from IS NOT NULL
              AND computed_total IS NOT NULL
              AND computed_total >= 0)
            OR
            (outcome <> 'PRICED'
              AND price_rule_id IS NULL
              AND price_catalog_entry_id IS NULL
              AND currency IS NULL
              AND unit_amount IS NULL
              AND computed_total IS NULL)
          )
      )
    `);
    await client.query(`
      CREATE INDEX handyman_service_quote_resolutions_request_idx
        ON handyman_service_quote_resolutions
          (client_id, handyman_request_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX handyman_service_quote_resolutions_line_idx
        ON handyman_service_quote_resolutions (quotation_line_id)
        WHERE quotation_line_id IS NOT NULL
    `);

    // The price snapshot is immutable: a written resolution can never be
    // rewritten, so a later price-catalog change can never retro-actively
    // alter an earlier quote.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_service_quote_resolution_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman service quote resolutions are immutable snapshot facts.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_service_quote_resolution_no_write
        BEFORE UPDATE OR DELETE ON handyman_service_quote_resolutions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_service_quote_resolution_no_write();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TRIGGER IF EXISTS handyman_service_quote_resolution_no_write ON handyman_service_quote_resolutions',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_service_quote_resolution_no_write',
    );
    await client.query('DROP TABLE IF EXISTS handyman_service_quote_resolutions');
    await client.query('DROP TABLE IF EXISTS handyman_service_request_items');
    await client.query('DROP TABLE IF EXISTS handyman_service_price_rules');
    await client.query('DROP TABLE IF EXISTS handyman_service_commercial_profiles');
    await client.query('DROP TABLE IF EXISTS handyman_service_variant_attributes');
    await client.query('DROP TABLE IF EXISTS handyman_service_attributes');
    await client.query('DROP TABLE IF EXISTS handyman_service_categories');
  },
};
