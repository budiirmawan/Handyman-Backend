/**
 * HANDYMAN E2E R1A — proposed appointment admission core.
 *
 * This module is deliberately pure and UNWIRED. It is not a booking API,
 * reservation engine, or authorization provider. Its inputs must be read from
 * trusted backend repositories after independent authentication/authorization.
 * In particular a client MUST NOT supply `verifiedByServer` or gate facts.
 *
 * Distinct authorities: optional pre-quotation INSPECTION visit vs approved
 * post-quotation EXECUTION visit. The frozen CR-HM-03 single immutable
 * inspection result and CR-HM-05 readiness rows are NOT modified here.
 */

export type HandymanAppointmentKind = 'INSPECTION' | 'EXECUTION';
export type HandymanCapacityStatus =
  | 'PROPOSED'
  | 'TENANT_SELECTED'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export interface HandymanAppointmentInterval {
  startAt: string; // ISO 8601 with offset / UTC; never local time without offset
  endAt: string;
  timezone: string; // authoritative building's IANA timezone
}

/** Only issued by a trusted, independently authenticated consent service. */
export interface VerifiedTenantChoice {
  requestId: string;
  tenantId: string;
  kind: HandymanAppointmentKind;
  selectedStartAt: string;
  selectedEndAt: string;
  consentEvidenceId: string;
  verifiedByServer: boolean;
}

export interface ExistingCapacityBooking extends HandymanAppointmentInterval {
  appointmentId: string;
  resourceId: string;
  status: HandymanCapacityStatus;
}

export interface ServerEvaluatedGate {
  /** Whether this requirement applies, derived from scoped configuration. */
  required: boolean;
  /** True only after the backend has evaluated the effective rule. */
  policyEvaluated: boolean;
  /** True only when a required permit/access clearance is valid right now. */
  satisfied: boolean;
}

export interface HandymanAppointmentAdmissionFacts {
  kind: HandymanAppointmentKind;
  appointmentId?: string;
  requestId: string;
  tenantId: string;
  buildingId: string;
  resourceId: string; // inspector or assigned crew capacity identity
  resourceEligible: boolean; // from scoped workforce authority
  interval: HandymanAppointmentInterval;
  choice: VerifiedTenantChoice | null;
  /** From authoritative request / quotation rows; NEVER from request JSON. */
  inspectionRequired: boolean;
  quotationApproved: boolean;
  permit: ServerEvaluatedGate;
  siteAccess: ServerEvaluatedGate;
  /** Resource's existing bookings, loaded and locked transactionally. */
  existingResourceBookings: readonly ExistingCapacityBooking[];
}

export type HandymanAppointmentBlockCode =
  | 'INVALID_APPOINTMENT_KIND'
  | 'INVALID_IDENTITY_SCOPE'
  | 'INVALID_TIME_WINDOW'
  | 'INVALID_TIMEZONE'
  | 'INELIGIBLE_RESOURCE'
  | 'INSPECTION_NOT_REQUIRED'
  | 'QUOTATION_NOT_APPROVED'
  | 'TENANT_CHOICE_NOT_VERIFIED'
  | 'TENANT_CHOICE_MISMATCH'
  | 'PERMIT_POLICY_UNRESOLVED'
  | 'PERMIT_NOT_READY'
  | 'SITE_ACCESS_POLICY_UNRESOLVED'
  | 'SITE_ACCESS_NOT_READY'
  | 'CAPACITY_CONFLICT';

export interface HandymanAppointmentAdmission {
  eligible: boolean;
  blockers: HandymanAppointmentBlockCode[];
}

const CAPACITY_BLOCKING: ReadonlySet<HandymanCapacityStatus> =
  new Set(['CONFIRMED', 'IN_PROGRESS']);
const OFFSET_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;

function instant(input: string): number | null {
  if (typeof input !== 'string' || !OFFSET_ISO.test(input)) return null;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Adjacent intervals are allowed; overlapping closed-open slots are not. */
export function intervalsOverlap(
  first: Pick<HandymanAppointmentInterval, 'startAt' | 'endAt'>,
  second: Pick<HandymanAppointmentInterval, 'startAt' | 'endAt'>,
): boolean {
  const a0 = instant(first.startAt);
  const a1 = instant(first.endAt);
  const b0 = instant(second.startAt);
  const b1 = instant(second.endAt);
  if (a0 === null || a1 === null || b0 === null || b1 === null) return false;
  if (a0 >= a1 || b0 >= b1) return false;
  return a0 < b1 && b0 < a1;
}

function validTimezone(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function sameInstant(first: string, second: string): boolean {
  const a = instant(first);
  const b = instant(second);
  return a !== null && b !== null && a === b;
}

/**
 * Pre-admission validation only, with no database or mutation side effects.
 * A positive outcome is NEVER evidence that capacity has been reserved.
 * The actual booking transaction must serialise conflicting resource windows
 * (e.g. exclusion constraint/lock) and re-evaluate every derived fact.
 */
export function evaluateHandymanAppointmentAdmission(
  facts: HandymanAppointmentAdmissionFacts,
  phase: 'BOOKING' | 'VISIT_START' = 'BOOKING',
): HandymanAppointmentAdmission {
  const blockers: HandymanAppointmentBlockCode[] = [];
  const add = (code: HandymanAppointmentBlockCode): void => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (facts.kind !== 'INSPECTION' && facts.kind !== 'EXECUTION') {
    add('INVALID_APPOINTMENT_KIND');
  }
  if (![facts.requestId, facts.tenantId, facts.buildingId, facts.resourceId].every(
    (item) => typeof item === 'string' && item.trim().length > 0,
  )) {
    add('INVALID_IDENTITY_SCOPE');
  }
  const start = instant(facts.interval.startAt);
  const end = instant(facts.interval.endAt);
  if (start === null || end === null || start >= end) add('INVALID_TIME_WINDOW');
  if (!validTimezone(facts.interval.timezone)) add('INVALID_TIMEZONE');
  if (!facts.resourceEligible) add('INELIGIBLE_RESOURCE');
  if (facts.kind === 'INSPECTION' && !facts.inspectionRequired) {
    add('INSPECTION_NOT_REQUIRED');
  }
  if (facts.kind === 'EXECUTION' && !facts.quotationApproved) {
    add('QUOTATION_NOT_APPROVED');
  }

  const choice = facts.choice;
  if (!choice || !choice.verifiedByServer || !choice.consentEvidenceId) {
    add('TENANT_CHOICE_NOT_VERIFIED');
  } else if (
    choice.requestId !== facts.requestId ||
    choice.tenantId !== facts.tenantId ||
    choice.kind !== facts.kind ||
    !sameInstant(choice.selectedStartAt, facts.interval.startAt) ||
    !sameInstant(choice.selectedEndAt, facts.interval.endAt)
  ) {
    add('TENANT_CHOICE_MISMATCH');
  }

  // Permit/clearance is a visit-START gate by default; a future confirmed
  // booking can legitimately await site approval. Do not block slot booking
  // merely because external Security has not yet cleared the appointment.
  if (phase === 'VISIT_START') {
    if (!facts.permit?.policyEvaluated) {
      add('PERMIT_POLICY_UNRESOLVED');
    } else if (facts.permit.required && !facts.permit.satisfied) {
      add('PERMIT_NOT_READY');
    }
    if (!facts.siteAccess?.policyEvaluated) {
      add('SITE_ACCESS_POLICY_UNRESOLVED');
    } else if (facts.siteAccess.required && !facts.siteAccess.satisfied) {
      add('SITE_ACCESS_NOT_READY');
    }
  }

  if (start !== null && end !== null && start < end) {
    for (const booking of facts.existingResourceBookings) {
      if (
        booking.resourceId === facts.resourceId &&
        booking.appointmentId !== facts.appointmentId &&
        CAPACITY_BLOCKING.has(booking.status) &&
        intervalsOverlap(facts.interval, booking)
      ) {
        add('CAPACITY_CONFLICT');
        break;
      }
    }
  }

  return { eligible: blockers.length === 0, blockers };
}

export type HandymanVisitAttemptOutcome =
  | 'COMPLETED'
  | 'NO_SHOW'
  | 'ACCESS_BLOCKED'
  | 'ABORTED'
  | 'REBOOK_REQUIRED';

/** Failed visit attempts must NEVER consume CR-HM-03's one final result. */
export function isEligibleFinalInspectionAttempt(
  kind: HandymanAppointmentKind,
  outcome: HandymanVisitAttemptOutcome,
  completedEvidenceVerifiedByServer: boolean,
): boolean {
  return kind === 'INSPECTION' &&
    outcome === 'COMPLETED' &&
    completedEvidenceVerifiedByServer;
}
