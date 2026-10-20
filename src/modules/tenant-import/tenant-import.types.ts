/**
 * CR-HM-MASTER-TENANT-BATCH-01 — Tenant/PIC batch import domain types.
 *
 * A batch import registers real parties (individuals or legal entities) and
 * their PICs in bulk, and optionally attaches effective-dated Unit relations.
 * It NEVER invents a party for a Unit whose occupant is unknown: a row without
 * party data is invalid, and a Unit without a row simply stays unassigned.
 *
 * Relation vocabulary is deliberately four-way and maps 1:1 onto the existing
 * authorities (no duplicated relationship truth):
 *   TENANCY → `tenant_space_relationships` (BE-14C, the occupancy authority)
 *   OWNER / OCCUPANT / PIC → `unit_party_roles` (CR-HM-MASTER-IND-01)
 */
import { createHash } from 'node:crypto';
import {
  isTenantVerificationStatus,
  type TenantVerificationStatus,
} from '../tenant-companies/tenant-company.types';

export const TENANT_IMPORT_BATCH_STATUSES = [
  'UPLOADED',
  'VALIDATED',
  'CONFIRMED',
  'COMMITTED',
  'ABORTED',
] as const;
export type TenantImportBatchStatus =
  (typeof TENANT_IMPORT_BATCH_STATUSES)[number];

export function isTenantImportBatchStatus(
  value: unknown,
): value is TenantImportBatchStatus {
  return (
    typeof value === 'string' &&
    (TENANT_IMPORT_BATCH_STATUSES as readonly string[]).includes(value)
  );
}

export const TENANT_IMPORT_ROW_STATUSES = [
  'PENDING',
  'VALID',
  'INVALID',
  'COMMITTED',
  'SKIPPED_EXISTS',
  'FAILED',
] as const;
export type TenantImportRowStatus =
  (typeof TENANT_IMPORT_ROW_STATUSES)[number];

export function isTenantImportRowStatus(
  value: unknown,
): value is TenantImportRowStatus {
  return (
    typeof value === 'string' &&
    (TENANT_IMPORT_ROW_STATUSES as readonly string[]).includes(value)
  );
}

/** Closed per-row error vocabulary (documented in the CR OpenAPI). */
export const TENANT_IMPORT_ROW_ERROR_CODES = [
  'VALIDATION',
  'PARTY_REQUIRED',
  'DUPLICATE_ROW',
  'DUPLICATE_PIC',
  'TENANT_IDENTITY_CONFLICT',
  'BUILDING_ACCESS_DENIED',
  'APARTMENT_UNIT_NOT_FOUND',
  'TENANT_SPACE_ALREADY_ASSIGNED',
  'UNIT_PARTY_ROLE_ALREADY_ACTIVE',
  'TENANT_COMPANY_INACTIVE',
  'COMMIT_FAILED',
] as const;
export type TenantImportRowErrorCode =
  (typeof TENANT_IMPORT_ROW_ERROR_CODES)[number];

export const TENANT_IMPORT_RELATIONS = [
  'TENANCY',
  'OWNER',
  'OCCUPANT',
  'PIC',
] as const;
export type TenantImportRelation = (typeof TENANT_IMPORT_RELATIONS)[number];

export function isTenantImportRelation(
  value: unknown,
): value is TenantImportRelation {
  return (
    typeof value === 'string' &&
    (TENANT_IMPORT_RELATIONS as readonly string[]).includes(value)
  );
}

export type TenantImportPartyInput = {
  tenantCode?: string;
  tenantName: string;
  partyKind?: 'INDIVIDUAL' | 'LEGAL_ENTITY';
  legalName?: string;
  identityDocumentType?: string;
  identityDocumentNumber?: string;
  email?: string;
  phone?: string;
  address?: string;
  status?: 'ACTIVE' | 'INACTIVE';
};

export type TenantImportPicInput = {
  picName: string;
  email?: string;
  phone?: string;
  roleTitle?: string;
  isPrimary?: boolean;
  status?: 'ACTIVE' | 'INACTIVE';
};

export type TenantImportUnitLinkInput = {
  buildingId: string;
  unitId?: string;
  unitCode?: string;
  relation: TenantImportRelation;
  effectiveFrom?: string;
  effectiveUntil?: string;
  replaceExisting?: boolean;
};

export type TenantImportRowInput = {
  externalRef?: string;
  party: TenantImportPartyInput;
  /** Defaults to PENDING_VERIFICATION — a temporary registration. */
  verificationStatus?: TenantVerificationStatus;
  pics?: TenantImportPicInput[];
  unitLinks?: TenantImportUnitLinkInput[];
};

export type TenantImportBatchRecord = {
  id: string;
  clientId: string;
  idempotencyKey: string | null;
  sourceName: string;
  sourceChecksum: string;
  status: TenantImportBatchStatus;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  committedRows: number;
  skippedRows: number;
  createdByUserId: string;
  createdAt: Date;
  validatedAt: Date | null;
  confirmedAt: Date | null;
  committedAt: Date | null;
  abortedAt: Date | null;
  updatedAt: Date;
};

export type PublicTenantImportBatch = Omit<
  TenantImportBatchRecord,
  'createdAt' | 'validatedAt' | 'confirmedAt' | 'committedAt' | 'abortedAt' | 'updatedAt'
> & {
  createdAt: string;
  validatedAt: string | null;
  confirmedAt: string | null;
  committedAt: string | null;
  abortedAt: string | null;
  updatedAt: string;
};

export type TenantImportRowRecord = {
  id: string;
  batchId: string;
  clientId: string;
  rowNumber: number;
  rowKey: string;
  payload: TenantImportRowInput;
  status: TenantImportRowStatus;
  errorCode: string | null;
  errorMessage: string | null;
  outcome: Record<string, unknown>;
  tenantCompanyId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantImportRow = {
  id: string;
  batchId: string;
  rowNumber: number;
  rowKey: string;
  externalRef: string | null;
  status: TenantImportRowStatus;
  errorCode: string | null;
  errorMessage: string | null;
  outcome: Record<string, unknown>;
  tenantCompanyId: string | null;
  /** Identity document numbers are masked in every read (IND-01 discipline). */
  party: Omit<TenantImportPartyInput, 'identityDocumentNumber'> & {
    identityDocumentNumber: string | null;
  };
  verificationStatus: TenantVerificationStatus;
  picCount: number;
  unitLinkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TenantImportPlanStep =
  | { step: 'PARTY'; action: 'CREATE' | 'REUSE'; tenantCode: string }
  | {
      step: 'PIC';
      action: 'CREATE' | 'SKIP';
      picIndex: number;
      picName: string;
      match?: string;
    }
  | {
      step: 'LINK';
      action: 'CREATE' | 'REPLACE' | 'SKIP';
      linkIndex: number;
      relation: TenantImportRelation;
      buildingId: string;
      unitId: string;
      replaceRelationshipId?: string;
      replaceRoleIds?: string[];
    };

/** Masked display form: `•••• 1234` (never the full number). */
export function maskIdentityDocumentNumber(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const tail = value.slice(-4);
  return `•••• ${tail}`;
}

/**
 * Deterministic party identity for dedup/idempotency:
 *   1. identity document (strongest — one physical party per document),
 *   2. tenantCode,
 *   3. normalized name + email fallback for code-less, document-less rows.
 */
export function rowKeyForParty(party: {
  tenantCode?: string;
  tenantName?: string;
  identityDocumentType?: string;
  identityDocumentNumber?: string;
  email?: string;
}): string {
  const docType = party.identityDocumentType?.trim().toUpperCase();
  const docNumber = party.identityDocumentNumber
    ?.trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (docType && docNumber) return `ID:${docType}:${docNumber}`;
  const code = party.tenantCode?.trim().toUpperCase();
  if (code) return `CODE:${code}`;
  const name = (party.tenantName ?? '').trim().toUpperCase();
  const email = (party.email ?? '').trim().toLowerCase();
  const digest = createHash('sha256')
    .update(`${name}|${email}`)
    .digest('hex')
    .slice(0, 32);
  return `NAME:${digest}`;
}

/** Stable derived tenantCode for rows without one (fits CODE_PATTERN). */
export function derivedTenantCode(rowKey: string): string {
  return `TEN-${createHash('sha256').update(rowKey).digest('hex').slice(0, 12).toUpperCase()}`;
}

export { isTenantVerificationStatus };
export type { TenantVerificationStatus };
