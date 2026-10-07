import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { generateIntegrationWebhookSigningSecret } from './integration-webhook-endpoint.secret';
import { integrationWebhookEndpointRepository as repository } from './integration-webhook-endpoint.repository';
import type {
  CreateIntegrationWebhookEndpointInput,
  CreatedIntegrationWebhookEndpoint,
  IntegrationWebhookEndpointFilters,
  IntegrationWebhookEndpointRecord,
  PublicIntegrationWebhookEndpoint,
  UpdateIntegrationWebhookEndpointInput,
} from './integration-webhook-endpoint.types';

/**
 * CR-BE-INTEG-01 PART 02 — webhook endpoint service.
 *
 * Client-scoped endpoint configuration with the BE-02G context resolver as
 * the sole data-scope authority (permission alone never grants cross-Client
 * access). Secrets are server-generated and disclosed exactly once (create /
 * rotate); every other seam returns the secret-free projection.
 *
 * Config lifecycle audit uses `INTEGRATION_ENDPOINT_*` operational events —
 * a family on the PART 01 recursion blocklist, so endpoint administration
 * can never enqueue integration fan-out of itself. Audit metadata never
 * contains secret material.
 */

function toPublic(
  record: IntegrationWebhookEndpointRecord,
): PublicIntegrationWebhookEndpoint {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    name: record.name,
    url: record.url,
    eventTypes: record.eventTypes,
    status: record.status,
    secretRotatedAt: record.secretRotatedAt
      ? new Date(record.secretRotatedAt).toISOString()
      : null,
    timeoutMs: record.timeoutMs,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

function endpointNotFoundError(): AppError {
  return AppError.notFound('Integration webhook endpoint not found.');
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

/** Building (when given) must belong to the endpoint's Client. */
async function assertBuildingBelongsToClient(
  clientId: string,
  buildingId: string,
): Promise<void> {
  const result = await getPool().query<{ clientId: string }>(
    `SELECT p.client_id AS "clientId"
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [buildingId],
  );
  if (result.rows[0]?.clientId !== clientId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building does not belong to the given Client.' },
    ]);
  }
}

async function recordEndpointAudit(
  eventType: string,
  record: IntegrationWebhookEndpointRecord,
  actorUserId: string,
  summary: string,
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    eventType,
    entityType: 'INTEGRATION_WEBHOOK_ENDPOINT',
    entityId: record.id,
    actorUserId,
    buildingId: record.buildingId,
    summary,
    metadata: {
      name: record.name,
      url: record.url,
      eventTypes: record.eventTypes,
      status: record.status,
      timeoutMs: record.timeoutMs,
      ...extraMetadata,
    },
  });
}

async function createIntegrationWebhookEndpoint(
  input: CreateIntegrationWebhookEndpointInput,
  userId: string,
): Promise<CreatedIntegrationWebhookEndpoint> {
  await assertClientAccess(userId, input.clientId);
  if (input.buildingId) {
    await assertBuildingBelongsToClient(input.clientId, input.buildingId);
  }

  const signingSecret = generateIntegrationWebhookSigningSecret();
  const record = await repository.create({ ...input, signingSecret });

  await recordEndpointAudit(
    'INTEGRATION_ENDPOINT_CREATED',
    record,
    userId,
    `Integration webhook endpoint "${record.name}" created.`,
  );

  // ONE-TIME disclosure: the raw secret is composed into this response only.
  return { ...toPublic(record), signingSecret };
}

async function listIntegrationWebhookEndpoints(
  filters: IntegrationWebhookEndpointFilters,
  userId: string,
): Promise<PublicIntegrationWebhookEndpoint[]> {
  const accessibleClientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (filters.clientId && !accessibleClientIds.includes(filters.clientId)) {
    throw buildingAccessDeniedError();
  }
  const rows = await repository.listForClients(accessibleClientIds, filters);
  return rows.map(toPublic);
}

async function getIntegrationWebhookEndpointById(
  id: string,
  userId: string,
): Promise<PublicIntegrationWebhookEndpoint> {
  const record = await repository.findById(id);
  if (!record) {
    throw endpointNotFoundError();
  }
  await assertClientAccess(userId, record.clientId);
  return toPublic(record);
}

async function updateIntegrationWebhookEndpoint(
  id: string,
  input: UpdateIntegrationWebhookEndpointInput,
  userId: string,
): Promise<PublicIntegrationWebhookEndpoint> {
  const existing = await repository.findById(id);
  if (!existing) {
    throw endpointNotFoundError();
  }
  await assertClientAccess(userId, existing.clientId);

  const updated = await repository.update(id, input);
  if (!updated) {
    throw endpointNotFoundError();
  }

  const statusChanged = input.status !== undefined && input.status !== existing.status;
  await recordEndpointAudit(
    statusChanged ? 'INTEGRATION_ENDPOINT_STATUS_CHANGED' : 'INTEGRATION_ENDPOINT_UPDATED',
    updated,
    userId,
    statusChanged
      ? `Integration webhook endpoint "${updated.name}" status changed to ${updated.status}.`
      : `Integration webhook endpoint "${updated.name}" updated.`,
    statusChanged ? { previousStatus: existing.status } : {},
  );

  return toPublic(updated);
}

async function rotateIntegrationWebhookEndpointSecret(
  id: string,
  userId: string,
): Promise<CreatedIntegrationWebhookEndpoint> {
  const existing = await repository.findById(id);
  if (!existing) {
    throw endpointNotFoundError();
  }
  await assertClientAccess(userId, existing.clientId);

  const signingSecret = generateIntegrationWebhookSigningSecret();
  const rotated = await repository.rotateSecret(id, signingSecret);
  if (!rotated) {
    throw endpointNotFoundError();
  }

  await recordEndpointAudit(
    'INTEGRATION_ENDPOINT_SECRET_ROTATED',
    rotated,
    userId,
    `Integration webhook endpoint "${rotated.name}" signing secret rotated.`,
  );

  // ONE-TIME disclosure of the NEW secret; the old one is gone for good.
  return { ...toPublic(rotated), signingSecret };
}

export const integrationWebhookEndpointService = {
  createIntegrationWebhookEndpoint,
  listIntegrationWebhookEndpoints,
  getIntegrationWebhookEndpointById,
  updateIntegrationWebhookEndpoint,
  rotateIntegrationWebhookEndpointSecret,
};
