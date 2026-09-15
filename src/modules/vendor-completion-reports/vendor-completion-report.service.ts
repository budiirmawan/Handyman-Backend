import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { vendorBuildingRepository } from '../vendor-buildings';
import {
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import { vendorWorkEvidenceRepository } from '../vendor-work-evidence';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  completionReportAlreadyExistsError,
  completionReportAlreadySubmittedError,
  completionReportBuildingMismatchError,
  completionReportEvidenceIncompleteError,
  completionReportNotFoundError,
} from './vendor-completion-report.errors';
import { vendorCompletionReportRepository } from './vendor-completion-report.repository';
import type {
  CreateVendorCompletionReportInput,
  PublicVendorCompletionReport,
  UpdateVendorCompletionReportInput,
  VendorCompletionReportFilters,
  VendorCompletionReportRecord,
  VendorWorkEvidenceReadiness,
} from './vendor-completion-report.types';

/**
 * BE-15F — Vendor Completion Report service.
 *
 * A reporting layer over BE-15B Vendor Work: it records the vendor's
 * completion summary/notes, finalizes completion (DRAFT → SUBMITTED), and
 * snapshots the BE-07 evidence-readiness result. No separate completion
 * workflow engine is created — the BE-08 Work Order completion lifecycle
 * remains BE-08's authority.
 *
 * Required evidence is enforced at submission: a report may be drafted
 * without evidence, but cannot be SUBMITTED while any required BE-07 evidence
 * requirement for the Vendor Work is below its minimum count.
 */

export function toPublicVendorCompletionReport(
  record: VendorCompletionReportRecord,
): PublicVendorCompletionReport {
  return {
    id: record.id,
    clientId: record.clientId,
    vendorWorkId: record.vendorWorkId,
    workOrderId: record.workOrderId,
    buildingId: record.buildingId,
    completionStatus: record.completionStatus,
    summary: record.summary,
    notes: record.notes,
    completedByUserId: record.completedByUserId,
    completedAt: record.completedAt ? record.completedAt.toISOString() : null,
    evidenceReady: record.evidenceReady,
    missingEvidenceTypes: record.missingEvidenceTypes,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Resolves the Vendor Work and its authoritative Building / Client context
 * from the BE-08 Work Order (the authority for the Work Order's Building).
 */
async function resolveVendorWorkContext(vendorWorkId: string): Promise<{
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  clientId: string;
}> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }

  const workOrder = await workOrderRepository.findById(work.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (workOrder.buildingId !== work.buildingId) {
    throw completionReportBuildingMismatchError();
  }

  return {
    vendorWorkId: work.id,
    workOrderId: workOrder.id,
    buildingId: workOrder.buildingId,
    clientId: workOrder.clientId,
  };
}

/**
 * Resolves the BE-07 evidence readiness for a Vendor Work: the list of
 * required evidence types whose ACTIVE submission count is below the
 * requirement's minimum (reusing BE-15E's repository — no duplicated evidence
 * logic).
 */
async function resolveEvidenceReadiness(
  vendorWorkId: string,
): Promise<VendorWorkEvidenceReadiness> {
  const requirements =
    await vendorWorkEvidenceRepository.listRequirementsForVendorWork(
      vendorWorkId,
    );
  const submissions =
    await vendorWorkEvidenceRepository.listSubmissionsForVendorWork(
      vendorWorkId,
    );

  const missingEvidenceTypes: string[] = [];
  for (const req of requirements) {
    const count = submissions.filter(
      (s) => s.evidenceRequirementId === req.id && s.status === 'ACTIVE',
    ).length;
    if (count < req.minimumCount) {
      missingEvidenceTypes.push(req.evidenceType);
    }
  }

  return {
    ready: missingEvidenceTypes.length === 0,
    missingEvidenceTypes,
  };
}

function isDuplicateReportViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_completion_reports_work_unique'
  );
}

export async function createCompletionReport(
  input: CreateVendorCompletionReportInput,
  userId: string,
): Promise<PublicVendorCompletionReport> {
  const context = await resolveVendorWorkContext(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, context.buildingId);

  const existing =
    await vendorCompletionReportRepository.findByVendorWorkId(
      context.vendorWorkId,
    );
  if (existing) {
    throw completionReportAlreadyExistsError();
  }

  const readiness = await resolveEvidenceReadiness(context.vendorWorkId);

  try {
    const record = await vendorCompletionReportRepository.create({
      clientId: context.clientId,
      vendorWorkId: context.vendorWorkId,
      workOrderId: context.workOrderId,
      buildingId: context.buildingId,
      summary: input.summary?.trim() || null,
      notes: input.notes?.trim() || null,
      evidenceReady: readiness.ready,
      missingEvidenceTypes: readiness.missingEvidenceTypes,
      createdByUserId: userId,
    });
    await recordOperationalEvent({
      clientId: context.clientId,
      eventType: 'VENDOR_COMPLETION_REPORT_CREATED',
      entityType: 'VENDOR_COMPLETION_REPORT',
      entityId: record.id,
      actorUserId: userId,
      buildingId: context.buildingId,
      vendorWorkId: context.vendorWorkId,
      summary: 'Vendor completion report created',
      metadata: {
        completionReportId: record.id,
        workOrderId: context.workOrderId,
      },
    });
    return toPublicVendorCompletionReport(record);
  } catch (error) {
    if (isDuplicateReportViolation(error)) {
      throw completionReportAlreadyExistsError();
    }
    throw error;
  }
}

export async function getCompletionReport(
  reportId: string,
  userId: string,
): Promise<PublicVendorCompletionReport> {
  const record = await vendorCompletionReportRepository.findById(reportId);
  if (!record) {
    throw completionReportNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicVendorCompletionReport(record);
}

export async function listCompletionReports(
  filters: VendorCompletionReportFilters,
  userId: string,
  accessibleBuildingIds: string[],
): Promise<PublicVendorCompletionReport[]> {
  let effectiveFilters = filters;

  if (filters.vendorWorkId) {
    const work = await vendorWorkRepository.findById(filters.vendorWorkId);
    if (!work) {
      throw vendorWorkNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, work.buildingId);
    effectiveFilters = { ...filters, buildingId: work.buildingId };
  }

  if (effectiveFilters.vendorId && effectiveFilters.buildingId) {
    const relationship =
      await vendorBuildingRepository.findActiveByVendorAndBuilding(
        effectiveFilters.vendorId,
        effectiveFilters.buildingId,
      );
    if (!relationship) {
      throw completionReportBuildingMismatchError();
    }
  }

  const buildingIds =
    effectiveFilters.buildingId !== undefined
      ? [effectiveFilters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  const records = await vendorCompletionReportRepository.list({
    vendorWorkId: effectiveFilters.vendorWorkId,
    vendorId: effectiveFilters.vendorId,
    buildingId: effectiveFilters.buildingId,
    buildingIds,
  });
  return records.map(toPublicVendorCompletionReport);
}

/** Updates a DRAFT report's summary/notes (and refreshes the evidence snapshot). */
export async function updateCompletionReport(
  reportId: string,
  input: UpdateVendorCompletionReportInput,
  userId: string,
): Promise<PublicVendorCompletionReport> {
  const existing = await vendorCompletionReportRepository.findById(reportId);
  if (!existing) {
    throw completionReportNotFoundError();
  }
  if (existing.completionStatus !== 'DRAFT') {
    throw completionReportAlreadySubmittedError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const readiness = await resolveEvidenceReadiness(existing.vendorWorkId);

  const updated = await vendorCompletionReportRepository.updateDraft(reportId, {
    summary:
      input.summary === undefined
        ? existing.summary
        : input.summary === null
          ? null
          : input.summary.trim() || null,
    notes:
      input.notes === undefined
        ? existing.notes
        : input.notes === null
          ? null
          : input.notes.trim() || null,
    evidenceReady: readiness.ready,
    missingEvidenceTypes: readiness.missingEvidenceTypes,
  });
  if (!updated) {
    throw completionReportAlreadySubmittedError();
  }
  return toPublicVendorCompletionReport(updated);
}

/**
 * Submits/finalizes a DRAFT report. Required BE-07 evidence must be satisfied
 * first; the report becomes SUBMITTED with `completed_by_user_id` and
 * `completed_at` set. A SUBMITTED report is immutable (final completion is
 * protected).
 */
export async function submitCompletionReport(
  reportId: string,
  userId: string,
): Promise<PublicVendorCompletionReport> {
  const existing = await vendorCompletionReportRepository.findById(reportId);
  if (!existing) {
    throw completionReportNotFoundError();
  }
  if (existing.completionStatus !== 'DRAFT') {
    throw completionReportAlreadySubmittedError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  // Re-validate the Vendor Work / Work Order context authoritatively.
  await resolveVendorWorkContext(existing.vendorWorkId);

  const readiness = await resolveEvidenceReadiness(existing.vendorWorkId);
  if (!readiness.ready) {
    throw completionReportEvidenceIncompleteError(
      readiness.missingEvidenceTypes,
    );
  }

  const finalized = await vendorCompletionReportRepository.finalize(
    reportId,
    userId,
  );
  if (!finalized) {
    throw completionReportAlreadySubmittedError();
  }

  await recordOperationalEvent({
    clientId: existing.clientId,
    eventType: 'VENDOR_COMPLETION_REPORT_SUBMITTED',
    entityType: 'VENDOR_COMPLETION_REPORT',
    entityId: existing.id,
    actorUserId: userId,
    buildingId: existing.buildingId,
    vendorWorkId: existing.vendorWorkId,
    summary: 'Vendor completion report submitted',
    metadata: {
      completionReportId: existing.id,
      workOrderId: existing.workOrderId,
    },
  });

  return toPublicVendorCompletionReport(finalized);
}

export const vendorCompletionReportService = {
  createCompletionReport,
  getCompletionReport,
  listCompletionReports,
  submitCompletionReport,
  toPublicVendorCompletionReport,
  updateCompletionReport,
};
