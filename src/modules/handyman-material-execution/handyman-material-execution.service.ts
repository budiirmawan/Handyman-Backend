import { withTransaction } from '../../database';
import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  handymanExecutionScopeNotFoundError,
  handymanExecutionScopeRepository,
  handymanQuotationLineRepository,
  handymanQuotationRepository,
} from '../handyman-quotations';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import {
  handymanMaterialExecutionEstimateInvalidError,
  handymanMaterialExecutionIllegalTransitionError,
  handymanMaterialExecutionLineNotFoundError,
  handymanMaterialExecutionLinkConflictError,
  handymanMaterialExecutionLinkInvalidError,
  handymanMaterialExecutionNotAuthorizedError,
  handymanMaterialExecutionQuantityExceededError,
  handymanMaterialExecutionScopeNotEligibleError,
  handymanMaterialExecutionValidationError,
} from './handyman-material-execution.errors';
import { handymanMaterialExecutionRepository }
  from './handyman-material-execution.repository';
import { resolveApprovedAddMaterial }
  from '../handyman-scope-variations/handyman-scope-variation-material-authority';
import type {
  AcquireHandymanMaterialLineInput,
  ApproveHandymanMaterialLineInput,
  EstimateHandymanMaterialLineInput,
  HandymanCustomerCareMaterialLineItem,
  HandymanCustomerCareMaterialLinesProjection,
  HandymanMaterialAcquisitionMode,
  HandymanMaterialExecutionCommandResult,
  HandymanMaterialExecutionEventType,
  HandymanMaterialExecutionLineRecord,
  SettleHandymanMaterialLineInput,
  UsageHandymanMaterialLineInput,
  HandymanMaterialFinalChargeReadyProjection,
} from './handyman-material-execution.types';

/**
 * CR-HM-09 PART 03 — ESTIMATE + LINK + APPROVE commands ONLY
 * (FROZEN governance `CR-HM-09_START_GOVERNANCE.md` D1–D7).
 * Composition of existing authorities ONLY: CR-HM-06 AUTHORIZED
 * scope + immutable APPROVED quotation snapshot (read-only link
 * anchor), CR-HM-04 `resolveHandymanAssignmentLead` for CURRENT
 * Lead authority. ZERO financial computation: the quotation link
 * carries ONLY quantity authority (estimatedQty <= approvedQty at
 * link time). ZERO ISSUE/PURCHASE/USE/RETURN/FINAL_CHARGE_READY
 * transitions here (later PARTs). Server-clock timestamps only.
 */

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanMaterialExecutionValidationError(field);
  }
  return value;
}

function ensureKey(value: string): string {
  if (typeof value !== 'string'
      || value.trim().length === 0 || value.length > 128) {
    throw handymanMaterialExecutionValidationError('idempotencyKey');
  }
  return value;
}

function ensureEstimatedQuantity(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw handymanMaterialExecutionEstimateInvalidError('not-a-number');
  }
  if (value <= 0) {
    throw handymanMaterialExecutionEstimateInvalidError(
      'not-positive');
  }
  return value;
}

async function authorityPreamble(
  scopeUuid: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  const resolution = await resolveHandymanAssignmentLead(
    scopeUuid,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanMaterialExecutionNotAuthorizedError();
  }
  return { scope, resolution };
}

// Variation authorization and assignment changes lock this scope first. Hold
// that same lock through each new material action so a concurrent REDUCE cannot
// race a quantity check, and re-resolve the real current Lead under the lock.
async function lockMaterialAuthority(tx: PoolClient, scopeId: string, actorId: string) {
  const scope = await handymanScopeAssignmentRepository.lockScopeById(tx, scopeId);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  const lead = await resolveHandymanAssignmentLead(scopeId, actorId, tx);
  if (!lead || lead.leadUserId !== actorId) throw handymanMaterialExecutionNotAuthorizedError();
}

// A REDUCE targets an immutable original quotation line. Bind it to the real
// material execution line through that identity; do not rewrite approvedQty or
// historical use. Only new estimates, acquisitions and use are limited.
async function assertRemainingOriginalMaterialQuantity(
  tx: PoolClient,
  scopeId: string,
  quotationLineId: string,
  proposedQuantity: number,
): Promise<void> {
  const result = await tx.query<{ allowed: boolean }>(
    `SELECT ROUND($3::numeric, 3) <= GREATEST(ql.quantity - COALESCE((
       SELECT SUM(v.quantity)
         FROM handyman_scope_variations v
        WHERE v.execution_scope_id = s.id
          AND v.variation_type = 'REDUCE' AND v.line_type = 'MATERIAL'
          AND v.target_quotation_line_id = ql.id
          AND v.tenant_decision_outcome = 'APPROVED'
          AND v.status IN ('AUTHORIZED_SCOPE', 'EXECUTION', 'QC', 'FINAL_CHARGE_ELIGIBILITY')
     ), 0), 0) AS allowed
       FROM handyman_execution_scopes s
       JOIN handyman_quotation_lines ql ON ql.quotation_version_id = s.approved_quotation_version_id
      WHERE s.id = $1 AND ql.id = $2 AND ql.line_type = 'MATERIAL'`,
    [scopeId, quotationLineId, proposedQuantity],
  );
  if (!result.rows[0]) {
    throw handymanMaterialExecutionLinkInvalidError('line-not-on-original-approved-snapshot');
  }
  if (!result.rows[0].allowed) {
    throw handymanMaterialExecutionQuantityExceededError('exceeds-remaining-scope-after-reduction');
  }
}

function assertAddMaterialPrecision(quantity: number): void {
  if (Number(quantity.toFixed(3)) !== quantity || quantity < 0.001) {
    throw handymanMaterialExecutionQuantityExceededError('add-material-quantity-precision');
  }
}

// Match the NUMERIC(14,3) storage scale for ADD arithmetic; binary float
// artifacts such as 0.1 + 0.2 must not reject an exactly authorized 0.3.
function materialQuantity(value: number, isAdd: boolean): number {
  return isAdd ? Math.round(value * 1000) / 1000 : value;
}

function assertAddReplayQuantity(actual: number | null, requested: number): void {
  if (actual !== requested) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
      message: 'Idempotency key was already used with a different ADD material quantity.' });
  }
}

async function assertAddMaterialLineAuthority(
  tx: PoolClient,
  line: HandymanMaterialExecutionLineRecord,
  proposedQuantity: number,
): Promise<void> {
  if (!line.variationId || !line.approvedVariationVersion || !line.workOrderId) {
    throw handymanMaterialExecutionLinkInvalidError('missing-add-material-binding');
  }
  const authority = await resolveApprovedAddMaterial(tx, line.executionScopeId,
    line.variationId, line.approvedVariationVersion);
  if (line.quotationVersionId !== authority.variation.revisedQuotationVersionId ||
      line.quotationLineId !== authority.binding.revisedQuotationLineId ||
      line.workOrderId !== authority.binding.workOrderId ||
      line.sourceItemId !== authority.sourceItemId ||
      line.approvedQty !== Number(authority.variation.quantity)) {
    throw handymanMaterialExecutionLinkInvalidError('add-material-binding-mismatch');
  }
  if (Number(proposedQuantity.toFixed(3)) > Number(authority.variation.quantity)) {
    throw handymanMaterialExecutionQuantityExceededError('exceeds-approved-add-material-quantity');
  }
}

async function assertMaterialQuantityAuthority(
  tx: PoolClient,
  line: HandymanMaterialExecutionLineRecord,
  proposedQuantity: number,
): Promise<void> {
  if (line.variationId) {
    await assertAddMaterialLineAuthority(tx, line, proposedQuantity);
  } else {
    await assertRemainingOriginalMaterialQuantity(tx, line.executionScopeId, line.quotationLineId, proposedQuantity);
  }
}

/**
 * ESTIMATE (governance D1/D3/D4/D7): AUTHORIZED scope + CURRENT
 * authoritative Crew Lead + valid quotation MATERIAL-line link →
 * create ONE execution line whose approvedQty is COPIED from the
 * APPROVED quotation snapshot line's quantity (quantity authority
 * only — NO commercial fields cross), with estimatedQty <= that
 * approved quantity. The linked quotation version MUST be the scope's
 * immutable approved snapshot. One execution line per quotation line;
 * replay of the same ESTIMATE key returns the SAME line/event.
 */
export async function estimateHandymanMaterialExecutionLine(
  input: EstimateHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const versionUuid = ensureUuid(input.quotationVersionId,
    'quotationVersionId');
  const quoteLineUuid = ensureUuid(input.quotationLineId,
    'quotationLineId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const estimatedQty = ensureEstimatedQuantity(input.estimatedQty);
  const variationUuid = input.variationId === undefined ? null : ensureUuid(input.variationId, 'variationId').toLowerCase();
  const workOrderUuid = input.workOrderId === undefined ? null : ensureUuid(input.workOrderId, 'workOrderId').toLowerCase();
  const approvedVariationVersion = input.approvedVariationVersion ?? null;
  if ((variationUuid === null) !== (approvedVariationVersion === null) ||
      (workOrderUuid !== null && variationUuid === null) ||
      (approvedVariationVersion !== null && (!Number.isInteger(approvedVariationVersion) || approvedVariationVersion < 1))) {
    throw handymanMaterialExecutionValidationError('approvedVariationVersion');
  }
  if (variationUuid) assertAddMaterialPrecision(estimatedQty);

  const { scope } = await authorityPreamble(scopeUuid, actorUuid);
  if (scope.status !== 'AUTHORIZED') {
    throw handymanMaterialExecutionScopeNotEligibleError();
  }

  const version = await handymanQuotationRepository.findVersionById(
    undefined,
    versionUuid,
  );
  if (!version || (!variationUuid && version.id !== scope.approvedQuotationVersionId) ||
      (variationUuid && version.id === scope.approvedQuotationVersionId)) {
    throw handymanMaterialExecutionLinkInvalidError(
      variationUuid ? 'add-requires-revised-quotation' : 'version-not-approved-snapshot');
  }
  const quoteLine = (await handymanQuotationLineRepository.listLines(
    undefined,
    version.id,
  )).find((line) => line.id === quoteLineUuid);
  if (!quoteLine || quoteLine.lineType !== 'MATERIAL') {
    throw handymanMaterialExecutionLinkInvalidError(
      'line-not-material-on-approved-version');
  }
  if (estimatedQty > quoteLine.quantity) {
    throw handymanMaterialExecutionEstimateInvalidError(
      'exceeds-approved-snapshot-quantity');
  }
  if (input.sourceItemId != null &&
      ((variationUuid && input.sourceItemId !== quoteLine.sourceItemId) ||
       (!variationUuid && quoteLine.sourceItemId != null && input.sourceItemId !== quoteLine.sourceItemId))) {
    throw handymanMaterialExecutionLinkInvalidError(
      'source-item-mismatch-with-approved-line');
  }
  // For ADD material, the chosen immutable quote line is the sole identity
  // source; a field caller may not substitute or invent an inventory item.
  const sourceItemId = variationUuid ? quoteLine.sourceItemId : (input.sourceItemId ?? quoteLine.sourceItemId);

  return withTransaction(async (tx) => {
    await lockMaterialAuthority(tx, scopeUuid, actorUuid);
    // Serialize link attempts against the SAME quotation line inside
    // the scope Lead serialization window.
    await tx.query(
      `SELECT id FROM handyman_quotation_lines WHERE id = $1
        FOR UPDATE`,
      [quoteLineUuid],
    );
    const existing = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineByQuotationLine(tx, quoteLineUuid);
    if (existing) {
      // Idempotent replay: the SAME estimate key replays the SAME
      // line/event; a different key on the same link is a bounded
      // one-link-per-quotation-line conflict (never a second row).
      const replayEvent = await handymanMaterialExecutionRepository
        .findMaterialExecutionEventByIdempotency(tx, existing.id,
          'ESTIMATE', key);
      if (replayEvent && existing.executionScopeId === scopeUuid &&
          (variationUuid === null ? existing.variationId === null :
            existing.variationId === variationUuid && existing.approvedVariationVersion === approvedVariationVersion &&
            existing.quotationVersionId === version.id && existing.estimatedQty === estimatedQty &&
            existing.sourceItemId === sourceItemId && (!workOrderUuid || existing.workOrderId === workOrderUuid))) {
        return { line: existing, event: replayEvent, replayed: true };
      }
      throw handymanMaterialExecutionLinkConflictError();
    }
    const addAuthority = variationUuid
      ? await resolveApprovedAddMaterial(tx, scopeUuid, variationUuid, approvedVariationVersion!)
      : null;
    if (addAuthority) {
      if (addAuthority.variation.revisedQuotationVersionId !== version.id ||
          addAuthority.binding.revisedQuotationLineId !== quoteLine.id ||
          (workOrderUuid && addAuthority.binding.workOrderId !== workOrderUuid) ||
          addAuthority.sourceItemId !== sourceItemId) {
        throw handymanMaterialExecutionLinkInvalidError('add-material-binding-mismatch');
      }
      if (estimatedQty > Number(addAuthority.variation.quantity)) {
        throw handymanMaterialExecutionEstimateInvalidError('exceeds-approved-add-material-quantity');
      }
    } else {
      await assertRemainingOriginalMaterialQuantity(tx, scopeUuid, quoteLineUuid, estimatedQty);
    }

    const line = await handymanMaterialExecutionRepository
      .createMaterialExecutionLine(tx, {
        clientId: scope.clientId,
        executionScopeId: scopeUuid,
        quotationVersionId: version.id,
        quotationLineId: quoteLine.id,
        sourceItemId,
        estimatedQty,
        ...(addAuthority ? { variationId: variationUuid, approvedVariationVersion: addAuthority.approvedVersion,
          workOrderId: addAuthority.binding.workOrderId, approvedQty: Number(addAuthority.variation.quantity) } : {}),
        supplierReference: input.supplierReference ?? null,
      });
    // approvedQty is the immutable quotation snapshot's quantity
    // authority, copied at link time (governance D3).
    const headed = await handymanMaterialExecutionRepository
      .updateMaterialExecutionLineHead(tx, line.id, {
        status: line.status,
        acquisitionMode: line.acquisitionMode,
        approvedQty: quoteLine.quantity,
        issuedQty: line.issuedQty,
        purchasedQty: line.purchasedQty,
        usedQty: line.usedQty,
        returnedQty: line.returnedQty,
        supplierReference: line.supplierReference,
      });
    if (!headed) throw handymanMaterialExecutionLineNotFoundError();
    const event = await handymanMaterialExecutionRepository
      .appendMaterialExecutionEvent(tx, {
        clientId: scope.clientId,
        lineId: line.id,
        executionScopeId: scopeUuid,
        eventType: 'ESTIMATE',
        idempotencyKey: key,
        actorUserId: actorUuid,
        ...(addAuthority ? { quantityDelta: estimatedQty } : {}),
      });
    return { line: headed, event, replayed: false };
  });
}

/**
 * APPROVE (governance D1/D5/D7): ESTIMATED -> APPROVED only,
 * CURRENT authoritative Crew Lead, quantities unchanged (approvedQty
 * already carries the snapshot authority from ESTIMATE). Replay of
 * the same APPROVE key returns the SAME event; a new key after
 * APPROVED is a bounded 409 illegal transition.
 */
export async function approveHandymanMaterialExecutionLine(
  input: ApproveHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const lineUuid = ensureUuid(input.lineId, 'lineId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  await authorityPreamble(scopeUuid, actorUuid);

  return withTransaction(async (tx) => {
    await lockMaterialAuthority(tx, scopeUuid, actorUuid);
    const current = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineByIdForUpdate(tx, lineUuid);
    if (!current || current.executionScopeId !== scopeUuid) {
      throw handymanMaterialExecutionLineNotFoundError();
    }
    const replayEvent = await handymanMaterialExecutionRepository
      .findMaterialExecutionEventByIdempotency(tx, lineUuid,
        'APPROVE', key);
    if (replayEvent) {
      return { line: current, event: replayEvent, replayed: true };
    }
    if (current.status !== 'ESTIMATED') {
      throw handymanMaterialExecutionIllegalTransitionError(
        current.status, 'APPROVE');
    }
    if (current.variationId) {
      await assertAddMaterialLineAuthority(tx, current, current.estimatedQty);
    }
    const headed = await handymanMaterialExecutionRepository
      .updateMaterialExecutionLineHead(tx, lineUuid, {
        status: 'APPROVED',
        acquisitionMode: current.acquisitionMode,
        approvedQty: current.approvedQty,
        issuedQty: current.issuedQty,
        purchasedQty: current.purchasedQty,
        usedQty: current.usedQty,
        returnedQty: current.returnedQty,
        supplierReference: current.supplierReference,
      });
    if (!headed) throw handymanMaterialExecutionLineNotFoundError();
    const event = await handymanMaterialExecutionRepository
      .appendMaterialExecutionEvent(tx, {
        clientId: current.clientId,
        lineId: lineUuid,
        executionScopeId: scopeUuid,
        eventType: 'APPROVE',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { line: headed, event, replayed: false };
  });
}


/* ---- PART 04 — ISSUE / PURCHASE acquisition commands ------------
 * Governance D4: ISSUED = drawn from provider/company-managed stock;
 * PURCHASED = procured by the field team (bounded supplierReference
 * only — receipt media lives in CR-HM-10 evidence). Exactly ONE
 * acquisition mode per line (mutually exclusive once chosen; further
 * partial acquisitions accumulate on the SAME axis). The accumulated
 * axis quantity is capped by approvedQty (quantity authority copied
 * from the APPROVED quotation snapshot at ESTIMATE). Acquisition is
 * POSSESSION recording — it NEVER implies USED. Idempotent replay
 * per (line, event_type, key).
 */

const ACQUISITION_CONFIG: Record<HandymanMaterialAcquisitionMode, {
  eventType: HandymanMaterialExecutionEventType;
}> = {
  ISSUED: { eventType: 'ISSUE' },
  PURCHASED: { eventType: 'PURCHASE' },
};

function ensureDeltaQuantity(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw handymanMaterialExecutionQuantityExceededError(
      'not-a-number');
  }
  if (value <= 0) {
    throw handymanMaterialExecutionQuantityExceededError(
      'not-positive');
  }
  return value;
}

async function acquireHandymanMaterialLine(
  mode: HandymanMaterialAcquisitionMode,
  input: AcquireHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  const config = ACQUISITION_CONFIG[mode];
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const lineUuid = ensureUuid(input.lineId, 'lineId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const deltaQty = ensureDeltaQuantity(input.quantity);

  await authorityPreamble(scopeUuid, actorUuid);

  return withTransaction(async (tx) => {
    await lockMaterialAuthority(tx, scopeUuid, actorUuid);
    const current = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineByIdForUpdate(tx, lineUuid);
    if (!current || current.executionScopeId !== scopeUuid) {
      throw handymanMaterialExecutionLineNotFoundError();
    }
    const replayEvent = await handymanMaterialExecutionRepository
      .findMaterialExecutionEventByIdempotency(tx, lineUuid,
        config.eventType, key);
    if (replayEvent) {
      if (current.variationId) assertAddReplayQuantity(replayEvent.quantityDelta, deltaQty);
      return { line: current, event: replayEvent, replayed: true };
    }
    if (current.variationId) assertAddMaterialPrecision(deltaQty);
    // A line adopts exactly ONE acquisition mode; a mismatch between
    // the chosen axis and the requested command is a bounded 409.
    if (current.acquisitionMode !== null
        && current.acquisitionMode !== mode) {
      throw handymanMaterialExecutionIllegalTransitionError(
        current.acquisitionMode, config.eventType);
    }
    // Legal opens: first acquisition from APPROVED; further partial
    // acquisitions while the line stays on THIS axis (ISSUED/PURCHASED).
    if (current.status !== 'APPROVED' && current.status !== mode) {
      throw handymanMaterialExecutionIllegalTransitionError(
        current.status, config.eventType);
    }
    const isAdd = current.variationId !== null;
    const nextIssued = mode === 'ISSUED'
      ? materialQuantity(current.issuedQty + deltaQty, isAdd)
      : current.issuedQty;
    const nextPurchased = mode === 'PURCHASED'
      ? materialQuantity(current.purchasedQty + deltaQty, isAdd)
      : current.purchasedQty;
    // Quantity cap: accumulated possession may never exceed the
    // approved snapshot authority.
    if (nextIssued > current.approvedQty
        || nextPurchased > current.approvedQty) {
      throw handymanMaterialExecutionQuantityExceededError(
        'exceeds-approved-snapshot-quantity');
    }
    await assertMaterialQuantityAuthority(
      tx, current, materialQuantity(nextIssued + nextPurchased - current.returnedQty, isAdd),
    );
    const headed = await handymanMaterialExecutionRepository
      .updateMaterialExecutionLineHead(tx, lineUuid, {
        status: mode,
        acquisitionMode: mode,
        approvedQty: current.approvedQty,
        issuedQty: nextIssued,
        purchasedQty: nextPurchased,
        usedQty: current.usedQty,
        returnedQty: current.returnedQty,
        supplierReference: input.supplierReference
          ?? current.supplierReference,
      });
    if (!headed) throw handymanMaterialExecutionLineNotFoundError();
    const event = await handymanMaterialExecutionRepository
      .appendMaterialExecutionEvent(tx, {
        clientId: current.clientId,
        lineId: lineUuid,
        executionScopeId: scopeUuid,
        eventType: config.eventType,
        idempotencyKey: key,
        actorUserId: actorUuid,
        ...(current.variationId ? { quantityDelta: deltaQty } : {}),
      });
    return { line: headed, event, replayed: false };
  });
}

/**
 * ISSUE: draw `quantity` from provider/company stock for the scope.
 * Legal only from APPROVED (first acquisition) or ISSUED (further
 * partial issues); cumulative issuedQty <= approvedQty. Possession
 * recording ONLY — never implies USED.
 */
export async function issueHandymanMaterialExecutionLine(
  input: AcquireHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  return acquireHandymanMaterialLine('ISSUED', input, actorUserId);
}

/**
 * PURCHASE: field procurement of `quantity` for the scope. Legal
 * only from APPROVED (first acquisition) or PURCHASED (further
 * partial purchases); cumulative purchasedQty <= approvedQty. A
 * bounded supplierReference may accompany (or update) the record —
 * it is a REFERENCE, never financial truth and never an FM
 * purchase-order chain.
 */
export async function purchaseHandymanMaterialExecutionLine(
  input: AcquireHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  return acquireHandymanMaterialLine('PURCHASED', input, actorUserId);
}

/* ---- PART 05 — USE / RETURN adjustments + FINAL_CHARGE_READY ----
 * Governance D2/D5: the final usage basis is ONLY
 * finalUsedQty = usedQty - returnedQty. USE/RETURN are bounded
 * quantity adjustments (partials legal) on the factual axes; RETURN
 * is never a sticky status. SETTLE (FINAL_CHARGE_READY) closes the
 * line: after that, ANY further USE/RETURN/ISSUE/PURCHASE is a
 * bounded 409 MATERIAL_LINE_SETTLED — corrections live downstream in
 * CR-HM-13 reversal/adjustment, NEVER by history rewrite here.
 * Execution truth ONLY: this layer computes NO amounts, NO pricing,
 * NO billing.
 */

async function adjustUsageHandymanMaterialLine(
  kind: 'USE' | 'RETURN',
  input: UsageHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const lineUuid = ensureUuid(input.lineId, 'lineId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const deltaQty = ensureDeltaQuantity(input.quantity);

  await authorityPreamble(scopeUuid, actorUuid);

  return withTransaction(async (tx) => {
    await lockMaterialAuthority(tx, scopeUuid, actorUuid);
    const current = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineByIdForUpdate(tx, lineUuid);
    if (!current || current.executionScopeId !== scopeUuid) {
      throw handymanMaterialExecutionLineNotFoundError();
    }
    const replayEvent = await handymanMaterialExecutionRepository
      .findMaterialExecutionEventByIdempotency(tx, lineUuid,
        kind, key);
    if (replayEvent) {
      if (current.variationId) assertAddReplayQuantity(replayEvent.quantityDelta, deltaQty);
      return { line: current, event: replayEvent, replayed: true };
    }
    if (current.variationId) assertAddMaterialPrecision(deltaQty);
    // Legal opening states: anything after acquisition opened
    // (ISSUED/PURCHASED/USED). FINAL_CHARGE_READY closes adjustment.
    if (current.status !== 'ISSUED'
        && current.status !== 'PURCHASED'
        && current.status !== 'USED') {
      throw handymanMaterialExecutionIllegalTransitionError(
        current.status, kind);
    }
    const isAdd = current.variationId !== null;
    const nextUsed = kind === 'USE'
      ? materialQuantity(current.usedQty + deltaQty, isAdd)
      : current.usedQty;
    const nextReturned = kind === 'RETURN'
      ? materialQuantity(current.returnedQty + deltaQty, isAdd)
      : current.returnedQty;
    // Frozen quantity caps: the usage basis may never go negative —
    // (a) used, including this delta, may not exceed what is held
    // after previously returned quantities;
    // (b) returned, including this delta, may not exceed what
    // remains used.
    if (nextUsed > materialQuantity(current.issuedQty + current.purchasedQty - nextReturned, isAdd)) {
      throw handymanMaterialExecutionQuantityExceededError(
        'use-exceeds-held-quantity');
    }
    if (nextReturned > materialQuantity(current.issuedQty + current.purchasedQty - nextUsed, isAdd)) {
      throw handymanMaterialExecutionQuantityExceededError(
        'return-exceeds-used-quantity');
    }
    if (kind === 'USE') {
      await assertMaterialQuantityAuthority(tx, current, nextUsed);
    }
    const headed = await handymanMaterialExecutionRepository
      .updateMaterialExecutionLineHead(tx, lineUuid, {
        status: kind === 'USE' ? 'USED' : current.status,
        acquisitionMode: current.acquisitionMode,
        approvedQty: current.approvedQty,
        issuedQty: current.issuedQty,
        purchasedQty: current.purchasedQty,
        usedQty: nextUsed,
        returnedQty: nextReturned,
        supplierReference: current.supplierReference,
      });
    if (!headed) throw handymanMaterialExecutionLineNotFoundError();
    const event = await handymanMaterialExecutionRepository
      .appendMaterialExecutionEvent(tx, {
        clientId: current.clientId,
        lineId: lineUuid,
        executionScopeId: scopeUuid,
        eventType: kind,
        idempotencyKey: key,
        actorUserId: actorUuid,
        ...(current.variationId ? { quantityDelta: deltaQty } : {}),
      });
    return { line: headed, event, replayed: false };
  });
}

/**
 * USE: consume `quantity` on the count-as-used axis. Consumption
 * follows the acquisition axis semantics (never changes the mode
 * chosen at acquisition). Partial uses are legal. First USE moves
 * the line ISSUED|PURCHASED -> USED; further USEs accumulate.
 */
export async function useHandymanMaterialExecutionLine(
  input: UsageHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  return adjustUsageHandymanMaterialLine('USE', input, actorUserId);
}

/**
 * RETURN: hand back `quantity` of the held-not-used remainder.
 * Partial returns are legal; the status is NOT sticky (RETURNED is
 * not a status). The returned quantity reduces the final usage
 * basis: finalUsedQty = usedQty - returnedQty.
 */
export async function returnHandymanMaterialExecutionLine(
  input: UsageHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  return adjustUsageHandymanMaterialLine('RETURN', input,
    actorUserId);
}

/**
 * FINAL_CHARGE_READY: close one line's execution history for
 * downstream pricing/ledger. The line must have passed acquisition
 * (ISSUED/PURCHASED/USED). Replay of the same SETTLE key returns the
 * SAME event; a new key afterward is a bounded 409.
 */
export async function settleHandymanMaterialExecutionLine(
  input: SettleHandymanMaterialLineInput,
  actorUserId: string,
): Promise<HandymanMaterialExecutionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const lineUuid = ensureUuid(input.lineId, 'lineId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  await authorityPreamble(scopeUuid, actorUuid);

  return withTransaction(async (tx) => {
    const current = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineByIdForUpdate(tx, lineUuid);
    if (!current || current.executionScopeId !== scopeUuid) {
      throw handymanMaterialExecutionLineNotFoundError();
    }
    const replayEvent = await handymanMaterialExecutionRepository
      .findMaterialExecutionEventByIdempotency(tx, lineUuid,
        'FINAL_CHARGE_READY', key);
    if (replayEvent) {
      return { line: current, event: replayEvent, replayed: true };
    }
    if (current.status !== 'ISSUED'
        && current.status !== 'PURCHASED'
        && current.status !== 'USED') {
      throw handymanMaterialExecutionIllegalTransitionError(
        current.status, 'FINAL_CHARGE_READY');
    }
    const headed = await handymanMaterialExecutionRepository
      .updateMaterialExecutionLineHead(tx, lineUuid, {
        status: 'FINAL_CHARGE_READY',
        acquisitionMode: current.acquisitionMode,
        approvedQty: current.approvedQty,
        issuedQty: current.issuedQty,
        purchasedQty: current.purchasedQty,
        usedQty: current.usedQty,
        returnedQty: current.returnedQty,
        supplierReference: current.supplierReference,
      });
    if (!headed) throw handymanMaterialExecutionLineNotFoundError();
    const event = await handymanMaterialExecutionRepository
      .appendMaterialExecutionEvent(tx, {
        clientId: current.clientId,
        lineId: lineUuid,
        executionScopeId: scopeUuid,
        eventType: 'FINAL_CHARGE_READY',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { line: headed, event, replayed: false };
  });
}

/**
 * FINAL_CHARGE_READY usage-basis read projection over ONE execution
 * scope (READ-ONLY, server-side): the exact settled lines and ONE
 * aggregated final-used figure. This module NEVER computes amounts;
 * the projection hands nothing but quantities to CR-HM-12/13.
 */
export async function getHandymanMaterialFinalChargeReadyProjection(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanMaterialFinalChargeReadyProjection> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  await authorityPreamble(scopeUuid, ensureUuid(actorUserId,
    'actorUserId'));
  const lines = (await handymanMaterialExecutionRepository
    .listMaterialExecutionLinesByScope(undefined, scopeUuid))
    .filter((line) => line.status === 'FINAL_CHARGE_READY');
  const totalFinalUsedQty = lines.reduce(
    (sum, line) => sum + (line.usedQty - line.returnedQty), 0);
  return {
    executionScopeId: scopeUuid,
    lines,
    totalFinalUsedQty,
  };
}

/**
 * CR-HM-17 GAP PART 03 — Customer Care material execution lines read
 * projection across all governed statuses on an execution scope.
 * Enforces the BE-02G exact-Building guard against the scope's building
 * without requiring Crew Lead identity (Customer Care authority
 * separation is preserved — this read never enters the Lead preamble).
 */
export async function getHandymanMaterialLinesCustomerCareView(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanCustomerCareMaterialLinesProjection> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');

  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();

  // CR-HM-SEC-02 PART 04 (PART 00A frozen decision D3) — the execution
  // scope is building-scoped (`building_id UUID NOT NULL`, migration
  // 0395), so the BE-02G exact-Building guard — not the client-level
  // `canAccessClient` shortcut — is the authoritative wall. A
  // same-Client SIBLING-building actor must not receive material lines
  // or events. Ordering preserved: scope 404 → exact-building
  // authorization → material/event projection.
  await assertBuildingScopedResourceAccess(actorUuid, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });

  const lineRecords = await handymanMaterialExecutionRepository
    .listMaterialExecutionLinesByScope(undefined, scopeUuid);

  const lines: HandymanCustomerCareMaterialLineItem[] = [];
  let totalFinalUsedQty = 0;

  for (const line of lineRecords) {
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, line.id);
    const isSettled = line.status === 'FINAL_CHARGE_READY';
    const finalUsedQty = isSettled ? line.usedQty - line.returnedQty : null;
    if (isSettled) {
      totalFinalUsedQty += line.usedQty - line.returnedQty;
    }
    lines.push({
      line,
      events,
      finalUsedQty,
    });
  }

  return {
    executionScopeId: scopeUuid,
    lines,
    totalFinalUsedQty,
  };
}

export const listHandymanMaterialLinesByScope =
  getHandymanMaterialLinesCustomerCareView;
