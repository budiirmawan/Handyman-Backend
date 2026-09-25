import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import type { WorkOrderRecord } from '../work-orders/work-order.types';
import { purchaseRequestRepository } from './purchase-request.repository';
import type {
  NewPurchaseRequest,
  PurchaseRequestRecord,
} from './purchase-request.types';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 00 — Work-Order field procurement parent.
 *
 * Canonical field relation:
 *
 *   Work Order → one Work-Order field Purchase Request → many material_requests
 *
 * The Purchase Request is the procurement HEADER (BE-17A); `material_requests`
 * are its item lines (BE-17B, `purchase_request_id`). A field material request
 * therefore needs exactly one server-owned parent per Work Order, which this
 * helper gets-or-creates. Every fact on the parent is server-derived from the
 * canonical Work Order — nothing is accepted from a client.
 *
 * Invariant / race arbiter: `purchase_requests_work_order_unique`
 * (UNIQUE (work_order_id) WHERE work_order_id IS NOT NULL). Two concurrent
 * callers both attempt the INSERT; the loser's unique violation is caught
 * inside a SAVEPOINT and the committed winner is re-read, so exactly one
 * parent ever exists and no caller sees a duplicate.
 *
 * Out of scope here (later PARTs): reservations, stock issue, usage, mobile
 * routes, permissions. `work_order_procurement_bindings` is untouched — it
 * stays the legacy one-row-per-Work-Order procurement binding.
 */

/**
 * `request_type` is a data-driven code string (BE-17A). `MATERIAL` is the
 * established material-parent code used throughout the material chain
 * (material-requests / reservations / issue-control fixtures); no new type is
 * invented.
 */
export const WORK_ORDER_FIELD_PURCHASE_REQUEST_TYPE = 'MATERIAL';

/** Prefix of the server-generated request number (`WOF_<8 hex>`), following the
 *  existing server-generated number convention (`FND_…`, `UNC_…`). */
export const WORK_ORDER_FIELD_REQUEST_NUMBER_PREFIX = 'WOF_';

const WORK_ORDER_UNIQUE_CONSTRAINT = 'purchase_requests_work_order_unique';
const REQUEST_NUMBER_UNIQUE_CONSTRAINT = 'purchase_request_number_unique';
const MAX_NUMBER_ATTEMPTS = 3;

function generateFieldRequestNumber(): string {
  return `${WORK_ORDER_FIELD_REQUEST_NUMBER_PREFIX}${randomUUID()
    .slice(0, 8)
    .toUpperCase()}`;
}

function buildFieldParentTitle(workOrder: WorkOrderRecord): string {
  return `Work order ${workOrder.workOrderNumber} field material request`;
}

function uniqueViolationConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' ? (candidate.constraint ?? null) : null;
}

async function createFieldParent(
  client: PoolClient,
  workOrder: WorkOrderRecord,
  actorUserId: string,
): Promise<PurchaseRequestRecord> {
  for (let attempt = 1; attempt <= MAX_NUMBER_ATTEMPTS; attempt += 1) {
    const candidate: NewPurchaseRequest = {
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      requestNumber: generateFieldRequestNumber(),
      requesterReference: null,
      requestType: WORK_ORDER_FIELD_PURCHASE_REQUEST_TYPE,
      title: buildFieldParentTitle(workOrder),
      description: null,
      requiredDate: null,
      priority: workOrder.priority,
      requestedByUserId: actorUserId,
      workOrderId: workOrder.id,
    };

    await client.query('SAVEPOINT wo_field_purchase_request');
    try {
      const created = await purchaseRequestRepository.create(candidate, client);
      await client.query('RELEASE SAVEPOINT wo_field_purchase_request');
      return created;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT wo_field_purchase_request');
      const constraint = uniqueViolationConstraint(error);
      if (constraint === WORK_ORDER_UNIQUE_CONSTRAINT) {
        // Race lost: the winner has committed (the unique check waited on it).
        const winner = await purchaseRequestRepository.findByWorkOrderId(
          workOrder.id,
          client,
        );
        if (winner) return winner;
      }
      if (
        constraint === REQUEST_NUMBER_UNIQUE_CONSTRAINT &&
        attempt < MAX_NUMBER_ATTEMPTS
      ) {
        continue; // astronomically rare number collision — regenerate
      }
      throw error;
    }
  }
  /* istanbul ignore next — loop always returns or throws */
  throw new Error('Unable to allocate work order field purchase request number.');
}

/**
 * Returns the single Work-Order field Purchase Request for `workOrder`,
 * creating it (once) when absent. Safe to call repeatedly and concurrently.
 *
 * When `executor` is supplied the work runs on that transaction; otherwise a
 * dedicated transaction is opened.
 */
export async function getOrCreateWorkOrderFieldPurchaseRequest(
  workOrder: WorkOrderRecord,
  actorUserId: string,
  executor: PoolClient | null = null,
): Promise<PurchaseRequestRecord> {
  const existing = await purchaseRequestRepository.findByWorkOrderId(
    workOrder.id,
    executor,
  );
  if (existing) return existing;

  const work = (client: PoolClient) =>
    createFieldParent(client, workOrder, actorUserId);

  return executor ? work(executor) : withTransaction(work);
}
