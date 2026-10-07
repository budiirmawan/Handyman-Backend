import { createHash } from 'node:crypto';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { permissionDeniedError } from '../auth';
import { permissionService } from '../permissions';
import { getReportingExportDatasetAdapter } from '../reporting-export/reporting-export.registry';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { resolveManagementReadScope } from '../management-read-scope';
import { recordOperationalEvent } from '../operational-events';
import { reportArchiveIdempotencyConflictError, reportArchiveNotFoundError } from './reporting-archive.errors';
import { reportArchiveRepository } from './reporting-archive.repository';
import {
  MAX_FILTER_SNAPSHOT_BYTES,
  normalizeReportFilterSnapshot,
} from './reporting-archive.validation';
import type {
  PublicReportArchive,
  ReportArchiveAccessibleScope,
  ReportArchiveJsonObject,
  ReportArchiveListFilters,
  ReportArchiveRecord,
  ReportArchiveRequestInput,
} from './reporting-archive.types';

/** CR-BE-EXP-01 PART 01 — request/archive authority; no rendering or download. */

type ScopeDateField = 'dateFrom' | 'dateTo';

async function assertDatasetReadPermission(
  dataset: ReportArchiveRecord['dataset'],
  userId: string,
): Promise<void> {
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  const required = getReportingExportDatasetAdapter(dataset).requiredReadPermission;
  if (!permissions.includes(required)) {
    throw permissionDeniedError();
  }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function fileSize(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPublic(record: ReportArchiveRecord): PublicReportArchive {
  const available =
    record.status === 'COMPLETED' &&
    record.retentionState !== 'PURGED' &&
    record.storageReference !== null;

  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    buildingIds: record.buildingIds,
    dataset: record.dataset,
    format: record.format,
    status: record.status,
    filterSnapshot: record.filterSnapshot,
    sourceProvenance: record.sourceProvenance,
    asOf: iso(record.asOf),
    requestedByUserId: record.requestedByUserId,
    requestedAt: record.requestedAt.toISOString(),
    generatedAt: iso(record.generatedAt),
    artifact: {
      available,
      filename: record.filename,
      contentType: record.contentType,
      fileSize: fileSize(record.fileSize),
      checksum: record.checksum,
      checksumAlgorithm: record.checksumAlgorithm,
    },
    failure:
      record.failureCode && record.failureMessage && record.failedAt
        ? {
            code: record.failureCode,
            message: record.failureMessage,
            failedAt: record.failedAt.toISOString(),
          }
        : null,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    nextAttemptAt: iso(record.nextAttemptAt),
    supersedesArchiveId: record.supersedesArchiveId,
    retention: {
      policyId: record.retentionPolicyId,
      policyCode: record.retentionPolicyCode,
      daysSnapshot: record.retentionDaysSnapshot,
      appliedAt: iso(record.retentionAppliedAt),
      retainedUntil: iso(record.retainedUntil),
      state: record.retentionState,
      hold: record.retentionHold,
      holdReason: record.retentionHoldReason,
      purgedAt: iso(record.purgedAt),
    },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readScopeDate(
  filters: ReportArchiveJsonObject,
  field: ScopeDateField,
): string | undefined {
  const value = filters[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw AppError.validation('Request validation failed.', [
      { field: `filters.${field}`, message: `${field} must be a non-empty ISO-8601 value.` },
    ]);
  }
  return value.trim();
}

async function resolveRequestScope(
  input: ReportArchiveRequestInput,
  userId: string,
): Promise<{
  scope: ReportArchiveAccessibleScope;
  context: Awaited<ReturnType<typeof resolveManagementReadScope>>['context'];
}> {
  const dateFrom = readScopeDate(input.filters, 'dateFrom');
  const dateTo = readScopeDate(input.filters, 'dateTo');
  const resolved = await resolveManagementReadScope(
    {
      clientId: input.clientId,
      ...(input.buildingId ? { buildingId: input.buildingId } : {}),
      ...(input.buildingIds ? { buildingIds: input.buildingIds } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    },
    userId,
  );

  if (
    resolved.context.scope.clientIds.length !== 1 ||
    resolved.context.scope.clientIds[0] !== input.clientId
  ) {
    throw buildingAccessDeniedError();
  }

  return {
    scope: {
      clientIds: [input.clientId],
      buildingIds: resolved.context.scope.buildingIds,
    },
    context: resolved.context,
  };
}

function buildFilterSnapshot(
  input: ReportArchiveRequestInput,
  context: Awaited<ReturnType<typeof resolveManagementReadScope>>['context'],
): ReportArchiveJsonObject {
  return {
    dataset: input.dataset,
    format: input.format,
    requestedScope: {
      clientId: input.clientId,
      buildingId: input.buildingId ?? null,
      buildingIds: input.buildingIds ?? [],
    },
    resolvedScope: {
      clientIds: context.scope.clientIds,
      buildingIds: context.scope.buildingIds,
      mode: context.scope.mode,
    },
    period: context.period,
    filters: input.filters,
  };
}

export async function createReportArchive(
  input: ReportArchiveRequestInput,
  userId: string,
  idempotencyKey?: string,
): Promise<PublicReportArchive> {
  await assertDatasetReadPermission(input.dataset, userId);
  const filters = normalizeReportFilterSnapshot(input.filters);
  const normalizedInput = { ...input, filters };
  const { scope, context } = await resolveRequestScope(normalizedInput, userId);
  const filterSnapshot = buildFilterSnapshot(normalizedInput, context);
  if (Buffer.byteLength(stableJson(filterSnapshot), 'utf8') >
    MAX_FILTER_SNAPSHOT_BYTES) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'filters',
        message: 'The resolved filter snapshot is too large to persist.',
      },
    ]);
  }
  const requestFingerprint = sha256(
    stableJson({
      dataset: normalizedInput.dataset,
      format: normalizedInput.format,
      filterSnapshot,
    }),
  );
  const idempotencyKeyHash = idempotencyKey ? sha256(idempotencyKey) : null;
  const sourceProvenance: ReportArchiveJsonObject = {
    authority: 'REPORTING_EXPORT_REGISTRY',
    dataset: normalizedInput.dataset,
    state: 'REQUESTED',
    asOf: null,
  };

  const result = await withTransaction(async (tx) => {
    const created = await reportArchiveRepository.createOnConflictReturn(
      {
        clientId: normalizedInput.clientId,
        buildingId:
          scope.buildingIds.length === 1 ? scope.buildingIds[0]! : null,
        buildingIds: scope.buildingIds,
        dataset: normalizedInput.dataset,
        format: normalizedInput.format,
        filters: filterSnapshot,
        sourceProvenance,
        requestedByUserId: userId,
        idempotencyKeyHash,
        requestFingerprint,
      },
      tx,
    );

    if (created.created) {
      await recordOperationalEvent(
        {
          clientId: created.record.clientId,
          buildingId: created.record.buildingId,
          eventType: 'REPORT_EXPORT_REQUESTED',
          entityType: 'REPORT_ARCHIVE',
          entityId: created.record.id,
          actorUserId: userId,
          summary: 'Report export requested',
          metadata: {
            archiveId: created.record.id,
            dataset: created.record.dataset,
            format: created.record.format,
            requestFingerprint,
            buildingScopeCount: created.record.buildingIds.length,
          },
        },
        tx,
      );
    }

    return created;
  });

  if (!result.created) {
    if (result.record.requestFingerprint !== requestFingerprint) {
      throw reportArchiveIdempotencyConflictError();
    }
    return toPublic(result.record);
  }

  return toPublic(result.record);
}

async function accessibleScope(userId: string): Promise<ReportArchiveAccessibleScope> {
  const [buildingIds, clientIds] = await Promise.all([
    contextAccessService.getAccessibleBuildingIds(userId),
    contextAccessService.getAccessibleClientIds(userId),
  ]);
  return { buildingIds, clientIds };
}

export async function getReportArchive(
  id: string,
  userId: string,
): Promise<PublicReportArchive> {
  const record = await reportArchiveRepository.findAccessibleById(
    id,
    await accessibleScope(userId),
  );
  if (!record) throw reportArchiveNotFoundError();
  return toPublic(record);
}

export async function listReportArchives(
  filters: ReportArchiveListFilters,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ items: PublicReportArchive[]; total: number }> {
  const result = await reportArchiveRepository.list(
    filters,
    await accessibleScope(userId),
    limit,
    offset,
  );
  return {
    items: result.items.map(toPublic),
    total: result.total,
  };
}

export const reportArchiveService = {
  createReportArchive,
  getReportArchive,
  listReportArchives,
  toPublic,
};
