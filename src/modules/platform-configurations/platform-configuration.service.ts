import { AppError, ERROR_CODES } from '../../shared/errors';
import { withTransaction } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import { platformConfigurationRepository } from './platform-configuration.repository';
import {
  PLATFORM_CONFIGURATION_AUDIT_EVENT,
  PLATFORM_CONFIGURATION_ENTITY_TYPE,
  PLATFORM_CONFIGURATION_CATALOGUE,
  SAAS_PLATFORM_CONFIGURATION_KEYS,
  entityIdForKey,
  type PlatformConfigurationChange,
  type PlatformConfigurationRecord,
  type SaaSPlatformConfigurationKey,
} from './platform-configuration.types';
import { assertValidPlatformConfigValue } from './platform-configuration.validation';

/**
 * CR-BE-SAAS-01 PART 12A — Platform configuration service
 * (frozen §20.2 / §18.2 / §22).
 *
 * Resolves frozen keys to:
 *   - the persisted value (when configured), OR
 *   - the frozen default (when absent OR malformed), OR
 *   - the static catalogue default when neither is available.
 *
 * Mutations are type-checked against the frozen catalogue shape and
 * produce exactly one `SAAS_PLATFORM_CONFIG_CHANGED` audit record
 * inside the same transaction as the row write. Reads do not
 * audit.
 *
 * OCC §17.3 + §20.2:
 *   - updates require `expectedVersion`;
 *   - `UPDATE WHERE version = expected` returns 0 rows on conflict →
 *     409 conflict.
 *
 * Unknown keys and wrong types → 400 validation. Server remains
 * authoritative on every path.
 */
export function isKnownConfigurationKey(
  key: string,
): key is SaaSPlatformConfigurationKey {
  return (SAAS_PLATFORM_CONFIGURATION_KEYS as readonly string[]).includes(key);
}

function getDescriptor(key: SaaSPlatformConfigurationKey) {
  const desc = PLATFORM_CONFIGURATION_CATALOGUE.get(key);
  if (!desc) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'key',
        message: `${key} is not a frozen platform configuration key (§20.2).`,
      },
    ]);
  }
  return desc;
}

/**
 * Resolve the effective value for a frozen key. Returns
 * `{ source: 'configured' | 'frozen_default', record, value }`.
 * Reads NEVER audit.
 */
export async function resolveConfiguration(
  key: SaaSPlatformConfigurationKey,
): Promise<{
  source: 'configured' | 'frozen_default';
  record: PlatformConfigurationRecord | null;
  value: unknown;
}> {
  const descriptor = getDescriptor(key);
  const row = await platformConfigurationRepository.findByKey(key);
  if (!row) {
    return {
      source: 'frozen_default',
      record: null,
      value: descriptor.frozenDefault(),
    };
  }
  // Validate the persisted value against the frozen shape. If
  // malformed, fall back to the frozen default (PART 08
  // `readConfigNumber` convention).
  const { validatePlatformConfigValue } = await import(
    './platform-configuration.validation'
  );
  const result = validatePlatformConfigValue(key, descriptor.shape, row.value);
  if (!result.ok) {
    return {
      source: 'frozen_default',
      record: row,
      value: descriptor.frozenDefault(),
    };
  }
  return { source: 'configured', record: row, value: result.value };
}

/** Get one configuration key — full record + computed effective
 *  value. Caller-driven: `actorUserId` is for audit consistency
 *  later; reads do NOT audit. */
export async function getConfiguration(
  key: SaaSPlatformConfigurationKey,
): Promise<PlatformConfigurationRecord | null> {
  // Caller must already have validated the key against
  // `isKnownConfigurationKey`. We still re-check here so the public
  // service treats unknown keys as validation failures.
  if (!isKnownConfigurationKey(key)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'key',
        message: `${key} is not a frozen platform configuration key (§20.2).`,
      },
    ]);
  }
  return platformConfigurationRepository.findByKey(key);
}

/** List every known platform configuration row (read-only). */
export async function listAllConfigurations(): Promise<
  PlatformConfigurationRecord[]
> {
  return platformConfigurationRepository.listAll();
}

/** Validate a key + value against the frozen catalogue. Throws
 *  AppError.validation(400) on shape mismatch. */
export function validateValue(
  key: string,
  value: unknown,
): unknown {
  if (!isKnownConfigurationKey(key)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'key',
        message: `${key} is not a frozen platform configuration key (§20.2).`,
      },
    ]);
  }
  return assertValidPlatformConfigValue(key, getDescriptor(key).shape, value);
}

/**
 * Update an existing platform configuration row. OCC §17.3.
 * Audits `SAAS_PLATFORM_CONFIG_CHANGED` inside the same transaction
 * as the UPDATE write.
 */
export async function updateConfiguration(input: {
  actorUserId: string;
  authority: string;
  key: string;
  expectedVersion: number;
  value: unknown;
  description?: string;
  requestId?: string;
}): Promise<PlatformConfigurationChange> {
  // 1. Validate key against frozen catalogue.
  if (!isKnownConfigurationKey(input.key)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'key',
        message: `${input.key} is not a frozen platform configuration key (§20.2).`,
      },
    ]);
  }
  const descriptor = getDescriptor(input.key);
  // 2. Validate value shape.
  const validatedValue = assertValidPlatformConfigValue(
    input.key,
    descriptor.shape,
    input.value,
  );
  if (!input.actorUserId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId is mandatory.' },
    ]);
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'expectedVersion',
        message: 'expectedVersion must be a positive integer.',
      },
    ]);
  }
  // Narrow `input.key` to the frozen CatalogueKey union so the
  // repository helpers (which expect the union) accept it inside
  // the `withTransaction` closure below.
  const narrowedKey: SaaSPlatformConfigurationKey = input.key;
  // 3. Single transaction: find-before + UPDATE (OCC) + audit.
  //    Per PART 13B hardening: the mutation row write and the
  //    `recordOperationalEvent` audit commit atomically. The same
  //    DB client is passed to `recordOperationalEvent` (rule B).
  //    Stale-OCC throws BEFORE any audit is staged (rule D). The
  //    frozen event name `SAAS_PLATFORM_CONFIG_CHANGED` (§18.2) is
  //    emitted exactly once on success (rule A).
  return withTransaction(async (txClient) => {
    const before = await platformConfigurationRepository.findByKey(
      narrowedKey,
      txClient,
    );
    if (!before) {
      throw new AppError({
        code: ERROR_CODES.SAAS_PLATFORM_CONFIG_NOT_FOUND,
        message: `Platform configuration key "${input.key}" does not exist; create it first via POST /platform/configuration/:key.`,
        statusCode: 404,
      });
    }
    const updateResult = await platformConfigurationRepository.update(
      {
        key: narrowedKey,
        value: validatedValue,
        description:
          input.description === undefined
            ? before.description
            : input.description,
        expectedVersion: input.expectedVersion,
        updatedByUserId: input.actorUserId,
      },
      txClient,
    );
    if (!updateResult.updated || !updateResult.record) {
      throw new AppError({
        code: ERROR_CODES.VERSION_CONFLICT,
        message: `Platform configuration version conflict for "${input.key}".`,
        statusCode: 409,
      });
    }
    await recordOperationalEvent(
      {
        eventType: PLATFORM_CONFIGURATION_AUDIT_EVENT,
        entityType: PLATFORM_CONFIGURATION_ENTITY_TYPE,
        entityId: entityIdForKey(narrowedKey),
        actorUserId: input.actorUserId,
        summary: `Platform configuration changed: ${narrowedKey}`,
        metadata: {
          authority: input.authority,
          key: narrowedKey,
          before: { value: before.value, version: before.version },
          after: {
            value: updateResult.record.value,
            version: updateResult.record.version,
          },
          expectedVersion: input.expectedVersion,
          requestId: input.requestId ?? null,
        },
      },
      txClient,
    );
    return { before, after: updateResult.record };
  });
}

/**
 * Create a brand-new platform configuration row. The existing
 * `platform_configurations` UNIQUE(key) index defends against
 * duplicates.
 */
export async function createConfiguration(input: {
  actorUserId: string;
  authority: string;
  key: string;
  value: unknown;
  description?: string;
  requestId?: string;
}): Promise<PlatformConfigurationRecord> {
  if (!isKnownConfigurationKey(input.key)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'key',
        message: `${input.key} is not a frozen platform configuration key (§20.2).`,
      },
    ]);
  }
  const descriptor = getDescriptor(input.key);
  const validatedValue = assertValidPlatformConfigValue(
    input.key,
    descriptor.shape,
    input.value,
  );
  if (!input.actorUserId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId is mandatory.' },
    ]);
  }
  const narrowedKey: SaaSPlatformConfigurationKey = input.key;
  // PART 13B hardening: INSERT + audit commit atomically. Duplicate
  // POST (PG `23505`) is translated into 409 by the `withTransaction`
  // wrapper — the audit row is NEVER staged for a duplicate insert
  // because the INSERT throws and rolls back the whole transaction.
  try {
    return await withTransaction(async (txClient) => {
      const record = await platformConfigurationRepository.insert(
        {
          key: narrowedKey,
          value: validatedValue,
          description: input.description ?? null,
          updatedByUserId: input.actorUserId,
        },
        txClient,
      );
      await recordOperationalEvent(
        {
          eventType: PLATFORM_CONFIGURATION_AUDIT_EVENT,
          entityType: PLATFORM_CONFIGURATION_ENTITY_TYPE,
          entityId: entityIdForKey(narrowedKey),
          actorUserId: input.actorUserId,
          summary: `Platform configuration created: ${narrowedKey}`,
          metadata: {
            authority: input.authority,
            key: narrowedKey,
            before: null,
            after: { value: record.value, version: record.version },
            requestId: input.requestId ?? null,
          },
        },
        txClient,
      );
      return record;
    });
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        message: `Platform configuration key "${input.key}" already exists.`,
        statusCode: 409,
      });
    }
    throw err;
  }
}
