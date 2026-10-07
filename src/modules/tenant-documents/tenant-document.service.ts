import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import {
  tenantDocumentAlreadyActiveError,
  tenantDocumentContextInvalidError,
  tenantDocumentNotFoundError,
  tenantDocumentStatusDateMismatchError,
} from './tenant-document.errors';
import { tenantDocumentRepository } from './tenant-document.repository';
import type {
  CreateTenantDocumentInput,
  NewTenantDocument,
  PublicTenantDocument,
  TenantDocumentFilters,
  TenantDocumentRecord,
  TenantDocumentStatus,
  UpdateTenantDocumentInput,
} from './tenant-document.types';

function toPublic(record: TenantDocumentRecord): PublicTenantDocument {
  return {
    ...record,
    issueDate: record.issueDate?.toISOString() ?? null,
    expiryDate: record.expiryDate?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertDocumentContext(
  tenantCompanyId: string,
  buildingId: string | null,
  actorUserId: string,
): Promise<{ clientId: string }> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  if (buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
    if (!(await tenantBuildingContextRepository.findActive(tenantCompanyId, buildingId))) {
      throw tenantDocumentContextInvalidError();
    }
  }
  return { clientId: company.clientId };
}

function assertDateOrder(issueDate: Date | null, expiryDate: Date | null): void {
  if (issueDate && expiryDate && expiryDate < issueDate) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'expiryDate',
        message: 'expiryDate must be the same as or after issueDate.',
      },
    ]);
  }
}

function resolveStatus(
  requested: TenantDocumentStatus,
  expiryDate: Date | null,
  now: Date = new Date(),
): TenantDocumentStatus {
  if (requested === 'INACTIVE') return 'INACTIVE';
  if (expiryDate && expiryDate < now) return 'EXPIRED';
  if (requested === 'EXPIRED') {
    throw tenantDocumentStatusDateMismatchError(
      'EXPIRED status requires an expiry date in the past.',
    );
  }
  return 'ACTIVE';
}

export async function createTenantDocument(
  input: CreateTenantDocumentInput,
  actorUserId: string,
): Promise<PublicTenantDocument> {
  const { clientId } = await assertDocumentContext(
    input.tenantCompanyId,
    input.buildingId ?? null,
    actorUserId,
  );
  const issueDate = input.issueDate ?? null;
  const expiryDate = input.expiryDate ?? null;
  assertDateOrder(issueDate, expiryDate);
  const status = resolveStatus(input.status ?? 'ACTIVE', expiryDate);
  const duplicateInput = {
    tenantCompanyId: input.tenantCompanyId,
    buildingId: input.buildingId ?? null,
    documentType: input.documentType,
    documentNumber: input.documentNumber,
  };
  if (
    status === 'ACTIVE' &&
    await tenantDocumentRepository.findActiveDuplicate(duplicateInput)
  ) {
    throw tenantDocumentAlreadyActiveError();
  }

  const record: NewTenantDocument = {
    clientId,
    ...duplicateInput,
    documentName: input.documentName,
    issueDate,
    expiryDate,
    fileReference: input.fileReference ?? null,
    status,
    notes: input.notes ?? null,
  };
  try {
    return toPublic(await tenantDocumentRepository.create(record));
  } catch (error) {
    if (isActiveUnique(error)) throw tenantDocumentAlreadyActiveError();
    throw error;
  }
}

export async function getTenantDocument(
  id: string,
  actorUserId: string,
): Promise<PublicTenantDocument> {
  let record = await tenantDocumentRepository.findById(id);
  if (!record) throw tenantDocumentNotFoundError();
  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  } else {
    await assertClientAccess(actorUserId, record.clientId);
  }
  await tenantDocumentRepository.expireDueById(id);
  record = await tenantDocumentRepository.findById(id);
  return toPublic(record!);
}

export async function listTenantDocuments(
  tenantCompanyId: string,
  filters: TenantDocumentFilters,
  actorUserId: string,
): Promise<PublicTenantDocument[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  await tenantDocumentRepository.expireDueByTenant(tenantCompanyId);
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await tenantDocumentRepository.listByTenant(
      tenantCompanyId,
      filters,
      buildingIds,
    )
  ).map(toPublic);
}

export async function updateTenantDocument(
  id: string,
  input: UpdateTenantDocumentInput,
  actorUserId: string,
): Promise<PublicTenantDocument> {
  const existing = await tenantDocumentRepository.findById(id);
  if (!existing) throw tenantDocumentNotFoundError();
  if (existing.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, existing.buildingId);
  } else {
    await assertClientAccess(actorUserId, existing.clientId);
  }

  const issueDate = input.issueDate === undefined
    ? existing.issueDate
    : input.issueDate;
  const expiryDate = input.expiryDate === undefined
    ? existing.expiryDate
    : input.expiryDate;
  assertDateOrder(issueDate, expiryDate);
  const status = resolveStatus(input.status ?? existing.status, expiryDate);
  if (status === 'ACTIVE' && existing.buildingId) {
    await assertDocumentContext(
      existing.tenantCompanyId,
      existing.buildingId,
      actorUserId,
    );
  }
  const documentType = input.documentType ?? existing.documentType;
  const documentNumber = input.documentNumber ?? existing.documentNumber;
  if (status === 'ACTIVE') {
    const duplicate = await tenantDocumentRepository.findActiveDuplicate({
      tenantCompanyId: existing.tenantCompanyId,
      buildingId: existing.buildingId,
      documentType,
      documentNumber,
    });
    if (duplicate && duplicate.id !== id) throw tenantDocumentAlreadyActiveError();
  }

  try {
    const updated = await tenantDocumentRepository.update(id, {
      ...input,
      status,
    });
    if (!updated) throw tenantDocumentNotFoundError();
    return toPublic(updated);
  } catch (error) {
    if (isActiveUnique(error)) throw tenantDocumentAlreadyActiveError();
    throw error;
  }
}

function isActiveUnique(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'tenant_documents_active_unique';
}

export const tenantDocumentService = {
  createTenantDocument,
  getTenantDocument,
  listTenantDocuments,
  updateTenantDocument,
};
