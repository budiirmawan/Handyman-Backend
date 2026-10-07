import { bastDocumentService } from '../bast-documents/bast-document.service';
import { contextAccessService } from '../context-access';
import { vendorBuildingRepository } from '../vendor-buildings';
import {
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import {
  bastBuildingMismatchError,
  bastLegacyWriteRestrictedError,
  bastNotFoundError,
} from './vendor-bast-binding.errors';
import { vendorBastRepository } from './vendor-bast-binding.repository';
import type {
  PublicVendorBast,
  VendorBastFilters,
  VendorBastRecord,
} from './vendor-bast-binding.types';

/**
 * CR-BE-BAST-01 PART 03 — BE-15 Vendor BAST compatibility service.
 *
 * Reads retain the legacy Vendor Work references while lifecycle and Sign-Off
 * values come from a safely linked BE-22 BAST. Legacy-only rows are readable
 * but labelled as fallbacks. No command in this service mutates
 * `vendor_bast_bindings` lifecycle columns.
 */
export function toPublicVendorBast(record: VendorBastRecord): PublicVendorBast {
  const { canonicalLink: _canonicalLink, ...publicRecord } = record;
  return {
    ...publicRecord,
    submittedAt: record.submittedAt ? record.submittedAt.toISOString() : null,
    acceptedAt: record.acceptedAt ? record.acceptedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    acceptanceSignOff: record.acceptanceSignOff
      ? {
          ...record.acceptanceSignOff,
          signedAt: record.acceptanceSignOff.signedAt.toISOString(),
        }
      : null,
  };
}

/**
 * The legacy create contract cannot safely construct the shared Document and
 * immutable Version required by canonical BE-22, so it is explicitly
 * deprecated rather than creating a second BAST authority.
 */
export async function createBast(): Promise<never> {
  throw bastLegacyWriteRestrictedError(
    'create',
    'Create BAST through POST /bast-documents.',
  );
}

export async function getBast(
  bastId: string,
  userId: string,
): Promise<PublicVendorBast> {
  const record = await vendorBastRepository.findById(bastId);
  if (!record) {
    throw bastNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicVendorBast(record);
}

export async function listBasts(
  filters: VendorBastFilters,
  userId: string,
  accessibleBuildingIds: string[],
): Promise<PublicVendorBast[]> {
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
      throw bastBuildingMismatchError();
    }
  }

  const buildingIds =
    effectiveFilters.buildingId !== undefined
      ? [effectiveFilters.buildingId]
      : accessibleBuildingIds;
  if (buildingIds.length === 0) {
    return [];
  }

  const records = await vendorBastRepository.list({
    vendorWorkId: effectiveFilters.vendorWorkId,
    vendorId: effectiveFilters.vendorId,
    buildingId: effectiveFilters.buildingId,
    buildingIds,
  });
  return records.map(toPublicVendorBast);
}

async function loadForCanonicalDelegation(
  bastId: string,
  userId: string,
): Promise<{ record: VendorBastRecord; canonicalBastDocumentId: string }> {
  const record = await vendorBastRepository.findById(bastId);
  if (!record) {
    throw bastNotFoundError();
  }
  // Authorize the legacy resource before inspecting whether its canonical link
  // can be delegated. Cross-Building canonical details are suppressed by SQL.
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  const canonical = record.canonicalLink;
  const safeStableContext =
    record.compatibility.lifecycleAuthority === 'CANONICAL_BAST' &&
    canonical !== null &&
    canonical.clientId === record.clientId &&
    canonical.buildingId === record.buildingId &&
    canonical.workOrderId === record.workOrderId &&
    canonical.vendorWorkId === record.vendorWorkId &&
    canonical.completionReportId === record.completionReportId &&
    canonical.serviceReportId === record.serviceReportId &&
    canonical.bastNumber === record.bastNumber;

  if (!safeStableContext || !canonical) {
    throw bastLegacyWriteRestrictedError(
      'lifecycle',
      'Reconcile this legacy row to a context-consistent canonical BAST, then use the canonical endpoint.',
    );
  }
  return { record, canonicalBastDocumentId: canonical.id };
}

/** Delegates legacy submit to the canonical immutable-attempt command. */
export async function submitBast(
  bastId: string,
  userId: string,
  documentVersionId: string,
): Promise<PublicVendorBast> {
  const { record, canonicalBastDocumentId } =
    await loadForCanonicalDelegation(bastId, userId);
  const command =
    record.acceptanceStatus === 'REJECTED'
      ? bastDocumentService.resubmitBastDocument
      : bastDocumentService.submitBastDocument;
  await command(canonicalBastDocumentId, { documentVersionId }, userId);
  return getBast(bastId, userId);
}

/** Delegates legacy accept to the canonical Sign-Off decision command. */
export async function acceptBast(
  bastId: string,
  userId: string,
  notes?: string | null,
): Promise<PublicVendorBast> {
  const { canonicalBastDocumentId } = await loadForCanonicalDelegation(
    bastId,
    userId,
  );
  await bastDocumentService.decideBastDocument(
    canonicalBastDocumentId,
    { decision: 'ACCEPT', notes: notes?.trim() || null },
    userId,
  );
  return getBast(bastId, userId);
}

/** Delegates legacy reject to the canonical Sign-Off/Finding command. */
export async function rejectBast(
  bastId: string,
  userId: string,
  notes?: string | null,
): Promise<PublicVendorBast> {
  const { canonicalBastDocumentId } = await loadForCanonicalDelegation(
    bastId,
    userId,
  );
  await bastDocumentService.decideBastDocument(
    canonicalBastDocumentId,
    { decision: 'REJECT', notes: notes?.trim() || null },
    userId,
  );
  return getBast(bastId, userId);
}

export const vendorBastService = {
  acceptBast,
  createBast,
  getBast,
  listBasts,
  rejectBast,
  submitBast,
  toPublicVendorBast,
};
