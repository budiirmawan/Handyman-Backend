import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  tenantCompanyCodeAlreadyExistsError,
  tenantCompanyNotFoundError,
  tenantIdentityDocumentAlreadyExistsError,
} from './tenant-company.errors';
import { tenantCompanyRepository } from './tenant-company.repository';
import {
  assertPartyIdentity,
  type PartyIdentityFields,
} from './tenant-company.validation';
import type {
  CreateTenantCompanyInput,
  PublicTenantCompany,
  TenantCompanyListFilters,
  TenantCompanyRecord,
  UpdateTenantCompanyInput,
} from './tenant-company.types';

function toPublic(record: TenantCompanyRecord): PublicTenantCompany {
  return { ...record, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

export async function createTenantCompany(input: CreateTenantCompanyInput, userId: string): Promise<PublicTenantCompany> {
  await assertClientAccess(userId, input.clientId);
  if (await tenantCompanyRepository.findByCodeForClient(input.clientId, input.tenantCode)) {
    throw tenantCompanyCodeAlreadyExistsError();
  }
  // CR-HM-MASTER-IND-01 — identity uniqueness is checked before the insert so
  // the API returns a stable 409; the partial unique index remains the final
  // race-proof authority and is mapped below.
  if (input.identityDocumentType && input.identityDocumentNumber) {
    const existing = await tenantCompanyRepository.findByIdentityDocument(
      input.clientId,
      input.identityDocumentType,
      input.identityDocumentNumber,
    );
    if (existing) throw tenantIdentityDocumentAlreadyExistsError();
  }
  try {
    return toPublic(await tenantCompanyRepository.create(input));
  } catch (error) {
    if (isCodeUniqueViolation(error)) throw tenantCompanyCodeAlreadyExistsError();
    if (isIdentityUniqueViolation(error)) {
      throw tenantIdentityDocumentAlreadyExistsError();
    }
    throw error;
  }
}

export async function getTenantCompany(id: string, userId: string): Promise<PublicTenantCompany> {
  const record = await tenantCompanyRepository.findById(id);
  if (!record) throw tenantCompanyNotFoundError();
  await assertClientAccess(userId, record.clientId);
  return toPublic(record);
}

export async function listTenantCompanies(clientId: string, filters: TenantCompanyListFilters, userId: string): Promise<PublicTenantCompany[]> {
  await assertClientAccess(userId, clientId);
  return (await tenantCompanyRepository.listByClient(clientId, filters)).map(toPublic);
}

export async function updateTenantCompany(id: string, input: UpdateTenantCompanyInput, userId: string): Promise<PublicTenantCompany> {
  const existing = await tenantCompanyRepository.findById(id);
  if (!existing) throw tenantCompanyNotFoundError();
  await assertClientAccess(userId, existing.clientId);

  // Party shape is validated on the MERGED record, so a partial PATCH can
  // never leave an INDIVIDUAL without an identity document or with a legal
  // name (or a LEGAL_ENTITY with a half-supplied document pair).
  const merged: PartyIdentityFields = {
    legalName: input.legalName === undefined ? existing.legalName : input.legalName,
    identityDocumentType: input.identityDocumentType === undefined
      ? existing.identityDocumentType
      : input.identityDocumentType,
    identityDocumentNumber: input.identityDocumentNumber === undefined
      ? existing.identityDocumentNumber
      : input.identityDocumentNumber,
  };
  assertPartyIdentity(existing.partyKind, merged);

  if (
    merged.identityDocumentType &&
    merged.identityDocumentNumber &&
    (merged.identityDocumentType !== existing.identityDocumentType ||
      merged.identityDocumentNumber !== existing.identityDocumentNumber)
  ) {
    const duplicate = await tenantCompanyRepository.findByIdentityDocument(
      existing.clientId,
      merged.identityDocumentType,
      merged.identityDocumentNumber,
    );
    if (duplicate && duplicate.id !== existing.id) {
      throw tenantIdentityDocumentAlreadyExistsError();
    }
  }

  try {
    const updated = await tenantCompanyRepository.update(id, input);
    if (!updated) throw tenantCompanyNotFoundError();
    return toPublic(updated);
  } catch (error) {
    if (isIdentityUniqueViolation(error)) {
      throw tenantIdentityDocumentAlreadyExistsError();
    }
    throw error;
  }
}

function isCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === 'tenant_companies_client_code_unique';
}

function isIdentityUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'tenant_companies_identity_document_unique';
}

export const tenantCompanyService = { createTenantCompany, getTenantCompany, listTenantCompanies, updateTenantCompany };
