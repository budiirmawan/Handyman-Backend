import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { recordOperationalEvent as recordSharedOperationalEvent } from '../operational-events';
import type {
  NewTenantCommunication,
  TenantCommunicationFilters,
  TenantCommunicationRecord,
  UpdateTenantCommunicationInput,
} from './tenant-communication.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", building_id AS "buildingId",
  sender_user_id AS "senderUserId",
  recipient_tenant_pic_id AS "recipientTenantPicId",
  recipient_user_id AS "recipientUserId",
  communication_type AS "communicationType", subject,
  message_body AS "messageBody", related_type AS "relatedType",
  service_request_id AS "serviceRequestId", complaint_id AS "complaintId",
  utility_request_id AS "utilityRequestId", document_id AS "documentId",
  status, sent_at AS "sentAt", read_at AS "readAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantCommunication): Promise<TenantCommunicationRecord> {
  const result = await getPool().query<TenantCommunicationRecord>(
    `INSERT INTO tenant_communications
       (id, client_id, tenant_company_id, building_id, sender_user_id,
        recipient_tenant_pic_id, recipient_user_id, communication_type,
        subject, message_body, related_type, service_request_id, complaint_id,
        utility_request_id, document_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCompanyId, input.buildingId,
      input.senderUserId, input.recipientTenantPicId, input.recipientUserId,
      input.communicationType, input.subject, input.messageBody,
      input.relatedType, input.serviceRequestId, input.complaintId,
      input.utilityRequestId, input.documentId],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantCommunicationRecord | null> {
  const result = await getPool().query<TenantCommunicationRecord>(
    `SELECT ${SELECT} FROM tenant_communications WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function listByTenant(
  tenantCompanyId: string,
  filters: TenantCommunicationFilters,
  buildingIds: string[],
): Promise<TenantCommunicationRecord[]> {
  const values: unknown[] = [tenantCompanyId, buildingIds];
  const clauses = [
    'tenant_company_id = $1',
    '(building_id IS NULL OR building_id = ANY($2::uuid[]))',
  ];
  const fields: [keyof TenantCommunicationFilters, string][] = [
    ['recipientTenantPicId', 'recipient_tenant_pic_id'],
    ['recipientUserId', 'recipient_user_id'],
    ['communicationType', 'communication_type'],
    ['relatedType', 'related_type'],
    ['buildingId', 'building_id'],
    ['status', 'status'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  if (filters.relatedId) {
    const column = filters.relatedType === 'SERVICE_REQUEST'
      ? 'service_request_id'
      : filters.relatedType === 'COMPLAINT'
        ? 'complaint_id'
        : filters.relatedType === 'UTILITY_REQUEST'
          ? 'utility_request_id'
          : filters.relatedType === 'DOCUMENT'
            ? 'document_id'
            : null;
    if (column) {
      values.push(filters.relatedId);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  const result = await getPool().query<TenantCommunicationRecord>(
    `SELECT ${SELECT} FROM tenant_communications
     WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`, values,
  );
  return result.rows;
}

async function updateDraft(
  id: string,
  input: UpdateTenantCommunicationInput,
): Promise<TenantCommunicationRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdateTenantCommunicationInput, string][] = [
    ['communicationType', 'communication_type'],
    ['subject', 'subject'],
    ['messageBody', 'message_body'],
  ];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<TenantCommunicationRecord>(
    `UPDATE tenant_communications SET ${sets.join(', ')}
     WHERE id = $${values.length} AND status = 'DRAFT' RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function markSent(id: string): Promise<TenantCommunicationRecord | null> {
  const result = await getPool().query<TenantCommunicationRecord>(
    `UPDATE tenant_communications
     SET status = 'SENT', sent_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT' RETURNING ${SELECT}`, [id],
  );
  return result.rows[0] ?? null;
}

async function markRead(id: string): Promise<TenantCommunicationRecord | null> {
  const result = await getPool().query<TenantCommunicationRecord>(
    `UPDATE tenant_communications
     SET status = 'READ', read_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'SENT' RETURNING ${SELECT}`, [id],
  );
  return result.rows[0] ?? null;
}

async function recordOperationalEvent(input: {
  clientId: string;
  buildingId: string | null;
  communicationId: string;
  actorUserId: string;
  eventType: string;
  summary: string;
}): Promise<void> {
  // Keep the repository-level method for existing service callers, but route
  // persistence through the shared authority so correlation, scrubbing, and
  // the integration-outbox hook cannot diverge.
  await recordSharedOperationalEvent({
    clientId: input.clientId,
    eventType: input.eventType,
    entityType: 'TENANT_COMMUNICATION',
    entityId: input.communicationId,
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
    summary: input.summary,
    metadata: {},
  });
}

export const tenantCommunicationRepository = {
  create,
  findById,
  listByTenant,
  markRead,
  markSent,
  recordOperationalEvent,
  updateDraft,
};
