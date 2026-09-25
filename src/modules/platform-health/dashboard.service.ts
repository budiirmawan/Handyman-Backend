/**
 * CR-BE-SAAS-01 PART 10B — Commercial dashboard service (frozen §21.2).
 *
 * The dashboard is a DETERMINISTIC READ-AGGREGATE over canonical
 * PART 03 / 05 / 06 / 07 / 09 sources. It does NOT introduce a snapshot
 * table, does NOT mutate any source, does NOT emit audit events.
 *
 * Lifecycle re-projection (activeCustomers / trialCustomers) reuses
 * the canonical PART 03 §11.2 rule 4 algorithm (healthy wins) —
 * implemented inline as a pure function to avoid coupling into the
 * private surface of the subscription service.
 *
 * Health counts (healthy / degraded / actionRequired / suspended /
 * incomplete) come from PART 10A `getTenantHealth` — every customer
 * is projected through the same read-model service. Customers whose
 * projection has `complete=false` are NOT counted as healthy, per the
 * PART 10 contract clarification.
 *
 * Per-currency isolation: every monetary bucket is reported per
 * currency. No FX conversion (frozen CR-BE-FX-01 boundary).
 *
 * MRR formula (frozen):
 *   MRR = Σ over ACTIVE subscriptions of base_price normalized to a
 *   monthly figure (ANNUAL: annual/12; MONTHLY: as-is). CUSTOM cycle
 *   is not in §21.2 — excluded from MRR/ARR with no synthesis.
 */
import { getPool } from '../../database';
import { getTenantHealth } from './tenant-health.service';
import { projectCustomerStatusFromStatuses } from '../platform-subscriptions/saas-customer-status.projector';
import {
  SAAS_QUOTA_PRESSURE_RATIO,
  type SaasTenantHealth,
} from './tenant-health.types';
import type {
  SaasCommercialBuildingsEntry,
  SaasCommercialCollectionBucket,
  SaasCommercialCustomerCounts,
  SaasCommercialCurrencyBucket,
  SaasCommercialHealthCounts,
  SaasCommercialOutstandingBucket,
  SaasCommercialSubscriptionCounts,
  SaasCommercialSummary,
} from './dashboard.types';

type CustomerRow = {
  id: string;
  code: string;
  status: string;
};

type SubscriptionListRow = {
  id: string;
  client_id: string;
  status: string;
  billing_cycle: string | null;
  currency_code: string | null;
  pricebook_version_id: string | null;
  package_id: string | null;
  product_id: string | null;
};

type PriceItemRow = {
  base_price: string;
  currency_code: string;
};

type InvoiceBucketRow = {
  currency_code: string;
  total: string;
};

type CollectionRow = {
  age: 'current' | '1to30' | '31to60' | 'over60';
};

type BuildingsRow = {
  customer_id: string;
  customer_code: string;
  buildings: string;
};

// ---------------------------------------------------------------------------
// Frozen §7.2 projection — canonical multi-subscription projector
// (PART 03 saas-customer-status.projector) reused so activeCustomers
// and trialCustomers are derived exactly per §11.2 rule 4.
// ---------------------------------------------------------------------------

type Projection =
  | 'ACTIVE'
  | 'TRIAL'
  | 'GRACE'
  | 'SUSPENDED'
  | 'PROSPECT'
  | 'TERMINATED';

function projectCustomerStatus(statuses: readonly string[]): Projection {
  // Single source of truth — see
  // src/modules/platform-subscriptions/saas-customer-status.projector.
  return projectCustomerStatusFromStatuses(statuses) as Projection;
}

async function listCustomerStatusByClient(
  pool: ReturnType<typeof getPool>,
): Promise<Map<string, Projection>> {
  // One row per (client_id, projection). Multiple subscriptions per
  // client are folded by `projectCustomerStatus` in code below.
  const result = await pool.query<{ client_id: string; status: string }>(
    `SELECT client_id, status FROM subscriptions
      WHERE status IS NOT NULL`,
  );
  const byClient = new Map<string, string[]>();
  for (const row of result.rows) {
    const arr = byClient.get(row.client_id) ?? [];
    arr.push(row.status);
    byClient.set(row.client_id, arr);
  }
  const projectionByClient = new Map<string, Projection>();
  for (const [clientId, statuses] of byClient.entries()) {
    projectionByClient.set(
      clientId,
      projectCustomerStatus(statuses),
    );
  }
  return projectionByClient;
}

// ---------------------------------------------------------------------------
// MRR / ARR (per currency, frozen §21.2)
// ---------------------------------------------------------------------------

async function computeMrrArr(
  pool: ReturnType<typeof getPool>,
): Promise<{
  mrrByCurrency: SaasCommercialCurrencyBucket[];
  arrByCurrency: SaasCommercialCurrencyBucket[];
}> {
  // ACTIVE subscriptions only. MONTHLY → base_price; ANNUAL → base_price/12.
  // CUSTOM cycle → excluded per §21.2 (no formula given).
  const result = await pool.query<
    PriceItemRow & { billing_cycle: string }
  >(
    `SELECT s.billing_cycle, i.base_price, i.currency_code
       FROM subscriptions s
       JOIN saas_price_items i
         ON i.pricebook_version_id = s.pricebook_version_id
        AND i.product_id = s.product_id
        AND (i.package_id = s.package_id
             OR (i.package_id IS NULL AND s.package_id IS NULL))
        AND i.billing_cycle = s.billing_cycle
      WHERE s.status = 'ACTIVE'
        AND s.billing_cycle IN ('MONTHLY', 'ANNUAL')
        AND s.pricebook_version_id IS NOT NULL
        AND s.product_id IS NOT NULL`,
  );
  const mrr = new Map<string, number>();
  const arr = new Map<string, number>();
  for (const row of result.rows) {
    const code = row.currency_code;
    const amount = Number(row.base_price);
    if (!Number.isFinite(amount)) continue;
    if (row.billing_cycle === 'MONTHLY') {
      mrr.set(code, (mrr.get(code) ?? 0) + amount);
      arr.set(code, (arr.get(code) ?? 0) + amount * 12);
    } else if (row.billing_cycle === 'ANNUAL') {
      mrr.set(code, (mrr.get(code) ?? 0) + amount / 12);
      arr.set(code, (arr.get(code) ?? 0) + amount);
    }
  }
  const toBucket = (m: Map<string, number>): SaasCommercialCurrencyBucket[] =>
    Array.from(m.entries())
      .map(([currencyCode, amt]) => ({
        currencyCode,
        amount: amt.toFixed(2),
      }))
      .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
  return {
    mrrByCurrency: toBucket(mrr),
    arrByCurrency: toBucket(arr),
  };
}

// ---------------------------------------------------------------------------
// Subscription counts
// ---------------------------------------------------------------------------

async function computeSubscriptionCounts(
  pool: ReturnType<typeof getPool>,
): Promise<SaasCommercialSubscriptionCounts> {
  const result = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM subscriptions GROUP BY status`,
  );
  const counts: SaasCommercialSubscriptionCounts = {
    active: 0,
    pastDue: 0,
    suspended: 0,
  };
  for (const row of result.rows) {
    const n = Number(row.n);
    if (row.status === 'ACTIVE') counts.active = n;
    else if (row.status === 'PAST_DUE') counts.pastDue = n;
    else if (row.status === 'SUSPENDED') counts.suspended = n;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Customer counts (best subscription = canonical §11.2 rule 4)
// ---------------------------------------------------------------------------

async function computeCustomerCounts(
  pool: ReturnType<typeof getPool>,
): Promise<SaasCommercialCustomerCounts> {
  const projections = await listCustomerStatusByClient(pool);
  let active = 0;
  let trial = 0;
  for (const projection of projections.values()) {
    if (projection === 'ACTIVE') active++;
    else if (projection === 'TRIAL') trial++;
  }
  return { active, trial };
}

// ---------------------------------------------------------------------------
// Outstanding invoices + collection status
// ---------------------------------------------------------------------------

async function computeOutstandingInvoices(
  pool: ReturnType<typeof getPool>,
): Promise<SaasCommercialOutstandingBucket[]> {
  const result = await pool.query<InvoiceBucketRow>(
    `SELECT currency_code, SUM(total_amount)::text AS total
       FROM saas_invoices
      WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
      GROUP BY currency_code
      ORDER BY currency_code ASC`,
  );
  return result.rows.map((r) => ({
    currencyCode: r.currency_code,
    amount: Number(r.total).toFixed(2),
  }));
}

async function computeCollectionStatus(
  pool: ReturnType<typeof getPool>,
  now: Date,
): Promise<SaasCommercialCollectionBucket> {
  // Bucket by invoice age using current_date - due_at. SaaS invoices
  // without a due_at are excluded from this bucketing.
  const result = await pool.query<CollectionRow & { n: string }>(
    `SELECT
        CASE
          WHEN due_at IS NULL THEN 'current'::text
          WHEN (NOW() - due_at) <= INTERVAL '30 days' THEN 'current'::text
          WHEN (NOW() - due_at) <= INTERVAL '60 days' THEN '1to30'::text
          WHEN (NOW() - due_at) <= INTERVAL '90 days' THEN '31to60'::text
          ELSE 'over60'::text
        END AS age,
        COUNT(*)::text AS n
       FROM saas_invoices
      WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
      GROUP BY 1`,
  );
  const bucket: SaasCommercialCollectionBucket = {
    current: 0,
    age1to30: 0,
    age31to60: 0,
    ageOver60: 0,
  };
  // Suppress unused-arg warning for `now` (kept for future use and
  // signature consistency).
  void now;
  for (const row of result.rows) {
    const n = Number(row.n);
    if (row.age === 'current') bucket.current = n;
    else if (row.age === '1to30') bucket.age1to30 = n;
    else if (row.age === '31to60') bucket.age31to60 = n;
    else if (row.age === 'over60') bucket.ageOver60 = n;
  }
  return bucket;
}

// ---------------------------------------------------------------------------
// Buildings under ACTIVE subscription
// ---------------------------------------------------------------------------

async function computeBuildingsUnderSubscription(
  pool: ReturnType<typeof getPool>,
): Promise<SaasCommercialBuildingsEntry[]> {
  // Count buildings per customer where the customer has ≥1 ACTIVE
  // subscription (canonical §11.2 projection = ACTIVE).
  const result = await pool.query<BuildingsRow>(
    `SELECT c.id AS customer_id, c.code AS customer_code,
            COUNT(b.id)::text AS buildings
       FROM clients c
       JOIN subscriptions s ON s.client_id = c.id
       LEFT JOIN properties p ON p.client_id = c.id
       LEFT JOIN buildings b ON b.property_id = p.id
      WHERE s.status = 'ACTIVE'
      GROUP BY c.id, c.code
      ORDER BY c.code ASC`,
  );
  return result.rows.map((r) => ({
    customerId: r.customer_id,
    customerCode: r.customer_code,
    buildings: Number(r.buildings),
  }));
}

// ---------------------------------------------------------------------------
// Usage near limit + health counts (PART 10A read-model)
// ---------------------------------------------------------------------------

async function computeUsageNearingLimitCustomerIds(
  pool: ReturnType<typeof getPool>,
): Promise<readonly string[]> {
  // usageNearingLimit is a frozen §21.2 field — list customers with
  // any limit usage ≥ 90%. We compute it via the PART 09 aggregation
  // view directly (the same projection PART 10A consumes) without
  // re-implementing the projection.
  const result = await pool.query<{ customer_id: string }>(
    `SELECT DISTINCT customer_id
       FROM saas_usage_aggregations agg
      WHERE agg.scope IN ('CURRENT', 'BILLING_PERIOD')
        AND EXISTS (
          SELECT 1
            FROM package_limits pl
            JOIN subscriptions s ON s.package_id = pl.package_id
           WHERE s.client_id = agg.customer_id
             AND pl.limit_key = agg.meter_key
             AND pl.limit_value > 0
             AND agg.total_quantity / pl.limit_value >= $1
        )`,
    [SAAS_QUOTA_PRESSURE_RATIO],
  );
  return result.rows.map((r) => r.customer_id);
}

async function computeHealthCounts(
  customers: readonly CustomerRow[],
  now: Date,
): Promise<SaasCommercialHealthCounts> {
  const counts: SaasCommercialHealthCounts = {
    healthy: 0,
    degraded: 0,
    actionRequired: 0,
    suspended: 0,
    incomplete: 0,
  };
  // Per-customer projection. PART 10A contract clarification: a
  // customer whose overall status is HEALTHY but `complete=false`
  // MUST NOT be counted as healthy — only as incomplete.
  for (const c of customers) {
    const projection: SaasTenantHealth = await getTenantHealth(c.id, now);
    if (!projection.complete) {
      counts.incomplete++;
      continue;
    }
    if (projection.overallStatus === 'HEALTHY') counts.healthy++;
    else if (projection.overallStatus === 'DEGRADED') counts.degraded++;
    else if (projection.overallStatus === 'ACTION_REQUIRED')
      counts.actionRequired++;
    else if (projection.overallStatus === 'SUSPENDED') counts.suspended++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

export async function getCommercialSummary(
  now: Date = new Date(),
): Promise<SaasCommercialSummary> {
  const pool = getPool();
  const [
    customers,
    subscriptionCounts,
    customerCounts,
    mrrArr,
    outstandingInvoices,
    collectionStatus,
    buildingsUnderSubscription,
    usageNearingLimitCustomerIds,
  ] = await Promise.all([
    pool.query<CustomerRow>(
      `SELECT id, code, status FROM clients ORDER BY code ASC`,
    ),
    computeSubscriptionCounts(pool),
    computeCustomerCounts(pool),
    computeMrrArr(pool),
    computeOutstandingInvoices(pool),
    computeCollectionStatus(pool, now),
    computeBuildingsUnderSubscription(pool),
    computeUsageNearingLimitCustomerIds(pool),
  ]);
  const healthCounts = await computeHealthCounts(customers.rows, now);
  return {
    mrrByCurrency: mrrArr.mrrByCurrency,
    arrByCurrency: mrrArr.arrByCurrency,
    activeSubscriptions: subscriptionCounts.active,
    pastDueSubscriptions: subscriptionCounts.pastDue,
    suspendedSubscriptions: subscriptionCounts.suspended,
    activeCustomers: customerCounts.active,
    trialCustomers: customerCounts.trial,
    outstandingInvoices,
    collectionStatus,
    usageNearingLimitCustomerIds,
    healthCounts,
    buildingsUnderSubscription,
    computedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Subscription projection helper (used by future customer routes)
// ---------------------------------------------------------------------------

export async function listSubscriptionProjections(): Promise<
  Map<string, Projection>
> {
  const pool = getPool();
  return listCustomerStatusByClient(pool);
}

export type { SubscriptionListRow };
