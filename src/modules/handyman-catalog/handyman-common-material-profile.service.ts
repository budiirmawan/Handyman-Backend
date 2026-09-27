import { AppError } from '../../shared/errors';
import { buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  inventoryItemNotFoundError,
  inventoryItemRepository,
} from '../inventory-items';
import { priceCatalogBuildingNotFoundError } from '../price-catalog-entries/price-catalog-entry.errors';
import {
  PRICE_CATALOG_CURRENCIES,
  priceCatalogLookupService,
} from '../price-catalog-entries';
import { propertyRepository } from '../properties';
import {
  serviceCatalogNotActiveError,
  serviceCatalogNotFoundError,
  serviceCatalogRepository,
} from '../service-catalog';
import { handymanServiceVariantNotFoundError } from './handyman-service-variant.errors';
import { handymanServiceVariantRepository } from './handyman-service-variant.repository';
import {
  handymanCommonMaterialProfileAlreadyExistsError,
  handymanCommonMaterialProfileNotFoundError,
  handymanCommonMaterialProfileReferenceInactiveError,
  handymanCommonMaterialProfileScopeMismatchError,
} from './handyman-common-material-profile.errors';
import { handymanCommonMaterialProfileRepository } from './handyman-common-material-profile.repository';
import {
  isHandymanCommonMaterialProfileStatus,
  isHandymanCustomerMaterialOption,
  isHandymanMaterialCommonality,
  type CreateHandymanCommonMaterialProfileInput,
  type HandymanCommonMaterialProfileCatalogEntry,
  type HandymanCommonMaterialProfileFilters,
  type HandymanCommonMaterialProfileRecord,
  type HandymanMaterialReferencePriceContext,
  type PublicHandymanCommonMaterialProfile,
} from './handyman-common-material-profile.types';
/**
 * CR-HM-02 PART 02 — Handyman Common Material Profile service.
 *
 * Bounded discovery association (frozen chain: service master → optional
 * Handyman variant → common material profile → inventory item master).
 *
 * Authority rules (server-enforced, never caller-driven):
 * - `clientId` is derived from the parent service entry (never supplied)
 *   and cross-checked client-side for every reference (service CHECK-FK
 *   plus the explicit code checks below);
 * - the variant, when supplied, must belong to the selected service AND the
 *   same Client (cross-service/cross-Client relationships are rejected);
 * - the material must sit in the same Client as the service (reject
 *   cross-client material);
 * - inactive authoritative references (service/variant/item) follow the
 *   existing reference-master convention and are rejected.
 *
 * Duplicate rule: one association per (service, item) at service level and
 * per (variant, item) at variant level (pre-check + two partial unique
 * indexes).
 *
 * Reference price: composed ONLY at read time through the existing
 * price-catalog lookup seam, only when the governed lookup resolves an
 * applicable material price — never persisted/copied here (no price
 * columns exist). This association is never an inventory reservation,
 * issue, stock mutation, purchase, or FM workflow; no operational/audit
 * event vocabulary is introduced by this PART.
 */

const UNIQUE_INDEXES = [
  'handyman_common_material_profiles_service_unique',
  'handyman_common_material_profiles_variant_unique',
];

function isDuplicateViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate.constraint !== undefined &&
    UNIQUE_INDEXES.includes(candidate.constraint)
  );
}

function toPublic(
  record: HandymanCommonMaterialProfileRecord,
): PublicHandymanCommonMaterialProfile {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Client-scoped isolation (service-catalog/variant convention). */
async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Profile validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

function normalizeOptionalText(
  value: string | undefined,
  field: string,
): string | null {
  if (value === undefined) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 1 || trimmed.length > 1000) {
    throw AppError.validation('Profile validation failed.', [
      { field, message: `${field} must be 1-1000 characters when provided.` },
    ]);
  }
  return trimmed;
}

export async function createHandymanCommonMaterialProfile(
  input: CreateHandymanCommonMaterialProfileInput,
  actorUserId: string,
): Promise<PublicHandymanCommonMaterialProfile> {
  assertUuid(input.serviceCatalogId, 'serviceCatalogId');
  assertUuid(input.inventoryItemId, 'inventoryItemId');
  if (input.serviceVariantId !== undefined) {
    assertUuid(input.serviceVariantId, 'serviceVariantId');
  }

  // 1) Master service: must exist and be ACTIVE (reference-master idiom).
  const service = await serviceCatalogRepository.findById(
    undefined,
    input.serviceCatalogId,
  );
  if (!service) throw serviceCatalogNotFoundError();
  if (service.status !== 'ACTIVE') throw serviceCatalogNotActiveError();

  await assertClientAccess(actorUserId, service.clientId);

  // 2) Optional variant: must belong to the selected service + Client and
  //    be ACTIVE (frozen chain; cross-service relationships rejected).
  let variantId: string | null = null;
  if (input.serviceVariantId !== undefined) {
    const variant = await handymanServiceVariantRepository.findById(
      undefined,
      input.serviceVariantId,
    );
    if (!variant) throw handymanServiceVariantNotFoundError();
    if (
      variant.serviceCatalogId !== service.id ||
      variant.clientId !== service.clientId
    ) {
      throw handymanCommonMaterialProfileScopeMismatchError();
    }
    if (variant.status !== 'ACTIVE') {
      throw handymanCommonMaterialProfileReferenceInactiveError();
    }
    variantId = variant.id;
  }

  // 3) Material master (inventory item stays authoritative): same Client as
  //    the service, ACTIVE — cross-client material is rejected.
  const item = await inventoryItemRepository.findById(input.inventoryItemId);
  if (!item) throw inventoryItemNotFoundError();
  if (item.clientId !== service.clientId) {
    throw handymanCommonMaterialProfileScopeMismatchError();
  }
  if (item.status !== 'ACTIVE') {
    throw handymanCommonMaterialProfileReferenceInactiveError();
  }

  // 4) Frozen catalog metadata only (spec/compatibility/typical quantity/
  //    commonality/customer material option).
  const specification = normalizeOptionalText(
    input.specification,
    'specification',
  );
  const compatibility = normalizeOptionalText(
    input.compatibility,
    'compatibility',
  );
  let typicalQuantity: number | null = null;
  if (input.typicalQuantity !== undefined) {
    if (
      typeof input.typicalQuantity !== 'number' ||
      !Number.isFinite(input.typicalQuantity) ||
      input.typicalQuantity <= 0
    ) {
      throw AppError.validation('Profile validation failed.', [
        {
          field: 'typicalQuantity',
          message: 'typicalQuantity must be a positive number when provided.',
        },
      ]);
    }
    typicalQuantity = input.typicalQuantity;
  }
  if (!isHandymanMaterialCommonality(input.commonality)) {
    throw AppError.validation('Profile validation failed.', [
      {
        field: 'commonality',
        message: 'commonality is not a recognized Handyman material commonality.',
      },
    ]);
  }
  if (!isHandymanCustomerMaterialOption(input.customerMaterialOption)) {
    throw AppError.validation('Profile validation failed.', [
      {
        field: 'customerMaterialOption',
        message: 'customerMaterialOption is not a recognized Handyman option.',
      },
    ]);
  }

  // 5) Duplicate association: pre-check + partial unique indexes.
  const existing = await handymanCommonMaterialProfileRepository.findDuplicate(
    undefined,
    service.id,
    variantId,
    item.id,
  );
  if (existing) throw handymanCommonMaterialProfileAlreadyExistsError();

  try {
    const record = await handymanCommonMaterialProfileRepository.insertProfile(
      undefined,
      {
        clientId: service.clientId,
        serviceCatalogId: service.id,
        serviceVariantId: variantId,
        inventoryItemId: item.id,
        specification,
        compatibility,
        typicalQuantity,
        commonality: input.commonality,
        customerMaterialOption: input.customerMaterialOption,
        createdByUserId: actorUserId,
      },
    );
    return toPublic(record);
  } catch (error) {
    if (isDuplicateViolation(error)) {
      throw handymanCommonMaterialProfileAlreadyExistsError();
    }
    throw error;
  }
}

/** Client-scoped read foundation. */
export async function listHandymanCommonMaterialProfiles(
  filters: HandymanCommonMaterialProfileFilters,
  actorUserId: string,
): Promise<PublicHandymanCommonMaterialProfile[]> {
  assertUuid(filters.clientId, 'clientId');
  if (filters.serviceCatalogId !== undefined) {
    assertUuid(filters.serviceCatalogId, 'serviceCatalogId');
  }
  if (filters.serviceVariantId !== undefined) {
    assertUuid(filters.serviceVariantId, 'serviceVariantId');
  }
  if (
    filters.status !== undefined &&
    !isHandymanCommonMaterialProfileStatus(filters.status)
  ) {
    throw AppError.validation('Profile validation failed.', [
      { field: 'status', message: 'status is not a recognized profile status.' },
    ]);
  }
  await assertClientAccess(actorUserId, filters.clientId);
  const records = await handymanCommonMaterialProfileRepository.listScoped(
    undefined,
    filters,
  );
  return records.map(toPublic);
}

/**
 * Compose the catalogue entry with its reference price through the existing
 * price-catalog lookup seam. The price is ONLY exposed when an applicable
 * material price resolves; otherwise `referencePrice` is null (fail-closed,
 * never guessed) and nothing is persisted or copied.
 */
export async function describeHandymanCommonMaterialProfile(
  profileId: string,
  actorUserId: string,
  referencePriceContext: HandymanMaterialReferencePriceContext,
): Promise<HandymanCommonMaterialProfileCatalogEntry> {
  assertUuid(profileId, 'profileId');
  assertUuid(referencePriceContext.buildingId, 'buildingId');
  if (
    !(PRICE_CATALOG_CURRENCIES as readonly string[]).includes(
      referencePriceContext.currency,
    )
  ) {
    throw AppError.validation('Profile validation failed.', [
      { field: 'currency', message: 'currency is not a governed price currency.' },
    ]);
  }

  const record = await handymanCommonMaterialProfileRepository.findById(
    undefined,
    profileId,
  );
  if (!record) throw handymanCommonMaterialProfileNotFoundError();
  await assertClientAccess(actorUserId, record.clientId);

  // The lookup's scope anchor must sit in the SAME Client as the profile —
  // a cross-client Building can never price this material.
  const building = await buildingRepository.findById(
    referencePriceContext.buildingId,
  );
  if (!building) throw priceCatalogBuildingNotFoundError();
  const property = await propertyRepository.findById(building.propertyId);
  if (!property || property.clientId !== record.clientId) {
    throw handymanCommonMaterialProfileScopeMismatchError();
  }

  // Authoritative material UOM anchors the MATERIAL price lane; without a
  // UOM no applicable material price can resolve (fail-closed null).
  const item = await inventoryItemRepository.findById(record.inventoryItemId);
  if (!item || item.uomId === null) {
    return { ...toPublic(record), referencePrice: null };
  }

  const result = await priceCatalogLookupService.lookupPriceCatalogEntry(
    {
      sourceMode: 'MATERIAL',
      itemId: item.id,
      uomId: item.uomId,
      buildingId: referencePriceContext.buildingId,
      currency: referencePriceContext.currency,
      asOf: referencePriceContext.asOf ?? new Date().toISOString(),
    },
    actorUserId,
  );

  if (result.resolution !== 'MATCHED' || !result.entry || !result.scopeTier) {
    return { ...toPublic(record), referencePrice: null };
  }

  return {
    ...toPublic(record),
    referencePrice: {
      unitPrice: Number(result.entry.unitPrice),
      currency: result.entry.currency,
      effectiveFrom: result.entry.effectiveFrom,
      effectiveTo: result.entry.effectiveTo,
      scopeTier: result.scopeTier,
    },
  };
}

export const handymanCommonMaterialProfileService = {
  createHandymanCommonMaterialProfile,
  listHandymanCommonMaterialProfiles,
  describeHandymanCommonMaterialProfile,
};
