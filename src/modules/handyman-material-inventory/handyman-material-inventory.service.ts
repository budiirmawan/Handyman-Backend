import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { inventoryItemNotFoundError } from '../inventory-items';
import { inventoryWarehouseNotFoundError } from '../inventory-warehouses';
import { materialReservationInsufficientStockError } from '../inventory-material-reservations/inventory-material-reservation.errors';
import { inventoryMaterialReservationRepository } from '../inventory-material-reservations/inventory-material-reservation.repository';
import type { HandymanMaterialReservationRecord } from '../inventory-material-reservations/inventory-material-reservation.types';
import { inventoryStockMovementService } from '../inventory-stock-movements';
import {
  handymanMaterialDemandNotFoundError,
} from '../handyman-material-demands/handyman-material-demand.errors';
import { handymanMaterialDemandRepository } from '../handyman-material-demands/handyman-material-demand.repository';
import type { HandymanMaterialDemandRecord } from '../handyman-material-demands/handyman-material-demand.types';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanMaterialInventoryActualUseExceededError,
  handymanMaterialInventoryDemandExceededError,
  handymanMaterialInventoryDemandNotExecutableError,
  handymanMaterialInventoryExecutionContextInvalidError,
  handymanMaterialInventoryIdempotencyConflictError,
  handymanMaterialInventoryIdempotencyKeyRequiredError,
  handymanMaterialInventoryIssueContextInvalidError,
  handymanMaterialInventoryIssueExceededError,
  handymanMaterialInventoryIssueNotFoundError,
  handymanMaterialInventoryReservationAllocationExceededError,
  handymanMaterialInventoryReservationMismatchError,
  handymanMaterialInventoryReservationNotActiveError,
  handymanMaterialInventoryReservationNotFoundError,
  handymanMaterialInventoryReturnExceededError,
  handymanMaterialInventoryUomIncompatibleError,
  handymanMaterialInventoryWorkOrderStateInvalidError,
} from './handyman-material-inventory.errors';
import { handymanMaterialInventoryRepository } from './handyman-material-inventory.repository';
import type {
  CancelHandymanMaterialReservationInput,
  HandymanMaterialActualUsageResult,
  HandymanMaterialControlledIssueRecord,
  HandymanMaterialControlledIssueResult,
  HandymanMaterialReservationCommandResult,
  HandymanMaterialReturnResult,
  HandymanMaterialUsageKind,
  IssueHandymanProviderStockInput,
  PublicHandymanMaterialActualUsage,
  PublicHandymanMaterialControlledIssue,
  PublicHandymanMaterialReservation,
  PublicHandymanMaterialReturn,
  RecordHandymanMaterialActualUsageInput,
  ReleaseHandymanMaterialReservationInput,
  ReserveHandymanMaterialDemandInput,
  ReturnUnusedHandymanProviderStockInput,
} from './handyman-material-inventory.types';

type Executor = Pick<PoolClient, 'query'>;

type DemandContext = {
  clientId: string;
  buildingId: string;
  handymanJobId: string;
  handymanRequestId: string;
  workOrderId: string;
  workOrderStatus: string;
};

type ProviderInventorySubject = {
  warehouseId: string;
  itemId: string;
  uomId: string;
};

type ExecutionContext = {
  handymanServiceVisitId: string | null;
  handymanWorkSessionId: string | null;
};

/**
 * CR-HM-BE-07 RUN 2 — thin Handyman ↔ inventory integration.
 *
 * Inventory authority remains deliberately singular:
 * - reservation rows and balance `reserved_quantity` remain in the existing
 *   `inventory_material_reservations` / `inventory_stock_balances` family;
 * - physical quantity changes remain only in `inventory_stock_movements`;
 * - this module adds only source links and append-only field facts.
 *
 * Deterministic lock order is intentionally short and compatible with the
 * existing procurement family:
 *
 *   reserve:  Handyman demand → stock balance
 *   release:  Handyman demand → reservation → stock balance
 *   issue:    Handyman demand → reservation (if supplied) → stock balance
 *   use:      originating controlled issue (Provider) OR demand (customer)
 *   return:   originating controlled issue → stock balance
 *
 * We do not lock visits, sessions, vendor work, or work orders here. They are
 * read-only contextual assertions, so no third BE-05 cross-family lock order
 * is introduced. A session is optional: pre-staged issue is valid, while a
 * supplied visit/session must be coherent with the job.
 */

function validation(field: string, message: string): never {
  throw AppError.validation('Request validation failed.', [{ field, message }]);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    return validation(field, `${field} must be a valid UUID.`);
  }
  return value.trim().toLowerCase();
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireUuid(value, field);
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw handymanMaterialInventoryIdempotencyKeyRequiredError();
  }
  const key = value.trim();
  if (key.length === 0 || key.length > 200) {
    throw handymanMaterialInventoryIdempotencyKeyRequiredError();
  }
  return key;
}

function parsePositiveQuantity(value: unknown): { canonical: string; value: number } {
  const raw =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : ''
      : typeof value === 'string'
        ? value.trim()
        : '';
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(raw);
  if (!match) {
    return validation(
      'quantity',
      'Quantity must be a positive decimal with at most 4 fraction digits.',
    );
  }
  const integer = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  const numeric = Number(canonical);
  if (canonical === '0' || integer.length > 14 || !Number.isFinite(numeric)) {
    return validation(
      'quantity',
      'Quantity must be greater than zero and fit the material quantity precision.',
    );
  }
  return { canonical, value: numeric };
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    return validation(field, `${field} must be an ISO-8601 timestamp.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return validation(field, `${field} must be an ISO-8601 timestamp.`);
  }
  return date;
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return validation(field, `${field} must be a string.`);
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > maxLength) {
    return validation(field, `${field} must be at most ${maxLength} characters.`);
  }
  return text;
}

function fingerprint(command: string, facts: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ command, ...facts }))
    .digest('hex');
}

function assertFingerprint(stored: string, expected: string): void {
  if (stored !== expected) throw handymanMaterialInventoryIdempotencyConflictError();
}

async function lockIdempotencyKey(
  tx: Executor,
  namespace: string,
  clientId: string,
  key: string,
): Promise<void> {
  // Same advisory-lock idiom as the existing Handyman commands. The table
  // unique indexes remain the cross-process structural backstop.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    `${namespace}:${clientId}`,
    key,
  ]);
}

async function assertBuildingAccess(
  actorUserId: string,
  buildingId: string,
): Promise<void> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
}

function toPublicReservation(
  record: HandymanMaterialReservationRecord,
): PublicHandymanMaterialReservation {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    sourceType: record.sourceType,
    handymanMaterialDemandId: record.handymanMaterialDemandId,
    warehouseId: record.warehouseId,
    itemId: record.itemId,
    uomId: record.uomId,
    reservedQuantity: record.reservedQuantity,
    consumedQuantity: record.consumedQuantity,
    remainingQuantity: record.remainingQuantity,
    status: record.status,
    createdByUserId: record.createdByUserId,
    releasedByUserId: record.releasedByUserId,
    cancelledByUserId: record.cancelledByUserId,
    consumedByUserId: record.consumedByUserId,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    releasedAt: record.releasedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    consumedAt: record.consumedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicIssue(
  record: HandymanMaterialControlledIssueRecord,
): PublicHandymanMaterialControlledIssue {
  const {
    idempotencyKey: _idempotencyKey,
    idempotencyFingerprint: _idempotencyFingerprint,
    issuedAt,
    createdAt,
    ...publicFields
  } = record;
  return {
    ...publicFields,
    issuedAt: issuedAt.toISOString(),
    createdAt: createdAt.toISOString(),
  };
}

function toPublicActualUsage(
  record: Awaited<ReturnType<typeof handymanMaterialInventoryRepository.createActualUsage>>,
): PublicHandymanMaterialActualUsage {
  const {
    idempotencyKey: _idempotencyKey,
    idempotencyFingerprint: _idempotencyFingerprint,
    usedAt,
    createdAt,
    ...publicFields
  } = record;
  return {
    ...publicFields,
    usedAt: usedAt.toISOString(),
    createdAt: createdAt.toISOString(),
  };
}

function toPublicReturn(
  record: Awaited<ReturnType<typeof handymanMaterialInventoryRepository.createReturn>>,
): PublicHandymanMaterialReturn {
  const {
    idempotencyKey: _idempotencyKey,
    idempotencyFingerprint: _idempotencyFingerprint,
    returnedAt,
    createdAt,
    ...publicFields
  } = record;
  return {
    ...publicFields,
    returnedAt: returnedAt.toISOString(),
    createdAt: createdAt.toISOString(),
  };
}

/** Resolve the immutable job/request/work-order chain from authoritative rows. */
async function requireDemandContext(
  demand: HandymanMaterialDemandRecord,
  executor: Executor,
): Promise<DemandContext> {
  const result = await executor.query<{
    clientId: string;
    buildingId: string;
    handymanJobId: string;
    handymanRequestId: string;
    workOrderId: string;
    workOrderStatus: string;
  }>(
    `SELECT
       j.client_id AS "clientId",
       r.building_id AS "buildingId",
       j.id AS "handymanJobId",
       j.handyman_request_id AS "handymanRequestId",
       w.id AS "workOrderId",
       w.status AS "workOrderStatus"
     FROM handyman_jobs j
     JOIN handyman_requests r ON r.id = j.handyman_request_id
     JOIN work_orders w ON w.id = j.work_order_id
     WHERE j.id = $1
       AND j.client_id = $2
       AND j.handyman_request_id = $3
       AND w.client_id = $2
       AND r.client_id = $2
       AND r.building_id = $4
       AND w.building_id = $4`,
    [
      demand.handymanJobId,
      demand.clientId,
      demand.handymanRequestId,
      demand.buildingId,
    ],
  );
  const context = result.rows[0];
  if (!context || context.workOrderId === '') {
    throw handymanMaterialInventoryDemandNotExecutableError(
      'The Handyman demand no longer resolves to its authoritative job and Work Order.',
    );
  }
  return context;
}

/** Reassert Run-1's quotation/addendum approval authority at time of reserve/issue/use. */
async function assertCommercialBasis(
  demand: HandymanMaterialDemandRecord,
  executor: Executor,
): Promise<void> {
  let valid = false;
  if (demand.commercialBasis === 'QUOTATION_INCLUDED') {
    const result = await executor.query<{ ok: number }>(
      `SELECT 1 AS ok
       FROM handyman_jobs j
       JOIN handyman_quotations q
         ON q.id = j.handyman_quotation_id
        AND q.status = 'APPROVED'
        AND q.sent_revision_id = j.handyman_quotation_revision_id
       JOIN handyman_quotation_revisions qr
         ON qr.id = j.handyman_quotation_revision_id
        AND qr.status = 'SUBMITTED'
       JOIN handyman_quotation_lines l
         ON l.id = $1
       JOIN handyman_quotation_approvals qa
         ON qa.quotation_revision_id = j.handyman_quotation_revision_id
        AND qa.status = 'APPROVED'
       WHERE j.id = $2
         AND j.client_id = $3
         AND j.handyman_quotation_revision_id = $4
         AND l.quotation_revision_id = j.handyman_quotation_revision_id
         AND l.line_type = 'MATERIAL'
         AND l.inventory_item_id IS NOT DISTINCT FROM $5::uuid
         AND l.uom_id = $6::uuid
         AND l.quantity = $7::numeric
         AND COALESCE(l.description, l.subject_name) = $8`,
      [
        demand.handymanQuotationLineId,
        demand.handymanJobId,
        demand.clientId,
        demand.quotationRevisionId,
        demand.inventoryItemId,
        demand.uomId,
        demand.quantity,
        demand.description,
      ],
    );
    valid = Boolean(result.rows[0]);
  } else if (demand.commercialBasis === 'ADDITIONAL_CUSTOMER_CHARGEABLE') {
    const result = await executor.query<{ ok: number }>(
      `SELECT 1 AS ok
       FROM handyman_material_commercial_addenda a
       JOIN handyman_material_approvals ap
         ON ap.id = $1
        AND ap.commercial_addendum_id = a.id
        AND ap.status = 'APPROVED'
       WHERE a.id = $2
         AND a.client_id = $3
         AND a.handyman_job_id = $4
         AND a.handyman_request_id = $5
         AND a.building_id = $6
         AND a.status = 'APPROVED'
         AND a.supply_source = $7
         AND a.inventory_item_id IS NOT DISTINCT FROM $8::uuid
         AND a.uom_id = $9::uuid
         AND a.description = $10
         AND a.quantity = $11::numeric`,
      [
        demand.handymanMaterialApprovalId,
        demand.commercialAddendumId,
        demand.clientId,
        demand.handymanJobId,
        demand.handymanRequestId,
        demand.buildingId,
        demand.supplySource,
        demand.inventoryItemId,
        demand.uomId,
        demand.description,
        demand.quantity,
      ],
    );
    valid = Boolean(result.rows[0]);
  } else if (demand.commercialBasis === 'NON_CHARGEABLE_OPERATIONAL') {
    valid =
      demand.sourceContext === 'INTERNAL_OPERATION' ||
      demand.sourceContext === 'FIELD_DISCOVERED';
  }

  if (!valid) {
    throw handymanMaterialInventoryDemandNotExecutableError(
      'The Handyman demand no longer has its required approved quotation/addendum basis.',
    );
  }
}

async function requireExecutableDemand(
  demand: HandymanMaterialDemandRecord,
  expectedSupplySource: 'PROVIDER_STOCK' | 'CUSTOMER_SUPPLIED',
  executor: Executor,
): Promise<DemandContext> {
  if (
    demand.status !== 'ACTIVE' ||
    demand.supplySource !== expectedSupplySource ||
    (expectedSupplySource === 'PROVIDER_STOCK' && !demand.inventoryItemId)
  ) {
    throw handymanMaterialInventoryDemandNotExecutableError();
  }
  const context = await requireDemandContext(demand, executor);
  await assertCommercialBasis(demand, executor);
  return context;
}

async function requireHistoricalProviderDemandContext(
  demand: HandymanMaterialDemandRecord,
  executor: Executor,
): Promise<DemandContext> {
  if (demand.supplySource !== 'PROVIDER_STOCK' || !demand.inventoryItemId) {
    throw handymanMaterialInventoryIssueContextInvalidError(
      'A customer-supplied demand cannot have a Provider-stock issue or return.',
    );
  }
  return requireDemandContext(demand, executor);
}

async function resolveProviderInventorySubject(
  demand: HandymanMaterialDemandRecord,
  input: { warehouseId: string; itemId: string | null; uomId: string | null },
  executor: Executor,
): Promise<ProviderInventorySubject> {
  if (!demand.inventoryItemId) {
    throw handymanMaterialInventoryDemandNotExecutableError();
  }
  if (input.itemId !== null && input.itemId !== demand.inventoryItemId) {
    throw handymanMaterialInventoryIssueContextInvalidError(
      'The supplied inventory item does not match the approved Handyman demand.',
    );
  }
  if (input.uomId !== null && input.uomId !== demand.uomId) {
    throw handymanMaterialInventoryUomIncompatibleError();
  }

  const itemResult = await executor.query<{
    id: string;
    clientId: string;
    uomId: string | null;
  }>(
    `SELECT id, client_id AS "clientId", uom_id AS "uomId"
     FROM inventory_items
     WHERE id = $1`,
    [demand.inventoryItemId],
  );
  const item = itemResult.rows[0];
  if (!item) throw inventoryItemNotFoundError();
  if (item.clientId !== demand.clientId) {
    throw handymanMaterialInventoryDemandNotExecutableError(
      'The demand inventory item does not belong to the demand client.',
    );
  }
  if (item.uomId !== null && item.uomId !== demand.uomId) {
    throw handymanMaterialInventoryUomIncompatibleError();
  }

  const warehouseResult = await executor.query<{
    id: string;
    clientId: string;
    buildingId: string;
  }>(
    `SELECT id, client_id AS "clientId", building_id AS "buildingId"
     FROM inventory_warehouses
     WHERE id = $1`,
    [input.warehouseId],
  );
  const warehouse = warehouseResult.rows[0];
  if (!warehouse) throw inventoryWarehouseNotFoundError();
  if (
    warehouse.clientId !== demand.clientId ||
    warehouse.buildingId !== demand.buildingId
  ) {
    throw handymanMaterialInventoryIssueContextInvalidError(
      'The warehouse must belong to the Handyman demand client and building.',
    );
  }

  return {
    warehouseId: warehouse.id,
    itemId: item.id,
    uomId: demand.uomId,
  };
}

async function resolveExecutionContext(
  input: {
    handymanServiceVisitId: string | null;
    handymanWorkSessionId: string | null;
  },
  context: DemandContext,
  executor: Executor,
): Promise<ExecutionContext> {
  if (input.handymanWorkSessionId) {
    const result = await executor.query<{
      sessionId: string;
      visitId: string;
    }>(
      `SELECT s.id AS "sessionId", v.id AS "visitId"
       FROM handyman_work_sessions s
       JOIN handyman_service_visits v ON v.id = s.visit_id
       WHERE s.id = $1
         AND s.client_id = $2
         AND v.client_id = $2
         AND v.handyman_job_id = $3`,
      [
        input.handymanWorkSessionId,
        context.clientId,
        context.handymanJobId,
      ],
    );
    const session = result.rows[0];
    if (!session) {
      throw handymanMaterialInventoryExecutionContextInvalidError(
        'The supplied work session does not belong to the Handyman job.',
      );
    }
    if (
      input.handymanServiceVisitId !== null &&
      input.handymanServiceVisitId !== session.visitId
    ) {
      throw handymanMaterialInventoryExecutionContextInvalidError(
        'The supplied work session and service visit do not match.',
      );
    }
    return {
      handymanServiceVisitId: session.visitId,
      handymanWorkSessionId: session.sessionId,
    };
  }

  if (input.handymanServiceVisitId) {
    const result = await executor.query<{ id: string }>(
      `SELECT id
       FROM handyman_service_visits
       WHERE id = $1
         AND client_id = $2
         AND handyman_job_id = $3`,
      [
        input.handymanServiceVisitId,
        context.clientId,
        context.handymanJobId,
      ],
    );
    if (!result.rows[0]) {
      throw handymanMaterialInventoryExecutionContextInvalidError();
    }
    return {
      handymanServiceVisitId: input.handymanServiceVisitId,
      handymanWorkSessionId: null,
    };
  }

  // This is the legitimate pre-staged issue/use lane: no visit/session is
  // invented, and no readiness or lifecycle rule is touched.
  return { handymanServiceVisitId: null, handymanWorkSessionId: null };
}

function assertReservationMatches(
  reservation: HandymanMaterialReservationRecord,
  demand: HandymanMaterialDemandRecord,
  subject: ProviderInventorySubject,
): void {
  if (
    reservation.handymanMaterialDemandId !== demand.id ||
    reservation.clientId !== demand.clientId ||
    reservation.buildingId !== demand.buildingId ||
    reservation.warehouseId !== subject.warehouseId ||
    reservation.itemId !== subject.itemId ||
    reservation.uomId !== subject.uomId
  ) {
    throw handymanMaterialInventoryReservationMismatchError();
  }
}

function assertIssueMatchesDemand(
  issue: HandymanMaterialControlledIssueRecord,
  demand: HandymanMaterialDemandRecord,
  context: DemandContext,
): void {
  if (
    issue.clientId !== demand.clientId ||
    issue.buildingId !== demand.buildingId ||
    issue.handymanMaterialDemandId !== demand.id ||
    issue.handymanJobId !== context.handymanJobId ||
    issue.workOrderId !== context.workOrderId ||
    issue.itemId !== demand.inventoryItemId ||
    issue.uomId !== demand.uomId
  ) {
    throw handymanMaterialInventoryIssueContextInvalidError();
  }
}

async function recordEvent(
  tx: Executor,
  context: DemandContext,
  input: {
    eventType: string;
    entityType: string;
    entityId: string;
    actorUserId: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: context.clientId,
      buildingId: context.buildingId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: input.actorUserId,
      summary: input.summary,
      // IDs, quantities, statuses only; never notes/reference/customer data.
      metadata: input.metadata,
    },
    tx,
  );
}

/** Reserve an active approved Provider-stock demand through the existing balance authority. */
export async function reserveHandymanMaterialDemand(
  input: ReserveHandymanMaterialDemandInput,
  actorUserId: string,
): Promise<HandymanMaterialReservationCommandResult> {
  const handymanMaterialDemandId = requireUuid(
    input.handymanMaterialDemandId,
    'handymanMaterialDemandId',
  );
  const warehouseId = requireUuid(input.warehouseId, 'warehouseId');
  const itemId = optionalUuid(input.itemId, 'itemId');
  const uomId = optionalUuid(input.uomId, 'uomId');
  const quantity = parsePositiveQuantity(input.quantity);
  const notes = optionalText(input.notes, 'notes', 1000);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('RESERVE_HANDYMAN_MATERIAL', {
    handymanMaterialDemandId,
    warehouseId,
    itemId,
    uomId,
    quantity: quantity.canonical,
    notes,
  });

  const previewDemand = await handymanMaterialDemandRepository.findDemandById(
    handymanMaterialDemandId,
  );
  if (!previewDemand) throw handymanMaterialDemandNotFoundError();
  await assertBuildingAccess(actorUserId, previewDemand.buildingId);

  const earlyReplay =
    await inventoryMaterialReservationRepository.findHandymanByIdempotencyKey(
      previewDemand.clientId,
      idempotencyKey,
    );
  if (earlyReplay) {
    assertFingerprint(earlyReplay.idempotencyFingerprint, idempotencyFingerprint);
    return { reservation: toPublicReservation(earlyReplay), replayed: true };
  }

  return withTransaction(async (tx) => {
    // Demand is the inventory-family head: it serializes capacity and demand
    // closure against reserve/issue commands without taking a job/visit lock.
    const demand = await handymanMaterialDemandRepository.lockDemandById(
      handymanMaterialDemandId,
      tx,
    );
    if (!demand) throw handymanMaterialDemandNotFoundError();
    await lockIdempotencyKey(
      tx,
      'handyman_material_reservations',
      demand.clientId,
      idempotencyKey,
    );
    const replay =
      await inventoryMaterialReservationRepository.findHandymanByIdempotencyKey(
        demand.clientId,
        idempotencyKey,
        tx,
      );
    if (replay) {
      assertFingerprint(replay.idempotencyFingerprint, idempotencyFingerprint);
      return { reservation: toPublicReservation(replay), replayed: true };
    }

    const context = await requireExecutableDemand(demand, 'PROVIDER_STOCK', tx);
    const subject = await resolveProviderInventorySubject(
      demand,
      { warehouseId, itemId, uomId },
      tx,
    );
    const snapshot =
      await inventoryMaterialReservationRepository.getHandymanDemandSnapshot(
        tx,
        demand.id,
        quantity.value,
      );
    if (!snapshot.reservationAllowed) {
      throw handymanMaterialInventoryDemandExceededError();
    }

    const balance = await inventoryMaterialReservationRepository.findBalanceForUpdate(
      tx,
      subject.warehouseId,
      subject.itemId,
    );
    if (!balance) {
      // Reuse the existing inventory reservation error contract for the
      // existing balance authority rather than manufacturing a Handyman stock
      // balance/error family.
      throw materialReservationInsufficientStockError();
    }
    const updatedBalance =
      await inventoryMaterialReservationRepository.increaseReservedQuantity(
        tx,
        balance.id,
        quantity.value,
      );
    if (!updatedBalance) {
      throw materialReservationInsufficientStockError();
    }

    const reservation =
      await inventoryMaterialReservationRepository.createHandymanWithClient(tx, {
        clientId: demand.clientId,
        buildingId: demand.buildingId,
        handymanMaterialDemandId: demand.id,
        warehouseId: subject.warehouseId,
        itemId: subject.itemId,
        uomId: subject.uomId,
        reservedQuantity: quantity.value,
        createdByUserId: actorUserId,
        idempotencyKey,
        idempotencyFingerprint,
        notes,
      });

    await recordEvent(tx, context, {
      eventType: 'HANDYMAN_MATERIAL_RESERVATION_CREATED',
      entityType: 'MATERIAL_RESERVATION',
      entityId: reservation.id,
      actorUserId,
      summary: 'Handyman material inventory reservation created.',
      metadata: {
        handymanMaterialDemandId: demand.id,
        warehouseId: subject.warehouseId,
        itemId: subject.itemId,
        quantity: quantity.value,
        authorizedDemand: snapshot.authorizedDemand,
        cumulativeIssued: snapshot.cumulativeIssued,
        activeReservedBefore: snapshot.activeReserved,
        resultingReservedQuantity: Number(updatedBalance.reservedQuantity),
        resultingAvailableQuantity: Number(updatedBalance.availableQuantity),
      },
    });
    return { reservation: toPublicReservation(reservation), replayed: false };
  });
}

async function transitionHandymanReservation(
  input: ReleaseHandymanMaterialReservationInput | CancelHandymanMaterialReservationInput,
  actorUserId: string,
  status: 'RELEASED' | 'CANCELLED',
): Promise<HandymanMaterialReservationCommandResult> {
  const inventoryMaterialReservationId = requireUuid(
    input.inventoryMaterialReservationId,
    'inventoryMaterialReservationId',
  );
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint(
    status === 'RELEASED'
      ? 'RELEASE_HANDYMAN_MATERIAL_RESERVATION'
      : 'CANCEL_HANDYMAN_MATERIAL_RESERVATION',
    { inventoryMaterialReservationId },
  );
  const preview = await inventoryMaterialReservationRepository.findHandymanById(
    inventoryMaterialReservationId,
  );
  if (!preview) throw handymanMaterialInventoryReservationNotFoundError();
  await assertBuildingAccess(actorUserId, preview.buildingId);

  const earlyReplay =
    await inventoryMaterialReservationRepository.findHandymanByTerminalIdempotencyKey(
      preview.clientId,
      idempotencyKey,
    );
  if (earlyReplay) {
    assertFingerprint(
      earlyReplay.terminalIdempotencyFingerprint ?? '',
      idempotencyFingerprint,
    );
    return { reservation: toPublicReservation(earlyReplay), replayed: true };
  }

  return withTransaction(async (tx) => {
    // The immutable source ID tells us which demand to lock first. This is the
    // same source → reservation → balance order as the procurement path.
    const demand = await handymanMaterialDemandRepository.lockDemandById(
      preview.handymanMaterialDemandId,
      tx,
    );
    if (!demand) throw handymanMaterialDemandNotFoundError();
    const reservation =
      await inventoryMaterialReservationRepository.findHandymanByIdForUpdate(
        tx,
        inventoryMaterialReservationId,
      );
    if (!reservation) throw handymanMaterialInventoryReservationNotFoundError();
    if (
      reservation.handymanMaterialDemandId !== demand.id ||
      reservation.clientId !== demand.clientId ||
      reservation.buildingId !== demand.buildingId
    ) {
      throw handymanMaterialInventoryReservationMismatchError();
    }
    await lockIdempotencyKey(
      tx,
      'handyman_material_reservation_terminal',
      reservation.clientId,
      idempotencyKey,
    );
    const replay =
      await inventoryMaterialReservationRepository.findHandymanByTerminalIdempotencyKey(
        reservation.clientId,
        idempotencyKey,
        tx,
      );
    if (replay) {
      assertFingerprint(
        replay.terminalIdempotencyFingerprint ?? '',
        idempotencyFingerprint,
      );
      return { reservation: toPublicReservation(replay), replayed: true };
    }
    if (reservation.status !== 'ACTIVE') {
      throw handymanMaterialInventoryReservationNotActiveError();
    }

    const balance = await inventoryMaterialReservationRepository.findBalanceForUpdate(
      tx,
      reservation.warehouseId,
      reservation.itemId,
    );
    if (!balance) throw handymanMaterialInventoryReservationMismatchError();
    const updatedBalance =
      await inventoryMaterialReservationRepository.decreaseReservedQuantity(
        tx,
        balance.id,
        reservation.remainingQuantity,
      );
    if (!updatedBalance) throw handymanMaterialInventoryReservationMismatchError();
    const transitioned =
      await inventoryMaterialReservationRepository.transitionHandymanWithClient(
        tx,
        reservation.id,
        status,
        actorUserId,
        idempotencyKey,
        idempotencyFingerprint,
      );
    if (!transitioned) throw handymanMaterialInventoryReservationNotActiveError();

    const context = await requireDemandContext(demand, tx);
    await recordEvent(tx, context, {
      eventType:
        status === 'RELEASED'
          ? 'HANDYMAN_MATERIAL_RESERVATION_RELEASED'
          : 'HANDYMAN_MATERIAL_RESERVATION_CANCELLED',
      entityType: 'MATERIAL_RESERVATION',
      entityId: transitioned.id,
      actorUserId,
      summary:
        status === 'RELEASED'
          ? 'Handyman material inventory reservation released.'
          : 'Handyman material inventory reservation cancelled.',
      metadata: {
        handymanMaterialDemandId: demand.id,
        warehouseId: transitioned.warehouseId,
        itemId: transitioned.itemId,
        releasedQuantity: transitioned.remainingQuantity,
        status: transitioned.status,
        resultingReservedQuantity: Number(updatedBalance.reservedQuantity),
        resultingAvailableQuantity: Number(updatedBalance.availableQuantity),
      },
    });
    return { reservation: toPublicReservation(transitioned), replayed: false };
  });
}

export async function releaseHandymanMaterialReservation(
  input: ReleaseHandymanMaterialReservationInput,
  actorUserId: string,
): Promise<HandymanMaterialReservationCommandResult> {
  return transitionHandymanReservation(input, actorUserId, 'RELEASED');
}

export async function cancelHandymanMaterialReservation(
  input: CancelHandymanMaterialReservationInput,
  actorUserId: string,
): Promise<HandymanMaterialReservationCommandResult> {
  return transitionHandymanReservation(input, actorUserId, 'CANCELLED');
}

/** Controlled Provider-stock hand-off: exactly one reservation-aware STOCK_OUT. */
export async function issueHandymanProviderStock(
  input: IssueHandymanProviderStockInput,
  actorUserId: string,
): Promise<HandymanMaterialControlledIssueResult> {
  const handymanMaterialDemandId = requireUuid(
    input.handymanMaterialDemandId,
    'handymanMaterialDemandId',
  );
  const warehouseId = requireUuid(input.warehouseId, 'warehouseId');
  const itemId = optionalUuid(input.itemId, 'itemId');
  const uomId = optionalUuid(input.uomId, 'uomId');
  const inventoryMaterialReservationId = optionalUuid(
    input.inventoryMaterialReservationId,
    'inventoryMaterialReservationId',
  );
  const suppliedVisitId = optionalUuid(
    input.handymanServiceVisitId,
    'handymanServiceVisitId',
  );
  const suppliedSessionId = optionalUuid(
    input.handymanWorkSessionId,
    'handymanWorkSessionId',
  );
  const quantity = parsePositiveQuantity(input.quantity);
  const suppliedIssuedAt = optionalDate(input.issuedAt, 'issuedAt');
  // Server-stamped defaults are not caller business facts: an identical retry
  // with no timestamp must replay rather than conflict because NOW advanced.
  const issuedAt = suppliedIssuedAt ?? new Date();
  const reference = optionalText(input.reference, 'reference', 200);
  const notes = optionalText(input.notes, 'notes', 1000);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('ISSUE_HANDYMAN_PROVIDER_STOCK', {
    handymanMaterialDemandId,
    warehouseId,
    itemId,
    uomId,
    inventoryMaterialReservationId,
    handymanServiceVisitId: suppliedVisitId,
    handymanWorkSessionId: suppliedSessionId,
    quantity: quantity.canonical,
    issuedAt: suppliedIssuedAt?.toISOString() ?? null,
    reference,
    notes,
  });

  const previewDemand = await handymanMaterialDemandRepository.findDemandById(
    handymanMaterialDemandId,
  );
  if (!previewDemand) throw handymanMaterialDemandNotFoundError();
  await assertBuildingAccess(actorUserId, previewDemand.buildingId);
  const earlyReplay =
    await handymanMaterialInventoryRepository.findControlledIssueByIdempotencyKey(
      previewDemand.clientId,
      idempotencyKey,
    );
  if (earlyReplay) {
    assertFingerprint(earlyReplay.idempotencyFingerprint, idempotencyFingerprint);
    return { issue: toPublicIssue(earlyReplay), replayed: true };
  }

  return withTransaction(async (tx) => {
    const demand = await handymanMaterialDemandRepository.lockDemandById(
      handymanMaterialDemandId,
      tx,
    );
    if (!demand) throw handymanMaterialDemandNotFoundError();
    await lockIdempotencyKey(
      tx,
      'handyman_material_controlled_issues',
      demand.clientId,
      idempotencyKey,
    );
    const replay =
      await handymanMaterialInventoryRepository.findControlledIssueByIdempotencyKey(
        demand.clientId,
        idempotencyKey,
        tx,
      );
    if (replay) {
      assertFingerprint(replay.idempotencyFingerprint, idempotencyFingerprint);
      return { issue: toPublicIssue(replay), replayed: true };
    }

    const context = await requireExecutableDemand(demand, 'PROVIDER_STOCK', tx);
    if (
      context.workOrderStatus === 'COMPLETED' ||
      context.workOrderStatus === 'CANCELLED' ||
      context.workOrderStatus === 'CLOSED'
    ) {
      // Mirror the existing controlled Work Order issue semantic exactly;
      // Handyman does not own or transition the Work Order lifecycle.
      throw handymanMaterialInventoryWorkOrderStateInvalidError();
    }
    const subject = await resolveProviderInventorySubject(
      demand,
      { warehouseId, itemId, uomId },
      tx,
    );
    const execution = await resolveExecutionContext(
      {
        handymanServiceVisitId: suppliedVisitId,
        handymanWorkSessionId: suppliedSessionId,
      },
      context,
      tx,
    );

    let reservation: HandymanMaterialReservationRecord | null = null;
    if (inventoryMaterialReservationId) {
      reservation =
        await inventoryMaterialReservationRepository.findHandymanByIdForUpdate(
          tx,
          inventoryMaterialReservationId,
        );
      if (!reservation) throw handymanMaterialInventoryReservationNotFoundError();
      if (reservation.status !== 'ACTIVE') {
        throw handymanMaterialInventoryReservationNotActiveError();
      }
      assertReservationMatches(reservation, demand, subject);
    }

    const snapshot =
      await inventoryMaterialReservationRepository.getHandymanDemandSnapshot(
        tx,
        demand.id,
        quantity.value,
      );
    if (
      (reservation && !snapshot.reservedIssueAllowed) ||
      (!reservation && !snapshot.unreservedIssueAllowed)
    ) {
      throw handymanMaterialInventoryIssueExceededError();
    }

    if (reservation) {
      const consumed =
        await inventoryMaterialReservationRepository.consumeHandymanWithClient(
          tx,
          reservation.id,
          quantity.value,
          actorUserId,
        );
      if (!consumed) {
        throw handymanMaterialInventoryReservationAllocationExceededError();
      }
    }

    // Generate the typed issue identifier before movement creation. The
    // movement source is therefore verifiable by the database trigger and
    // cannot be posted through the generic public movement command.
    const issueId = randomUUID();
    const movement = await inventoryStockMovementService.postStockMovementWithClient(
      tx,
      {
        warehouseId: subject.warehouseId,
        itemId: subject.itemId,
        movementType: 'STOCK_OUT',
        quantity: quantity.value,
        ...(reservation
          ? { reservedQuantityToConsume: quantity.value }
          : {}),
        movementDate: issuedAt.toISOString(),
        reference: reference ?? undefined,
        source: `HANDYMAN_MATERIAL_ISSUE:${issueId}`,
        performedByUserId: actorUserId,
        notes: notes ?? 'Handyman Provider-stock controlled issue',
      },
    );
    const issue = await handymanMaterialInventoryRepository.createControlledIssue(
      {
        id: issueId,
        clientId: demand.clientId,
        buildingId: demand.buildingId,
        handymanMaterialDemandId: demand.id,
        handymanJobId: context.handymanJobId,
        workOrderId: context.workOrderId,
        inventoryMaterialReservationId: reservation?.id ?? null,
        warehouseId: subject.warehouseId,
        itemId: subject.itemId,
        uomId: subject.uomId,
        handymanServiceVisitId: execution.handymanServiceVisitId,
        handymanWorkSessionId: execution.handymanWorkSessionId,
        inventoryStockMovementId: movement.record.id,
        quantity: quantity.value,
        issuedByUserId: actorUserId,
        issuedAt,
        reference,
        notes,
        idempotencyKey,
        idempotencyFingerprint,
      },
      tx,
    );
    await recordEvent(tx, context, {
      eventType: 'HANDYMAN_MATERIAL_ISSUED',
      entityType: 'HANDYMAN_MATERIAL_CONTROLLED_ISSUE',
      entityId: issue.id,
      actorUserId,
      summary: 'Handyman Provider-stock material issued.',
      metadata: {
        handymanMaterialDemandId: demand.id,
        workOrderId: context.workOrderId,
        inventoryMaterialReservationId: reservation?.id ?? null,
        inventoryStockMovementId: movement.record.id,
        warehouseId: subject.warehouseId,
        itemId: subject.itemId,
        quantity: quantity.value,
        authorizedDemand: snapshot.authorizedDemand,
        cumulativeIssuedBefore: snapshot.cumulativeIssued,
        activeReservedBefore: snapshot.activeReserved,
        handymanServiceVisitId: execution.handymanServiceVisitId,
        handymanWorkSessionId: execution.handymanWorkSessionId,
      },
    });
    return { issue: toPublicIssue(issue), replayed: false };
  });
}

/** Append-only actual use/install fact; Provider use is constrained by original issue. */
export async function recordHandymanMaterialActualUsage(
  input: RecordHandymanMaterialActualUsageInput,
  actorUserId: string,
): Promise<HandymanMaterialActualUsageResult> {
  const handymanMaterialDemandId = requireUuid(
    input.handymanMaterialDemandId,
    'handymanMaterialDemandId',
  );
  const handymanMaterialControlledIssueId = optionalUuid(
    input.handymanMaterialControlledIssueId,
    'handymanMaterialControlledIssueId',
  );
  const suppliedVisitId = optionalUuid(
    input.handymanServiceVisitId,
    'handymanServiceVisitId',
  );
  const suppliedSessionId = optionalUuid(
    input.handymanWorkSessionId,
    'handymanWorkSessionId',
  );
  const usageKind: HandymanMaterialUsageKind = input.usageKind ?? 'USED';
  if (usageKind !== 'USED' && usageKind !== 'INSTALLED') {
    return validation('usageKind', 'usageKind must be USED or INSTALLED.');
  }
  const quantity = parsePositiveQuantity(input.quantity);
  const suppliedUsedAt = optionalDate(input.usedAt, 'usedAt');
  const usedAt = suppliedUsedAt ?? new Date();
  const notes = optionalText(input.notes, 'notes', 1000);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('RECORD_HANDYMAN_MATERIAL_ACTUAL_USAGE', {
    handymanMaterialDemandId,
    handymanMaterialControlledIssueId,
    handymanServiceVisitId: suppliedVisitId,
    handymanWorkSessionId: suppliedSessionId,
    usageKind,
    quantity: quantity.canonical,
    usedAt: suppliedUsedAt?.toISOString() ?? null,
    notes,
  });

  const previewDemand = await handymanMaterialDemandRepository.findDemandById(
    handymanMaterialDemandId,
  );
  if (!previewDemand) throw handymanMaterialDemandNotFoundError();
  await assertBuildingAccess(actorUserId, previewDemand.buildingId);
  const earlyReplay =
    await handymanMaterialInventoryRepository.findActualUsageByIdempotencyKey(
      previewDemand.clientId,
      idempotencyKey,
    );
  if (earlyReplay) {
    assertFingerprint(earlyReplay.idempotencyFingerprint, idempotencyFingerprint);
    return {
      usage: toPublicActualUsage(earlyReplay),
      replayed: true,
      supplySource: previewDemand.supplySource,
    };
  }

  if (previewDemand.supplySource === 'PROVIDER_STOCK') {
    if (!handymanMaterialControlledIssueId) {
      throw handymanMaterialInventoryIssueContextInvalidError(
        'Provider-stock actual use requires an originating controlled issue.',
      );
    }
    return withTransaction(async (tx) => {
      // This is the one deterministic lock shared by Provider use and return.
      const issue =
        await handymanMaterialInventoryRepository.lockControlledIssueById(
          handymanMaterialControlledIssueId,
          tx,
        );
      if (!issue) throw handymanMaterialInventoryIssueNotFoundError();
      await lockIdempotencyKey(
        tx,
        'handyman_material_actual_usage',
        issue.clientId,
        idempotencyKey,
      );
      const replay =
        await handymanMaterialInventoryRepository.findActualUsageByIdempotencyKey(
          issue.clientId,
          idempotencyKey,
          tx,
        );
      if (replay) {
        assertFingerprint(replay.idempotencyFingerprint, idempotencyFingerprint);
        return {
          usage: toPublicActualUsage(replay),
          replayed: true,
          supplySource: previewDemand.supplySource,
        };
      }

      const context = await requireHistoricalProviderDemandContext(previewDemand, tx);
      assertIssueMatchesDemand(issue, previewDemand, context);
      const execution = await resolveExecutionContext(
        {
          handymanServiceVisitId: suppliedVisitId,
          handymanWorkSessionId: suppliedSessionId,
        },
        context,
        tx,
      );
      const snapshot = await handymanMaterialInventoryRepository.getIssueUseReturnSnapshot(
        tx,
        issue.id,
      );
      if (
        snapshot.usedQuantity + snapshot.returnedQuantity + quantity.value >
        snapshot.issuedQuantity + 1e-9
      ) {
        throw handymanMaterialInventoryActualUseExceededError();
      }
      const usage = await handymanMaterialInventoryRepository.createActualUsage(
        {
          clientId: issue.clientId,
          buildingId: issue.buildingId,
          handymanMaterialDemandId: previewDemand.id,
          handymanJobId: context.handymanJobId,
          workOrderId: context.workOrderId,
          handymanMaterialControlledIssueId: issue.id,
          inventoryItemId: issue.itemId,
          uomId: issue.uomId,
          handymanServiceVisitId: execution.handymanServiceVisitId,
          handymanWorkSessionId: execution.handymanWorkSessionId,
          usageKind,
          quantity: quantity.value,
          usedByUserId: actorUserId,
          usedAt,
          notes,
          idempotencyKey,
          idempotencyFingerprint,
        },
        tx,
      );
      await recordEvent(tx, context, {
        eventType: 'HANDYMAN_MATERIAL_ACTUAL_USAGE_RECORDED',
        entityType: 'HANDYMAN_MATERIAL_ACTUAL_USAGE',
        entityId: usage.id,
        actorUserId,
        summary: 'Handyman Provider-stock actual material use recorded.',
        metadata: {
          handymanMaterialDemandId: previewDemand.id,
          handymanMaterialControlledIssueId: issue.id,
          workOrderId: context.workOrderId,
          usageKind,
          quantity: quantity.value,
          cumulativeUsedBefore: snapshot.usedQuantity,
          cumulativeReturnedBefore: snapshot.returnedQuantity,
        },
      });
      return {
        usage: toPublicActualUsage(usage),
        replayed: false,
        supplySource: previewDemand.supplySource,
      };
    });
  }

  if (handymanMaterialControlledIssueId) {
    throw handymanMaterialInventoryIssueContextInvalidError(
      'Customer-supplied actual use must not reference an inventory issue.',
    );
  }
  return withTransaction(async (tx) => {
    const demand = await handymanMaterialDemandRepository.lockDemandById(
      handymanMaterialDemandId,
      tx,
    );
    if (!demand) throw handymanMaterialDemandNotFoundError();
    await lockIdempotencyKey(
      tx,
      'handyman_material_actual_usage',
      demand.clientId,
      idempotencyKey,
    );
    const replay =
      await handymanMaterialInventoryRepository.findActualUsageByIdempotencyKey(
        demand.clientId,
        idempotencyKey,
        tx,
      );
    if (replay) {
      assertFingerprint(replay.idempotencyFingerprint, idempotencyFingerprint);
      return {
        usage: toPublicActualUsage(replay),
        replayed: true,
        supplySource: demand.supplySource,
      };
    }

    const context = await requireExecutableDemand(demand, 'CUSTOMER_SUPPLIED', tx);
    const execution = await resolveExecutionContext(
      {
        handymanServiceVisitId: suppliedVisitId,
        handymanWorkSessionId: suppliedSessionId,
      },
      context,
      tx,
    );
    const usedQuantity =
      await handymanMaterialInventoryRepository.getCustomerActualUsageQuantity(
        tx,
        demand.id,
      );
    if (usedQuantity + quantity.value > Number(demand.quantity) + 1e-9) {
      throw handymanMaterialInventoryActualUseExceededError();
    }
    const usage = await handymanMaterialInventoryRepository.createActualUsage(
      {
        clientId: demand.clientId,
        buildingId: demand.buildingId,
        handymanMaterialDemandId: demand.id,
        handymanJobId: context.handymanJobId,
        workOrderId: context.workOrderId,
        handymanMaterialControlledIssueId: null,
        inventoryItemId: demand.inventoryItemId,
        uomId: demand.uomId,
        handymanServiceVisitId: execution.handymanServiceVisitId,
        handymanWorkSessionId: execution.handymanWorkSessionId,
        usageKind,
        quantity: quantity.value,
        usedByUserId: actorUserId,
        usedAt,
        notes,
        idempotencyKey,
        idempotencyFingerprint,
      },
      tx,
    );
    await recordEvent(tx, context, {
      eventType: 'HANDYMAN_MATERIAL_ACTUAL_USAGE_RECORDED',
      entityType: 'HANDYMAN_MATERIAL_ACTUAL_USAGE',
      entityId: usage.id,
      actorUserId,
      summary: 'Customer-supplied Handyman material actual use recorded.',
      metadata: {
        handymanMaterialDemandId: demand.id,
        workOrderId: context.workOrderId,
        usageKind,
        quantity: quantity.value,
        cumulativeUsedBefore: usedQuantity,
      },
    });
    return {
      usage: toPublicActualUsage(usage),
      replayed: false,
      supplySource: demand.supplySource,
    };
  });
}

/** Normal unused Provider-stock return: one originating issue, one STOCK_IN. */
export async function returnUnusedHandymanProviderStock(
  input: ReturnUnusedHandymanProviderStockInput,
  actorUserId: string,
): Promise<HandymanMaterialReturnResult> {
  const handymanMaterialControlledIssueId = requireUuid(
    input.handymanMaterialControlledIssueId,
    'handymanMaterialControlledIssueId',
  );
  const quantity = parsePositiveQuantity(input.quantity);
  const suppliedReturnedAt = optionalDate(input.returnedAt, 'returnedAt');
  const returnedAt = suppliedReturnedAt ?? new Date();
  const reference = optionalText(input.reference, 'reference', 200);
  const notes = optionalText(input.notes, 'notes', 1000);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint('RETURN_UNUSED_HANDYMAN_PROVIDER_STOCK', {
    handymanMaterialControlledIssueId,
    quantity: quantity.canonical,
    returnedAt: suppliedReturnedAt?.toISOString() ?? null,
    reference,
    notes,
  });

  const previewIssue =
    await handymanMaterialInventoryRepository.findControlledIssueById(
      handymanMaterialControlledIssueId,
    );
  if (!previewIssue) throw handymanMaterialInventoryIssueNotFoundError();
  await assertBuildingAccess(actorUserId, previewIssue.buildingId);
  const earlyReplay = await handymanMaterialInventoryRepository.findReturnByIdempotencyKey(
    previewIssue.clientId,
    idempotencyKey,
  );
  if (earlyReplay) {
    assertFingerprint(earlyReplay.idempotencyFingerprint, idempotencyFingerprint);
    return { return: toPublicReturn(earlyReplay), replayed: true };
  }

  return withTransaction(async (tx) => {
    // The original controlled issue is the lock for all usage/return arithmetic.
    const issue =
      await handymanMaterialInventoryRepository.lockControlledIssueById(
        handymanMaterialControlledIssueId,
        tx,
      );
    if (!issue) throw handymanMaterialInventoryIssueNotFoundError();
    await lockIdempotencyKey(
      tx,
      'handyman_material_returns',
      issue.clientId,
      idempotencyKey,
    );
    const replay = await handymanMaterialInventoryRepository.findReturnByIdempotencyKey(
      issue.clientId,
      idempotencyKey,
      tx,
    );
    if (replay) {
      assertFingerprint(replay.idempotencyFingerprint, idempotencyFingerprint);
      return { return: toPublicReturn(replay), replayed: true };
    }

    const demand = await handymanMaterialDemandRepository.findDemandById(
      issue.handymanMaterialDemandId,
      tx,
    );
    if (!demand) throw handymanMaterialDemandNotFoundError();
    const context = await requireHistoricalProviderDemandContext(demand, tx);
    assertIssueMatchesDemand(issue, demand, context);
    const snapshot = await handymanMaterialInventoryRepository.getIssueUseReturnSnapshot(
      tx,
      issue.id,
    );
    if (
      snapshot.usedQuantity + snapshot.returnedQuantity + quantity.value >
      snapshot.issuedQuantity + 1e-9
    ) {
      throw handymanMaterialInventoryReturnExceededError();
    }

    const returnId = randomUUID();
    const movement = await inventoryStockMovementService.postStockMovementWithClient(
      tx,
      {
        warehouseId: issue.warehouseId,
        itemId: issue.itemId,
        movementType: 'STOCK_IN',
        quantity: quantity.value,
        movementDate: returnedAt.toISOString(),
        reference: reference ?? undefined,
        source: `HANDYMAN_MATERIAL_RETURN:${returnId}`,
        performedByUserId: actorUserId,
        notes: notes ?? 'Handyman Provider-stock unused return',
      },
    );
    const returned = await handymanMaterialInventoryRepository.createReturn(
      {
        id: returnId,
        clientId: issue.clientId,
        buildingId: issue.buildingId,
        handymanMaterialControlledIssueId: issue.id,
        handymanMaterialDemandId: issue.handymanMaterialDemandId,
        handymanJobId: issue.handymanJobId,
        workOrderId: issue.workOrderId,
        warehouseId: issue.warehouseId,
        itemId: issue.itemId,
        uomId: issue.uomId,
        inventoryStockMovementId: movement.record.id,
        quantity: quantity.value,
        returnedByUserId: actorUserId,
        returnedAt,
        reference,
        notes,
        idempotencyKey,
        idempotencyFingerprint,
      },
      tx,
    );
    await recordEvent(tx, context, {
      eventType: 'HANDYMAN_MATERIAL_RETURNED',
      entityType: 'HANDYMAN_MATERIAL_RETURN',
      entityId: returned.id,
      actorUserId,
      summary: 'Unused Handyman Provider-stock material returned.',
      metadata: {
        handymanMaterialDemandId: demand.id,
        handymanMaterialControlledIssueId: issue.id,
        inventoryStockMovementId: movement.record.id,
        warehouseId: issue.warehouseId,
        itemId: issue.itemId,
        quantity: quantity.value,
        cumulativeUsedBefore: snapshot.usedQuantity,
        cumulativeReturnedBefore: snapshot.returnedQuantity,
      },
    });
    return { return: toPublicReturn(returned), replayed: false };
  });
}

export const handymanMaterialInventoryService = {
  cancelHandymanMaterialReservation,
  issueHandymanProviderStock,
  recordHandymanMaterialActualUsage,
  releaseHandymanMaterialReservation,
  reserveHandymanMaterialDemand,
  returnUnusedHandymanProviderStock,
  toPublicActualUsage,
  toPublicIssue,
  toPublicReservation,
  toPublicReturn,
};
