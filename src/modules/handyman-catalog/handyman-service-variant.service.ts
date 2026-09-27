import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  isValidServiceCatalogCode,
  normalizeServiceCatalogCode,
  serviceCatalogNotActiveError,
  serviceCatalogNotFoundError,
  serviceCatalogRepository,
} from '../service-catalog';
import {
  handymanServiceVariantCodeAlreadyExistsError,
  handymanServiceVariantNotFoundError,
} from './handyman-service-variant.errors';
import { handymanServiceVariantRepository } from './handyman-service-variant.repository';
import {
  isHandymanServiceVariantStatus,
  type CreateHandymanServiceVariantInput,
  type HandymanServiceVariantFilters,
  type HandymanServiceVariantRecord,
  type PublicHandymanServiceVariant,
} from './handyman-service-variant.types';

/**
 * CR-HM-02 PART 01 — Handyman Service Variant service.
 *
 * Foundation on top of the existing `service_catalog` master (frozen
 * CR-HM-02 governance): the service entry remains the sole authoritative
 * service master; a Variant is Handyman-governed identity/presentation only,
 * attached to an ACTIVE master entry. Tenant isolation is derived and
 * structural: `clientId` always comes from the parent service entry (never
 * the caller), the composite scope-FK proves it at the storage layer, and
 * every read/write additionally passes the existing per-Client access rule
 * (same convention as `service_catalog` — Catalogue entries are
 * Client-scoped, isolation is per Client).
 *
 * Duplicate rule: variant identity `(service_catalog_id, code)` is unique
 * for the life of the service (pre-check + DB unique constraint).
 *
 * No material/media/price/request/evidence behavior here (later PARTs), and
 * no operational/audit event vocabulary is introduced by this PART (same
 * restraint as CR-HM-01 PART 01).
 */

const CODE_UNIQUE_CONSTRAINT =
  'handyman_service_variants_service_code_unique';

function isCodeUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === CODE_UNIQUE_CONSTRAINT
  );
}

function toPublic(
  record: HandymanServiceVariantRecord,
): PublicHandymanServiceVariant {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Client-scoped isolation (mirrors service-catalog convention). */
async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

export async function createHandymanServiceVariant(
  input: CreateHandymanServiceVariantInput,
  actorUserId: string,
): Promise<PublicHandymanServiceVariant> {
  if (!isValidUuid(input.serviceCatalogId)) {
    throw AppError.validation('Variant validation failed.', [
      {
        field: 'serviceCatalogId',
        message: 'serviceCatalogId must be a valid UUID.',
      },
    ]);
  }

  // Master reference: must exist and be ACTIVE (reference-master idiom;
  // inactive handling follows the service-catalog repository convention).
  const service = await serviceCatalogRepository.findById(
    undefined,
    input.serviceCatalogId,
  );
  if (!service) {
    throw serviceCatalogNotFoundError();
  }
  if (service.status !== 'ACTIVE') {
    throw serviceCatalogNotActiveError();
  }

  await assertClientAccess(actorUserId, service.clientId);

  const code = normalizeServiceCatalogCode(input.code);
  const details: { field: string; message: string }[] = [];
  if (!isValidServiceCatalogCode(code)) {
    details.push({
      field: 'code',
      message:
        'code must start with a letter and contain only uppercase letters, digits, underscore or hyphen (2-64 characters).',
    });
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 200) {
    details.push({
      field: 'name',
      message: 'name is required (1-200 characters).',
    });
  }
  let description: string | null = null;
  if (input.description !== undefined) {
    const trimmed = input.description.trim();
    if (trimmed.length < 1 || trimmed.length > 1000) {
      details.push({
        field: 'description',
        message: 'description must be 1-1000 characters when provided.',
      });
    } else {
      description = trimmed;
    }
  }
  if (details.length > 0) {
    throw AppError.validation('Variant validation failed.', details);
  }

  const existing = await handymanServiceVariantRepository
    .findByCodeForService(undefined, service.id, code);
  if (existing) {
    throw handymanServiceVariantCodeAlreadyExistsError();
  }

  try {
    const record = await handymanServiceVariantRepository.insertVariant(
      undefined,
      {
        clientId: service.clientId,
        serviceCatalogId: service.id,
        code,
        name,
        description,
        createdByUserId: actorUserId,
      },
    );
    return toPublic(record);
  } catch (error) {
    if (isCodeUniqueViolation(error)) {
      throw handymanServiceVariantCodeAlreadyExistsError();
    }
    throw error;
  }
}

/** Client-scoped read foundation for later catalogue composition. */
export async function listHandymanServiceVariants(
  filters: HandymanServiceVariantFilters,
  actorUserId: string,
): Promise<PublicHandymanServiceVariant[]> {
  if (!isValidUuid(filters.clientId)) {
    throw AppError.validation('Variant validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  if (
    filters.serviceCatalogId !== undefined &&
    !isValidUuid(filters.serviceCatalogId)
  ) {
    throw AppError.validation('Variant validation failed.', [
      {
        field: 'serviceCatalogId',
        message: 'serviceCatalogId must be a valid UUID when provided.',
      },
    ]);
  }
  if (
    filters.status !== undefined &&
    !isHandymanServiceVariantStatus(filters.status)
  ) {
    throw AppError.validation('Variant validation failed.', [
      { field: 'status', message: 'status is not a recognized variant status.' },
    ]);
  }
  await assertClientAccess(actorUserId, filters.clientId);
  const records = await handymanServiceVariantRepository.listScoped(
    undefined,
    filters,
  );
  return records.map(toPublic);
}

export async function getHandymanServiceVariant(
  id: string,
): Promise<PublicHandymanServiceVariant> {
  const record = await handymanServiceVariantRepository.findById(
    undefined,
    id,
  );
  if (!record) throw handymanServiceVariantNotFoundError();
  return toPublic(record);
}

export const handymanServiceVariantService = {
  createHandymanServiceVariant,
  listHandymanServiceVariants,
  getHandymanServiceVariant,
};
