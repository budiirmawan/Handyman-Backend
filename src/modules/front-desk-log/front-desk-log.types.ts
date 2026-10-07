/**
 * BE-13L — Front Desk Log read-model types.
 *
 * Events are projected from authoritative BE-13 records at read time.
 * No Visitor or Visit data is copied into another persistence engine.
 */

export const FRONT_DESK_ACTIVITY_TYPES = [
  'INVITATION_CREATED',
  'EXPECTED_VISITOR_REGISTERED',
  'WALK_IN_REGISTERED',
  'HOST_CONFIRMATION_REQUESTED',
  'HOST_CONFIRMATION_CONFIRMED',
  'HOST_CONFIRMATION_REJECTED',
  'VISIT_CHECKED_IN',
  'VISIT_CHECKED_OUT',
  'VISITOR_PASS_ISSUED',
  'VISITOR_PASS_RETURNED',
  'VISITOR_PASS_CANCELLED',
  'CONTRACTOR_VISITOR_REGISTERED',
  'DELIVERY_COURIER_ARRIVED',
  'DELIVERY_COURIER_RECEIVED',
  'DELIVERY_COURIER_REJECTED',
  'DELIVERY_COURIER_CANCELLED',
] as const;

export type FrontDeskActivityType =
  (typeof FRONT_DESK_ACTIVITY_TYPES)[number];

export function isFrontDeskActivityType(
  value: unknown,
): value is FrontDeskActivityType {
  return (
    typeof value === 'string' &&
    (FRONT_DESK_ACTIVITY_TYPES as readonly string[]).includes(value)
  );
}

export const FRONT_DESK_SOURCE_TYPES = [
  'VISITOR_INVITATION',
  'EXPECTED_VISITOR',
  'WALK_IN_VISIT',
  'HOST_CONFIRMATION',
  'VISIT_CHECK_IN',
  'VISITOR_PASS',
  'CONTRACTOR_VISITOR',
  'DELIVERY_COURIER',
] as const;

export type FrontDeskSourceType =
  (typeof FRONT_DESK_SOURCE_TYPES)[number];

export type FrontDeskLogRecord = {
  id: string;
  activityType: FrontDeskActivityType;
  sourceType: FrontDeskSourceType;
  sourceId: string;
  clientId: string;
  buildingId: string;
  visitorId: string | null;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  visitCheckInId: string | null;
  actorUserId: string;
  occurredAt: Date;
  notes: string | null;
};

export type PublicFrontDeskLog = Omit<FrontDeskLogRecord, 'occurredAt'> & {
  occurredAt: string;
};

export type FrontDeskLogFilters = {
  buildingId?: string;
  visitorId?: string;
  activityType?: FrontDeskActivityType;
  /** Inclusive ISO lower timestamp bound. */
  occurredFrom?: string;
  /** Inclusive ISO upper timestamp bound. */
  occurredTo?: string;
};

export type FrontDeskLogIdentity = {
  activityType: FrontDeskActivityType;
  sourceId: string;
};
