import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { assertActiveAllowedCurrency } from '../client-monetary-contexts';
import { getRequestId } from '../../shared/request-context';
import { permissionDeniedError } from '../auth';
import { contextAccessService } from '../context-access';
import { permissionService } from '../permissions';
import { recordOperationalEvent } from '../operational-events';
import {
  operationalBudgetNotActiveError,
  operationalBudgetOverspendOverrideNotAllowedError,
  operationalBudgetOverspendRejectedError,
  operationalBudgetPolicyTransitionInvalidError,
  operationalCommitmentActualizationExceedsOpenError,
  operationalCommitmentCancelAfterActualizationError,
  operationalCommitmentCategoryMismatchError,
  operationalCommitmentCurrencyMismatchError,
  operationalCommitmentDecreaseBelowActualizedError,
  operationalCommitmentNotFoundError,
  operationalCommitmentNotOpenError,
} from './operational-commitment.errors';
import { operationalCommitmentRepository } from './operational-commitment.repository';
import type {
  ActualizeOperationalCommitmentInput,
  AdjustOperationalCommitmentInput,
  CloseOperationalCommitmentInput,
  CreateOperationalCommitmentInput,
  OperationalCommitmentEntryRecord,
  OperationalCommitmentFilters,
  OperationalCommitmentRecord,
  PublicOperationalCommitment,
  PublicOperationalCommitmentDetail,
  PublicOperationalCommitmentEntry,
} from './operational-commitment.types';
import { OPEN_OPERATIONAL_COMMITMENT_STATUSES } from './operational-commitment.types';
import { operationalBudgetNotFoundError } from './operational-finance.errors';
import { operationalFinanceRepository } from './operational-finance.repository';
import type {
  OperationalBudgetOverspendPolicy,
  OperationalBudgetRecord,
} from './operational-finance.types';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Operational Commitment service.
 *
 * Governed invariants implemented here:
 *
 *  1. One transaction per financial decision, opened with a
 *     `SELECT ... FOR UPDATE` on the budget row. That row lock is the single
 *     serialization point for a Building's spend, so two concurrent approvals
 *     can never both consume the same remaining budget.
 *  2. Available budget is re-read INSIDE the lock. Anything read before the
 *     lock is discarded.
 *  3. Overspend is rejected by default (`STRICT`). It is possible only when
 *     the budget policy is `ALLOW_WITH_OVERRIDE`, the actor holds
 *     `operational_budget.override`, and an explicit reason is supplied. It is
 *     never silent.
 *  4. Amount changes are append-only ledger entries; the header is derived.
 *  5. Actualization moves value from open to actualized WITHOUT freeing
 *     budget, so an obligation can never be counted twice.
 *  6. Audit events are written on the same executor as the state change; a
 *     rejection is audited best-effort after the rolled-back transaction.
 */

const OVERRIDE_PERMISSION = 'operational_budget.override';

export function toPublicCommitmentRecord(
  record: OperationalCommitmentRecord,
): PublicOperationalCommitment {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    budgetId: record.budgetId,
    budgetCategoryId: record.budgetCategoryId,
    origin: record.origin,
    sourceType: record.sourceType,
    purchaseOrderId: record.purchaseOrderId,
    purchaseOrderLineId: record.purchaseOrderLineId,
    workOrderId: record.workOrderId,
    vendorId: record.vendorId,
    materialRequestId: record.materialRequestId,
    currency: record.currency,
    committedAmount: Number(record.committedAmount),
    actualizedAmount: Number(record.actualizedAmount),
    releasedAmount: Number(record.releasedAmount),
    openAmount: Number(record.openAmount),
    status: record.status,
    title: record.title,
    reason: record.reason,
    overspendOverride:
      record.overspendOverrideReason === null ||
      record.overspendOverrideByUserId === null ||
      record.overspendOverrideAt === null
        ? null
        : {
            reason: record.overspendOverrideReason,
            byUserId: record.overspendOverrideByUserId,
            at: record.overspendOverrideAt.toISOString(),
          },
    idempotencyKey: record.idempotencyKey,
    createdByUserId: record.createdByUserId,
    closedAt: record.closedAt?.toISOString() ?? null,
    closedByUserId: record.closedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicEntry(
  record: OperationalCommitmentEntryRecord,
): PublicOperationalCommitmentEntry {
  return {
    ...record,
    signedAmount: Number(record.signedAmount),
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

/** Money is exchanged with SQL as a fixed 2-decimal string, never a float. */
function money(amount: number): string {
  return amount.toFixed(2);
}

function negative(amount: string): string {
  return amount.startsWith('-') ? amount : `-${amount}`;
}

async function loadBudget(
  budgetId: string,
  actorUserId: string,
): Promise<OperationalBudgetRecord> {
  const budget = await operationalFinanceRepository.findBudgetById(budgetId);
  if (!budget) throw operationalBudgetNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, budget.buildingId);
  return budget;
}

async function loadCommitment(
  commitmentId: string,
  actorUserId: string,
): Promise<OperationalCommitmentRecord> {
  const commitment = await operationalCommitmentRepository.findById(commitmentId);
  if (!commitment) throw operationalCommitmentNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    commitment.buildingId,
  );
  return commitment;
}

async function assertOverrideAuthority(actorUserId: string): Promise<void> {
  const permissions = await permissionService.resolvePermissionsForUser(
    actorUserId,
  );
  if (!permissions.includes(OVERRIDE_PERMISSION)) throw permissionDeniedError();
}

type OverspendDecision = {
  overrideReason: string | null;
  probe: Awaited<
    ReturnType<typeof operationalCommitmentRepository.probeConsumption>
  >;
};

/**
 * Evaluates the locked availability of a requested amount and returns the
 * override provenance to persist, or throws. The caller has already taken the
 * budget row lock, so this decision cannot race another approval.
 */
export async function decideCommitmentOverspend(options: {
  executor: Parameters<typeof operationalCommitmentRepository.probeConsumption>[0];
  budgetId: string;
  budgetCategoryId: string;
  requestedAmount: string;
  excludeCommitmentId: string | null;
  policy: OperationalBudgetOverspendPolicy;
  overrideReason: string | null | undefined;
  actorUserId: string;
}): Promise<OverspendDecision> {
  const probe = await operationalCommitmentRepository.probeConsumption(
    options.executor,
    options.budgetId,
    options.budgetCategoryId,
    options.requestedAmount,
    options.excludeCommitmentId,
  );

  const withinCategory = probe.categoryAllowed;
  const withinBudget = probe.budgetAllowed;
  if (withinCategory && withinBudget) {
    return { overrideReason: null, probe };
  }

  const scope = withinCategory ? 'BUDGET' : 'CATEGORY';
  const reason = options.overrideReason?.trim();

  if (options.policy !== 'ALLOW_WITH_OVERRIDE') {
    // A STRICT budget cannot be overridden at all — not even by an actor who
    // holds the override permission.
    if (reason) throw operationalBudgetOverspendOverrideNotAllowedError();
    throw operationalBudgetOverspendRejectedError({
      scope,
      plannedAmount:
        scope === 'CATEGORY'
          ? probe.categoryPlannedAmount
          : probe.budgetPlannedAmount,
      consumedAmount:
        scope === 'CATEGORY'
          ? probe.categoryConsumedAmount
          : probe.budgetConsumedAmount,
      availableAmount:
        scope === 'CATEGORY'
          ? probe.categoryAvailableAmount
          : probe.budgetAvailableAmount,
      requestedAmount: options.requestedAmount,
    });
  }

  // ALLOW_WITH_OVERRIDE still rejects unless the caller explicitly overrides
  // AND holds the separate override authority.
  if (!reason) {
    throw operationalBudgetOverspendRejectedError({
      scope,
      plannedAmount:
        scope === 'CATEGORY'
          ? probe.categoryPlannedAmount
          : probe.budgetPlannedAmount,
      consumedAmount:
        scope === 'CATEGORY'
          ? probe.categoryConsumedAmount
          : probe.budgetConsumedAmount,
      availableAmount:
        scope === 'CATEGORY'
          ? probe.categoryAvailableAmount
          : probe.budgetAvailableAmount,
      requestedAmount: options.requestedAmount,
    });
  }

  await assertOverrideAuthority(options.actorUserId);
  return { overrideReason: reason, probe };
}

/** Best-effort rejection audit; the causing transaction has rolled back. */
async function auditOverspendRejection(
  budget: OperationalBudgetRecord,
  actorUserId: string,
  requestedAmount: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await recordOperationalEvent({
      clientId: budget.clientId,
      buildingId: budget.buildingId,
      eventType: 'OPERATIONAL_BUDGET_OVERSPEND_REJECTED',
      entityType: 'OPERATIONAL_BUDGET',
      entityId: budget.id,
      actorUserId,
      summary: 'A commitment was rejected because it exceeds available budget.',
      metadata: { requestedAmount, ...context },
    });
  } catch {
    // Audit of a rejected attempt must never mask the rejection itself.
  }
}

export async function createOperationalCommitment(
  budgetId: string,
  input: CreateOperationalCommitmentInput,
  actorUserId: string,
): Promise<PublicOperationalCommitment> {
  const budget = await loadBudget(budgetId, actorUserId);

  try {
    return await withTransaction(async (client) => {
      const locked = await operationalCommitmentRepository.lockBudgetForCommitment(
        client,
        budgetId,
      );
      if (!locked) throw operationalBudgetNotFoundError();

      // Idempotent replay: the same key on the same budget resolves to the
      // already-created commitment and writes nothing.
      const existing = await operationalCommitmentRepository.findByIdempotencyKey(
        client,
        budgetId,
        input.idempotencyKey,
      );
      if (existing) return toPublicCommitmentRecord(existing);

      if (locked.status !== 'ACTIVE') {
        throw operationalBudgetNotActiveError(locked.status);
      }
      await assertActiveAllowedCurrency(locked.clientId, input.currency);
      if (input.currency !== locked.currency) {
        throw operationalCommitmentCurrencyMismatchError();
      }

      const category = await operationalCommitmentRepository.findCategory(
        client,
        input.budgetCategoryId,
      );
      if (!category || category.budgetId !== budgetId) {
        throw operationalCommitmentCategoryMismatchError();
      }

      const amount = money(input.amount);
      const decision = await decideCommitmentOverspend({
        executor: client,
        budgetId,
        budgetCategoryId: input.budgetCategoryId,
        requestedAmount: amount,
        excludeCommitmentId: null,
        policy: locked.overspendPolicy,
        overrideReason: input.overspendOverrideReason,
        actorUserId,
      });

      const commitment = await operationalCommitmentRepository.insertCommitment(
        client,
        {
          clientId: locked.clientId,
          buildingId: locked.buildingId,
          budgetId,
          budgetCategoryId: input.budgetCategoryId,
          currency: locked.currency,
          amount,
          title: input.title,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          workOrderId: input.workOrderId ?? null,
          vendorId: input.vendorId ?? null,
          materialRequestId: input.materialRequestId ?? null,
          overspendOverrideReason: decision.overrideReason,
          actorUserId,
          origin: 'MANUAL',
          purchaseOrderLineId: null,
        },
      );

      await operationalCommitmentRepository.insertEntry(client, {
        commitmentId: commitment.id,
        entryType: 'CREATE',
        signedAmount: commitment.committedAmount,
        currency: commitment.currency,
        sourceBindingId: null,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        actorUserId,
        requestId: getRequestId() ?? null,
      });

      await recordOperationalEvent(
        {
          clientId: commitment.clientId,
          buildingId: commitment.buildingId,
          eventType: 'OPERATIONAL_COMMITMENT_CREATED',
          entityType: 'OPERATIONAL_COMMITMENT',
          entityId: commitment.id,
          actorUserId,
          summary: 'Operational Commitment created.',
          metadata: {
            budgetId,
            budgetCategoryId: commitment.budgetCategoryId,
            origin: commitment.origin,
            currency: commitment.currency,
            committedAmount: commitment.committedAmount,
            availableBeforeAmount: decision.probe.categoryAvailableAmount,
          },
        },
        client,
      );

      if (decision.overrideReason) {
        await operationalCommitmentRepository.insertEntry(client, {
          commitmentId: commitment.id,
          entryType: 'OVERRIDE',
          signedAmount: '0',
          currency: commitment.currency,
          sourceBindingId: null,
          idempotencyKey: `${input.idempotencyKey}:OVERRIDE`,
          reason: decision.overrideReason,
          actorUserId,
          requestId: getRequestId() ?? null,
        });
        await recordOperationalEvent(
          {
            clientId: commitment.clientId,
            buildingId: commitment.buildingId,
            eventType: 'OPERATIONAL_BUDGET_OVERSPEND_OVERRIDDEN',
            entityType: 'OPERATIONAL_BUDGET',
            entityId: budgetId,
            actorUserId,
            summary: 'An overspending commitment was explicitly overridden.',
            metadata: {
              commitmentId: commitment.id,
              requestedAmount: amount,
              categoryAvailableAmount: decision.probe.categoryAvailableAmount,
              budgetAvailableAmount: decision.probe.budgetAvailableAmount,
              overrideReason: decision.overrideReason,
            },
          },
          client,
        );
      }

      return toPublicCommitmentRecord(commitment);
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'OPERATIONAL_BUDGET_OVERSPEND_REJECTED'
    ) {
      await auditOverspendRejection(budget, actorUserId, money(input.amount), {
        budgetCategoryId: input.budgetCategoryId,
        operation: 'CREATE',
      });
    }
    throw error;
  }
}

export async function getOperationalCommitment(
  commitmentId: string,
  actorUserId: string,
): Promise<PublicOperationalCommitmentDetail> {
  const commitment = await loadCommitment(commitmentId, actorUserId);
  const entries = await operationalCommitmentRepository.listEntries(commitmentId);
  return {
    ...toPublicCommitmentRecord(commitment),
    entries: entries.map(toPublicEntry),
  };
}

export async function listOperationalCommitments(
  budgetId: string,
  filters: OperationalCommitmentFilters,
  actorUserId: string,
): Promise<PublicOperationalCommitment[]> {
  await loadBudget(budgetId, actorUserId);
  return (
    await operationalCommitmentRepository.listCommitments(budgetId, filters)
  ).map(toPublicCommitmentRecord);
}

type MutationKind = 'INCREASE' | 'DECREASE' | 'RELEASE' | 'CANCEL';

async function mutateCommitment(
  commitmentId: string,
  actorUserId: string,
  kind: MutationKind,
  input: {
    amount?: number;
    reason: string;
    idempotencyKey: string;
    overspendOverrideReason?: string | null;
  },
): Promise<PublicOperationalCommitment> {
  const current = await loadCommitment(commitmentId, actorUserId);
  const budget = await loadBudget(current.budgetId, actorUserId);

  try {
    return await withTransaction(async (client) => {
      // Fixed lock order: budget row first, then the commitment row.
      const locked = await operationalCommitmentRepository.lockBudgetForCommitment(
        client,
        current.budgetId,
      );
      if (!locked) throw operationalBudgetNotFoundError();

      const commitment = await operationalCommitmentRepository.lockCommitment(
        client,
        commitmentId,
      );
      if (!commitment) throw operationalCommitmentNotFoundError();

      // Idempotent replay of the same transition writes nothing.
      const replay =
        await operationalCommitmentRepository.findEntryByIdempotencyKey(
          client,
          commitmentId,
          input.idempotencyKey,
        );
      if (replay) return toPublicCommitmentRecord(commitment);

      if (!OPEN_OPERATIONAL_COMMITMENT_STATUSES.includes(commitment.status)) {
        throw operationalCommitmentNotOpenError(commitment.status);
      }

      let updated: OperationalCommitmentRecord;
      let entryType: 'ADJUST_INCREASE' | 'ADJUST_DECREASE' | 'RELEASE' | 'CANCEL';
      let signedAmount: string;
      let overrideReason: string | null = null;
      let eventType: string;
      let summary: string;

      if (kind === 'INCREASE') {
        const amount = money(input.amount!);
        const decision = await decideCommitmentOverspend({
          executor: client,
          budgetId: commitment.budgetId,
          budgetCategoryId: commitment.budgetCategoryId,
          requestedAmount: amount,
          excludeCommitmentId: null,
          policy: locked.overspendPolicy,
          overrideReason: input.overspendOverrideReason,
          actorUserId,
        });
        overrideReason = decision.overrideReason;
        entryType = 'ADJUST_INCREASE';
        signedAmount = amount;
        updated = await operationalCommitmentRepository.applyAmounts(
          client,
          commitmentId,
          { committedDelta: amount },
          { closedByUserId: null },
        );
        eventType = 'OPERATIONAL_COMMITMENT_ADJUSTED';
        summary = 'Operational Commitment increased.';
      } else if (kind === 'DECREASE') {
        const amount = money(input.amount!);
        const check = await client.query<{ allowed: boolean }>(
          `SELECT (committed_amount - $2::numeric >= actualized_amount)
                  AND (committed_amount - $2::numeric > 0) AS allowed
             FROM operational_commitments WHERE id = $1`,
          [commitmentId, amount],
        );
        if (!check.rows[0]?.allowed) {
          throw operationalCommitmentDecreaseBelowActualizedError();
        }
        entryType = 'ADJUST_DECREASE';
        signedAmount = negative(amount);
        updated = await operationalCommitmentRepository.applyAmounts(
          client,
          commitmentId,
          { committedDelta: negative(amount) },
          { closedByUserId: null },
        );
        eventType = 'OPERATIONAL_COMMITMENT_ADJUSTED';
        summary = 'Operational Commitment decreased.';
      } else if (kind === 'RELEASE') {
        // Release always frees exactly the remaining open amount; the
        // commitment becomes terminal.
        const remainder = commitment.openAmount;
        entryType = 'RELEASE';
        signedAmount = negative(remainder);
        updated = await operationalCommitmentRepository.applyAmounts(
          client,
          commitmentId,
          { releasedDelta: remainder },
          { closedByUserId: actorUserId },
        );
        eventType = 'OPERATIONAL_COMMITMENT_RELEASED';
        summary = 'Operational Commitment remainder released.';
      } else {
        const cancellable = await client.query<{ allowed: boolean }>(
          `SELECT (actualized_amount = 0) AS allowed
             FROM operational_commitments WHERE id = $1`,
          [commitmentId],
        );
        if (!cancellable.rows[0]?.allowed) {
          throw operationalCommitmentCancelAfterActualizationError();
        }
        entryType = 'CANCEL';
        signedAmount = negative(commitment.committedAmount);
        updated = await operationalCommitmentRepository.markCancelled(
          client,
          commitmentId,
          actorUserId,
        );
        eventType = 'OPERATIONAL_COMMITMENT_CANCELLED';
        summary = 'Operational Commitment cancelled.';
      }

      await operationalCommitmentRepository.insertEntry(client, {
        commitmentId,
        entryType,
        signedAmount,
        currency: commitment.currency,
        sourceBindingId: null,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        actorUserId,
        requestId: getRequestId() ?? null,
      });

      await recordOperationalEvent(
        {
          clientId: updated.clientId,
          buildingId: updated.buildingId,
          eventType,
          entityType: 'OPERATIONAL_COMMITMENT',
          entityId: commitmentId,
          actorUserId,
          summary,
          metadata: {
            budgetId: updated.budgetId,
            budgetCategoryId: updated.budgetCategoryId,
            signedAmount,
            committedAmount: updated.committedAmount,
            actualizedAmount: updated.actualizedAmount,
            releasedAmount: updated.releasedAmount,
            openAmount: updated.openAmount,
            status: updated.status,
            reason: input.reason,
          },
        },
        client,
      );

      if (overrideReason) {
        await operationalCommitmentRepository.insertEntry(client, {
          commitmentId,
          entryType: 'OVERRIDE',
          signedAmount: '0',
          currency: commitment.currency,
          sourceBindingId: null,
          idempotencyKey: `${input.idempotencyKey}:OVERRIDE`,
          reason: overrideReason,
          actorUserId,
          requestId: getRequestId() ?? null,
        });
        await recordOperationalEvent(
          {
            clientId: updated.clientId,
            buildingId: updated.buildingId,
            eventType: 'OPERATIONAL_BUDGET_OVERSPEND_OVERRIDDEN',
            entityType: 'OPERATIONAL_BUDGET',
            entityId: updated.budgetId,
            actorUserId,
            summary: 'An overspending commitment increase was explicitly overridden.',
            metadata: { commitmentId, overrideReason },
          },
          client,
        );
      }

      return toPublicCommitmentRecord(updated);
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'OPERATIONAL_BUDGET_OVERSPEND_REJECTED'
    ) {
      await auditOverspendRejection(
        budget,
        actorUserId,
        money(input.amount ?? 0),
        { commitmentId, operation: kind },
      );
    }
    throw error;
  }
}

export const adjustOperationalCommitment = (
  commitmentId: string,
  input: AdjustOperationalCommitmentInput,
  actorUserId: string,
): Promise<PublicOperationalCommitment> =>
  mutateCommitment(
    commitmentId,
    actorUserId,
    input.amount >= 0 ? 'INCREASE' : 'DECREASE',
    {
      amount: Math.abs(input.amount),
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      overspendOverrideReason: input.overspendOverrideReason,
    },
  );

export const releaseOperationalCommitment = (
  commitmentId: string,
  input: CloseOperationalCommitmentInput,
  actorUserId: string,
): Promise<PublicOperationalCommitment> =>
  mutateCommitment(commitmentId, actorUserId, 'RELEASE', input);

export const cancelOperationalCommitment = (
  commitmentId: string,
  input: CloseOperationalCommitmentInput,
  actorUserId: string,
): Promise<PublicOperationalCommitment> =>
  mutateCommitment(commitmentId, actorUserId, 'CANCEL', input);

/**
 * PART 02 internal actualization primitive — the seam PART 03/04 call from
 * inside their own source transaction. It is deliberately NOT exposed over
 * HTTP: actual cost is recognised by an authoritative source transaction, not
 * by an arbitrary financial mutation endpoint.
 *
 * Actualization reduces `open_amount` and raises `actualized_amount` by the
 * same value, so the budget stays consumed and the obligation can never be
 * counted twice.
 */
/**
 * Applies one actualization to an OPEN commitment on the caller's executor.
 *
 * Shared by the standalone primitive below and by the PART 03 material seam,
 * so both paths obey exactly the same rules: idempotent replay, open-amount
 * ceiling, status recomputation, ledger entry, lineage link and audit event.
 *
 * Actualization moves value from `open_amount` to `actualized_amount`; it does
 * NOT reduce the budget consumption of the commitment, so the same obligation
 * can never be counted twice.
 */
export async function applyCommitmentActualization(
  client: Pick<PoolClient, 'query'>,
  commitmentId: string,
  input: ActualizeOperationalCommitmentInput,
): Promise<PublicOperationalCommitment> {
  const commitment = await operationalCommitmentRepository.lockCommitment(
    client,
    commitmentId,
  );
  if (!commitment) throw operationalCommitmentNotFoundError();

  const replay = await operationalCommitmentRepository.findEntryByIdempotencyKey(
    client,
    commitmentId,
    input.idempotencyKey,
  );
  if (replay) return toPublicCommitmentRecord(commitment);

  if (!OPEN_OPERATIONAL_COMMITMENT_STATUSES.includes(commitment.status)) {
    throw operationalCommitmentNotOpenError(commitment.status);
  }

  const amount = money(input.amount);
  const check = await client.query<{ allowed: boolean }>(
    `SELECT ($2::numeric > 0 AND $2::numeric <= open_amount) AS allowed
       FROM operational_commitments WHERE id = $1`,
    [commitmentId, amount],
  );
  if (!check.rows[0]?.allowed) {
    throw operationalCommitmentActualizationExceedsOpenError();
  }

  const fully = await client.query<{ full: boolean }>(
    `SELECT (actualized_amount + $2::numeric = committed_amount) AS full
       FROM operational_commitments WHERE id = $1`,
    [commitmentId, amount],
  );

  const updated = await operationalCommitmentRepository.applyAmounts(
    client,
    commitmentId,
    { actualizedDelta: amount },
    { closedByUserId: fully.rows[0]?.full ? input.actorUserId : null },
  );

  await operationalCommitmentRepository.insertEntry(client, {
    commitmentId,
    entryType: 'ACTUALIZE',
    signedAmount: negative(amount),
    currency: commitment.currency,
    sourceBindingId: input.sourceBindingId ?? null,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason ?? null,
    actorUserId: input.actorUserId,
    requestId: getRequestId() ?? null,
  });

  await recordOperationalEvent(
    {
      clientId: updated.clientId,
      buildingId: updated.buildingId,
      eventType: 'OPERATIONAL_COMMITMENT_ACTUALIZED',
      entityType: 'OPERATIONAL_COMMITMENT',
      entityId: commitmentId,
      actorUserId: input.actorUserId,
      summary:
        updated.status === 'ACTUALIZED'
          ? 'Operational Commitment fully actualized.'
          : 'Operational Commitment partially actualized.',
      metadata: {
        budgetId: updated.budgetId,
        budgetCategoryId: updated.budgetCategoryId,
        actualizedAmount: updated.actualizedAmount,
        openAmount: updated.openAmount,
        status: updated.status,
        sourceBindingId: input.sourceBindingId ?? null,
      },
    },
    client,
  );

  return toPublicCommitmentRecord(updated);
}

/**
 * CR-BE-COMM-VAR-01 PART 04 — governed actualization reversal.
 *
 * Reverses the still-effective actualized amount contributed by ONE lineage
 * row, and only when an authoritative source state justifies it (today: an
 * invoice that left its verified/finalized state). It is an append-only
 * `ACTUALIZE_REVERSAL` entry — the original actualization is never edited or
 * deleted — and it reopens a commitment that had been closed by that
 * actualization.
 *
 * A RELEASED or CANCELLED commitment is deliberately NOT reversible: its
 * remainder has already been given back to the budget, so reopening it would
 * resurrect an obligation the organisation has formally abandoned.
 */
export async function reverseCommitmentActualization(
  client: Pick<PoolClient, 'query'>,
  commitmentId: string,
  input: {
    sourceBindingId: string;
    reason: string;
    idempotencyKey: string;
    actorUserId: string;
  },
): Promise<PublicOperationalCommitment | null> {
  const commitment = await operationalCommitmentRepository.lockCommitment(
    client,
    commitmentId,
  );
  if (!commitment) throw operationalCommitmentNotFoundError();

  const replay = await operationalCommitmentRepository.findEntryByIdempotencyKey(
    client,
    commitmentId,
    input.idempotencyKey,
  );
  if (replay) return toPublicCommitmentRecord(commitment);

  if (
    commitment.status !== 'ACTUALIZED' &&
    commitment.status !== 'PARTIALLY_ACTUALIZED'
  ) {
    throw operationalCommitmentNotOpenError(commitment.status);
  }

  const amount = await operationalCommitmentRepository.actualizedAmountForBinding(
    client,
    commitmentId,
    input.sourceBindingId,
  );
  if (Number(amount) <= 0) return null;

  const updated = await operationalCommitmentRepository.applyAmounts(
    client,
    commitmentId,
    { actualizedDelta: negative(amount) },
    { closedByUserId: null, reopen: true },
  );

  await operationalCommitmentRepository.insertEntry(client, {
    commitmentId,
    entryType: 'ACTUALIZE_REVERSAL',
    signedAmount: amount,
    currency: commitment.currency,
    sourceBindingId: input.sourceBindingId,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    actorUserId: input.actorUserId,
    requestId: getRequestId() ?? null,
  });

  await recordOperationalEvent(
    {
      clientId: updated.clientId,
      buildingId: updated.buildingId,
      eventType: 'OPERATIONAL_COMMITMENT_ACTUALIZATION_REVERSED',
      entityType: 'OPERATIONAL_COMMITMENT',
      entityId: commitmentId,
      actorUserId: input.actorUserId,
      summary: 'Operational Commitment actualization reversed.',
      metadata: {
        budgetId: updated.budgetId,
        reversedAmount: amount,
        actualizedAmount: updated.actualizedAmount,
        openAmount: updated.openAmount,
        status: updated.status,
        sourceBindingId: input.sourceBindingId,
        reason: input.reason,
      },
    },
    client,
  );

  return toPublicCommitmentRecord(updated);
}

/**
 * PART 02 internal actualization primitive — the seam PART 03/04 call from
 * inside their own source transaction. It is deliberately NOT exposed over
 * HTTP: actual cost is recognised by an authoritative source transaction, not
 * by an arbitrary financial mutation endpoint.
 */
export async function actualizeOperationalCommitment(
  commitmentId: string,
  input: ActualizeOperationalCommitmentInput,
): Promise<PublicOperationalCommitment> {
  return withTransaction((client) =>
    applyCommitmentActualization(client, commitmentId, input),
  );
}

/**
 * Narrowly scoped overspend-policy transition for a DRAFT or ACTIVE budget.
 *
 * PART 01 could only change the policy through the DRAFT-only budget PATCH,
 * which left an ACTIVE budget unable to authorise an override. This seam is
 * deliberately separate, requires the override authority itself, and is
 * audited with the existing PART 01 policy event.
 */
export async function changeOperationalBudgetOverspendPolicy(
  budgetId: string,
  input: { overspendPolicy: OperationalBudgetOverspendPolicy; reason: string },
  actorUserId: string,
): Promise<{ budgetId: string; overspendPolicy: OperationalBudgetOverspendPolicy }> {
  const budget = await loadBudget(budgetId, actorUserId);
  await assertOverrideAuthority(actorUserId);

  return withTransaction(async (client) => {
    const locked = await operationalCommitmentRepository.lockBudgetForCommitment(
      client,
      budgetId,
    );
    if (!locked) throw operationalBudgetNotFoundError();
    if (locked.status !== 'DRAFT' && locked.status !== 'ACTIVE') {
      throw operationalBudgetPolicyTransitionInvalidError(locked.status);
    }

    if (locked.overspendPolicy === input.overspendPolicy) {
      return { budgetId, overspendPolicy: locked.overspendPolicy };
    }

    await client.query(
      `UPDATE operational_budgets
          SET overspend_policy = $2, updated_at = NOW()
        WHERE id = $1`,
      [budgetId, input.overspendPolicy],
    );

    await recordOperationalEvent(
      {
        clientId: budget.clientId,
        buildingId: budget.buildingId,
        eventType: 'OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED',
        entityType: 'OPERATIONAL_BUDGET',
        entityId: budgetId,
        actorUserId,
        summary: `Operational Budget overspend policy changed to ${input.overspendPolicy}.`,
        metadata: {
          fromOverspendPolicy: locked.overspendPolicy,
          toOverspendPolicy: input.overspendPolicy,
          budgetStatus: locked.status,
          reason: input.reason,
        },
      },
      client,
    );

    return { budgetId, overspendPolicy: input.overspendPolicy };
  });
}

export const operationalCommitmentService = {
  actualizeOperationalCommitment,
  applyCommitmentActualization,
  reverseCommitmentActualization,
  adjustOperationalCommitment,
  cancelOperationalCommitment,
  changeOperationalBudgetOverspendPolicy,
  createOperationalCommitment,
  getOperationalCommitment,
  listOperationalCommitments,
  releaseOperationalCommitment,
};
