import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parseOptionalHandymanRequestedWindow } from '../handyman-scheduling/handyman-scheduling.service';
import {
  HANDYMAN_UNLISTED_INTAKE_MAX_DESCRIPTION_LENGTH,
  HANDYMAN_UNLISTED_INTAKE_MAX_IDEMPOTENCY_KEY_LENGTH,
  HANDYMAN_UNLISTED_INTAKE_MAX_SERVICE_NAME_LENGTH,
  HANDYMAN_UNLISTED_INTAKE_STATUSES,
  type HandymanUnlistedIntakeStatus,
} from './handyman-unlisted-intake.types';

const ALLOWED_CREATE_BODY_KEYS = new Set([
  'exchangeToken',
  'propertyId',
  'buildingId',
  'tenantCompanyId',
  'tenantPicId',
  'spaceId',
  'unitId',
  'approvalTenantCompanyId',
  'costResponsibleTenantCompanyId',
  'requestedServiceName',
  'serviceName',
  'unlistedServiceName',
  'description',
  'complaint',
  'customerComplaint',
  'preferredWindowStart',
  'preferredWindowEnd',
  'idempotencyKey',
  'internalNote',
  'serviceCatalogId',
  'serviceVariantId',
]);

const FORBIDDEN_CREATE_OVERRIDE_KEYS = new Set([
  'id',
  'clientId',
  'status',
  'createdByUserId',
  'createdByCareActorId',
  'careActorId',
  'actorUserId',
  'originChannel',
  'originReference',
  'channelAttributionId',
  'createdAt',
  'updatedAt',
  'timezone',
  'preferredWindowTimezone',
  'items',
]);

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

export function parseUnlistedIntakeUuidParam(
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

function parseOptionalUuidField(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

function resolveAliasedString(
  record: Record<string, unknown>,
  primaryKey: string,
  aliases: readonly string[],
): unknown {
  let resolved: unknown = record[primaryKey];
  for (const alias of aliases) {
    if (record[alias] !== undefined) {
      if (resolved !== undefined && resolved !== record[alias]) {
        throw AppError.validation('Unlisted service intake validation failed.', [
          {
            field: alias,
            message: `${primaryKey} and ${alias} must match when both are provided.`,
          },
        ]);
      }
      resolved = record[alias];
    }
  }
  return resolved;
}

function assertNoCatalogSelection(record: Record<string, unknown>): void {
  if (
    record.serviceCatalogId !== undefined &&
    record.serviceCatalogId !== null
  ) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'serviceCatalogId',
        message:
          'serviceCatalogId must not be supplied for unlisted service intake cases.',
      },
    ]);
  }
  if (
    record.serviceVariantId !== undefined &&
    record.serviceVariantId !== null
  ) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'serviceVariantId',
        message:
          'serviceVariantId must not be supplied for unlisted service intake cases.',
      },
    ]);
  }
}

function assertAllowedBodyKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CREATE_OVERRIDE_KEYS.has(key)) {
      throw AppError.validation('Unlisted service intake validation failed.', [
        {
          field: key,
          message: `Field "${key}" is server-derived or not permitted on unlisted service intake creation.`,
        },
      ]);
    }
    if (!ALLOWED_CREATE_BODY_KEYS.has(key)) {
      throw AppError.validation('Unlisted service intake validation failed.', [
        {
          field: key,
          message: `Field "${key}" is not supported.`,
        },
      ]);
    }
  }
  assertNoCatalogSelection(record);
}

function parseRequestedServiceName(record: Record<string, unknown>): string {
  const raw = resolveAliasedString(record, 'requestedServiceName', [
    'serviceName',
    'unlistedServiceName',
  ]);
  if (typeof raw !== 'string') {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'requestedServiceName',
        message: 'requestedServiceName is required and must be a string.',
      },
    ]);
  }
  if (raw.includes('\u0000')) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'requestedServiceName',
        message: 'requestedServiceName must not contain NUL characters.',
      },
    ]);
  }
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (
    normalized.length < 1 ||
    normalized.length > HANDYMAN_UNLISTED_INTAKE_MAX_SERVICE_NAME_LENGTH
  ) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'requestedServiceName',
        message: `requestedServiceName must be between 1 and ${HANDYMAN_UNLISTED_INTAKE_MAX_SERVICE_NAME_LENGTH} characters.`,
      },
    ]);
  }
  return normalized;
}

function parseComplaintDescription(record: Record<string, unknown>): string {
  const raw = resolveAliasedString(record, 'description', [
    'complaint',
    'customerComplaint',
  ]);
  if (typeof raw !== 'string') {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'description',
        message: 'description (customer complaint) is required and must be a string.',
      },
    ]);
  }
  if (raw.includes('\u0000')) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'description',
        message: 'description must not contain NUL characters.',
      },
    ]);
  }
  const normalized = normalizeText(raw);
  if (
    normalized.length < 1 ||
    normalized.length > HANDYMAN_UNLISTED_INTAKE_MAX_DESCRIPTION_LENGTH
  ) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'description',
        message: `description must be between 1 and ${HANDYMAN_UNLISTED_INTAKE_MAX_DESCRIPTION_LENGTH} characters.`,
      },
    ]);
  }
  return normalized;
}

function parseIdempotencyKey(
  record: Record<string, unknown>,
  headerIdempotencyKey?: string,
  fallbackExchangeToken?: string,
): string {
  const bodyKey = record.idempotencyKey;
  if (
    bodyKey !== undefined &&
    headerIdempotencyKey !== undefined &&
    typeof bodyKey === 'string' &&
    bodyKey.trim() !== headerIdempotencyKey.trim()
  ) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'idempotencyKey',
        message:
          'idempotencyKey in request body must match Idempotency-Key header when both are provided.',
      },
    ]);
  }
  const rawKey = bodyKey !== undefined ? bodyKey : headerIdempotencyKey;
  if (rawKey === undefined && fallbackExchangeToken) {
    const hash = createHash('sha256')
      .update(fallbackExchangeToken)
      .digest('hex')
      .slice(0, 48);
    return `care-exchange:${hash}`;
  }
  if (typeof rawKey !== 'string') {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'idempotencyKey is required and must be a non-empty string.',
      },
    ]);
  }
  const normalized = rawKey.trim();
  if (
    normalized.length < 1 ||
    normalized.length > HANDYMAN_UNLISTED_INTAKE_MAX_IDEMPOTENCY_KEY_LENGTH ||
    normalized.includes('\u0000')
  ) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'idempotencyKey',
        message: `idempotencyKey must be between 1 and ${HANDYMAN_UNLISTED_INTAKE_MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      },
    ]);
  }
  return normalized;
}

function parseSpaceOrUnitId(record: Record<string, unknown>): string | null {
  const spaceId = parseOptionalUuidField(record.spaceId, 'spaceId');
  const unitId = parseOptionalUuidField(record.unitId, 'unitId');
  if (
    spaceId !== undefined &&
    unitId !== undefined &&
    spaceId !== unitId
  ) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'unitId',
        message: 'spaceId and unitId must match when both are provided.',
      },
    ]);
  }
  return spaceId ?? unitId ?? null;
}

export type ParsedBuildingCareUnlistedIntakeInput = {
  buildingId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  spaceId: string | null;
  approvalTenantCompanyId?: string;
  costResponsibleTenantCompanyId?: string;
  requestedServiceName: string;
  description: string;
  preferredWindowStart?: string;
  preferredWindowEnd?: string;
  idempotencyKey: string;
  rawInternalNote?: unknown;
};

export function parseCreateBuildingCareUnlistedIntakeBody(
  body: unknown,
  buildingIdFromPath: string,
  headerIdempotencyKey?: string,
): ParsedBuildingCareUnlistedIntakeInput {
  const buildingId = parseUnlistedIntakeUuidParam(
    buildingIdFromPath,
    'buildingId',
  );
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const record = body as Record<string, unknown>;
  assertAllowedBodyKeys(record);

  if (record.exchangeToken !== undefined) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: 'exchangeToken',
        message: 'exchangeToken is not accepted on building-scoped Care routes.',
      },
    ]);
  }

  if (record.buildingId !== undefined) {
    const bodyBuildingId = parseUnlistedIntakeUuidParam(
      record.buildingId,
      'buildingId',
    );
    if (bodyBuildingId !== buildingId) {
      throw AppError.validation('Unlisted service intake validation failed.', [
        {
          field: 'buildingId',
          message: 'buildingId in body must match path buildingId.',
        },
      ]);
    }
  }

  const tenantCompanyId = parseUnlistedIntakeUuidParam(
    record.tenantCompanyId,
    'tenantCompanyId',
  );
  const tenantPicId =
    parseOptionalUuidField(record.tenantPicId, 'tenantPicId') ?? null;
  const spaceId = parseSpaceOrUnitId(record);
  const approvalTenantCompanyId =
    parseOptionalUuidField(
      record.approvalTenantCompanyId,
      'approvalTenantCompanyId',
    ) ?? undefined;
  const costResponsibleTenantCompanyId =
    parseOptionalUuidField(
      record.costResponsibleTenantCompanyId,
      'costResponsibleTenantCompanyId',
    ) ?? undefined;

  const requestedServiceName = parseRequestedServiceName(record);
  const description = parseComplaintDescription(record);
  const dates = parseOptionalHandymanRequestedWindow(
    record.preferredWindowStart,
    record.preferredWindowEnd,
  );
  const idempotencyKey = parseIdempotencyKey(record, headerIdempotencyKey);

  return {
    buildingId,
    tenantCompanyId,
    tenantPicId,
    spaceId,
    ...(approvalTenantCompanyId ? { approvalTenantCompanyId } : {}),
    ...(costResponsibleTenantCompanyId
      ? { costResponsibleTenantCompanyId }
      : {}),
    requestedServiceName,
    description,
    ...(dates ?? {}),
    idempotencyKey,
    ...(record.internalNote !== undefined && record.internalNote !== null
      ? { rawInternalNote: record.internalNote }
      : {}),
  };
}

export type ParsedCareWorkspaceUnlistedIntakeInput = {
  exchangeToken?: string;
  propertyId?: string;
  buildingId?: string;
  tenantCompanyId?: string;
  tenantPicId: string | null;
  spaceId: string | null;
  approvalTenantCompanyId?: string;
  costResponsibleTenantCompanyId?: string;
  requestedServiceName: string;
  description: string;
  preferredWindowStart?: string;
  preferredWindowEnd?: string;
  idempotencyKey: string;
  rawInternalNote?: unknown;
};

export function parseCreateCareWorkspaceUnlistedIntakeBody(
  body: unknown,
  headerIdempotencyKey?: string,
): ParsedCareWorkspaceUnlistedIntakeInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const record = body as Record<string, unknown>;
  assertAllowedBodyKeys(record);

  let exchangeToken: string | undefined;
  if (record.exchangeToken !== undefined && record.exchangeToken !== null) {
    if (
      typeof record.exchangeToken !== 'string' ||
      record.exchangeToken.trim().length < 1 ||
      record.exchangeToken.trim().length > 512
    ) {
      throw AppError.validation('Unlisted service intake validation failed.', [
        {
          field: 'exchangeToken',
          message: 'exchangeToken must be a non-empty string up to 512 chars.',
        },
      ]);
    }
    exchangeToken = record.exchangeToken.trim();
  }

  const propertyId =
    parseOptionalUuidField(record.propertyId, 'propertyId') ?? undefined;
  const buildingId =
    parseOptionalUuidField(record.buildingId, 'buildingId') ?? undefined;
  const tenantCompanyId =
    parseOptionalUuidField(record.tenantCompanyId, 'tenantCompanyId') ??
    undefined;

  if (!exchangeToken && (!buildingId || !tenantCompanyId)) {
    throw AppError.validation('Unlisted service intake validation failed.', [
      {
        field: !buildingId ? 'buildingId' : 'tenantCompanyId',
        message:
          'Either exchangeToken or both buildingId and tenantCompanyId are required.',
      },
    ]);
  }

  const tenantPicId =
    parseOptionalUuidField(record.tenantPicId, 'tenantPicId') ?? null;
  const spaceId = parseSpaceOrUnitId(record);
  const approvalTenantCompanyId =
    parseOptionalUuidField(
      record.approvalTenantCompanyId,
      'approvalTenantCompanyId',
    ) ?? undefined;
  const costResponsibleTenantCompanyId =
    parseOptionalUuidField(
      record.costResponsibleTenantCompanyId,
      'costResponsibleTenantCompanyId',
    ) ?? undefined;

  const requestedServiceName = parseRequestedServiceName(record);
  const description = parseComplaintDescription(record);
  const dates = parseOptionalHandymanRequestedWindow(
    record.preferredWindowStart,
    record.preferredWindowEnd,
  );
  const idempotencyKey = parseIdempotencyKey(
    record,
    headerIdempotencyKey,
    exchangeToken,
  );

  return {
    ...(exchangeToken ? { exchangeToken } : {}),
    ...(propertyId ? { propertyId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    tenantPicId,
    spaceId,
    ...(approvalTenantCompanyId ? { approvalTenantCompanyId } : {}),
    ...(costResponsibleTenantCompanyId
      ? { costResponsibleTenantCompanyId }
      : {}),
    requestedServiceName,
    description,
    ...(dates ?? {}),
    idempotencyKey,
    ...(record.internalNote !== undefined && record.internalNote !== null
      ? { rawInternalNote: record.internalNote }
      : {}),
  };
}

export type ParsedUnlistedIntakeListQuery = {
  clientId?: string;
  propertyId?: string;
  buildingId?: string;
  tenantCompanyId?: string;
  spaceId?: string;
  status?: HandymanUnlistedIntakeStatus;
  limit: number;
  offset: number;
};

export function parseUnlistedIntakeListQuery(
  query: unknown,
): ParsedUnlistedIntakeListQuery {
  if (query === undefined || query === null) {
    return { limit: 50, offset: 0 };
  }
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw AppError.validation('Request query validation failed.');
  }
  const q = query as Record<string, unknown>;
  const allowed = new Set([
    'clientId',
    'propertyId',
    'buildingId',
    'tenantCompanyId',
    'spaceId',
    'unitId',
    'status',
    'limit',
    'offset',
    'page',
  ]);
  for (const key of Object.keys(q)) {
    if (!allowed.has(key)) {
      throw AppError.validation('Request query validation failed.', [
        { field: key, message: `Unsupported query parameter "${key}".` },
      ]);
    }
  }

  const readOptUuid = (field: string): string | undefined => {
    const val = q[field];
    if (val === undefined || val === '') return undefined;
    if (typeof val !== 'string' || !isValidUuid(val)) {
      throw AppError.validation('Request query validation failed.', [
        { field, message: `${field} must be a valid UUID.` },
      ]);
    }
    return val.toLowerCase();
  };

  let status: HandymanUnlistedIntakeStatus | undefined;
  if (q.status !== undefined && q.status !== '') {
    if (
      typeof q.status !== 'string' ||
      !(HANDYMAN_UNLISTED_INTAKE_STATUSES as readonly string[]).includes(
        q.status,
      )
    ) {
      throw AppError.validation('Request query validation failed.', [
        {
          field: 'status',
          message: `status must be one of: ${HANDYMAN_UNLISTED_INTAKE_STATUSES.join(', ')}.`,
        },
      ]);
    }
    status = q.status as HandymanUnlistedIntakeStatus;
  }

  let limit = 50;
  if (q.limit !== undefined && q.limit !== '') {
    const parsedLimit = Number(q.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw AppError.validation('Request query validation failed.', [
        { field: 'limit', message: 'limit must be an integer between 1 and 100.' },
      ]);
    }
    limit = parsedLimit;
  }

  let offset = 0;
  if (q.offset !== undefined && q.offset !== '') {
    const parsedOffset = Number(q.offset);
    if (
      !Number.isInteger(parsedOffset) ||
      parsedOffset < 0 ||
      parsedOffset > 10000
    ) {
      throw AppError.validation('Request query validation failed.', [
        {
          field: 'offset',
          message: 'offset must be an integer between 0 and 10000.',
        },
      ]);
    }
    offset = parsedOffset;
  } else if (q.page !== undefined && q.page !== '') {
    const parsedPage = Number(q.page);
    if (!Number.isInteger(parsedPage) || parsedPage < 1 || parsedPage > 1000) {
      throw AppError.validation('Request query validation failed.', [
        { field: 'page', message: 'page must be an integer between 1 and 1000.' },
      ]);
    }
    offset = (parsedPage - 1) * limit;
  }

  const spaceId = readOptUuid('spaceId') ?? readOptUuid('unitId');

  return {
    clientId: readOptUuid('clientId'),
    propertyId: readOptUuid('propertyId'),
    buildingId: readOptUuid('buildingId'),
    tenantCompanyId: readOptUuid('tenantCompanyId'),
    spaceId,
    ...(status ? { status } : {}),
    limit,
    offset,
  };
}
