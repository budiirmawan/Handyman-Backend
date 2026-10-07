/**
 * CR-BE-SAAS-01 PART 08 — Lifecycle repository seam.
 *
 * Reuses the canonical `platform_configurations` table (§20) for policy
 * values. PART 12 owns the broader catalogue; PART 08 only reads the
 * three keys it actually depends on (`saas.past_due_grace_days`,
 * `saas.grace_period_days`, `saas.suspended_access_policy`,
 * `saas.suspended_limited_allowlist`) and never writes them.
 *
 * NO duplicate commercial authority lives here; the lifecycle service
 * composes these reads with the PART 03 subscription repository and
 * the PART 06 invoice repository. No new aggregate is created.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../../../database';
import type { SaasSuspendedAccessPolicy } from './saas-lifecycle.types';

type Executor = PoolClient | ReturnType<typeof getPool>;

function executor(q?: Executor): Executor {
  return q ?? getPool();
}

type ConfigRow = {
  value: unknown;
};

async function readConfigNumber(
  key: string,
  q?: Executor,
): Promise<number | null> {
  const result = await executor(q).query<ConfigRow>(
    `SELECT value FROM platform_configurations WHERE key = $1`,
    [key],
  );
  const raw = result.rows[0]?.value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function readConfigString<T extends string>(
  key: string,
  q?: Executor,
): Promise<T | null> {
  const result = await executor(q).query<ConfigRow>(
    `SELECT value FROM platform_configurations WHERE key = $1`,
    [key],
  );
  const raw = result.rows[0]?.value;
  if (typeof raw !== 'string') return null;
  return raw as T;
}

async function readConfigJson(
  key: string,
  q?: Executor,
): Promise<unknown> {
  const result = await executor(q).query<ConfigRow>(
    `SELECT value FROM platform_configurations WHERE key = $1`,
    [key],
  );
  return result.rows[0]?.value ?? null;
}

/**
 * Outstanding (PARTIALLY_PAID + ISSUED) SaaS invoices for a subscription.
 * Used by the reactivation service to enforce §11.5.2.
 */
type OutstandingInvoiceRow = { id: string; status: string; dueAt: Date | null };
async function findOutstandingInvoicesForSubscription(
  subscriptionId: string,
  q?: Executor,
): Promise<readonly OutstandingInvoiceRow[]> {
  const result = await executor(q).query<OutstandingInvoiceRow>(
    `SELECT id, status, due_at AS "dueAt"
       FROM saas_invoices
      WHERE subscription_id = $1
        AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')`,
    [subscriptionId],
  );
  return result.rows;
}

/**
 * ACTIVE/PAST_DUE/GRACE subscriptions whose renewal window has passed
 * without a renewal — frozen §11.4.1. Always pulls a bounded slice
 * (caller-supplied `limit`).
 */
type PastDueCandidateRow = {
  id: string;
  clientId: string;
  status: string;
  renewalDate: Date | null;
  currentPeriodEnd: Date | null;
  version: number;
};
async function listOverdueEvaluationCandidates(
  cutoff: Date,
  limit: number,
  q?: Executor,
): Promise<readonly PastDueCandidateRow[]> {
  const result = await executor(q).query<PastDueCandidateRow>(
    `SELECT id, client_id AS "clientId", status,
            renewal_date AS "renewalDate",
            current_period_end AS "currentPeriodEnd",
            version
       FROM subscriptions
      WHERE status IN ('ACTIVE', 'PAST_DUE')
        AND renewal_date IS NOT NULL AND renewal_date < $1
      ORDER BY renewal_date ASC, id ASC
      LIMIT $2`,
    [cutoff, Math.max(1, Math.min(limit, 1000))],
  );
  return result.rows;
}

async function listGraceDeadlineReached(
  cutoff: Date,
  limit: number,
  q?: Executor,
): Promise<readonly PastDueCandidateRow[]> {
  const result = await executor(q).query<PastDueCandidateRow>(
    `SELECT id, client_id AS "clientId", status,
            renewal_date AS "renewalDate",
            current_period_end AS "currentPeriodEnd",
            version
       FROM subscriptions
      WHERE status = 'GRACE'
        AND grace_until IS NOT NULL AND grace_until < $1
      ORDER BY grace_until ASC, id ASC
      LIMIT $2`,
    [cutoff, Math.max(1, Math.min(limit, 1000))],
  );
  return result.rows;
}

async function listPastDueOlderThan(
  days: number,
  cutoff: Date,
  limit: number,
  q?: Executor,
): Promise<readonly PastDueCandidateRow[]> {
  const threshold = new Date(
    cutoff.getTime() - days * 86_400_000,
  );
  const result = await executor(q).query<PastDueCandidateRow>(
    `SELECT id, client_id AS "clientId", status,
            renewal_date AS "renewalDate",
            current_period_end AS "currentPeriodEnd",
            version
       FROM subscriptions
      WHERE status = 'PAST_DUE'
        AND updated_at IS NOT NULL AND updated_at < $1
      ORDER BY updated_at ASC, id ASC
      LIMIT $2`,
    [threshold, Math.max(1, Math.min(limit, 1000))],
  );
  return result.rows;
}

async function listOverdueInvoices(
  cutoff: Date,
  limit: number,
  q?: Executor,
): Promise<
  readonly {
    id: string;
    subscriptionId: string | null;
    customerId: string;
    dueAt: Date | null;
    version: number;
  }[]
> {
  const result = await executor(q).query<{
    id: string;
    subscriptionId: string | null;
    customerId: string;
    dueAt: Date | null;
    version: number;
  }>(
    `SELECT id, subscription_id AS "subscriptionId",
            customer_id AS "customerId",
            due_at AS "dueAt", version
       FROM saas_invoices
      WHERE status IN ('ISSUED', 'PARTIALLY_PAID')
        AND due_at IS NOT NULL AND due_at < $1
      ORDER BY due_at ASC, id ASC
      LIMIT $2`,
    [cutoff, Math.max(1, Math.min(limit, 1000))],
  );
  return result.rows;
}

export const saasLifecycleRepository = {
  readConfigNumber,
  readConfigString,
  readConfigJson,
  findOutstandingInvoicesForSubscription,
  listOverdueEvaluationCandidates,
  listGraceDeadlineReached,
  listPastDueOlderThan,
  listOverdueInvoices,
};

export type { SaasSuspendedAccessPolicy };
