/**
 * CR-BE-SAAS-01 PART 09 — Usage & metering AppError factories.
 *
 * Frozen §17.1 codes: SAAS_USAGE_METER_NOT_FOUND (404),
 * SAAS_USAGE_RECORD_DUPLICATE (409).
 */
import { AppError, ERROR_CODES } from '../../shared/errors';

export function saasUsageMeterNotFoundError(meterKey: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_USAGE_METER_NOT_FOUND,
    message: `SaaS usage meter not found: ${meterKey}.`,
    statusCode: 404,
    resource: { type: 'SAAS_USAGE_METER', id: meterKey },
  });
}

export function saasUsageRecordDuplicateError(
  customerId: string,
  meterKey: string,
  sourceReference: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_USAGE_RECORD_DUPLICATE,
    message:
      'SaaS usage record duplicate: a record with the same identity already exists.',
    statusCode: 409,
    resource: { type: 'SAAS_USAGE_RECORD', id: `${customerId}/${meterKey}` },
    conflict: { customerId, meterKey, sourceReference },
  });
}
