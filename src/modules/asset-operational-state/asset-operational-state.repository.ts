import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  AssetOperationalState,
  AssetOperationalStateRecord,
} from './asset-operational-state.types';

/**
 * The BE-21C transaction convention: a narrow executor the caller may hand in
 * so several statements participate in ONE transaction on ONE connection.
 * Defaulting to the pool keeps every existing (non-transactional) call site
 * byte-for-byte unchanged.
 */
type Executor = Pick<PoolClient, 'query'>;

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — operational-state persistence.
 *
 * The state lives on the AUTHORITATIVE `assets` row (mig 0348), so this
 * repository reads and writes exactly those columns from that table. It does
 * NOT extend the BE-05A repository's SELECT list: the operational axis is a
 * separate concern from the Asset registry, and widening every Asset read in
 * the codebase to carry RN-10 columns would couple BE-05A to RN-10 for no
 * benefit. The targeted read here (precedent: the BE-25F QR resolver reads
 * `assets` directly for its own projection) keeps the blast radius to this
 * module, while the compare-and-set still lands on the one authoritative row.
 *
 * `asset_status` and `building_id` are read alongside because they are needed
 * for correctness, not decoration: `status` gates master-lifecycle terminality
 * and `building_id` is the BE-02G isolation context. Neither is mutated here.
 */

type AssetOperationalStateRow = {
  assetId: string;
  assetStatus: string;
  buildingId: string;
  operationalState: AssetOperationalState;
  operationalStateVersion: number;
  operationalStateChangedAt: Date | null;
  operationalStateChangedByUserId: string | null;
  operationalStateReason: string | null;
};

const OPERATIONAL_STATE_SELECT = `
  id                                        AS "assetId",
  status                                    AS "assetStatus",
  building_id                               AS "buildingId",
  operational_state                         AS "operationalState",
  operational_state_version                 AS "operationalStateVersion",
  operational_state_changed_at              AS "operationalStateChangedAt",
  operational_state_changed_by_user_id      AS "operationalStateChangedByUserId",
  operational_state_reason                  AS "operationalStateReason"
`;

async function findByAssetId(
  assetId: string,
): Promise<AssetOperationalStateRecord | null> {
  return findByAssetIdWith(getPool(), assetId, '');
}

/**
 * PART 03 — the same projection, taken under a ROW LOCK, on the caller's
 * connection.
 *
 * The governed return-to-service command reads the Asset, evaluates the
 * BE-21C clearance gate, writes the new state, and appends the audit row inside
 * ONE transaction. `FOR UPDATE` serializes two concurrent returns of the same
 * Asset and — more importantly — ensures the state, the retirement flag, and
 * the safety-gate result that were *read* are still the ones the guarded
 * UPDATE acts on, so nothing but the compare-and-set version can make the
 * command fail after the gate has been cleared.
 */
async function findByAssetIdForUpdate(
  assetId: string,
  executor: Executor,
): Promise<AssetOperationalStateRecord | null> {
  return findByAssetIdWith(executor, assetId, 'FOR UPDATE');
}

async function findByAssetIdWith(
  executor: Executor,
  assetId: string,
  lockClause: string,
): Promise<AssetOperationalStateRecord | null> {
  const result = await executor.query<AssetOperationalStateRow>(
    `SELECT ${OPERATIONAL_STATE_SELECT} FROM assets WHERE id = $1 ${lockClause}`,
    [assetId],
  );

  return result.rows[0] ?? null;
}

/**
 * Compare-and-set. Applies the transition ONLY when all three guards hold:
 *
 *   1. `operational_state_version = $2`  — the caller read the version it is
 *      mutating, so a stale writer can never overwrite newer safety state;
 *   2. `operational_state <> $3`         — a same-state write is a no-op the
 *      service rejects first, and this guard makes it unrepresentable;
 *   3. `status <> 'RETIRED'`             — master-lifecycle terminality is
 *      enforced in the SAME statement, so a concurrent retirement cannot be
 *      raced past by an in-flight operational transition.
 *
 * Returns NULL when any guard fails; the service re-reads to disambiguate
 * which one it was and raises the matching deterministic error. `version` is
 * incremented exactly once, and the actor/timestamp/reason are written in the
 * same statement as the state, so the audit facts can never disagree with the
 * state they describe.
 *
 * PART 03 REUSES this one writer for the governed return-to-service command
 * (target `IN_SERVICE`) rather than adding a second UPDATE. There is exactly one
 * place in the codebase where the operational state can change — one set of
 * guards, one version increment, one audit statement — which is what makes the
 * CAS token meaningful. `IN_SERVICE` being the target is decided by the CALLER
 * (the governed command, after its clearance gate), never by a request body:
 * the generic PATCH still cannot reach this state because its DTO rejects
 * `IN_SERVICE` before the repository is ever consulted.
 */
async function transitionFrom(
  assetId: string,
  expectedVersion: number,
  state: AssetOperationalState,
  reason: string,
  actorUserId: string | null,
  executor: Executor = getPool(),
): Promise<AssetOperationalStateRecord | null> {
  const result = await executor.query<AssetOperationalStateRow>(
    `UPDATE assets
        SET operational_state = $3,
            operational_state_version = operational_state_version + 1,
            operational_state_changed_at = NOW(),
            operational_state_changed_by_user_id = $4,
            operational_state_reason = $5,
            updated_at = NOW()
      WHERE id = $1
        AND operational_state_version = $2
        AND operational_state <> $3
        AND status <> 'RETIRED'
      RETURNING ${OPERATIONAL_STATE_SELECT}`,
    [assetId, expectedVersion, state, actorUserId, reason],
  );

  return result.rows[0] ?? null;
}

export const assetOperationalStateRepository = {
  findByAssetId,
  findByAssetIdForUpdate,
  transitionFrom,
};
