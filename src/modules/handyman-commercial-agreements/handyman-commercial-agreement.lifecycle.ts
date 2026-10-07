/**
 * CR-HM-12 PART 01 — commercial agreement version lifecycle guards.
 * ACTIVATE: DRAFT → ACTIVE. SUPERSEDE: ACTIVE → SUPERSEDED.
 * SUPERSEDED is terminal. nextHandymanCommercialAgreementVersionStatus
 * is the only status authority; a consumer never resolves "latest"
 * (frozen §5 binding law). No pricing evaluation, no fee math.
 */

import {
  handymanCommercialAgreementIllegalTransitionError,
  handymanCommercialAgreementValidationError,
} from './handyman-commercial-agreement.errors';
import type {
  HandymanCommercialAgreementEventType,
  HandymanCommercialAgreementStatus,
} from './handyman-commercial-agreement.types';

const ACTIVATE_FROM: readonly HandymanCommercialAgreementStatus[] = [
  'DRAFT',
];
const SUPERSEDE_FROM: readonly HandymanCommercialAgreementStatus[] = [
  'ACTIVE',
];

export function nextHandymanCommercialAgreementVersionStatus(
  from: HandymanCommercialAgreementStatus,
  action: HandymanCommercialAgreementEventType | string,
): HandymanCommercialAgreementStatus {
  if (action === 'ACTIVATE') {
    if (!ACTIVATE_FROM.includes(from)) {
      throw handymanCommercialAgreementIllegalTransitionError(from, action);
    }
    return 'ACTIVE';
  }
  if (action === 'SUPERSEDE') {
    if (!SUPERSEDE_FROM.includes(from)) {
      throw handymanCommercialAgreementIllegalTransitionError(from, action);
    }
    return 'SUPERSEDED';
  }
  throw handymanCommercialAgreementIllegalTransitionError(
    from,
    String(action ?? ''),
  );
}

/** Parse a strict ISO timestamp; illegal shape is a bounded failure. */
export function parseHandymanAgreementTimestamp(
  value: unknown,
  field: string,
): Date {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw handymanCommercialAgreementValidationError(field);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw handymanCommercialAgreementValidationError(field);
  }
  return parsed;
}

/**
 * Supersession window law (frozen §5/§10): the replacement version
 * becomes effective STRICTLY after the current ACTIVE version's
 * effective_from. Closing at or before the open of the window it
 * closes is illegal.
 */
export function assertHandymanAgreementSupersessionWindow(
  currentEffectiveFrom: Date,
  replacementEffectiveFrom: Date,
): void {
  if (replacementEffectiveFrom.getTime() <= currentEffectiveFrom.getTime()) {
    throw handymanCommercialAgreementValidationError('effectiveFrom');
  }
}
