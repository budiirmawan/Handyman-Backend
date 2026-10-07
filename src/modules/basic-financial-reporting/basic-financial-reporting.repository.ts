import { getPool } from '../../database';
import type { FinancialReportFilters } from './basic-financial-reporting.types';

type Scope = { buildingId: string; filters: FinancialReportFilters };

const params = (s: Scope) =>
  [s.buildingId, s.filters.periodFrom ?? null, s.filters.periodTo ?? null, s.filters.tenantCompanyId ?? null] as const;

const n = (v: unknown) => Number(v ?? 0);

// Helper to build Record<string, {count, amount}> from rows grouped by currency
function buildGrouped(rows: Array<{ currencyCode: string | null; count?: number; amount?: string; active_count?: number; active_amount?: string; cancelled_count?: number; total_count?: number }>, countField: string, amountField: string) {
  const byCurrency: Record<string, { count: number; amount: number }> = {};
  let unknownCount = 0;
  let unknownAmount = 0;
  let totalCount = 0;

  for (const r of rows) {
    const code = (r as any).currencyCode ?? (r as any).currency ?? null;
    const cnt = Number((r as any)[countField] ?? (r as any).count ?? 0);
    const amt = Number((r as any)[amountField] ?? (r as any).amount ?? 0);
    totalCount += cnt;
    if (code === null || code === undefined) {
      unknownCount += cnt;
      unknownAmount += amt;
    } else {
      const existing = byCurrency[code] ?? { count: 0, amount: 0 };
      existing.count += cnt;
      existing.amount += amt;
      byCurrency[code] = existing;
    }
  }

  return { byCurrency, unknown: { count: unknownCount, amount: unknownAmount }, totalCount };
}

// ---------------------------------------------------------------------------
// PART 01 — currency-safe source aggregation
// ---------------------------------------------------------------------------

async function tenantChargesGrouped(s: Scope) {
  const v = params(s);
  // Group by exact currency_code, including NULL as unknown
  const rows = (
    await getPool().query(
      `SELECT
         currency_code AS "currencyCode",
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS count,
         COALESCE(SUM(amount) FILTER (WHERE status = 'ACTIVE'), 0)::text AS amount,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
       FROM tenant_charges
       WHERE building_id = $1
         AND ($2::date IS NULL OR charge_date >= $2)
         AND ($3::date IS NULL OR charge_date <= $3)
         AND ($4::uuid IS NULL OR tenant_company_id = $4)
       GROUP BY currency_code`,
      v,
    )
  ).rows as Array<{ currencyCode: string | null; count: number; amount: string; cancelled: number }>;

  const byCurrency: Record<string, { count: number; amount: number }> = {};
  let unknownCount = 0;
  let unknownAmount = 0;
  let totalActiveCount = 0;
  let cancelledCount = 0;

  for (const r of rows) {
    const cnt = n(r.count);
    const amt = n(r.amount);
    const canc = n(r.cancelled);
    cancelledCount += canc;
    totalActiveCount += cnt;
    if (r.currencyCode === null) {
      unknownCount += cnt;
      unknownAmount += amt;
    } else {
      const ex = byCurrency[r.currencyCode] ?? { count: 0, amount: 0 };
      ex.count += cnt;
      ex.amount += amt;
      byCurrency[r.currencyCode] = ex;
    }
  }

  return {
    totalActiveCount,
    cancelledCount,
    byCurrency,
    unknown: { count: unknownCount, amount: unknownAmount },
  };
}

async function utilityBillsGrouped(s: Scope) {
  const v = params(s);
  const rows = (
    await getPool().query(
      `SELECT
         currency AS "currencyCode",
         COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS count,
         COALESCE(SUM(bill_amount) FILTER (WHERE status <> 'CANCELLED'), 0)::text AS amount,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
       FROM utility_bills
       WHERE building_id = $1
         AND ($2::date IS NULL OR period_end::date >= $2)
         AND ($3::date IS NULL OR period_end::date <= $3)
         AND ($4::uuid IS NULL OR tenant_company_id = $4)
       GROUP BY currency`,
      v,
    )
  ).rows as Array<{ currencyCode: string | null; count: number; amount: string; cancelled: number }>;

  const byCurrency: Record<string, { count: number; amount: number }> = {};
  let unknownCount = 0;
  let unknownAmount = 0;
  let totalNonCancelledCount = 0;
  let cancelledCount = 0;

  for (const r of rows) {
    const cnt = n(r.count);
    const amt = n(r.amount);
    const canc = n(r.cancelled);
    cancelledCount += canc;
    totalNonCancelledCount += cnt;
    if (r.currencyCode === null) {
      unknownCount += cnt;
      unknownAmount += amt;
    } else {
      const ex = byCurrency[r.currencyCode] ?? { count: 0, amount: 0 };
      ex.count += cnt;
      ex.amount += amt;
      byCurrency[r.currencyCode] = ex;
    }
  }

  return {
    totalNonCancelledCount,
    cancelledCount,
    byCurrency,
    unknown: { count: unknownCount, amount: unknownAmount },
  };
}

async function byTenantGrouped(s: Scope) {
  const v = params(s);
  // tenant charges per tenant per currency
  const chRows = (
    await getPool().query(
      `SELECT tenant_company_id AS "tenantCompanyId", currency_code AS "currencyCode",
              COALESCE(SUM(amount),0)::text AS amount
       FROM tenant_charges
       WHERE building_id = $1 AND status = 'ACTIVE'
         AND ($2::date IS NULL OR charge_date >= $2)
         AND ($3::date IS NULL OR charge_date <= $3)
       GROUP BY tenant_company_id, currency_code`,
      v.slice(0, 3),
    )
  ).rows as Array<{ tenantCompanyId: string; currencyCode: string | null; amount: string }>;

  const ubRows = (
    await getPool().query(
      `SELECT tenant_company_id AS "tenantCompanyId", currency AS "currencyCode",
              COALESCE(SUM(bill_amount),0)::text AS amount
       FROM utility_bills
       WHERE building_id = $1 AND status <> 'CANCELLED'
         AND ($2::date IS NULL OR period_end::date >= $2)
         AND ($3::date IS NULL OR period_end::date <= $3)
       GROUP BY tenant_company_id, currency`,
      v.slice(0, 3),
    )
  ).rows as Array<{ tenantCompanyId: string; currencyCode: string | null; amount: string }>;

  const ivRows = (
    await getPool().query(
      `SELECT i.tenant_company_id AS "tenantCompanyId", i.currency_code AS "currencyCode",
              COALESCE(SUM(i.total_amount),0)::text AS amount,
              COALESCE(SUM(LEAST(COALESCE(ps.paid_amount,0), i.total_amount)),0)::text AS paid,
              COALESCE(SUM(GREATEST(i.total_amount - COALESCE(ps.paid_amount,0),0)),0)::text AS outstanding
       FROM tenant_invoices i
       LEFT JOIN invoice_payment_status ps ON ps.invoice_id = i.id
       WHERE i.building_id = $1 AND i.status = 'FINALIZED'
         AND ($2::date IS NULL OR i.invoice_date >= $2)
         AND ($3::date IS NULL OR i.invoice_date <= $3)
       GROUP BY i.tenant_company_id, i.currency_code`,
      v.slice(0, 3),
    )
  ).rows as Array<{
    tenantCompanyId: string;
    currencyCode: string | null;
    amount: string;
    paid: string;
    outstanding: string;
  }>;

  // Collect distinct tenant ids
  const tenantIds = new Set<string>();
  for (const r of [...chRows, ...ubRows, ...ivRows]) tenantIds.add(r.tenantCompanyId);

  const map = new Map<
    string,
    {
      byCurrency: Record<string, { tenantChargeAmount: number; utilityBillAmount: number; invoiceAmount: number; paidAmount: number; outstandingAmount: number }>;
      unknown: { tenantChargeAmount: number; utilityBillAmount: number; invoiceAmount: number; paidAmount: number; outstandingAmount: number };
    }
  >();

  for (const tid of tenantIds) {
    map.set(tid, {
      byCurrency: {},
      unknown: { tenantChargeAmount: 0, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 },
    });
  }

  for (const r of chRows) {
    const entry = map.get(r.tenantCompanyId)!;
    const amt = n(r.amount);
    if (r.currencyCode === null) {
      entry.unknown.tenantChargeAmount += amt;
    } else {
      const cur = entry.byCurrency[r.currencyCode] ?? { tenantChargeAmount: 0, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 };
      cur.tenantChargeAmount += amt;
      entry.byCurrency[r.currencyCode] = cur;
    }
  }

  for (const r of ubRows) {
    const entry = map.get(r.tenantCompanyId)!;
    const amt = n(r.amount);
    if (r.currencyCode === null) {
      entry.unknown.utilityBillAmount += amt;
    } else {
      const cur = entry.byCurrency[r.currencyCode] ?? { tenantChargeAmount: 0, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 };
      cur.utilityBillAmount += amt;
      entry.byCurrency[r.currencyCode] = cur;
    }
  }

  for (const r of ivRows) {
    const entry = map.get(r.tenantCompanyId)!;
    const amt = n(r.amount);
    const paid = n(r.paid);
    const out = n(r.outstanding);
    if (r.currencyCode === null) {
      entry.unknown.invoiceAmount += amt;
      entry.unknown.paidAmount += paid;
      entry.unknown.outstandingAmount += out;
    } else {
      const cur = entry.byCurrency[r.currencyCode] ?? { tenantChargeAmount: 0, utilityBillAmount: 0, invoiceAmount: 0, paidAmount: 0, outstandingAmount: 0 };
      cur.invoiceAmount += amt;
      cur.paidAmount += paid;
      cur.outstandingAmount += out;
      entry.byCurrency[r.currencyCode] = cur;
    }
  }

  // Apply tenantCompanyId filter if present
  const filterId = s.filters.tenantCompanyId ?? null;
  const result = Array.from(map.entries())
    .filter(([tid]) => (filterId ? tid === filterId : true))
    .map(([tenantCompanyId, data]) => ({
      tenantCompanyId,
      byCurrency: data.byCurrency,
      unknown: data.unknown,
    }))
    // Only keep tenants with any non-zero amount
    .filter((e) => {
      const hasKnown = Object.values(e.byCurrency).some((v) => v.tenantChargeAmount !== 0 || v.utilityBillAmount !== 0 || v.invoiceAmount !== 0);
      const hasUnknown = e.unknown.tenantChargeAmount !== 0 || e.unknown.utilityBillAmount !== 0 || e.unknown.invoiceAmount !== 0;
      return hasKnown || hasUnknown;
    })
    .sort((a, b) => a.tenantCompanyId.localeCompare(b.tenantCompanyId));

  return result;
}

async function invoicesGrouped(s: Scope) {
  const v = params(s);
  const rows = (
    await getPool().query(
      `SELECT
         currency_code AS "currencyCode",
         COUNT(*) FILTER (WHERE status = 'FINALIZED')::int AS finalized_count,
         COALESCE(SUM(total_amount) FILTER (WHERE status = 'FINALIZED'),0)::text AS finalized_amount,
         COUNT(*) FILTER (WHERE status = 'DRAFT')::int AS draft_count,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_count
       FROM tenant_invoices
       WHERE building_id = $1
         AND ($2::date IS NULL OR invoice_date >= $2)
         AND ($3::date IS NULL OR invoice_date <= $3)
         AND ($4::uuid IS NULL OR tenant_company_id = $4)
       GROUP BY currency_code`,
      v,
    )
  ).rows as Array<{ currencyCode: string | null; finalized_count: number; finalized_amount: string; draft_count: number; cancelled_count: number }>;

  const byCurrency: Record<string, { count: number; amount: number }> = {};
  let unknownCount = 0;
  let unknownAmount = 0;
  let finalizedCount = 0;
  let draftCount = 0;
  let cancelledCount = 0;

  for (const r of rows) {
    const fCount = n(r.finalized_count);
    const fAmt = n(r.finalized_amount);
    finalizedCount += fCount;
    draftCount += n(r.draft_count);
    cancelledCount += n(r.cancelled_count);
    if (r.currencyCode === null) {
      unknownCount += fCount;
      unknownAmount += fAmt;
    } else {
      const ex = byCurrency[r.currencyCode] ?? { count: 0, amount: 0 };
      ex.count += fCount;
      ex.amount += fAmt;
      byCurrency[r.currencyCode] = ex;
    }
  }

  return {
    finalizedCount,
    draftCount,
    cancelledCount,
    byCurrency,
    unknown: { count: unknownCount, amount: unknownAmount },
  };
}

async function paymentsGrouped(s: Scope) {
  const v = params(s);
  const rows = (
    await getPool().query(
      `WITH scoped AS (
         SELECT i.currency_code AS "currencyCode", i.total_amount::text AS total_amount, i.due_date, i.status, COALESCE(ps.paid_amount,0)::text AS paid
         FROM tenant_invoices i
         LEFT JOIN invoice_payment_status ps ON ps.invoice_id = i.id
         WHERE i.building_id = $1
           AND ($2::date IS NULL OR i.invoice_date >= $2)
           AND ($3::date IS NULL OR i.invoice_date <= $3)
           AND ($4::uuid IS NULL OR i.tenant_company_id = $4)
       ),
       finals AS (
         SELECT *, GREATEST(total_amount::numeric - paid::numeric, 0)::text AS outstanding
         FROM scoped WHERE status = 'FINALIZED'
       )
       SELECT
         "currencyCode",
         COALESCE(SUM(LEAST(paid::numeric, total_amount::numeric)),0)::text AS paid_amount,
         COALESCE(SUM(outstanding::numeric) FILTER (WHERE outstanding::numeric > 0 AND due_date >= CURRENT_DATE),0)::text AS unpaid_amount,
         COALESCE(SUM(outstanding::numeric) FILTER (WHERE outstanding::numeric > 0 AND due_date < CURRENT_DATE),0)::text AS overdue_amount,
         COALESCE(SUM(outstanding::numeric),0)::text AS outstanding_amount,
         COUNT(*) FILTER (WHERE paid::numeric = 0 AND outstanding::numeric > 0 AND due_date >= CURRENT_DATE)::int AS unpaid_count,
         COUNT(*) FILTER (WHERE paid::numeric > 0 AND outstanding::numeric > 0 AND due_date >= CURRENT_DATE)::int AS partial_count,
         COUNT(*) FILTER (WHERE outstanding::numeric = 0)::int AS paid_count,
         COUNT(*) FILTER (WHERE outstanding::numeric > 0 AND due_date < CURRENT_DATE)::int AS overdue_count
       FROM finals
       GROUP BY "currencyCode"`,
      v,
    )
  ).rows as Array<{
    currencyCode: string | null;
    paid_amount: string;
    unpaid_amount: string;
    overdue_amount: string;
    outstanding_amount: string;
    unpaid_count: number;
    partial_count: number;
    paid_count: number;
    overdue_count: number;
  }>;

  const byCurrency: Record<string, { paidAmount: number; unpaidAmount: number; overdueAmount: number; outstandingAmount: number; unpaidCount: number; partiallyPaidCount: number; paidCount: number; overdueCount: number }> = {};
  const unknown = { paidAmount: 0, unpaidAmount: 0, overdueAmount: 0, outstandingAmount: 0, unpaidCount: 0, partiallyPaidCount: 0, paidCount: 0, overdueCount: 0 };
  let totalUnpaid = 0;
  let totalPartial = 0;
  let totalPaid = 0;
  let totalOverdue = 0;

  for (const r of rows) {
    const bucket = {
      paidAmount: n(r.paid_amount),
      unpaidAmount: n(r.unpaid_amount),
      overdueAmount: n(r.overdue_amount),
      outstandingAmount: n(r.outstanding_amount),
      unpaidCount: n(r.unpaid_count),
      partiallyPaidCount: n(r.partial_count),
      paidCount: n(r.paid_count),
      overdueCount: n(r.overdue_count),
    };
    totalUnpaid += bucket.unpaidCount;
    totalPartial += bucket.partiallyPaidCount;
    totalPaid += bucket.paidCount;
    totalOverdue += bucket.overdueCount;

    if (r.currencyCode === null) {
      unknown.paidAmount += bucket.paidAmount;
      unknown.unpaidAmount += bucket.unpaidAmount;
      unknown.overdueAmount += bucket.overdueAmount;
      unknown.outstandingAmount += bucket.outstandingAmount;
      unknown.unpaidCount += bucket.unpaidCount;
      unknown.partiallyPaidCount += bucket.partiallyPaidCount;
      unknown.paidCount += bucket.paidCount;
      unknown.overdueCount += bucket.overdueCount;
    } else {
      byCurrency[r.currencyCode] = bucket;
    }
  }

  return {
    byCurrency,
    unknown,
    totalCounts: {
      unpaidCount: totalUnpaid,
      partiallyPaidCount: totalPartial,
      paidCount: totalPaid,
      overdueCount: totalOverdue,
    },
  };
}

async function receiptsGrouped(s: Scope) {
  const v = params(s);
  const rows = (
    await getPool().query(
      `SELECT
         i.currency_code AS "currencyCode",
         COUNT(*) FILTER (WHERE pr.status = 'ISSUED')::int AS issued_count,
         COALESCE(SUM(pr.received_amount) FILTER (WHERE pr.status = 'ISSUED'),0)::text AS issued_amount,
         COUNT(*) FILTER (WHERE pr.status = 'VOID')::int AS void_count,
         COALESCE(SUM(pr.received_amount) FILTER (WHERE pr.status = 'VOID'),0)::text AS void_amount
       FROM payment_receipts pr
       JOIN tenant_invoices i ON i.id = pr.invoice_id
       WHERE pr.building_id = $1
         AND ($2::date IS NULL OR pr.received_at >= $2::date)
         AND ($3::date IS NULL OR pr.received_at < $3::date + INTERVAL '1 day')
         AND ($4::uuid IS NULL OR pr.tenant_company_id = $4)
       GROUP BY i.currency_code`,
      v,
    )
  ).rows as Array<{ currencyCode: string | null; issued_count: number; issued_amount: string; void_count: number; void_amount: string }>;

  const issuedByCurrency: Record<string, { count: number; amount: number }> = {};
  const voidByCurrency: Record<string, { count: number; amount: number }> = {};
  let issuedUnknown = { count: 0, amount: 0 };
  let voidUnknown = { count: 0, amount: 0 };
  let issuedTotalCount = 0;
  let voidTotalCount = 0;

  for (const r of rows) {
    const iCount = n(r.issued_count);
    const iAmt = n(r.issued_amount);
    const vCount = n(r.void_count);
    const vAmt = n(r.void_amount);
    issuedTotalCount += iCount;
    voidTotalCount += vCount;
    if (r.currencyCode === null) {
      issuedUnknown.count += iCount;
      issuedUnknown.amount += iAmt;
      voidUnknown.count += vCount;
      voidUnknown.amount += vAmt;
    } else {
      issuedByCurrency[r.currencyCode] = { count: (issuedByCurrency[r.currencyCode]?.count ?? 0) + iCount, amount: (issuedByCurrency[r.currencyCode]?.amount ?? 0) + iAmt };
      voidByCurrency[r.currencyCode] = { count: (voidByCurrency[r.currencyCode]?.count ?? 0) + vCount, amount: (voidByCurrency[r.currencyCode]?.amount ?? 0) + vAmt };
    }
  }

  return {
    issued: { totalCount: issuedTotalCount, byCurrency: issuedByCurrency, unknown: issuedUnknown },
    void: { totalCount: voidTotalCount, byCurrency: voidByCurrency, unknown: voidUnknown },
  };
}

async function vendorCostsGrouped(s: Scope) {
  const v = params(s).slice(0, 3);
  const rows = (
    await getPool().query(
      `SELECT
         currency_code AS "currencyCode",
         COUNT(*) FILTER (WHERE status = 'FINALIZED')::int AS finalized_count,
         COALESCE(SUM(cost_amount) FILTER (WHERE status = 'FINALIZED'),0)::text AS finalized_amount,
         COUNT(*) FILTER (WHERE status = 'DRAFT')::int AS draft_count,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_count
       FROM vendor_service_costs
       WHERE building_id = $1
         AND ($2::date IS NULL OR cost_date >= $2)
         AND ($3::date IS NULL OR cost_date <= $3)
       GROUP BY currency_code`,
      v,
    )
  ).rows as Array<{ currencyCode: string | null; finalized_count: number; finalized_amount: string; draft_count: number; cancelled_count: number }>;

  const byCurrency: Record<string, { count: number; amount: number }> = {};
  let unknownCount = 0;
  let unknownAmount = 0;
  let finalizedCount = 0;
  let draftCount = 0;
  let cancelledCount = 0;

  for (const r of rows) {
    const fCount = n(r.finalized_count);
    const fAmt = n(r.finalized_amount);
    finalizedCount += fCount;
    draftCount += n(r.draft_count);
    cancelledCount += n(r.cancelled_count);
    if (r.currencyCode === null) {
      unknownCount += fCount;
      unknownAmount += fAmt;
    } else {
      const ex = byCurrency[r.currencyCode] ?? { count: 0, amount: 0 };
      ex.count += fCount;
      ex.amount += fAmt;
      byCurrency[r.currencyCode] = ex;
    }
  }

  return {
    finalizedCount,
    draftCount,
    cancelledCount,
    byCurrency,
    unknown: { count: unknownCount, amount: unknownAmount },
  };
}

async function basicExpensesGrouped(s: Scope) {
  const v = params(s).slice(0, 3);
  const rows = (
    await getPool().query(
      `SELECT
         currency_code AS "currencyCode",
         COUNT(*) FILTER (WHERE status = 'FINALIZED')::int AS finalized_count,
         COALESCE(SUM(amount) FILTER (WHERE status = 'FINALIZED'),0)::text AS finalized_amount,
         COUNT(*) FILTER (WHERE status = 'DRAFT')::int AS draft_count,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_count
       FROM basic_expenses
       WHERE building_id = $1
         AND ($2::date IS NULL OR expense_date >= $2)
         AND ($3::date IS NULL OR expense_date <= $3)
       GROUP BY currency_code`,
      v,
    )
  ).rows as Array<{ currencyCode: string | null; finalized_count: number; finalized_amount: string; draft_count: number; cancelled_count: number }>;

  const byCurrency: Record<string, { count: number; amount: number }> = {};
  let unknownCount = 0;
  let unknownAmount = 0;
  let finalizedCount = 0;
  let draftCount = 0;
  let cancelledCount = 0;

  for (const r of rows) {
    const fCount = n(r.finalized_count);
    const fAmt = n(r.finalized_amount);
    finalizedCount += fCount;
    draftCount += n(r.draft_count);
    cancelledCount += n(r.cancelled_count);
    if (r.currencyCode === null) {
      unknownCount += fCount;
      unknownAmount += fAmt;
    } else {
      const ex = byCurrency[r.currencyCode] ?? { count: 0, amount: 0 };
      ex.count += fCount;
      ex.amount += fAmt;
      byCurrency[r.currencyCode] = ex;
    }
  }

  return {
    finalizedCount,
    draftCount,
    cancelledCount,
    byCurrency,
    unknown: { count: unknownCount, amount: unknownAmount },
  };
}

async function unrepresentedVendorCostGrouped(s: Scope) {
  const v = params(s).slice(0, 3);
  const rows = (
    await getPool().query(
      `SELECT
         c.currency_code AS "currencyCode",
         COALESCE(SUM(c.cost_amount),0)::text AS amount
       FROM vendor_service_costs c
       WHERE c.building_id = $1
         AND c.status = 'FINALIZED'
         AND ($2::date IS NULL OR c.cost_date >= $2)
         AND ($3::date IS NULL OR c.cost_date <= $3)
         AND NOT EXISTS (
           SELECT 1 FROM basic_expenses e
           WHERE e.vendor_service_cost_id = c.id AND e.status = 'FINALIZED'
         )
       GROUP BY c.currency_code`,
      v,
    )
  ).rows as Array<{ currencyCode: string | null; amount: string }>;

  const byCurrency: Record<string, { amount: number }> = {};
  let unknownAmount = 0;

  for (const r of rows) {
    const amt = n(r.amount);
    if (r.currencyCode === null) {
      unknownAmount += amt;
    } else {
      byCurrency[r.currencyCode] = { amount: (byCurrency[r.currencyCode]?.amount ?? 0) + amt };
    }
  }

  return {
    byCurrency,
    unknown: { amount: unknownAmount },
  };
}

// Legacy helpers for backward compat — now derived from grouped data
function singleCurrencyAmount(byCurrency: Record<string, { amount: number }>, unknown: { amount: number; count: number }): number | null {
  const knownCodes = Object.keys(byCurrency);
  const hasUnknown = unknown.count > 0 || unknown.amount !== 0;
  if (hasUnknown) return null;
  if (knownCodes.length === 1) {
    return byCurrency[knownCodes[0]].amount;
  }
  if (knownCodes.length === 0) return 0;
  return null;
}

function singleCurrencyCountAmount(byCurrency: Record<string, { count: number; amount: number }>, unknown: { count: number; amount: number }): { count: number; amount: number | null; byCurrency: Record<string, { count: number; amount: number }>; unknown: { count: number; amount: number } } {
  // For legacy we need total count across all currencies
  let totalCount = unknown.count;
  for (const v of Object.values(byCurrency)) totalCount += v.count;
  const amt = singleCurrencyAmount(byCurrency as any, unknown as any);
  return { totalCount, amount: amt, byCurrency, unknown } as any;
}

export const basicFinancialReportingRepository = {
  // PART 01 new currency-safe foundations
  tenantChargesGrouped,
  utilityBillsGrouped,
  byTenantGrouped,
  invoicesGrouped,
  paymentsGrouped,
  receiptsGrouped,
  vendorCostsGrouped,
  basicExpensesGrouped,
  unrepresentedVendorCostGrouped,

  // Legacy — kept for reference but now delegates to grouped versions to avoid unsafe SUM
  // These wrappers preserve old shape but are now safe (nullable when multi-currency)
  async tenantBilling(s: Scope) {
    const [tc, ub, byTenant] = await Promise.all([tenantChargesGrouped(s), utilityBillsGrouped(s), byTenantGrouped(s)]);
    // Legacy byTenant expects flat amounts per tenant (single currency convenience)
    const legacyByTenant = byTenant.map((t) => {
      const codes = Object.keys(t.byCurrency);
      const hasUnknown = t.unknown.tenantChargeAmount !== 0 || t.unknown.utilityBillAmount !== 0 || t.unknown.invoiceAmount !== 0;
      if (codes.length === 1 && !hasUnknown) {
        const cur = t.byCurrency[codes[0]];
        return {
          tenantCompanyId: t.tenantCompanyId,
          tenantChargeAmount: cur.tenantChargeAmount,
          utilityBillAmount: cur.utilityBillAmount,
          invoiceAmount: cur.invoiceAmount,
          paidAmount: cur.paidAmount,
          outstandingAmount: cur.outstandingAmount,
        };
      }
      // Multi-currency or unknown → legacy scalar must be null to avoid mixed SUM
      return {
        tenantCompanyId: t.tenantCompanyId,
        tenantChargeAmount: null as any,
        utilityBillAmount: null as any,
        invoiceAmount: null as any,
        paidAmount: null as any,
        outstandingAmount: null as any,
      };
    });

    return {
      tenantCharges: {
        count: tc.totalActiveCount,
        amount: singleCurrencyAmount(tc.byCurrency, tc.unknown),
        cancelledCount: tc.cancelledCount,
        byCurrency: tc.byCurrency,
        unknown: tc.unknown,
      },
      utilityBills: {
        count: ub.totalNonCancelledCount,
        amount: singleCurrencyAmount(ub.byCurrency, ub.unknown),
        cancelledCount: ub.cancelledCount,
        byCurrency: ub.byCurrency,
        unknown: ub.unknown,
      },
      byTenant: legacyByTenant,
      // New safe fields for PART 02 consumption
      _grouped: { tenantCharges: tc, utilityBills: ub, byTenant },
    };
  },

  async invoicePayment(s: Scope) {
    const [inv, pay] = await Promise.all([invoicesGrouped(s), paymentsGrouped(s)]);
    return {
      invoices: {
        count: inv.finalizedCount,
        amount: singleCurrencyAmount(inv.byCurrency, inv.unknown),
        draftCount: inv.draftCount,
        cancelledCount: inv.cancelledCount,
        byCurrency: inv.byCurrency,
        unknown: inv.unknown,
      },
      payments: {
        paidAmount: (() => {
          const knownCodes = Object.keys(pay.byCurrency);
          if (pay.unknown.paidAmount !== 0 || pay.unknown.count !== 0) return null;
          if (knownCodes.length === 1) return pay.byCurrency[knownCodes[0]].paidAmount;
          if (knownCodes.length === 0) return 0;
          return null;
        })(),
        unpaidAmount: (() => {
          const knownCodes = Object.keys(pay.byCurrency);
          if (pay.unknown.unpaidAmount !== 0) return null;
          if (knownCodes.length === 1) return pay.byCurrency[knownCodes[0]].unpaidAmount;
          if (knownCodes.length === 0) return 0;
          return null;
        })(),
        overdueAmount: (() => {
          const knownCodes = Object.keys(pay.byCurrency);
          if (pay.unknown.overdueAmount !== 0) return null;
          if (knownCodes.length === 1) return pay.byCurrency[knownCodes[0]].overdueAmount;
          if (knownCodes.length === 0) return 0;
          return null;
        })(),
        outstandingAmount: (() => {
          const knownCodes = Object.keys(pay.byCurrency);
          if (pay.unknown.outstandingAmount !== 0) return null;
          if (knownCodes.length === 1) return pay.byCurrency[knownCodes[0]].outstandingAmount;
          if (knownCodes.length === 0) return 0;
          return null;
        })(),
        unpaidCount: pay.totalCounts.unpaidCount,
        partiallyPaidCount: pay.totalCounts.partiallyPaidCount,
        paidCount: pay.totalCounts.paidCount,
        overdueCount: pay.totalCounts.overdueCount,
        byCurrency: pay.byCurrency,
        unknown: pay.unknown,
      },
      _grouped: { invoices: inv, payments: pay },
    };
  },

  async receipts(s: Scope) {
    const r = await receiptsGrouped(s);
    return {
      issued: {
        count: r.issued.totalCount,
        amount: singleCurrencyAmount(r.issued.byCurrency, r.issued.unknown),
        byCurrency: r.issued.byCurrency,
        unknown: r.issued.unknown,
      },
      void: {
        count: r.void.totalCount,
        amount: singleCurrencyAmount(r.void.byCurrency, r.void.unknown),
        byCurrency: r.void.byCurrency,
        unknown: r.void.unknown,
      },
      _grouped: r,
    };
  },

  async costs(s: Scope) {
    const c = await vendorCostsGrouped(s);
    return {
      finalized: {
        count: c.finalizedCount,
        amount: singleCurrencyAmount(c.byCurrency, c.unknown),
        byCurrency: c.byCurrency,
        unknown: c.unknown,
      },
      draftCount: c.draftCount,
      cancelledCount: c.cancelledCount,
      _grouped: c,
    };
  },

  async expenses(s: Scope) {
    const e = await basicExpensesGrouped(s);
    return {
      finalized: {
        count: e.finalizedCount,
        amount: singleCurrencyAmount(e.byCurrency, e.unknown),
        byCurrency: e.byCurrency,
        unknown: e.unknown,
      },
      draftCount: e.draftCount,
      cancelledCount: e.cancelledCount,
      _grouped: e,
    };
  },

  async unrepresentedVendorCost(s: Scope) {
    const u = await unrepresentedVendorCostGrouped(s);
    // Legacy scalar: single-currency convenience
    const knownCodes = Object.keys(u.byCurrency);
    const hasUnknown = u.unknown.amount !== 0;
    let legacyAmount: number | null;
    if (hasUnknown) legacyAmount = null;
    else if (knownCodes.length === 1) legacyAmount = u.byCurrency[knownCodes[0]].amount;
    else if (knownCodes.length === 0) legacyAmount = 0;
    else legacyAmount = null;

    return {
      amount: legacyAmount,
      byCurrency: u.byCurrency,
      unknown: u.unknown,
      _grouped: u,
    };
  },
};
