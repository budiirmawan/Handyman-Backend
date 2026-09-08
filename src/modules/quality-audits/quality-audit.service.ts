import { buildingNotFoundError, buildingRepository } from '../buildings';
import { cleaningAreaRepository } from '../cleaning-areas';
import { dailyCleaningRepository } from '../daily-cleaning';
import { publicAreaInspectionRepository } from '../public-area-inspections';
import { supervisorInspectionRepository } from '../supervisor-inspections';
import { toiletInspectionRepository } from '../toilet-inspections';
import {
  qualityAuditImmutableError,
  qualityAuditNotFoundError,
  qualityAuditSourceNotFoundError,
} from './quality-audit.errors';
import {
  qualityAuditRepository,
  type QualityAuditWithContextRow,
} from './quality-audit.repository';
import type {
  CompleteQualityAuditInput,
  CreateQualityAuditInput,
  PublicQualityAudit,
  QualityAuditFilter,
  QualityAuditRecord,
  QualityAuditSourceType,
  UpdateQualityAuditInput,
} from './quality-audit.types';

type ResolvedSource = {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
};

async function resolveAuditSource(
  sourceType: QualityAuditSourceType,
  sourceId: string,
): Promise<ResolvedSource> {
  if (sourceType === 'DAILY_CLEANING') {
    const task = await dailyCleaningRepository.findById(sourceId);
    if (!task) {
      throw qualityAuditSourceNotFoundError();
    }
    return {
      clientId: task.client_id,
      buildingId: task.building_id,
      cleaningAreaId: task.cleaning_area_id,
    };
  }

  if (sourceType === 'TOILET_INSPECTION') {
    const context = await toiletInspectionRepository.findExecutionContext(
      sourceId,
    );
    if (!context) {
      throw qualityAuditSourceNotFoundError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
    };
  }

  if (sourceType === 'PUBLIC_AREA_INSPECTION') {
    const context =
      await publicAreaInspectionRepository.findExecutionContext(sourceId);
    if (!context) {
      throw qualityAuditSourceNotFoundError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
    };
  }

  if (sourceType === 'SUPERVISOR_INSPECTION') {
    const inspection = await supervisorInspectionRepository.findById(sourceId);
    if (!inspection) {
      throw qualityAuditSourceNotFoundError();
    }
    return {
      clientId: inspection.clientId,
      buildingId: inspection.buildingId,
      cleaningAreaId: inspection.cleaningAreaId,
    };
  }

  if (sourceType === 'CLEANING_AREA') {
    const area = await cleaningAreaRepository.findById(sourceId);
    if (!area) {
      throw qualityAuditSourceNotFoundError();
    }
    return {
      clientId: area.clientId,
      buildingId: area.buildingId,
      cleaningAreaId: area.id,
    };
  }

  throw qualityAuditSourceNotFoundError();
}

export function toPublicQualityAudit(
  row: QualityAuditWithContextRow | QualityAuditRecord,
): PublicQualityAudit {
  const isContextRow = 'area_code' in row;
  const ctx = isContextRow ? (row as QualityAuditWithContextRow) : null;
  const rec = !isContextRow ? (row as QualityAuditRecord) : null;

  const clientId = rec ? rec.clientId : ctx!.client_id;
  const buildingId = rec ? rec.buildingId : ctx!.building_id;
  const cleaningAreaId = rec ? rec.cleaningAreaId : ctx!.cleaning_area_id;
  const score = rec ? rec.score : ctx!.score === null ? null : Number(ctx!.score);
  const auditedAt = rec ? rec.auditedAt : ctx!.audited_at;
  const createdAt = rec ? rec.createdAt : ctx!.created_at;
  const updatedAt = rec ? rec.updatedAt : ctx!.updated_at;

  return {
    id: row.id,
    clientId,
    buildingId,
    cleaningAreaId,
    sourceType: (row as any).source_type ?? (row as any).sourceType,
    sourceId: (row as any).source_id ?? (row as any).sourceId,
    auditorUserId: (row as any).auditor_user_id ?? (row as any).auditorUserId,
    score,
    result: row.result,
    status: row.status,
    notes: row.notes,
    auditedAt:
      auditedAt instanceof Date
        ? auditedAt.toISOString()
        : auditedAt
          ? String(auditedAt)
          : null,
    createdAt:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : String(createdAt),
    updatedAt:
      updatedAt instanceof Date
        ? updatedAt.toISOString()
        : String(updatedAt),
    cleaningArea:
      ctx && ctx.area_code
        ? {
            id: ctx.cleaning_area_id!,
            code: ctx.area_code,
            name: ctx.area_name!,
            status: ctx.area_status!,
          }
        : null,
  };
}

export async function createQualityAudit(
  input: CreateQualityAuditInput,
): Promise<PublicQualityAudit> {
  const source = await resolveAuditSource(input.sourceType, input.sourceId);

  const record = await qualityAuditRepository.create({
    clientId: source.clientId,
    buildingId: source.buildingId,
    cleaningAreaId: source.cleaningAreaId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    auditorUserId: input.auditorUserId,
    score: input.score ?? null,
    result: input.result ?? null,
    notes: input.notes ?? null,
  });

  const full = await qualityAuditRepository.findById(record.id);
  return toPublicQualityAudit(full!);
}

export async function getQualityAuditById(
  id: string,
): Promise<PublicQualityAudit> {
  const row = await qualityAuditRepository.findById(id);
  if (!row) {
    throw qualityAuditNotFoundError();
  }
  return toPublicQualityAudit(row);
}

export async function listQualityAudits(
  filter: QualityAuditFilter = {},
): Promise<PublicQualityAudit[]> {
  if (filter.buildingId) {
    const building = await buildingRepository.findById(filter.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
  }

  const rows = await qualityAuditRepository.list(filter);
  return rows.map(toPublicQualityAudit);
}

export async function updateQualityAudit(
  id: string,
  input: UpdateQualityAuditInput,
): Promise<PublicQualityAudit> {
  const existing = await qualityAuditRepository.findById(id);
  if (!existing) {
    throw qualityAuditNotFoundError();
  }
  if (existing.status === 'COMPLETED') {
    throw qualityAuditImmutableError();
  }

  const record = await qualityAuditRepository.update(id, input);
  return toPublicQualityAudit(record as QualityAuditRecord);
}

export async function completeQualityAudit(
  id: string,
  input: CompleteQualityAuditInput,
): Promise<PublicQualityAudit> {
  const existing = await qualityAuditRepository.findById(id);
  if (!existing) {
    throw qualityAuditNotFoundError();
  }
  if (existing.status === 'COMPLETED') {
    throw qualityAuditImmutableError();
  }

  const record = await qualityAuditRepository.complete(id, input);
  return toPublicQualityAudit(record as QualityAuditRecord);
}

export const qualityAuditService = {
  completeQualityAudit,
  createQualityAudit,
  getQualityAuditById,
  listQualityAudits,
  toPublicQualityAudit,
  updateQualityAudit,
};
