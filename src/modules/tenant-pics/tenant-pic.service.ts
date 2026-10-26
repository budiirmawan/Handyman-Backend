import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import type { AuditRequestContext } from '../audit';
import { recordEvent } from '../audit';
import { permissionDeniedError } from '../auth/auth.errors';
import { recordOperationalEvent } from '../operational-events';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import {
  tenantCompanyInactiveForPicError,
  tenantPicInactivePrimaryError,
  tenantPicNotFoundError,
  tenantPicUserAlreadyLinkedError,
} from './tenant-pic.errors';
import { tenantPicRepository } from './tenant-pic.repository';
import {
  assertTenantPicIdentityChangeAuthorized,
  type TenantPicIdentityAuthorization,
} from './tenant-pic-identity.guard';
import type { TenantVerificationStatus } from '../tenant-companies/tenant-company.types';
import type {
  CreateTenantPicInput,
  NewTenantPic,
  PublicTenantPic,
  TenantPicRecord,
  UpdateTenantPicInput,
} from './tenant-pic.types';

function toPublic(record: TenantPicRecord): PublicTenantPic {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(userId: string, clientId: string, tx?: PoolClient): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId, tx))) {
    throw buildingAccessDeniedError();
  }
}

async function auditIdentityChange(
  tx: PoolClient,
  clientId: string,
  previousUserId: string | null,
  pic: TenantPicRecord,
  actorUserId: string,
  authorization: TenantPicIdentityAuthorization,
): Promise<void> {
  await recordOperationalEvent({
    clientId,
    buildingId: authorization.buildingIds.length === 1 ? authorization.buildingIds[0] : null,
    actorUserId,
    eventType: 'tenant_pic.identity_link_changed',
    entityType: 'tenant_pic',
    entityId: pic.id,
    summary: 'Tenant PIC identity link changed',
    metadata: {
      tenantCompanyId: pic.tenantCompanyId,
      previousUserId,
      nextUserId: pic.userId,
      authority: authorization.authority,
      buildingIds: authorization.buildingIds,
    },
  }, tx);
}

export async function createTenantPic(
  input: CreateTenantPicInput,
  actorUserId: string,
): Promise<PublicTenantPic> {
  try {
    return await withTransaction(async (tx) => {
      await tenantPicRepository.lockCompany(input.tenantCompanyId, tx);
      const company = await tenantCompanyRepository.findById(input.tenantCompanyId, tx);
      if (!company) throw tenantCompanyNotFoundError();
      await assertClientAccess(actorUserId, company.clientId, tx);
      if (company.status !== 'ACTIVE') throw tenantCompanyInactiveForPicError();

      const status = input.status ?? 'ACTIVE';
      const isPrimary = input.isPrimary ?? false;
      if (isPrimary && status !== 'ACTIVE') throw tenantPicInactivePrimaryError();
      const record: NewTenantPic = {
        tenantCompanyId: input.tenantCompanyId,
        userId: input.userId ?? null,
        picName: input.picName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        roleTitle: input.roleTitle ?? null,
        isPrimary,
        status,
        verificationStatus: input.verificationStatus ?? 'VERIFIED',
      };
      const identity = record.userId === null ? null
        : await assertTenantPicIdentityChangeAuthorized(tx, company, null, record.userId, actorUserId);
      const created = await tenantPicRepository.create(record, tx);
      if (identity) await auditIdentityChange(tx, company.clientId, null, created, actorUserId, identity);
      return toPublic(created);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_pics_company_user_unique')) {
      throw tenantPicUserAlreadyLinkedError();
    }
    throw error;
  }
}

export async function getTenantPic(id: string, actorUserId: string): Promise<PublicTenantPic> {
  const record = await tenantPicRepository.findById(id);
  if (!record) throw tenantPicNotFoundError();
  const company = await tenantCompanyRepository.findById(record.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  return toPublic(record);
}

export async function listTenantPics(
  tenantCompanyId: string,
  actorUserId: string,
): Promise<PublicTenantPic[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  return (await tenantPicRepository.listByTenantCompany(tenantCompanyId)).map(toPublic);
}

export async function updateTenantPic(
  id: string,
  input: UpdateTenantPicInput,
  actorUserId: string,
): Promise<PublicTenantPic> {
  try {
    return await withTransaction(async (tx) => {
      const reference = await tenantPicRepository.findById(id, tx);
      if (!reference) throw tenantPicNotFoundError();
      // Same company -> PIC order as primary-contact mutations. NO KEY UPDATE
      // keeps the company mutex compatible with decision-insert FK locks.
      await tenantPicRepository.lockCompany(reference.tenantCompanyId, tx);
      const existing = await tenantPicRepository.findByIdForUpdate(id, tx);
      if (!existing) throw tenantPicNotFoundError();
      if (existing.tenantCompanyId !== reference.tenantCompanyId) throw permissionDeniedError();
      const company = await tenantCompanyRepository.findById(existing.tenantCompanyId, tx);
      if (!company) throw tenantCompanyNotFoundError();
      await assertClientAccess(actorUserId, company.clientId, tx);

      const resultingStatus = input.status ?? existing.status;
      if (input.isPrimary === true && resultingStatus !== 'ACTIVE') {
        throw tenantPicInactivePrimaryError();
      }
      // Omitted or unchanged userId is contact maintenance, not a relink.
      const identity = input.userId !== undefined && input.userId !== existing.userId
        ? await assertTenantPicIdentityChangeAuthorized(tx, company, existing, input.userId, actorUserId)
        : null;
      const effectiveInput = { ...input };
      if (resultingStatus === 'INACTIVE' && existing.isPrimary && input.isPrimary === undefined) {
        effectiveInput.isPrimary = false;
      }

      const updated = await tenantPicRepository.update(id, existing.tenantCompanyId, effectiveInput, tx);
      if (!updated) throw tenantPicNotFoundError();
      if (identity) await auditIdentityChange(tx, company.clientId, existing.userId, updated, actorUserId, identity);
      return toPublic(updated);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_pics_company_user_unique')) {
      throw tenantPicUserAlreadyLinkedError();
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — auditable PIC verification verdict (the PIC
 * counterpart of the Tenant party verification action).
 */
export async function setTenantPicVerification(
  id: string,
  status: TenantVerificationStatus,
  actorUserId: string,
  audit: AuditRequestContext = {},
): Promise<PublicTenantPic> {
  const existing = await tenantPicRepository.findById(id);
  if (!existing) throw tenantPicNotFoundError();
  const company = await tenantCompanyRepository.findById(existing.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  const updated = await tenantPicRepository.setVerificationStatus(id, status);
  if (!updated) throw tenantPicNotFoundError();
  if (updated.verificationStatus !== existing.verificationStatus) {
    await recordEvent({
      eventType: 'TENANT_VERIFICATION_UPDATED',
      outcome: 'SUCCESS',
      userId: actorUserId,
      actorUserId: audit.actorUserId ?? actorUserId,
      requestId: audit.requestId ?? null,
      ipAddress: audit.ipAddress ?? null,
      userAgent: audit.userAgent ?? null,
      metadata: {
        subject: 'TENANT_PIC',
        tenantPicId: id,
        tenantCompanyId: existing.tenantCompanyId,
        from: existing.verificationStatus,
        to: updated.verificationStatus,
      },
    });
  }
  return toPublic(updated);
}

export const tenantPicService = {
  createTenantPic,
  getTenantPic,
  listTenantPics,
  setTenantPicVerification,
  updateTenantPic,
};
