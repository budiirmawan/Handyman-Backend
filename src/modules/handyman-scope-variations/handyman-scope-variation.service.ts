import { assertOriginalScopeOpenForApproval } from '../handyman-request-scope-set/handyman-request-close-guard';
import { hasVerifiedHandymanBastCustomerAcceptance } from '../handyman-bast';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access/context-access.service';
import { permissionService } from '../permissions';
import { resolveBuildingCareAuthority } from '../handyman-care-authority';
import { recordOperationalEvent } from '../operational-events';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments/handyman-scope-assignment.service';
import { isHandymanQcSupervisor, lockHandymanQcScope }
  from '../handyman-evidence-qc/handyman-qc-authority';
import { assertCurrentGuardedHandymanQcPass }
  from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { findEligibleHandymanWorker } from '../handyman-providers/handyman-worker-eligibility.repository';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence/handyman-field-evidence.service';
import { assertHandymanTenantDecisionActor }
  from '../handyman-tenant-decision-authority/handyman-tenant-decision-authority';
import { assertHandymanQuotationPricingAuthority }
  from '../handyman-quotations/handyman-quotation-access';
import { handymanScopeVariationRepository } from './handyman-scope-variation.repository';
import { createIssuedVariationOfferDocument, requireVariationOfferForDecision }
  from './handyman-variation-offer-document.service';
import {
  addLaborBindingFromEvents, addMaterialBindingFromEvents,
  assertAddLaborQuoteBinding, assertAddMaterialQuoteBinding,
  assertPinnedVariationApproval, variationConsentSnapshot,
} from './handyman-scope-variation-material-authority';
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
  quotationId: string;
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
    quotation_id: string;
    tenant_company_id: string;
    building_id: string;
    approved_quotation_version_id: string;
  }>(
    `SELECT id,
            client_id,
            handyman_request_id,
            quotation_id,
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
    quotationId: scope.quotation_id,
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

// Reviewing, pricing and authorizing a variation are commercial decisions,
// not Care relay actions. Reuse the quotation writer's explicit Operations
// permission and customer-side exclusion in addition to the existing
// exact-Building and originator-separation checks.
async function assertVariationCommercialAuthority(
  tx: PoolClient,
  actorUserId: string,
  ctx: ExecutionScopeContext,
  originActorUserId: string,
): Promise<void> {
  await assertOperationsManagerForExecutionScope(actorUserId, ctx, originActorUserId);
  await assertHandymanQuotationPricingAuthority({
    actorUserId,
    clientId: ctx.clientId,
    handymanRequestId: ctx.handymanRequestId,
    tenantCompanyId: ctx.tenantCompanyId,
  }, tx);
}

async function assertAuthorizedTenantDecisionActor(
  actorUserId: string,
  ctx: ExecutionScopeContext,
  tx: PoolClient,
): Promise<void> {
  await assertBuildingScopeAccess(actorUserId, ctx);

  await assertHandymanTenantDecisionActor(tx, {
    actorUserId,
    handymanRequestId: ctx.handymanRequestId,
    clientId: ctx.clientId,
    tenantCompanyId: ctx.tenantCompanyId,
    buildingId: ctx.buildingId,
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

function toCents(amount: string): bigint {
  const trimmed = amount.trim();
  const isNegative = trimmed.startsWith('-');
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;
  const [whole = '0', frac = '00'] = unsigned.split('.');
  const cents =
    BigInt(whole || '0') * 100n +
    BigInt((frac + '00').slice(0, 2));
  return isNegative ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const isNegative = cents < 0n;
  const abs = isNegative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${isNegative ? '-' : ''}${whole}.${frac}`;
}

// This validates the version and total delta, not an item-level mapping:
// ADD variations have no authoritative revised-quotation-line identity.
async function assertValidRevisedQuotationVersionForVariation(
  tx: PoolClient,
  ctx: ExecutionScopeContext,
  params: {
    variationId: string;
    revisedQuotationVersionId: string;
    expectedCurrency: string;
    expectedVariationDelta: string;
    requireCurrentOffer?: boolean;
  },
): Promise<{
  revisedVersionNumber: number;
  originalVersionNumber: number;
  originalQuotedTotal: string;
  revisedQuotedTotal: string;
  mode: 'STANDALONE' | 'CUMULATIVE';
}> {
  if (params.revisedQuotationVersionId === ctx.approvedQuotationVersionId) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message:
        'Cannot reuse the original approved quotation version as revisedQuotationVersionId; a distinct revised quotation version on the same quotation thread is required.',
    });
  }

  // The same quotation offer cannot be used to approve two variations,
  // including when two preparations race. Only the variation service binds
  // this pointer; serialize its check and write without changing the quote.
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`handyman-variation-quotation:${params.revisedQuotationVersionId.toLowerCase()}`],
  );

  const qvRes = await tx.query<{
    id: string;
    version_number: number;
    status: string;
    current_offer: boolean;
    orig_version_number: number;
  }>(
    `SELECT qv.id,
            qv.version_number,
            qv.status,
            (qv.valid_until IS NOT NULL AND qv.valid_until > clock_timestamp()) AS current_offer,
            orig_qv.version_number AS orig_version_number
       FROM handyman_quotation_versions qv
       JOIN handyman_quotations q
         ON q.id = qv.quotation_id
       JOIN handyman_quotation_versions orig_qv
         ON orig_qv.id = $4
        AND orig_qv.quotation_id = q.id
      WHERE qv.id = $1
        AND q.id = $2
        AND q.client_id = $3
      FOR SHARE`,
    [
      params.revisedQuotationVersionId,
      ctx.quotationId,
      ctx.clientId,
      ctx.approvedQuotationVersionId,
    ],
  );
  const qv = qvRes.rows[0];
  if (!qv) {
    throw AppError.validation(
      'revisedQuotationVersionId does not belong to this execution scope quotation thread.',
    );
  }
  if (Number(qv.version_number) <= Number(qv.orig_version_number)) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message:
        'revisedQuotationVersionId must have a higher version_number than the original approved quotation version.',
    });
  }
  if (qv.status !== 'ISSUED' && qv.status !== 'APPROVED') {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message:
        'revisedQuotationVersionId must be in ISSUED or APPROVED status.',
    });
  }
  // Currency belongs to the immutable quotation lines, not the version row.
  // Like quotation decisions, new consent cannot be recorded against an
  // expired or undated issued offer. Once consent is recorded, passage of the
  // offer deadline alone does not invalidate that existing decision.
  if (params.requireCurrentOffer && (qv.status !== 'ISSUED' || !qv.current_offer)) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'A current, unapproved ISSUED revised quotation offer is required.',
    });
  }

  const duplicate = await tx.query<{ id: string }>(
    `SELECT id FROM handyman_scope_variations
      WHERE revised_quotation_version_id = $1 AND id <> $2
      LIMIT 1`,
    [params.revisedQuotationVersionId, params.variationId],
  );
  if (duplicate.rows.length > 0) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'This revised quotation version is already bound to another variation.',
    });
  }

  const origLinesRes = await tx.query<{
    line_total: string;
    currency: string;
  }>(
    `SELECT line_total::numeric(18,2)::text AS line_total,
            currency
       FROM handyman_quotation_lines
      WHERE quotation_version_id = $1`,
    [ctx.approvedQuotationVersionId],
  );
  const revLinesRes = await tx.query<{
    line_total: string;
    currency: string;
  }>(
    `SELECT line_total::numeric(18,2)::text AS line_total,
            currency
       FROM handyman_quotation_lines
      WHERE quotation_version_id = $1`,
    [params.revisedQuotationVersionId],
  );

  if (revLinesRes.rows.length === 0) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message:
        'revisedQuotationVersionId has no quotation lines; a valid revised scope/charge representation is required.',
    });
  }
  for (const row of [...origLinesRes.rows, ...revLinesRes.rows]) {
    if (row.currency !== params.expectedCurrency) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Original and revised quotation line currencies must match the variation currency.',
      });
    }
  }

  let origTotalCents = 0n;
  for (const row of origLinesRes.rows) {
    origTotalCents += toCents(row.line_total);
  }
  let revTotalCents = 0n;
  for (const row of revLinesRes.rows) {
    revTotalCents += toCents(row.line_total);
  }
  if (revTotalCents < 0n) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'Revised quotation total cannot be negative.',
    });
  }

  const priorVarsRes = await tx.query<{ quoted_total_delta: string }>(
    `SELECT quoted_total_delta::numeric(18,2)::text AS quoted_total_delta
       FROM handyman_scope_variations
      WHERE execution_scope_id = $1
        AND id <> $2
        AND quoted_total_delta IS NOT NULL
        AND status IN ('AUTHORIZED_SCOPE', 'EXECUTION', 'QC', 'FINAL_CHARGE_ELIGIBILITY')`,
    [ctx.executionScopeId, params.variationId],
  );
  let priorAuthorizedDeltaCents = 0n;
  for (const row of priorVarsRes.rows) {
    priorAuthorizedDeltaCents += toCents(row.quoted_total_delta);
  }

  const thisDeltaCents = toCents(params.expectedVariationDelta);
  const actualRevDeltaCents = revTotalCents - origTotalCents;
  const matchesStandalone = actualRevDeltaCents === thisDeltaCents;
  const matchesCumulative =
    actualRevDeltaCents === priorAuthorizedDeltaCents + thisDeltaCents;

  if (!matchesStandalone && !matchesCumulative) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: `Revised quotation line total delta (${fromCents(actualRevDeltaCents)}) does not reconcile with variation quotedTotalDelta (${fromCents(thisDeltaCents)}).`,
    });
  }

  return {
    revisedVersionNumber: Number(qv.version_number),
    originalVersionNumber: Number(qv.orig_version_number),
    originalQuotedTotal: fromCents(origTotalCents),
    revisedQuotedTotal: fromCents(revTotalCents),
    mode: matchesCumulative && priorVarsRes.rows.length > 0 ? 'CUMULATIVE' : 'STANDALONE',
  };
}

async function assertVerifiedAuthoritativeQcRunForVariation(
  tx: PoolClient,
  ctx: ExecutionScopeContext,
  qcRunId: string,
  expectedQcOutcome: HandymanScopeVariationQcOutcome,
): Promise<{
  qcRunId: string;
  checklistIdentity: string;
  qcRunStatus: string;
}> {
  const qcRes = await tx.query<{
    id: string;
    checklist_identity: string;
    status: string;
    created_at: Date | string;
  }>(
    `SELECT id, checklist_identity, status, created_at
       FROM handyman_qc_runs
      WHERE id = $1
        AND execution_scope_id = $2
        AND client_id = $3
      FOR SHARE`,
    [qcRunId, ctx.executionScopeId, ctx.clientId],
  );
  const qcRun = qcRes.rows[0];
  if (!qcRun) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message:
        'qcRunId must reference an existing authoritative Supervisor QC run (handyman_qc_runs) for this execution scope.',
    });
  }
  if (qcRun.status !== expectedQcOutcome) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: `Authoritative QC run (${qcRun.id}) status is ${qcRun.status}, which does not match variation qcOutcome ${expectedQcOutcome}.`,
    });
  }
  const latest = await tx.query<{ id: string }>(
    `SELECT id FROM handyman_qc_runs
       WHERE execution_scope_id = $1 AND client_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
    [ctx.executionScopeId, ctx.clientId],
  );
  if (latest.rows[0]?.id !== qcRun.id) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'Variation QC requires the latest authoritative run on this execution scope.',
    });
  }

  if (expectedQcOutcome === 'PASSED') {
    // Consume the same versioned, byte-verified, latest Supervisor decision
    // required by BAST; this is not a parallel variation QC engine.
    try {
      await assertCurrentGuardedHandymanQcPass(tx, {
        id: ctx.executionScopeId, clientId: ctx.clientId,
        buildingId: ctx.buildingId,
      }, qcRun.id);
    } catch (error) {
      if (error instanceof AppError
          && (error.code === ERROR_CODES.HANDYMAN_QC_PASS_BLOCKED
            || error.code === ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED)) {
        throw new AppError({ statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
          message: 'Variation QC requires a current guarded Supervisor PASS with valid checklist, Work Sessions, defects and evidence.',
        });
      }
      throw error;
    }
  }

  return {
    qcRunId: qcRun.id,
    checklistIdentity: qcRun.checklist_identity,
    qcRunStatus: qcRun.status,
  };
}

function stripCommercialForField(
  v: HandymanScopeVariationRecord,
  events: HandymanScopeVariationEventRecord[],
): FieldScopeVariationProjection {
  const binding = addMaterialBindingFromEvents(v, events) ?? addLaborBindingFromEvents(v, events);
  const decision = events.find((event) => event.eventType === 'TENANT_DECISION');
  const approvedVersion = (decision?.metadata.consentSnapshot as { version?: unknown } | undefined)?.version;
  return {
    id: v.id,
    executionScopeId: v.executionScopeId,
    handymanRequestId: v.handymanRequestId,
    variationType: v.variationType,
    lineType: v.lineType,
    targetQuotationLineId: v.targetQuotationLineId,
    ...(binding ? { revisedQuotationVersionId: v.revisedQuotationVersionId, ...binding } : {}),
    ...(binding && v.tenantDecisionOutcome === 'APPROVED' && typeof approvedVersion === 'number'
      ? { approvedVariationVersion: approvedVersion } : {}),
    title: v.title,
    description: v.description,
    technicalFinding: v.technicalFinding,
    quantity: v.quantity,
    uomId: v.uomId,
    status: v.status,
    tenantDecisionOutcome: v.tenantDecisionOutcome,
    qcOutcome: v.qcOutcome,
    qcRunId: v.qcRunId,
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

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

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

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

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

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

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

    await assertVariationCommercialAuthority(
      tx, actorUserId, ctx, variation.originActorUserId,
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

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

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
    revisedQuotationLineId?: unknown;
    workOrderId?: unknown;
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
  const revisedQuotationVersionId = assertUuid(
    input.revisedQuotationVersionId,
    'revisedQuotationVersionId',
  ).toLowerCase();

  return withTransaction(async (tx) => {
    // Serialize cumulative scope, the issued offer and its snapshot together.
    await lockHandymanQcScope(tx, ctx.executionScopeId);
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

    await assertVariationCommercialAuthority(
      tx, actorUserId, ctx, variation.originActorUserId,
    );

    const isAddItem = variation.variationType === 'ADD';
    const hasBindingInput = input.revisedQuotationLineId != null || input.workOrderId != null;
    // Existing unbound ADD labor offers remain historical/lifecycle-compatible,
    // but cannot create item-level labor execution without fresh pinned consent.
    const needsBinding = isAddItem && (variation.lineType === 'MATERIAL' || hasBindingInput);
    const binding = needsBinding ? {
      revisedQuotationLineId: assertUuid(input.revisedQuotationLineId, 'revisedQuotationLineId').toLowerCase(),
      workOrderId: assertUuid(input.workOrderId, 'workOrderId').toLowerCase(),
    } : null;
    if (!isAddItem && hasBindingInput) {
      throw AppError.validation('The quotation line and Work Order binding is only valid for an ADD variation.');
    }

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'REVISED_QUOTATION',
        idempotencyKey,
      );
    if (existingEv) {
      if (
        existingEv.actorUserId !== actorUserId ||
        variation.revisedQuotationVersionId !== revisedQuotationVersionId ||
        variation.quotedUnitAmount !== quotedUnitAmount ||
        variation.currency !== currency ||
        (binding !== null && (existingEv.metadata.revisedQuotationLineId !== binding.revisedQuotationLineId ||
          existingEv.metadata.workOrderId !== binding.workOrderId))
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT,
          message: 'idempotencyKey was already used with different quotation terms.',
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

    const qvValidation = await assertValidRevisedQuotationVersionForVariation(
      tx,
      ctx,
      {
        variationId: variation.id,
        revisedQuotationVersionId,
        expectedCurrency: currency,
        expectedVariationDelta: quotedTotalDelta,
        requireCurrentOffer: true,
      },
    );

    if (binding) {
      const validateBinding = variation.lineType === 'MATERIAL' ? assertAddMaterialQuoteBinding : assertAddLaborQuoteBinding;
      await validateBinding(tx, {
        executionScopeId: ctx.executionScopeId, quotationVersionId: revisedQuotationVersionId,
        quotationLineId: binding.revisedQuotationLineId, workOrderId: binding.workOrderId,
        quantity: variation.quantity, uomId: variation.uomId, quotedUnitAmount, currency,
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

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

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

    const offer = await createIssuedVariationOfferDocument(tx, updated, actorUserId, binding, {
      mode: qvValidation.mode, originalQuotedTotal: qvValidation.originalQuotedTotal,
      revisedQuotedTotal: qvValidation.revisedQuotedTotal,
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
        ...(binding ?? {}),
        revisedVersionNumber: qvValidation.revisedVersionNumber,
        originalQuotedTotal: qvValidation.originalQuotedTotal,
        revisedQuotedTotal: qvValidation.revisedQuotedTotal,
        offerDocument: { id: offer.offerDocumentId, version: offer.offerDocumentVersion,
          number: offer.number, pdfSha256: offer.offerPdfSha256, sourceSha256: offer.sourceSha256 },
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
    revisedQuotationVersionId: unknown;
    revisedQuotationLineId?: unknown;
    workOrderId?: unknown;
    offerDocumentId?: unknown;
    offerDocumentVersion?: unknown;
    offerPdfSha256?: unknown;
    evidenceReference: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
    expectedVersion: unknown;
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
    // PART04: serialize work-revision changes with BM verification and new
    // dispatch/check-in/start/resume. Scope first, then variation (QC order).
    await lockHandymanQcScope(tx, ctx.executionScopeId);
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

    const bindingEvents = await handymanScopeVariationRepository.listEventsByVariation(variation.id, tx);
    const itemBinding = addMaterialBindingFromEvents(variation, bindingEvents) ?? addLaborBindingFromEvents(variation, bindingEvents);
    if (variation.variationType === 'ADD' && (variation.lineType === 'MATERIAL' || itemBinding)) {
      if (!itemBinding) {
        throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
          message: 'ADD requires a revised quotation-line and Work Order binding before Tenant consent.' });
      }
      if (assertUuid(input.revisedQuotationLineId, 'revisedQuotationLineId').toLowerCase() !== itemBinding.revisedQuotationLineId ||
          assertUuid(input.workOrderId, 'workOrderId').toLowerCase() !== itemBinding.workOrderId) {
        throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
          message: 'Tenant decision must identify the exact offered line and Work Order.' });
      }
    }

    // The PIC must identify both the variation state and the issued offer
    // they actually reviewed; neither may be silently inferred from the head.
    const callerQvId = assertUuid(
      input.revisedQuotationVersionId, 'revisedQuotationVersionId',
    ).toLowerCase();
    const expectedVersion = Number(input.expectedVersion);
    if (
      (typeof input.expectedVersion !== 'number' && typeof input.expectedVersion !== 'string') ||
      !Number.isInteger(expectedVersion) || expectedVersion < 1
    ) {
      throw AppError.validation('expectedVersion must be a positive integer.');
    }

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'TENANT_DECISION',
        idempotencyKey,
      );
    if (existingEv) {
      const pinned = existingEv.metadata.consentSnapshot as { version?: unknown; offerDocumentId?: unknown;
        offerDocumentVersion?: unknown; offerPdfSha256?: unknown } | undefined;
      if (
        (pinned?.offerDocumentId !== undefined &&
          (input.offerDocumentId !== pinned.offerDocumentId || Number(input.offerDocumentVersion) !== pinned.offerDocumentVersion ||
            input.offerPdfSha256 !== pinned.offerPdfSha256)) ||
        existingEv.actorUserId !== actorUserId ||
        existingEv.metadata.decisionOutcome !== decisionOutcome ||
        variation.revisedQuotationVersionId !== callerQvId ||
        pinned?.version !== expectedVersion ||
        existingEv.evidenceReference !== evidenceReference ||
        existingEv.notes !== notes
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT,
          message: 'idempotencyKey was already used with different tenant consent.',
        });
      }
      const events =
        await handymanScopeVariationRepository.listEventsByVariation(
          variation.id,
          tx,
        );
      return { replayed: true, variation, events };
    }

    if (decisionOutcome === 'APPROVED') await assertOriginalScopeOpenForApproval(tx, ctx.executionScopeId);

    assertExpectedVersion(variation, expectedVersion);

    if (variation.status !== 'REVISED_QUOTATION') {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Cannot record tenant decision when variation status is ${variation.status}.`,
      });
    }

    if (
      !variation.revisedQuotationVersionId ||
      variation.revisedQuotationVersionId === ctx.approvedQuotationVersionId ||
      !variation.currency ||
      !variation.quotedTotalDelta
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Variation has no valid distinct revisedQuotationVersionId for tenant decision.',
      });
    }

    if (callerQvId !== variation.revisedQuotationVersionId) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Tenant decision revisedQuotationVersionId does not match the variation bound revisedQuotationVersionId.',
      });
    }

    await assertValidRevisedQuotationVersionForVariation(tx, ctx, {
      variationId: variation.id,
      revisedQuotationVersionId: variation.revisedQuotationVersionId,
      expectedCurrency: variation.currency,
      expectedVariationDelta: variation.quotedTotalDelta,
      requireCurrentOffer: true,
    });
    if (itemBinding && variation.quotedUnitAmount !== null) {
      const validateBinding = variation.lineType === 'MATERIAL' ? assertAddMaterialQuoteBinding : assertAddLaborQuoteBinding;
      await validateBinding(tx, {
        executionScopeId: ctx.executionScopeId, quotationVersionId: variation.revisedQuotationVersionId,
        quotationLineId: itemBinding.revisedQuotationLineId, workOrderId: itemBinding.workOrderId,
        quantity: variation.quantity, uomId: variation.uomId,
        quotedUnitAmount: variation.quotedUnitAmount, currency: variation.currency,
      });
    }
    const offer = await requireVariationOfferForDecision(tx, variation, bindingEvents, itemBinding, input);

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);
    // Evidence I/O can outlast an offer's deadline; recheck at the write.
    const liveOffer = await tx.query<{ valid: boolean }>(
      `SELECT status = 'ISSUED' AND valid_until IS NOT NULL AND valid_until > clock_timestamp() AS valid
         FROM handyman_quotation_versions WHERE id = $1`,
      [variation.revisedQuotationVersionId],
    );
    if (!liveOffer.rows[0]?.valid) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: 'The revised quotation offer expired before Tenant consent was recorded.',
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
        consentSnapshot: { ...variationConsentSnapshot(variation, variation.version, itemBinding), ...offer },
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
    // PART04: serialize work-revision changes with BM verification and new
    // dispatch/check-in/start/resume. Scope first, then variation (QC order).
    await lockHandymanQcScope(tx, ctx.executionScopeId);
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

    await assertVariationCommercialAuthority(
      tx, actorUserId, ctx, variation.originActorUserId,
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

    await assertOriginalScopeOpenForApproval(tx, ctx.executionScopeId);

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

    if (
      !variation.revisedQuotationVersionId ||
      variation.revisedQuotationVersionId === ctx.approvedQuotationVersionId ||
      !variation.currency ||
      !variation.quotedTotalDelta
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Cannot authorize scope variation without a distinct, valid revised quotation version.',
      });
    }

    await assertPinnedVariationApproval(tx, variation, variation.version - 1);

    await assertValidRevisedQuotationVersionForVariation(tx, ctx, {
      variationId: variation.id,
      revisedQuotationVersionId: variation.revisedQuotationVersionId,
      expectedCurrency: variation.currency,
      expectedVariationDelta: variation.quotedTotalDelta,
    });
    if (variation.variationType === 'ADD' && variation.lineType === 'MATERIAL') {
      const events = await handymanScopeVariationRepository.listEventsByVariation(variation.id, tx);
      const binding = addMaterialBindingFromEvents(variation, events);
      if (!binding || variation.quotedUnitAmount === null) {
        throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
          message: 'ADD material requires the PIC-approved quotation-line and Work Order binding.' });
      }
      await assertAddMaterialQuoteBinding(tx, {
        executionScopeId: ctx.executionScopeId, quotationVersionId: variation.revisedQuotationVersionId,
        quotationLineId: binding.revisedQuotationLineId, workOrderId: binding.workOrderId,
        quantity: variation.quantity, uomId: variation.uomId,
        quotedUnitAmount: variation.quotedUnitAmount, currency: variation.currency,
      });
    }

    // Legacy ADD labor approvals without an item binding retain their historical
    // lifecycle, but are never executable through the new item-level contract.
    if (variation.variationType === 'ADD' && variation.lineType === 'LABOR') {
      const events = await handymanScopeVariationRepository.listEventsByVariation(variation.id, tx);
      const binding = addLaborBindingFromEvents(variation, events);
      if (binding && variation.quotedUnitAmount !== null) {
        await assertAddLaborQuoteBinding(tx, {
          executionScopeId: ctx.executionScopeId, quotationVersionId: variation.revisedQuotationVersionId,
          quotationLineId: binding.revisedQuotationLineId, workOrderId: binding.workOrderId,
          quantity: variation.quantity, uomId: variation.uomId,
          quotedUnitAmount: variation.quotedUnitAmount, currency: variation.currency,
        });
      }
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

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

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
 * 7. EXECUTION — Assigned PIC Pekerjaan (Crew Lead) records an AUTHORIZED_SCOPE
 *    variation's execution. This event does not gate actual Work Sessions:
 *    those carry only an execution scope/assignment, not a variation or line.
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
    if (!variation.revisedQuotationVersionId || !variation.currency || !variation.quotedTotalDelta) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: 'Variation execution requires the approved revised quotation.',
      });
    }
    await assertPinnedVariationApproval(tx, variation, variation.version - 2);
    await assertValidRevisedQuotationVersionForVariation(tx, ctx, {
      variationId: variation.id,
      revisedQuotationVersionId: variation.revisedQuotationVersionId,
      expectedCurrency: variation.currency,
      expectedVariationDelta: variation.quotedTotalDelta,
    });

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

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
    qcRunId: unknown;
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
  const qcRunId = assertUuid(input.qcRunId, 'qcRunId');

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
  if (isInspector || isPicPekerjaan) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
      message: 'Inspector or executing PIC cannot independently verify variation QC.',
    });
  }

  const actorRole: HandymanScopeVariationActorRole = 'SUPERVISOR';

  return withTransaction(async (tx) => {
    // Share the scope lock with QC run decisions and reassignments. A broad
    // Operations role never authorizes this QC approval; only the explicitly
    // permitted, current Supervisor of the assigned Crew Lead can do so.
    const qcScope = await lockHandymanQcScope(tx, ctx.executionScopeId);
    if (qcScope.clientId !== ctx.clientId
        || !(await isHandymanQcSupervisor(ctx.executionScopeId,
          ctx.clientId, actorUserId, tx))) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
        message: 'Variation QC requires the current, explicitly permitted Supervisor.',
      });
    }
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

    if (variation.originActorUserId === actorUserId) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.HANDYMAN_VARIATION_ROLE_FORBIDDEN,
        message: 'Originating actor may not verify QC on their own variation.',
      });
    }

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

    const existingEv =
      await handymanScopeVariationRepository.findEventByIdempotencyKey(
        tx,
        variation.id,
        'QC',
        idempotencyKey,
      );
    if (existingEv) {
      if (
        variation.qcOutcome !== qcOutcome ||
        variation.qcRunId !== qcRunId
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different qcOutcome or qcRunId.',
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

    const verifiedQcRun = await assertVerifiedAuthoritativeQcRunForVariation(
      tx,
      ctx,
      qcRunId,
      qcOutcome,
    );

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'QC',
        latestEvidenceReference: evidenceReference,
        qcOutcome,
        qcRunId: verifiedQcRun.qcRunId,
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
        qcRunId: verifiedQcRun.qcRunId,
        qcChecklistIdentity: verifiedQcRun.checklistIdentity,
        qcRunStatus: verifiedQcRun.qcRunStatus,
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
    qcRunId?: unknown;
    bastId?: unknown;
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
  const callerQcRunId =
    input.qcRunId !== undefined && input.qcRunId !== null
      ? assertUuid(input.qcRunId, 'qcRunId')
      : null;
  const callerBastId =
    input.bastId !== undefined && input.bastId !== null
      ? assertUuid(input.bastId, 'bastId')
      : null;

  await assertBuildingScopeAccess(actorUserId, ctx);
  return withTransaction(async (tx) => {
    // Serialize admission with QC OPEN/FINISH; the financial gate consumes
    // the current QC result but never changes its authority or BAST state.
    const qcScope = await lockHandymanQcScope(tx, ctx.executionScopeId);
    if (qcScope.clientId !== ctx.clientId) {
      throw new AppError({
        statusCode: 403, code: ERROR_CODES.BUILDING_ACCESS_DENIED,
        message: 'Execution scope Client mismatch.',
      });
    }
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

    if (
      variation.status !== 'QC' ||
      variation.qcOutcome !== 'PASSED' ||
      !variation.qcRunId
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Variation can only enter FINAL_CHARGE_ELIGIBILITY after QC with PASSED outcome and a linked authoritative QC run.',
      });
    }

    if (callerQcRunId && callerQcRunId !== variation.qcRunId) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'qcRunId does not match the variation bound authoritative QC run.',
      });
    }

    // 1. Authoritative Supervisor QC gate & defect closure
    const verifiedQcRun = await assertVerifiedAuthoritativeQcRunForVariation(
      tx,
      ctx,
      variation.qcRunId,
      'PASSED',
    );
    // Earlier FAILED runs are immutable rework history, not permanent
    // financial vetoes. The shared verifier above requires the *latest*
    // authoritative QC run to be the bound PASSED run; a newer OPEN/FAILED
    // run is therefore rejected without punishing a corrected failure.

    // 2. Operational closure gate (no in-flight work sessions)
    const openSessionRes = await tx.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM handyman_work_sessions
        WHERE execution_scope_id = $1
          AND client_id = $2
          AND status IN ('CHECKED_IN', 'IN_PROGRESS', 'PAUSED', 'MATERIAL_RUN')
        LIMIT 1`,
      [ctx.executionScopeId, ctx.clientId],
    );
    if (openSessionRes.rows[0]) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message: `Cannot admit variation to FINAL_CHARGE_ELIGIBILITY while work session ${openSessionRes.rows[0].id} is still in ${openSessionRes.rows[0].status} status.`,
      });
    }

    // 3. Accepted BAST & customer sign-off gate
    const bastRes = await tx.query<{
      id: string;
      status: string;
      accepted_at: Date | string | null;
      has_valid_sign_off: boolean;
    }>(
      `SELECT b.id,
              b.status,
              b.accepted_at,
              EXISTS (
                SELECT 1
                  FROM handyman_bast_sign_offs so
                 WHERE so.bast_id = b.id
                   AND so.execution_scope_id = b.execution_scope_id
                   AND so.client_id = b.client_id
                   AND so.decision = 'ACCEPT'
                   AND length(so.signature_digest) > 0
              ) AS has_valid_sign_off
         FROM handyman_bast_documents b
        WHERE b.execution_scope_id = $1
          AND b.client_id = $2
          AND ($3::uuid IS NULL OR b.id = $3::uuid)
          AND b.status <> 'VOID'
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT 1
        FOR SHARE`,
      [ctx.executionScopeId, ctx.clientId, callerBastId],
    );
    const bast = bastRes.rows[0];
    if (
      !bast ||
      bast.status !== 'ACCEPTED' ||
      !bast.accepted_at ||
      !bast.has_valid_sign_off ||
      !(await hasVerifiedHandymanBastCustomerAcceptance(tx, bast.id))
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Variation cannot enter FINAL_CHARGE_ELIGIBILITY without an ACCEPTED BAST and customer acceptance sign-off for this execution scope.',
      });
    }

    // 4. Original scope / variation charge reconciliation gate
    if (
      !variation.revisedQuotationVersionId ||
      !variation.currency ||
      !variation.quotedTotalDelta
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Variation is missing revised quotation commercial binding required for charge reconciliation.',
      });
    }
    const qvReconciliation = await assertValidRevisedQuotationVersionForVariation(
      tx,
      ctx,
      {
        variationId: variation.id,
        revisedQuotationVersionId: variation.revisedQuotationVersionId,
        expectedCurrency: variation.currency,
        expectedVariationDelta: variation.quotedTotalDelta,
      },
    );

    const incompleteAuthorizedVariationRes = await tx.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
         FROM handyman_scope_variations
        WHERE execution_scope_id = $1
          AND id <> $2
          AND (
            status IN ('AUTHORIZED_SCOPE', 'EXECUTION')
            OR (status = 'QC' AND qc_outcome = 'FAILED')
          )
        LIMIT 1`,
      [ctx.executionScopeId, variation.id],
    );
    if (incompleteAuthorizedVariationRes.rows[0]) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Cannot admit variation to FINAL_CHARGE_ELIGIBILITY while another authorized scope variation on the execution scope remains incomplete or failed QC.',
      });
    }

    // 5. Finance admission & duplicate invoice protection gate
    const finalizedInvoiceRes = await tx.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
         FROM tenant_invoices
        WHERE handyman_execution_scope_id = $1
          AND client_id = $2
          AND status = 'FINALIZED'
        LIMIT 1
        FOR SHARE`,
      [ctx.executionScopeId, ctx.clientId],
    );
    const officialInvoiceRes = await tx.query('SELECT id FROM handyman_official_invoices WHERE execution_scope_id=$1 AND client_id=$2 FOR SHARE',
      [ctx.executionScopeId, ctx.clientId]);
    if (finalizedInvoiceRes.rows[0] || officialInvoiceRes.rows[0]) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
        message:
          'Cannot admit variation to FINAL_CHARGE_ELIGIBILITY after the execution scope tenant invoice has already been FINALIZED (duplicate invoice / post-finalization charge mutation blocked).',
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

    await assertVerifiedManagedEvidenceReference(tx, ctx, evidenceReference);

    const updated =
      await handymanScopeVariationRepository.updateVariationState(tx, {
        variationId: variation.id,
        status: 'FINAL_CHARGE_ELIGIBILITY',
        latestEvidenceReference: evidenceReference,
        bastId: bast.id,
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
        revisedQuotationVersionId: variation.revisedQuotationVersionId,
        originalQuotedTotal: qvReconciliation.originalQuotedTotal,
        reconciledQuotedTotal: qvReconciliation.revisedQuotedTotal,
        qcRunId: verifiedQcRun.qcRunId,
        bastId: bast.id,
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

/**
 * Standalone Building Care variation-status projection. This reuses the
 * variation aggregate's canonical scope loader and repository, but authorizes
 * with the dedicated Care permission + exact Building resolver rather than
 * the Operations route's broader tenant_company.read capability. Only
 * persisted lifecycle/status facts are returned; no commercial or audit data.
 */
export async function listBuildingCareScopeVariationStatuses(
  actorUserId: string,
  executionScopeId: string,
): Promise<Array<{
  status: HandymanScopeVariationStatus;
  variationType: HandymanScopeVariationType;
  tenantDecisionOutcome: HandymanScopeVariationTenantDecision | null;
  updatedAt: string;
}>> {
  const ctx = await loadExecutionScopeContext(executionScopeId);
  await resolveBuildingCareAuthority({
    actorUserId,
    buildingId: ctx.buildingId,
    assertedClientId: ctx.clientId,
  });
  const variations =
    await handymanScopeVariationRepository.listByExecutionScope(
      ctx.executionScopeId,
    );
  return variations.map((variation) => ({
    status: variation.status,
    variationType: variation.variationType,
    tenantDecisionOutcome: variation.tenantDecisionOutcome,
    updatedAt: variation.updatedAt,
  }));
}
