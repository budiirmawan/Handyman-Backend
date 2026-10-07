import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — Asset operational state.
 *
 * Adds a SECOND, INDEPENDENT axis to the Asset row: the operational safety
 * state of the physical unit, as distinct from its master-data lifecycle.
 *
 *   assets.status                      BE-05E master lifecycle —
 *                                      ACTIVE | INACTIVE | UNDER_MAINTENANCE |
 *                                      RETIRED (is this asset current in the
 *                                      registry, and may it receive records?)
 *
 *   assets.operational_state           RN-10 operational safety state —
 *                                      IN_SERVICE | OUT_OF_SERVICE | ISOLATED |
 *                                      SHUT_DOWN (is this equipment available
 *                                      for safe use right now?)
 *
 * Both are authoritative and both are retained simultaneously:
 * `status = 'ACTIVE' AND operational_state = 'OUT_OF_SERVICE'` is a valid, and
 * common, combination (a registered, in-life asset that is currently unsafe to
 * use). Neither axis can be derived from the other, and this migration does
 * NOT fold them together.
 *
 * WHY THE ASSET ROW AND NOT A SIDE TABLE
 * --------------------------------------
 * The operational state is a property of the physical Asset. A 1:1 companion
 * table would be a second Asset entity that could disagree with, or outlive,
 * the row it describes, and it would move the compare-and-set token off the
 * authoritative row. The state is therefore additive columns on `assets`.
 *
 * VERSION / COMPARE-AND-SET
 * -------------------------
 * `operational_state_version` starts at 1 and is incremented EXACTLY ONCE per
 * successful transition. The guarded UPDATE matches on the caller's expected
 * version, so two concurrent transitions cannot both win and a stale writer
 * can never silently overwrite newer safety state. This mirrors the BE-05E
 * `updateStatusFrom` guard, made explicit as a version because RN-10 mutation
 * is a management operation flowing through mobile-adjacent clients.
 *
 * EXISTING DATA
 * -------------
 * Every existing Asset defaults to `IN_SERVICE` — the only safe and truthful
 * default, because no historical operational state was ever recorded and
 * inventing one would fabricate safety data. `assets.status` values are
 * untouched, and `equipment_profiles` is not referenced at all.
 *
 * `operational_state_changed_at`, `..._changed_by_user_id`, and
 * `..._reason` are NULL until the first transition: NULL means "has never
 * moved from IN_SERVICE", mirroring BE-05E's nullable `status_changed_at`.
 * The actor FK is ON DELETE SET NULL so deleting a user can never erase the
 * fact that someone took equipment out of service.
 *
 * This migration adds NO equipment-state columns, NO return-to-service
 * structure, NO evidence, NO availableActions, and no mobile authority.
 */

export const migration0348AddAssetOperationalState: Migration = {
  id: '0348_add_asset_operational_state',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE assets
        ADD COLUMN operational_state TEXT NOT NULL DEFAULT 'IN_SERVICE',
        ADD COLUMN operational_state_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN operational_state_changed_at TIMESTAMPTZ,
        ADD COLUMN operational_state_changed_by_user_id UUID,
        ADD COLUMN operational_state_reason TEXT,
        ADD CONSTRAINT assets_operational_state_check
          CHECK (
            operational_state IN
              ('IN_SERVICE', 'OUT_OF_SERVICE', 'ISOLATED', 'SHUT_DOWN')
          ),
        -- The version is a monotonic concurrency token: 1 means "never
        -- transitioned", so a value below 1 is not representable.
        ADD CONSTRAINT assets_operational_state_version_check
          CHECK (operational_state_version >= 1),
        ADD CONSTRAINT assets_operational_state_changed_by_user_id_fkey
          FOREIGN KEY (operational_state_changed_by_user_id)
          REFERENCES users (id) ON DELETE SET NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE assets
        DROP CONSTRAINT IF EXISTS assets_operational_state_changed_by_user_id_fkey,
        DROP CONSTRAINT IF EXISTS assets_operational_state_version_check,
        DROP CONSTRAINT IF EXISTS assets_operational_state_check,
        DROP COLUMN IF EXISTS operational_state_reason,
        DROP COLUMN IF EXISTS operational_state_changed_by_user_id,
        DROP COLUMN IF EXISTS operational_state_changed_at,
        DROP COLUMN IF EXISTS operational_state_version,
        DROP COLUMN IF EXISTS operational_state
    `);
  },
};
