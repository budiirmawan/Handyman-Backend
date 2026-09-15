import { AppError } from '../../shared/errors';
import { recordOperationalEvent } from '../operational-events';
import { findingNotFoundError } from '../findings/finding.errors';
import { findingRepository } from '../findings/finding.repository';
import { findingHistoryRepository } from './finding-history.repository';
import type {
  FindingHistoryFilters,
  PublicFindingHistoryEvent,
} from './finding-history.types';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'password',
  'rawevidence',
  'secret',
  'sessiontoken',
  'token',
]);

function safeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (typeof value !== 'object' || value === null) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
    if (!SENSITIVE_KEYS.has(normalized)) safe[key] = safeMetadata(item);
  }
  return safe;
}

export async function recordFindingEvent(input: {
  findingId: string;
  clientId: string;
  buildingId: string;
  eventType: string;
  actorUserId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<PublicFindingHistoryEvent> {
  const finding = await findingRepository.findById(input.findingId);
  if (!finding) throw findingNotFoundError();
  if (
    finding.clientId !== input.clientId ||
    finding.buildingId !== input.buildingId
  ) {
    throw AppError.badRequest('Finding event context mismatch.');
  }
  const row = await recordOperationalEvent({
    clientId: input.clientId,
    entityType: 'FINDING',
    entityId: input.findingId,
    eventType: input.eventType,
    actorUserId: input.actorUserId ?? null,
    buildingId: input.buildingId,
    summary: input.summary,
    metadata: safeMetadata(input.metadata ?? {}) as Record<string, unknown>,
  });
  return {
    id: row.id,
    findingId: row.entity_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    summary: row.summary,
    metadata: row.metadata ?? {},
    occurredAt: new Date(row.occurred_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function getFindingHistory(
  findingId: string,
  filters: FindingHistoryFilters,
): Promise<PublicFindingHistoryEvent[]> {
  if (!(await findingRepository.findById(findingId))) throw findingNotFoundError();
  if (
    filters.from !== undefined && filters.to !== undefined &&
    new Date(filters.from) > new Date(filters.to)
  ) {
    throw AppError.validation('Request validation failed.', [
      { field: 'from', message: 'from must be before or equal to to.' },
    ]);
  }
  return findingHistoryRepository.listByFinding(findingId, filters);
}

export const findingHistoryService = {
  getFindingHistory,
  recordFindingEvent,
};
