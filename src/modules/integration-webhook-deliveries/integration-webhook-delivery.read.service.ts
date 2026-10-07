import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { integrationWebhookDeliveryRepository as repository } from './integration-webhook-delivery.repository';
import type {
  IntegrationWebhookDeliveryListFilters,
  IntegrationWebhookDeliveryRecord,
  PublicIntegrationWebhookDelivery,
} from './integration-webhook-delivery.types';

/**
 * CR-BE-INTEG-01 PART 06 — delivery history read service.
 *
 * READ-ONLY over the PART 03 ledger — no lifecycle transition, no manual
 * retry, no payload access. Scope follows the endpoint-registry precedent:
 * BE-02G `canAccessClient` / accessible-Client intersection on every seam
 * (permission alone never crosses Clients). The projection exposes state /
 * attempt / timing / response metadata only; signing secrets and payload
 * bodies are structurally absent.
 */

export function toPublicIntegrationWebhookDelivery(
  record: IntegrationWebhookDeliveryRecord,
): PublicIntegrationWebhookDelivery {
  const iso = (value: Date | null): string | null =>
    value ? new Date(value).toISOString() : null;
  return {
    id: record.id,
    outboxEventId: record.outboxEventId,
    endpointId: record.endpointId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: record.eventType,
    status: record.status,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    nextRetryAt: iso(record.nextRetryAt),
    lastAttemptAt: iso(record.lastAttemptAt),
    lastResponseStatus: record.lastResponseStatus,
    lastError: record.lastError,
    deliveredAt: iso(record.deliveredAt),
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

export async function listIntegrationWebhookDeliveries(
  filters: IntegrationWebhookDeliveryListFilters,
  userId: string,
  page?: { limit: number; offset: number },
): Promise<{ rows: PublicIntegrationWebhookDelivery[]; total: number }> {
  const accessibleClientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (filters.clientId && !accessibleClientIds.includes(filters.clientId)) {
    throw buildingAccessDeniedError();
  }
  const [rows, total] = await Promise.all([
    repository.listForClients(accessibleClientIds, filters, page),
    repository.countForClients(accessibleClientIds, filters),
  ]);
  return { rows: rows.map(toPublicIntegrationWebhookDelivery), total };
}

export async function getIntegrationWebhookDeliveryById(
  id: string,
  userId: string,
): Promise<PublicIntegrationWebhookDelivery> {
  const record = await repository.findById(id);
  if (!record) {
    throw AppError.notFound('Integration webhook delivery not found.');
  }
  if (!(await contextAccessService.canAccessClient(userId, record.clientId))) {
    throw buildingAccessDeniedError();
  }
  return toPublicIntegrationWebhookDelivery(record);
}
