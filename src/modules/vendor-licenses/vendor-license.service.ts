import { AppError } from '../../shared/errors';
import {
  vendorComplianceDocumentNotFoundError,
  vendorComplianceDocumentRepository,
} from '../vendor-compliance-documents';
import {
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import {
  vendorLicenseAlreadyActiveError,
  vendorLicenseDocumentMismatchError,
  vendorLicenseNotFoundError,
  vendorLicenseStatusDateMismatchError,
} from './vendor-license.errors';
import { vendorLicenseRepository } from './vendor-license.repository';
import type {
  CreateVendorLicenseInput,
  NewVendorLicense,
  PublicVendorLicense,
  UpdateVendorLicenseInput,
  VendorLicenseExpiryStatus,
  VendorLicenseRecord,
  VendorLicenseStatus,
} from './vendor-license.types';

/**
 * Resolves the expiry status of a record at `asOf` (default: now).
 *
 * This is the BE-06H "resolve expiry status" primitive — a pure read-time
 * computation. It never mutates rows, never schedules anything, and never
 * notifies anyone (no renewal automation, no scheduler in this PART):
 *   - no expiry date            → NOT_APPLICABLE (cannot expire)
 *   - expiry date >= asOf       → VALID
 *   - expiry date <  asOf       → EXPIRED (even when the stored status is
 *                                 still ACTIVE — the resolver is the truth
 *                                 at read time; the stored status is the
 *                                 recorded lifecycle)
 */
export function resolveExpiryStatus(
  record: Pick<VendorLicenseRecord, 'expiryDate'>,
  asOf: Date = new Date(),
): VendorLicenseExpiryStatus {
  if (record.expiryDate === null) {
    return 'NOT_APPLICABLE';
  }
  return record.expiryDate >= asOf ? 'VALID' : 'EXPIRED';
}

export function toPublicVendorLicense(
  record: VendorLicenseRecord,
  asOf: Date = new Date(),
): PublicVendorLicense {
  return {
    id: record.id,
    vendorId: record.vendorId,
    recordType: record.recordType,
    name: record.name,
    number: record.number,
    issuingAuthority: record.issuingAuthority,
    issueDate: record.issueDate,
    expiryDate: record.expiryDate,
    status: record.status,
    expiryStatus: resolveExpiryStatus(record, asOf),
    documentReference: record.documentReference,
    notes: record.notes,
  };
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the
 * race-condition backstop behind the explicit duplicate pre-check.
 */
function isActiveLicenseUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint ===
      'vendor_licenses_certifications_active_unique'
  );
}

function assertDateOrder(issueDate: Date | null, expiryDate: Date | null): void {
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
 * Keeps stored status and dates consistent at WRITE time (the read-time
 * truth is `resolveExpiryStatus`):
 *   - ACTIVE  requires the expiry date, when present, to be in the future.
 *   - EXPIRED requires an expiry date in the past. Expired records remain
 *             historical records — they are never deleted.
 *   - INACTIVE carries no date requirement (withdrawn/superseded history).
 */
function assertStatusDateConsistency(
  status: VendorLicenseStatus,
  expiryDate: Date | null,
  now: Date = new Date(),
): void {
  if (status === 'ACTIVE' && expiryDate !== null && expiryDate < now) {
    throw vendorLicenseStatusDateMismatchError(
      'An ACTIVE license / certification cannot carry an expiry date in the past; use status EXPIRED.',
    );
  }

  if (status === 'EXPIRED' && (expiryDate === null || expiryDate >= now)) {
    throw vendorLicenseStatusDateMismatchError(
      'An EXPIRED license / certification requires an expiry date in the past.',
    );
  }
}

/**
 * Validates an optional BE-06G document reference. The record points at an
 * existing `vendor_compliance_documents` row, so document storage (metadata
 * + file pointer) is reused, never duplicated:
 *   1. unknown document           → 404 VENDOR_COMPLIANCE_DOCUMENT_NOT_FOUND
 *   2. document of another Vendor → 400 ..._DOCUMENT_MISMATCH
 */
async function assertReferencableDocument(
  vendorId: string,
  documentReference: string,
): Promise<void> {
  const document =
    await vendorComplianceDocumentRepository.findById(documentReference);
  if (!document) {
    throw vendorComplianceDocumentNotFoundError();
  }
  if (document.vendorId !== vendorId) {
    throw vendorLicenseDocumentMismatchError();
  }
}

/**
 * Creates a License or Certification record.
 *
 * Validation order (pinned by tests):
 *   1. unknown Vendor             → 404 VENDOR_NOT_FOUND
 *   2. issue/expiry order         → 400 VALIDATION_ERROR
 *   3. status/date consistency    → 400 ..._STATUS_DATE_MISMATCH
 *   4. document reference rules   → see assertReferencableDocument
 *   5. conflicting ACTIVE record  → 409 ..._ALREADY_ACTIVE
 *      (same vendor + record type + number; history never conflicts)
 */
export async function createVendorLicense(
  input: CreateVendorLicenseInput,
): Promise<PublicVendorLicense> {
  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const status = input.status ?? 'ACTIVE';
  const issueDate = input.issueDate ?? null;
  const expiryDate = input.expiryDate ?? null;

  assertDateOrder(issueDate, expiryDate);
  assertStatusDateConsistency(status, expiryDate);

  const documentReference = input.documentReference ?? null;
  if (documentReference !== null) {
    await assertReferencableDocument(input.vendorId, documentReference);
  }

  if (status === 'ACTIVE') {
    const existing = await vendorLicenseRepository.findActiveByTypeAndNumber(
      input.vendorId,
      input.recordType,
      input.number,
    );
    if (existing) {
      throw vendorLicenseAlreadyActiveError();
    }
  }

  const newLicense: NewVendorLicense = {
    vendorId: input.vendorId,
    recordType: input.recordType,
    name: input.name,
    number: input.number,
    issuingAuthority: input.issuingAuthority ?? null,
    issueDate,
    expiryDate,
    status,
    documentReference,
    notes: input.notes ?? null,
  };

  try {
    const record = await vendorLicenseRepository.create(newLicense);
    return toPublicVendorLicense(record);
  } catch (error) {
    if (isActiveLicenseUniqueViolation(error)) {
      throw vendorLicenseAlreadyActiveError();
    }
    throw error;
  }
}

export async function getVendorLicenseById(
  id: string,
): Promise<PublicVendorLicense> {
  const record = await vendorLicenseRepository.findById(id);
  if (!record) {
    throw vendorLicenseNotFoundError();
  }
  return toPublicVendorLicense(record);
}

/**
 * Lists the licenses/certifications of one Vendor, history included, each
 * carrying its resolved `expiryStatus`.
 *
 * The Vendor is validated first (unknown Vendor → 404 rather than an empty
 * list) and the query is scoped to `vendor_id`, so another Vendor's — and
 * therefore another Client's — records are never reachable through this
 * route (Client isolation inherited through the Vendor).
 */
export async function listVendorLicensesByVendor(
  vendorId: string,
): Promise<PublicVendorLicense[]> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const asOf = new Date();
  const records = await vendorLicenseRepository.listByVendorId(vendorId);
  return records.map((record) => toPublicVendorLicense(record, asOf));
}

/**
 * The current/effective records of one Vendor at `asOf` (default: now):
 * stored status ACTIVE and not past expiry. An ACTIVE row whose expiry has
 * passed drops out of this view without any row being rewritten — there is
 * no scheduler; effectiveness is resolved at read time.
 */
export async function listCurrentVendorLicenses(
  vendorId: string,
  asOf: Date = new Date(),
): Promise<PublicVendorLicense[]> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const records = await vendorLicenseRepository.listCurrentByVendorId(
    vendorId,
    asOf,
  );
  return records.map((record) => toPublicVendorLicense(record, asOf));
}

/**
 * Partially updates a record (metadata, dates, document reference,
 * status). `vendorId` and `recordType` are deliberately immutable. The
 * post-update shape is fully re-validated against the merged result.
 * Deactivation is `status: 'INACTIVE'`; expired records remain historical
 * records — nothing is deleted.
 */
export async function updateVendorLicense(
  id: string,
  input: UpdateVendorLicenseInput,
): Promise<PublicVendorLicense> {
  const existing = await vendorLicenseRepository.findById(id);
  if (!existing) {
    throw vendorLicenseNotFoundError();
  }

  const number = input.number ?? existing.number;
  const issueDate =
    input.issueDate === undefined ? existing.issueDate : input.issueDate;
  const expiryDate =
    input.expiryDate === undefined ? existing.expiryDate : input.expiryDate;
  const status = input.status ?? existing.status;

  assertDateOrder(issueDate, expiryDate);
  assertStatusDateConsistency(status, expiryDate);

  if (
    input.documentReference !== undefined &&
    input.documentReference !== null &&
    input.documentReference !== existing.documentReference
  ) {
    await assertReferencableDocument(
      existing.vendorId,
      input.documentReference,
    );
  }

  // The post-update row must not collide with a DIFFERENT active record of
  // the same (vendor, record type, number).
  if (status === 'ACTIVE') {
    const active = await vendorLicenseRepository.findActiveByTypeAndNumber(
      existing.vendorId,
      existing.recordType,
      number,
    );
    if (active && active.id !== existing.id) {
      throw vendorLicenseAlreadyActiveError();
    }
  }

  try {
    const record = await vendorLicenseRepository.update(id, input);
    return toPublicVendorLicense(record as VendorLicenseRecord);
  } catch (error) {
    if (isActiveLicenseUniqueViolation(error)) {
      throw vendorLicenseAlreadyActiveError();
    }
    throw error;
  }
}

export const vendorLicenseService = {
  createVendorLicense,
  getVendorLicenseById,
  listCurrentVendorLicenses,
  listVendorLicensesByVendor,
  resolveExpiryStatus,
  toPublicVendorLicense,
  updateVendorLicense,
};
