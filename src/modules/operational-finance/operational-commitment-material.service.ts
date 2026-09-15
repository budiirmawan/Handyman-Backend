import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { logger } from '../../shared/logger';
import { getRequestId } from '../../shared/request-context';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  operationalBudgetNotActiveError,
  operationalCommitmentCategoryMismatchError,
  operationalCommitmentCurrencyMismatchError,
  operationalCommitmentNotFoundError,
  operationalCommitmentSourceAlreadyCommittedError,
  operationalCommitmentSourceNotEligibleError,
} from './operational-commitment.errors';
import { operationalCommitmentRepository } from './operational-commitment.repository';
import {
  applyCommitmentActualization,
  decideCommitmentOverspend,
  toPublicCommitmentRecord,
} from './operational-commitment.service';
import type {
  CreatePoLineCommitmentInput,
  PublicOperationalCommitment,
} from './operational-commitment.types';
import { operationalBudgetNotFoundError } from './operational-finance.errors';
import { operationalFinanceRepository } from './operational-finance.repository';

/**
 * CR-BE-COMM-VAR-01 PART 03 — Material commitment / actual integration.
 *
 * Governed mapping (nothing else may create a material commitment):
 *
 *   Material Request (quantity, NO price)  -> no commitment
 *   Reservation (quantity)                 -> no commitment
 *   ISSUED Purchase Order line (priced)    -> COMMITMENT
 *   Receiving (no price)                   -> nothing
 *   WO material usage total_cost           -> ACTUAL
 *
 * The material engine is untouched: reservation, issue, balance and movement
 * logic are unchanged, and the actualization seam can never fail a material
 * issue (it runs inside a SAVEPOINT and is rolled back on any problem).
 */

function money(amount: string): string {
  return amount;
}

/**
 * Raises the commitment for one priced, ISSUED Purchase Order line.
 *
 * The amount, currency, scope, vendor and Material Request lineage are all
 * DERIVED from the authoritative PO line — the caller supplies only the budget
 * category (never inferred, per the governed cost-category rule) and an
 * idempotency key. PO issuance itself is deliberately untouched: procurement
 * must not start failing because a budget is exhausted.
 */
export async function createPurchaseOrderLineCommitment(
  budgetId: string,
  input: CreatePoLineCommitmentInput,
  actorUserId: string,
): Promise<PublicOperationalCommitment> {
  const budget = await operationalFinanceRepository.findBudgetById(budgetId);
  if (!budget) throw operationalBudgetNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, budget.buildingId);

  return withTransaction(async (client) => {
    const locked = await operationalCommitmentRepository.lockBudgetForCommitment(
      client,
      budgetId,
    );
    if (!locked) throw operationalBudgetNotFoundError();

    const existing = await operationalCommitmentRepository.findByIdempotencyKey(
      client,
      budgetId,
      input.idempotencyKey,
    );
    if (existing) return toPublicCommitmentRecord(existing);

    if (locked.status !== 'ACTIVE') {
      throw operationalBudgetNotActiveError(locked.status);
    }

    const line = await operationalCommitmentRepository.findIssuedPurchaseOrderLine(
      client,
      input.purchaseOrderLineId,
    );
    if (!line) throw operationalCommitmentNotFoundError();

    // Only an ISSUED Purchase Order is an approved obligation. A DRAFT
    // commitment-to-be is not a mandate, and a CANCELLED one never will be.
    if (line.purchaseOrderStatus !== 'ISSUED') {
      throw operationalCommitmentSourceNotEligibleError(
        `purchase order status is ${line.purchaseOrderStatus}`,
      );
    }
    if (line.buildingId !== locked.buildingId) {
      throw operationalCommitmentSourceNotEligibleError(
        'the purchase order line belongs to another Building',
      );
    }
    if (line.currency !== locked.currency) {
      throw operationalCommitmentCurrencyMismatchError();
    }

    const category = await operationalCommitmentRepository.findCategory(
      client,
      input.budgetCategoryId,
    );
    if (!category || category.budgetId !== budgetId) {
      throw operationalCommitmentCategoryMismatchError();
    }

    // Mutual exclusion with the legacy CR-BE-FIN-01 read-time commitment:
    // a PO represented by an active source binding must not also enter the
    // ledger, or the same obligation would be counted twice.
    if (
      await operationalCommitmentRepository.hasLegacyPurchaseOrderBinding(
        client,
        line.purchaseOrderId,
        line.id,
      )
    ) {
      throw operationalCommitmentSourceAlreadyCommittedError(
        'this purchase order is already represented by an operational budget source binding',
      );
    }

    const amount = money(line.lineAmount);
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

    let commitment;
    try {
      commitment = await operationalCommitmentRepository.insertCommitment(client, {
        clientId: locked.clientId,
        buildingId: locked.buildingId,
        budgetId,
        budgetCategoryId: input.budgetCategoryId,
        currency: locked.currency,
        amount,
        title: line.description.slice(0, 160),
        reason: null,
        idempotencyKey: input.idempotencyKey,
        workOrderId: null,
        vendorId: line.vendorId,
        materialRequestId: line.materialRequestId,
        overspendOverrideReason: decision.overrideReason,
        actorUserId,
        origin: 'PO_LINE',
        purchaseOrderLineId: line.id,
      });
    } catch (error) {
      // The partial unique index reserves a PO line for one live commitment.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw operationalCommitmentSourceAlreadyCommittedError(
          'this purchase order line already has a live commitment',
        );
      }
      throw error;
    }

    await operationalCommitmentRepository.insertEntry(client, {
      commitmentId: commitment.id,
      entryType: 'CREATE',
      signedAmount: commitment.committedAmount,
      currency: commitment.currency,
      sourceBindingId: null,
      idempotencyKey: input.idempotencyKey,
      reason: null,
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
        summary: 'Operational Commitment created from an issued purchase order line.',
        metadata: {
          budgetId,
          budgetCategoryId: commitment.budgetCategoryId,
          origin: commitment.origin,
          purchaseOrderId: line.purchaseOrderId,
          purchaseOrderLineId: line.id,
          materialRequestId: line.materialRequestId,
          vendorId: line.vendorId,
          committedAmount: commitment.committedAmount,
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
          summary: 'An overspending purchase order line commitment was overridden.',
          metadata: {
            commitmentId: commitment.id,
            purchaseOrderLineId: line.id,
            overrideReason: decision.overrideReason,
          },
        },
        client,
      );
    }

    return toPublicCommitmentRecord(commitment);
  });
}

export type MaterialUsageActualizationInput = {
  usageId: string;
  /** Governing date (`used_at`), used for the budget-period rule. */
  usedOn: string;
  buildingId: string;
  clientId: string;
  workOrderId: string;
  materialRequestId: string | null;
  totalCost: string | null;
  currency: string | null;
  actorUserId: string;
};

export type MaterialUsageActualizationOutcome =
  | { outcome: 'NO_COST' }
  | { outcome: 'NO_COMMITMENT' }
  | { outcome: 'AMBIGUOUS'; candidateCount: number }
  | { outcome: 'CURRENCY_MISMATCH' }
  | {
      outcome: 'ACTUALIZED';
      commitmentId: string;
      appliedAmount: string;
      uncommittedRemainder: string;
    };

function minimumAmount(left: string, right: string): string {
  return Number(left) <= Number(right) ? left : right;
}

/**
 * PART 03 material actualization seam, executed INSIDE the caller's material
 * issue transaction.
 *
 * Behaviour is deliberately fail-closed and non-blocking:
 *
 *  - no cost on the usage        -> nothing happens (no fabricated actual);
 *  - no matching commitment      -> the usage is an uncommitted actual and is
 *                                   picked up by the budget consumption term;
 *  - more than one candidate     -> nothing is actualized, an ambiguity event
 *                                   is recorded, and no guess is made;
 *  - currency mismatch           -> nothing is actualized (no conversion);
 *  - one candidate               -> min(usage cost, open amount) is actualized
 *                                   idempotently through the shared primitive,
 *                                   with the CR-BE-FIN-01 lineage row linked to
 *                                   the ledger entry. Any excess stays an
 *                                   uncommitted actual — it never creates a
 *                                   second commitment.
 */
export async function actualizeWorkOrderMaterialUsage(
  client: Pick<PoolClient, 'query'>,
  input: MaterialUsageActualizationInput,
): Promise<MaterialUsageActualizationOutcome> {
  if (input.totalCost === null || Number(input.totalCost) <= 0) {
    return { outcome: 'NO_COST' };
  }
  if (!input.materialRequestId) return { outcome: 'NO_COMMITMENT' };

  const candidates =
    await operationalCommitmentRepository.findMaterialCommitmentCandidates(
      client,
      input.materialRequestId,
      input.buildingId,
      input.usedOn,
    );

  if (candidates.length === 0) return { outcome: 'NO_COMMITMENT' };

  if (candidates.length > 1) {
    await recordOperationalEvent(
      {
        clientId: input.clientId,
        buildingId: input.buildingId,
        eventType: 'OPERATIONAL_COMMITMENT_MATERIAL_LINEAGE_AMBIGUOUS',
        entityType: 'WORK_ORDER_MATERIAL_USAGE',
        entityId: input.usageId,
        actorUserId: input.actorUserId,
        summary:
          'Material cost was not actualized: more than one open commitment matches the Material Request.',
        metadata: {
          workOrderId: input.workOrderId,
          materialRequestId: input.materialRequestId,
          candidateCommitmentIds: candidates.map((candidate) => candidate.id),
          totalCost: input.totalCost,
        },
      },
      client,
    );
    return { outcome: 'AMBIGUOUS', candidateCount: candidates.length };
  }

  const candidate = candidates[0];
  if (input.currency === null || input.currency !== candidate.currency) {
    await recordOperationalEvent(
      {
        clientId: input.clientId,
        buildingId: input.buildingId,
        eventType: 'OPERATIONAL_COMMITMENT_MATERIAL_CURRENCY_MISMATCH',
        entityType: 'WORK_ORDER_MATERIAL_USAGE',
        entityId: input.usageId,
        actorUserId: input.actorUserId,
        summary:
          'Material cost was not actualized: its currency does not match the commitment currency.',
        metadata: {
          commitmentId: candidate.id,
          usageCurrency: input.currency,
          commitmentCurrency: candidate.currency,
        },
      },
      client,
    );
    return { outcome: 'CURRENCY_MISMATCH' };
  }

  const applied = minimumAmount(input.totalCost, candidate.openAmount);
  const binding = await operationalCommitmentRepository.ensureMaterialUsageBinding(
    client,
    {
      budgetId: candidate.budgetId,
      budgetCategoryId: candidate.budgetCategoryId,
      clientId: candidate.clientId,
      buildingId: candidate.buildingId,
      workOrderMaterialUsageId: input.usageId,
      createdByUserId: input.actorUserId,
    },
  );

  await applyCommitmentActualization(client, candidate.id, {
    amount: Number(applied),
    sourceBindingId: binding.id,
    reason: `Work Order material usage ${input.usageId}`,
    // One usage can actualize a commitment exactly once; the entry key and the
    // (commitment, source binding) unique index both enforce it.
    idempotencyKey: `WO_MATERIAL_USAGE:${input.usageId}`,
    actorUserId: input.actorUserId,
  });

  return {
    outcome: 'ACTUALIZED',
    commitmentId: candidate.id,
    appliedAmount: applied,
    uncommittedRemainder: (Number(input.totalCost) - Number(applied)).toFixed(2),
  };
}

/**
 * Non-blocking wrapper used by the material engine. The whole seam runs in a
 * SAVEPOINT so a finance-side failure can never roll back — or reject — an
 * authorised material issue. Physical material movement is an operational
 * safety concern and is never gated by budget.
 */
export async function tryActualizeWorkOrderMaterialUsage(
  client: Pick<PoolClient, 'query'>,
  input: MaterialUsageActualizationInput,
): Promise<MaterialUsageActualizationOutcome | { outcome: 'FAILED' }> {
  await client.query('SAVEPOINT operational_commitment_material');
  try {
    const outcome = await actualizeWorkOrderMaterialUsage(client, input);
    await client.query('RELEASE SAVEPOINT operational_commitment_material');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT operational_commitment_material');
    await client
      .query('RELEASE SAVEPOINT operational_commitment_material')
      .catch(() => undefined);
    logger.warn('Work Order material cost could not be actualized', {
      operation: 'operational_commitment.material_actualization_failed',
      resourceType: 'WORK_ORDER_MATERIAL_USAGE',
      resourceId: input.usageId,
      buildingId: input.buildingId,
      errorMessage: error instanceof Error ? error.message : 'unknown error',
    });
    return { outcome: 'FAILED' };
  }
}

export const operationalCommitmentMaterialService = {
  actualizeWorkOrderMaterialUsage,
  createPurchaseOrderLineCommitment,
  tryActualizeWorkOrderMaterialUsage,
};
