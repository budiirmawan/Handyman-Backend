/**
 * CR-BE-SAAS-01 PART 12B — Platform configuration HTTP controllers
 * (frozen §22).
 *
 * Controllers perform:
 *   - request validation (body + path `:key`);
 *   - authenticated-actor binding (`req.auth.userId`);
 *   - delegation to the PART 12A domain service (no rule recoding);
 *   - canonical projection shaping for the response.
 *
 * Controllers do NOT:
 *   - accept `actorUserId` / `key` from the body (path is authoritative);
 *   - re-implement business rules (shape, OCC, audit);
 *   - mutate state on GET reads;
 *   - audit reads.
 *
 * Routes are mounted by `createPlatformConfigurationRouter`.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { getRequestId } from '../../shared/request-context';
import {
  createConfiguration,
  getConfiguration,
  isKnownConfigurationKey,
  listAllConfigurations,
  resolveConfiguration,
  updateConfiguration,
  validateValue,
} from './platform-configuration.service';
import {
  SAAS_PLATFORM_CONFIGURATION_KEYS,
  type PlatformConfigurationRecord,
  type SaaSPlatformConfigurationKey,
} from './platform-configuration.types';
import {
  parseCreateConfigurationBody,
  parseUpdateConfigurationBody,
} from './platform-configuration.body-validation';

const READ_AUTHORITY = 'platform.customer.read';
const MUTATION_AUTHORITY = 'platform.configuration.manage';

export interface PlatformConfigurationPublic {
  key: SaaSPlatformConfigurationKey;
  scope: 'PLATFORM';
  source: 'configured' | 'frozen_default';
  value: unknown;
  version: number | null;
  description: string | null;
  updatedByUserId: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

function toPublic(
  key: SaaSPlatformConfigurationKey,
  record: PlatformConfigurationRecord | null,
  resolved: { source: 'configured' | 'frozen_default'; value: unknown },
): PlatformConfigurationPublic {
  return {
    key,
    scope: 'PLATFORM',
    source: resolved.source,
    value: resolved.value,
    version: record?.version ?? null,
    description: record?.description ?? null,
    updatedByUserId: record?.updatedByUserId ?? null,
    updatedAt: record?.updatedAt ?? null,
    createdAt: record?.createdAt ?? null,
  };
}

async function listPublic(): Promise<PlatformConfigurationPublic[]> {
  const rows = await listAllConfigurations();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: PlatformConfigurationPublic[] = [];
  for (const key of SAAS_PLATFORM_CONFIGURATION_KEYS) {
    const record = byKey.get(key) ?? null;
    const resolved = await resolveConfiguration(key);
    out.push(toPublic(key, record, resolved));
  }
  return out;
}

export async function listPlatformConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const items = await listPublic();
    sendSuccess(res, { items });
  } catch (error) {
    next(error);
  }
}

export async function getPlatformConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawKey = req.params['key'];
    if (typeof rawKey !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'key', message: 'key is required.' },
      ]);
    }
    if (!isKnownConfigurationKey(rawKey)) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'key',
          message: `${rawKey} is not a frozen platform configuration key (§20.2).`,
        },
      ]);
    }
    const key = rawKey as SaaSPlatformConfigurationKey;
    const record = await getConfiguration(key);
    const resolved = await resolveConfiguration(key);
    const publicItem = toPublic(key, record, resolved);
    sendSuccess(res, publicItem);
  } catch (error) {
    next(error);
  }
}

export async function createPlatformConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawKey = req.params['key'];
    if (typeof rawKey !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'key', message: 'key is required.' },
      ]);
    }
    const { key, body } = parseCreateConfigurationBody(req.body, rawKey);
    // Validate the value against the frozen catalogue shape. Throws
    // AppError.validation(400) on mismatch.
    validateValue(key, body.value);
    const userId = req.auth.userId;
    const record = await createConfiguration({
      actorUserId: userId,
      authority: MUTATION_AUTHORITY,
      key,
      value: body.value,
      ...(body.description !== undefined ? { description: body.description } : {}),
      requestId: getRequestId(),
    });
    sendSuccess(res, {
      key: record.key,
      value: record.value,
      version: record.version,
      description: record.description,
      updatedByUserId: record.updatedByUserId,
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
    });
  } catch (error) {
    next(error);
  }
}

export async function updatePlatformConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawKey = req.params['key'];
    if (typeof rawKey !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'key', message: 'key is required.' },
      ]);
    }
    const { key, body } = parseUpdateConfigurationBody(req.body, rawKey);
    // Validate the value against the frozen catalogue shape. Throws
    // AppError.validation(400) on mismatch.
    validateValue(key, body.value);
    const userId = req.auth.userId;
    const updated = await updateConfiguration({
      actorUserId: userId,
      authority: MUTATION_AUTHORITY,
      key,
      expectedVersion: body.expectedVersion,
      value: body.value,
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
      requestId: getRequestId(),
    });
    sendSuccess(res, {
      key: updated.after.key,
      value: updated.after.value,
      version: updated.after.version,
      description: updated.after.description,
      updatedByUserId: updated.after.updatedByUserId,
      updatedAt: updated.after.updatedAt,
      createdAt: updated.after.createdAt,
      before: updated.before
        ? {
            value: updated.before.value,
            version: updated.before.version,
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
}
