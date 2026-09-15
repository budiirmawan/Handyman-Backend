import { findDueReminders, dispatchReminder } from '../notification-reminders';
import { processDueSlaClocks } from '../applied-slas/applied-sla.service';
import { findDueEscalations, triggerEscalation } from '../notification-escalations';
import { processDueOutboundDeliveries } from '../notification-delivery';
import { processDueSlaEscalations } from '../sla-escalation-actions';
import { processDueEvidenceRetention } from '../evidence-retention-policies/evidence-retention-execution.service';
import { processDueIntegrationWebhookJobs } from '../integration-webhook-deliveries';
import { runWithSchedulerContext } from '../../shared/request-context';
import type {
  DueEvidenceRetentionResult,
  DueIntegrationWebhookResult,
  DueJobDispatchResult,
  DueJobDomainResult,
  DueOutboundDeliveryResult,
} from './due-job-dispatcher.types';

/**
 * CR-BE-STAB-01 PART 03 — lightweight due operational job dispatcher.
 *
 * WHY IT EXISTS
 * -------------
 * The reminder (`findDueReminders` / `dispatchReminder`) and escalation
 * (`findDueEscalations` / `triggerEscalation`) modules already own their full
 * domain logic: due-window enumeration, template rendering, recipient
 * resolution, in-app notification recording, and the atomic PENDING→SENT /
 * PENDING→TRIGGERED transition that makes each item idempotent. What they do
 * NOT ship is a runtime caller. This dispatcher is that caller: the smallest
 * surface that invokes the existing seams on demand. PART 04 wires it into
 * application boot / a cadence; this PART only provides the callable service
 * and its focused tests.
 *
 * REUSE, NOT REDESIGN
 * -------------------
 * No notification, reminder, escalation, Corrective Action, Incident, or
 * document-expiry domain logic is touched. This module holds no tables and no
 * new decision model. It consumes the existing seams as-is.
 *
 * IDEMPOTENCY
 * -----------
 * Each item is processed through its existing per-item seam
 * (`dispatchReminder` / `triggerEscalation`), whose contract is already
 * idempotent: a non-PENDING item is a no-op (returns null) and the PENDING→done
 * transition is a status-guarded single UPDATE. Running the dispatcher twice
 * therefore delivers no duplicate notifications — the second run finds the due
 * window but the items are no longer PENDING, so they are skipped.
 *
 * FAILURE ISOLATION
 * -----------------
 * Eligible items are enumerated via `findDueReminders` / `findDueEscalations`
 * and each is processed inside its own try/catch, so one failing item cannot
 * prevent the remaining eligible items in the same window from being handled.
 * Failures are counted (not swallowed silently) and reported in the result.
 * (The underlying per-item seams already treat already-done / inactive-template
 * items as skips rather than failures; the try/catch here additionally contains
 * unexpected throw paths.)
 *
 * SAFE WHEN EMPTY
 * ---------------
 * An empty due window yields all-zero counts without error.
 */

/** A single worker invocation result normalized for counting. */
type ItemOutcome = {
  /** true when the item did not throw. */
  ok: boolean;
  /** The per-item seam's public result, if any (null = already done / skip). */
  result: { notifications: readonly unknown[] } | null;
};

/**
 * Processes one due item through `worker`, isolating any failure so remaining
 * eligible items are unaffected. The worker is invoked exactly once.
 */
async function runItem(
  id: string,
  worker: (id: string) => Promise<{ notifications: readonly unknown[] } | null>,
): Promise<ItemOutcome> {
  try {
    return { ok: true, result: await worker(id) };
  } catch {
    return { ok: false, result: null };
  }
}

/** Counts a per-domain item outcome into the running totals. */
function accumulate(
  outcome: ItemOutcome,
  state: DueJobDomainResult,
): void {
  if (!outcome.ok) {
    state.failures += 1;
    return;
  }
  if (outcome.result) {
    state.processed += 1;
    state.notificationsCreated += outcome.result.notifications.length;
  }
}

async function processDueReminders(before: Date): Promise<DueJobDomainResult> {
  const state: DueJobDomainResult = {
    processed: 0,
    notificationsCreated: 0,
    failures: 0,
  };
  const due = await findDueReminders(before);
  for (const reminder of due) {
    accumulate(await runItem(reminder.id, (id) => dispatchReminder(id)), state);
  }
  return state;
}

async function processDueEscalations(before: Date): Promise<DueJobDomainResult> {
  const state: DueJobDomainResult = {
    processed: 0,
    notificationsCreated: 0,
    failures: 0,
  };
  const due = await findDueEscalations(before);
  for (const escalation of due) {
    accumulate(await runItem(escalation.id, (id) => triggerEscalation(id)), state);
  }
  return state;
}

/**
 * CR-BE-SLA-02 PART 04 — SLA breach detection, normalized for reporting.
 *
 * `processDueSlaClocks` is SLA-01 authority and keeps its own signature
 * (`Promise<number>` = clocks newly marked breached). Rather than change that
 * contract — and every SLA-01 caller with it — the dispatcher adapts it here,
 * which §6.3 of the CR-BE-SLA-02 governance explicitly allows.
 *
 * Breach detection creates no notifications of its own (escalation delivery is
 * the next domain's job), so `notificationsCreated` is always 0. The whole call
 * is isolated: SLA-01 owns its per-clock transaction, so if the batch throws,
 * the failure is counted here and the remaining domains still run.
 */
async function processDueSlaClockDomain(before: Date): Promise<DueJobDomainResult> {
  try {
    const breached = await processDueSlaClocks(before);
    return { processed: breached, notificationsCreated: 0, failures: 0 };
  } catch {
    return { processed: 0, notificationsCreated: 0, failures: 1 };
  }
}

/**
 * CR-BE-SLA-02 PART 04 — SLA escalation levels due this tick.
 *
 * `processDueSlaEscalations` (PART 03) owns the whole domain: the bounded
 * `FOR UPDATE SKIP LOCKED` due query (clamped to DUE_ITEM_RETRIEVAL_LIMIT), the
 * atomic PENDING→TRIGGERED claim that makes a second run a no-op, per-action
 * failure isolation, recipient resolution, and notification recording. The
 * dispatcher only maps its richer result onto the uniform domain shape:
 *
 *   processed            ← triggered  (actions this run actually fired)
 *   notificationsCreated ← notificationsCreated
 *   failures             ← failures
 *
 * `due` and `skipped` are intentionally not surfaced: a skip is a due action
 * left PENDING on purpose (claim lost to a concurrent runner, or a deactivated
 * template) and is neither work done nor an error — it simply stays due.
 */
async function processDueSlaEscalationDomain(
  before: Date,
): Promise<DueJobDomainResult> {
  try {
    const result = await processDueSlaEscalations(before);
    return {
      processed: result.triggered,
      notificationsCreated: result.notificationsCreated,
      failures: result.failures,
    };
  } catch {
    return { processed: 0, notificationsCreated: 0, failures: 1 };
  }
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 04 — due outbound delivery execution.
 *
 * `processDueOutboundDeliveries` (notification-delivery module) owns the
 * whole domain: the bounded `FOR UPDATE SKIP LOCKED` due enumeration, the
 * guarded PENDING/RETRY_SCHEDULED → SENDING claim, the adapter send, the
 * immutable attempt-history write, the guarded lifecycle transition, and the
 * operational events. The dispatcher only isolates a batch-level throw so the
 * remaining domains still run.
 */
async function processDueOutboundDeliveryDomain(
  before: Date,
): Promise<DueOutboundDeliveryResult> {
  try {
    return await processDueOutboundDeliveries(before);
  } catch {
    return {
      due: 0,
      sent: 0,
      retryScheduled: 0,
      failedPermanent: 0,
      exhausted: 0,
      skipped: 0,
      failures: 1,
    };
  }
}

/**
 * CR-BE-DOC-CONTROL-01 PART 04 — evidence retention execution.
 *
 * `processDueEvidenceRetention` (evidence-retention-policies module) owns
 * the whole domain: the bounded `FOR UPDATE SKIP LOCKED` due marking, the
 * state-guarded purge (binary disposal through the single storage
 * abstraction + PURGED tombstone — the row is never deleted), hold skips,
 * per-row failure isolation with natural next-tick retry, and the governed
 * operational events. The dispatcher only isolates a batch-level throw so
 * the remaining domains still run.
 */
async function processDueEvidenceRetentionDomain(
  before: Date,
): Promise<DueEvidenceRetentionResult> {
  try {
    return await processDueEvidenceRetention(before);
  } catch {
    return { dueMarked: 0, purged: 0, held: 0, failures: 1 };
  }
}

/**
 * CR-BE-INTEG-01 PART 05 — integration webhook fan-out + delivery execution.
 *
 * `processDueIntegrationWebhookJobs` (integration-webhook-deliveries module)
 * owns the whole domain: the flag gate (dark by default), the atomic
 * per-outbox-row fan-out (claim → matching endpoints → idempotent delivery
 * creation → PROCESSED), the bounded `FOR UPDATE SKIP LOCKED` due
 * enumeration, the guarded claim, the HMAC-signed POST with per-endpoint
 * timeout, the guarded lifecycle transition, and the governed
 * `INTEGRATION_WEBHOOK_*` operational events (recursion-blocked at the
 * outbox enqueue seam). The dispatcher only isolates a batch-level throw so
 * the remaining domains still run.
 */
async function processDueIntegrationWebhookDomain(
  before: Date,
): Promise<DueIntegrationWebhookResult> {
  try {
    return await processDueIntegrationWebhookJobs(before);
  } catch {
    return {
      fannedOut: 0,
      delivered: 0,
      retryScheduled: 0,
      failedPermanent: 0,
      exhausted: 0,
      skipped: 0,
      failures: 1,
    };
  }
}

/**
 * Runs the dispatcher once for items due at or before `before` (default: now).
 *
 * Returns a per-domain summary. Safe to call repeatedly and with an empty due
 * window. This is the seam the PART 04 scheduler invokes on a cadence.
 *
 * ORDER MATTERS (CR-BE-SLA-02 §6.2): SLA escalations run AFTER SLA clocks, so a
 * breach detected in this tick materializes its escalation ledger rows and an
 * `offset_minutes = 0` level fires in the SAME tick instead of waiting a full
 * scheduler interval. Outbound delivery execution (CR-BE-NOTIFY-PROV-01
 * PART 04) is an independent domain and runs last.
 */
export async function processDueOperationalJobs(
  before: Date = new Date(),
): Promise<DueJobDispatchResult> {
  // CR-BE-AUDIT-01 PART 03 — the entire dispatcher pass shares one generated
  // SCHEDULER correlation context. The helper preserves an active HTTP context
  // if a caller explicitly invokes the dispatcher from an HTTP request.
  return runWithSchedulerContext(() => processDueOperationalJobsInContext(before));
}

async function processDueOperationalJobsInContext(
  before: Date,
): Promise<DueJobDispatchResult> {
  const reminders = await processDueReminders(before);
  const escalations = await processDueEscalations(before);
  const slaClocks = await processDueSlaClockDomain(before);
  const slaEscalations = await processDueSlaEscalationDomain(before);
  const outboundDeliveries = await processDueOutboundDeliveryDomain(before);
  const evidenceRetention = await processDueEvidenceRetentionDomain(before);
  const webhookDeliveries = await processDueIntegrationWebhookDomain(before);
  return {
    reminders,
    escalations,
    slaClocks,
    slaEscalations,
    outboundDeliveries,
    evidenceRetention,
    webhookDeliveries,
    executedAt: new Date().toISOString(),
  };
}

export const dueJobDispatcherService = {
  processDueOperationalJobs,
};
