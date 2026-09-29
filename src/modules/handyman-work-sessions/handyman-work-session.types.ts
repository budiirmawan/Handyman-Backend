/**
 * CR-HM-08 PART 01 — work-session persistence types ONLY (FROZEN
 * governance `CR-HM-08_START_GOVERNANCE.md` §5/§6/§7/§11). Statuses
 * and event types are the exact frozen contracts. NO billing/rate/
 * duration/billable fields anywhere; NO material/QC/BAST/payment/
 * warranty semantics; NO FM work_order references.
 */

export const HANDYMAN_WORK_SESSION_STATUSES = [
  'CHECKED_IN',
  'IN_PROGRESS',
  'PAUSED',
  'MATERIAL_RUN',
  'COMPLETED',
  'CHECKED_OUT',
] as const;

export type HandymanWorkSessionStatus =
  (typeof HANDYMAN_WORK_SESSION_STATUSES)[number];

export function isHandymanWorkSessionStatus(
  value: string,
): value is HandymanWorkSessionStatus {
  return (HANDYMAN_WORK_SESSION_STATUSES as readonly string[])
    .includes(value);
}

export const HANDYMAN_WORK_SESSION_EVENT_TYPES = [
  'CHECK_IN',
  'START_WORK',
  'PAUSE',
  'MATERIAL_RUN',
  'RESUME',
  'COMPLETE',
  'CHECK_OUT',
] as const;

export type HandymanWorkSessionEventType =
  (typeof HANDYMAN_WORK_SESSION_EVENT_TYPES)[number];

export function isHandymanWorkSessionEventType(
  value: string,
): value is HandymanWorkSessionEventType {
  return (HANDYMAN_WORK_SESSION_EVENT_TYPES as readonly string[])
    .includes(value);
}

/**
 * Session projection row. checkedInAt is always server-set;
 * startedWorkAt/completedAt/checkedOutAt are null until the
 * corresponding transition projects them (PART 02+).
 */
export type HandymanWorkSessionRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  leadWorkerId: string;
  leadUserId: string;
  status: HandymanWorkSessionStatus;
  checkedInAt: Date;
  startedWorkAt: Date | null;
  completedAt: Date | null;
  checkedOutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Identity/binding input for session creation (server-derived). */
export type NewHandymanWorkSession = {
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  leadWorkerId: string;
  leadUserId: string;
};

/** Append-only transition event row (immutable by trigger). */
export type HandymanWorkSessionEventRecord = {
  id: string;
  clientId: string;
  sessionId: string;
  executionScopeId: string;
  eventType: HandymanWorkSessionEventType;
  idempotencyKey: string;
  occurredAt: Date;
  actorUserId: string;
  createdAt: Date;
};

/**
 * Event insertion input. occurredAt is NOT caller-supplied — server
 * clock authoritative (governance §11); client timestamps, when ever
 * captured, are informational snapshot only (never persisted here).
 */
export type NewHandymanWorkSessionEvent = {
  clientId: string;
  sessionId: string;
  executionScopeId: string;
  eventType: HandymanWorkSessionEventType;
  idempotencyKey: string;
  actorUserId: string;
};

/**
 * Append-only helper-presence snapshot row. Server-derived from the
 * CURRENT crew membership of the session's assignment (PART 02);
 * helpers may have NO login (helperUserId nullable). NO billable
 * flag, rate, or duration can ever exist here (governance §6/§7).
 */
export type HandymanWorkSessionHelperPresenceRecord = {
  id: string;
  clientId: string;
  sessionId: string;
  eventId: string;
  executionScopeId: string;
  helperWorkerId: string;
  helperUserId: string | null;
  createdAt: Date;
};

export type NewHandymanWorkSessionHelperPresence = {
  clientId: string;
  sessionId: string;
  eventId: string;
  executionScopeId: string;
  helperWorkerId: string;
  helperUserId: string | null;
};
