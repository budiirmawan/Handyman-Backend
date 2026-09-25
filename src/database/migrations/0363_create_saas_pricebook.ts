import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 02 — versioned SaaS Pricebook (frozen contract §10).
 *
 *   saas_pricebooks          — the commercial catalog book (unique code,
 *                              default currency for items, ACTIVE/INACTIVE).
 *   saas_pricebook_versions  — DRAFT / PUBLISHED / SUPERSEDED; monotonic
 *                              version_number per pricebook; at most ONE
 *                              PUBLISHED version per pricebook at any moment
 *                              (partial unique index — single-publish
 *                              invariant).
 *   saas_price_items         — commercial pricing rows bound to a version
 *                              (product, package nullable, currency,
 *                              billing cycle, base price, included building
 *                              count, additional building price).
 *
 * Historical commercial terms are preserved by two mechanisms:
 *
 *   1. Trigger enforcement: a version that is PUBLISHED may only be mutated
 *      in the single frozen shape — status → SUPERSEDED + closing
 *      `effective_to` (the supersede performed by publishing a new version).
 *      SUPERSEDED versions are terminal. DRAFT versions stay editable until
 *      published. Price items are immutable while their version is
 *      PUBLISHED or SUPERSEDED.
 *   2. Referential design: later PARTs' Subscription records reference
 *      `saas_pricebook_versions.id` (the immutable/versioned commercial
 *      record); republishing never restates existing rows.
 *
 * Currency authority is the global `currencies` table (0331) — no second
 * currency enum. Product/package references reuse the PART 02 catalog
 * tables (0362). No existing table is modified.
 */
export const migration0363CreateSaasPricebook: Migration = {
  id: '0363_create_saas_pricebook',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE saas_pricebooks (
        id UUID PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        currency_code VARCHAR(3) NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_pricebooks_code_unique UNIQUE (code),
        CONSTRAINT saas_pricebooks_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code),
        CONSTRAINT saas_pricebooks_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE TABLE saas_pricebook_versions (
        id UUID PRIMARY KEY,
        pricebook_id UUID NOT NULL,
        version_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        effective_from TIMESTAMPTZ,
        effective_to TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        published_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_pricebook_versions_pricebook_id_fkey
          FOREIGN KEY (pricebook_id) REFERENCES saas_pricebooks (id),
        CONSTRAINT saas_pricebook_versions_published_by_user_id_fkey
          FOREIGN KEY (published_by_user_id) REFERENCES users (id),
        CONSTRAINT saas_pricebook_versions_number_unique
          UNIQUE (pricebook_id, version_number),
        CONSTRAINT saas_pricebook_versions_status_check
          CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
        CONSTRAINT saas_pricebook_versions_period_check
          CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
      )
    `);
    await client.query(`
      CREATE INDEX saas_pricebook_versions_pricebook_idx
        ON saas_pricebook_versions (pricebook_id, version_number DESC);
      CREATE UNIQUE INDEX saas_pricebook_versions_single_published
        ON saas_pricebook_versions (pricebook_id) WHERE status = 'PUBLISHED'
    `);

    await client.query(`
      CREATE TABLE saas_price_items (
        id UUID PRIMARY KEY,
        pricebook_version_id UUID NOT NULL,
        product_id UUID NOT NULL,
        package_id UUID,
        currency_code VARCHAR(3) NOT NULL,
        billing_cycle TEXT NOT NULL,
        base_price NUMERIC(18,2) NOT NULL,
        included_building_count INTEGER NOT NULL DEFAULT 0,
        additional_building_price NUMERIC(18,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_price_items_pricebook_version_id_fkey
          FOREIGN KEY (pricebook_version_id) REFERENCES saas_pricebook_versions (id),
        CONSTRAINT saas_price_items_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES saas_products (id),
        CONSTRAINT saas_price_items_package_id_fkey
          FOREIGN KEY (package_id) REFERENCES saas_packages (id),
        CONSTRAINT saas_price_items_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code),
        CONSTRAINT saas_price_items_cycle_check
          CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL', 'CUSTOM')),
        CONSTRAINT saas_price_items_base_price_check CHECK (base_price >= 0),
        CONSTRAINT saas_price_items_included_check CHECK (included_building_count >= 0),
        CONSTRAINT saas_price_items_additional_check CHECK (additional_building_price >= 0)
      )
    `);
    // Unique per (version, product, package, cycle). COALESCE makes the
    // NULL package_id (platform-wide items) participate in uniqueness —
    // portable across PostgreSQL versions.
    await client.query(`
      CREATE UNIQUE INDEX saas_price_items_version_product_package_cycle_unique
        ON saas_price_items (
          pricebook_version_id,
          product_id,
          COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
          billing_cycle
        );
      CREATE INDEX saas_price_items_version_idx ON saas_price_items (pricebook_version_id)
    `);

    // Immutability (frozen §10.2): a PUBLISHED version may only be mutated
    // in the single frozen shape — status → SUPERSEDED (the supersede
    // performed by publishing a new version), with every other column
    // unchanged. SUPERSEDED versions are terminal. DRAFT versions remain
    // editable until published.
    await client.query(`
      CREATE FUNCTION prevent_pricebook_version_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'SUPERSEDED' THEN
          RAISE EXCEPTION 'superseded pricebook versions are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD.status = 'PUBLISHED' THEN
          IF NEW.status IS DISTINCT FROM 'SUPERSEDED' THEN
            RAISE EXCEPTION 'published pricebook versions are immutable'
              USING ERRCODE = '55000';
          END IF;
          IF NEW.effective_from IS DISTINCT FROM OLD.effective_from
            OR NEW.version_number IS DISTINCT FROM OLD.version_number
            OR NEW.published_at IS DISTINCT FROM OLD.published_at
            OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
            OR NEW.pricebook_id IS DISTINCT FROM OLD.pricebook_id
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'published pricebook versions are immutable'
              USING ERRCODE = '55000';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER saas_pricebook_versions_immutable
        BEFORE UPDATE OR DELETE ON saas_pricebook_versions
        FOR EACH ROW EXECUTE FUNCTION prevent_pricebook_version_mutation()
    `);

    // Price items are immutable while their version is PUBLISHED or
    // SUPERSEDED ("rows immutable with the version", frozen §10.3).
    await client.query(`
      CREATE FUNCTION prevent_price_item_mutation()
      RETURNS trigger AS $$
      DECLARE v_status TEXT;
      BEGIN
        SELECT status INTO v_status
          FROM saas_pricebook_versions
         WHERE id = OLD.pricebook_version_id;
        IF v_status IN ('PUBLISHED', 'SUPERSEDED') THEN
          RAISE EXCEPTION 'price items of published pricebook versions are immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER saas_price_items_immutable
        BEFORE UPDATE OR DELETE ON saas_price_items
        FOR EACH ROW EXECUTE FUNCTION prevent_price_item_mutation()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TRIGGER IF EXISTS saas_price_items_immutable ON saas_price_items');
    await client.query('DROP FUNCTION IF EXISTS prevent_price_item_mutation()');
    await client.query('DROP TRIGGER IF EXISTS saas_pricebook_versions_immutable ON saas_pricebook_versions');
    await client.query('DROP FUNCTION IF EXISTS prevent_pricebook_version_mutation()');
    await client.query('DROP TABLE IF EXISTS saas_price_items');
    await client.query('DROP TABLE IF EXISTS saas_pricebook_versions');
    await client.query('DROP TABLE IF EXISTS saas_pricebooks');
  },
};
