import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 02 — SaaS Product & Package catalog (frozen contract
 * §9.1–9.4).
 *
 * New platform-global catalog tables (no existing equivalent — the legacy
 * `modules` table is the canonical capability vocabulary and is REFERENCED,
 * never duplicated):
 *
 *   saas_products    — platform-global product identity (code e.g. ASENTRA).
 *   saas_packages    — edition definitions per product (STARTER / STANDARD /
 *                      PROFESSIONAL / ENTERPRISE seeded). A package is data
 *                      ("what would this package grant?"), never an
 *                      authorization role and never a hardcoded consumer.
 *   package_features — declarative grant list: package → capability_code,
 *                      referenced against the EXISTING `modules` catalogue
 *                      (FK on code) — no second feature catalog.
 *   package_limits   — package limit definitions; canonical limit_key
 *                      vocabulary frozen by contract §9.4.
 *
 * No runtime entitlement materialization, no usage counting, and no change
 * to `module_entitlements`, `subscriptions`, or `licenses` — those remain
 * business-plane constructs for later PARTs.
 *
 * Seeding: the ASENTRA product and the four frozen edition codes are seeded
 * here (contract §9.2), following the in-migration reference-data precedent
 * of 0331 (currencies). Feature/limit composition is NOT seeded — it is
 * platform-administered data entered through the PART 02 API.
 */

/** Deterministic ids so the seeded catalog is stable across environments. */
const ASENTRA_PRODUCT_ID = 'a1e7c000-0000-4000-8000-000000000001';
const STARTER_PACKAGE_ID = 'a1e7c000-0000-4000-8000-000000000002';
const STANDARD_PACKAGE_ID = 'a1e7c000-0000-4000-8000-000000000003';
const PROFESSIONAL_PACKAGE_ID = 'a1e7c000-0000-4000-8000-000000000004';
const ENTERPRISE_PACKAGE_ID = 'a1e7c000-0000-4000-8000-000000000005';

/**
 * Canonical limit_key vocabulary (frozen; extensible only by CR amendment).
 */
const FROZEN_LIMIT_KEYS = [
  'building.count',
  'user.count',
  'active.asset.count',
  'monthly.wo.count',
  'storage.bytes',
  'api.requests',
  'integration.count',
  'ai.usage',
] as const;

export const migration0362CreateSaasProductCatalog: Migration = {
  id: '0362_create_saas_product_catalog',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE saas_products (
        id UUID PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_products_code_unique UNIQUE (code),
        CONSTRAINT saas_products_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE TABLE saas_packages (
        id UUID PRIMARY KEY,
        product_id UUID NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_packages_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES saas_products (id),
        CONSTRAINT saas_packages_product_code_unique UNIQUE (product_id, code),
        CONSTRAINT saas_packages_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(`
      CREATE INDEX saas_packages_product_idx ON saas_packages (product_id, created_at DESC)
    `);

    // capability_code MUST exist in the existing canonical `modules`
    // catalogue (0015) — enforced at the database level, not by convention.
    await client.query(`
      CREATE TABLE package_features (
        id UUID PRIMARY KEY,
        package_id UUID NOT NULL,
        capability_code TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT package_features_package_id_fkey
          FOREIGN KEY (package_id) REFERENCES saas_packages (id),
        CONSTRAINT package_features_capability_code_fkey
          FOREIGN KEY (capability_code) REFERENCES modules (code),
        CONSTRAINT package_features_package_capability_unique
          UNIQUE (package_id, capability_code)
      )
    `);

    await client.query(`
      CREATE TABLE package_limits (
        id UUID PRIMARY KEY,
        package_id UUID NOT NULL,
        limit_key TEXT NOT NULL,
        limit_value BIGINT NOT NULL,
        unit TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT package_limits_package_id_fkey
          FOREIGN KEY (package_id) REFERENCES saas_packages (id),
        CONSTRAINT package_limits_package_key_unique UNIQUE (package_id, limit_key),
        CONSTRAINT package_limits_value_check CHECK (limit_value >= 0),
        CONSTRAINT package_limits_key_check CHECK (limit_key IN (${FROZEN_LIMIT_KEYS.map(
          (key) => `'${key}'`,
        ).join(', ')}))
      )
    `);

    // Seeded catalog (contract §9.1/§9.2): ASENTRA product + the four
    // frozen edition codes. ON CONFLICT keeps re-runs idempotent.
    await client.query(
      `INSERT INTO saas_products (id, code, name, description, status)
       VALUES ($1, 'ASENTRA', 'Asentra', 'Asentra facility-management SaaS platform.', 'ACTIVE')
       ON CONFLICT (code) DO NOTHING`,
      [ASENTRA_PRODUCT_ID],
    );
    const editions: Array<[string, string, string]> = [
      [STARTER_PACKAGE_ID, 'STARTER', 'Starter'],
      [STANDARD_PACKAGE_ID, 'STANDARD', 'Standard'],
      [PROFESSIONAL_PACKAGE_ID, 'PROFESSIONAL', 'Professional'],
      [ENTERPRISE_PACKAGE_ID, 'ENTERPRISE', 'Enterprise'],
    ];
    for (const [id, code, name] of editions) {
      await client.query(
        `INSERT INTO saas_packages (id, product_id, code, name, description, status)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
         ON CONFLICT (product_id, code) DO NOTHING`,
        [id, ASENTRA_PRODUCT_ID, code, `${name} edition`, `ASENTRA ${name} edition package.`],
      );
    }
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS package_limits');
    await client.query('DROP TABLE IF EXISTS package_features');
    await client.query('DROP TABLE IF EXISTS saas_packages');
    await client.query('DROP TABLE IF EXISTS saas_products');
  },
};
