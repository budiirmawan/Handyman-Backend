import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 08 — `platform_configurations` (frozen §20).
 *
 * PART 12 owns the canonical platform configuration table, but PART 08
 * (§11.4 sweep + §16 suspension access policy) MUST read policy values
 * from `platform_configurations` per the frozen contract. PART 12 has
 * not landed yet, so PART 08 creates the canonical table here with the
 * full §20 schema (PART 12 will extend it; no later PART may DROP or
 * RENAME the columns added here). The seeded keys cover exactly the
 * PART 08 needs: `saas.past_due_grace_days`,
 * `saas.grace_period_days`, and `saas.suspended_access_policy`.
 *
 * No business data is rewritten by this migration (frozen §25.6).
 */
export const migration0370CreatePlatformConfigurations: Migration = {
  id: '0370_create_platform_configurations',
  async up(client) {
    await client.query(`
      CREATE TABLE platform_configurations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        value JSONB NOT NULL,
        description TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by_user_id UUID REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // §20.2 frozen defaults — PART 08 only seeds the keys it depends on;
    // PART 12 will seed the remainder without conflict (key UNIQUE).
    await client.query(`
      INSERT INTO platform_configurations (key, value, description) VALUES
        ('saas.past_due_grace_days', '7'::jsonb,
         'Days a subscription may stay PAST_DUE before transitioning to GRACE (frozen §20.2).'),
        ('saas.grace_period_days', '14'::jsonb,
         'GRACE period duration in days (frozen §20.2).'),
        ('saas.suspended_access_policy', '"FULL_BLOCK"'::jsonb,
         'Business-plane suspension policy (frozen §20.2 / §12.2.3): READ_ONLY | LIMITED_ACCESS | FULL_BLOCK.'),
        ('saas.suspended_limited_allowlist', '[]'::jsonb,
         'Route patterns allowed under LIMITED_ACCESS suspension policy (frozen §20.2).')
      ON CONFLICT (key) DO NOTHING
    `);
  },
  async down(client) {
    await client.query(`DROP TABLE IF EXISTS platform_configurations`);
  },
};
