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
    metadata: record.metadata,
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
