import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { purchaseOrderRepository } from '../purchase-orders';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorRepository } from '../vendors';
import {
  workContractAlreadyExistsForPoError,
  workContractContextInvalidError,
  workContractNotDraftError,
  workContractNotFoundError,
  workContractNumberExistsError,
  workContractPurchaseOrderInvalidError,
  workContractPurchaseOrderNotIssuedError,
  workContractTransitionInvalidError,
  workContractVendorInvalidError,
} from './work-contract.errors';
import { workContractRepository } from './work-contract.repository';
import type {
  CreateWorkContractInput,
  NewWorkContract,
  PublicWorkContract,
  UpdateWorkContractInput,
  WorkContractAvailableActions,
  WorkContractFilters,
  WorkContractRecord,
  WorkContractStatus,
} from './work-contract.types';
import { canTransitionWorkContractStatus } from './work-contract.types';

function toPublic(record: WorkContractRecord): PublicWorkContract {
  return {
    ...record,
    activatedAt: record.activatedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== '23505'
  ) {
    return false;
  }
  if (!constraint) return true;
  return (
    'constraint' in error &&
    typeof error.constraint === 'string' &&
    error.constraint === constraint
  );
}

/**
 * Loads a Work Contract and asserts BE-02G Building access for the actor.
 * Every by-id read/command funnels through here, so tenant/client isolation
 * is enforced once rather than per handler.
 */
async function loadAccessible(
  id: string,
  actorUserId: string,
): Promise<WorkContractRecord> {
  const record = await workContractRepository.findById(id);
  if (!record) throw workContractNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    record.buildingId,
  );
  return record;
}

/**
 * Frozen decision — the SPK inherits its whole scope from the Purchase Order.
 *
 * Resolves the referenced PO and derives Client, Building and Vendor from it.
 * The caller supplies only `purchaseOrderId`, so it cannot widen its own
 * scope or point a mandate at a vendor that was never committed.
 *
 * The PO must be ISSUED: a DRAFT commitment is not yet a mandate to execute.
 * PO issuance itself is PART 03 and is only READ here, never written.
 */
async function resolveMandateContext(
  purchaseOrderId: string,
  actorUserId: string,
): Promise<{ clientId: string; buildingId: string; vendorId: string }> {
  const purchaseOrder = await purchaseOrderRepository.findById(
    purchaseOrderId,
  );
  if (!purchaseOrder) throw workContractPurchaseOrderInvalidError();

  // Isolation before any further disclosure.
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    purchaseOrder.buildingId,
  );

  if (purchaseOrder.status !== 'ISSUED') {
    throw workContractPurchaseOrderNotIssuedError(purchaseOrder.status);
  }

  // The PO guarantees these structurally; defend against drift anyway.
  if (
    !purchaseOrder.clientId ||
    !purchaseOrder.buildingId ||
    !purchaseOrder.vendorId
  ) {
    throw workContractContextInvalidError();
  }

  return {
    clientId: purchaseOrder.clientId,
    buildingId: purchaseOrder.buildingId,
    vendorId: purchaseOrder.vendorId,
  };
}

/**
 * Confirms the inherited Vendor is still ACTIVE and still holds an ACTIVE
 * relationship to the mandate's Building. The PO was issued at a point in
 * time; a Vendor may have been deactivated since.
 */
async function isVendorUsable(
  vendorId: string,
  clientId: string,
  buildingId: string,
): Promise<boolean> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor || vendor.status !== 'ACTIVE' || vendor.clientId !== clientId) {
    return false;
  }

  const relationship =
    await vendorBuildingRepository.findActiveByVendorAndBuilding(
      vendorId,
      buildingId,
    );
  return relationship !== null;
}

async function assertVendorUsable(
  vendorId: string,
  clientId: string,
  buildingId: string,
): Promise<void> {
  if (!(await isVendorUsable(vendorId, clientId, buildingId))) {
    throw workContractVendorInvalidError();
  }
}

/**
 * Raises an SPK against an ISSUED Purchase Order.
 *
 * The SPK is created as DRAFT. It records the execution mandate only: no
 * quantity, no amount ledger, no readiness verdict, and no Work Order
 * linkage (PART 05).
 */
export async function createWorkContract(
  input: CreateWorkContractInput,
  actorUserId: string,
): Promise<PublicWorkContract> {
  const context = await resolveMandateContext(
    input.purchaseOrderId,
    actorUserId,
  );

  await assertVendorUsable(
    context.vendorId,
    context.clientId,
    context.buildingId,
  );

  // At most one live SPK per Purchase Order (fail fast; the partial unique
  // index is the ultimate authority).
  const existing = await workContractRepository.findLiveByPurchaseOrder(
    input.purchaseOrderId,
  );
  if (existing) throw workContractAlreadyExistsForPoError();

  const newWorkContract: NewWorkContract = {
    clientId: context.clientId,
    buildingId: context.buildingId,
    vendorId: context.vendorId,
    purchaseOrderId: input.purchaseOrderId,
    spkNumber: input.spkNumber,
    spkDate: input.spkDate,
    title: input.title,
    scopeDescription: input.scopeDescription?.trim() || null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    notes: input.notes?.trim() || null,
    status: 'DRAFT',
    createdByUserId: actorUserId,
  };

  let record: WorkContractRecord;
  try {
    record = await workContractRepository.create(newWorkContract);
  } catch (error) {
    if (isUniqueViolation(error, 'work_contracts_po_live_unique')) {
      throw workContractAlreadyExistsForPoError();
    }
    if (isUniqueViolation(error)) throw workContractNumberExistsError();
    throw error;
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'WORK_CONTRACT_CREATED',
    entityType: 'WORK_CONTRACT',
    entityId: record.id,
    actorUserId,
    summary: `Work Contract (SPK) ${record.spkNumber} created as draft.`,
    metadata: {
      vendorId: record.vendorId,
      purchaseOrderId: record.purchaseOrderId,
      status: record.status,
      spkDate: record.spkDate,
    },
  });

  return toPublic(record);
}

export async function getWorkContract(
  id: string,
  actorUserId: string,
): Promise<PublicWorkContract> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listWorkContracts(
  filters: WorkContractFilters,
  actorUserId: string,
): Promise<PublicWorkContract[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds =
    await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const records = await workContractRepository.list(filters, buildingIds);
  return records.map(toPublic);
}

/**
 * CR-BE-R2P-CONTRACT-01 PART 01 — backend-authoritative SPK actions.
 *
 * Mirrors the existing transition table and command preconditions only. The
 * action endpoint requires read permission; an actor without the existing
 * `work_contract.manage` permission receives an empty action list.
 */
export async function resolveWorkContractAvailableActions(
  id: string,
  actorUserId: string,
): Promise<WorkContractAvailableActions> {
  const workContract = await loadAccessible(id, actorUserId);
  const permissions =
    await permissionService.resolvePermissionsForUser(actorUserId);
  const availableActions: WorkContractAvailableActions['availableActions'] =
    [];

  if (permissions.includes('work_contract.manage')) {
    if (
      workContract.status === 'DRAFT' &&
      (await isVendorUsable(
        workContract.vendorId,
        workContract.clientId,
        workContract.buildingId,
      ))
    ) {
      availableActions.push('ACTIVATE');
    }
    if (workContract.status === 'ACTIVE') {
      availableActions.push('COMPLETE');
    }
    if (
      workContract.status === 'DRAFT' ||
      workContract.status === 'ACTIVE'
    ) {
      availableActions.push('CANCEL');
    }
  }

  return {
    workContractId: workContract.id,
    state: workContract.status,
    availableActions,
  };
}

/**
 * Updates a DRAFT Work Contract. Identity, the PO reference and the inherited
 * scope are immutable (enforced in validation); only mandate detail may change
 * before the SPK is activated.
 */
export async function updateWorkContract(
  id: string,
  input: UpdateWorkContractInput,
  actorUserId: string,
): Promise<PublicWorkContract> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status !== 'DRAFT') throw workContractNotDraftError();

  const updated = await workContractRepository.update(id, input, actorUserId);
  if (!updated) throw workContractNotDraftError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    eventType: 'WORK_CONTRACT_UPDATED',
    entityType: 'WORK_CONTRACT',
    entityId: updated.id,
    actorUserId,
    summary: `Work Contract (SPK) ${updated.spkNumber} updated.`,
    metadata: { status: updated.status, fields: Object.keys(input) },
  });

  return toPublic(updated);
}

/**
 * Shared lifecycle driver for the deterministic transition table
 * (DRAFT → ACTIVE → COMPLETED / CANCELLED).
 *
 * The transition is validated against `WORK_CONTRACT_TRANSITIONS` and then
 * applied with the source status in the UPDATE's WHERE clause, so an invalid
 * or repeated command cannot mutate anything.
 */
async function applyTransition(
  id: string,
  to: Exclude<WorkContractStatus, 'DRAFT'>,
  actorUserId: string,
  eventType: string,
  summarize: (record: WorkContractRecord) => string,
): Promise<PublicWorkContract> {
  const current = await loadAccessible(id, actorUserId);
  if (!canTransitionWorkContractStatus(current.status, to)) {
    throw workContractTransitionInvalidError(current.status, to);
  }

  // Activation puts the mandate in force, so the vendor must still be usable
  // at that moment. Completion and cancellation are wind-down transitions and
  // must stay possible even if the vendor has since been deactivated.
  if (to === 'ACTIVE') {
    await assertVendorUsable(
      current.vendorId,
      current.clientId,
      current.buildingId,
    );
  }

  const updated = await workContractRepository.transition(
    id,
    current.status,
    to,
    actorUserId,
  );
  // Lost the race: another command moved the contract first.
  if (!updated) throw workContractTransitionInvalidError(current.status, to);

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    eventType,
    entityType: 'WORK_CONTRACT',
    entityId: updated.id,
    actorUserId,
    summary: summarize(updated),
    metadata: {
      vendorId: updated.vendorId,
      purchaseOrderId: updated.purchaseOrderId,
      status: updated.status,
      previousStatus: current.status,
    },
  });

  return toPublic(updated);
}

/** DRAFT → ACTIVE. The mandate comes into force and becomes immutable. */
export async function activateWorkContract(
  id: string,
  actorUserId: string,
): Promise<PublicWorkContract> {
  return applyTransition(
    id,
    'ACTIVE',
    actorUserId,
    'WORK_CONTRACT_ACTIVATED',
    (record) => `Work Contract (SPK) ${record.spkNumber} activated.`,
  );
}

/** ACTIVE → COMPLETED. Terminal; releases the Purchase Order. */
export async function completeWorkContract(
  id: string,
  actorUserId: string,
): Promise<PublicWorkContract> {
  return applyTransition(
    id,
    'COMPLETED',
    actorUserId,
    'WORK_CONTRACT_COMPLETED',
    (record) => `Work Contract (SPK) ${record.spkNumber} completed.`,
  );
}

/** DRAFT | ACTIVE → CANCELLED. Terminal; releases the Purchase Order. */
export async function cancelWorkContract(
  id: string,
  actorUserId: string,
): Promise<PublicWorkContract> {
  return applyTransition(
    id,
    'CANCELLED',
    actorUserId,
    'WORK_CONTRACT_CANCELLED',
    (record) => `Work Contract (SPK) ${record.spkNumber} cancelled.`,
  );
}

export const workContractService = {
  activateWorkContract,
  cancelWorkContract,
  completeWorkContract,
  createWorkContract,
  getWorkContract,
  listWorkContracts,
  resolveWorkContractAvailableActions,
  updateWorkContract,
};
