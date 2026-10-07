import { AppError } from '../../shared/errors';
import {
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import {
  vendorComplianceDocumentAlreadyActiveError,
  vendorComplianceDocumentNotFoundError,
  vendorComplianceDocumentStatusDateMismatchError,
} from './vendor-compliance-document.errors';
import { vendorComplianceDocumentRepository } from './vendor-compliance-document.repository';
import type {
  CreateVendorComplianceDocumentInput,
  NewVendorComplianceDocument,
  PublicVendorComplianceDocument,
  UpdateVendorComplianceDocumentInput,
  VendorComplianceDocumentRecord,
  VendorComplianceDocumentStatus,
} from './vendor-compliance-document.types';

export function toPublicVendorComplianceDocument(
  record: VendorComplianceDocumentRecord,
): PublicVendorComplianceDocument {
  return {
    id: record.id,
    vendorId: record.vendorId,
    documentType: record.documentType,
    documentNumber: record.documentNumber,
    documentName: record.documentName,
    issueDate: record.issueDate,
    expiryDate: record.expiryDate,
    status: record.status,
    fileReference: record.fileReference,
    notes: record.notes,
  };
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the
 * race-condition backstop behind the explicit duplicate pre-check.
 */
function isActiveDocumentUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint ===
      'vendor_compliance_documents_active_unique'
  );
}

function assertDateOrder(
  issueDate: Date | null,
  expiryDate: Date | null,
): void {
  if (issueDate !== null && expiryDate !== null && expiryDate < issueDate) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'expiryDate',
        message: 'expiryDate must be the same as or after issueDate.',
      },
    ]);
  }
}

/**
 * Keeps status and dates consistent (BE-06G rule; the BE-06H expiry ENGINE
 * — scheduled transitions, reminders, renewals — deliberately does not
 * exist yet):
 *   - ACTIVE  requires the expiry date, when present, to be in the future.
 *   - EXPIRED requires an expiry date in the past.
 *   - INACTIVE carries no date requirement (withdrawn/superseded history).
 */
function assertStatusDateConsistency(
  status: VendorComplianceDocumentStatus,
  expiryDate: Date | null,
  now: Date = new Date(),
): void {
  if (status === 'ACTIVE' && expiryDate !== null && expiryDate < now) {
    throw vendorComplianceDocumentStatusDateMismatchError(
      'An ACTIVE compliance document cannot carry an expiry date in the past; use status EXPIRED.',
    );
  }

  if (status === 'EXPIRED' && (expiryDate === null || expiryDate >= now)) {
    throw vendorComplianceDocumentStatusDateMismatchError(
      'An EXPIRED compliance document requires an expiry date in the past.',
    );
  }
}

/**
 * Creates a compliance document (metadata + opaque file reference only —
 * no binary, no OCR, no approval workflow, no renewal automation).
 *
 * Validation order (pinned by tests):
 *   1. unknown Vendor               → 404 VENDOR_NOT_FOUND
 *   2. issue/expiry order           → 400 VALIDATION_ERROR
 *   3. status/date consistency      → 400 ..._STATUS_DATE_MISMATCH
 *   4. conflicting ACTIVE document  → 409 ..._ALREADY_ACTIVE
 *      (same vendor + type + number; history rows never conflict)
 */
export async function createVendorComplianceDocument(
  input: CreateVendorComplianceDocumentInput,
): Promise<PublicVendorComplianceDocument> {
  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const status = input.status ?? 'ACTIVE';
  const issueDate = input.issueDate ?? null;
  const expiryDate = input.expiryDate ?? null;

  assertDateOrder(issueDate, expiryDate);
  assertStatusDateConsistency(status, expiryDate);

  if (status === 'ACTIVE') {
    const existing =
      await vendorComplianceDocumentRepository.findActiveByTypeAndNumber(
        input.vendorId,
        input.documentType,
        input.documentNumber,
      );
    if (existing) {
      throw vendorComplianceDocumentAlreadyActiveError();
    }
  }

  const newDocument: NewVendorComplianceDocument = {
    vendorId: input.vendorId,
    documentType: input.documentType,
    documentNumber: input.documentNumber,
    documentName: input.documentName,
    issueDate,
    expiryDate,
    status,
    fileReference: input.fileReference ?? null,
    notes: input.notes ?? null,
  };

  try {
    const record = await vendorComplianceDocumentRepository.create(newDocument);
    return toPublicVendorComplianceDocument(record);
  } catch (error) {
    if (isActiveDocumentUniqueViolation(error)) {
      throw vendorComplianceDocumentAlreadyActiveError();
    }
    throw error;
  }
}

export async function getVendorComplianceDocumentById(
  id: string,
): Promise<PublicVendorComplianceDocument> {
  const record = await vendorComplianceDocumentRepository.findById(id);
  if (!record) {
    throw vendorComplianceDocumentNotFoundError();
  }
  return toPublicVendorComplianceDocument(record);
}

/**
 * Lists the compliance documents of one Vendor, history included.
 *
 * The Vendor is validated first (unknown Vendor → 404 rather than an empty
 * list) and the query is scoped to `vendor_id`, so another Vendor's — and
 * therefore another Client's — documents are never reachable through this
 * route (Client isolation inherited through the Vendor).
 */
export async function listVendorComplianceDocumentsByVendor(
  vendorId: string,
): Promise<PublicVendorComplianceDocument[]> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const records =
    await vendorComplianceDocumentRepository.listByVendorId(vendorId);
  return records.map(toPublicVendorComplianceDocument);
}

/**
 * Partially updates document metadata and/or status. `vendorId` is
 * deliberately immutable. The post-update shape is fully re-validated
 * (date order, status/date consistency, ACTIVE-conflict) against the
 * merged result, so a partial update can never leave the row inconsistent.
 */
export async function updateVendorComplianceDocument(
  id: string,
  input: UpdateVendorComplianceDocumentInput,
): Promise<PublicVendorComplianceDocument> {
  const existing = await vendorComplianceDocumentRepository.findById(id);
  if (!existing) {
    throw vendorComplianceDocumentNotFoundError();
  }

  const documentType = input.documentType ?? existing.documentType;
  const documentNumber = input.documentNumber ?? existing.documentNumber;
  const issueDate =
    input.issueDate === undefined ? existing.issueDate : input.issueDate;
  const expiryDate =
    input.expiryDate === undefined ? existing.expiryDate : input.expiryDate;
  const status = input.status ?? existing.status;

  assertDateOrder(issueDate, expiryDate);
  assertStatusDateConsistency(status, expiryDate);

  // The post-update row must not collide with a DIFFERENT active document
  // of the same (vendor, type, number).
  if (status === 'ACTIVE') {
    const active =
      await vendorComplianceDocumentRepository.findActiveByTypeAndNumber(
        existing.vendorId,
        documentType,
        documentNumber,
      );
    if (active && active.id !== existing.id) {
      throw vendorComplianceDocumentAlreadyActiveError();
    }
  }

  try {
    const record = await vendorComplianceDocumentRepository.update(id, input);
    return toPublicVendorComplianceDocument(
      record as VendorComplianceDocumentRecord,
    );
  } catch (error) {
    if (isActiveDocumentUniqueViolation(error)) {
      throw vendorComplianceDocumentAlreadyActiveError();
    }
    throw error;
  }
}

export const vendorComplianceDocumentService = {
  createVendorComplianceDocument,
  getVendorComplianceDocumentById,
  listVendorComplianceDocumentsByVendor,
  toPublicVendorComplianceDocument,
  updateVendorComplianceDocument,
};
