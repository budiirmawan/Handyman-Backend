/**
 * CR-HM-12 PART 02 — PURE execution evaluator for labor pricing
 * basis definitions (FROZEN `CR-HM-12_START_GOVERNANCE.md` §6: the
 * LABOR basis consumes approved LABOR facts + governed timeline and
 * crew inputs; CR-HM-12 never fabricates presence/work time and
 * never infers billable time from CHECK_IN alone).
 *
 * Inputs are SUPPLIED by the consumer from read-only authority
 * (CR-HM-08 published timeline projections, CR-HM-04 crew truth).
 * This module reads nothing, writes nothing, and produces a governed
 * basis amount — NOT a final transaction charge. Charge composition
 * and posting belong to CR-HM-13.
 *
 * Laws (frozen here):
 *  - money is cent-exact: unitAmount is a NUMERIC(18,2) string;
 *    results are integer-cent arithmetic, half-up at the cent,
 *    returned as exact 2-decimal text;
 *  - HOURLY requires billableMinutes (integer ≥ 0, from the
 *    definition's billableTimeBasis ONLY); amount accumulates
 *    unit × minutes / 60;
 *  - VISIT_FEE requires visitCount (integer ≥ 0); amount is
 *    unit × visits;
 *  - FIXED_SCOPE / INSPECTION_FIRST take neither input and resolve
 *    to the scope-total unit;
 *  - PER_HEAD multiplies the unit by crewHeadcount (integer ≥ 1);
 *    PER_CREW prices the crew as one unit (headcount never
 *    multiplies);
 *  - unknown/extra inputs are bounded validation failures — never
 *    silently ignored.
 */

import { handymanLaborPricingValidationError }
  from './handyman-labor-pricing.errors';
import type {
  HandymanBillableTimeBasis,
  HandymanCrewPricingMode,
  HandymanLaborPricingCurrency,
  HandymanLaborPricingMode,
} from './handyman-labor-pricing.types';
import {
  isHandymanLaborPricingCurrency,
  isHandymanLaborPricingMode,
} from './handyman-labor-pricing.types';

export type HandymanLaborPricingBasisFacts = {
  mode: HandymanLaborPricingMode;
  crewMode: HandymanCrewPricingMode;
  billableTimeBasis: HandymanBillableTimeBasis | null;
  unitAmount: string;
  currency: HandymanLaborPricingCurrency;
};

export type HandymanLaborPricingExecuteInput = {
  /** Required for HOURLY; must be absent otherwise. */
  billableMinutes?: number;
  /** Required for VISIT_FEE; must be absent otherwise. */
  visitCount?: number;
  /** Always required; multiplies only under PER_HEAD. */
  crewHeadcount: number;
};

export type HandymanLaborPricingBasisResult = {
  mode: HandymanLaborPricingMode;
  crewMode: HandymanCrewPricingMode;
  billableTimeBasis: HandymanBillableTimeBasis | null;
  unitAmount: string;
  basisAmount: string;
  currency: HandymanLaborPricingCurrency;
  appliedMinutes: number | null;
  appliedVisits: number | null;
  appliedHeads: number;
};

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

export function parseHandymanLaborUnitAmount(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!MONEY_PATTERN.test(raw)) {
    throw handymanLaborPricingValidationError('unitAmount');
  }
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(cents)) {
    throw handymanLaborPricingValidationError('unitAmount');
  }
  return (cents / 100).toFixed(2);
}

function requireNonNegativeInteger(
  value: number | undefined,
  field: string,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw handymanLaborPricingValidationError(field);
  }
  return value;
}

/** Shape law — must mirror the migration CHECK exactly. */
export function assertHandymanLaborPricingShape(
  facts: {
    mode: string;
    crewMode: string;
    billableTimeBasis: string | null;
  },
): void {
  if (!isHandymanLaborPricingMode(facts.mode)) {
    throw handymanLaborPricingValidationError('mode');
  }
  if (!(facts.crewMode === 'PER_HEAD' || facts.crewMode === 'PER_CREW')) {
    throw handymanLaborPricingValidationError('crewMode');
  }
  if (
    (facts.mode === 'FIXED_SCOPE' || facts.mode === 'INSPECTION_FIRST')
    && facts.crewMode !== 'PER_CREW'
  ) {
    throw handymanLaborPricingValidationError('crewMode');
  }
  if (facts.mode === 'HOURLY') {
    if (
      facts.billableTimeBasis !== 'PRESENCE'
      && facts.billableTimeBasis !== 'ACTUAL_WORK'
    ) {
      throw handymanLaborPricingValidationError('billableTimeBasis');
    }
  } else if (facts.billableTimeBasis !== null) {
    throw handymanLaborPricingValidationError('billableTimeBasis');
  }
}

function halfUpCents(exactCents: number): number {
  if (!Number.isFinite(exactCents)) {
    throw handymanLaborPricingValidationError('unitAmount');
  }
  const result = Math.floor(exactCents + 0.5);
  if (!Number.isSafeInteger(result)) {
    throw handymanLaborPricingValidationError('unitAmount');
  }
  return result;
}

function centsToText(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw handymanLaborPricingValidationError('unitAmount');
  }
  return (cents / 100).toFixed(2);
}

/**
 * Evaluate the governed labor basis for one execution scope against
 * one definition. Deterministic, pure, side-effect free.
 */
export function evaluateHandymanLaborPricingBasis(
  facts: HandymanLaborPricingBasisFacts,
  input: HandymanLaborPricingExecuteInput,
): HandymanLaborPricingBasisResult {
  assertHandymanLaborPricingShape(facts);
  if (!isHandymanLaborPricingCurrency(facts.currency)) {
    throw handymanLaborPricingValidationError('currency');
  }
  const unit = parseHandymanLaborUnitAmount(facts.unitAmount);
  const baseCents = Math.round(Number(unit) * 100);

  const heads = requireNonNegativeInteger(
    input.crewHeadcount, 'crewHeadcount',
  );
  if (heads < 1) {
    throw handymanLaborPricingValidationError('crewHeadcount');
  }
  const headFactor = facts.crewMode === 'PER_HEAD' ? heads : 1;

  let basisCents = 0;
  let appliedMinutes: number | null = null;
  let appliedVisits: number | null = null;

  if (facts.mode === 'HOURLY') {
    appliedMinutes = requireNonNegativeInteger(
      input.billableMinutes, 'billableMinutes',
    );
    basisCents = halfUpCents(
      (baseCents * appliedMinutes * headFactor) / 60,
    );
  } else if (facts.mode === 'VISIT_FEE') {
    appliedVisits = requireNonNegativeInteger(
      input.visitCount, 'visitCount',
    );
    basisCents = halfUpCents(baseCents * appliedVisits * headFactor);
  } else {
    if (input.billableMinutes !== undefined
      || input.visitCount !== undefined) {
      throw handymanLaborPricingValidationError('billableMinutes');
    }
    basisCents = halfUpCents(baseCents);
  }

  return {
    mode: facts.mode,
    crewMode: facts.crewMode,
    billableTimeBasis: facts.billableTimeBasis,
    unitAmount: unit,
    basisAmount: centsToText(basisCents),
    currency: facts.currency,
    appliedMinutes,
    appliedVisits,
    appliedHeads: facts.crewMode === 'PER_HEAD' ? heads : 1,
  };
}
