import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { configurationAuditEventNotFoundError } from './configuration-audit.errors';
import {
  configurationAuditRepository,
  type AuditRow,
} from './configuration-audit.repository';
import type {
  ConfigurationAuditEvent,
  ConfigurationAuditFilters,
  RecordConfigurationAuditInput,
} from './configuration-audit.types';
import type { ConfigurationVersionSourceType } from '../configuration-versions';

function safeSummary(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 500);
}

function metadata(input: RecordConfigurationAuditInput): Record<string, unknown> {
  const value: Record<string, unknown> = {
    sourceType: input.sourceType,
    configurationVersionId: input.configurationVersionId ?? null,
    previousStatus: input.previousStatus ?? null,
    newStatus: input.newStatus ?? null,
  };
  if (input.versionNumber !== undefined) value.versionNumber = input.versionNumber;
  if (input.previousVersionId !== undefined) {
    value.previousVersionId = input.previousVersionId;
  }
  if (input.valid !== undefined) value.valid = input.valid;
  if (input.validationErrorCodes) {
    value.validationErrorCodes = input.validationErrorCodes
      .filter((code) => /^[A-Z][A-Z0-9_-]{0,63}$/.test(code))
      .slice(0, 50);
  }
  if (input.previewContextId) value.previewContextId = input.previewContextId;
  if (input.previewStatus) value.previewStatus = input.previewStatus;
  return value;
}

/** Append-only projection over the existing operational_events authority. */
export async function recordConfigurationAuditEvent(
  input: RecordConfigurationAuditInput,
): Promise<void> {
  await recordOperationalEvent({
    clientId: input.clientId,
    buildingId: input.buildingId,
    eventType: input.action,
    entityType: 'CONFIGURATION',
    entityId: input.configurationId,
    actorUserId: input.actorUserId,
    summary: safeSummary(input.summary),
    metadata: metadata(input),
  });
}

function publicEvent(row: AuditRow): ConfigurationAuditEvent {
  const data = row.metadata ?? {};
  return {
    id: row.id,
    configurationId: row.entity_id,
    configurationVersionId:
      typeof data.configurationVersionId === 'string'
        ? data.configurationVersionId
        : null,
    sourceType: data.sourceType as ConfigurationVersionSourceType,
    action: row.event_type as ConfigurationAuditEvent['action'],
    actorUserId: row.actor_user_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    previousStatus:
      typeof data.previousStatus === 'string' ? data.previousStatus : null,
    newStatus: typeof data.newStatus === 'string' ? data.newStatus : null,
    summary: row.summary,
    metadata: data,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export async function listConfigurationAuditEvents(
  filters: ConfigurationAuditFilters,
  userId: string,
): Promise<ConfigurationAuditEvent[]> {
  const [buildingIds, clientIds] = await Promise.all([
    contextAccessService.getAccessibleBuildingIds(userId),
    contextAccessService.getAccessibleClientIds(userId),
  ]);
  return (
    await configurationAuditRepository.list(filters, buildingIds, clientIds)
  ).map(publicEvent);
}

export async function getConfigurationAuditEvent(
  id: string,
  userId: string,
): Promise<ConfigurationAuditEvent> {
  const event = await configurationAuditRepository.findById(id);
  if (!event) throw configurationAuditEventNotFoundError();
  if (event.building_id) {
    await contextAccessService.assertBuildingAccess(userId, event.building_id);
  } else if (!(await contextAccessService.canAccessClient(userId, event.client_id))) {
    throw buildingAccessDeniedError();
  }
  return publicEvent(event);
}

export const configurationAuditService = {
  getConfigurationAuditEvent,
  listConfigurationAuditEvents,
  recordConfigurationAuditEvent,
};
