import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  handymanExecutionScopeNotFoundError,
  handymanExecutionScopeRepository,
  handymanQuotationLineRepository,
  handymanQuotationRepository,
} from '../handyman-quotations';
import { resolveHandymanAssignmentLead }
  from '../handyman-scope-assignments';
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
import type {
  AcquireHandymanMaterialLineInput,
  ApproveHandymanMaterialLineInput,
  EstimateHandymanMaterialLineInput,
  HandymanCustomerCareMaterialLineItem,
  HandymanCustomerCareMaterialLinesProjection,
  HandymanMaterialAcquisitionMode,
  HandymanMaterialExecutionCommandResult,
  HandymanMaterialExecutionEventType,
  HandymanMaterialExecutionProgressLine,
  HandymanMaterialExecutionProgressProjection,
  HandymanMaterialExecutionProgressRow,
  HandymanMaterialFinalChargeReadyLine,
  HandymanMaterialFinalChargeReadyProjection,
  HandymanMaterialFinalUsedTotalByUom,
  SettleHandymanMaterialLineInput,
  UsageHandymanMaterialLineInput,
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

const MAX_NUMERIC_14_3_EXCLUSIVE = 100_000_000_000;
const MATERIAL_QUANTITY_SCALE = 3;

/** Decimal places in the shortest decimal representation of a JSON number. */
function decimalScale(value: number): number {
  const [mantissa, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const fractionalDigits = mantissa.split('.')[1]?.length ?? 0;
  return Math.max(0, fractionalDigits - exponent);
}

/** NUMERIC(14,3): at most 11 integer digits and 3 fractional digits. */
function isPersistableQuantity(value: number): boolean {
  return Math.abs(value) < MAX_NUMERIC_14_3_EXCLUSIVE
    && decimalScale(value) <= MATERIAL_QUANTITY_SCALE;
}

function ensureEstimatedQuantity(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw handymanMaterialExecutionEstimateInvalidError('not-a-number');
  }
  if (value <= 0) {
    throw handymanMaterialExecutionEstimateInvalidError(
      'not-positive');
  }
  if (!isPersistableQuantity(value)) {
    throw handymanMaterialExecutionEstimateInvalidError(
      'numeric-14-3-precision-or-range');
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

  const { scope } = await authorityPreamble(scopeUuid, actorUuid);
  if (scope.status !== 'AUTHORIZED') {
    throw handymanMaterialExecutionScopeNotEligibleError();
  }

  const version = await handymanQuotationRepository.findVersionById(
    undefined,
    versionUuid,
  );
  if (!version || version.id !== scope.approvedQuotationVersionId) {
    // The link MUST anchor to the scope's immutable APPROVED
    // quotation snapshot — never to an arbitrary or pending version.
    throw handymanMaterialExecutionLinkInvalidError(
      'version-not-approved-snapshot');
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
  if (input.sourceItemId != null
      && quoteLine.sourceItemId != null
      && input.sourceItemId !== quoteLine.sourceItemId) {
    throw handymanMaterialExecutionLinkInvalidError(
      'source-item-mismatch-with-approved-line');
  }
  const sourceItemId = input.sourceItemId ?? quoteLine.sourceItemId;

  return withTransaction(async (tx) => {
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
      if (replayEvent && existing.executionScopeId === scopeUuid) {
        return { line: existing, event: replayEvent, replayed: true };
      }
      throw handymanMaterialExecutionLinkConflictError();
    }

    const line = await handymanMaterialExecutionRepository
      .createMaterialExecutionLine(tx, {
        clientId: scope.clientId,
        executionScopeId: scopeUuid,
        quotationVersionId: version.id,
        quotationLineId: quoteLine.id,
        sourceItemId,
        estimatedQty,
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
  if (!isPersistableQuantity(value)) {
    throw handymanMaterialExecutionQuantityExceededError(
      'numeric-14-3-precision-or-range');
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
    const current = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineByIdForUpdate(tx, lineUuid);
    if (!current || current.executionScopeId !== scopeUuid) {
      throw handymanMaterialExecutionLineNotFoundError();
    }
    const replayEvent = await handymanMaterialExecutionRepository
      .findMaterialExecutionEventByIdempotency(tx, lineUuid,
        config.eventType, key);
    if (replayEvent) {
      return { line: current, event: replayEvent, replayed: true };
    }
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
    const nextIssued = mode === 'ISSUED'
      ? current.issuedQty + deltaQty
      : current.issuedQty;
    const nextPurchased = mode === 'PURCHASED'
      ? current.purchasedQty + deltaQty
      : current.purchasedQty;
    // Quantity cap: accumulated possession may never exceed the
    // approved snapshot authority.
    if (nextIssued > current.approvedQty
        || nextPurchased > current.approvedQty) {
      throw handymanMaterialExecutionQuantityExceededError(
        'exceeds-approved-snapshot-quantity');
    }
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
 * USE records consumed quantity; RETURN records held-but-unused
 * quantity. A return therefore never reduces final-used: on settled
 * lines, finalUsedQty = usedQty. USE/RETURN remain bounded quantity
 * adjustments (partials legal) on their factual axes; RETURN is never
 * a sticky status. SETTLE (FINAL_CHARGE_READY) closes the
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
    const current = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineByIdForUpdate(tx, lineUuid);
    if (!current || current.executionScopeId !== scopeUuid) {
      throw handymanMaterialExecutionLineNotFoundError();
    }
    const replayEvent = await handymanMaterialExecutionRepository
      .findMaterialExecutionEventByIdempotency(tx, lineUuid,
        kind, key);
    if (replayEvent) {
      return { line: current, event: replayEvent, replayed: true };
    }
    // Legal opening states: anything after acquisition opened
    // (ISSUED/PURCHASED/USED). FINAL_CHARGE_READY closes adjustment.
    if (current.status !== 'ISSUED'
        && current.status !== 'PURCHASED'
        && current.status !== 'USED') {
      throw handymanMaterialExecutionIllegalTransitionError(
        current.status, kind);
    }
    const nextUsed = kind === 'USE'
      ? current.usedQty + deltaQty
      : current.usedQty;
    const nextReturned = kind === 'RETURN'
      ? current.returnedQty + deltaQty
      : current.returnedQty;
    // Frozen quantity caps: the usage basis may never go negative —
    // (a) used, including this delta, may not exceed what is held
    // after previously returned quantities;
    // (b) returned, including this delta, may not exceed what
    // remains used.
    if (nextUsed > current.issuedQty + current.purchasedQty
          - nextReturned) {
      throw handymanMaterialExecutionQuantityExceededError(
        'use-exceeds-held-quantity');
    }
    if (nextReturned > current.issuedQty + current.purchasedQty
          - nextUsed) {
      throw handymanMaterialExecutionQuantityExceededError(
        'return-exceeds-used-quantity');
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
 * not a status). Returned stock was not consumed, so RETURN does not
 * change final-used; settled finalUsedQty remains usedQty.
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

function toProgressLine(
  row: HandymanMaterialExecutionProgressRow,
): HandymanMaterialExecutionProgressLine {
  const { line } = row;
  const isSettled = line.status === 'FINAL_CHARGE_READY';
  return {
    id: line.id,
    executionScopeId: line.executionScopeId,
    material: {
      description: row.materialDescription,
      sourceItemId: line.sourceItemId,
    },
    uom: row.uom,
    status: line.status,
    acquisitionMode: line.acquisitionMode,
    estimatedQty: line.estimatedQty,
    approvedQty: line.approvedQty,
    issuedQty: line.issuedQty,
    purchasedQty: line.purchasedQty,
    usedQty: line.usedQty,
    returnedQty: line.returnedQty,
    finalUsedQty: isSettled ? line.usedQty : null,
  };
}

async function listAuthorizedProgressRows(
  scopeUuid: string,
  actorUuid: string,
): Promise<HandymanMaterialExecutionProgressRow[]> {
  await authorityPreamble(scopeUuid, actorUuid);
  return handymanMaterialExecutionRepository
    .listMaterialExecutionProgressRowsByScope(undefined, scopeUuid);
}

/**
 * Lead-only material progress over the assigned execution scope.
 * Returns current line heads and quote-linked identity/UOM only; it does
 * not expose events, Customer Care history, or commercial data.
 */
export async function getHandymanMaterialProgressProjection(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanMaterialProgressProjection> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const rows = await listAuthorizedProgressRows(scopeUuid, actorUuid);
  return {
    executionScopeId: scopeUuid,
    lines: rows.map(toProgressLine),
  };
}

function aggregateFinalUsedByUom(
  lines: readonly HandymanMaterialExecutionProgressLine[],
): HandymanMaterialFinalUsedTotalByUom[] {
  const totals = new Map<string, HandymanMaterialFinalUsedTotalByUom>();
  for (const line of lines) {
    const finalUsedQty = line.finalUsedQty ?? 0;
    const current = totals.get(line.uom.id);
    totals.set(line.uom.id, {
      uom: line.uom,
      totalFinalUsedQty: Number(
        ((current?.totalFinalUsedQty ?? 0) + finalUsedQty).toFixed(3),
      ),
    });
  }
  return [...totals.values()].sort((a, b) => a.uom.id.localeCompare(b.uom.id));
}

/**
 * FINAL_CHARGE_READY quantity handoff over one execution scope. Settled
 * line quantities and the aggregate are grouped by the authoritative
 * quotation-line UOM; a RETURN only records unused stock and cannot reduce
 * final-used quantity. This module computes no commercial amounts.
 */
export async function getHandymanMaterialFinalChargeReadyProjection(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanMaterialFinalChargeReadyProjection> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const rows = await listAuthorizedProgressRows(scopeUuid, actorUuid);
  const lines: HandymanMaterialFinalChargeReadyLine[] = rows
    .map((row) => ({
      ...toProgressLine(row),
      quotationLineId: row.line.quotationLineId,
    }))
    .filter((line) => line.status === 'FINAL_CHARGE_READY');
  return {
    executionScopeId: scopeUuid,
    lines,
    totalsByUom: aggregateFinalUsedByUom(lines),
  };
}

/**
 * CR-HM-17 GAP PART 03 — Customer Care material execution lines read
 * projection across all governed statuses on an execution scope.
 * Enforces `canAccessClient(actorUserId, scope.clientId)` without
 * requiring Crew Lead identity.
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

  const allowed = await contextAccessService.canAccessClient(
    actorUuid,
    scope.clientId,
  );
  if (!allowed) throw buildingAccessDeniedError();

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
