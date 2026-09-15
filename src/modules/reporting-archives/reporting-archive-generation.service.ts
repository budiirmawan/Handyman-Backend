import { AppError, ERROR_CODES } from '../../shared/errors';
import { withTransaction } from '../../database';
import { permissionDeniedError } from '../auth';
import { permissionService } from '../permissions';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { resolveManagementReadScope } from '../management-read-scope';
import { recordOperationalEvent } from '../operational-events';
import {
  createEvidenceStorage,
  isReportArchiveStorageKey,
  reportArchiveStorageKey,
} from '../evidence/storage';
import type {
  EvidenceStorage,
  StoredEvidenceFile,
} from '../evidence/storage';
import {
  getReportingExport,
} from '../reporting-export/reporting-export.service';
import {
  getReportingExportDatasetAdapter,
} from '../reporting-export/reporting-export.registry';
import { renderReportingCsv } from '../reporting-export/csv-renderer';
import { renderReportingXlsx } from '../reporting-export/xlsx-renderer';
import { renderReportingPdf } from '../reporting-export/pdf-renderer';
import {
  reportArchiveRepository,
} from './reporting-archive.repository';
import {
  reportArchiveNotFoundError,
} from './reporting-archive.errors';
import { reportArchiveService } from './reporting-archive.service';
import { safeFilename, checksumBytes } from '../reporting-export/csv-renderer';
import type {
  PublicReportArchive,
  ReportArchiveDownload,
  ReportArchiveJsonObject,
  ReportArchiveRecord,
} from './reporting-archive.types';
import type { PublicReportingExport } from '../reporting-export/reporting-export.types';

/** CR-BE-EXP-01 PART 05 — synchronous generation/download seams. */

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_CHECKSUM_ALGORITHM = 'SHA-256';

export type RenderedReportArtifact = {
  bytes: Buffer;
  contentType: string;
  filename: string;
  fileSize: number;
  checksum: string;
  checksumAlgorithm: string;
};

/**
 * Renders one requested format from one already-created canonical snapshot.
 * This pure dispatcher never queries, authorizes, persists, or accesses
 * storage. JSON uses the existing object-shaped export authority's normal
 * serialization; all other formats call their dedicated renderer exactly once.
 */
export async function renderReportArchiveArtifact(
  record: Pick<ReportArchiveRecord, 'dataset' | 'format'>,
  snapshot: PublicReportingExport,
  tableKey?: string,
): Promise<RenderedReportArtifact> {
  switch (record.format) {
    case 'JSON': {
      const text = JSON.stringify(snapshot) ?? '{}';
      const bytes = Buffer.from(text, 'utf8');
      return {
        bytes,
        contentType: JSON_CONTENT_TYPE,
        filename: safeFilename(undefined, snapshot.metadata.dataset, 'report', 'json'),
        fileSize: bytes.length,
        checksum: checksumBytes(bytes),
        checksumAlgorithm: JSON_CHECKSUM_ALGORITHM,
      };
    }
    case 'CSV': {
      const rendered = renderReportingCsv(snapshot, { tableKey });
      return {
        bytes: rendered.bytes,
        contentType: rendered.contentType,
        filename: safeFilename(rendered.filename, snapshot.metadata.dataset, 'report', 'csv'),
        fileSize: rendered.fileSize,
        checksum: rendered.checksum,
        checksumAlgorithm: rendered.checksumAlgorithm,
      };
    }
    case 'XLSX': {
      const rendered = await renderReportingXlsx(snapshot);
      return {
        bytes: rendered.bytes,
        contentType: rendered.contentType,
        filename: safeFilename(rendered.filename, snapshot.metadata.dataset, 'report', 'xlsx'),
        fileSize: rendered.fileSize,
        checksum: rendered.checksum,
        checksumAlgorithm: rendered.checksumAlgorithm,
      };
    }
    case 'PDF': {
      const rendered = await renderReportingPdf(snapshot);
      return {
        bytes: rendered.bytes,
        contentType: rendered.contentType,
        filename: safeFilename(rendered.filename, snapshot.metadata.dataset, 'report', 'pdf'),
        fileSize: rendered.fileSize,
        checksum: rendered.checksum,
        checksumAlgorithm: rendered.checksumAlgorithm,
      };
    }
    default:
      throw AppError.badRequest('Unsupported report archive format.');
  }
}

function isRecord(value: unknown): value is ReportArchiveJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestScope(record: ReportArchiveRecord): {
  buildingId?: string;
  buildingIds?: string[];
} {
  const snapshot = record.filterSnapshot;
  const requested = isRecord(snapshot.requestedScope)
    ? snapshot.requestedScope
    : {};
  const buildingId =
    typeof requested.buildingId === 'string' ? requested.buildingId : undefined;
  const rawBuildingIds = requested.buildingIds;
  const buildingIds = Array.isArray(rawBuildingIds)
    ? rawBuildingIds.filter((value): value is string => typeof value === 'string')
    : undefined;
  return {
    ...(buildingId ? { buildingId } : {}),
    ...(buildingIds && buildingIds.length > 0 ? { buildingIds } : {}),
  };
}

function archiveFilters(record: ReportArchiveRecord): ReportArchiveJsonObject {
  const filters = record.filterSnapshot.filters;
  if (!isRecord(filters)) {
    throw AppError.internal('Report archive filter snapshot is invalid.');
  }
  return { ...filters };
}

function tableKeyFromFilters(filters: ReportArchiveJsonObject): string | undefined {
  const value = filters.tableKey;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'filters.tableKey', message: 'tableKey must be a safe governed identifier.' },
    ]);
  }
  return value;
}

function generationPassThrough(record: ReportArchiveRecord): {
  passThrough: Record<string, unknown>;
  tableKey?: string;
} {
  const passThrough = archiveFilters(record);
  const tableKey = tableKeyFromFilters(passThrough);
  delete passThrough.tableKey;

  if (record.dataset === 'MANAGEMENT_OPERATIONS_COMMAND_CENTER') {
    passThrough.clientId = record.clientId;
    if (record.buildingIds.length === 1) {
      passThrough.buildingId = record.buildingIds[0];
    } else if (record.buildingIds.length > 1) {
      passThrough.buildingIds = record.buildingIds;
    }
    return { passThrough, ...(tableKey ? { tableKey } : {}) };
  }

  const requested = requestScope(record);
  if (requested.buildingId) {
    passThrough.buildingId = requested.buildingId;
  } else if (requested.buildingIds && requested.buildingIds.length === 1) {
    passThrough.buildingId = requested.buildingIds[0];
  } else if (requested.buildingIds && requested.buildingIds.length > 1) {
    throw AppError.badRequest(
      'This dataset does not support a selected multi-building archive scope.',
    );
  }
  return { passThrough, ...(tableKey ? { tableKey } : {}) };
}

function sameIds(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function assertGenerationAuthorization(
  record: ReportArchiveRecord,
): Promise<void> {
  const permissions = await permissionService.resolvePermissionsForUser(
    record.requestedByUserId,
  );
  const adapter = getReportingExportDatasetAdapter(record.dataset);
  const required = ['report_export.generate', adapter.requiredReadPermission];
  if (required.some((permission) => !permissions.includes(permission))) {
    throw permissionDeniedError();
  }

  const requested = requestScope(record);
  const resolved = await resolveManagementReadScope(
    {
      clientId: record.clientId,
      ...(requested.buildingId ? { buildingId: requested.buildingId } : {}),
      ...(requested.buildingIds ? { buildingIds: requested.buildingIds } : {}),
    },
    record.requestedByUserId,
  );
  if (
    resolved.context.scope.clientIds.length !== 1 ||
    resolved.context.scope.clientIds[0] !== record.clientId ||
    !sameIds(resolved.context.scope.buildingIds, record.buildingIds)
  ) {
    throw buildingAccessDeniedError();
  }

  if (!requested.buildingId && !requested.buildingIds) {
    const allAccessible = await resolveManagementReadScope(
      { clientId: record.clientId },
      record.requestedByUserId,
    );
    if (!sameIds(allAccessible.context.scope.buildingIds, record.buildingIds)) {
      throw buildingAccessDeniedError();
    }
    if (record.dataset !== 'MANAGEMENT_OPERATIONS_COMMAND_CENTER') {
      const allUserBuildings = await contextAccessService.getAccessibleBuildingIds(
        record.requestedByUserId,
      );
      if (!sameIds(allUserBuildings, record.buildingIds)) {
        throw buildingAccessDeniedError();
      }
    }
  }
}

function safeFailure(): { failureCode: string; failureMessage: string } {
  return {
    failureCode: 'REPORT_EXPORT_GENERATION_FAILED',
    failureMessage: 'Report export generation failed.',
  };
}

async function claimReportArchive(
  id: string,
): Promise<ReportArchiveRecord | null> {
  return withTransaction(async (tx) => {
    const claimed = await reportArchiveRepository.claimForGeneration(id, tx);
    if (!claimed) return null;
    await recordOperationalEvent(
      {
        clientId: claimed.clientId,
        buildingId: claimed.buildingId,
        eventType: 'REPORT_EXPORT_GENERATING',
        entityType: 'REPORT_ARCHIVE',
        entityId: claimed.id,
        actorUserId: claimed.requestedByUserId,
        summary: 'Report export generation started',
        metadata: {
          archiveId: claimed.id,
          dataset: claimed.dataset,
          format: claimed.format,
          attempt: claimed.attemptCount,
        },
      },
      tx,
    );
    return claimed;
  });
}

async function failReportArchive(
  record: ReportArchiveRecord,
): Promise<ReportArchiveRecord | null> {
  const failure = safeFailure();
  return withTransaction(async (tx) => {
    const failed = await reportArchiveRepository.failGeneration(
      record.id,
      {
        ...failure,
        failedAt: new Date(),
      },
      tx,
    );
    if (!failed) return null;
    await recordOperationalEvent(
      {
        clientId: failed.clientId,
        buildingId: failed.buildingId,
        eventType: 'REPORT_EXPORT_FAILED',
        entityType: 'REPORT_ARCHIVE',
        entityId: failed.id,
        actorUserId: failed.requestedByUserId,
        summary: 'Report export generation failed',
        metadata: {
          archiveId: failed.id,
          dataset: failed.dataset,
          format: failed.format,
          failureCode: failure.failureCode,
          attempt: failed.attemptCount,
        },
      },
      tx,
    );
    return failed;
  });
}

/**
 * Synchronously processes one REQUESTED archive. This is the service seam a
 * future worker may call; PART 05 intentionally adds no worker or scheduler.
 */
export async function generateReportArchive(
  id: string,
): Promise<PublicReportArchive> {
  const existing = await reportArchiveRepository.findByIdForGeneration(id);
  if (!existing) throw reportArchiveNotFoundError();
  if (existing.status !== 'REQUESTED') return reportArchiveService.toPublic(existing);

  const claimed = await claimReportArchive(id);
  if (!claimed) {
    const current = await reportArchiveRepository.findByIdForGeneration(id);
    if (!current) throw reportArchiveNotFoundError();
    return reportArchiveService.toPublic(current);
  }

  const storageKey = reportArchiveStorageKey(claimed.id);
  let storage: EvidenceStorage | null = null;
  try {
    const storageBackend = createEvidenceStorage();
    storage = storageBackend;
    await assertGenerationAuthorization(claimed);
    const source = generationPassThrough(claimed);
    const snapshot = await getReportingExport(
      { dataset: claimed.dataset, passThrough: source.passThrough },
      claimed.requestedByUserId,
    );
    if (!sameIds(snapshot.metadata.buildingScope, claimed.buildingIds)) {
      throw buildingAccessDeniedError();
    }
    const asOf = snapshot.metadata.asOf;
    if (!asOf || Number.isNaN(new Date(asOf).getTime())) {
      throw AppError.internal('Report export source provenance is invalid.');
    }
    const rendered = await renderReportArchiveArtifact(
      claimed,
      snapshot,
      source.tableKey,
    );
    if (
      rendered.fileSize !== rendered.bytes.length ||
      checksumBytes(rendered.bytes) !== rendered.checksum
    ) {
      throw AppError.internal('Report export artifact integrity could not be verified.');
    }
    if (!isReportArchiveStorageKey(storageKey)) {
      throw AppError.internal('Report export storage key is invalid.');
    }
    await storageBackend.put(storageKey, {
      buffer: rendered.bytes,
      mimeType: rendered.contentType,
    });

    const adapter = getReportingExportDatasetAdapter(claimed.dataset);
    const artifactGeneratedAt = new Date();
    const completed = await withTransaction(async (tx) => {
      const record = await reportArchiveRepository.completeGeneration(
        claimed.id,
        {
          sourceProvenance: {
            ...claimed.sourceProvenance,
            authority: adapter.sourceAuthority,
            state: 'COMPLETED',
            asOf,
            sourceGeneratedAt: snapshot.generatedAt,
            generatedAt: artifactGeneratedAt.toISOString(),
          },
          asOf: new Date(asOf),
          generatedAt: artifactGeneratedAt,
          storageReference: storageKey,
          filename: rendered.filename,
          contentType: rendered.contentType,
          fileSize: rendered.fileSize,
          checksum: rendered.checksum,
          checksumAlgorithm: rendered.checksumAlgorithm,
        },
        tx,
      );
      if (!record) throw AppError.internal('Report export completion claim was lost.');
      await recordOperationalEvent(
        {
          clientId: record.clientId,
          buildingId: record.buildingId,
          eventType: 'REPORT_EXPORT_COMPLETED',
          entityType: 'REPORT_ARCHIVE',
          entityId: record.id,
          actorUserId: record.requestedByUserId,
          summary: 'Report export generated and archived',
          metadata: {
            archiveId: record.id,
            dataset: record.dataset,
            format: record.format,
            asOf: record.asOf?.toISOString() ?? null,
            generatedAt: record.generatedAt?.toISOString() ?? null,
            fileSize: record.fileSize,
            checksum: record.checksum,
          },
        },
        tx,
      );
      return record;
    });
    return reportArchiveService.toPublic(completed);
  } catch (error) {
    if (storage) await storage.remove(storageKey).catch(() => undefined);
    const failed = await failReportArchive(claimed);
    if (failed) return reportArchiveService.toPublic(failed);
    throw error;
  }
}

/**
 * Reads and verifies a completed stored artifact without regenerating it.
 * The returned buffer is streamed by the HTTP controller using the existing
 * evidence-file response convention.
 */
export async function downloadReportArchive(
  id: string,
  userId: string,
): Promise<ReportArchiveDownload> {
  const scope = await archiveAccessibleScope(userId);
  const record = await reportArchiveRepository.findAccessibleById(id, scope);
  if (
    !record ||
    record.status !== 'COMPLETED' ||
    record.retentionState === 'PURGED' ||
    !record.storageReference ||
    !record.filename ||
    !record.contentType ||
    record.fileSize === null ||
    !record.checksum ||
    !isReportArchiveStorageKey(record.storageReference)
  ) {
    throw reportArchiveNotFoundError();
  }

  let stored: StoredEvidenceFile;
  try {
    stored = await createEvidenceStorage().get(record.storageReference);
  } catch {
    throw reportArchiveNotFoundError();
  }
  const expectedSize = Number(record.fileSize);
  if (
    !Number.isSafeInteger(expectedSize) ||
    stored.size !== expectedSize ||
    stored.buffer.length !== expectedSize ||
    checksumBytes(stored.buffer) !== record.checksum
  ) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL_SERVER_ERROR,
      message: 'Stored report archive failed integrity verification.',
      statusCode: 500,
    });
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'REPORT_ARCHIVE_DOWNLOADED',
    entityType: 'REPORT_ARCHIVE',
    entityId: record.id,
    actorUserId: userId,
    summary: 'Report archive downloaded',
    metadata: {
      archiveId: record.id,
      dataset: record.dataset,
      format: record.format,
      fileSize: expectedSize,
      checksum: record.checksum,
    },
  });

  return {
    buffer: stored.buffer,
    contentType: record.contentType,
    filename: record.filename,
    fileSize: expectedSize,
  };
}

async function archiveAccessibleScope(userId: string) {
  const resolved = await resolveManagementReadScope({}, userId);
  return {
    clientIds: resolved.context.scope.clientIds,
    buildingIds: resolved.context.scope.buildingIds,
  };
}

export const reportArchiveGenerationService = {
  downloadReportArchive,
  generateReportArchive,
  renderReportArchiveArtifact,
};
