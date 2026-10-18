import type { Request } from 'express';
import { logger } from '../../shared/logger';
import {
  insertAuditEvent,
  listAuditEvents,
  type AuditListFilters,
  type AuditListResult,
} from './audit.repository';
import type {
  AuditEventRecord,
  AuditRequestContext,
  PublicAuditEvent,
  RecordAuditEventInput,
} from './audit.types';

const SENSITIVE_AUDIT_KEY =
  /(password|passwd|pwd|hash|token|secret|credential|authorization|api[_-]?key)/i;

/** Defense in depth for historical or future metadata accidentally containing credentials. */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const sanitize = (value: unknown, key?: string, depth = 0): unknown => {
    if (key && SENSITIVE_AUDIT_KEY.test(key)) {
      return '[REDACTED]';
    }
    if (depth > 8) {
      return '[TRUNCATED]';
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, undefined, depth + 1));
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
          childKey,
          sanitize(child, childKey, depth + 1),
        ]),
      );
    }
    return value;
  };

  return sanitize(metadata) as Record<string, unknown>;
}

export function toPublicAuditEvent(record: AuditEventRecord): PublicAuditEvent {
  return {
    id: record.id,
    eventType: record.eventType,
    outcome: record.outcome,
    userId: record.userId,
    actorUserId: record.actorUserId,
    sessionId: record.sessionId,
    requestId: record.requestId,
    ipAddress: record.ipAddress,
    userAgent: record.userAgent,
    metadata: sanitizeAuditMetadata(record.metadata),
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Records a security event. Best-effort by design: a temporary audit-write
 * failure must not collapse security flows (e.g. login), so failures are
 * logged and swallowed. State-changing administrative actions record their
 * event immediately after the state change.
 */
export async function recordEvent(input: RecordAuditEventInput): Promise<void> {
  try {
    await insertAuditEvent(input);
  } catch (error) {
    logger.warn('Authentication audit event could not be persisted', {
      operation: 'audit.record_failed',
      eventType: input.eventType,
      errorMessage: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

export async function listEvents(
  filters: AuditListFilters,
): Promise<AuditListResult> {
  return listAuditEvents(filters);
}

/**
 * Extracts safe correlation context from an Express request. Uses `req.ip`
 * (the socket address; forwarded headers are not trusted by default).
 */
export function auditContextFromRequest(req: Request): AuditRequestContext {
  return {
    requestId: req.requestId,
    ipAddress: req.ip ?? undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

export const auditService = {
  listEvents,
  recordEvent,
};
