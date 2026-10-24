/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — Handyman ASSIGNMENT notification
 * event contract.
 *
 * POSITION
 * --------
 * The CR-HM-16 PART 02 contract (`handyman-notification-contract.ts`) froze
 * the MEANING of the Handyman LIFECYCLE vocabulary (request triaged,
 * quotation issued, permit readiness, crew lead designated, …). Those events
 * are declarative subjects: a BE-26D subscription can name their audience.
 *
 * The ASSIGNMENT events are a different kind of subject: their audience is
 * the fact itself. "Who must be told that this Work Order was assigned?" is
 * answered by the assignment (the assignee, the superseded assignee, the
 * Operations actor), not by a static recipient rule. This file therefore
 * freezes those events as a SEPARATE, additive vocabulary with its own
 * audience authority (`ASSIGNMENT_RECIPIENT`), leaving the CR-HM-16 contract
 * byte-for-byte untouched.
 *
 * WHAT THIS OWNS
 * --------------
 * The event identity, the assignment scope, the navigation target and the
 * canonical template key of every assignment notification event.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No delivery, no channel, no provider, no transport, no persistence. The
 * contract is CHANNEL-FREE and PROVIDER-FREE by law: no WhatsApp, email,
 * browser push, native push or any named provider appears here (or in any
 * emitted intent). Delivery status, retry/backoff and provider adapters stay
 * the reused BE-26 / CR-BE-NOTIFY-PROV-01 capability. A notification REACTS
 * to an occurred event and must never write Handyman lifecycle state.
 *
 * NO INVENTED EVENTS
 * ------------------
 * Every event type below is ALREADY emitted by the assignment authorities
 * (`src/modules/assignment-responses/assignment-response.notifications.ts`
 * writes them as the `source_event_type` of the assignment notification, and
 * `handyman_assignment_response_events` records the matching decision
 * history). This contract names them; it does not create any.
 */

/**
 * The assignment target types an assignment event may address. These are the
 * three assignment authorities that already exist in the domain:
 *   - `WORK_ORDER_ASSIGNMENT`      — Standard Work Order assignment,
 *   - `EXECUTION_SCOPE_ASSIGNMENT`  — Handyman Execution Scope crew lead,
 *   - `INSPECTOR_VISIT_ASSIGNMENT`  — Handyman Inspector visit assignment.
 */
export const HANDYMAN_ASSIGNMENT_NOTIFICATION_TARGET_TYPES = [
  'WORK_ORDER_ASSIGNMENT',
  'EXECUTION_SCOPE_ASSIGNMENT',
  'INSPECTOR_VISIT_ASSIGNMENT',
] as const;

export type HandymanAssignmentNotificationTargetType =
  (typeof HANDYMAN_ASSIGNMENT_NOTIFICATION_TARGET_TYPES)[number];

export function isHandymanAssignmentNotificationTargetType(
  value: unknown,
): value is HandymanAssignmentNotificationTargetType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_ASSIGNMENT_NOTIFICATION_TARGET_TYPES as readonly string[]).includes(
      value,
    )
  );
}

/**
 * The audience authority of an assignment event.
 *
 *   - `ASSIGNEE`  — the party the assignment designates (the assigned worker,
 *                   the crew lead, the inspector). Derived from the
 *                   assignment fact, never from a static rule.
 *   - `OPERATIONS` — the Operations actors of the assignment (the actor who
 *                   made it and the Work Order's creator). Derived from the
 *                   assignment fact, never from a static rule.
 */
export const HANDYMAN_ASSIGNMENT_NOTIFICATION_AUDIENCES = [
  'ASSIGNEE',
  'OPERATIONS',
] as const;

export type HandymanAssignmentNotificationAudience =
  (typeof HANDYMAN_ASSIGNMENT_NOTIFICATION_AUDIENCES)[number];

/**
 * The navigation target of an assignment event. The vocabulary is the
 * existing backend-owned one (migration 0358 / 0472) — a destination is
 * never a frontend route string.
 */
export type HandymanAssignmentNavigationTargetType =
  | 'WORK_ORDER_FIELD_WORK'
  | 'EXECUTION_SCOPE_FIELD_WORK'
  | 'INSPECTOR_VISIT_FIELD_WORK';

/** One frozen assignment notification event. */
export type HandymanAssignmentNotificationContractEntry = {
  /** The event identity (already emitted by the assignment authority). */
  eventType: string;
  /** The assignment scope this event belongs to. */
  assignmentTargetType: HandymanAssignmentNotificationTargetType;
  /** The notification MEANING of the event. */
  meaning: string;
  /** The recipient authority of the event. */
  audience: HandymanAssignmentNotificationAudience;
  /** The canonical BE-26B template key of the event. */
  templateKey: string;
  /** The canonical navigation target type, or null when the event has none. */
  navigationTargetType: HandymanAssignmentNavigationTargetType | null;
};

/**
 * The frozen assignment notification vocabulary.
 *
 * The four lifecycle moments of every assignment authority — pending,
 * accepted, declined, superseded — mapped onto the three assignment
 * scopes. No event here is new: each one is already the `source_event_type`
 * of the corresponding assignment notification.
 */
export const HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT = [
  // ---- Standard Work Order assignment -------------------------------
  {
    eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
    assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
    meaning:
      'A Work Order was assigned to a worker, crew or vendor and the assignee still owes an explicit answer.',
    audience: 'ASSIGNEE',
    templateKey: 'HANDYMAN_WORK_ORDER_ASSIGNMENT_PENDING',
    navigationTargetType: 'WORK_ORDER_FIELD_WORK',
  },
  {
    eventType: 'WORK_ORDER_ASSIGNMENT_ACCEPTED',
    assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
    meaning:
      'The assignee of a Work Order explicitly accepted the assignment.',
    audience: 'OPERATIONS',
    templateKey: 'HANDYMAN_WORK_ORDER_ASSIGNMENT_ACCEPTED',
    navigationTargetType: 'WORK_ORDER_FIELD_WORK',
  },
  {
    eventType: 'WORK_ORDER_ASSIGNMENT_DECLINED',
    assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
    meaning:
      'The assignee of a Work Order explicitly declined the assignment, so the Work Order needs a new assignee.',
    audience: 'OPERATIONS',
    templateKey: 'HANDYMAN_WORK_ORDER_ASSIGNMENT_DECLINED',
    navigationTargetType: 'WORK_ORDER_FIELD_WORK',
  },
  {
    eventType: 'WORK_ORDER_ASSIGNMENT_SUPERSEDED',
    assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
    meaning:
      'The assignment a party held on a Work Order was replaced by another assignment.',
    audience: 'ASSIGNEE',
    templateKey: 'HANDYMAN_WORK_ORDER_ASSIGNMENT_SUPERSEDED',
    navigationTargetType: null,
  },
  // ---- Handyman Execution Scope crew assignment ----------------------
  {
    eventType: 'EXECUTION_SCOPE_ASSIGNMENT_PENDING',
    assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
    meaning:
      'A Handyman Execution Scope crew lead was designated and still owes an explicit answer.',
    audience: 'ASSIGNEE',
    templateKey: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_PENDING',
    navigationTargetType: 'EXECUTION_SCOPE_FIELD_WORK',
  },
  {
    eventType: 'EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED',
    assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
    meaning:
      'The designated crew lead of a Handyman Execution Scope accepted the assignment.',
    audience: 'OPERATIONS',
    templateKey: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED',
    navigationTargetType: 'EXECUTION_SCOPE_FIELD_WORK',
  },
  {
    eventType: 'EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
    assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
    meaning:
      'The designated crew lead of a Handyman Execution Scope declined the assignment.',
    audience: 'OPERATIONS',
    templateKey: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
    navigationTargetType: 'EXECUTION_SCOPE_FIELD_WORK',
  },
  {
    eventType: 'EXECUTION_SCOPE_ASSIGNMENT_SUPERSEDED',
    assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
    meaning:
      'The crew lead designation of a Handyman Execution Scope was replaced by another designation.',
    audience: 'ASSIGNEE',
    templateKey: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_SUPERSEDED',
    navigationTargetType: null,
  },
  // ---- Handyman Inspector visit assignment ---------------------------
  {
    eventType: 'INSPECTOR_VISIT_ASSIGNMENT_PENDING',
    assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
    meaning:
      'An Inspector was assigned to a Handyman inspection visit and still owes an explicit answer.',
    audience: 'ASSIGNEE',
    templateKey: 'HANDYMAN_INSPECTOR_VISIT_ASSIGNMENT_PENDING',
    navigationTargetType: 'INSPECTOR_VISIT_FIELD_WORK',
  },
  {
    eventType: 'INSPECTOR_VISIT_ASSIGNMENT_ACCEPTED',
    assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
    meaning:
      'The assigned Inspector of a Handyman inspection visit accepted the assignment.',
    audience: 'OPERATIONS',
    templateKey: 'HANDYMAN_INSPECTOR_VISIT_ASSIGNMENT_ACCEPTED',
    navigationTargetType: 'INSPECTOR_VISIT_FIELD_WORK',
  },
  {
    eventType: 'INSPECTOR_VISIT_ASSIGNMENT_DECLINED',
    assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
    meaning:
      'The assigned Inspector of a Handyman inspection visit declined the assignment.',
    audience: 'OPERATIONS',
    templateKey: 'HANDYMAN_INSPECTOR_VISIT_ASSIGNMENT_DECLINED',
    navigationTargetType: 'INSPECTOR_VISIT_FIELD_WORK',
  },
  {
    eventType: 'INSPECTOR_VISIT_ASSIGNMENT_SUPERSEDED',
    assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
    meaning:
      'The Inspector assignment of a Handyman inspection visit was replaced or revoked.',
    audience: 'ASSIGNEE',
    templateKey: 'HANDYMAN_INSPECTOR_VISIT_ASSIGNMENT_SUPERSEDED',
    navigationTargetType: null,
  },
] as const satisfies readonly HandymanAssignmentNotificationContractEntry[];

/** The admitted Handyman assignment notification event types. */
export type HandymanAssignmentNotificationEventType =
  (typeof HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT)[number]['eventType'];

/** True when the value is an admitted Handyman assignment event type. */
export function isHandymanAssignmentNotificationEventType(
  value: unknown,
): value is HandymanAssignmentNotificationEventType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT as readonly {
      eventType: string;
    }[]).some((entry) => entry.eventType === value)
  );
}

/**
 * The frozen contract entry of one admitted assignment event type, or
 * undefined when the event type is not admitted (fail-closed admission).
 */
export function handymanAssignmentNotificationContractFor(
  eventType: string,
): HandymanAssignmentNotificationContractEntry | undefined {
  return (
    HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT as readonly HandymanAssignmentNotificationContractEntry[]
  ).find((entry) => entry.eventType === eventType);
}
