/**
 * CR-HM-12 PART 03 — PURE material pricing basis evaluator (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §6). Deterministic, side-effect
 * free, reads and writes nothing.
 *
 * Laws (frozen here):
 *  - the basis quantity per settled line is chosen by the mode:
 *    SETTLED_USAGE -> finalUsedQty (actual usedQty; returned unused
 *    stock does not reverse consumption); APPROVED_QTY -> approvedQty;
 *  - quantity law inherited from CR-HM-09: 0 <= finalUsedQty <=
 *    approvedQty, both finite and non-negative — a violation is a
 *    bounded input failure, never a reinterpretation of execution
 *    history;
 *  - the unit amount is the CR-HM-06 approved MATERIAL snapshot
 *    (exact 2dp text); it is NEVER recomputed from reference price
 *    (B1) and NEVER re-stored (snapshot immutability, B4);
 *  - one currency per evaluation (same law as one currency per
 *    quotation version); mixing is a bounded failure;
 *  - money is cent-exact: line amount = round-half-up(unit cents *
 *    qty), scope basis = exact sum of line cents;
 *  - the result is a MATERIAL pricing basis figure only — it is not
 *    a final transaction charge, and it is never merged with any
 *    LABOR figure (B10); composition of customer charges is
 *    CR-HM-13's to decide against its own CR.
 */

import { handymanMaterialPricingValidationError }
  from './handyman-material-pricing.errors';
import type {
  HandymanMaterialPricingBasisEvaluation,
  HandymanMaterialPricingLineInput,
  HandymanMaterialPricingMode,
} from './handyman-material-pricing.types';
import { isHandymanMaterialPricingMode } from './handyman-material-pricing.types';

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})$/;

export function assertHandymanMaterialUnitAmount(value: string): string {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value.trim())) {
    throw handymanMaterialPricingValidationError('finalQuotedUnitAmount');
  }
  return value.trim();
}

function assertQty(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw handymanMaterialPricingValidationError(field);
  }
  return value;
}

function halfUpCents(exactCents: number): number {
  if (!Number.isFinite(exactCents) || exactCents < 0) {
    throw handymanMaterialPricingValidationError('lines');
  }
  const result = Math.floor(exactCents + 0.5);
  if (!Number.isSafeInteger(result)) {
    throw handymanMaterialPricingValidationError('lines');
  }
  return result;
}

export function evaluateHandymanMaterialPricingBasis(
  mode: string,
  lines: readonly HandymanMaterialPricingLineInput[],
): HandymanMaterialPricingBasisEvaluation {
  if (!isHandymanMaterialPricingMode(mode)) {
    throw handymanMaterialPricingValidationError('mode');
  }
  const basisMode = mode as HandymanMaterialPricingMode;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw handymanMaterialPricingValidationError('lines');
  }

  let currency: string | null = null;
  let totalCents = 0;
  const evaluated = lines.map((line) => {
    if (
      typeof line.quotationLineId !== 'string'
      || line.quotationLineId.length === 0
      || typeof line.materialExecutionLineId !== 'string'
      || line.materialExecutionLineId.length === 0
    ) {
      throw handymanMaterialPricingValidationError('lines');
    }
    const unit = assertHandymanMaterialUnitAmount(
      line.finalQuotedUnitAmount,
    );
    const unitCents = Math.round(Number(unit) * 100);
    if (!Number.isSafeInteger(unitCents)) {
      throw handymanMaterialPricingValidationError('finalQuotedUnitAmount');
    }
    const approvedQty = assertQty(line.approvedQty, 'approvedQty');
    const finalUsedQty = assertQty(line.finalUsedQty, 'finalUsedQty');
    if (finalUsedQty > approvedQty) {
      throw handymanMaterialPricingValidationError('finalUsedQty');
    }
    const appliedQty =
      basisMode === 'SETTLED_USAGE' ? finalUsedQty : approvedQty;

    if (typeof line.currency !== 'string' || line.currency.length === 0) {
      throw handymanMaterialPricingValidationError('currency');
    }
    if (currency === null) {
      currency = line.currency;
    } else if (currency !== line.currency) {
      throw handymanMaterialPricingValidationError('currency');
    }

    const cents = halfUpCents(unitCents * appliedQty);
    totalCents += cents;
    if (!Number.isSafeInteger(totalCents)) {
      throw handymanMaterialPricingValidationError('lines');
    }
    return {
      quotationLineId: line.quotationLineId,
      materialExecutionLineId: line.materialExecutionLineId,
      finalQuotedUnitAmount: unit,
      appliedQty,
      basisAmount: (cents / 100).toFixed(2),
      currency: line.currency,
    };
  });

  return {
    mode: basisMode,
    currency: currency as string,
    lines: evaluated,
    basisAmount: (totalCents / 100).toFixed(2),
  };
}
