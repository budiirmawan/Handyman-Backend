import {
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import { vendorWorkHistoryInvalidFilterError } from './vendor-work-history.errors';
import { vendorWorkHistoryRepository } from './vendor-work-history.repository';
import type {
  PublicVendorWorkHistoryEvent,
  VendorWorkHistoryFilters,
} from './vendor-work-history.types';

/**
 * BE-15K — Vendor Work History service.
 *
 * Lists the Vendor Work history in chronological order, reusing the shared
 * BE-07 operational-events store. The history covers every BE-15 domain:
 * assignment, work lifecycle, checklist binding, permit readiness, evidence,
 * completion / service report, BAST, verification, and rework / resubmission.
 * Related operational references are resolved from each event's metadata.
 *
 * History is append-oriented and read-only — no update/delete is exposed, and
 * the BE-07 writer scrubs credentials / tokens / sensitive payloads before
 * persistence.
 */
export async function getVendorWorkHistory(
  vendorWorkId: string,
  filters: VendorWorkHistoryFilters,
): Promise<PublicVendorWorkHistoryEvent[]> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }

  if (
    filters.from !== undefined &&
    filters.to !== undefined &&
    new Date(filters.from) > new Date(filters.to)
  ) {
    throw vendorWorkHistoryInvalidFilterError();
  }

  return vendorWorkHistoryRepository.listByVendorWork(
    work.id,
    work.vendorAssignmentId,
    filters,
  );
}

export const vendorWorkHistoryService = {
  getVendorWorkHistory,
};
