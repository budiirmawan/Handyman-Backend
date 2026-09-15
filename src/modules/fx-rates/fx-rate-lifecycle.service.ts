import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database';
import { getRequestId } from '../../shared/request-context';
import {
  fxRateCurrencyInactiveOrUnknownError,
  fxRateInvalidStatusTransitionError,
  fxRateNotFoundError,
  fxRateSelfApprovalError,
} from './fx-rate.errors';
import {
  currencyMasterRepository,
  fxRateEventRepository,
  fxRateRepository,
} from './fx-rate.repository';
import { validateEffectiveWindow, validateRateLiteral } from './fx-rate.validation';
import type { FxRate, FxRateEventType } from './fx-rate.types';

/**
 * CR-BE-FX-01 PART 02 — governed FX Rate lifecycle.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §4, §5, §13, §14.1, §15, §18.
 *
 * Frozen rules this module exists to enforce:
 *
 *  - CANONICAL CONVENTION: `1 BASE = RATE x QUOTE`. Nothing here reinterprets,
 *    rescales or converts a rate value.
 *  - A stored rate is NEVER modified. Correction is a NEW rate plus exact
 *    supersession linkage, in one transaction.
 *  - Lifecycle: PENDING_APPROVAL -> ACTIVE | REJECTED; ACTIVE -> SUPERSEDED |
 *    INACTIVE; REJECTED / SUPERSEDED / INACTIVE are terminal. Every illegal
 *    transition fails closed.
 *  - MAKER-CHECKER: approval requires an approver who is not the maker. The
 *    PART 01 `fx_rates_maker_checker_check` constraint is the structural
 *    backstop; this service reports it first with an actionable message.
 *  - ACTIVE WINDOW: activation respects the PART 01 GiST exclusion. This module
 *    never shortens another rate, never silently supersedes another rate, never
 *    selects a latest rate, and never rewrites a window. A conflict fails closed.
 *  - AUDIT: every transition emits exactly one append-only `fx_rate_events` row
 *    inside the SAME transaction as the state change, so a transition can never
 *    be recorded without its audit row or vice versa.
 *
 * There is NO conversion here. PART 03 owns the single governed conversion
 * authority; PART 02 only governs which rate may exist and be ACTIVE.
 */

/** Correction payload for supersession. The currency pair is never changed. */
export type SupersedeFxRateInput = {
  /** New rate value. Omitted only for a window-only correction, which reuses the exact stored value. */
  rate?: string | number;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  sourceReference?: string | null;
};

export type CreateFxRateInput = {
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  rate: string | number;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  source: 'MANUAL_TREASURY';
  sourceReference?: string | null;
};

export type FxRateLifecycleResult = {
  rate: FxRate;
  /** The successor, when this command produced one (supersession). */
  successor?: FxRate;
  eventTypes: FxRateEventType[];
};

function eventMetadata(rate: FxRate, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseCurrencyCode: rate.baseCurrencyCode,
    quoteCurrencyCode: rate.quoteCurrencyCode,
    rateType: rate.rateType,
    // Copied, not re-read: the ledger must describe the rate as it stood.
    rate: rate.rate,
    convention: '1 BASE = RATE x QUOTE',
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
    source: rate.source,
    ...(rate.sourceReference ? { sourceReference: rate.sourceReference } : {}),
    status: rate.status,
    ...extra,
  };
}

/** Both legs must be ACTIVE in the existing Currency Master. Never duplicated. */
async function assertActiveCurrencyLegs(baseCurrencyCode: string, quoteCurrencyCode: string): Promise<void> {
  const inactive = await currencyMasterRepository.findInactive([baseCurrencyCode, quoteCurrencyCode]);
  if (inactive.length > 0) {
    throw fxRateCurrencyInactiveOrUnknownError(inactive[0]!);
  }
}

export const fxRateLifecycleService = {
  /**
   * Proposes a rate. It lands in `PENDING_APPROVAL` and cannot be used by any
   * consumer until a different authorized user approves it.
   */
  async createRate(input: CreateFxRateInput, actorUserId: string): Promise<FxRateLifecycleResult> {
    const id = randomUUID();
    const requestId = getRequestId();

    const rate = await withTransaction(async (tx) => {
      await assertActiveCurrencyLegs(input.baseCurrencyCode, input.quoteCurrencyCode);
      const created = await fxRateRepository.insert(
        {
          id,
          baseCurrencyCode: input.baseCurrencyCode,
          quoteCurrencyCode: input.quoteCurrencyCode,
          rate: String(input.rate),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          source: input.source,
          sourceReference: input.sourceReference ?? null,
          createdByUserId: actorUserId,
        },
        tx,
      );
      await fxRateEventRepository.append(
        {
          fxRateId: created.id,
          eventType: 'FX_RATE_CREATED',
          actorUserId,
          requestId,
          metadata: eventMetadata(created, { createdByUserId: actorUserId }),
        },
        tx,
      );
      return created;
    });

    return { rate, eventTypes: ['FX_RATE_CREATED'] };
  },

  /**
   * Activates a proposed rate. Maker-checker: the approver must not be the maker.
   *
   * If another ACTIVE rate already covers part of this window the GiST exclusion
   * rejects the update and the caller receives `FX_RATE_ACTIVE_WINDOW_CONFLICT`.
   * Nothing is silently shortened, superseded or window-rewritten.
   */
  async approveRate(rateId: string, actorUserId: string): Promise<FxRateLifecycleResult> {
    const requestId = getRequestId();

    const rate = await withTransaction(async (tx) => {
      const current = await fxRateRepository.findByIdWith(tx, rateId);
      if (!current) throw fxRateNotFoundError(rateId);
      if (current.status !== 'PENDING_APPROVAL') {
        throw fxRateInvalidStatusTransitionError(current.status, 'ACTIVE');
      }
      if (current.createdByUserId === actorUserId) {
        throw fxRateSelfApprovalError(rateId);
      }

      const approved = await fxRateRepository.transition(
        { rateId, expectedStatus: 'PENDING_APPROVAL', nextStatus: 'ACTIVE', actorUserId },
        tx,
      );
      if (!approved) throw fxRateInvalidStatusTransitionError('PENDING_APPROVAL', 'ACTIVE');

      await fxRateEventRepository.append(
        {
          fxRateId: approved.id,
          eventType: 'FX_RATE_APPROVED',
          actorUserId,
          requestId,
          metadata: eventMetadata(approved, {
            createdByUserId: approved.createdByUserId,
            approvedByUserId: actorUserId,
            approvedAt: approved.approvedAt,
            lifecycleAction: 'ACTIVATE',
          }),
        },
        tx,
      );
      return approved;
    });

    return { rate, eventTypes: ['FX_RATE_APPROVED'] };
  },

  /**
   * Rejects a proposal. Rejection is terminal.
   *
   * Authorization comes from `fx_rate.approve` at the route; the actor is
   * recorded and an audit row is written. Maker-checker does NOT apply here: the
   * PART 01 schema froze segregation for `approved_by_user_id` only, and no
   * additional DB-level segregation is invented.
   */
  async rejectRate(
    rateId: string,
    actorUserId: string,
    reason?: string | null,
  ): Promise<FxRateLifecycleResult> {
    const requestId = getRequestId();

    const rate = await withTransaction(async (tx) => {
      const current = await fxRateRepository.findByIdWith(tx, rateId);
      if (!current) throw fxRateNotFoundError(rateId);
      if (current.status !== 'PENDING_APPROVAL') {
        throw fxRateInvalidStatusTransitionError(current.status, 'REJECTED');
      }

      const rejected = await fxRateRepository.transition(
        {
          rateId,
          expectedStatus: 'PENDING_APPROVAL',
          nextStatus: 'REJECTED',
          actorUserId,
          reason: reason ?? null,
        },
        tx,
      );
      if (!rejected) throw fxRateInvalidStatusTransitionError('PENDING_APPROVAL', 'REJECTED');

      await fxRateEventRepository.append(
        {
          fxRateId: rejected.id,
          eventType: 'FX_RATE_REJECTED',
          actorUserId,
          requestId,
          metadata: eventMetadata(rejected, {
            createdByUserId: rejected.createdByUserId,
            rejectedByUserId: actorUserId,
            rejectedAt: rejected.rejectedAt,
            ...(rejected.rejectedReason ? { rejectedReason: rejected.rejectedReason } : {}),
            lifecycleAction: 'REJECT',
          }),
        },
        tx,
      );
      return rejected;
    });

    return { rate, eventTypes: ['FX_RATE_REJECTED'] };
  },

  /**
   * Corrects an ACTIVE rate. This is the ONLY sanctioned way to change a rate.
   *
   * One transaction, exact linkage in both directions:
   *   successor.supersedes_rate_id  = incumbent.id
   *   incumbent.superseded_by_rate_id = successor.id
   *
   * Ordering matters: the incumbent is moved to `SUPERSEDED` BEFORE the ACTIVE
   * successor is inserted, because the GiST exclusion is not deferrable. If the
   * successor cannot be inserted (for example it would overlap a DIFFERENT
   * ACTIVE rate) the whole transaction rolls back and the incumbent stays
   * ACTIVE — fail closed, never half-superseded.
   *
   * The currency pair is inherited and cannot be changed: supersession corrects
   * a rate, it does not mint a new pair. The incumbent's stored rate value is
   * never mutated; a window-only correction copies it exactly.
   *
   * Maker-checker is enforced by the existing `fx_rates_maker_checker_check`:
   * the successor is authored by the incumbent's maker and approved by the
   * superseding actor, so the two must differ. That is reuse of a PART 01
   * invariant, not a new segregation rule.
   */
  async supersedeRate(
    rateId: string,
    input: SupersedeFxRateInput,
    actorUserId: string,
  ): Promise<FxRateLifecycleResult> {
    const requestId = getRequestId();
    const successorId = randomUUID();

    const { incumbent, successor } = await withTransaction(async (tx) => {
      const current = await fxRateRepository.findByIdWith(tx, rateId);
      if (!current) throw fxRateNotFoundError(rateId);
      if (current.status !== 'ACTIVE') {
        throw fxRateInvalidStatusTransitionError(current.status, 'SUPERSEDED');
      }
      // Reuses the PART 01 maker-checker invariant rather than inventing one.
      if (current.createdByUserId === actorUserId) {
        throw fxRateSelfApprovalError(rateId);
      }

      const window = validateEffectiveWindow(input.effectiveFrom, input.effectiveTo);
      // A window-only correction reuses the incumbent's exact stored decimal.
      const rate =
        input.rate === undefined || input.rate === null
          ? current.rate
          : validateRateLiteral(input.rate);

      // 1. Move the incumbent out of ACTIVE first (GiST exclusion is not deferrable).
      const superseded = await fxRateRepository.transition(
        { rateId, expectedStatus: 'ACTIVE', nextStatus: 'SUPERSEDED', actorUserId },
        tx,
      );
      if (!superseded) throw fxRateInvalidStatusTransitionError('ACTIVE', 'SUPERSEDED');

      // 2. Insert the ACTIVE successor, born approved and linked.
      const created = await fxRateRepository.insertActiveSuccessor(
        {
          id: successorId,
          baseCurrencyCode: current.baseCurrencyCode,
          quoteCurrencyCode: current.quoteCurrencyCode,
          rate,
          effectiveFrom: window.effectiveFrom,
          effectiveTo: window.effectiveTo,
          source: current.source,
          sourceReference: input.sourceReference ?? current.sourceReference,
          supersedesRateId: current.id,
          createdByUserId: current.createdByUserId,
          approvedByUserId: actorUserId,
        },
        tx,
      );

      // 3. Close the reverse link. Both directions are now exact.
      const linked = await fxRateRepository.setSuccessor(current.id, created.id, tx);
      if (!linked) throw fxRateInvalidStatusTransitionError('ACTIVE', 'SUPERSEDED');

      await fxRateEventRepository.append(
        {
          fxRateId: created.id,
          eventType: 'FX_RATE_CREATED',
          actorUserId,
          requestId,
          metadata: eventMetadata(created, {
            createdVia: 'SUPERSESSION',
            supersedesRateId: current.id,
            createdByUserId: created.createdByUserId,
            approvedByUserId: actorUserId,
          }),
        },
        tx,
      );
      await fxRateEventRepository.append(
        {
          fxRateId: linked.id,
          eventType: 'FX_RATE_SUPERSEDED',
          actorUserId,
          requestId,
          metadata: eventMetadata(linked, {
            supersededByRateId: created.id,
            supersededByUserId: actorUserId,
            supersededAt: linked.supersededAt,
            lifecycleAction: 'SUPERSEDE',
            previousRate: current.rate,
          }),
        },
        tx,
      );

      return { incumbent: linked, successor: created };
    });

    return { rate: incumbent, successor, eventTypes: ['FX_RATE_CREATED', 'FX_RATE_SUPERSEDED'] };
  },

  /**
   * Withdraws an ACTIVE rate with no replacement. Terminal.
   *
   * Authorization comes from `fx_rate.approve`; the actor is recorded and an
   * audit row is written. No maker-checker (see `rejectRate`).
   */
  async deactivateRate(
    rateId: string,
    actorUserId: string,
    reason?: string | null,
  ): Promise<FxRateLifecycleResult> {
    const requestId = getRequestId();

    const rate = await withTransaction(async (tx) => {
      const current = await fxRateRepository.findByIdWith(tx, rateId);
      if (!current) throw fxRateNotFoundError(rateId);
      if (current.status !== 'ACTIVE') {
        throw fxRateInvalidStatusTransitionError(current.status, 'INACTIVE');
      }

      const deactivated = await fxRateRepository.transition(
        {
          rateId,
          expectedStatus: 'ACTIVE',
          nextStatus: 'INACTIVE',
          actorUserId,
          reason: reason ?? null,
        },
        tx,
      );
      if (!deactivated) throw fxRateInvalidStatusTransitionError('ACTIVE', 'INACTIVE');

      await fxRateEventRepository.append(
        {
          fxRateId: deactivated.id,
          eventType: 'FX_RATE_DEACTIVATED',
          actorUserId,
          requestId,
          metadata: eventMetadata(deactivated, {
            createdByUserId: deactivated.createdByUserId,
            deactivatedByUserId: actorUserId,
            deactivatedAt: deactivated.deactivatedAt,
            ...(deactivated.deactivationReason
              ? { deactivationReason: deactivated.deactivationReason }
              : {}),
            lifecycleAction: 'DEACTIVATE',
          }),
        },
        tx,
      );
      return deactivated;
    });

    return { rate, eventTypes: ['FX_RATE_DEACTIVATED'] };
  },
};
