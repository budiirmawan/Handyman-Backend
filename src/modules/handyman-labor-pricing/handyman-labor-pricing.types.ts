/**
 * CR-HM-12 PART 02 — labor & crew pricing-mode basis types ONLY
 * (FROZEN `CR-HM-12_START_GOVERNANCE.md` §4/§5/§10). Modes are the
 * roadmap/capability-map vocabulary; crew application modes and the
 * billable-time basis names bind to CR-HM-08 §11 published
 * projections. Definitions bind to an EXACT agreement version id —
 * never "the current version". ZERO charge/billing/ledger facts
 * exist here; the evaluator is pure and posts nothing. Material
 * basis is PART 03; BM fee rules are PART 04.
 */

export const HANDYMAN_LABOR_PRICING_MODES = [
  'HOURLY',
  'FIXED_SCOPE',
  'INSPECTION_FIRST',
  'VISIT_FEE',
] as const;

export type HandymanLaborPricingMode =
  (typeof HANDYMAN_LABOR_PRICING_MODES)[number];

export function isHandymanLaborPricingMode(
  value: string,
): value is HandymanLaborPricingMode {
  return (HANDYMAN_LABOR_PRICING_MODES as readonly string[]).includes(
    value,
  );
}

export const HANDYMAN_CREW_PRICING_MODES = [
  'PER_HEAD',
  'PER_CREW',
] as const;

export type HandymanCrewPricingMode =
  (typeof HANDYMAN_CREW_PRICING_MODES)[number];

export function isHandymanCrewPricingMode(
  value: string,
): value is HandymanCrewPricingMode {
  return (HANDYMAN_CREW_PRICING_MODES as readonly string[]).includes(
    value,
  );
}

export const HANDYMAN_BILLABLE_TIME_BASES = [
  'PRESENCE',
  'ACTUAL_WORK',
] as const;

export type HandymanBillableTimeBasis =
  (typeof HANDYMAN_BILLABLE_TIME_BASES)[number];

export function isHandymanBillableTimeBasis(
  value: string,
): value is HandymanBillableTimeBasis {
  return (HANDYMAN_BILLABLE_TIME_BASES as readonly string[]).includes(
    value,
  );
}

/** Governed currency list — same frozen 9-currency set as 0392. */
export const HANDYMAN_LABOR_PRICING_CURRENCIES = [
  'IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY',
] as const;

export type HandymanLaborPricingCurrency =
  (typeof HANDYMAN_LABOR_PRICING_CURRENCIES)[number];

export function isHandymanLaborPricingCurrency(
  value: string,
): value is HandymanLaborPricingCurrency {
  return (HANDYMAN_LABOR_PRICING_CURRENCIES as readonly string[])
    .includes(value);
}

export type HandymanLaborPricingBasisRecord = {
  id: string;
  agreementVersionId: string;
  mode: HandymanLaborPricingMode;
  crewMode: HandymanCrewPricingMode;
  billableTimeBasis: HandymanBillableTimeBasis | null;
  /** Exact NUMERIC(18,2) text as stored — governed rule fact. */
  unitAmount: string;
  currency: HandymanLaborPricingCurrency;
  idempotencyKey: string;
  createdByUserId: string;
  createdAt: Date;
};

export type NewHandymanLaborPricingBasis = {
  agreementVersionId: string;
  mode: HandymanLaborPricingMode;
  crewMode: HandymanCrewPricingMode;
  billableTimeBasis: HandymanBillableTimeBasis | null;
  unitAmount: string;
  currency: HandymanLaborPricingCurrency;
  idempotencyKey: string;
  createdByUserId: string;
};
