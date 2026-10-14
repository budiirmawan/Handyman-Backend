import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access/context-access.service';
import { permissionService } from '../permissions';
import { recordOperationalEvent } from '../operational-events';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments/handyman-scope-assignment.service';
import { findEligibleHandymanWorker } from '../handyman-providers/handyman-worker-eligibility.repository';
import { handymanScopeVariationRepository } from './handyman-scope-variation.repository';
import {
  HANDYMAN_SCOPE_VARIATION_LINE_TYPES,
  HANDYMAN_SCOPE_VARIATION_QC_OUTCOMES,
  HANDYMAN_SCOPE_VARIATION_TYPES,
  type FieldScopeVariationProjection,
  type HandymanScopeVariationActorRole,
  type HandymanScopeVariationEventRecord,
  type HandymanScopeVariationLineType,
  type HandymanScopeVariationQcOutcome,
  type HandymanScopeVariationRecord,
  type HandymanScopeVariationStatus,
  type HandymanScopeVariationTenantDecision,
  type HandymanScopeVariationType,
  type ReconciledAuthorizedScopeProjection,
} from './handyman-scope-variation.types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUTHORIZED_VARIATION_STATUSES: ReadonlySet<HandymanScopeVariationStatus> =
  new Set<HandymanScopeVariationStatus>([
    'AUTHORIZED_SCOPE',
    'EXECUTION',
    'QC',
    'FINAL_CHARGE_ELIGIBILITY',
  ]);

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

function assertNonNegativeAmount(
  value: unknown,
  field = 'quotedUnitAmount',
): string {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw AppError.validation(`${field} must be a non-negative amount.`);
  }
  return num.toFixed(2);
}

function assertVariationType(value: unknown): HandymanScopeVariationType {
  if (
    typeof value !== 'string' ||
    !(HANDYMAN_SCOPE_VARIATION_TYPES as readonly string[]).includes(value)
  ) {
    throw AppError.validation('variationType must be ADD or REDUCE.');
  }
  return value as HandymanScopeVariationType;
}

function assertLineType(value: unknown): HandymanScopeVariationLineType {
  if (
    typeof value !== 'string' ||
    !(HANDYMAN_SCOPE_VARIATION_LINE_TYPES as readonly string[]).includes(value)
  ) {
    throw AppError.validation('lineType must be LABOR or MATERIAL.');
  }
  return value as HandymanScopeVariationLineType;
}

interface ExecutionScopeContext {
  executionScopeId: string;
  clientId: string;
  handymanRequestId: string;
  tenantCompanyId: string;
  buildingId: string;
  approvedQuotationVersionId: string;
}

interface OriginalQuotationLineRow {
  id: string;
  lineType: string;
  description: string;
  quantity: string;
  uomId: string;
}

async function listOriginalQuotationLines(
  quotationVersionId: string,
  tx?: PoolClient,
): Promise<OriginalQuotationLineRow[]> {
  const db = tx ?? getPool();
  const res = await db.query<{
    id: string;
    line_type: string;
    description: string;
    quantity: string;
    uom_id: string;
  }>(
    `SELECT id,
            line_type,
            description,
            quantity::text AS quantity,
            uom_id
       FROM handyman_quotation_lines
      WHERE quotation_version_id = $1
      ORDER BY created_at ASC, id ASC`,
    [quotationVersionId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    lineType: r.line_type,
    description: r.description,
    quantity: r.quantity,
    uomId: r.uom_id,
  }));
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
    approved_quotation_version_id: string;
  }>(
    `SELECT id,
            client_id,
            handyman_request_id,
            tenant_company_id,
            building_id,
            approved_quotation_version_id
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
    approvedQuotationVersionId: scope.approved_quotation_version_id,
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

async function userHasPermissionCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  return permissions.includes(code);
}

async function assertOperationsManagerForExecutionScope(
  actorUserId: string,
  ctx: ExecutionScopeContext,
  originActorUserId?: string,
): Promise<void> {
  await assertBuildingScopeAccess(actorUserId, ctx);
  const hasManage = await userHasPermissionCode(
    actorUserId,
    'tenant_company.manage',
  );
  if (!hasManage) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message:
        'Only authorized Operations/Manager actors may perform this scope variation review action.',
    });
  }
  if (originActorUserId && originActorUserId === actorUserId) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message:
        'Originating field worker may never self-approve or review their own scope variation.',
    });
  }
}

async function assertAuthorizedTenantDecisionActor(
  actorUserId: string,
  ctx: ExecutionScopeContext,
  tx: PoolClient,
): Promise<void> {
  await assertBuildingScopeAccess(actorUserId, ctx);

  // Check if actor is the linked Tenant PIC user for this service request.
  const res = await tx.query<{
    tenant_pic_user_id: string | null;
    tenant_pic_status: string | null;
  }>(
    `SELECT tp.user_id AS tenant_pic_user_id,
            tp.status AS tenant_pic_status
       FROM handyman_service_requests r
       LEFT JOIN tenant_pics tp
         ON tp.id = r.tenant_pic_id
        AND tp.client_id = r.client_id
        AND tp.tenant_company_id = r.tenant_company_id
      WHERE r.id = $1
        AND r.client_id = $2`,
    [ctx.handymanRequestId, ctx.clientId],
  );
  const row = res.rows[0];
  const isAuthorizedTenantPic =
    row &&
    row.tenant_pic_user_id === actorUserId &&
    row.tenant_pic_status === 'ACTIVE';

  if (isAuthorizedTenantPic) {
    return;
  }

  // Check if an Operations/Manager actor is trying to impersonate Tenant consent.
  const hasManage = await userHasPermissionCode(
    actorUserId,
    'tenant_company.manage',
  );
  if (hasManage) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_TENANT_IMPERSONATION_FORBIDDEN,
      message:
        'Operations/Manager may never impersonate Tenant consent on a scope variation.',
    });
  }

  throw new AppError({
    statusCode: 403,
    code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
    message:
      'Only the authorized Tenant PIC user for this service request may record a tenant variation decision.',
  });
}

async function validateReduceTargetAndRemainingQuantity(
  tx: PoolClient,
  ctx: ExecutionScopeContext,
  input: {
    targetQuotationLineId: string | null;
    lineType: HandymanScopeVariationLineType;
    uomId: string;
    requestedQuantity: string;
    excludeVariationId?: string;
    authorizedOnly?: boolean;
  },
): Promise<{
  originalQuantity: number;
  alreadyReducedQuantity: number;
  remainingQuantityBeforeThis: number;
}> {
  if (!input.targetQuotationLineId) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_VARIATION_TARGET_LINE_INVALID,
      message:
        'REDUCE variation requires targetQuotationLineId referencing an original approved quotation line.',
    });
  }

  const validLineId = assertUuid(
    input.targetQuotationLineId,
    'targetQuotationLineId',
  );
  const originalLines = await listOriginalQuotationLines(
    ctx.approvedQuotationVersionId,
    tx,
  );
  const targetLine = originalLines.find((l) => l.id === validLineId);
  if (!targetLine) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_VARIATION_TARGET_LINE_INVALID,
      message:
        'targetQuotationLineId does not belong to the execution scope original approved quotation version.',
    });
  }
  if (targetLine.lineType !== input.lineType) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_VARIATION_TARGET_LINE_INVALID,
      message: `targetQuotationLineId has lineType ${targetLine.lineType}, which does not match variation lineType ${input.lineType}.`,
    });
  }
  if (targetLine.uomId !== input.uomId) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_VARIATION_TARGET_LINE_INVALID,
      message:
        'targetQuotationLineId uomId does not match the variation uomId.',
    });
  }

  // Lock all variations on this execution scope to prevent concurrent over-reduction.
  const existingVars =
    await handymanScopeVariationRepository.listByExecutionScope(
      ctx.executionScopeId,
      tx,
    );

  let alreadyReducedQuantity = 0;
  for (const v of existingVars) {
    if (v.id === input.excludeVariationId) continue;
    if (v.variationType !== 'REDUCE') continue;
    if (v.targetQuotationLineId !== validLineId) continue;

    if (input.authorizedOnly) {
      if (AUTHORIZED_VARIATION_STATUSES.has(v.status)) {
        alreadyReducedQuantity += Number(v.quantity);
      }
    } else {
      const isRejected =
        v.status === 'TENANT_DECISION' &&
        v.tenantDecisionOutcome === 'REJECTED';
      if (!isRejected) {
        alreadyReducedQuantity += Number(v.quantity);
      }
    }
  }

  const originalQuantity = Number(targetLine.quantity);
  const remainingQuantityBeforeThis = Number(
    (originalQuantity - alreadyReducedQuantity).toFixed(3),
  );
  const reqQty = Number(input.requestedQuantity);

  if (reqQty > remainingQuantityBeforeThis) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_REDUCE_EXCEEDS_REMAINING,
      message: `Requested reduction quantity (${reqQty.toFixed(3)}) exceeds remaining available quantity (${remainingQuantityBeforeThis.toFixed(3)}) on original quotation line.`,
      details: [
        {
          targetQuotationLineId: validLineId,
          originalQuantity: originalQuantity.toFixed(3),
          alreadyReducedQuantity: alreadyReducedQuantity.toFixed(3),
          remainingAvailableQuantity: remainingQuantityBeforeThis.toFixed(3),
          requestedQuantity: reqQty.toFixed(3),
        },
      ],
    });
  }

  return {
    originalQuantity,
    alreadyReducedQuantity,
    remainingQuantityBeforeThis,
  };
}

function assertExpectedVersion(
  variation: HandymanScopeVariationRecord,
  expectedVersion: unknown,
): void {
  if (expectedVersion === undefined || expectedVersion === null) {
    return;
  }
  const num = Number(expectedVersion);
  if (!Number.isInteger(num) || num < 1) {
    throw AppError.validation(
      'expectedVersion must be a positive integer.',
    );
  }
  if (variation.version !== num) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_VERSION_CONFLICT,
      message: `Variation version conflict: expected ${num}, actual ${variation.version}.`,
      details: [
        {
          expectedVersion: num,
          actualVersion: variation.version,
        },
      ],
    });
  }
}

function stripCommercialForField(
  v: HandymanScopeVariationRecord,
  events: HandymanScopeVariationEventRecord[],
): FieldScopeVariationProjection {
  return {
    id: v.id,
    executionScopeId: v.executionScopeId,
    handymanRequestId: v.handymanRequestId,
    variationType: v.variationType,
    lineType: v.lineType,
    targetQuotationLineId: v.targetQuotationLineId,
    title: v.title,
    description: v.description,
    technicalFinding: v.technicalFinding,
    quantity: v.quantity,
    uomId: v.uomId,
    status: v.status,
    tenantDecisionOutcome: v.tenantDecisionOutcome,
    qcOutcome: v.qcOutcome,
    originActorUserId: v.originActorUserId,
    originActorRole: v.originActorRole,
    latestEvidenceReference: v.latestEvidenceReference,
    version: v.version,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    events: events.map((e) => ({
      ...e,
      metadata: {
        variationType: e.metadata.variationType ?? v.variationType,
        quantity: e.metadata.quantity ?? v.quantity,
        decisionOutcome: e.metadata.decisionOutcome ?? undefined,
        qcOutcome: e.metadata.qcOutcome ?? undefined,
      },
    })),
  };
}

export async function buildReconciledAuthorizedScopeProjection(
  ctx: ExecutionScopeContext,
  tx?: PoolClient,
): Promise<ReconciledAuthorizedScopeProjection> {
  const originalLines = await listOriginalQuotationLines(
    ctx.approvedQuotationVersionId,
    tx,
  );
  const variations =
    await handymanScopeVariationRepository.listByExecutionScope(
      ctx.executionScopeId,
      tx,
    );

  const reducedByLineId = new Map<string, number>();
  for (const v of variations) {
    if (
      v.variationType === 'REDUCE' &&
      v.targetQuotationLineId &&
      AUTHORIZED_VARIATION_STATUSES.has(v.status)
    ) {
      const prev = reducedByLineId.get(v.targetQuotationLineId) ?? 0;
      reducedByLineId.set(v.targetQuotationLineId, prev + Number(v.quantity));
    }
  }

  const reconciledOriginalLines = originalLines.map((line, idx) => {
    const origQty = Number(line.quantity);
    const reducedQty = reducedByLineId.get(line.id) ?? 0;
    const remainingQty = Math.max(0, origQty - reducedQty);
    return {
      quotationLineId: line.id,
      lineNumber: idx + 1,
      lineType: line.lineType,
      description: line.description,
      uomId: line.uomId,
      originalQuantity: origQty.toFixed(3),
      authorizedReducedQuantity: reducedQty.toFixed(3),
      remainingAuthorizedQuantity: remainingQty.toFixed(3),
    };
  });

  const authorizedAddedItems = variations
    .filter(
      (v) =>
        v.variationType === 'ADD' &&
        AUTHORIZED_VARIATION_STATUSES.has(v.status),
    )
    .map((v) => ({
      variationId: v.id,
      lineType: v.lineType,
      title: v.title,
      description: v.description,
      quantity: v.quantity,
      uomId: v.uomId,
      status: v.status,
      qcOutcome: v.qcOutcome,
      finalChargeEligible: v.finalChargeEligible,
      invoiced: v.invoiced,
    }));

  const rejectedVariationsCount = variations.filter(
    (v) =>
      v.status === 'TENANT_DECISION' && v.tenantDecisionOutcome === 'REJECTED',
  ).length;

  const pendingVariationsCount = variations.filter(
    (v) =>
      !AUTHORIZED_VARIATION_STATUSES.has(v.status) &&
      !(
        v.status === 'TENANT_DECISION' &&
        v.tenantDecisionOutcome === 'REJECTED'
      ),
  ).length;

  const finalChargeEligibleVariationsCount = variations.filter(
    (v) => v.status === 'FINAL_CHARGE_ELIGIBILITY' && v.finalChargeEligible,
  ).length;

  return {
    executionScopeId: ctx.executionScopeId,
    approvedQuotationVersionId: ctx.approvedQuotationVersionId,
    originalApprovedLinesImmutable: true,
    reconciledOriginalLines,
    authorizedAddedItems,
    pendingVariationsCount,
    rejectedVariationsCount,
    finalChargeEligibleVariationsCount,
  };
}

/**
 * 1. FIELD_FINDING — Inspector or PIC Pekerjaan records a field finding /
 *    technical scope recommendation.
 */
export async function submitFieldFindingVariation(
  actorUserId: string,
  executionScopeId: string,
  input: {
    variationType: unknown;
    lineType: unknown;
    targetQuotationLineId?: unknown;
    title: unknown;
    description: unknown;
    technicalFinding: unknown;
    quantity: unknown;
    uomId: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: FieldScopeVariationProjection;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const { isPicPekerjaan, isInspector } =
    await resolveFieldRoleForExecutionScope(actorUserId, ctx);

  if (!isInspector && !isPicPekerjaan) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message:
        'Only the assigned Inspector or PIC Pekerjaan for this Work Order may submit a field finding.',
    });
  }

  const originActorRole: 'PIC_PEKERJAAN' | 'INSPECTOR' = isInspector
    ? 'INSPECTOR'
    : 'PIC_PEKERJAAN';

  const variationType = assertVariationType(input.variationType);
  const lineType = assertLineType(input.lineType);
  const title = assertNonEmptyText(input.title, 'title', 200);
  const description = assertNonEmptyText(
    input.description,
    'description',
    1000,
  );
  const technicalFinding = assertNonEmptyText(
    input.technicalFinding,
    'technicalFinding',
    1000,
  );
  const quantity = assertPositiveQuantity(input.quantity, 'quantity');
  const uomId = assertUuid(input.uomId, 'uomId');
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
  const targetQuotationLineId =
    input.targetQuotationLineId !== undefined &&
    input.targetQuotationLineId !== null
      ? assertUuid(input.targetQuotationLineId, 'targetQuotationLineId')
      : null;
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const existing =
      await handymanScopeVariationRepository.findByCreateIdempotencyKey(
        tx,
        ctx.executionScopeId,
        idempotencyKey,
      );
    if (existing) {
      if (
        existing.originActorUserId !== actorUserId ||
        existing.variationType !== variationType ||
        existing.lineType !== lineType ||
        existing.quantity !== quantity ||
        existing.uomId !== uomId ||
        existing.targetQuotationLineId !== targetQuotationLineId
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different variation payload.',
        });
      }
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          existing.id,
          tx,
        );
      return {
        replayed: true,
        variation: stripCommercialForField(existing, events),
      };
    }

    if (variationType === 'REDUCE') {
      await validateReduceTargetAndRemainingQuantity(tx, ctx, {
        targetQuotationLineId,
        lineType,
        uomId,
        requestedQuantity: quantity,
      });
    }

    const variation = await handymanScopeVariationRepository.insertVariation(
      tx,
      {
        id: randomUUID(),
        clientId: ctx.clientId,
        executionScopeId: ctx.executionScopeId,
        handymanRequestId: ctx.handymanRequestId,
        tenantCompanyId: ctx.tenantCompanyId,
        buildingId: ctx.buildingId,
        variationType,
        lineType,
        targetQuotationLineId,
        title,
        description,
        technicalFinding,
        quantity,
        uomId,
        status: 'FIELD_FINDING',
        originActorUserId: actorUserId,
        originActorRole,
        latestEvidenceReference: evidenceReference,
        createIdempotencyKey: idempotencyKey,
      },
    );

    const ev = await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'FIELD_FINDING',
      fromStatus: null,
      toStatus: 'FIELD_FINDING',
      actorUserId,
      actorRole: originActorRole,
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        variationType,
        lineType,
        quantity,
        targetQuotationLineId,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.field_finding_submitted',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Field finding submitted for ${variationType} scope variation`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          variationType,
          originActorRole,
          quantity,
        },
      },
      tx,
    );

    return {
      replayed: false,
      variation: stripCommercialForField(variation, [ev]),
    };
  });
}

/**
 * 2A. PROPOSAL (Create directly) — PIC Pekerjaan proposes a variation
 *     (Pekerjaan Tambah / Kurang). Inspector is forbidden from proposing.
 */
export async function proposeScopeVariation(
  actorUserId: string,
  executionScopeId: string,
  input: {
    variationType: unknown;
    lineType: unknown;
    targetQuotationLineId?: unknown;
    title: unknown;
    description: unknown;
    technicalFinding: unknown;
    quantity: unknown;
    uomId: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: FieldScopeVariationProjection;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );

  if (!isPicPekerjaan) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan (Crew Lead) may propose a scope variation.',
    });
  }

  const variationType = assertVariationType(input.variationType);
  const lineType = assertLineType(input.lineType);
  const title = assertNonEmptyText(input.title, 'title', 200);
  const description = assertNonEmptyText(
    input.description,
    'description',
    1000,
  );
  const technicalFinding = assertNonEmptyText(
    input.technicalFinding,
    'technicalFinding',
    1000,
  );
  const quantity = assertPositiveQuantity(input.quantity, 'quantity');
  const uomId = assertUuid(input.uomId, 'uomId');
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
  const targetQuotationLineId =
    input.targetQuotationLineId !== undefined &&
    input.targetQuotationLineId !== null
      ? assertUuid(input.targetQuotationLineId, 'targetQuotationLineId')
      : null;
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    const existing =
      await handymanScopeVariationRepository.findByCreateIdempotencyKey(
        tx,
        ctx.executionScopeId,
        idempotencyKey,
      );
    if (existing) {
      if (
        existing.originActorUserId !== actorUserId ||
        existing.variationType !== variationType ||
        existing.lineType !== lineType ||
        existing.quantity !== quantity ||
        existing.uomId !== uomId ||
        existing.targetQuotationLineId !== targetQuotationLineId
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different variation payload.',
        });
      }
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          existing.id,
          tx,
        );
      return {
        replayed: true,
        variation: stripCommercialForField(existing, events),
      };
    }

    if (variationType === 'REDUCE') {
      await validateReduceTargetAndRemainingQuantity(tx, ctx, {
        targetQuotationLineId,
        lineType,
        uomId,
        requestedQuantity: quantity,
      });
    }

    const variation = await handymanScopeVariationRepository.insertVariation(
      tx,
      {
        id: randomUUID(),
        clientId: ctx.clientId,
        executionScopeId: ctx.executionScopeId,
        handymanRequestId: ctx.handymanRequestId,
        tenantCompanyId: ctx.tenantCompanyId,
        buildingId: ctx.buildingId,
        variationType,
        lineType,
        targetQuotationLineId,
        title,
        description,
        technicalFinding,
        quantity,
        uomId,
        status: 'PROPOSAL',
        originActorUserId: actorUserId,
        originActorRole: 'PIC_PEKERJAAN',
        latestEvidenceReference: evidenceReference,
        createIdempotencyKey: idempotencyKey,
      },
    );

    const findingEvent = await handymanScopeVariationRepository.insertEvent(
      tx,
      {
        id: randomUUID(),
        clientId: ctx.clientId,
        variationId: variation.id,
        executionScopeId: ctx.executionScopeId,
        eventType: 'FIELD_FINDING',
        fromStatus: null,
        toStatus: 'FIELD_FINDING',
        actorUserId,
        actorRole: 'PIC_PEKERJAAN',
        evidenceReference,
        notes,
        idempotencyKey: `${idempotencyKey}:finding`,
        metadata: {
          variationType,
          lineType,
          quantity,
          targetQuotationLineId,
        },
      },
    );

    const proposalEvent = await handymanScopeVariationRepository.insertEvent(
      tx,
      {
        id: randomUUID(),
        clientId: ctx.clientId,
        variationId: variation.id,
        executionScopeId: ctx.executionScopeId,
        eventType: 'PROPOSAL',
        fromStatus: 'FIELD_FINDING',
        toStatus: 'PROPOSAL',
        actorUserId,
        actorRole: 'PIC_PEKERJAAN',
        evidenceReference,
        notes,
        idempotencyKey,
        metadata: {
          variationType,
          lineType,
          quantity,
          targetQuotationLineId,
        },
      },
    );

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.proposed',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Scope variation (${variationType}) proposed by PIC Pekerjaan`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          variationType,
          quantity,
        },
      },
      tx,
    );

    return {
      replayed: false,
      variation: stripCommercialForField(variation, [
        findingEvent,
        proposalEvent,
      ]),
    };
  });
}

/**
 * 2B. PROPOSAL (Promote existing FIELD_FINDING -> PROPOSAL) — PIC Pekerjaan only.
 */
export async function promoteFieldFindingToProposal(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    evidenceReference?: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: FieldScopeVariationProjection;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );
  if (!isPicPekerjaan) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan (Crew Lead) may promote a field finding to a variation proposal.',
    });
  }

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
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'PROPOSAL',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return {
        replayed: true,
        variation: stripCommercialForField(variation, events),
      };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    if (variation.status !== 'FIELD_FINDING') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Cannot transition variation from ${variation.status} to PROPOSAL.`,
      });
    }

    const evidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : variation.latestEvidenceReference;

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'PROPOSAL',
        latestEvidenceReference: evidenceReference,
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'PROPOSAL',
      fromStatus: 'FIELD_FINDING',
      toStatus: 'PROPOSAL',
      actorUserId,
      actorRole: 'PIC_PEKERJAAN',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        variationType: variation.variationType,
        quantity: variation.quantity,
      },
    });

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );

    return {
      replayed: false,
      variation: stripCommercialForField(updated, events),
    };
  });
}

/**
 * 3. OPERATIONS_REVIEW — Operations/Manager reviews FIELD_FINDING or PROPOSAL.
 */
export async function reviewScopeVariation(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    targetQuotationLineId?: unknown;
    evidenceReference?: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: HandymanScopeVariationRecord;
  events: HandymanScopeVariationEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');
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
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    await assertOperationsManagerForExecutionScope(
      actorUserId,
      ctx,
      variation.originActorUserId,
    );

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'OPERATIONS_REVIEW',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return { replayed: true, variation, events };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    if (
      variation.status !== 'FIELD_FINDING' &&
      variation.status !== 'PROPOSAL'
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Cannot transition variation from ${variation.status} to OPERATIONS_REVIEW.`,
      });
    }

    const effectiveTargetLineId =
      input.targetQuotationLineId !== undefined &&
      input.targetQuotationLineId !== null
        ? assertUuid(input.targetQuotationLineId, 'targetQuotationLineId')
        : variation.targetQuotationLineId;

    if (variation.variationType === 'REDUCE') {
      await validateReduceTargetAndRemainingQuantity(tx, ctx, {
        targetQuotationLineId: effectiveTargetLineId,
        lineType: variation.lineType,
        uomId: variation.uomId,
        requestedQuantity: variation.quantity,
        excludeVariationId: variation.id,
      });
    }

    const evidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : variation.latestEvidenceReference;

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'OPERATIONS_REVIEW',
        latestEvidenceReference: evidenceReference,
        targetQuotationLineId: effectiveTargetLineId,
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'OPERATIONS_REVIEW',
      fromStatus: variation.status,
      toStatus: 'OPERATIONS_REVIEW',
      actorUserId,
      actorRole: 'OPERATIONS_MANAGER',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        variationType: variation.variationType,
        targetQuotationLineId: effectiveTargetLineId,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.operations_reviewed',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Scope variation (${variation.variationType}) reviewed by Operations`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          variationType: variation.variationType,
        },
      },
      tx,
    );

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );
    return { replayed: false, variation: updated, events };
  });
}

/**
 * 4. REVISED_QUOTATION — Operations/Manager prepares commercial revision
 *    (unit amount, currency, total delta) without impersonating tenant consent.
 */
export async function prepareVariationRevisedQuotation(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    quotedUnitAmount: unknown;
    currency?: unknown;
    revisedQuotationVersionId?: unknown;
    evidenceReference?: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: HandymanScopeVariationRecord;
  events: HandymanScopeVariationEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');
  const quotedUnitAmount = assertNonNegativeAmount(
    input.quotedUnitAmount,
    'quotedUnitAmount',
  );
  const currency =
    typeof input.currency === 'string' && input.currency.trim().length > 0
      ? input.currency.trim().toUpperCase()
      : 'IDR';
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;
  const revisedQuotationVersionId =
    input.revisedQuotationVersionId !== undefined &&
    input.revisedQuotationVersionId !== null
      ? assertUuid(
          input.revisedQuotationVersionId,
          'revisedQuotationVersionId',
        )
      : null;

  return withTransaction(async (tx) => {
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    await assertOperationsManagerForExecutionScope(
      actorUserId,
      ctx,
      variation.originActorUserId,
    );

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'REVISED_QUOTATION',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return { replayed: true, variation, events };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    if (variation.status !== 'OPERATIONS_REVIEW') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Cannot transition variation from ${variation.status} to REVISED_QUOTATION.`,
      });
    }

    const rawMagnitude = Number(
      (Number(variation.quantity) * Number(quotedUnitAmount)).toFixed(2),
    );
    const signedDelta =
      variation.variationType === 'REDUCE' ? -rawMagnitude : rawMagnitude;
    const quotedTotalDelta = signedDelta.toFixed(2);

    const evidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : variation.latestEvidenceReference;

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'REVISED_QUOTATION',
        latestEvidenceReference: evidenceReference,
        quotedUnitAmount,
        quotedTotalDelta,
        currency,
        revisedQuotationVersionId,
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'REVISED_QUOTATION',
      fromStatus: 'OPERATIONS_REVIEW',
      toStatus: 'REVISED_QUOTATION',
      actorUserId,
      actorRole: 'OPERATIONS_MANAGER',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        quotedUnitAmount,
        quotedTotalDelta,
        currency,
        revisedQuotationVersionId,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.revised_quotation_prepared',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Revised quotation prepared for ${variation.variationType} scope variation`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          variationType: variation.variationType,
          quotedTotalDelta,
          currency,
        },
      },
      tx,
    );

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );
    return { replayed: false, variation: updated, events };
  });
}

/**
 * 5. TENANT_DECISION — Authorized Tenant PIC user records APPROVED or REJECTED.
 *    Operations/Manager, PIC Pekerjaan, and Inspector are strictly forbidden
 *    from impersonating tenant consent.
 */
export async function recordVariationTenantDecision(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    decision: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: HandymanScopeVariationRecord;
  events: HandymanScopeVariationEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');

  const rawDecision =
    typeof input.decision === 'string'
      ? input.decision.trim().toUpperCase()
      : '';
  let decisionOutcome: HandymanScopeVariationTenantDecision;
  if (rawDecision === 'APPROVE' || rawDecision === 'APPROVED') {
    decisionOutcome = 'APPROVED';
  } else if (rawDecision === 'REJECT' || rawDecision === 'REJECTED') {
    decisionOutcome = 'REJECTED';
  } else {
    throw AppError.validation(
      'decision must be APPROVE/APPROVED or REJECT/REJECTED.',
    );
  }

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
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    await assertAuthorizedTenantDecisionActor(actorUserId, ctx, tx);

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'TENANT_DECISION',
        idempotencyKey,
      );
    if (existingEv) {
      if (variation.tenantDecisionOutcome !== decisionOutcome) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different tenant decision outcome.',
        });
      }
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return { replayed: true, variation, events };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    if (variation.status !== 'REVISED_QUOTATION') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Cannot record tenant decision when variation status is ${variation.status}.`,
      });
    }

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'TENANT_DECISION',
        latestEvidenceReference: evidenceReference,
        tenantDecisionOutcome: decisionOutcome,
        tenantDecidedByUserId: actorUserId,
        tenantDecidedAt: new Date(),
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'TENANT_DECISION',
      fromStatus: 'REVISED_QUOTATION',
      toStatus: 'TENANT_DECISION',
      actorUserId,
      actorRole: 'TENANT',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        decisionOutcome,
        variationType: variation.variationType,
        quantity: variation.quantity,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.tenant_decided',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Tenant recorded ${decisionOutcome} decision on scope variation`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          decisionOutcome,
          variationType: variation.variationType,
        },
      },
      tx,
    );

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );
    return { replayed: false, variation: updated, events };
  });
}

/**
 * 6. AUTHORIZED_SCOPE — Authorizes a tenant-approved variation into reconciled
 *    executable scope (reconciling remaining work for REDUCE, or adding
 *    authorized variation work for ADD while keeping original scope immutable).
 */
export async function authorizeVariationScope(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    evidenceReference?: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: HandymanScopeVariationRecord;
  events: HandymanScopeVariationEventRecord[];
  reconciledAuthorizedScope: ReconciledAuthorizedScopeProjection;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');
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
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    await assertOperationsManagerForExecutionScope(
      actorUserId,
      ctx,
      variation.originActorUserId,
    );

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'AUTHORIZED_SCOPE',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      const reconciledAuthorizedScope =
        await buildReconciledAuthorizedScopeProjection(ctx, tx);
      return {
        replayed: true,
        variation,
        events,
        reconciledAuthorizedScope,
      };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    if (
      variation.status !== 'TENANT_DECISION' ||
      variation.tenantDecisionOutcome !== 'APPROVED'
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Pending or rejected variations cannot be authorized into executable scope. Requires TENANT_DECISION with APPROVED outcome.',
      });
    }

    if (variation.variationType === 'REDUCE') {
      await validateReduceTargetAndRemainingQuantity(tx, ctx, {
        targetQuotationLineId: variation.targetQuotationLineId,
        lineType: variation.lineType,
        uomId: variation.uomId,
        requestedQuantity: variation.quantity,
        excludeVariationId: variation.id,
        authorizedOnly: true,
      });
    }

    const evidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : variation.latestEvidenceReference;

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'AUTHORIZED_SCOPE',
        latestEvidenceReference: evidenceReference,
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'AUTHORIZED_SCOPE',
      fromStatus: 'TENANT_DECISION',
      toStatus: 'AUTHORIZED_SCOPE',
      actorUserId,
      actorRole: 'OPERATIONS_MANAGER',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        variationType: variation.variationType,
        quantity: variation.quantity,
        targetQuotationLineId: variation.targetQuotationLineId,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.scope_authorized',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Scope variation (${variation.variationType}) authorized into execution scope`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          variationType: variation.variationType,
          quantity: variation.quantity,
        },
      },
      tx,
    );

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );
    const reconciledAuthorizedScope =
      await buildReconciledAuthorizedScopeProjection(ctx, tx);

    return {
      replayed: false,
      variation: updated,
      events,
      reconciledAuthorizedScope,
    };
  });
}

/**
 * 7. EXECUTION — Assigned PIC Pekerjaan (Crew Lead) executes an AUTHORIZED_SCOPE
 *    variation.
 */
export async function recordVariationExecution(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: FieldScopeVariationProjection;
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');
  const { isPicPekerjaan } = await resolveFieldRoleForExecutionScope(
    actorUserId,
    ctx,
  );
  if (!isPicPekerjaan) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message:
        'Only the assigned PIC Pekerjaan (Crew Lead) may execute an authorized scope variation.',
    });
  }

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
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'EXECUTION',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return {
        replayed: true,
        variation: stripCommercialForField(variation, events),
      };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    if (variation.status !== 'AUTHORIZED_SCOPE') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Variation cannot enter EXECUTION from status ${variation.status}. Requires AUTHORIZED_SCOPE.`,
      });
    }

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'EXECUTION',
        latestEvidenceReference: evidenceReference,
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'EXECUTION',
      fromStatus: 'AUTHORIZED_SCOPE',
      toStatus: 'EXECUTION',
      actorUserId,
      actorRole: 'PIC_PEKERJAAN',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        variationType: variation.variationType,
        quantity: variation.quantity,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.executed',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Scope variation (${variation.variationType}) executed by PIC Pekerjaan`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          variationType: variation.variationType,
        },
      },
      tx,
    );

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );
    return {
      replayed: false,
      variation: stripCommercialForField(updated, events),
    };
  });
}

/**
 * 8. QC — Assigned Inspector or Operations/Manager verifies QC of an executed
 *    variation (PASSED / FAILED).
 */
export async function recordVariationQc(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    qcOutcome: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: HandymanScopeVariationRecord;
  events: HandymanScopeVariationEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');

  const rawOutcome =
    typeof input.qcOutcome === 'string'
      ? input.qcOutcome.trim().toUpperCase()
      : '';
  if (
    !(HANDYMAN_SCOPE_VARIATION_QC_OUTCOMES as readonly string[]).includes(
      rawOutcome,
    )
  ) {
    throw AppError.validation('qcOutcome must be PASSED or FAILED.');
  }
  const qcOutcome = rawOutcome as HandymanScopeVariationQcOutcome;

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

  const { isInspector, isPicPekerjaan } =
    await resolveFieldRoleForExecutionScope(actorUserId, ctx);
  const hasManage = await userHasPermissionCode(
    actorUserId,
    'tenant_company.manage',
  );

  if (!isInspector && (!hasManage || isPicPekerjaan)) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message:
        'Only the assigned Inspector or an Operations/Manager actor (not the executing PIC Pekerjaan) may verify variation QC.',
    });
  }

  const actorRole: HandymanScopeVariationActorRole = isInspector
    ? 'INSPECTOR'
    : 'OPERATIONS_MANAGER';

  return withTransaction(async (tx) => {
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'QC',
        idempotencyKey,
      );
    if (existingEv) {
      if (variation.qcOutcome !== qcOutcome) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT,
          message: 'idempotencyKey was already used with a different qcOutcome.',
        });
      }
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return { replayed: true, variation, events };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    const canReQcFailed =
      variation.status === 'QC' && variation.qcOutcome === 'FAILED';
    if (variation.status !== 'EXECUTION' && !canReQcFailed) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Variation cannot undergo QC from status ${variation.status}. Requires EXECUTION.`,
      });
    }

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'QC',
        latestEvidenceReference: evidenceReference,
        qcOutcome,
        qcVerifiedByUserId: actorUserId,
        qcVerifiedAt: new Date(),
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'QC',
      fromStatus: variation.status,
      toStatus: 'QC',
      actorUserId,
      actorRole,
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        qcOutcome,
        variationType: variation.variationType,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.qc_verified',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Scope variation QC verified (${qcOutcome})`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          qcOutcome,
          actorRole,
        },
      },
      tx,
    );

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );
    return { replayed: false, variation: updated, events };
  });
}

/**
 * 9. FINAL_CHARGE_ELIGIBILITY — Operations/Manager confirms final charge
 *    eligibility after QC PASSED. Never automatically adds to an invoice.
 */
export async function confirmVariationFinalChargeEligibility(
  actorUserId: string,
  executionScopeId: string,
  variationId: string,
  input: {
    evidenceReference?: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion?: unknown;
  },
): Promise<{
  replayed: boolean;
  variation: HandymanScopeVariationRecord;
  events: HandymanScopeVariationEventRecord[];
}> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  const validVariationId = assertUuid(variationId, 'variationId');
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
    const variation =
      await handymanScopeVariationRepository.findByIdForUpdate(
        tx,
        validVariationId,
        ctx.executionScopeId,
      );
    if (!variation) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Handyman scope variation not found.',
      });
    }

    await assertOperationsManagerForExecutionScope(
      actorUserId,
      ctx,
      variation.originActorUserId,
    );

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'FINAL_CHARGE_ELIGIBILITY',
        idempotencyKey,
      );
    if (existingEv) {
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return { replayed: true, variation, events };
    }

    assertExpectedVersion(variation, input.expectedVersion);

    if (variation.status !== 'QC' || variation.qcOutcome !== 'PASSED') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Variation can only enter FINAL_CHARGE_ELIGIBILITY after QC with PASSED outcome.',
      });
    }

    const evidenceReference =
      input.evidenceReference !== undefined && input.evidenceReference !== null
        ? assertNonEmptyText(
            input.evidenceReference,
            'evidenceReference',
            500,
          )
        : variation.latestEvidenceReference;

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'FINAL_CHARGE_ELIGIBILITY',
        latestEvidenceReference: evidenceReference,
        finalChargeEligible: true,
      });

    await handymanScopeVariationRepository.insertEvent(tx, {
      id: randomUUID(),
      clientId: ctx.clientId,
      variationId: variation.id,
      executionScopeId: ctx.executionScopeId,
      eventType: 'FINAL_CHARGE_ELIGIBILITY',
      fromStatus: 'QC',
      toStatus: 'FINAL_CHARGE_ELIGIBILITY',
      actorUserId,
      actorRole: 'OPERATIONS_MANAGER',
      evidenceReference,
      notes,
      idempotencyKey,
      metadata: {
        variationType: variation.variationType,
        quotedTotalDelta: variation.quotedTotalDelta,
        currency: variation.currency,
        finalChargeEligible: true,
        invoiced: false,
      },
    });

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId,
        eventType: 'handyman_scope_variation.final_charge_eligible',
        entityType: 'handyman_scope_variation',
        entityId: variation.id,
        summary: `Scope variation confirmed eligible for downstream final charge`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          variationType: variation.variationType,
          invoiced: false,
        },
      },
      tx,
    );

    const events =
      await handymanScopeVariationRepository.listEventsByVariation(
        variation.id,
        tx,
      );
    return { replayed: false, variation: updated, events };
  });
}

/**
 * Field Read: Assigned PIC Pekerjaan or Inspector reads variations and
 * reconciled authorized scope with zero commercial leakage.
 */
export async function listFieldScopeVariations(
  actorUserId: string,
  executionScopeId: string,
): Promise<{
  actorRole: 'PIC_PEKERJAAN' | 'INSPECTOR';
  variations: FieldScopeVariationProjection[];
  reconciledAuthorizedScope: ReconciledAuthorizedScopeProjection;
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

  const variations =
    await handymanScopeVariationRepository.listByExecutionScope(
      ctx.executionScopeId,
    );
  const allEvents =
    await handymanScopeVariationRepository.listEventsByExecutionScope(
      ctx.executionScopeId,
    );
  const eventsByVar = new Map<string, HandymanScopeVariationEventRecord[]>();
  for (const ev of allEvents) {
    const arr = eventsByVar.get(ev.variationId) ?? [];
    arr.push(ev);
    eventsByVar.set(ev.variationId, arr);
  }

  const reconciledAuthorizedScope =
    await buildReconciledAuthorizedScopeProjection(ctx);

  return {
    actorRole: isPicPekerjaan ? 'PIC_PEKERJAAN' : 'INSPECTOR',
    variations: variations.map((v) =>
      stripCommercialForField(v, eventsByVar.get(v.id) ?? []),
    ),
    reconciledAuthorizedScope,
  };
}

/**
 * Operations / Customer Care Read: Full variation records, audit history, and
 * reconciled authorized scope.
 */
export async function listOperationsScopeVariations(
  actorUserId: string,
  executionScopeId: string,
): Promise<{
  variations: Array<
    HandymanScopeVariationRecord & {
      events: HandymanScopeVariationEventRecord[];
    }
  >;
  reconciledAuthorizedScope: ReconciledAuthorizedScopeProjection;
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
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message: 'Missing required permission: tenant_company.read.',
    });
  }

  const variations =
    await handymanScopeVariationRepository.listByExecutionScope(
      ctx.executionScopeId,
    );
  const allEvents =
    await handymanScopeVariationRepository.listEventsByExecutionScope(
      ctx.executionScopeId,
    );
  const eventsByVar = new Map<string, HandymanScopeVariationEventRecord[]>();
  for (const ev of allEvents) {
    const arr = eventsByVar.get(ev.variationId) ?? [];
    arr.push(ev);
    eventsByVar.set(ev.variationId, arr);
  }

  const reconciledAuthorizedScope =
    await buildReconciledAuthorizedScopeProjection(ctx);

  return {
    variations: variations.map((v) => ({
      ...v,
      events: eventsByVar.get(v.id) ?? [],
    })),
    reconciledAuthorizedScope,
  };
}
