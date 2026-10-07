/**
 * BE-01H — Authentication audit domain types.
 *
 * A persistent security event history, separate from BE-00 application
 * logging. Metadata must only ever contain non-secret values (reason codes,
 * entity ids); never credentials or token material.
 */
export const AUDIT_EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'INVITATION_CREATED',
  'INVITATION_ACCEPTED',
  'INVITATION_REVOKED',
  'ACCOUNT_DEACTIVATED',
  'ACCOUNT_REACTIVATED',
  'ACCOUNT_SUSPENDED',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export function isAuditEventType(value: unknown): value is AuditEventType {
  return (
    typeof value === 'string' &&
    (AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return (
    typeof value === 'string' &&
    (AUDIT_OUTCOMES as readonly string[]).includes(value)
  );
}

export type AuditMetadata = Record<string, unknown>;

export type RecordAuditEventInput = {
  eventType: AuditEventType;
  outcome: AuditOutcome;
  userId?: string | null;
  actorUserId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: AuditMetadata;
};

/** Request-derived correlation context, safe to attach to audit events. */
export type AuditRequestContext = {
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  actorUserId?: string;
};

export type AuditEventRecord = {
  id: string;
  eventType: AuditEventType;
  outcome: AuditOutcome;
  userId: string | null;
  actorUserId: string | null;
  sessionId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: AuditMetadata;
  createdAt: Date;
};

/** Safe public representation exposed through the audit read API. */
export type PublicAuditEvent = {
  id: string;
  eventType: AuditEventType;
  outcome: AuditOutcome;
  userId: string | null;
  actorUserId: string | null;
  sessionId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: AuditMetadata;
  createdAt: string;
};
