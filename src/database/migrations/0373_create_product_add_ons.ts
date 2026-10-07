import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 13C — Add-on storage (frozen §9.5 + §6 binding).
 *
 * Frozen §9.5 EXPLICITLY names the catalogue table `product_add_ons`
 * (no `saas_` prefix). The frozen contract names only the logical
 * entity `SubscriptionAddOn` (ER diagram §6); the binding table
 * physical name is implementation-defined; we choose
 * `saas_subscription_add_ons` to follow the PART 02 catalog naming
 * convention (`saas_products`, `saas_packages`, etc.).
 *
 * Authoritative columns are constrained strictly to what frozen
 * §9.5 enumerates (plus timestamps per PART 02 0362 repository
 * convention). No `version` column on the catalogue: per PART 13C #6
 * the 5 frozen §22 routes take no Idempotency-Key and no OCC on
 * the catalogue (§22 PATCH add-on row carries no `ver` marker; the
 * §17.3 versioned-aggregate list does NOT include `product_add_ons`).
 * The subscription OCC (already present on `subscriptions`) is the
 * anchor for attach/detach.
 *
 *   1. `product_add_ons` — the platform-global add-on catalogue
 *      (frozen §9.5: `id`, `product_id`, `code` unique per product,
 *      `name`, `description`, `status`, `entitlement_effects` JSONB,
 *      `quota_effects` JSONB, plus `created_at`/`updated_at`).
 *
 *   2. `saas_subscription_add_ons` — the binding edge between a
 *      subscription and a single add-on (frozen §6 ER diagram:
 *      `Subscription 1 ─ 0..n SubscriptionAddOn`). Lifecycle column
 *      `status` ∈ {ACTIVE, REMOVED}. A partial unique ACTIVE index
 *      prevents the duplicate binding the brief proof 12 requires;
 *      historical REMOVED rows are preserved (the index is on ACTIVE
 *      rows only).
 *
 * No `module_entitlements` ALTER is performed here — PART 04 (0365)
 * already gave that table the `source` column with the frozen
 * vocabulary. The one-active-per-(subscription, module) partial
 * unique index from 0016 is the storage invariant: PACKAGE and
 * ADD_ON CANNOT coexist as separate ACTIVE rows; the add-on attach
 * path suspends the prior ACTIVE row before materialising the
 * ADD_ON source grant (see service-layer docstring). For PACKAGE
 * restoration on detach, the service reuses the canonical PART 04
 * `syncPackageEntitlements` seam rather than inventing a new
 * algorithm.
 *
 * Conventions follow PART 02 0362 and PART 04 0365: additive, no
 * destructive rewrite, partial unique over ACTIVE rows.
 */
export const migration0373CreateProductAddOns: Migration = {
  id: '0373_create_product_add_ons',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE product_add_ons (
        id UUID PRIMARY KEY,
        product_id UUID NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        entitlement_effects JSONB NOT NULL DEFAULT '[]'::jsonb,
        quota_effects JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT product_add_ons_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES saas_products (id),
        CONSTRAINT product_add_ons_product_code_unique
          UNIQUE (product_id, code),
        CONSTRAINT product_add_ons_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT product_add_ons_entitlement_effects_is_array_check
          CHECK (jsonb_typeof(entitlement_effects) = 'array'),
        CONSTRAINT product_add_ons_quota_effects_is_array_check
          CHECK (jsonb_typeof(quota_effects) = 'array')
      )
    `);
    await client.query(`
      CREATE INDEX product_add_ons_product_idx
        ON product_add_ons (product_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX product_add_ons_status_idx
        ON product_add_ons (status) WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE TABLE saas_subscription_add_ons (
        id UUID PRIMARY KEY,
        subscription_id UUID NOT NULL,
        add_on_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_subscription_add_ons_subscription_id_fkey
          FOREIGN KEY (subscription_id) REFERENCES subscriptions (id),
        CONSTRAINT saas_subscription_add_ons_add_on_id_fkey
          FOREIGN KEY (add_on_id) REFERENCES product_add_ons (id),
        CONSTRAINT saas_subscription_add_ons_status_check
          CHECK (status IN ('ACTIVE', 'REMOVED'))
      )
    `);
    // One ACTIVE binding per (subscription, add-on) pair. Historical
    // REMOVED bindings are preserved (proof 12).
    await client.query(`
      CREATE UNIQUE INDEX saas_subscription_add_ons_active_unique
        ON saas_subscription_add_ons (subscription_id, add_on_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX saas_subscription_add_ons_subscription_idx
        ON saas_subscription_add_ons (subscription_id, status)
    `);
    await client.query(`
      CREATE INDEX saas_subscription_add_ons_add_on_idx
        ON saas_subscription_add_ons (add_on_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS saas_subscription_add_ons');
    await client.query('DROP TABLE IF EXISTS product_add_ons');
  },
};
