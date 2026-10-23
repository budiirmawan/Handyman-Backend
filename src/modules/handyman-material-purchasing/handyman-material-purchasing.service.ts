import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access/context-access.service';
import { permissionService } from '../permissions';
import { recordOperationalEvent } from '../operational-events';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments/handyman-scope-assignment.service';
import { findEligibleHandymanWorker } from '../handyman-providers/handyman-worker-eligibility.repository';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence/handyman-field-evidence.service';
import { handymanMaterialPurchasingRepository } from './handyman-material-purchasing.repository';
import {
  HANDYMAN_MATERIAL_FUNDING_SOURCES,
  HANDYMAN_MATERIAL_REIMBURSEMENT_STATUSES,
  HANDYMAN_MATERIAL_RETURN_DESTINATIONS,
  HANDYMAN_REIMBURSEMENT_DISBURSEMENT_METHODS,
  type HandymanMaterialFundingSource,
  type HandymanMaterialPurchaseEventRecord,
  type HandymanMaterialPurchaseRecord,
  type HandymanMaterialReimbursementStatus,
  type HandymanMaterialReturnDestination,
  type HandymanReimbursementDisbursementMethod,
  type MaterialLedgerSeparationSummary,
} from './handyman-material-purchasing.types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.validation(`${field} must be a valid UUID.`);
  }
  return value;
}

function assertNonEmptyText(
  value: unknown,
  field: string,
  maxLen: number,
): string {
  if (typeof value !== 'string') {
    throw AppError.validation(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLen) {
    throw AppError.validation(
      `${field} must be between 1 and ${maxLen} characters.`,
    );
  }
  return trimmed;
}

function assertPositiveQuantity(value: unknown, field = 'quantity'): string {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw AppError.validation(`${field} must be a positive number.`);
  }
  return num.toFixed(3);
}

function assertNonNegativeAmount(value: unknown, field: string): string {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw AppError.validation(`${field} must be a non-negative amount.`);
  }
  return num.toFixed(2);
}

function assertFundingSource(value: unknown): HandymanMaterialFundingSource {
  if (
    typeof value !== 'string' ||
    !(HANDYMAN_MATERIAL_FUNDING_SOURCES as readonly string[]).includes(value)
  ) {
    throw AppError.validation(
      `fundingSource must be one of: ${HANDYMAN_MATERIAL_FUNDING_SOURCES.join(', ')}.`,
    );
  }
  return value as HandymanMaterialFundingSource;
}

function assertStrictBodyAllowlist(
  body: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request body must be a JSON object.');
  }
  const obj = body as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw AppError.validation(
      `Unknown or unaccepted fields in request body: ${unknown.join(', ')}.`,
    );
  }
  return obj;
}

function isPgUniqueViolation(
  err: unknown,
): err is { code: string; constraint?: string } {
  return (
    Boolean(err) &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === '23505'
  );
}

async function resolveOptionalWorkOrderId(
  tx: PoolClient,
  ctx: ExecutionScopeContext,
  rawWorkOrderId: unknown,
  existingWorkOrderId: string | null = null,
): Promise<string | null> {
  if (rawWorkOrderId === undefined || rawWorkOrderId === null) {
    return existingWorkOrderId;
  }
  const validWoId = assertUuid(rawWorkOrderId, 'workOrderId');
  if (existingWorkOrderId && existingWorkOrderId !== validWoId) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM,
      message:
        'Material purchase record is already bound to a different Work Order.',
    });
  }
  const woRes = await tx.query<{
    id: string;
    client_id: string;
    building_id: string;
  }>(
    `SELECT id, client_id, building_id
       FROM work_orders
      WHERE id = $1`,
    [validWoId],
  );
  const wo = woRes.rows[0];
  if (!wo) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.WORK_ORDER_NOT_FOUND,
      message: 'Referenced Work Order not found.',
    });
  }
  if (wo.client_id !== ctx.clientId || wo.building_id !== ctx.buildingId) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Referenced workOrderId does not belong to the exact Client and Building of this Execution Scope.',
    });
  }
  return wo.id;
}

interface ExecutionScopeContext {
  executionScopeId: string;
  clientId: string;
  handymanRequestId: string;
  tenantCompanyId: string;
  buildingId: string;
}

async function loadExecutionScopeContext(
  executionScopeId: string,
  tx?: PoolClient,
): Promise<ExecutionScopeContext> {
  const validScopeId = assertUuid(executionScopeId, 'executionScopeId');
  const db = tx ?? getPool();
  const res = await db.query<{
    id: string;
    client_id: string;
    handyman_request_id: string;
    tenant_company_id: string;
    building_id: string;
  }>(
    `SELECT id, client_id, handyman_request_id, tenant_company_id, building_id
       FROM handyman_execution_scopes
      WHERE id = $1`,
    [validScopeId],
  );
  const scope = res.rows[0];
  if (!scope) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_NOT_FOUND,
      message: 'Handyman execution scope not found.',
    });
  }
  return {
    executionScopeId: scope.id,
    clientId: scope.client_id,
    handymanRequestId: scope.handyman_request_id,
    tenantCompanyId: scope.tenant_company_id,
    buildingId: scope.building_id,
  };
}

async function assertBuildingScopeAccess(
  actorUserId: string,
  ctx: ExecutionScopeContext,
): Promise<void> {
  const allowed = await contextAccessService.canAccessBuildingScopedResource(
    actorUserId,
    {
      clientId: ctx.clientId,
      buildingId: ctx.buildingId,
    },
  );
  if (!allowed) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.BUILDING_ACCESS_DENIED,
      message: 'Access to the requested building context is denied.',
    });
  }
}

async function userHasPermissionCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  return permissions.includes(code);
}

async function resolveFieldRoleForExecutionScope(
  actorUserId: string,
  ctx: ExecutionScopeContext,
  tx?: PoolClient,
): Promise<{
  isPicPekerjaan: boolean;
  isInspector: boolean;
}> {
  await assertBuildingScopeAccess(actorUserId, ctx);
  const db = tx ?? getPool();

  let isPicPekerjaan = false;
  try {
    const lead = await resolveHandymanAssignmentLead(
      ctx.executionScopeId,
      actorUserId,
    );
    if (lead && lead.leadUserId === actorUserId) {
      isPicPekerjaan = true;
    }
  } catch {
    isPicPekerjaan = false;
  }

  let isInspector = false;
  const inspRes = await db.query<{ id: string }>(
    `SELECT id
       FROM handyman_visit_appointments
      WHERE client_id = $1
        AND handyman_request_id = $2
        AND kind = 'INSPECTION'
        AND resource_type = 'INSPECTOR_USER'
        AND resource_id = $3
        AND state IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED')
      LIMIT 1`,
    [ctx.clientId, ctx.handymanRequestId, actorUserId],
  );
  if (inspRes.rows[0]) {
    const eligible = await findEligibleHandymanWorker(db, {
      clientId: ctx.clientId,
      buildingId: ctx.buildingId,
      userId: actorUserId,
      requireLogin: true,
    });
    if (eligible) {
      isInspector = true;
    }
  }

  return { isPicPekerjaan, isInspector };
}

async function assertOperationsManagerActor(
  actorUserId: string,
  ctx: ExecutionScopeContext,
  requestedByUserId?: string,
): Promise<void> {
  await assertBuildingScopeAccess(actorUserId, ctx);
  const hasManage = await userHasPermissionCode(
    actorUserId,
    'tenant_company.manage',
  );
  if (!hasManage) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Only authorized Operations/Manager actors may perform this material purchasing approval or reconciliation action.',
    });
  }
  if (requestedByUserId && requestedByUserId === actorUserId) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Field requester may never self-approve or self-reconcile their own material purchase.',
    });
  }
}

async function assertFinanceReimbursementActor(
  actorUserId: string,
  ctx: ExecutionScopeContext,
  mode: 'read' | 'manage',
  forbiddenSelfUserIds: Array<string | null | undefined> = [],
): Promise<void> {
  await assertBuildingScopeAccess(actorUserId, ctx);
  const perms = await permissionService.resolvePermissionsForUser(actorUserId);
  const allowed =
    mode === 'manage'
      ? perms.includes('handyman.finance.manage')
      : perms.includes('handyman.finance.read') ||
        perms.includes('handyman.finance.manage');
  if (!allowed) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_FINANCE_FORBIDDEN,
      message:
        mode === 'manage'
          ? 'Missing required Finance authority: handyman.finance.manage.'
          : 'Missing required Finance read authority: handyman.finance.read.',
    });
  }
  for (const selfId of forbiddenSelfUserIds) {
    if (selfId && selfId === actorUserId) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_FINANCE_FORBIDDEN,
        message:
          'Finance actor may never self-approve, self-reject, or self-disburse their own worker reimbursement.',
      });
    }
  }
}

function assertExpectedVersion(
  record: HandymanMaterialPurchaseRecord,
  expectedVersion: unknown,
): void {
  if (expectedVersion === undefined || expectedVersion === null) {
    return;
  }
  const num = Number(expectedVersion);
  if (!Number.isInteger(num) || num < 1) {
    throw AppError.validation('expectedVersion must be a positive integer.');
  }
  if (record.version !== num) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_VERSION_CONFLICT,
      message: `Material purchase version conflict: expected ${num}, actual ${record.version}.`,
      details: [{ expectedVersion: num, actualVersion: record.version }],
    });
  }
}

export function computeMaterialLedgerSeparationSummary(
  executionScopeId: string,
  records: HandymanMaterialPurchaseRecord[],
): MaterialLedgerSeparationSummary {
  let reqQty = 0;
  let appQty = 0;
  let issQty = 0;
  let purQty = 0;
  let useQty = 0;
  let retQty = 0;

  let totalPurchaseExpense = 0;
  let totalNetUsedExpense = 0;
  let purchasedRecordsCount = 0;

  let totalReimbursementPayable = 0;
  let totalDisbursedAmount = 0;
  let pendingReconciliationCount = 0;
  let reconciledPayableCount = 0;
  let financeApprovedCount = 0;
  let disbursedCount = 0;
  let rejectedCount = 0;

  let eligibleRecordsCount = 0;
  let totalEligibleUsedQty = 0;
  let anyTenantInvoiced = false;

  const currency = records[0]?.currency ?? 'IDR';

  for (const r of records) {
    reqQty += Number(r.requestedQuantity);
    appQty += Number(r.approvedQuantity);
    issQty += Number(r.issuedQuantity);
    purQty += Number(r.purchasedQuantity);
    useQty += Number(r.usedQuantity);
    retQty += Number(r.returnedQuantity);

    if (Number(r.purchasedQuantity) > 0) {
      purchasedRecordsCount += 1;
      totalPurchaseExpense += Number(r.actualTotalExpenseAmount);
      totalNetUsedExpense += Number(r.netUsedExpenseAmount);
    }

    totalReimbursementPayable += Number(r.reimbursementPayableAmount);
    totalDisbursedAmount += Number(r.reimbursementDisbursedAmount);
    if (r.reimbursementStatus === 'PENDING_RECONCILIATION') {
      pendingReconciliationCount += 1;
    } else if (r.reimbursementStatus === 'RECONCILED_PAYABLE') {
      reconciledPayableCount += 1;
    } else if (r.reimbursementStatus === 'FINANCE_APPROVED') {
      financeApprovedCount += 1;
    } else if (r.reimbursementStatus === 'DISBURSED') {
      disbursedCount += 1;
    } else if (r.reimbursementStatus === 'REJECTED') {
      rejectedCount += 1;
    }

    if (r.tenantChargeEligible) {
      eligibleRecordsCount += 1;
      totalEligibleUsedQty += Number(r.tenantChargeEligibleQty);
    }
    if (r.tenantInvoiced) {
      anyTenantInvoiced = true;
    }
  }

  return {
    executionScopeId,
    operationalMaterialMovement: {
      totalRequestedQuantity: reqQty.toFixed(3),
      totalApprovedQuantity: appQty.toFixed(3),
      totalIssuedQuantity: issQty.toFixed(3),
      totalPurchasedQuantity: purQty.toFixed(3),
      totalUsedQuantity: useQty.toFixed(3),
      totalReturnedQuantity: retQty.toFixed(3),
    },
    actualSupplierPurchasingExpense: {
      currency,
      totalPurchaseExpenseAmount: totalPurchaseExpense.toFixed(2),
      totalNetUsedExpenseAmount: totalNetUsedExpense.toFixed(2),
      purchasedRecordsCount,
    },
    workerAdvanceReimbursementPayable: {
      currency,
      totalReimbursementPayableAmount: totalReimbursementPayable.toFixed(2),
      totalDisbursedAmount: totalDisbursedAmount.toFixed(2),
      pendingReconciliationCount,
      reconciledPayableCount,
      financeApprovedCount,
      disbursedCount,
      rejectedCount,
    },
    tenantInvoiceChargeEligibility: {
      eligibleRecordsCount,
      totalEligibleUsedQuantity: totalEligibleUsedQty.toFixed(3),
      anyTenantInvoiced,
    },
  };
}

/**
 * 1. REQUEST — Assigned PIC Pekerjaan submits a material / purchase request.
 */
export async function submitMaterialPurchaseRequest(
  actorUserId: string,
  executionScopeId: string,
  input: {
    workOrderId?: unknown;
    materialExecutionLineId?: unknown;
    sourceItemId?: unknown;
    itemName: unknown;
    uomId: unknown;
    uomCode?: unknown;
    fundingSource: unknown;
    requestedQuantity: unknown;
    supplierName?: unknown;
    supplierReference?: unknown;
    currency?: unknown;
    cashAdvanceReference?: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
  },
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );
  if (!isPicPekerjaan) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan (Crew Lead) for this Work Order may submit a material/purchase request.',
    });
  }

  const itemName = assertNonEmptyText(input.itemName, 'itemName', 250);
  const uomId = assertUuid(input.uomId, 'uomId');
  const uomCode =
    typeof input.uomCode === 'string' && input.uomCode.trim().length > 0
      ? input.uomCode.trim()
      : null;
  const fundingSource = assertFundingSource(input.fundingSource);
  const requestedQuantity = assertPositiveQuantity(
    input.requestedQuantity,
    'requestedQuantity',
  );
  const evidenceReference = assertNonEmptyText(
    input.evidenceReference,
    'evidenceReference',
    500,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const materialExecutionLineId =
    input.materialExecutionLineId !== undefined &&
    input.materialExecutionLineId !== null
      ? assertUuid(input.materialExecutionLineId, 'materialExecutionLineId')
      : null;
  const sourceItemId =
    input.sourceItemId !== undefined && input.sourceItemId !== null
      ? assertUuid(input.sourceItemId, 'sourceItemId')
      : null;
  const supplierName =
    typeof input.supplierName === 'string' &&
    input.supplierName.trim().length > 0
      ? input.supplierName.trim()
      : null;
  const supplierReference =
    typeof input.supplierReference === 'string' &&
    input.supplierReference.trim().length > 0
      ? input.supplierReference.trim()
      : null;
  const currency =
    typeof input.currency === 'string' && input.currency.trim().length > 0
      ? input.currency.trim().toUpperCase()
      : 'IDR';
  const cashAdvanceReference =
    typeof input.cashAdvanceReference === 'string' &&
    input.cashAdvanceReference.trim().length > 0
      ? input.cashAdvanceReference.trim()
      : null;
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const existing =
      await handymanMaterialPurchasingRepository.findByCreateIdempotencyKey(
        tx,
        ctx.executionScopeId,
        idempotencyKey,
      );
    if (existing) {
      if (
        existing.requestedByUserId !== actorUserId ||
        existing.fundingSource !== fundingSource ||
        existing.requestedQuantity !== requestedQuantity ||
        existing.uomId !== uomId ||
        existing.itemName !== itemName
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different material purchase request payload.',
        });
      }
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          existing.id,
          tx,
        );
      return { replayed: true, record: existing, events };
    }

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);
    const workOrderId = await resolveOptionalWorkOrderId(
      tx,
      ctx,
      input.workOrderId,
      null,
    );

    const record =
      await handymanMaterialPurchasingRepository.insertPurchaseRecord(tx, {
        id: randomUUID(),
        clientId: ctx.clientId,
        executionScopeId: ctx.executionScopeId,
        workOrderId,
        handymanRequestId: ctx.handymanRequestId,
        tenantCompanyId: ctx.tenantCompanyId,
        buildingId: ctx.buildingId,
        materialExecutionLineId,
        sourceItemId,
        itemName,
        uomId,
        uomCode,
        fundingSource,
        requestedQuantity,
        supplierName,
        supplierReference,
        currency,
        cashAdvanceReference,
        latestEvidenceReference: evidenceReference,
        requestedByUserId: actorUserId,
        createIdempotencyKey: idempotencyKey,
      });

    const ev = await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'REQUEST',
      fromStatus: null,
      toStatus: 'REQUEST',
      actorUserId,
      actorRole: 'PIC_PEKERJAAN',
      quantityDelta: requestedQuantity,
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        itemName,
        fundingSource,
        requestedQuantity,
        uomId,
        workOrderId,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_purchase.requested',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Material purchase requested (${itemName}, ${requestedQuantity}) via ${fundingSource}`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          fundingSource,
          requestedQuantity,
        },
      },
      tx,
    );

    return { replayed: false, record, events: [ev] };
  });
}

/**
 * 2. APPROVAL — Operations/Manager approves a material/purchase request.
 */
export async function approveMaterialPurchaseRequest(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  input: {
    approvedQuantity?: unknown;
    approvedMaxUnitPrice?: unknown;
    currency?: unknown;
    approvalReference: unknown;
    expenditureReference?: unknown;
    cashAdvanceReference?: unknown;
    evidenceReference?: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const approvalReference = assertNonEmptyText(
    input.approvalReference,
    'approvalReference',
    200,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    await assertOperationsManagerActor(
      actorUserId,
      ctx,
      record.requestedByUserId,
    );

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'APPROVAL',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (record.status !== 'REQUEST') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot approve material purchase record in status ${record.status}.`,
      });
    }

    const approvedQuantity =
      input.approvedQuantity !== undefined && input.approvedQuantity !== null
        ? assertPositiveQuantity(input.approvedQuantity, 'approvedQuantity')
        : record.requestedQuantity;
    const approvedMaxUnitPrice =
      input.approvedMaxUnitPrice !== undefined &&
      input.approvedMaxUnitPrice !== null
        ? assertNonNegativeAmount(
            input.approvedMaxUnitPrice,
            'approvedMaxUnitPrice',
          )
        : null;
    const currency =
      typeof input.currency === 'string' && input.currency.trim().length > 0
        ? input.currency.trim().toUpperCase()
        : record.currency;
    const expenditureReference =
      typeof input.expenditureReference === 'string' &&
      input.expenditureReference.trim().length > 0
        ? input.expenditureReference.trim()
        : record.expenditureReference;
    const cashAdvanceReference =
      typeof input.cashAdvanceReference === 'string' &&
      input.cashAdvanceReference.trim().length > 0
        ? input.cashAdvanceReference.trim()
        : record.cashAdvanceReference;

    if (record.fundingSource === 'CASH_ADVANCE' && !cashAdvanceReference) {
      throw AppError.validation(
        'cashAdvanceReference is required when fundingSource is CASH_ADVANCE.',
      );
    }

    const evidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : record.latestEvidenceReference;

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: 'APPROVAL',
        latestEvidenceReference: evidenceReference,
        approvedQuantity,
        approvedMaxUnitPrice,
        currency,
        approvalReference,
        expenditureReference,
        cashAdvanceReference,
        approvedByUserId: actorUserId,
      });

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'APPROVAL',
      fromStatus: 'REQUEST',
      toStatus: 'APPROVAL',
      actorUserId,
      actorRole: 'OPERATIONS_MANAGER',
      quantityDelta: approvedQuantity,
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        approvedQuantity,
        approvedMaxUnitPrice,
        approvalReference,
        expenditureReference,
        cashAdvanceReference,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_purchase.approved',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Material purchase request approved (${approvedQuantity}, ref ${approvalReference})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          approvedQuantity,
          approvalReference,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}

/**
 * 3A. ISSUE (Warehouse Stock Issue) — Records warehouse material issue for
 *     WAREHOUSE_STOCK funding source.
 */
export async function recordMaterialWarehouseIssue(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  input: {
    issuedQuantity: unknown;
    warehouseIssueReference?: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );
  const hasManage = await userHasPermissionCode(
    actorUserId,
    'tenant_company.manage',
  );
  if (!isPicPekerjaan && !hasManage) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan or Operations/Manager may record material warehouse issue.',
    });
  }

  const issuedQuantity = assertPositiveQuantity(
    input.issuedQuantity,
    'issuedQuantity',
  );
  const evidenceReference = assertNonEmptyText(
    input.evidenceReference,
    'evidenceReference',
    500,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const warehouseIssueReference =
    typeof input.warehouseIssueReference === 'string' &&
    input.warehouseIssueReference.trim().length > 0
      ? input.warehouseIssueReference.trim()
      : null;
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;
  const actorRole: 'PIC_PEKERJAAN' | 'OPERATIONS_MANAGER' = isPicPekerjaan
    ? 'PIC_PEKERJAAN'
    : 'OPERATIONS_MANAGER';

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'ISSUED',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (record.status !== 'APPROVAL') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot record warehouse issue from status ${record.status}. Requires APPROVAL.`,
      });
    }
    if (record.fundingSource !== 'WAREHOUSE_STOCK') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot record warehouse issue when fundingSource is ${record.fundingSource}. Use purchase endpoint instead.`,
      });
    }
    if (Number(issuedQuantity) > Number(record.approvedQuantity)) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Issued quantity (${issuedQuantity}) cannot exceed approved quantity (${record.approvedQuantity}).`,
      });
    }

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: 'ISSUED',
        latestEvidenceReference: evidenceReference,
        issuedQuantity,
        purchaseReference: warehouseIssueReference,
        actualUnitPrice: '0.00',
        actualTotalExpenseAmount: '0.00',
        netUsedExpenseAmount: '0.00',
        reimbursementPayableAmount: '0.00',
        reimbursementStatus: 'NOT_APPLICABLE',
      });

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'ISSUED',
      fromStatus: 'APPROVAL',
      toStatus: 'ISSUED',
      actorUserId,
      actorRole,
      quantityDelta: issuedQuantity,
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        issuedQuantity,
        warehouseIssueReference,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_purchase.issued',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Warehouse stock material issued (${issuedQuantity})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          issuedQuantity,
          warehouseIssueReference,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}

/**
 * 3B. PURCHASE (Actual Supplier Purchase) — Records supplier purchase with
 *     supplier, purchase ref, actual price, currency, purchase date, funding
 *     source, expenditure ref, and mandatory receipt evidence attachment.
 */
export async function recordMaterialSupplierPurchase(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  input: {
    workOrderId?: unknown;
    purchasedQuantity: unknown;
    supplierName: unknown;
    supplierReference?: unknown;
    purchaseReference: unknown;
    actualUnitPrice: unknown;
    currency?: unknown;
    purchaseDate: unknown;
    expenditureReference?: unknown;
    receiptEvidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );
  const hasManage = await userHasPermissionCode(
    actorUserId,
    'tenant_company.manage',
  );
  if (!isPicPekerjaan && !hasManage) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan or Operations/Manager may record a material purchase.',
    });
  }

  const purchasedQuantity = assertPositiveQuantity(
    input.purchasedQuantity,
    'purchasedQuantity',
  );
  const supplierName = assertNonEmptyText(
    input.supplierName,
    'supplierName',
    250,
  );
  const purchaseReference = assertNonEmptyText(
    input.purchaseReference,
    'purchaseReference',
    250,
  );
  const supplierReference =
    typeof input.supplierReference === 'string' &&
    input.supplierReference.trim().length > 0
      ? input.supplierReference.trim()
      : purchaseReference;
  const actualUnitPrice = assertNonNegativeAmount(
    input.actualUnitPrice,
    'actualUnitPrice',
  );
  const receiptEvidenceReference = assertNonEmptyText(
    input.receiptEvidenceReference,
    'receiptEvidenceReference',
    500,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );

  if (typeof input.purchaseDate !== 'string' || !input.purchaseDate.trim()) {
    throw AppError.validation('purchaseDate is required.');
  }
  const parsedPurchaseDate = new Date(input.purchaseDate);
  if (Number.isNaN(parsedPurchaseDate.getTime())) {
    throw AppError.validation('purchaseDate must be a valid ISO date/time.');
  }

  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;
  const actorRole: 'PIC_PEKERJAAN' | 'OPERATIONS_MANAGER' = isPicPekerjaan
    ? 'PIC_PEKERJAAN'
    : 'OPERATIONS_MANAGER';

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'PURCHASED',
        idempotencyKey,
      );
    if (existingEv) {
      if (
        record.purchasedQuantity !== purchasedQuantity ||
        record.actualUnitPrice !== actualUnitPrice
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different purchase quantity or unit price.',
        });
      }
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (record.status !== 'APPROVAL') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot record supplier purchase from status ${record.status}. Requires APPROVAL.`,
      });
    }
    if (record.fundingSource === 'WAREHOUSE_STOCK') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message:
          'Cannot record supplier purchase when fundingSource is WAREHOUSE_STOCK. Use issue endpoint instead.',
      });
    }
    if (Number(purchasedQuantity) > Number(record.approvedQuantity)) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Purchased quantity (${purchasedQuantity}) cannot exceed approved quantity (${record.approvedQuantity}).`,
      });
    }
    if (
      record.approvedMaxUnitPrice !== null &&
      Number(actualUnitPrice) > Number(record.approvedMaxUnitPrice)
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Actual unit price (${actualUnitPrice}) exceeds approved max unit price (${record.approvedMaxUnitPrice}).`,
      });
    }

    const currency =
      typeof input.currency === 'string' && input.currency.trim().length > 0
        ? input.currency.trim().toUpperCase()
        : record.currency;
    const expenditureReference =
      typeof input.expenditureReference === 'string' &&
      input.expenditureReference.trim().length > 0
        ? input.expenditureReference.trim()
        : record.expenditureReference;

    const actualTotalExpenseAmount = (
      Number(purchasedQuantity) * Number(actualUnitPrice)
    ).toFixed(2);

    // PART 01: ONLY worker personal out-of-pocket expenses ('REIMBURSEMENT')
    // may generate a reimbursement claim; Handyman cash advances ('CASH_ADVANCE')
    // and company funds ('PETTY_CASH', 'COMPANY_DIRECT') stay NOT_APPLICABLE.
    let reimbursementPayableAmount = '0.00';
    let reimbursementPayeeUserId: string | null = null;
    let clearReimbursementPayee = true;
    let reimbursementStatus: HandymanMaterialReimbursementStatus =
      'NOT_APPLICABLE';

    if (record.fundingSource === 'REIMBURSEMENT') {
      reimbursementPayableAmount = actualTotalExpenseAmount;
      reimbursementPayeeUserId = record.requestedByUserId;
      clearReimbursementPayee = false;
      reimbursementStatus = 'PENDING_RECONCILIATION';
    }

    const workOrderId = await resolveOptionalWorkOrderId(
      tx,
      ctx,
      input.workOrderId,
      record.workOrderId,
    );

    const verifiedReceipt = await assertVerifiedManagedEvidenceReference(
      tx,
      ctx,
      receiptEvidenceReference,
      { requiredPurpose: 'MATERIAL_RECEIPT' },
    );
    const receiptSha256Checksum = verifiedReceipt!.sha256Checksum;

    const dup =
      await handymanMaterialPurchasingRepository.findDuplicateReceiptOrInvoice(
        tx,
        {
          clientId: ctx.clientId,
          excludeRecordId: record.id,
          receiptEvidenceReference,
          receiptSha256Checksum,
          supplierName,
          purchaseReference,
        },
      );
    if (dup) {
      if (
        dup.executionScopeId !== ctx.executionScopeId ||
        (workOrderId && dup.workOrderId && dup.workOrderId !== workOrderId)
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM,
          message:
            'Receipt photo or supplier invoice reference has already been claimed on another Work Order.',
          details: [
            {
              conflictingPurchaseRecordId: dup.id,
              conflictingExecutionScopeId: dup.executionScopeId,
              matchedBy: dup.matchedBy,
            },
          ],
        });
      }
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_RECEIPT_DUPLICATE,
        message:
          'Duplicate receipt photo, receipt binary digest, or supplier invoice reference cannot be claimed more than once.',
        details: [
          {
            conflictingPurchaseRecordId: dup.id,
            matchedBy: dup.matchedBy,
          },
        ],
      });
    }

    let updated: HandymanMaterialPurchaseRecord;
    try {
      updated =
        await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
          purchaseRecordId: record.id,
          status: 'PURCHASED',
          latestEvidenceReference: receiptEvidenceReference,
          workOrderId,
          purchasedQuantity,
          supplierName,
          supplierReference,
          purchaseReference,
          purchaseDate: parsedPurchaseDate,
          currency,
          actualUnitPrice,
          actualTotalExpenseAmount,
          expenditureReference,
          receiptEvidenceReference,
          receiptSha256Checksum,
          reimbursementPayableAmount,
          reimbursementPayeeUserId,
          clearReimbursementPayee,
          reimbursementStatus,
        });
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_MATERIAL_RECEIPT_DUPLICATE,
          message:
            'Duplicate receipt photo, receipt binary digest, or supplier invoice reference rejected.',
        });
      }
      throw err;
    }

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'PURCHASED',
      fromStatus: 'APPROVAL',
      toStatus: 'PURCHASED',
      actorUserId,
      actorRole,
      quantityDelta: purchasedQuantity,
      evidenceReference: receiptEvidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        workOrderId,
        purchasedQuantity,
        supplierName,
        supplierReference,
        purchaseReference,
        actualUnitPrice,
        actualTotalExpenseAmount,
        currency,
        purchaseDate: parsedPurchaseDate.toISOString(),
        fundingSource: record.fundingSource,
        expenditureReference,
        receiptEvidenceReference,
        receiptSha256Checksum,
        reimbursementPayableAmount,
        reimbursementStatus,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_purchase.purchased',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Material purchased (${purchasedQuantity} @ ${actualUnitPrice} ${currency} = ${actualTotalExpenseAmount})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          purchasedQuantity,
          actualUnitPrice,
          actualTotalExpenseAmount,
          currency,
          fundingSource: record.fundingSource,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}

/**
 * 4. USAGE — Assigned PIC Pekerjaan records actual material usage.
 */
export async function recordMaterialPurchaseUsage(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  input: {
    usedQuantity: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );
  if (!isPicPekerjaan) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan (Crew Lead) may record actual material usage.',
    });
  }

  const usedDelta = assertPositiveQuantity(input.usedQuantity, 'usedQuantity');
  const evidenceReference = assertNonEmptyText(
    input.evidenceReference,
    'evidenceReference',
    500,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'USAGE',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (
      record.status !== 'ISSUED' &&
      record.status !== 'PURCHASED' &&
      record.status !== 'USAGE' &&
      record.status !== 'RETURN'
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot record material usage when status is ${record.status}.`,
      });
    }

    const acquiredQty =
      Number(record.issuedQuantity) + Number(record.purchasedQuantity);
    const nextUsedQty = Number(record.usedQuantity) + Number(usedDelta);
    const returnedQty = Number(record.returnedQuantity);

    if (Number((nextUsedQty + returnedQty).toFixed(3)) > acquiredQty) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Used (${nextUsedQty.toFixed(3)}) + returned (${returnedQty.toFixed(3)}) quantity cannot exceed acquired (${acquiredQty.toFixed(3)}) quantity.`,
      });
    }

    const unitPrice = Number(record.actualUnitPrice ?? 0);
    const netUsedExpenseAmount = (nextUsedQty * unitPrice).toFixed(2);

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: 'USAGE',
        latestEvidenceReference: evidenceReference,
        usedQuantity: nextUsedQty.toFixed(3),
        netUsedExpenseAmount,
      });

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'USAGE',
      fromStatus: record.status,
      toStatus: 'USAGE',
      actorUserId,
      actorRole: 'PIC_PEKERJAAN',
      quantityDelta: usedDelta,
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        usedDelta,
        cumulativeUsedQuantity: nextUsedQty.toFixed(3),
        netUsedExpenseAmount,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_purchase.used',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Material usage recorded (+${usedDelta}, total used ${nextUsedQty.toFixed(3)})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          usedDelta,
          cumulativeUsedQuantity: nextUsedQty.toFixed(3),
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}

/**
 * 5. RETURN — Assigned PIC Pekerjaan or Operations/Manager records unused
 *    material return.
 */
export async function recordMaterialPurchaseReturn(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  input: {
    returnedQuantity: unknown;
    returnDestination?: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );
  const hasManage = await userHasPermissionCode(
    actorUserId,
    'tenant_company.manage',
  );
  if (!isPicPekerjaan && !hasManage) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan or Operations/Manager may record unused material return.',
    });
  }

  const returnDelta = assertPositiveQuantity(
    input.returnedQuantity,
    'returnedQuantity',
  );
  const rawDest =
    typeof input.returnDestination === 'string' &&
    input.returnDestination.trim().length > 0
      ? input.returnDestination.trim().toUpperCase()
      : 'WAREHOUSE';
  if (
    !(HANDYMAN_MATERIAL_RETURN_DESTINATIONS as readonly string[]).includes(
      rawDest,
    )
  ) {
    throw AppError.validation(
      `returnDestination must be one of: ${HANDYMAN_MATERIAL_RETURN_DESTINATIONS.join(', ')}.`,
    );
  }
  const returnDestination = rawDest as HandymanMaterialReturnDestination;

  const evidenceReference = assertNonEmptyText(
    input.evidenceReference,
    'evidenceReference',
    500,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;
  const actorRole: 'PIC_PEKERJAAN' | 'OPERATIONS_MANAGER' = isPicPekerjaan
    ? 'PIC_PEKERJAAN'
    : 'OPERATIONS_MANAGER';

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'RETURN',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (
      record.status !== 'ISSUED' &&
      record.status !== 'PURCHASED' &&
      record.status !== 'USAGE' &&
      record.status !== 'RETURN'
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot record material return when status is ${record.status}.`,
      });
    }

    const acquiredQty =
      Number(record.issuedQuantity) + Number(record.purchasedQuantity);
    const usedQty = Number(record.usedQuantity);
    const nextReturnedQty =
      Number(record.returnedQuantity) + Number(returnDelta);

    if (Number((usedQty + nextReturnedQty).toFixed(3)) > acquiredQty) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Used (${usedQty.toFixed(3)}) + returned (${nextReturnedQty.toFixed(3)}) quantity cannot exceed acquired (${acquiredQty.toFixed(3)}) quantity.`,
      });
    }

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: 'RETURN',
        latestEvidenceReference: evidenceReference,
        returnedQuantity: nextReturnedQty.toFixed(3),
        returnDestination,
      });

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'RETURN',
      fromStatus: record.status,
      toStatus: 'RETURN',
      actorUserId,
      actorRole,
      quantityDelta: returnDelta,
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        returnDelta,
        cumulativeReturnedQuantity: nextReturnedQty.toFixed(3),
        returnDestination,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_purchase.returned',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Unused material returned (+${returnDelta} to ${returnDestination})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          returnDelta,
          cumulativeReturnedQuantity: nextReturnedQty.toFixed(3),
          returnDestination,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}

/**
 * 6. RECONCILIATION — Operations/Manager reconciles material usage + return,
 *    supplier expense, worker advance/reimbursement payable, and tenant
 *    charge eligibility (never auto-invoicing).
 */
export async function reconcileMaterialPurchase(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  input: {
    tenantChargeEligible?: unknown;
    reimbursementEligible?: unknown;
    reimbursementRejectionReason?: unknown;
    expenditureReference?: unknown;
    evidenceReference?: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
  separationSummary: MaterialLedgerSeparationSummary;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    await assertOperationsManagerActor(
      actorUserId,
      ctx,
      record.requestedByUserId,
    );

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'RECONCILIATION',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      const allRecords =
        await handymanMaterialPurchasingRepository.listByExecutionScope(
          ctx.executionScopeId,
          tx,
        );
      return {
        replayed: true,
        record,
        events,
        separationSummary: computeMaterialLedgerSeparationSummary(
          ctx.executionScopeId,
          allRecords,
        ),
      };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (record.status !== 'USAGE' && record.status !== 'RETURN') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot reconcile material purchase record from status ${record.status}. Requires USAGE or RETURN.`,
      });
    }

    const acquiredQty = Number(
      (
        Number(record.issuedQuantity) + Number(record.purchasedQuantity)
      ).toFixed(3),
    );
    const usedQty = Number(record.usedQuantity);
    const returnedQty = Number(record.returnedQuantity);
    const accountedQty = Number((usedQty + returnedQty).toFixed(3));

    if (usedQty <= 0 || accountedQty !== acquiredQty) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message: `Cannot reconcile material purchase: used (${usedQty.toFixed(3)}) + returned (${returnedQty.toFixed(3)}) must equal acquired (${acquiredQty.toFixed(3)}) quantity with usedQuantity > 0.`,
        details: [
          {
            acquiredQuantity: acquiredQty.toFixed(3),
            usedQuantity: usedQty.toFixed(3),
            returnedQuantity: returnedQty.toFixed(3),
            unaccountedQuantity: (acquiredQty - accountedQty).toFixed(3),
          },
        ],
      });
    }

    const tenantChargeEligible =
      input.tenantChargeEligible !== undefined
        ? Boolean(input.tenantChargeEligible)
        : true;
    const tenantChargeEligibleQty = tenantChargeEligible
      ? usedQty.toFixed(3)
      : '0.000';

    const expenditureReference =
      typeof input.expenditureReference === 'string' &&
      input.expenditureReference.trim().length > 0
        ? input.expenditureReference.trim()
        : record.expenditureReference;

    let reimbursementStatus: HandymanMaterialReimbursementStatus =
      'NOT_APPLICABLE';
    let reimbursementPayableAmount = '0.00';
    let clearReimbursementPayee = true;
    let reimbursementRejectedByUserId: string | null = null;
    let reimbursementRejectedAt: Date | null = null;
    let reimbursementRejectionReason: string | null = null;

    if (record.fundingSource === 'REIMBURSEMENT') {
      if (!record.receiptEvidenceReference) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
          message:
            'Personal out-of-pocket reimbursement requires a verified MATERIAL_RECEIPT photo.',
        });
      }
      await assertVerifiedManagedEvidenceReference(
        tx,
        ctx,
        record.receiptEvidenceReference,
        { requiredPurpose: 'MATERIAL_RECEIPT' },
      );

      clearReimbursementPayee = false;
      const eligible =
        input.reimbursementEligible !== undefined
          ? Boolean(input.reimbursementEligible)
          : true;

      if (!eligible) {
        const rawReason = input.reimbursementRejectionReason ?? notes;
        reimbursementRejectionReason = assertNonEmptyText(
          rawReason,
          'reimbursementRejectionReason',
          500,
        );
        reimbursementStatus = 'REJECTED';
        reimbursementPayableAmount = '0.00';
        reimbursementRejectedByUserId = actorUserId;
        reimbursementRejectedAt = new Date();
      } else {
        reimbursementStatus = 'RECONCILED_PAYABLE';
        // If unused material was returned to supplier, reimburse net used; if returned to warehouse/company custody, reimburse full supplier receipt expense.
        if (record.returnDestination === 'SUPPLIER_RETURN') {
          reimbursementPayableAmount = record.netUsedExpenseAmount;
        } else {
          reimbursementPayableAmount = record.actualTotalExpenseAmount;
        }
      }
    }

    const evidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : record.latestEvidenceReference;

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: 'RECONCILIATION',
        latestEvidenceReference: evidenceReference,
        expenditureReference,
        reimbursementPayableAmount,
        clearReimbursementPayee,
        reimbursementStatus,
        reimbursementRejectedByUserId,
        reimbursementRejectedAt,
        reimbursementRejectionReason,
        tenantChargeEligible,
        tenantChargeEligibleQty,
        reconciledByUserId: actorUserId,
        reconciledAt: new Date(),
      });

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'RECONCILIATION',
      fromStatus: record.status,
      toStatus: 'RECONCILIATION',
      actorUserId,
      actorRole: 'OPERATIONS_MANAGER',
      quantityDelta: '0.000',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        usedQuantity: record.usedQuantity,
        returnedQuantity: record.returnedQuantity,
        actualTotalExpenseAmount: record.actualTotalExpenseAmount,
        netUsedExpenseAmount: record.netUsedExpenseAmount,
        reimbursementPayableAmount,
        reimbursementStatus,
        tenantChargeEligible,
        tenantChargeEligibleQty,
        tenantInvoiced: false,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_purchase.reconciled',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Material purchase reconciled (used ${record.usedQuantity}, returned ${record.returnedQuantity})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          reimbursementPayableAmount,
          reimbursementStatus,
          tenantChargeEligible,
          tenantChargeEligibleQty,
          tenantInvoiced: false,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    const allRecords =
      await handymanMaterialPurchasingRepository.listByExecutionScope(
        ctx.executionScopeId,
        tx,
      );

    return {
      replayed: false,
      record: updated,
      events,
      separationSummary: computeMaterialLedgerSeparationSummary(
        ctx.executionScopeId,
        allRecords,
      ),
    };
  });
}

/**
 * Field Read: Assigned PIC Pekerjaan or Inspector reads material & purchase
 * history within their role scope.
 */
export async function listFieldMaterialPurchases(
  actorUserId: string,
  executionScopeId: string,
): Promise<{
  actorRole: 'PIC_PEKERJAAN' | 'INSPECTOR';
  records: Array<Record<string, unknown>>;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const { isPicPekerjaan, isInspector } =
    await resolveFieldRoleForExecutionScope(actorUserId, ctx);

  if (!isPicPekerjaan && !isInspector) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_FIELD_READ_FORBIDDEN,
      message:
        'User is not an authorized assigned PIC Pekerjaan or Inspector for this Work Order.',
    });
  }

  const records =
    await handymanMaterialPurchasingRepository.listByExecutionScope(
      ctx.executionScopeId,
    );
  const allEvents =
    await handymanMaterialPurchasingRepository.listEventsByExecutionScope(
      ctx.executionScopeId,
    );
  const eventsByRec = new Map<string, HandymanMaterialPurchaseEventRecord[]>();
  for (const ev of allEvents) {
    const arr = eventsByRec.get(ev.purchaseRecordId) ?? [];
    arr.push(ev);
    eventsByRec.set(ev.purchaseRecordId, arr);
  }

  if (isPicPekerjaan) {
    return {
      actorRole: 'PIC_PEKERJAAN',
      records: records.map((r) => projectFieldRecordForPic(r, eventsByRec.get(r.id) ?? [])),
    };
  }

  // Inspector receives operational material movement view without supplier expense / commercial pricing details
  return {
    actorRole: 'INSPECTOR',
    records: records.map((r) => projectFieldRecordForInspector(r)),
  };
}

function projectFieldRecordForPic(
  r: HandymanMaterialPurchaseRecord,
  events: HandymanMaterialPurchaseEventRecord[],
): Record<string, unknown> {
  return {
    id: r.id,
    executionScopeId: r.executionScopeId,
    workOrderId: r.workOrderId,
    handymanRequestId: r.handymanRequestId,
    materialExecutionLineId: r.materialExecutionLineId,
    sourceItemId: r.sourceItemId,
    itemName: r.itemName,
    uomId: r.uomId,
    uomCode: r.uomCode,
    fundingSource: r.fundingSource,
    status: r.status,
    requestedQuantity: r.requestedQuantity,
    approvedQuantity: r.approvedQuantity,
    issuedQuantity: r.issuedQuantity,
    purchasedQuantity: r.purchasedQuantity,
    usedQuantity: r.usedQuantity,
    returnedQuantity: r.returnedQuantity,
    returnDestination: r.returnDestination,
    supplierName: r.supplierName,
    supplierReference: r.supplierReference,
    purchaseReference: r.purchaseReference,
    purchaseDate: r.purchaseDate,
    currency: r.currency,
    actualUnitPrice: r.actualUnitPrice,
    actualTotalExpenseAmount: r.actualTotalExpenseAmount,
    netUsedExpenseAmount: r.netUsedExpenseAmount,
    cashAdvanceReference: r.cashAdvanceReference,
    receiptEvidenceReference: r.receiptEvidenceReference,
    receiptSha256Checksum: r.receiptSha256Checksum,
    latestEvidenceReference: r.latestEvidenceReference,
    reimbursementPayableAmount: r.reimbursementPayableAmount,
    reimbursementStatus: r.reimbursementStatus,
    reimbursementFinanceApprovalReference:
      r.reimbursementFinanceApprovalReference,
    reimbursementFinanceApprovedAt: r.reimbursementFinanceApprovedAt,
    reimbursementDisbursementReference: r.reimbursementDisbursementReference,
    reimbursementDisbursementMethod: r.reimbursementDisbursementMethod,
    reimbursementDisbursedAmount: r.reimbursementDisbursedAmount,
    reimbursementDisbursedAt: r.reimbursementDisbursedAt,
    reimbursementRejectionReason: r.reimbursementRejectionReason,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    events,
  };
}

function projectFieldRecordForInspector(
  r: HandymanMaterialPurchaseRecord,
): Record<string, unknown> {
  return {
    id: r.id,
    executionScopeId: r.executionScopeId,
    workOrderId: r.workOrderId,
    handymanRequestId: r.handymanRequestId,
    itemName: r.itemName,
    uomId: r.uomId,
    uomCode: r.uomCode,
    status: r.status,
    requestedQuantity: r.requestedQuantity,
    approvedQuantity: r.approvedQuantity,
    issuedQuantity: r.issuedQuantity,
    purchasedQuantity: r.purchasedQuantity,
    usedQuantity: r.usedQuantity,
    returnedQuantity: r.returnedQuantity,
    latestEvidenceReference: r.latestEvidenceReference,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Field Single-Record Read: Assigned PIC Pekerjaan or Inspector reads one
 * material purchase record within their role scope.
 */
export async function getFieldMaterialPurchase(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
): Promise<{
  actorRole: 'PIC_PEKERJAAN' | 'INSPECTOR';
  record: Record<string, unknown>;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const { isPicPekerjaan, isInspector } =
    await resolveFieldRoleForExecutionScope(actorUserId, ctx);

  if (!isPicPekerjaan && !isInspector) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_FIELD_READ_FORBIDDEN,
      message:
        'User is not an authorized assigned PIC Pekerjaan or Inspector for this Work Order.',
    });
  }

  const record = await handymanMaterialPurchasingRepository.findById(
    validRecordId,
    ctx.executionScopeId,
  );
  if (!record) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
      message: 'Handyman material purchase record not found.',
    });
  }

  if (isPicPekerjaan) {
    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(record.id);
    return {
      actorRole: 'PIC_PEKERJAAN',
      record: projectFieldRecordForPic(record, events),
    };
  }

  return {
    actorRole: 'INSPECTOR',
    record: projectFieldRecordForInspector(record),
  };
}

/**
 * Operations Single-Record Read: Full material purchase record + event history.
 */
export async function getOperationsMaterialPurchase(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
): Promise<{
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  await assertBuildingScopeAccess(actorUserId, ctx);

  const hasRead = await userHasPermissionCode(
    actorUserId,
    'tenant_company.read',
  );
  if (!hasRead) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message: 'Missing required permission: tenant_company.read.',
    });
  }

  const record = await handymanMaterialPurchasingRepository.findById(
    validRecordId,
    ctx.executionScopeId,
  );
  if (!record) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
      message: 'Handyman material purchase record not found.',
    });
  }
  const events = await handymanMaterialPurchasingRepository.listEventsByRecord(
    record.id,
  );
  return { record, events };
}

/**
 * Operations / Customer Care Read: Full material purchasing records, event
 * history, and 4-way ledger separation summary.
 */
export async function listOperationsMaterialPurchases(
  actorUserId: string,
  executionScopeId: string,
): Promise<{
  records: Array<
    HandymanMaterialPurchaseRecord & {
      events: HandymanMaterialPurchaseEventRecord[];
    }
  >;
  separationSummary: MaterialLedgerSeparationSummary;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  await assertBuildingScopeAccess(actorUserId, ctx);

  const hasRead = await userHasPermissionCode(
    actorUserId,
    'tenant_company.read',
  );
  if (!hasRead) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN,
      message: 'Missing required permission: tenant_company.read.',
    });
  }

  const records =
    await handymanMaterialPurchasingRepository.listByExecutionScope(
      ctx.executionScopeId,
    );
  const allEvents =
    await handymanMaterialPurchasingRepository.listEventsByExecutionScope(
      ctx.executionScopeId,
    );
  const eventsByRec = new Map<string, HandymanMaterialPurchaseEventRecord[]>();
  for (const ev of allEvents) {
    const arr = eventsByRec.get(ev.purchaseRecordId) ?? [];
    arr.push(ev);
    eventsByRec.set(ev.purchaseRecordId, arr);
  }

  return {
    records: records.map((r) => ({
      ...r,
      events: eventsByRec.get(r.id) ?? [],
    })),
    separationSummary: computeMaterialLedgerSeparationSummary(
      ctx.executionScopeId,
      records,
    ),
  };
}

/**
 * Finance Read (Execution Scope): Lists reimbursement-relevant material
 * purchases and 4-way ledger summary for a specific execution scope.
 */
export async function listScopeFinanceMaterialReimbursements(
  actorUserId: string,
  executionScopeId: string,
): Promise<{
  records: Array<
    HandymanMaterialPurchaseRecord & {
      events: HandymanMaterialPurchaseEventRecord[];
    }
  >;
  separationSummary: MaterialLedgerSeparationSummary;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  await assertFinanceReimbursementActor(actorUserId, ctx, 'read');

  const records =
    await handymanMaterialPurchasingRepository.listByExecutionScope(
      ctx.executionScopeId,
    );
  const allEvents =
    await handymanMaterialPurchasingRepository.listEventsByExecutionScope(
      ctx.executionScopeId,
    );
  const eventsByRec = new Map<string, HandymanMaterialPurchaseEventRecord[]>();
  for (const ev of allEvents) {
    const arr = eventsByRec.get(ev.purchaseRecordId) ?? [];
    arr.push(ev);
    eventsByRec.set(ev.purchaseRecordId, arr);
  }

  return {
    records: records
      .filter((r) => r.fundingSource === 'REIMBURSEMENT')
      .map((r) => ({
        ...r,
        events: eventsByRec.get(r.id) ?? [],
      })),
    separationSummary: computeMaterialLedgerSeparationSummary(
      ctx.executionScopeId,
      records,
    ),
  };
}

/**
 * Finance Read (Assigned Buildings Queue): Lists personal out-of-pocket worker
 * reimbursements strictly within Buildings assigned to the Finance actor.
 */
export async function listFinanceMaterialReimbursements(
  actorUserId: string,
  rawQuery: unknown,
): Promise<{
  items: Array<
    HandymanMaterialPurchaseRecord & {
      events: HandymanMaterialPurchaseEventRecord[];
    }
  >;
}> {
  const query = assertStrictBodyAllowlist(rawQuery ?? {}, [
    'buildingId',
    'executionScopeId',
    'workOrderId',
    'reimbursementStatus',
    'limit',
  ]);
  const perms = await permissionService.resolvePermissionsForUser(actorUserId);
  if (
    !perms.includes('handyman.finance.read') &&
    !perms.includes('handyman.finance.manage')
  ) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_FINANCE_FORBIDDEN,
      message: 'Missing required Finance read authority: handyman.finance.read.',
    });
  }

  const buildingId =
    query.buildingId !== undefined &&
    query.buildingId !== null &&
    query.buildingId !== ''
      ? assertUuid(query.buildingId, 'buildingId')
      : undefined;
  const executionScopeId =
    query.executionScopeId !== undefined &&
    query.executionScopeId !== null &&
    query.executionScopeId !== ''
      ? assertUuid(query.executionScopeId, 'executionScopeId')
      : undefined;
  const workOrderId =
    query.workOrderId !== undefined &&
    query.workOrderId !== null &&
    query.workOrderId !== ''
      ? assertUuid(query.workOrderId, 'workOrderId')
      : undefined;

  let reimbursementStatus: HandymanMaterialReimbursementStatus | undefined;
  if (
    query.reimbursementStatus !== undefined &&
    query.reimbursementStatus !== null &&
    query.reimbursementStatus !== ''
  ) {
    if (
      typeof query.reimbursementStatus !== 'string' ||
      !(HANDYMAN_MATERIAL_REIMBURSEMENT_STATUSES as readonly string[]).includes(
        query.reimbursementStatus,
      )
    ) {
      throw AppError.validation(
        `reimbursementStatus must be one of: ${HANDYMAN_MATERIAL_REIMBURSEMENT_STATUSES.join(', ')}.`,
      );
    }
    reimbursementStatus =
      query.reimbursementStatus as HandymanMaterialReimbursementStatus;
  }

  let limit: number | undefined;
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      throw AppError.validation('limit must be an integer between 1 and 200.');
    }
    limit = parsed;
  }

  const records =
    await handymanMaterialPurchasingRepository.listReimbursementsForFinanceActor(
      actorUserId,
      {
        buildingId,
        executionScopeId,
        workOrderId,
        reimbursementStatus,
        limit,
      },
    );
  const events =
    await handymanMaterialPurchasingRepository.listEventsByRecordIds(
      records.map((r) => r.id),
    );
  const eventsByRec = new Map<string, HandymanMaterialPurchaseEventRecord[]>();
  for (const ev of events) {
    const arr = eventsByRec.get(ev.purchaseRecordId) ?? [];
    arr.push(ev);
    eventsByRec.set(ev.purchaseRecordId, arr);
  }

  return {
    items: records.map((r) => ({
      ...r,
      events: eventsByRec.get(r.id) ?? [],
    })),
  };
}

/**
 * 7A. FINANCE REIMBURSEMENT APPROVAL — Authorized Finance actor (`handyman.finance.manage`)
 *     approves an Operations-verified (`RECONCILED_PAYABLE`) personal out-of-pocket
 *     worker reimbursement claim for disbursement.
 */
export async function approveMaterialPurchaseReimbursement(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  rawBody: unknown,
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const input = assertStrictBodyAllowlist(rawBody, [
    'approvalReference',
    'notes',
    'idempotencyKey',
    'expectedVersion',
  ]);
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const approvalReference = assertNonEmptyText(
    input.approvalReference,
    'approvalReference',
    200,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    await assertFinanceReimbursementActor(actorUserId, ctx, 'manage', [
      record.requestedByUserId,
      record.reimbursementPayeeUserId,
    ]);

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'REIMBURSEMENT_APPROVED',
        idempotencyKey,
      );
    if (existingEv) {
      if (
        record.reimbursementFinanceApprovalReference !== approvalReference
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different Finance reimbursement approvalReference.',
        });
      }
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (record.fundingSource !== 'REIMBURSEMENT') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_NOT_ELIGIBLE,
        message: `Funding source ${record.fundingSource} is not eligible for worker personal reimbursement.`,
      });
    }
    if (record.reimbursementStatus === 'DISBURSED') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED,
        message:
          'Worker reimbursement has already been disbursed and cannot be modified.',
      });
    }
    if (
      record.status !== 'RECONCILIATION' ||
      record.reimbursementStatus !== 'RECONCILED_PAYABLE' ||
      Number(record.reimbursementPayableAmount) <= 0
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_ILLEGAL_TRANSITION,
        message: `Cannot approve worker reimbursement when purchase status is ${record.status} and reimbursementStatus is ${record.reimbursementStatus}. Operations verification (RECONCILIATION / RECONCILED_PAYABLE) is required first.`,
      });
    }

    if (!record.receiptEvidenceReference) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
        message:
          'Cannot approve worker reimbursement without a verified MATERIAL_RECEIPT photo.',
      });
    }
    await assertVerifiedManagedEvidenceReference(
      tx,
      ctx,
      record.receiptEvidenceReference,
      { requiredPurpose: 'MATERIAL_RECEIPT' },
    );

    const approvedAt = new Date();
    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: record.status,
        latestEvidenceReference: record.latestEvidenceReference,
        reimbursementStatus: 'FINANCE_APPROVED',
        reimbursementFinanceApprovalReference: approvalReference,
        reimbursementFinanceApprovedByUserId: actorUserId,
        reimbursementFinanceApprovedAt: approvedAt,
      });

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'REIMBURSEMENT_APPROVED',
      fromStatus: record.status,
      toStatus: record.status,
      actorUserId,
      actorRole: 'FINANCE_MANAGER',
      quantityDelta: '0.000',
      evidenceReference: record.receiptEvidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        workOrderId: record.workOrderId,
        approvalReference,
        reimbursementPayableAmount: record.reimbursementPayableAmount,
        reimbursementPayeeUserId: record.reimbursementPayeeUserId,
        fromReimbursementStatus: record.reimbursementStatus,
        toReimbursementStatus: 'FINANCE_APPROVED',
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_reimbursement.approved',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Finance approved worker reimbursement (${record.reimbursementPayableAmount} ${record.currency}, ref ${approvalReference})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          workOrderId: record.workOrderId,
          approvalReference,
          reimbursementPayableAmount: record.reimbursementPayableAmount,
          reimbursementPayeeUserId: record.reimbursementPayeeUserId,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}

/**
 * 7B. FINANCE REIMBURSEMENT REJECTION — Authorized Finance actor (`handyman.finance.manage`)
 *     rejects an un-disbursed worker reimbursement claim with an explicit reason.
 */
export async function rejectMaterialPurchaseReimbursement(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  rawBody: unknown,
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const input = assertStrictBodyAllowlist(rawBody, [
    'reason',
    'notes',
    'idempotencyKey',
    'expectedVersion',
  ]);
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const reason = assertNonEmptyText(input.reason, 'reason', 500);
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : reason;

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    await assertFinanceReimbursementActor(actorUserId, ctx, 'manage', [
      record.requestedByUserId,
      record.reimbursementPayeeUserId,
    ]);

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'REIMBURSEMENT_REJECTED',
        idempotencyKey,
      );
    if (existingEv) {
      if (record.reimbursementRejectionReason !== reason) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different Finance reimbursement rejection reason.',
        });
      }
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (record.fundingSource !== 'REIMBURSEMENT') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_NOT_ELIGIBLE,
        message: `Funding source ${record.fundingSource} is not eligible for worker personal reimbursement.`,
      });
    }
    if (record.reimbursementStatus === 'DISBURSED') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED,
        message:
          'Worker reimbursement has already been disbursed and cannot be rejected.',
      });
    }
    if (
      record.status !== 'RECONCILIATION' ||
      (record.reimbursementStatus !== 'RECONCILED_PAYABLE' &&
        record.reimbursementStatus !== 'FINANCE_APPROVED')
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_ILLEGAL_TRANSITION,
        message: `Cannot reject worker reimbursement when purchase status is ${record.status} and reimbursementStatus is ${record.reimbursementStatus}.`,
      });
    }

    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: record.status,
        latestEvidenceReference: record.latestEvidenceReference,
        reimbursementStatus: 'REJECTED',
        reimbursementPayableAmount: '0.00',
        reimbursementRejectedByUserId: actorUserId,
        reimbursementRejectedAt: new Date(),
        reimbursementRejectionReason: reason,
      });

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'REIMBURSEMENT_REJECTED',
      fromStatus: record.status,
      toStatus: record.status,
      actorUserId,
      actorRole: 'FINANCE_MANAGER',
      quantityDelta: '0.000',
      evidenceReference:
        record.receiptEvidenceReference ?? record.latestEvidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        workOrderId: record.workOrderId,
        reason,
        previousReimbursementPayableAmount: record.reimbursementPayableAmount,
        fromReimbursementStatus: record.reimbursementStatus,
        toReimbursementStatus: 'REJECTED',
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_reimbursement.rejected',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Finance rejected worker reimbursement (${reason})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          workOrderId: record.workOrderId,
          reason,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}

/**
 * 7C. FINANCE REIMBURSEMENT DISBURSEMENT — Authorized Finance actor (`handyman.finance.manage`)
 *     records payout/disbursement of a Finance-approved worker reimbursement,
 *     preventing disbursement without prior approval and preventing double payment.
 */
export async function disburseMaterialPurchaseReimbursement(
  actorUserId: string,
  executionScopeId: string,
  purchaseRecordId: string,
  rawBody: unknown,
): Promise<{
  replayed: boolean;
  record: HandymanMaterialPurchaseRecord;
  events: HandymanMaterialPurchaseEventRecord[];
}> {
  const input = assertStrictBodyAllowlist(rawBody, [
    'disbursementReference',
    'disbursementMethod',
    'disbursedAmount',
    'evidenceReference',
    'notes',
    'idempotencyKey',
    'expectedVersion',
  ]);
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validRecordId = assertUuid(purchaseRecordId, 'purchaseRecordId');
  const disbursementReference = assertNonEmptyText(
    input.disbursementReference,
    'disbursementReference',
    200,
  );
  const rawMethod =
    typeof input.disbursementMethod === 'string' &&
    input.disbursementMethod.trim().length > 0
      ? input.disbursementMethod.trim().toUpperCase()
      : 'BANK_TRANSFER';
  if (
    !(HANDYMAN_REIMBURSEMENT_DISBURSEMENT_METHODS as readonly string[]).includes(
      rawMethod,
    )
  ) {
    throw AppError.validation(
      `disbursementMethod must be one of: ${HANDYMAN_REIMBURSEMENT_DISBURSEMENT_METHODS.join(', ')}.`,
    );
  }
  const disbursementMethod =
    rawMethod as HandymanReimbursementDisbursementMethod;
  const requestedDisbursedAmount =
    input.disbursedAmount !== undefined && input.disbursedAmount !== null
      ? assertNonNegativeAmount(input.disbursedAmount, 'disbursedAmount')
      : null;
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const record =
      await handymanMaterialPurchasingRepository.findByIdForUpdate(
        tx,
        validRecordId,
        ctx.executionScopeId,
      );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Handyman material purchase record not found.',
      });
    }

    await assertFinanceReimbursementActor(actorUserId, ctx, 'manage', [
      record.requestedByUserId,
      record.reimbursementPayeeUserId,
    ]);

    const existingEv =
      await handymanMaterialPurchasingRepository.findEventByIdempotencyKey(
        tx,
        record.id,
        'REIMBURSEMENT_DISBURSED',
        idempotencyKey,
      );
    if (existingEv) {
      if (
        record.reimbursementDisbursementReference !== disbursementReference ||
        record.reimbursementDisbursementMethod !== disbursementMethod ||
        (requestedDisbursedAmount !== null &&
          record.reimbursementDisbursedAmount !== requestedDisbursedAmount)
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different Finance disbursement payload.',
        });
      }
      const events =
        await handymanMaterialPurchasingRepository.listEventsByRecord(
          record.id,
          tx,
        );
      return { replayed: true, record, events };
    }

    if (record.fundingSource !== 'REIMBURSEMENT') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_NOT_ELIGIBLE,
        message: `Funding source ${record.fundingSource} is not eligible for worker personal reimbursement.`,
      });
    }

    if (record.reimbursementStatus === 'DISBURSED') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED,
        message:
          'Worker reimbursement has already been disbursed; double payment is prohibited.',
      });
    }

    if (
      record.status !== 'RECONCILIATION' ||
      record.reimbursementStatus !== 'FINANCE_APPROVED' ||
      !record.reimbursementFinanceApprovedByUserId ||
      !record.reimbursementFinanceApprovedAt
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_APPROVAL_REQUIRED,
        message: `Cannot disburse worker reimbursement when reimbursementStatus is ${record.reimbursementStatus}: Finance approval is required before disbursement.`,
      });
    }

    assertExpectedVersion(record, input.expectedVersion);

    if (
      requestedDisbursedAmount !== null &&
      requestedDisbursedAmount !== record.reimbursementPayableAmount
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_AMOUNT_MISMATCH,
        message: `disbursedAmount (${requestedDisbursedAmount}) must equal approved reimbursementPayableAmount (${record.reimbursementPayableAmount}).`,
      });
    }

    const dupDisb =
      await handymanMaterialPurchasingRepository.findDuplicateDisbursementReference(
        tx,
        {
          clientId: ctx.clientId,
          excludeRecordId: record.id,
          disbursementReference,
        },
      );
    if (dupDisb) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED,
        message:
          'disbursementReference has already been recorded on another worker reimbursement payout.',
      });
    }

    if (!record.receiptEvidenceReference) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
        message:
          'Cannot disburse worker reimbursement without a verified MATERIAL_RECEIPT photo.',
      });
    }
    await assertVerifiedManagedEvidenceReference(
      tx,
      ctx,
      record.receiptEvidenceReference,
      { requiredPurpose: 'MATERIAL_RECEIPT' },
    );

    const payoutEvidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : record.receiptEvidenceReference;
    if (payoutEvidenceReference !== record.receiptEvidenceReference) {
      await assertVerifiedManagedEvidenceReference(
        tx,
        ctx,
        payoutEvidenceReference,
      );
    }

    let updated: HandymanMaterialPurchaseRecord;
    try {
      updated =
        await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
          purchaseRecordId: record.id,
          status: record.status,
          latestEvidenceReference: payoutEvidenceReference,
          reimbursementStatus: 'DISBURSED',
          reimbursementDisbursementReference: disbursementReference,
          reimbursementDisbursementMethod: disbursementMethod,
          reimbursementDisbursedAmount: record.reimbursementPayableAmount,
          reimbursementDisbursedByUserId: actorUserId,
          reimbursementDisbursedAt: new Date(),
        });
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED,
          message:
            'disbursementReference has already been recorded on another worker reimbursement payout.',
        });
      }
      throw err;
    }

    await handymanMaterialPurchasingRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      purchaseRecordId: record.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'REIMBURSEMENT_DISBURSED',
      fromStatus: record.status,
      toStatus: record.status,
      actorUserId,
      actorRole: 'FINANCE_MANAGER',
      quantityDelta: '0.000',
      evidenceReference: payoutEvidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        workOrderId: record.workOrderId,
        disbursementReference,
        disbursementMethod,
        reimbursementDisbursedAmount: record.reimbursementPayableAmount,
        reimbursementPayeeUserId: record.reimbursementPayeeUserId,
        financeApprovalReference: record.reimbursementFinanceApprovalReference,
        fromReimbursementStatus: record.reimbursementStatus,
        toReimbursementStatus: 'DISBURSED',
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_material_reimbursement.disbursed',
        entityType: 'handyman_material_purchase_record',
        entityId: record.id,
        summary: `Finance disbursed worker reimbursement (${record.reimbursementPayableAmount} ${record.currency}, ref ${disbursementReference})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          workOrderId: record.workOrderId,
          disbursementReference,
          disbursementMethod,
          reimbursementDisbursedAmount: record.reimbursementPayableAmount,
          reimbursementPayeeUserId: record.reimbursementPayeeUserId,
        },
      },
      tx,
    );

    const events =
      await handymanMaterialPurchasingRepository.listEventsByRecord(
        record.id,
        tx,
      );
    return { replayed: false, record: updated, events };
  });
}
