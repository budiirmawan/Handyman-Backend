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
  HANDYMAN_MATERIAL_RETURN_DESTINATIONS,
  type HandymanMaterialFundingSource,
  type HandymanMaterialPurchaseEventRecord,
  type HandymanMaterialPurchaseRecord,
  type HandymanMaterialReimbursementStatus,
  type HandymanMaterialReturnDestination,
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
  let pendingReconciliationCount = 0;
  let reconciledPayableCount = 0;

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
    if (r.reimbursementStatus === 'PENDING_RECONCILIATION') {
      pendingReconciliationCount += 1;
    } else if (r.reimbursementStatus === 'RECONCILED_PAYABLE') {
      reconciledPayableCount += 1;
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
      pendingReconciliationCount,
      reconciledPayableCount,
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

    const record =
      await handymanMaterialPurchasingRepository.insertPurchaseRecord(tx, {
        id: randomUUID(),
        clientId: ctx.clientId,
        executionScopeId: ctx.executionScopeId,
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

    let reimbursementPayableAmount = '0.00';
    let reimbursementPayeeUserId: string | null = null;
    let reimbursementStatus: HandymanMaterialReimbursementStatus =
      'NOT_APPLICABLE';

    if (record.fundingSource === 'REIMBURSEMENT') {
      reimbursementPayableAmount = actualTotalExpenseAmount;
      reimbursementPayeeUserId = record.requestedByUserId;
      reimbursementStatus = 'PENDING_RECONCILIATION';
    } else if (record.fundingSource === 'CASH_ADVANCE') {
      reimbursementPayableAmount = '0.00';
      reimbursementPayeeUserId = record.requestedByUserId;
      reimbursementStatus = 'PENDING_RECONCILIATION';
    }

    await assertVerifiedManagedEvidenceReference(
      tx,
      ctx,
      receiptEvidenceReference,
    );

    const updated =
      await handymanMaterialPurchasingRepository.updatePurchaseRecord(tx, {
        purchaseRecordId: record.id,
        status: 'PURCHASED',
        latestEvidenceReference: receiptEvidenceReference,
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
        reimbursementPayableAmount,
        reimbursementPayeeUserId,
        reimbursementStatus,
      });

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
      record.reimbursementStatus;
    let reimbursementPayableAmount = record.reimbursementPayableAmount;
    if (record.fundingSource === 'REIMBURSEMENT') {
      reimbursementStatus = 'RECONCILED_PAYABLE';
      // If unused material was returned to supplier, reimburse net used; if returned to warehouse/company custody, reimburse full supplier receipt expense.
      if (record.returnDestination === 'SUPPLIER_RETURN') {
        reimbursementPayableAmount = record.netUsedExpenseAmount;
      } else {
        reimbursementPayableAmount = record.actualTotalExpenseAmount;
      }
    } else if (record.fundingSource === 'CASH_ADVANCE') {
      reimbursementStatus = 'RECONCILED_PAYABLE';
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
        reimbursementStatus,
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
      records: records.map((r) => ({
        id: r.id,
        executionScopeId: r.executionScopeId,
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
        receiptEvidenceReference: r.receiptEvidenceReference,
        latestEvidenceReference: r.latestEvidenceReference,
        reimbursementPayableAmount: r.reimbursementPayableAmount,
        reimbursementStatus: r.reimbursementStatus,
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        events: eventsByRec.get(r.id) ?? [],
      })),
    };
  }

  // Inspector receives operational material movement view without supplier expense / commercial pricing details
  return {
    actorRole: 'INSPECTOR',
    records: records.map((r) => ({
      id: r.id,
      executionScopeId: r.executionScopeId,
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
    })),
  };
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
