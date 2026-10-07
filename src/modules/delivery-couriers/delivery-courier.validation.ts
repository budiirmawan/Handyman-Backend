import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  DELIVERY_COURIER_STATUSES,
  DELIVERY_COURIER_TYPES,
  isDeliveryCourierStatus,
  isDeliveryCourierType,
  type CreateDeliveryCourierInput,
  type DeliveryCourierListFilters,
  type DeliveryCourierStatus,
  type DeliveryCourierType,
  type UpdateDeliveryCourierStatusInput,
} from './delivery-courier.types';

export type ValidationDetail = { field: string; message: string };

const MAX_NAME_LENGTH = 255;
const MAX_REFERENCE_LENGTH = 255;
const MAX_NOTES_LENGTH = 4096;
const MAX_SEARCH_LENGTH = 255;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDeliveryCourierIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Delivery / Courier id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateDeliveryCourierBody(
  body: unknown,
): Omit<CreateDeliveryCourierInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const buildingId = readOptionalUuid(body.buildingId, 'buildingId', details);
  const visitorId = readOptionalNullableUuid(
    body.visitorId,
    'visitorId',
    details,
  );
  const expectedVisitorId = readOptionalUuid(
    body.expectedVisitorId,
    'expectedVisitorId',
    details,
  );
  const walkInVisitId = readOptionalUuid(
    body.walkInVisitId,
    'walkInVisitId',
    details,
  );
  const deliveryType = readDeliveryType(body.deliveryType, details);
  const courierCompany = readOptionalText(
    body.courierCompany,
    'courierCompany',
    MAX_NAME_LENGTH,
    details,
  );
  const courierName = readOptionalText(
    body.courierName,
    'courierName',
    MAX_NAME_LENGTH,
    details,
  );
  const recipientUserId = readOptionalNullableUuid(
    body.recipientUserId,
    'recipientUserId',
    details,
  );
  const recipientWorkforceId = readOptionalNullableUuid(
    body.recipientWorkforceId,
    'recipientWorkforceId',
    details,
  );
  const recipientName = readOptionalText(
    body.recipientName,
    'recipientName',
    MAX_NAME_LENGTH,
    details,
  );
  const arrivedAt = readOptionalDate(body.arrivedAt, 'arrivedAt', details);
  const referenceNumber = readOptionalText(
    body.referenceNumber,
    'referenceNumber',
    MAX_REFERENCE_LENGTH,
    details,
  );
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!deliveryType || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    deliveryType,
    ...(courierCompany === undefined ? {} : { courierCompany }),
    ...(courierName === undefined ? {} : { courierName }),
    ...(recipientUserId === undefined ? {} : { recipientUserId }),
    ...(recipientWorkforceId === undefined ? {} : { recipientWorkforceId }),
    ...(recipientName === undefined ? {} : { recipientName }),
    ...(arrivedAt === undefined ? {} : { arrivedAt }),
    ...(referenceNumber === undefined ? {} : { referenceNumber }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateDeliveryCourierStatusBody(
  body: unknown,
): Omit<UpdateDeliveryCourierStatusInput, 'statusUpdatedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const status = readStatus(body.status, details);
  const referenceNumber = readOptionalText(
    body.referenceNumber,
    'referenceNumber',
    MAX_REFERENCE_LENGTH,
    details,
  );
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!status) {
    details.push({ field: 'status', message: 'A terminal status is required.' });
  } else if (status === 'ARRIVED') {
    details.push({
      field: 'status',
      message: 'status must be one of: RECEIVED, REJECTED, CANCELLED.',
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    status: status as Exclude<DeliveryCourierStatus, 'ARRIVED'>,
    ...(referenceNumber === undefined ? {} : { referenceNumber }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseDeliveryCourierListQuery(
  query: Record<string, unknown>,
): DeliveryCourierListFilters {
  const details: ValidationDetail[] = [];
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const visitorId = readOptionalUuid(query.visitorId, 'visitorId', details);
  const expectedVisitorId = readOptionalUuid(
    query.expectedVisitorId,
    'expectedVisitorId',
    details,
  );
  const walkInVisitId = readOptionalUuid(
    query.walkInVisitId,
    'walkInVisitId',
    details,
  );
  const deliveryType = readOptionalDeliveryType(
    readSingle(query.deliveryType),
    details,
  );
  const status = readStatus(readSingle(query.status), details);
  const search = readOptionalSearch(query.search, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    ...(deliveryType === undefined ? {} : { deliveryType }),
    ...(status === undefined ? {} : { status }),
    ...(search === undefined ? {} : { search }),
  };
}

function readSingle(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingle(value);
  if (single === undefined || single === null || single === '') return undefined;
  if (typeof single !== 'string' || !isValidUuid(single.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return single.trim().toLowerCase();
}

function readOptionalNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed.toISOString();
}

function readDeliveryType(
  value: unknown,
  details: ValidationDetail[],
): DeliveryCourierType | undefined {
  if (!isDeliveryCourierType(value)) {
    details.push({
      field: 'deliveryType',
      message: `deliveryType must be one of: ${DELIVERY_COURIER_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalDeliveryType(
  value: unknown,
  details: ValidationDetail[],
): DeliveryCourierType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return readDeliveryType(value, details);
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): DeliveryCourierStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isDeliveryCourierStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${DELIVERY_COURIER_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalSearch(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingle(value);
  if (single === undefined || single === null || single === '') return undefined;
  if (typeof single !== 'string') {
    details.push({ field: 'search', message: 'search must be a string.' });
    return undefined;
  }
  const trimmed = single.trim();
  if (trimmed.length > MAX_SEARCH_LENGTH) {
    details.push({
      field: 'search',
      message: `search must be at most ${MAX_SEARCH_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed === '' ? undefined : trimmed;
}
