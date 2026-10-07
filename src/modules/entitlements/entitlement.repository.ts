import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  EntitlementRecord,
  EntitlementSource,
  EntitlementStatus,
  NewEntitlement,
} from './entitlement.types';

type EntitlementRow = {
  id: string;
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  source: EntitlementSource;
  /** pg returns BIGINT as string; coerced in the mapper (pricebook precedent). */
  limitValue: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type Executor = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;

const ENTITLEMENT_SELECT = `
  id,
  subscription_id AS "subscriptionId",
  module_id AS "moduleId",
  status,
  starts_at AS "startsAt",
  ends_at AS "endsAt",
  source,
  limit_value AS "limitValue",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function executor(q?: Executor): Executor {
  return q ?? getPool();
}

function mapEntitlementRow(row: EntitlementRow): EntitlementRecord {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    moduleId: row.moduleId,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    source: row.source,
    limitValue: row.limitValue === null ? null : Number(row.limitValue),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createEntitlement(
  input: NewEntitlement,
  q?: Executor,
): Promise<EntitlementRecord> {
  const result = await executor(q).query<EntitlementRow>(
    `INSERT INTO module_entitlements
       (id, subscription_id, module_id, status, starts_at, ends_at, source, limit_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ENTITLEMENT_SELECT}`,
    [
      randomUUID(),
      input.subscriptionId,
      input.moduleId,
      input.status,
      input.startsAt,
      input.endsAt,
      input.source ?? 'MANUAL',
      input.limitValue ?? null,
    ],
  );

  return mapEntitlementRow(result.rows[0]);
}

async function findById(id: string, q?: Executor): Promise<EntitlementRecord | null> {
  const result = await executor(q).query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

async function findBySubscriptionId(
  subscriptionId: string,
  q?: Executor,
): Promise<EntitlementRecord[]> {
  const result = await executor(q).query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements
     WHERE subscription_id = $1 ORDER BY starts_at DESC`,
    [subscriptionId],
  );

  return result.rows.map(mapEntitlementRow);
}

async function findBySubscriptionAndModule(
  subscriptionId: string,
  moduleId: string,
  q?: Executor,
): Promise<EntitlementRecord | null> {
  const result = await executor(q).query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements
     WHERE subscription_id = $1 AND module_id = $2 AND status = 'ACTIVE'`,
    [subscriptionId, moduleId],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

async function listEntitlements(q?: Executor): Promise<EntitlementRecord[]> {
  const result = await executor(q).query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_SELECT} FROM module_entitlements ORDER BY starts_at DESC`,
  );

  return result.rows.map(mapEntitlementRow);
}

async function updateStatus(
  id: string,
  status: EntitlementStatus,
  q?: Executor,
): Promise<EntitlementRecord | null> {
  const result = await executor(q).query<EntitlementRow>(
    `UPDATE module_entitlements SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ENTITLEMENT_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

// ---------------------------------------------------------------------------
// PART 04 (frozen §12.1) — package materialization & console override
// ---------------------------------------------------------------------------

/**
 * Deterministic stale reconciliation (PART 04): a PACKAGE-derived grant that
 * the current package configuration no longer enables becomes EXPIRED with
 * its period closed. Historical rows are preserved — never deleted.
 */
async function expirePackageRow(
  id: string,
  endsAt: Date,
  q?: Executor,
): Promise<EntitlementRecord | null> {
  const result = await executor(q).query<EntitlementRow>(
    `UPDATE module_entitlements
        SET status = 'EXPIRED', ends_at = $2, updated_at = NOW()
      WHERE id = $1 AND source = 'PACKAGE' AND status = 'ACTIVE'
      RETURNING ${ENTITLEMENT_SELECT}`,
    [id, endsAt],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

/**
 * Console override demotion (PART 04): an ACTIVE grant of ANY source yields
 * the one-active-per-(subscription, module) slot to the new OVERRIDE grant.
 */
async function suspendRow(id: string, q?: Executor): Promise<EntitlementRecord | null> {
  const result = await executor(q).query<EntitlementRow>(
    `UPDATE module_entitlements SET status = 'SUSPENDED', updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${ENTITLEMENT_SELECT}`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

/**
 * PART 13C PART 01C — sum the ACTIVE add-on quota delta for one
 * `(subscription, limitKey)` pair (frozen §12.1 step 2: "add-on
 * quota delta (sum of active SubscriptionAddOn effects matching the
 * capability's package limit key)"). Read-only helper that powers
 * the additive quota extension of `resolveEffectiveLimit`.
 */
async function sumActiveAddOnQuotaDelta(
  subscriptionId: string,
  limitKey: string,
  q?: Executor,
): Promise<number> {
  const result = await executor(q).query<{ sum: string | null }>(
    `SELECT COALESCE(SUM((eff->>'deltaValue')::bigint), 0)::text AS sum
       FROM saas_subscription_add_ons b
       JOIN product_add_ons a ON a.id = b.add_on_id
       CROSS JOIN LATERAL jsonb_array_elements(a.quota_effects) eff
      WHERE b.subscription_id = $1
        AND b.status = 'ACTIVE'
        AND a.status = 'ACTIVE'
        AND (eff->>'limitKey') = $2`,
    [subscriptionId, limitKey],
  );
  return Number(result.rows[0]?.sum ?? '0');
}

/**
 * PART 13C PART 01C — for one capability on one subscription, return
 * the ACTIVE grant's explicit `limit_value` (frozen §12.1 step 1,
 * most-specific precedence) — or null if none is set.
 */
async function findActiveCapabilityLimitValue(
  subscriptionId: string,
  moduleId: string,
  q?: Executor,
): Promise<number | null> {
  const result = await executor(q).query<{ limitValue: string | null }>(
    `SELECT limit_value AS "limitValue"
       FROM module_entitlements
      WHERE subscription_id = $1
        AND module_id = $2
        AND status = 'ACTIVE'
      LIMIT 1`,
    [subscriptionId, moduleId],
  );
  const raw = result.rows[0]?.limitValue;
  if (raw === null || raw === undefined) return null;
  return Number(raw);
}
/**
 * Refresh an existing ACTIVE OVERRIDE grant's explicit limit (idempotent
 * re-override of the same capability keeps a single row).
 */
async function updateRowLimit(
  id: string,
  limitValue: number | null,
  q?: Executor,
): Promise<EntitlementRecord | null> {
  const result = await executor(q).query<EntitlementRow>(
    `UPDATE module_entitlements
        SET limit_value = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${ENTITLEMENT_SELECT}`,
    [id, limitValue],
  );

  const row = result.rows[0];
  return row ? mapEntitlementRow(row) : null;
}

export const entitlementRepository = {
  createEntitlement,
  expirePackageRow,
  findActiveCapabilityLimitValue,
  findBySubscriptionAndModule,
  findBySubscriptionId,
  findById,
  listEntitlements,
  sumActiveAddOnQuotaDelta,
  suspendRow,
  updateRowLimit,
  updateStatus,
};
