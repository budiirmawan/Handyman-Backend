import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PERMIT_CONTRACTOR_CONTEXT_TYPES,
  isPermitContractorContextType,
  type PermitContractorContextType,
} from '../permits/permit.types';
import type {
  ContractorContextFilters,
  ResolveContractorContextInput,
} from './contractor-context.types';

type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseResolveContractorContextBody(
  body: unknown,
): ResolveContractorContextInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const contractorContextType = readContextType(
    body.contractorContextType,
    'contractorContextType',
    true,
    details,
  );
  const contractorContextId = readId(
    body.contractorContextId,
    'contractorContextId',
    true,
    details,
  );
  const buildingId = readId(body.buildingId, 'buildingId', false, details);
  if (
    contractorContextType === 'VENDOR_CONTRACTOR' &&
    buildingId === undefined
  ) {
    details.push({
      field: 'buildingId',
      message: 'buildingId is required for VENDOR_CONTRACTOR.',
    });
  }
  if (!contractorContextType || !contractorContextId || details.length > 0) {
    fail(details);
  }
  return {
    contractorContextType,
    contractorContextId,
    ...(buildingId ? { buildingId } : {}),
  };
}

export function parseContractorContextReference(
  rawType: string,
  rawId: string,
  query: unknown,
): ResolveContractorContextInput {
  const details: ValidationDetail[] = [];
  const contractorContextType = readContextType(
    rawType,
    'contractorContextType',
    true,
    details,
  );
  const contractorContextId = readId(
    rawId,
    'contractorContextId',
    true,
    details,
  );
  const buildingId = isRecord(query)
    ? readId(query.buildingId, 'buildingId', false, details)
    : undefined;
  if (
    contractorContextType === 'VENDOR_CONTRACTOR' &&
    buildingId === undefined
  ) {
    details.push({
      field: 'buildingId',
      message: 'buildingId is required for VENDOR_CONTRACTOR.',
    });
  }
  if (!contractorContextType || !contractorContextId || details.length > 0) {
    fail(details);
  }
  return {
    contractorContextType,
    contractorContextId,
    ...(buildingId ? { buildingId } : {}),
  };
}

export function parseContractorContextFilters(
  query: unknown,
): ContractorContextFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const sourceValues = [
    ['contractorContextType', query.contractorContextType],
    ['sourceType', query.sourceType],
    ['source', query.source],
  ].filter((entry) => entry[1] !== undefined) as [string, unknown][];
  const parsedSources = sourceValues.map(([field, value]) =>
    readContextType(value, field, false, details));
  const contractorContextType = parsedSources[0];
  if (
    contractorContextType &&
    parsedSources.some((source) => source && source !== contractorContextType)
  ) {
    details.push({
      field: 'contractorContextType',
      message: 'Contractor source filters must identify the same source.',
    });
  }

  const tenantCompanyId = readId(
    query.tenantCompanyId,
    'tenantCompanyId',
    false,
    details,
  );
  const vendorId = readId(query.vendorId, 'vendorId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  if (
    contractorContextType === 'VENDOR_CONTRACTOR' &&
    tenantCompanyId !== undefined
  ) {
    details.push({
      field: 'tenantCompanyId',
      message: 'tenantCompanyId applies only to TENANT_CONTRACTOR.',
    });
  }
  if (details.length > 0) fail(details);
  return {
    ...(contractorContextType ? { contractorContextType } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(vendorId ? { vendorId } : {}),
    ...(buildingId ? { buildingId } : {}),
  };
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readContextType(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): PermitContractorContextType | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitContractorContextType(normalized)) {
    details.push({
      field,
      message: `${field} must be one of: ${PERMIT_CONTRACTOR_CONTEXT_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}
