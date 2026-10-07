import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import { moduleRepository } from '../modules';
import {
  saasPackageCodeAlreadyExistsError,
  saasPackageNotFoundError,
  saasProductCodeAlreadyExistsError,
  saasProductNotFoundError,
} from './platform-product.errors';
import { platformProductRepository } from './platform-product.repository';
import {
  FROZEN_PACKAGE_LIMIT_KEYS,
  type CreateSaasPackageInput,
  type CreateSaasProductInput,
  type ListSaasPackageFilters,
  type ListSaasProductFilters,
  type PackageFeatureInput,
  type PackageLimitInput,
  type SaasPackageDetail,
  type SaasPackageRecord,
  type SaasProductRecord,
  type UpdateSaasPackageInput,
  type UpdateSaasProductInput,
} from './platform-product.types';

/**
 * CR-BE-SAAS-01 PART 02 — SaaS Product & Package catalog domain service
 * (SaaS Control Plane).
 *
 * Audit (frozen §18): platform-scope events use `client_id = NULL` and the
 * single canonical `operational_events` store. Event names:
 *   - SAAS_PRODUCT_CREATED / SAAS_PRODUCT_UPDATED (entity SAAS_PRODUCT);
 *   - SAAS_PACKAGE_CHANGED (frozen §18.2 name; metadata.action =
 *     CREATED | UPDATED) — entity SAAS_PACKAGE.
 *
 * No OCC (frozen §17.3 scopes optimistic concurrency to a fixed aggregate
 * list that does not include the catalog tables); state rules are simple
 * and the catalog is not commercial state.
 */

/** PART 02 event names (see module doc for provenance). */
export const SAAS_PRODUCT_CREATED_EVENT = 'SAAS_PRODUCT_CREATED';
export const SAAS_PRODUCT_UPDATED_EVENT = 'SAAS_PRODUCT_UPDATED';
/** Frozen §18.2 name for package changes. */
export const SAAS_PACKAGE_CHANGED_EVENT = 'SAAS_PACKAGE_CHANGED';

const PRODUCT_STATUS_VALUES = ['ACTIVE', 'INACTIVE'] as const;
const NAME_MAX_LENGTH = 255;
const DESCRIPTION_MAX_LENGTH = 2000;
const UNIT_MAX_LENGTH = 50;
const MAX_FEATURES_PER_PACKAGE = 500;
const MAX_LIMITS_PER_PACKAGE = 500;

function assertName(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw AppError.validation(`${field} is required.`, [
      { field, message: `${field} is required.` },
    ]);
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw AppError.validation(`${field} is too long.`, [
      { field, message: `${field} must be at most ${NAME_MAX_LENGTH} characters.` },
    ]);
  }
  return trimmed;
}

function normalizeDescription(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    throw AppError.validation('description is too long.', [
      {
        field: 'description',
        message: `description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`,
      },
    ]);
  }
  return trimmed;
}

function assertStatus(value: string, field: string): 'ACTIVE' | 'INACTIVE' {
  if (!PRODUCT_STATUS_VALUES.includes(value as 'ACTIVE')) {
    throw AppError.validation(`${field} must be ACTIVE or INACTIVE.`, [
      { field, message: `${field} must be ACTIVE or INACTIVE.` },
    ]);
  }
  return value as 'ACTIVE' | 'INACTIVE';
}

/**
 * Validates package feature composition against the EXISTING canonical
 * `modules` catalogue (contract §9.3). No second feature catalog exists or
 * may be created.
 */
async function assertCapabilitiesExist(
  features: readonly PackageFeatureInput[],
): Promise<void> {
  const details: { field: string; message: string }[] = [];
  for (const feature of features) {
    const module = await moduleRepository.findByCode(feature.capabilityCode);
    if (!module) {
      details.push({
        field: 'features.capabilityCode',
        message: `capability code ${feature.capabilityCode} does not exist in the modules catalogue.`,
      });
    }
  }
  if (details.length > 0) {
    throw AppError.validation('Package features reference unknown capability codes.', details);
  }
}

function normalizeFeatures(
  features: readonly PackageFeatureInput[],
): ReadonlyArray<{ capabilityCode: string; enabled: boolean }> {
  const seen = new Set<string>();
  const normalized: { capabilityCode: string; enabled: boolean }[] = [];
  for (const feature of features) {
    const code = feature.capabilityCode.trim().toUpperCase();
    if (seen.has(code)) {
      throw AppError.validation('Duplicate capability code in features.', [
        {
          field: 'features.capabilityCode',
          message: `capability code ${code} is listed more than once.`,
        },
      ]);
    }
    seen.add(code);
    normalized.push({ capabilityCode: code, enabled: feature.enabled ?? true });
  }
  return normalized;
}

function normalizeLimits(
  limits: readonly PackageLimitInput[],
): ReadonlyArray<{
  limitKey: (typeof FROZEN_PACKAGE_LIMIT_KEYS)[number];
  limitValue: number;
  unit: string;
}> {
  const seen = new Set<string>();
  const normalized: {
    limitKey: (typeof FROZEN_PACKAGE_LIMIT_KEYS)[number];
    limitValue: number;
    unit: string;
  }[] = [];
  for (const limit of limits) {
    const key = limit.limitKey as string;
    if (!(FROZEN_PACKAGE_LIMIT_KEYS as readonly string[]).includes(key)) {
      throw AppError.validation('Unknown package limit key.', [
        {
          field: 'limits.limitKey',
          message: `limit key ${key} is not in the frozen vocabulary (${FROZEN_PACKAGE_LIMIT_KEYS.join(', ')}).`,
        },
      ]);
    }
    if (!Number.isInteger(limit.limitValue) || limit.limitValue < 0) {
      throw AppError.validation('Invalid package limit value.', [
        {
          field: 'limits.limitValue',
          message: 'limitValue must be a non-negative integer.',
        },
      ]);
    }
    if (limit.limitValue > Number.MAX_SAFE_INTEGER) {
      throw AppError.validation('Package limit value too large.', [
        { field: 'limits.limitValue', message: 'limitValue is too large.' },
      ]);
    }
    const unit = limit.unit.trim();
    if (unit.length === 0 || unit.length > UNIT_MAX_LENGTH) {
      throw AppError.validation('Invalid package limit unit.', [
        {
          field: 'limits.unit',
          message: `unit must be a non-empty string of at most ${UNIT_MAX_LENGTH} characters.`,
        },
      ]);
    }
    if (seen.has(key)) {
      throw AppError.validation('Duplicate limit key.', [
        { field: 'limits.limitKey', message: `limit key ${key} is listed more than once.` },
      ]);
    }
    seen.add(key);
    normalized.push({ limitKey: key as (typeof FROZEN_PACKAGE_LIMIT_KEYS)[number], limitValue: limit.limitValue, unit });
  }
  return normalized;
}

function assertCompositionSize(
  features: readonly unknown[],
  limits: readonly unknown[],
): void {
  if (features.length > MAX_FEATURES_PER_PACKAGE) {
    throw AppError.validation('Too many package features.', [
      {
        field: 'features',
        message: `features must have at most ${MAX_FEATURES_PER_PACKAGE} entries.`,
      },
    ]);
  }
  if (limits.length > MAX_LIMITS_PER_PACKAGE) {
    throw AppError.validation('Too many package limits.', [
      {
        field: 'limits',
        message: `limits must have at most ${MAX_LIMITS_PER_PACKAGE} entries.`,
      },
    ]);
  }
}

function productSnapshot(product: SaasProductRecord): Record<string, unknown> {
  return {
    code: product.code,
    name: product.name,
    description: product.description,
    status: product.status,
  };
}

export async function createSaasProduct(
  actorUserId: string,
  authority: string,
  input: CreateSaasProductInput,
): Promise<SaasProductRecord> {
  const code = input.code.trim().toUpperCase();
  if (code.length === 0 || code.length > 64 || !/^[A-Z][A-Z0-9_-]*$/.test(code)) {
    throw AppError.validation('Invalid product code.', [
      {
        field: 'code',
        message: 'code must start with a letter and contain letters, digits, "-" or "_" (max 64).',
      },
    ]);
  }
  const name = assertName(input.name, 'name');
  const description = normalizeDescription(input.description) ?? null;
  const status = input.status !== undefined ? assertStatus(input.status, 'status') : 'ACTIVE';

  const existing = await platformProductRepository.findProductByCode(code);
  if (existing) {
    throw saasProductCodeAlreadyExistsError();
  }

  const record = await platformProductRepository.createProduct({
    code,
    name,
    description,
    status,
  });

  await recordOperationalEvent({
    clientId: null,
    eventType: SAAS_PRODUCT_CREATED_EVENT,
    entityType: 'SAAS_PRODUCT',
    entityId: record.id,
    actorUserId,
    summary: `SaaS product created: ${record.code} (${record.status})`,
    metadata: {
      authority,
      after: productSnapshot(record),
    },
  });

  return record;
}

export async function updateSaasProduct(
  actorUserId: string,
  authority: string,
  productId: string,
  input: UpdateSaasProductInput,
): Promise<SaasProductRecord> {
  const existing = await platformProductRepository.findProductById(productId);
  if (!existing) {
    throw saasProductNotFoundError(productId);
  }

  const normalized: UpdateSaasProductInput = {};
  if (input.name !== undefined) normalized.name = assertName(input.name, 'name');
  if (input.description !== undefined) {
    normalized.description = normalizeDescription(input.description);
  }
  if (input.status !== undefined) {
    normalized.status = assertStatus(input.status, 'status');
  }

  const updated = await platformProductRepository.updateProduct(
    productId,
    normalized,
  );
  if (!updated) {
    throw saasProductNotFoundError(productId);
  }

  const before = productSnapshot(existing);
  const after = productSnapshot(updated);
  const changedFields = Object.keys(after).filter(
    (field) => before[field as keyof typeof before] !== after[field as keyof typeof after],
  );

  await recordOperationalEvent({
    clientId: null,
    eventType: SAAS_PRODUCT_UPDATED_EVENT,
    entityType: 'SAAS_PRODUCT',
    entityId: updated.id,
    actorUserId,
    summary: `SaaS product updated: ${updated.code}`,
    metadata: { authority, before, after, changedFields },
  });

  return updated;
}

export async function listSaasProducts(params: {
  filters: ListSaasProductFilters;
  withTotal: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ records: SaasProductRecord[]; total: number | null }> {
  const limit = params.pageSize;
  const offset = params.page !== undefined && params.pageSize !== undefined
    ? (params.page - 1) * params.pageSize
    : undefined;
  return platformProductRepository.listProducts(
    params.filters,
    params.withTotal,
    limit,
    offset,
  );
}

export async function getSaasProductDetail(
  productId: string,
): Promise<{
  product: SaasProductRecord;
  packages: SaasPackageDetail[];
}> {
  const product = await platformProductRepository.findProductById(productId);
  if (!product) {
    throw saasProductNotFoundError(productId);
  }
  const packageRecords = await platformProductRepository.findPackagesByProductId(
    product.id,
  );
  const packages: SaasPackageDetail[] = [];
  for (const packageRecord of packageRecords) {
    const detail = await platformProductRepository.findPackageDetail(
      packageRecord.id,
    );
    if (detail) packages.push(detail);
  }
  return { product, packages };
}

export async function createSaasPackage(
  actorUserId: string,
  authority: string,
  input: CreateSaasPackageInput,
): Promise<SaasPackageDetail> {
  const product = await platformProductRepository.findProductById(input.productId);
  if (!product) {
    throw saasProductNotFoundError(input.productId);
  }

  const code = input.code.trim().toUpperCase();
  if (code.length === 0 || code.length > 64 || !/^[A-Z][A-Z0-9_-]*$/.test(code)) {
    throw AppError.validation('Invalid package code.', [
      {
        field: 'code',
        message: 'code must start with a letter and contain letters, digits, "-" or "_" (max 64).',
      },
    ]);
  }
  const name = assertName(input.name, 'name');
  const description = normalizeDescription(input.description) ?? null;
  const status = input.status !== undefined ? assertStatus(input.status, 'status') : 'ACTIVE';
  const features = normalizeFeatures(input.features ?? []);
  const limits = normalizeLimits(input.limits ?? []);
  assertCompositionSize(features, limits);
  await assertCapabilitiesExist(features);

  const existing = await platformProductRepository.findPackageByProductAndCode(
    product.id,
    code,
  );
  if (existing) {
    throw saasPackageCodeAlreadyExistsError();
  }

  return withTransaction(async (client) => {
    const record = await platformProductRepository.createPackage(
      {
        productId: product.id,
        code,
        name,
        description,
        status,
      },
      client,
    );
    await platformProductRepository.insertFeatures(
      record.id,
      features,
      client,
    );
    await platformProductRepository.insertLimits(record.id, limits, client);

    const detail = await platformProductRepository.findPackageDetail(
      record.id,
      client,
    );
    if (!detail) {
      throw saasPackageNotFoundError(record.id);
    }

    await recordOperationalEvent(
      {
        clientId: null,
        eventType: SAAS_PACKAGE_CHANGED_EVENT,
        entityType: 'SAAS_PACKAGE',
        entityId: record.id,
        actorUserId,
        summary: `SaaS package created: ${product.code}/${record.code}`,
        metadata: {
          authority,
          action: 'CREATED',
          before: null,
          after: detail,
        },
      },
      client,
    );

    return detail;
  });
}

export async function updateSaasPackage(
  actorUserId: string,
  authority: string,
  packageId: string,
  input: UpdateSaasPackageInput,
): Promise<SaasPackageDetail> {
  const existing = await platformProductRepository.findPackageDetail(packageId);
  if (!existing) {
    throw saasPackageNotFoundError(packageId);
  }

  const normalized: {
    name?: string;
    description?: string | null;
    status?: 'ACTIVE' | 'INACTIVE';
  } = {};
  if (input.name !== undefined) normalized.name = assertName(input.name, 'name');
  if (input.description !== undefined) {
    normalized.description = normalizeDescription(input.description);
  }
  if (input.status !== undefined) {
    normalized.status = assertStatus(input.status, 'status');
  }
  const replacingFeatures = input.features !== undefined;
  const replacingLimits = input.limits !== undefined;
  const features = replacingFeatures ? normalizeFeatures(input.features!) : [];
  const limits = replacingLimits ? normalizeLimits(input.limits!) : [];
  if (replacingFeatures || replacingLimits) {
    assertCompositionSize(features, limits);
    await assertCapabilitiesExist(features);
  }

  return withTransaction(async (client) => {
    const updatedRecord = await platformProductRepository.updatePackageScalars(
      packageId,
      normalized,
      client,
    );
    if (!updatedRecord) {
      throw saasPackageNotFoundError(packageId);
    }

    if (replacingFeatures || replacingLimits) {
      await platformProductRepository.replacePackageComposition(
        packageId,
        replacingFeatures
          ? features
          : existing.features.map((f) => ({
              capabilityCode: f.capabilityCode,
              enabled: f.enabled,
            })),
        replacingLimits
          ? limits
          : existing.limits.map((l) => ({
              limitKey: l.limitKey,
              limitValue: l.limitValue,
              unit: l.unit,
            })),
        client,
      );
    }

    const updated = await platformProductRepository.findPackageDetail(
      packageId,
      client,
    );
    if (!updated) {
      throw saasPackageNotFoundError(packageId);
    }

    const changedFields = Object.keys({
      ...(normalized.name !== undefined ? { name: true } : {}),
      ...(normalized.description !== undefined ? { description: true } : {}),
      ...(normalized.status !== undefined ? { status: true } : {}),
      ...(replacingFeatures ? { features: true } : {}),
      ...(replacingLimits ? { limits: true } : {}),
    });

    await recordOperationalEvent(
      {
        clientId: null,
        eventType: SAAS_PACKAGE_CHANGED_EVENT,
        entityType: 'SAAS_PACKAGE',
        entityId: packageId,
        actorUserId,
        summary: `SaaS package updated: ${existing.code}`,
        metadata: {
          authority,
          action: 'UPDATED',
          before: existing,
          after: updated,
          changedFields,
        },
      },
      client,
    );

    return updated;
  });
}

export async function listSaasPackages(params: {
  filters: ListSaasPackageFilters;
  withTotal: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ records: SaasPackageRecord[]; total: number | null }> {
  const limit = params.pageSize;
  const offset = params.page !== undefined && params.pageSize !== undefined
    ? (params.page - 1) * params.pageSize
    : undefined;
  return platformProductRepository.listPackages(
    params.filters,
    params.withTotal,
    limit,
    offset,
  );
}

export async function getSaasPackageDetail(
  packageId: string,
): Promise<SaasPackageDetail> {
  const detail = await platformProductRepository.findPackageDetail(packageId);
  if (!detail) {
    throw saasPackageNotFoundError(packageId);
  }
  return detail;
}
