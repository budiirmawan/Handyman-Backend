import { assetNotFoundError, assetRepository } from '../assets';
import { recordAssetHistory } from '../asset-history';
import {
  assetIdentifierActiveTypeExistsError,
  assetIdentifierNotFoundError,
  assetIdentifierNotResolvableError,
  assetIdentifierValueAlreadyExistsError,
} from './asset-identifier.errors';
import { assetIdentifierRepository } from './asset-identifier.repository';
import type {
  AssetIdentifierRecord,
  AssetIdentifierStatus,
  AssetIdentifierType,
  CreateAssetIdentifierInput,
  PublicAssetIdentifier,
  ResolvedAssetIdentifier,
  UpdateAssetIdentifierInput,
  UpdateAssetIdentifierStatusInput,
} from './asset-identifier.types';
import { generateIdentifierValue } from './asset-identifier.validation';

/** How many times to retry if a generated value happens to collide. */
const GENERATE_ATTEMPTS = 5;

export function toPublicAssetIdentifier(
  record: AssetIdentifierRecord,
): PublicAssetIdentifier {
  return {
    id: record.id,
    assetId: record.assetId,
    identifierType: record.identifierType,
    identifierValue: record.identifierValue,
    status: record.status,
  };
}

/**
 * The Asset registry (BE-05A) is the single source of Client / Building
 * context; the Identifier duplicates neither. Building isolation itself is
 * enforced at the API layer against the returned `buildingId`.
 */
async function requireAsset(assetId: string) {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  return asset;
}

/**
 * Registers an identifier for an Asset.
 *
 * When `identifierValue` is omitted the backend mints an OPAQUE value — the
 * preferred path for QR labels, since a generated value cannot accidentally
 * embed Client, Building, or sequence information.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                       → 404 ASSET_NOT_FOUND
 *   2. value already used (any Asset,
 *      any status)                         → 409 ASSET_IDENTIFIER_VALUE_ALREADY_EXISTS
 *   3. a second ACTIVE of the same type    → 409 ASSET_IDENTIFIER_ACTIVE_TYPE_EXISTS
 *
 * Uniqueness deliberately spans INACTIVE rows too, so a retired label can
 * never be reissued and resolve to the wrong equipment.
 */
export async function createAssetIdentifier(
  input: CreateAssetIdentifierInput,
  actorUserId?: string | null,
): Promise<PublicAssetIdentifier> {
  await requireAsset(input.assetId);

  const status = input.status ?? 'ACTIVE';

  if (status === 'ACTIVE') {
    const activeOfType = await assetIdentifierRepository.findActiveByType(
      input.assetId,
      input.identifierType,
    );
    if (activeOfType) {
      throw assetIdentifierActiveTypeExistsError();
    }
  }

  if (input.identifierValue !== undefined) {
    const existing = await assetIdentifierRepository.findByValue(
      input.identifierValue,
    );
    if (existing) {
      throw assetIdentifierValueAlreadyExistsError();
    }

    try {
      const record = await assetIdentifierRepository.createIdentifier({
        assetId: input.assetId,
        identifierType: input.identifierType,
        identifierValue: input.identifierValue,
        status,
      });
      await recordIdentifierCreated(record, actorUserId);
      return toPublicAssetIdentifier(record);
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  // Generated path: retry on the (vanishingly unlikely) value collision.
  for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt += 1) {
    try {
      const record = await assetIdentifierRepository.createIdentifier({
        assetId: input.assetId,
        identifierType: input.identifierType,
        identifierValue: generateIdentifierValue(),
        status,
      });
      await recordIdentifierCreated(record, actorUserId);
      return toPublicAssetIdentifier(record);
    } catch (error) {
      if (isValueUniqueViolation(error)) {
        continue;
      }
      throw translateUniqueViolation(error);
    }
  }

  throw assetIdentifierValueAlreadyExistsError();
}

async function recordIdentifierCreated(
  record: AssetIdentifierRecord,
  actorUserId?: string | null,
): Promise<void> {
  await recordAssetHistory({
    assetId: record.assetId,
    eventType: 'IDENTIFIER_CREATED',
    actorUserId,
    summary: `${record.identifierType} identifier ${record.identifierValue} issued`,
    metadata: {
      identifierId: record.id,
      identifierType: record.identifierType,
      identifierValue: record.identifierValue,
      status: record.status,
    },
  });
}

/** All identifiers registered for an Asset, including retired labels. */
export async function listAssetIdentifiers(
  assetId: string,
  filters?: {
    status?: AssetIdentifierStatus;
    identifierType?: AssetIdentifierType;
  },
): Promise<PublicAssetIdentifier[]> {
  await requireAsset(assetId);

  const records = await assetIdentifierRepository.listByAssetId(
    assetId,
    filters,
  );
  return records.map(toPublicAssetIdentifier);
}

export async function getAssetIdentifierById(
  assetId: string,
  identifierId: string,
): Promise<PublicAssetIdentifier> {
  await requireAsset(assetId);

  const record = await assetIdentifierRepository.findById(identifierId);
  // An identifier of another Asset must not be reachable through this one.
  if (!record || record.assetId !== assetId) {
    throw assetIdentifierNotFoundError();
  }

  return toPublicAssetIdentifier(record);
}

/**
 * BE-05H — resolves a scanned / typed identifier value to its Asset.
 *
 * Only an ACTIVE identifier resolves: a retired label is treated exactly
 * like an unknown value (same 404, same message), so probing cannot reveal
 * which identifiers once existed.
 *
 * Returns the SAFE, MINIMAL Asset context only. Building isolation is
 * enforced by the caller (the controller) against the returned
 * `asset.buildingId` — resolution never bypasses BE-02.
 */
export async function resolveAssetByIdentifier(
  identifierValue: string,
): Promise<ResolvedAssetIdentifier> {
  const identifier = await assetIdentifierRepository.findActiveByValue(
    identifierValue,
  );
  if (!identifier) {
    throw assetIdentifierNotResolvableError();
  }

  const asset = await assetRepository.findById(identifier.assetId);
  if (!asset) {
    // FK guarantees the Asset exists; a miss is a data-integrity fault.
    throw assetNotFoundError();
  }

  return {
    identifier: {
      id: identifier.id,
      identifierType: identifier.identifierType,
      identifierValue: identifier.identifierValue,
    },
    asset: {
      id: asset.id,
      buildingId: asset.buildingId,
      assetCode: asset.assetCode,
      assetName: asset.assetName,
      status: asset.status,
      functionalLocationId: asset.functionalLocationId,
    },
  };
}

/**
 * Retires or reinstates an identifier.
 *
 * The value and owning Asset are immutable — a printed label cannot be
 * re-pointed or rewritten. Retiring is not a delete: the row stays, keeping
 * its value reserved forever.
 */
export async function updateAssetIdentifier(
  assetId: string,
  identifierId: string,
  input: UpdateAssetIdentifierInput,
  actorUserId?: string | null,
): Promise<PublicAssetIdentifier> {
  await requireAsset(assetId);

  const existing = await assetIdentifierRepository.findById(identifierId);
  if (!existing || existing.assetId !== assetId) {
    throw assetIdentifierNotFoundError();
  }

  if (input.status === undefined || input.status === existing.status) {
    return toPublicAssetIdentifier(existing);
  }

  // Reinstating must not create a second active label of the same type.
  if (input.status === 'ACTIVE') {
    const activeOfType = await assetIdentifierRepository.findActiveByType(
      assetId,
      existing.identifierType,
    );
    if (activeOfType && activeOfType.id !== identifierId) {
      throw assetIdentifierActiveTypeExistsError();
    }
  }

  try {
    const record = await assetIdentifierRepository.updateStatus(
      identifierId,
      input.status,
    );

    await recordAssetHistory({
      assetId,
      eventType: 'IDENTIFIER_UPDATED',
      actorUserId,
      summary:
        input.status === 'INACTIVE'
          ? `${existing.identifierType} identifier ${existing.identifierValue} retired`
          : `${existing.identifierType} identifier ${existing.identifierValue} reinstated`,
      metadata: {
        identifierId,
        identifierType: existing.identifierType,
        identifierValue: existing.identifierValue,
        from: existing.status,
        to: input.status,
      },
    });

    return toPublicAssetIdentifier(record as AssetIdentifierRecord);
  } catch (error) {
    throw translateUniqueViolation(error);
  }
}

export async function updateAssetIdentifierStatus(
  assetId: string,
  identifierId: string,
  input: UpdateAssetIdentifierStatusInput,
  actorUserId?: string | null,
): Promise<PublicAssetIdentifier> {
  return updateAssetIdentifier(
    assetId,
    identifierId,
    { status: input.status },
    actorUserId,
  );
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function isValueUniqueViolation(error: unknown): boolean {
  return isUniqueViolation(error, 'asset_identifiers_value_unique');
}

function translateUniqueViolation(error: unknown): unknown {
  if (isValueUniqueViolation(error)) {
    return assetIdentifierValueAlreadyExistsError();
  }
  if (isUniqueViolation(error, 'asset_identifiers_one_active_per_type')) {
    return assetIdentifierActiveTypeExistsError();
  }
  return error;
}

export const assetIdentifierService = {
  createAssetIdentifier,
  getAssetIdentifierById,
  listAssetIdentifiers,
  resolveAssetByIdentifier,
  toPublicAssetIdentifier,
  updateAssetIdentifier,
  updateAssetIdentifierStatus,
};
