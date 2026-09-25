/**
 * CR-BE-SAAS-01 PART 03 — canonical customer-status projection
 * (frozen §7.2 / §11.2 rule 4).
 *
 * Single source of truth for "given a customer's subscriptions, what is
 * its projected customer status?". Reused by PART 03 lifecycle code
 * AND PART 10 health + dashboard projections so neither PART can drift.
 *
 * Frozen rule (healthy wins):
 *   - any subscription is ACTIVE              → ACTIVE
 *   - else any subscription is TRIAL           → TRIAL
 *   - else any is GRACE or PAST_DUE            → GRACE
 *   - else any subscription is SUSPENDED       → SUSPENDED
 *   - else only DRAFT/PENDING                  → PROSPECT
 *   - else no subscriptions                    → PROSPECT
 *   - else                                     → TERMINATED
 */
import type { SaaSCustomerStorageStatus } from '../platform-customers';

/**
 * Pure projector that takes just the subscription statuses (the only
 * field the canonical rule consumes). Reusable by callers that have
 * a rich record OR a raw status array.
 */
export function projectCustomerStatusFromStatuses(
  statuses: readonly string[],
): SaaSCustomerStorageStatus {
  if (statuses.includes('ACTIVE')) return 'ACTIVE';
  if (statuses.includes('TRIAL')) return 'TRIAL';
  if (statuses.includes('GRACE') || statuses.includes('PAST_DUE'))
    return 'GRACE';
  if (statuses.includes('SUSPENDED')) return 'SUSPENDED';
  if (statuses.includes('DRAFT') || statuses.includes('PENDING'))
    return 'PROSPECT';
  if (statuses.length === 0) return 'PROSPECT';
  return 'TERMINATED';
}
