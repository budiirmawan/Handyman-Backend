import { buildingNotFoundError, buildingRepository } from '../buildings';
import { cleaningAreaRepository } from '../cleaning-areas';
import { contextAccessService } from '../context-access';
import {
  dailyCleaningNotFoundError,
  dailyCleaningRepository,
} from '../daily-cleaning';
import { permissionService } from '../permissions';
import { publicAreaInspectionRepository } from '../public-area-inspections';
import { supervisorInspectionRepository } from '../supervisor-inspections';
import { toiletInspectionRepository } from '../toilet-inspections';
import {
  qualityAuditDraftAlreadyExistsError,
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
  DailyCleaningQualityAuditContext,
  PublicQualityAudit,
  QualityAuditMobileAction,
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

/**
 * Creates a DRAFT quality audit for an audited Housekeeping source.
 *
 * CR-BE-RN15-CLEANING-QUALITY-MOBILE-01 tightens the ORDER of the two checks
 * that guard the insert, without changing either outcome:
 *
 *   1. BE-02G Building access is asserted BEFORE the row is written. The
 *      Building is derived from the resolved source, so it is known as soon as
 *      the source is resolved; previously the controller asserted it AFTER the
 *      create had already committed, which left an audit row belonging to an
 *      unauthorized caller behind every 403. The caller still sees the same
 *      403 BUILDING_ACCESS_DENIED — now with nothing persisted.
 *   2. At most ONE DRAFT audit may exist per `(sourceType, sourceId)`. The
 *      pre-check gives a clean 409; the unique-violation translation below
 *      covers the concurrent race the pre-check cannot. COMPLETED audits are
 *      not consulted at all, so quality history stays unlimited.
 */
export async function createQualityAudit(
  input: CreateQualityAuditInput,
): Promise<PublicQualityAudit> {
  const source = await resolveAuditSource(input.sourceType, input.sourceId);

  await contextAccessService.assertBuildingAccess(
    input.auditorUserId,
    source.buildingId,
  );

  const existingDraft = await qualityAuditRepository.findDraftBySource(
    input.sourceType,
    input.sourceId,
  );
  if (existingDraft) {
    throw qualityAuditDraftAlreadyExistsError();
  }

  let record;
  try {
    record = await qualityAuditRepository.create({
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
  } catch (error) {
    if (qualityAuditRepository.isDraftQualityAuditUniqueViolation(error)) {
      throw qualityAuditDraftAlreadyExistsError();
    }
    throw error;
  }

  const full = await qualityAuditRepository.findById(record.id);
  return toPublicQualityAudit(full!);
}

/**
 * CR-BE-RN15-CLEANING-QUALITY-MOBILE-01 — backend-only command authority.
 *
 *   CREATE_AUDIT   — no DRAFT audit exists for the source, and the caller may
 *                    manage quality audits;
 *   COMPLETE_AUDIT — a DRAFT audit exists, and the caller may manage quality
 *                    audits.
 *
 * The two are mutually exclusive by construction: the DRAFT either exists or
 * it does not. Building access is asserted by the caller before this resolver
 * runs, so reaching it already proves the Building condition. Mobile never
 * derives these tokens.
 */
export function resolveDailyCleaningQualityAuditActions(input: {
  hasDraftAudit: boolean;
  canManage: boolean;
}): QualityAuditMobileAction[] {
  if (!input.canManage) {
    return [];
  }
  return input.hasDraftAudit ? ['COMPLETE_AUDIT'] : ['CREATE_AUDIT'];
}

/**
 * Target-scoped discovery of the DAILY_CLEANING quality audit for one Daily
 * Cleaning task, so mobile never scans the global quality-audit list.
 *
 * `taskId` is resolved canonically through Daily Cleaning (the same
 * authoritative reading BE-11C publishes as `id` / `taskId`, i.e.
 * `generated_tasks.id`) — no second task lookup is introduced. The Building
 * authority check runs against the task-derived Building before any audit fact
 * is disclosed, so an unrelated-Building caller is denied rather than shown
 * `audit: null`.
 *
 * Read-only. It never creates, updates or completes an audit, and it exposes
 * no completed history: `audit` is the single open DRAFT or `null`.
 */
export async function getDailyCleaningQualityAuditContext(
  taskId: string,
  actorUserId: string,
): Promise<DailyCleaningQualityAuditContext> {
  const task = await dailyCleaningRepository.findById(taskId);
  if (!task) {
    throw dailyCleaningNotFoundError();
  }

  await contextAccessService.assertBuildingAccess(
    actorUserId,
    task.building_id,
  );

  const draft = await qualityAuditRepository.findDraftBySource(
    'DAILY_CLEANING',
    taskId,
  );

  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );

  return {
    audit: draft ? toPublicQualityAudit(draft) : null,
    availableActions: resolveDailyCleaningQualityAuditActions({
      hasDraftAudit: draft !== null,
      canManage: permissions.has('quality_audit.manage'),
    }),
  };
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
  getDailyCleaningQualityAuditContext,
  getQualityAuditById,
  listQualityAudits,
  resolveDailyCleaningQualityAuditActions,
  toPublicQualityAudit,
  updateQualityAudit,
};
