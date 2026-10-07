import type { BastRequirement } from '../work-orders';

/**
 * Deterministic reasons why canonical BE-22 state does not yet permit Work
 * Order closure. These are readiness facts only; Work Order remains the sole
 * owner of the CLOSED transition.
 */
export const BAST_CLOSURE_BLOCKER_CODES = [
  'CANONICAL_CONTEXT_MISMATCH',
  'NO_APPLICABLE_VENDOR_WORK',
  'REQUIRED_BAST_MISSING',
  'REQUIRED_BAST_CARDINALITY_VIOLATION',
  'REQUIRED_BAST_NOT_ACCEPTED',
  'ACCEPTANCE_NOT_TRACEABLE',
  'RECONCILIATION_QUARANTINED',
  'UNRESOLVED_BAST_REWORK',
  'UNRESOLVED_VENDOR_REWORK',
] as const;

export type BastClosureBlockerCode =
  (typeof BAST_CLOSURE_BLOCKER_CODES)[number];

export type BastClosureBlocker = {
  code: BastClosureBlockerCode;
  /** Present only for a context-valid Vendor Work scope. */
  vendorWorkId?: string;
};

export type WorkOrderBastClosureReadiness = {
  requirement: BastRequirement;
  ready: boolean;
  blockers: BastClosureBlocker[];
};
