/**
 * BE-12G — Security Shift Handover domain types.
 *
 * A Security Shift Handover binding associates an existing BE-10J
 * `shift_handovers` row with a Security operational context — a BE-12A
 * start Security Post and an optional BE-12B Patrol Route — under the
 * same Building. The BE-10J lifecycle (DRAFT → READY → ACKNOWLEDGED)
 * remains authoritative on the handover row; this binding layer only
 * records the Security context alongside it.
 *
 * The binding's own status is ACTIVE/INACTIVE so an INACTIVE binding
 * never blocks a re-bind and does not affect the underlying handover
 * lifecycle. The binding does not duplicate the handover status.
 */

export const SECURITY_SHIFT_HANDOVER_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type SecurityShiftHandoverBindingStatus =
  (typeof SECURITY_SHIFT_HANDOVER_BINDING_STATUSES)[number];

export function isSecurityShiftHandoverBindingStatus(
  value: unknown,
): value is SecurityShiftHandoverBindingStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_SHIFT_HANDOVER_BINDING_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/** Full database record. */
export type SecurityShiftHandoverBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  shiftHandoverId: string;
  startSecurityPostId: string | null;
  patrolRouteId: string | null;
  status: SecurityShiftHandoverBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicSecurityShiftHandoverBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  shiftHandoverId: string;
  startSecurityPostId: string | null;
  patrolRouteId: string | null;
  status: SecurityShiftHandoverBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSecurityShiftHandoverBindingInput = {
  buildingId: string;
  shiftHandoverId: string;
  startSecurityPostId?: string | null;
  patrolRouteId?: string | null;
  status?: SecurityShiftHandoverBindingStatus;
  createdByUserId: string;
};

export type UpdateSecurityShiftHandoverBindingInput = {
  startSecurityPostId?: string | null;
  patrolRouteId?: string | null;
  status?: SecurityShiftHandoverBindingStatus;
};

export type SecurityShiftHandoverBindingFilter = {
  buildingId?: string;
  shiftHandoverId?: string;
  startSecurityPostId?: string;
  patrolRouteId?: string;
  status?: SecurityShiftHandoverBindingStatus;
};
