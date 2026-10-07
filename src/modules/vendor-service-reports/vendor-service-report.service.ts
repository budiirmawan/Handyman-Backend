import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorCompletionReportRepository } from '../vendor-completion-reports';
import {
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  serviceReportAlreadyExistsError,
  serviceReportAlreadyFinalizedError,
  serviceReportBuildingMismatchError,
  serviceReportCompletionMismatchError,
  serviceReportNotFoundError,
  serviceReportNumberAlreadyExistsError,
} from './vendor-service-report.errors';
import { vendorServiceReportRepository } from './vendor-service-report.repository';
import type {
  CreateVendorServiceReportInput,
  PublicVendorServiceReport,
  UpdateVendorServiceReportInput,
  VendorServiceReportFilters,
  VendorServiceReportRecord,
} from './vendor-service-report.types';

/**
 * BE-15G — Vendor Service Report service.
 *
 * A reporting layer over BE-15B Vendor Work: it records the vendor's service
 * report (number, date, summary, work performed, recommendations) and
 * finalizes it (DRAFT → FINALIZED). No separate service workflow engine is
 * created — the BE-08 Work Order / BE-15F completion context remains the
 * authority.
 */

export function toPublicVendorServiceReport(
  record: VendorServiceReportRecord,
): PublicVendorServiceReport {
  return {
    id: record.id,
    clientId: record.clientId,
    vendorWorkId: record.vendorWorkId,
    completionReportId: record.completionReportId,
    workOrderId: record.workOrderId,
    buildingId: record.buildingId,
    serviceReportNumber: record.serviceReportNumber,
    serviceDate: record.serviceDate,
    summary: record.summary,
    workPerformed: record.workPerformed,
    recommendation: record.recommendation,
    preparedByUserId: record.preparedByUserId,
    status: record.status,
    finalizedAt: record.finalizedAt ? record.finalizedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Resolves the Vendor Work and its authoritative Building / Client context
 * from the BE-08 Work Order (the authority for the Work Order's Building),
 * plus the BE-15F completion report for the same Vendor Work when one exists.
 */
async function resolveVendorWorkContext(vendorWorkId: string): Promise<{
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  clientId: string;
  completionReportId: string | null;
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
    throw serviceReportBuildingMismatchError();
  }

  const completionReport =
    await vendorCompletionReportRepository.findByVendorWorkId(vendorWorkId);
  if (completionReport && completionReport.workOrderId !== workOrder.id) {
    throw serviceReportCompletionMismatchError();
  }

  return {
    vendorWorkId: work.id,
    workOrderId: workOrder.id,
    buildingId: workOrder.buildingId,
    clientId: workOrder.clientId,
    completionReportId: completionReport ? completionReport.id : null,
  };
}

function isWorkUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_service_reports_work_unique'
  );
}

function isNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_service_reports_number_unique'
  );
}

export async function createServiceReport(
  input: CreateVendorServiceReportInput,
  userId: string,
): Promise<PublicVendorServiceReport> {
  const context = await resolveVendorWorkContext(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, context.buildingId);

  const existing = await vendorServiceReportRepository.findByVendorWorkId(
    context.vendorWorkId,
  );
  if (existing) {
    throw serviceReportAlreadyExistsError();
  }

  try {
    const record = await vendorServiceReportRepository.create({
      clientId: context.clientId,
      vendorWorkId: context.vendorWorkId,
      completionReportId: context.completionReportId,
      workOrderId: context.workOrderId,
      buildingId: context.buildingId,
      serviceReportNumber: input.serviceReportNumber,
      serviceDate: input.serviceDate,
      summary: input.summary?.trim() || null,
      workPerformed: input.workPerformed?.trim() || null,
      recommendation: input.recommendation?.trim() || null,
      preparedByUserId: input.preparedByUserId,
    });
    await recordOperationalEvent({
      clientId: context.clientId,
      eventType: 'VENDOR_SERVICE_REPORT_CREATED',
      entityType: 'VENDOR_SERVICE_REPORT',
      entityId: record.id,
      actorUserId: input.preparedByUserId,
      buildingId: context.buildingId,
      vendorWorkId: context.vendorWorkId,
      summary: 'Vendor service report created',
      metadata: {
        serviceReportId: record.id,
        workOrderId: context.workOrderId,
      },
    });
    return toPublicVendorServiceReport(record);
  } catch (error) {
    if (isWorkUniqueViolation(error)) {
      throw serviceReportAlreadyExistsError();
    }
    if (isNumberUniqueViolation(error)) {
      throw serviceReportNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getServiceReport(
  reportId: string,
  userId: string,
): Promise<PublicVendorServiceReport> {
  const record = await vendorServiceReportRepository.findById(reportId);
  if (!record) {
    throw serviceReportNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicVendorServiceReport(record);
}

export async function listServiceReports(
  filters: VendorServiceReportFilters,
  userId: string,
  accessibleBuildingIds: string[],
): Promise<PublicVendorServiceReport[]> {
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
      throw serviceReportBuildingMismatchError();
    }
  }

  const buildingIds =
    effectiveFilters.buildingId !== undefined
      ? [effectiveFilters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  const records = await vendorServiceReportRepository.list({
    vendorWorkId: effectiveFilters.vendorWorkId,
    vendorId: effectiveFilters.vendorId,
    buildingId: effectiveFilters.buildingId,
    buildingIds,
  });
  return records.map(toPublicVendorServiceReport);
}

/** Updates a DRAFT report's mutable fields. */
export async function updateServiceReport(
  reportId: string,
  input: UpdateVendorServiceReportInput,
  userId: string,
): Promise<PublicVendorServiceReport> {
  const existing = await vendorServiceReportRepository.findById(reportId);
  if (!existing) {
    throw serviceReportNotFoundError();
  }
  if (existing.status !== 'DRAFT') {
    throw serviceReportAlreadyFinalizedError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const updated = await vendorServiceReportRepository.updateDraft(reportId, {
    serviceDate: input.serviceDate ?? existing.serviceDate,
    summary:
      input.summary === undefined
        ? existing.summary
        : input.summary === null
          ? null
          : input.summary.trim() || null,
    workPerformed:
      input.workPerformed === undefined
        ? existing.workPerformed
        : input.workPerformed === null
          ? null
          : input.workPerformed.trim() || null,
    recommendation:
      input.recommendation === undefined
        ? existing.recommendation
        : input.recommendation === null
          ? null
          : input.recommendation.trim() || null,
  });
  if (!updated) {
    throw serviceReportAlreadyFinalizedError();
  }
  return toPublicVendorServiceReport(updated);
}

/**
 * Finalizes a DRAFT report (DRAFT → FINALIZED). The report becomes immutable
 * and `finalized_at` is set. Report history is preserved through the shared
 * operational-events timeline.
 */
export async function finalizeServiceReport(
  reportId: string,
  userId: string,
): Promise<PublicVendorServiceReport> {
  const existing = await vendorServiceReportRepository.findById(reportId);
  if (!existing) {
    throw serviceReportNotFoundError();
  }
  if (existing.status !== 'DRAFT') {
    throw serviceReportAlreadyFinalizedError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  // Re-validate the Vendor Work / Work Order / completion context.
  await resolveVendorWorkContext(existing.vendorWorkId);

  const finalized = await vendorServiceReportRepository.finalize(reportId);
  if (!finalized) {
    throw serviceReportAlreadyFinalizedError();
  }

  await recordOperationalEvent({
    clientId: existing.clientId,
    eventType: 'VENDOR_SERVICE_REPORT_FINALIZED',
    entityType: 'VENDOR_SERVICE_REPORT',
    entityId: existing.id,
    actorUserId: userId,
    buildingId: existing.buildingId,
    vendorWorkId: existing.vendorWorkId,
    summary: 'Vendor service report finalized',
    metadata: {
      serviceReportId: existing.id,
      workOrderId: existing.workOrderId,
    },
  });

  return toPublicVendorServiceReport(finalized);
}

export const vendorServiceReportService = {
  createServiceReport,
  finalizeServiceReport,
  getServiceReport,
  listServiceReports,
  toPublicVendorServiceReport,
  updateServiceReport,
};
