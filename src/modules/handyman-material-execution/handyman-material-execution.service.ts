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
  handymanMaterialExecutionScopeNotEligibleError,
  handymanMaterialExecutionValidationError,
} from './handyman-material-execution.errors';
import { handymanMaterialExecutionRepository }
  from './handyman-material-execution.repository';
import type {
  ApproveHandymanMaterialLineInput,
  EstimateHandymanMaterialLineInput,
  HandymanMaterialExecutionCommandResult,
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
