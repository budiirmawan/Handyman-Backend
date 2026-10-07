import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AuditEventRecord,
  AuditEventType,
  AuditOutcome,
  AuditMetadata,
  RecordAuditEventInput,
} from './audit.types';

type AuditEventRow = {
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
  total: string;
};

const AUDIT_SELECT = `
  id,
  event_type AS "eventType",
  outcome,
  user_id AS "userId",
  actor_user_id AS "actorUserId",
  session_id AS "sessionId",
  request_id AS "requestId",
  ip_address AS "ipAddress",
  user_agent AS "userAgent",
  metadata,
  created_at AS "createdAt"
`;

function mapAuditRow(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    eventType: row.eventType,
    outcome: row.outcome,
    userId: row.userId,
    actorUserId: row.actorUserId,
    sessionId: row.sessionId,
    requestId: row.requestId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export async function insertAuditEvent(
  input: RecordAuditEventInput,
): Promise<AuditEventRecord> {
  const result = await getPool().query<AuditEventRow>(
    `INSERT INTO authentication_audit_events
       (id, event_type, outcome, user_id, actor_user_id, session_id, request_id, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::jsonb, '{}'::jsonb))
     RETURNING ${AUDIT_SELECT}`,
    [
      randomUUID(),
      input.eventType,
      input.outcome,
      input.userId ?? null,
      input.actorUserId ?? null,
      input.sessionId ?? null,
      input.requestId ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );

  return mapAuditRow(result.rows[0]);
}

export type AuditListFilters = {
  eventType?: AuditEventType;
  userId?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
};

export type AuditListResult = {
  items: AuditEventRecord[];
  total: number;
};

export async function listAuditEvents(
  filters: AuditListFilters,
): Promise<AuditListResult> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.eventType) {
    params.push(filters.eventType);
    where.push(`event_type = $${params.length}`);
  }

  if (filters.userId) {
    params.push(filters.userId);
    where.push(`user_id = $${params.length}`);
  }

  if (filters.outcome) {
    params.push(filters.outcome);
    where.push(`outcome = $${params.length}`);
  }

  if (filters.from) {
    params.push(filters.from);
    where.push(`created_at >= $${params.length}`);
  }

  if (filters.to) {
    params.push(filters.to);
    where.push(`created_at <= $${params.length}`);
  }

  params.push(filters.limit);
  const limitParam = `$${params.length}`;
  params.push(filters.offset);
  const offsetParam = `$${params.length}`;

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const result = await getPool().query<AuditEventRow>(
    `SELECT ${AUDIT_SELECT}, COUNT(*) OVER() AS total
     FROM authentication_audit_events
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  const total = result.rows[0] ? Number(result.rows[0].total) : 0;
  const items = result.rows.map(mapAuditRow);

  return { items, total };
}
