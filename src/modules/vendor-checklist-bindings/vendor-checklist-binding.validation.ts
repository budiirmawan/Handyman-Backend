import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { VendorChecklistBindingFilters } from './vendor-checklist-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseVendorChecklistBindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'bindingId',
        message: 'Vendor checklist binding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseVendorChecklistExecutionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'executionId',
        message: 'Vendor checklist execution id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

function readUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

/**
 * Parses the create body (`POST /vendor-checklist-bindings`). Both
 * `vendorWorkId` and `checklistTemplateId` are required.
 */
export function parseCreateVendorChecklistBindingBody(
  body: unknown,
): { vendorWorkId: string; checklistTemplateId: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const record = body as Record<string, unknown>;
  const details: ValidationDetail[] = [];

  const vendorWorkId = readUuid(
    record.vendorWorkId,
    'vendorWorkId',
    'Vendor work id',
    details,
  );
  const checklistTemplateId = readUuid(
    record.checklistTemplateId,
    'checklistTemplateId',
    'Checklist template id',
    details,
  );

  if (!vendorWorkId) {
    details.push({
      field: 'vendorWorkId',
      message: 'vendorWorkId is required and must be a valid UUID.',
    });
  }
  if (!checklistTemplateId) {
    details.push({
      field: 'checklistTemplateId',
      message: 'checklistTemplateId is required and must be a valid UUID.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    vendorWorkId: vendorWorkId as string,
    checklistTemplateId: checklistTemplateId as string,
  };
}

/**
 * Parses list filters (`GET /vendor-checklist-bindings?...`). At least one of
 * `vendorWorkId`, `vendorId`, or `buildingId` must be supplied.
 */
export function parseVendorChecklistBindingFilters(
  query: Record<string, unknown>,
): VendorChecklistBindingFilters {
  const details: ValidationDetail[] = [];

  const vendorWorkId = readUuid(
    query.vendorWorkId,
    'vendorWorkId',
    'Vendor work id',
    details,
  );
  const vendorId = readUuid(query.vendorId, 'vendorId', 'Vendor id', details);
  const buildingId = readUuid(
    query.buildingId,
    'buildingId',
    'Building id',
    details,
  );

  if (!vendorWorkId && !vendorId && !buildingId) {
    details.push({
      field: 'filter',
      message: 'Provide at least one of vendorWorkId, vendorId, or buildingId.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(vendorWorkId === undefined ? {} : { vendorWorkId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(buildingId === undefined ? {} : { buildingId }),
  };
}
