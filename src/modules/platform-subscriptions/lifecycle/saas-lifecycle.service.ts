/**
 * CR-BE-SAAS-01 PART 08 — Grace, suspension & reactivation service.
 *
 * Owns:
 *   1. Frozen §11.4 sweep — ACTIVE→PAST_DUE → GRACE → SUSPENDED plus the
 *      overdue-invoice projection. Deterministic callable seam; the
 *      external scheduler (out of repo scope) drives it on a cadence.
 *      Idempotent on repeated calls (state-checked + OCC).
 *   2. Frozen §11.5 explicit `reactivate` command — only path that can
 *      move SUSPENDED → ACTIVE. Validates outstanding invoices OR
 *      requires `overrideReason` (mandatory-audit).
 *   3. Frozen §12.2.3 suspension access policy — business-plane guard
 *      derived from `saas.suspended_access_policy`.
 *
 * Does NOT own:
 *   - PART 07 invoice PAID/PARTIALLY_PAID transitions (untouched);
 *   - PART 05 provisioning (untouched);
 *   - PART 04 entitlement effectiveness (already structurally correct
 *     via existing `isSubscriptionEffective` returning false for
 *     non-ACTIVE; this service never removes entitlement rows);
 *   - customer-status direct writes (reuses PART 03's
 *     `reprojectCustomerStatus` seam).
 *
 * D7 ABSOLUTE INVARIANT — verified by focused test:
 *   - PART 07 reconciliation NEVER auto-reactivates. This service is
 *     the only path that can flip SUSPENDED → ACTIVE.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../../database';
import { recordOperationalEvent } from '../../operational-events';
import { AppError, ERROR_CODES } from '../../../shared/errors';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../../request-idempotency';
import {
  saasSubscriptionNotFoundError,
  saasSubscriptionTransitionNotAllowedError,
  saasSubscriptionVersionConflictError,
  saasSubscriptionReactivationDeniedError,
  saasSubscriptionSuspendedError,
} from '../platform-subscription.errors';
import {
  SAAS_SUBSCRIPTION_CHANGED_EVENT,
} from '../platform-subscription.service';
import { platformSubscriptionRepository } from '../platform-subscription.repository';
import type {
  PublicSaasSubscription,
  SaasSubscriptionRecord,
} from '../platform-subscription.types';
import { saasInvoiceRepository } from '../../platform-billing/platform-invoice.repository';
import { saasLifecycleRepository } from './saas-lifecycle.repository';
import type {
  ReactivateSaasSubscriptionInput,
  ReactivateSaasSubscriptionResult,
  SaasSuspendedAccessPolicy,
  SweepBillingInput,
  SweepBillingResult,
  SuspendViaSweepInput,
} from './saas-lifecycle.types';

/** Frozen §18.2 — canonical audit event names. */
export const SAAS_SUBSCRIPTION_PAST_DUE_EVENT = 'SAAS_SUBSCRIPTION_PAST_DUE';
export const SAAS_SUBSCRIPTION_SUSPENDED_EVENT = 'SAAS_SUBSCRIPTION_SUSPENDED';
export const SAAS_SUBSCRIPTION_REACTIVATED_EVENT =
  'SAAS_SUBSCRIPTION_REACTIVATED';
/** Optional grace event (not in §18.2 frozen names but auditable; PART 08 only writes it when the row actually moves to GRACE). */
export const SAAS_SUBSCRIPTION_GRACE_EVENT = 'SAAS_SUBSCRIPTION_GRACE';
export const SAAS_INVOICE_OVERDUE_EVENT = 'SAAS_INVOICE_OVERDUE';

/** Frozen §17.2 — op key is explicit in the catalog. */
export const SAAS_SUBSCRIPTION_REACTIVATE_OPERATION_KEY =
  'saas.subscription.reactivate';

/**
 * The §11.4 sweep is naturally repeat-safe (state-checked) and therefore
 * does not take Idempotency-Key. The op-key list stays frozen.
 */
export const SAAS_SUBSCRIPTION_SWEEP_OPERATION_KEY =
  'saas.subscription.billing_sweep';

const REACTIVATABLE_FROM: ReadonlyArray<string> = ['SUSPENDED', 'GRACE'];

function toIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

async function reprojectCustomerStatus(
  clientId: string,
  client: PoolClient,
): Promise<{ before: string | null; after: string | null }> {
  if (process.env.LIFECYCLE_DEBUG === '1') {
    console.log('[reproject] start', clientId);
  }
  const customer = await client.query<{ status: string }>(
    `SELECT status FROM clients WHERE id = $1 FOR UPDATE`,
    [clientId],
  );
  if (process.env.LIFECYCLE_DEBUG === '1') {
    console.log('[reproject] customer row', customer.rows[0]);
  }
  const before = customer.rows[0]?.status ?? null;
  if (!before) return { before: null, after: null };

  const subsResult = await client.query<{ status: string }>(
    `SELECT status FROM subscriptions WHERE client_id = $1`,
    [clientId],
  );
  if (process.env.LIFECYCLE_DEBUG === '1') {
    console.log('[reproject] subs', subsResult.rows.length);
  }
  const statuses = subsResult.rows.map((r) => r.status);

  let projected: string;
  if (statuses.includes('ACTIVE')) projected = 'ACTIVE';
  else if (statuses.includes('TRIAL')) projected = 'TRIAL';
  else if (statuses.includes('GRACE') || statuses.includes('PAST_DUE'))
    projected = 'GRACE';
  else if (statuses.includes('SUSPENDED')) projected = 'SUSPENDED';
  else if (statuses.includes('DRAFT') || statuses.includes('PENDING'))
    projected = 'PROSPECT';
  else if (statuses.length === 0) projected = 'PROSPECT';
  else projected = 'TERMINATED';

  if (projected === before) return { before, after: before };
  if (before === 'INACTIVE' && projected === 'PROSPECT') {
    // Preserve legacy rows: never newly write a different legacy mapping.
    return { before, after: before };
  }

  await client.query(
    `UPDATE clients SET status = $1, version = version + 1,
            updated_at = NOW()
      WHERE id = $2`,
    [projected, clientId],
  );
  if (process.env.LIFECYCLE_DEBUG === '1') {
    console.log('[reproject] updated', projected);
  }
  return { before, after: projected };
}

async function auditSubscriptionEvent(
  params: {
    clientId: string;
    eventType: string;
    entityId: string;
    actorUserId: string;
    authority: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
  client: PoolClient,
): Promise<void> {
  if (process.env.LIFECYCLE_DEBUG === '1') {
    console.log('[audit] start', params.eventType);
  }
  await recordOperationalEvent(
    {
      clientId: params.clientId,
      eventType: params.eventType,
      entityType: 'SAAS_SUBSCRIPTION',
      entityId: params.entityId,
      actorUserId: params.actorUserId,
      summary: params.summary,
      metadata: {
        ...params.metadata,
        authority: params.authority,
      },
    },
    client,
  );
  if (process.env.LIFECYCLE_DEBUG === '1') {
    console.log('[audit] end', params.eventType);
  }
}

/**
 * Read the active suspension policy. Defaults to `FULL_BLOCK` when the
 * configuration key is missing (matches §20.2 default).
 */
export async function readSuspendedAccessPolicy(
  q?: PoolClient,
): Promise<SaasSuspendedAccessPolicy> {
  const v = await saasLifecycleRepository.readConfigString<string>(
    'saas.suspended_access_policy',
    q,
  );
  if (v === 'READ_ONLY' || v === 'LIMITED_ACCESS' || v === 'FULL_BLOCK') {
    return v;
  }
  return 'FULL_BLOCK';
}

/**
 * Read the §20.2 numeric policy values with frozen defaults.
 * Used only by the sweep service — never by business-plane requests.
 */
async function readSweepPolicyDays(
  q?: PoolClient,
): Promise<{
  pastDueGraceDays: number;
  gracePeriodDays: number;
}> {
  const past = await saasLifecycleRepository.readConfigNumber(
    'saas.past_due_grace_days',
    q,
  );
  const grace = await saasLifecycleRepository.readConfigNumber(
    'saas.grace_period_days',
    q,
  );
  return {
    pastDueGraceDays: past ?? 7,
    gracePeriodDays: grace ?? 14,
  };
}

/**
 * Enforce the §12.2.3 suspension policy on a business-plane mutation.
 * The active policy comes from `saas.suspended_access_policy`. Reads are
 * always allowed (per frozen §12.2.3.1); mutations are denied except
 * when the active policy is `LIMITED_ACCESS` AND the route is on the
 * allowlist. `READ_ONLY` and `FULL_BLOCK` both deny mutations.
 */
export async function assertNotSuspendedForBusinessPlaneMutation(
  customerId: string,
  subscriptionId: string,
  operation: string,
  q?: PoolClient,
): Promise<void> {
  const subsResult = await (q ?? requirePool()).query<{ status: string }>(
    `SELECT status FROM subscriptions
       WHERE client_id = $1
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1`,
    [customerId],
  );
  const status = subsResult.rows[0]?.status;
  if (!status) return;
  if (status === 'ACTIVE' || status === 'TRIAL') return;

  const policy = await readSuspendedAccessPolicy(q);
  if (policy === 'FULL_BLOCK') {
    throw saasSubscriptionSuspendedError(
      customerId,
      subscriptionId,
      policy,
      operation,
    );
  }
  if (policy === 'READ_ONLY') {
    // Only mutations are denied; read-only path returns here.
    if (operation.startsWith('read.')) return;
    throw saasSubscriptionSuspendedError(
      customerId,
      subscriptionId,
      policy,
      operation,
    );
  }
  // LIMITED_ACCESS — allowlist consult.
  const allowlistRaw = await saasLifecycleRepository.readConfigJson(
    'saas.suspended_limited_allowlist',
    q,
  );
  const allowlist = Array.isArray(allowlistRaw)
    ? (allowlistRaw.filter((x) => typeof x === 'string') as string[])
    : [];
  const matched = allowlist.some((pattern) => matchesRoute(pattern, operation));
  if (matched) return;
  throw saasSubscriptionSuspendedError(
    customerId,
    subscriptionId,
    policy,
    operation,
  );
}

function matchesRoute(pattern: string, op: string): boolean {
  if (pattern === op) return true;
  if (!pattern.includes('*')) return false;
  // very small glob: '*' suffix wildcard only — keeps the seam narrow.
  const prefix = pattern.replace(/\*$/, '');
  return op.startsWith(prefix);
}

function requirePool(): ReturnType<typeof import('../../../database').getPool> {
  // Lazy require avoids circular import at module-load time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../../database').getPool();
}

/**
 * POST /platform/subscriptions/:id/sweep-billing — admin/operator
 * callable seam that exercises the frozen §11.4 transition graph for
 * ONE subscription. The future scheduler (PART 14+) drives this on a
 * cadence; we do not invent a cron worker here.
 *
 * Frozen §11.4 rules:
 *   1. ACTIVE with renewal_date < now AND has unpaid invoice → PAST_DUE.
 *   2. PAST_DUE older than platform-configured past_due_grace_days
 *      → GRACE with grace_until = now + grace_period_days.
 *   3. GRACE with grace_until < now → SUSPENDED.
 *   4. Trial lapsed → SUSPENDED (PART 08 §11.4.4).
 *
 * Idempotent: state-checked, version-guarded. Repeated calls produce
 * NO duplicate audit events because we skip transitions whose target
 * matches the current state.
 */
export async function sweepSubscriptionLifecycle(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: SweepBillingInput = {},
): Promise<SweepBillingResult> {
  const cutoff = input.cutoff ?? new Date();
  const touched: string[] = [];
  const noOp = true;
  let overdueInvoicesMarked = 0;
  let pastDueTransitions = 0;
  let graceTransitions = 0;
  let suspendedTransitions = 0;

  await withTransaction(async (client) => {
    if (process.env.LIFECYCLE_DEBUG === '1') {
      console.log('[sweep] in tx');
    }
    const locked = await platformSubscriptionRepository.lockById(
      subscriptionId,
      client,
    );
    if (process.env.LIFECYCLE_DEBUG === '1') {
      console.log('[sweep] locked', locked?.status);
    }
    if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

    // ── (a) Overdue invoice projection (PART 08 §11.4) — eligible
    //     invoices are ISSUED/PARTIALLY_PAID with dueAt < cutoff.
    //     Marked via OCC; replay-safe (status guard skips existing
    //     OVERDUE/PAID/VOID/DRAFT rows).
    const overdueCandidates = await client.query<{
      id: string;
      dueAt: Date | null;
      version: number;
    }>(
      `SELECT id, due_at AS "dueAt", version
         FROM saas_invoices
        WHERE subscription_id = $1
          AND status IN ('ISSUED', 'PARTIALLY_PAID')
          AND due_at IS NOT NULL AND due_at < $2`,
      [subscriptionId, cutoff],
    );
    if (process.env.LIFECYCLE_DEBUG === '1') {
      console.log('[sweep] overdue candidates', overdueCandidates.rows.length);
    }
    for (const candidate of overdueCandidates.rows) {
      const updated = await saasInvoiceRepository.markOverdueWithVersion(
        candidate.id,
        candidate.version,
        cutoff,
        client,
      );
      if (!updated) continue;
      overdueInvoicesMarked += 1;
      await auditSubscriptionEvent(
        {
          clientId: locked.clientId,
          eventType: SAAS_INVOICE_OVERDUE_EVENT,
          entityId: updated.id,
          actorUserId,
          authority,
          summary: `SaaS invoice marked OVERDUE: ${updated.number ?? updated.id}`,
          metadata: {
            subscriptionId: locked.id,
            invoiceId: updated.id,
            invoiceStatus: updated.status,
            dueAt: toIso(updated.dueAt),
            cutoff: cutoff.toISOString(),
            reason: 'sweep',
          },
        },
        client,
      );
    }

    // ── (b) Subscription transition (server-authoritative).
    if (locked.status === 'TRIAL' && locked.trialEndDate) {
      if (locked.trialEndDate.getTime() <= cutoff.getTime()) {
        // Trial lapsed → SUSPENDED (frozen §11.4.4).
        const updated = await platformSubscriptionRepository.updateWithVersion(
          locked.id,
          { status: 'SUSPENDED' },
          locked.version,
          client,
        );
        if (updated) {
          touched.push(updated.id);
          suspendedTransitions += 1;
          await emitChangedAndSuspended(
            client,
            updated,
            locked,
            actorUserId,
            authority,
            'trial_lapsed',
          );
        }
        return;
      }
    }

    if (
      locked.status === 'ACTIVE' &&
      locked.renewalDate !== null &&
      locked.renewalDate.getTime() < cutoff.getTime()
    ) {
      // Has unpaid invoice? (PART 08 transitions ACTIVE → PAST_DUE only
      // when there is at least one ISSUED/PARTIALLY_PAID/OVERDUE
      // invoice; otherwise the renewal sweep is out of scope for this
      // step — `renewal_date` itself is handled by the renew command).
      const openInvoice = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM saas_invoices
          WHERE subscription_id = $1
            AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')`,
        [locked.id],
      );
      if (process.env.LIFECYCLE_DEBUG === '1') {
        console.log('[sweep] openInvoice count', openInvoice.rows[0]);
      }
      if (Number(openInvoice.rows[0]?.count ?? '0') > 0) {
        const updated = await platformSubscriptionRepository.updateWithVersion(
          locked.id,
          { status: 'PAST_DUE' },
          locked.version,
          client,
        );
        if (process.env.LIFECYCLE_DEBUG === '1') {
          console.log('[sweep] PAST_DUE updated', updated);
        }
        if (updated) {
          touched.push(updated.id);
          pastDueTransitions += 1;
          await emitChangedAndPastDue(
            client,
            updated,
            locked,
            actorUserId,
            authority,
          );
        }
      }
    }

    // Re-read after the possible PAST_DUE transition above.
    const afterPastDue =
      touched.includes(locked.id)
        ? await platformSubscriptionRepository.lockById(locked.id, client)
        : locked;

    if (afterPastDue && afterPastDue.status === 'PAST_DUE') {
      const { pastDueGraceDays } = await readSweepPolicyDays(client);
      const deadlineMs =
        afterPastDue.updatedAt !== null
          ? afterPastDue.updatedAt.getTime() + pastDueGraceDays * 86_400_000
          : null;
      if (deadlineMs !== null && cutoff.getTime() >= deadlineMs) {
        const { gracePeriodDays } = await readSweepPolicyDays(client);
        const graceUntil = new Date(
          cutoff.getTime() + gracePeriodDays * 86_400_000,
        );
        const updated = await platformSubscriptionRepository.updateWithVersion(
          afterPastDue.id,
          { status: 'GRACE', graceUntil },
          afterPastDue.version,
          client,
        );
        if (updated) {
          touched.push(updated.id);
          graceTransitions += 1;
          await emitChangedAndGrace(
            client,
            updated,
            afterPastDue,
            actorUserId,
            authority,
            graceUntil,
          );
        }
      }
    }

    // Re-read again for the SUSPENDED gate.
    const afterGrace =
      graceTransitions > 0
        ? await platformSubscriptionRepository.lockById(locked.id, client)
        : (await platformSubscriptionRepository.lockById(locked.id, client));

    if (afterGrace && afterGrace.status === 'GRACE' && afterGrace.graceUntil) {
      if (afterGrace.graceUntil.getTime() <= cutoff.getTime()) {
        const updated = await platformSubscriptionRepository.updateWithVersion(
          afterGrace.id,
          { status: 'SUSPENDED' },
          afterGrace.version,
          client,
        );
        if (updated) {
          touched.push(updated.id);
          suspendedTransitions += 1;
          await emitChangedAndSuspended(
            client,
            updated,
            afterGrace,
            actorUserId,
            authority,
            'grace_elapsed',
          );
        }
      }
    }
  });

  return {
    cutoff: cutoff.toISOString(),
    overdueInvoicesMarked,
    pastDueTransitions,
    graceTransitions,
    suspendedTransitions,
    touchedSubscriptionIds: touched,
    noOp:
      noOp &&
      overdueInvoicesMarked === 0 &&
      pastDueTransitions === 0 &&
      graceTransitions === 0 &&
      suspendedTransitions === 0,
  };
}

/**
 * Bulk sweep over all eligible subscriptions. Used by the future
 * scheduler; callable from the route for ops. Same idempotency
 * guarantees as `sweepSubscriptionLifecycle`.
 */
export async function sweepAllSubscriptionsLifecycle(
  actorUserId: string,
  authority: string,
  input: SweepBillingInput = {},
): Promise<SweepBillingResult> {
  const cutoff = input.cutoff ?? new Date();
  const limit = input.limit ?? 200;
  const aggregated: SweepBillingResult = {
    cutoff: cutoff.toISOString(),
    overdueInvoicesMarked: 0,
    pastDueTransitions: 0,
    graceTransitions: 0,
    suspendedTransitions: 0,
    touchedSubscriptionIds: [],
    noOp: true,
  };

  // 1. Mark overdue invoices.
  const overdue = await saasLifecycleRepository.listOverdueInvoices(
    cutoff,
    limit,
  );
  for (const candidate of overdue) {
    const result = await withTransaction(async (client) => {
      const updated = await saasInvoiceRepository.markOverdueWithVersion(
        candidate.id,
        candidate.version,
        cutoff,
        client,
      );
      if (!updated) return null;
      await auditSubscriptionEvent(
        {
          clientId: candidate.customerId,
          eventType: SAAS_INVOICE_OVERDUE_EVENT,
          entityId: updated.id,
          actorUserId,
          authority,
          summary: `SaaS invoice marked OVERDUE: ${updated.number ?? updated.id}`,
          metadata: {
            subscriptionId: candidate.subscriptionId,
            invoiceId: updated.id,
            dueAt: toIso(updated.dueAt),
            cutoff: cutoff.toISOString(),
            reason: 'bulk_sweep',
          },
        },
        client,
      );
      return updated;
    });
    if (result) aggregated.overdueInvoicesMarked += 1;
  }

  // 2. PAST_DUE sweep.
  const overdueSubs = await saasLifecycleRepository.listOverdueEvaluationCandidates(
    cutoff,
    limit,
  );
  for (const sub of overdueSubs) {
    if (sub.status !== 'ACTIVE') continue;
    const hasOpenInvoice = await requirePool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM saas_invoices
        WHERE subscription_id = $1
          AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')`,
      [sub.id],
    );
    if (Number(hasOpenInvoice.rows[0]?.count ?? '0') === 0) continue;
    const out = await sweepSubscriptionLifecycle(actorUserId, authority, sub.id, {
      cutoff,
    });
    aggregate(aggregated, out);
  }

  // 3. PAST_DUE → GRACE.
  const { pastDueGraceDays } = await readSweepPolicyDays();
  const pastDueSubs = await saasLifecycleRepository.listPastDueOlderThan(
    pastDueGraceDays,
    cutoff,
    limit,
  );
  for (const sub of pastDueSubs) {
    const out = await sweepSubscriptionLifecycle(actorUserId, authority, sub.id, {
      cutoff,
    });
    aggregate(aggregated, out);
  }

  // 4. GRACE → SUSPENDED.
  const graceSubs = await saasLifecycleRepository.listGraceDeadlineReached(
    cutoff,
    limit,
  );
  for (const sub of graceSubs) {
    const out = await sweepSubscriptionLifecycle(actorUserId, authority, sub.id, {
      cutoff,
    });
    aggregate(aggregated, out);
  }

  aggregated.noOp =
    aggregated.overdueInvoicesMarked === 0 &&
    aggregated.pastDueTransitions === 0 &&
    aggregated.graceTransitions === 0 &&
    aggregated.suspendedTransitions === 0;
  return aggregated;
}

function aggregate(target: SweepBillingResult, next: SweepBillingResult): void {
  target.overdueInvoicesMarked += next.overdueInvoicesMarked;
  target.pastDueTransitions += next.pastDueTransitions;
  target.graceTransitions += next.graceTransitions;
  target.suspendedTransitions += next.suspendedTransitions;
  const seen = new Set(target.touchedSubscriptionIds);
  for (const id of next.touchedSubscriptionIds) {
    if (!seen.has(id)) {
      target.touchedSubscriptionIds.push(id);
      seen.add(id);
    }
  }
}

/**
 * Suspend via the explicit sweep command (used when a caller wants to
 * drive one subscription through the suspended state without invoking
 * the full sweep). Same OCC + audit invariants as the sweep.
 */
export async function suspendSubscriptionViaSweep(
  actorUserId: string,
  authority: string,
  input: SuspendViaSweepInput,
): Promise<PublicSaasSubscription> {
  return withTransaction(async (client) => {
    const locked = await platformSubscriptionRepository.lockById(
      input.subscriptionId,
      client,
    );
    if (!locked) throw saasSubscriptionNotFoundError(input.subscriptionId);
    if (locked.status !== 'GRACE' && locked.status !== 'PAST_DUE') {
      throw saasSubscriptionTransitionNotAllowedError(
        locked.status,
        'SUSPENDED',
        ['GRACE', 'PAST_DUE'],
      );
    }
    const updated = await platformSubscriptionRepository.updateWithVersion(
      input.subscriptionId,
      { status: 'SUSPENDED' },
      input.expectedVersion,
      client,
    );
    if (!updated) {
      const current = await platformSubscriptionRepository.findById(
        input.subscriptionId,
        client,
      );
      if (!current) throw saasSubscriptionNotFoundError(input.subscriptionId);
      throw saasSubscriptionVersionConflictError(
        input.subscriptionId,
        current.version,
        input.expectedVersion,
      );
    }
    const projection = await reprojectCustomerStatus(updated.clientId, client);
    await auditSubscriptionEvent(
      {
        clientId: updated.clientId,
        eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
        entityId: updated.id,
        actorUserId,
        authority,
        summary: `SaaS subscription changed: ${updated.code} ${locked.status} → SUSPENDED`,
        metadata: {
          before: { status: locked.status, graceUntil: toIso(locked.graceUntil) },
          after: {
            status: 'SUSPENDED',
            graceUntil: toIso(updated.graceUntil),
          },
          reason: input.reason,
          customerStatusBefore: projection.before,
          customerStatusAfter: projection.after,
        },
      },
      client,
    );
    await auditSubscriptionEvent(
      {
        clientId: updated.clientId,
        eventType: SAAS_SUBSCRIPTION_SUSPENDED_EVENT,
        entityId: updated.id,
        actorUserId,
        authority,
        summary: `SaaS subscription suspended: ${updated.code}`,
        metadata: {
          fromStatus: locked.status,
          reason: input.reason,
        },
      },
      client,
    );
    return toPublic(updated);
  });
}

/**
 * POST /platform/subscriptions/:id/reactivate — frozen §11.5.
 *
 * ONLY path that can flip SUSPENDED → ACTIVE (D7 invariant). Validates:
 *   1. current status ∈ {SUSPENDED, GRACE};
 *   2. no outstanding SaaS invoice — OR `overrideReason` is supplied;
 *   3. expectedVersion matches (frozen §17.3);
 *   4. re-projects customer status via the canonical PART 03 seam;
 *   5. emits exactly one SAAS_SUBSCRIPTION_REACTIVATED event (plus the
 *      canonical SAAS_SUBSCRIPTION_CHANGED for the transition).
 *
 * Idempotent: replay on a successful reactivate returns the same
 * subscription row; replay on a different body or stale version raises
 * 409 (executeIdempotent fingerprint conflict).
 */
export async function reactivateSaasSubscription(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: ReactivateSaasSubscriptionInput,
  idempotencyKey: string,
): Promise<ReactivateSaasSubscriptionResult> {
  const requestFingerprint = stableFingerprint({
    id: subscriptionId,
    body: input,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_SUBSCRIPTION_REACTIVATE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) =>
      doReactivate(actorUserId, authority, subscriptionId, input, client),
  });

  return result.responseBody as ReactivateSaasSubscriptionResult;
}

function stableFingerprint(value: unknown): string {
  return computeRequestFingerprint(value);
}

async function doReactivate(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: ReactivateSaasSubscriptionInput,
  client: PoolClient,
): Promise<{
  responseStatus: number;
  responseBody: ReactivateSaasSubscriptionResult;
}> {
  const locked = await platformSubscriptionRepository.lockById(
    subscriptionId,
    client,
  );
  if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

  if (!REACTIVATABLE_FROM.includes(locked.status)) {
    throw saasSubscriptionReactivationDeniedError(
      subscriptionId,
      'invalid_state',
      { fromStatus: locked.status },
    );
  }

  const outstanding =
    await saasLifecycleRepository.findOutstandingInvoicesForSubscription(
      subscriptionId,
      client,
    );

  const hasOutstanding = outstanding.length > 0;
  const overrideReason = (input.overrideReason ?? '').trim();
  if (hasOutstanding && overrideReason.length === 0) {
    throw saasSubscriptionReactivationDeniedError(
      subscriptionId,
      'unpaid',
      {
        outstandingInvoiceIds: outstanding.map((r) => r.id),
        expectedOverrideReason: true,
      },
    );
  }
  const overrideApplied = hasOutstanding && overrideReason.length > 0;

  const updated = await platformSubscriptionRepository.updateWithVersion(
    subscriptionId,
    {
      status: 'ACTIVE',
      graceUntil: null,
    },
    input.expectedVersion,
    client,
  );
  if (!updated) {
    const current = await platformSubscriptionRepository.findById(
      subscriptionId,
      client,
    );
    if (!current) throw saasSubscriptionNotFoundError(subscriptionId);
    throw saasSubscriptionVersionConflictError(
      subscriptionId,
      current.version,
      input.expectedVersion,
    );
  }

  const projection = await reprojectCustomerStatus(updated.clientId, client);

  await auditSubscriptionEvent(
    {
      clientId: updated.clientId,
      eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
      entityId: updated.id,
      actorUserId,
      authority,
      summary: `SaaS subscription changed: ${updated.code} ${locked.status} → ACTIVE`,
      metadata: {
        before: { status: locked.status, graceUntil: toIso(locked.graceUntil) },
        after: { status: 'ACTIVE', graceUntil: null },
        overrideApplied,
        ...(overrideApplied ? { overrideReason } : {}),
        ...(hasOutstanding
          ? { outstandingInvoiceIds: outstanding.map((r) => r.id) }
          : {}),
        customerStatusBefore: projection.before,
        customerStatusAfter: projection.after,
      },
    },
    client,
  );

  await auditSubscriptionEvent(
    {
      clientId: updated.clientId,
      eventType: SAAS_SUBSCRIPTION_REACTIVATED_EVENT,
      entityId: updated.id,
      actorUserId,
      authority,
      summary: `SaaS subscription reactivated: ${updated.code}`,
      metadata: {
        fromStatus: locked.status,
        overrideApplied,
        ...(overrideApplied ? { overrideReason } : {}),
        ...(hasOutstanding
          ? { outstandingInvoiceIds: outstanding.map((r) => r.id) }
          : {}),
      },
    },
    client,
  );

  return {
    responseStatus: 200,
    responseBody: {
      subscription: toPublic(updated),
      overrideApplied,
      customerStatusBefore: projection.before,
      customerStatusAfter: projection.after,
    },
  };
}

function toPublic(record: SaasSubscriptionRecord): PublicSaasSubscription {
  // Defer to PART 03's canonical public mapping; never re-derive here.
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    planCode: record.planCode ?? '',
    status: record.status as PublicSaasSubscription['status'],
    trialEndDate: toIso(record.trialEndDate),
    startsAt: toIso((record as unknown as { startsAt?: Date | null }).startsAt ?? null) ?? toIso(record.createdAt) ?? '',
    endsAt: toIso((record as unknown as { endsAt?: Date | null }).endsAt ?? null),
    currentPeriodStart: toIso(record.currentPeriodStart),
    currentPeriodEnd: toIso(record.currentPeriodEnd),
    renewalDate: toIso(record.renewalDate),
    graceUntil: toIso(record.graceUntil),
    cancelledAt: toIso(record.cancelledAt),
    terminatedAt: toIso(record.terminatedAt),
    productId: record.productId,
    packageId: record.packageId,
    pricebookVersionId: record.pricebookVersionId,
    billingCycle: record.billingCycle as PublicSaasSubscription['billingCycle'],
    currencyCode: record.currencyCode,
    version: record.version,
    createdAt: toIso(record.createdAt) ?? '',
    updatedAt: toIso(record.updatedAt) ?? '',
  };
}

async function emitChangedAndPastDue(
  client: PoolClient,
  updated: Awaited<ReturnType<typeof platformSubscriptionRepository.lockById>> & object,
  before: { status: string; graceUntil: Date | null },
  actorUserId: string,
  authority: string,
): Promise<void> {
  const locked = updated as unknown as {
    id: string;
    clientId: string;
    code: string;
  };
  const projection = await reprojectCustomerStatus(locked.clientId, client);
  await auditSubscriptionEvent(
    {
      clientId: locked.clientId,
      eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
      entityId: locked.id,
      actorUserId,
      authority,
      summary: `SaaS subscription changed: ${locked.code} ${before.status} → PAST_DUE`,
      metadata: {
        before: { status: before.status, graceUntil: toIso(before.graceUntil) },
        after: { status: 'PAST_DUE' },
        reason: 'sweep',
        customerStatusBefore: projection.before,
        customerStatusAfter: projection.after,
      },
    },
    client,
  );
  await auditSubscriptionEvent(
    {
      clientId: locked.clientId,
      eventType: SAAS_SUBSCRIPTION_PAST_DUE_EVENT,
      entityId: locked.id,
      actorUserId,
      authority,
      summary: `SaaS subscription PAST_DUE: ${locked.code}`,
      metadata: { fromStatus: before.status, reason: 'sweep' },
    },
    client,
  );
}

async function emitChangedAndGrace(
  client: PoolClient,
  updated: Awaited<ReturnType<typeof platformSubscriptionRepository.lockById>> & object,
  before: { status: string; graceUntil: Date | null },
  actorUserId: string,
  authority: string,
  graceUntil: Date,
): Promise<void> {
  const locked = updated as unknown as {
    id: string;
    clientId: string;
    code: string;
  };
  const projection = await reprojectCustomerStatus(locked.clientId, client);
  await auditSubscriptionEvent(
    {
      clientId: locked.clientId,
      eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
      entityId: locked.id,
      actorUserId,
      authority,
      summary: `SaaS subscription changed: ${locked.code} ${before.status} → GRACE`,
      metadata: {
        before: { status: before.status, graceUntil: toIso(before.graceUntil) },
        after: { status: 'GRACE', graceUntil: graceUntil.toISOString() },
        reason: 'sweep',
        graceUntil: graceUntil.toISOString(),
        customerStatusBefore: projection.before,
        customerStatusAfter: projection.after,
      },
    },
    client,
  );
  await auditSubscriptionEvent(
    {
      clientId: locked.clientId,
      eventType: SAAS_SUBSCRIPTION_GRACE_EVENT,
      entityId: locked.id,
      actorUserId,
      authority,
      summary: `SaaS subscription GRACE: ${locked.code}`,
      metadata: {
        fromStatus: before.status,
        graceUntil: graceUntil.toISOString(),
      },
    },
    client,
  );
}

async function emitChangedAndSuspended(
  client: PoolClient,
  updated: Awaited<ReturnType<typeof platformSubscriptionRepository.lockById>> & object,
  before: { status: string; graceUntil: Date | null },
  actorUserId: string,
  authority: string,
  reason: string,
): Promise<void> {
  const locked = updated as unknown as {
    id: string;
    clientId: string;
    code: string;
  };
  const projection = await reprojectCustomerStatus(locked.clientId, client);
  await auditSubscriptionEvent(
    {
      clientId: locked.clientId,
      eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
      entityId: locked.id,
      actorUserId,
      authority,
      summary: `SaaS subscription changed: ${locked.code} ${before.status} → SUSPENDED`,
      metadata: {
        before: { status: before.status, graceUntil: toIso(before.graceUntil) },
        after: { status: 'SUSPENDED' },
        reason,
        customerStatusBefore: projection.before,
        customerStatusAfter: projection.after,
      },
    },
    client,
  );
  await auditSubscriptionEvent(
    {
      clientId: locked.clientId,
      eventType: SAAS_SUBSCRIPTION_SUSPENDED_EVENT,
      entityId: locked.id,
      actorUserId,
      authority,
      summary: `SaaS subscription SUSPENDED: ${locked.code}`,
      metadata: { fromStatus: before.status, reason },
    },
    client,
  );
}

// Utility — exported for tests that need to assert the catalog.
export const _internal = {
  REACTIVATABLE_FROM,
  randomUUID,
  AppError,
  ERROR_CODES,
};
