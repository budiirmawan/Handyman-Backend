import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type {
  BindWorkContractInput,
  CreateWOProcurementBindingInput,
  LinkReceivingInput,
} from './work-order-procurement-binding.types';

type Detail = { field: string; message: string };
export type ValidationDetail = Detail;
const MAX_NOTES_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readUuid(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readUuidOrNull(
  value: unknown,
  field: string,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID or null.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readNotes(value: unknown, details: Detail[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'notes', message: 'notes must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    details.push({ field: 'notes', message: `notes must be at most ${MAX_NOTES_LENGTH} characters.` });
    return undefined;
  }
  return trimmed;
}

export function parseBindingIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'id', message: 'id must be a valid UUID.' }]);
  }
  return value;
}

export function parseWorkOrderIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'workOrderId', message: 'workOrderId must be a valid UUID.' }]);
  }
  return value;
}

export function parseCreateBindingBody(
  body: unknown,
): CreateWOProcurementBindingInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const workOrderId = readUuid(body.workOrderId, 'workOrderId', true, details);
  const purchaseRequestId = readUuid(
    body.purchaseRequestId,
    'purchaseRequestId',
    true,
    details,
  );
  const materialRequestId = readUuidOrNull(
    body.materialRequestId,
    'materialRequestId',
    details,
  );
  const serviceRequestId = readUuidOrNull(
    body.serviceRequestId,
    'serviceRequestId',
    details,
  );
  const workContractId = readUuidOrNull(
    body.workContractId,
    'workContractId',
    details,
  );
  const notes = readNotes(body.notes, details);

  // CR-BE-R2P-01 PART 05 — the SPK reference is the ONLY chain input. The
  // Purchase Order, Vendor, Client and Building are derived from it, so a
  // caller supplying them would be attempting to override authoritative
  // context.
  const derived = ['purchaseOrderId', 'vendorId', 'clientId', 'buildingId'].find(
    (field) => body[field] !== undefined,
  );
  if (derived) {
    details.push({
      field: derived,
      message:
        'This field is derived from the Work Contract (SPK) and must not be supplied.',
    });
  }

  if (!workOrderId || !purchaseRequestId || details.length) fail(details);
  return {
    workOrderId,
    purchaseRequestId,
    ...(materialRequestId === undefined ? {} : { materialRequestId }),
    ...(serviceRequestId === undefined ? {} : { serviceRequestId }),
    ...(workContractId === undefined ? {} : { workContractId }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * CR-BE-R2P-01 PART 05 — the bind-SPK body carries the SPK reference only.
 * Everything else about the chain is backend-derived.
 */
export function parseBindWorkContractBody(
  body: unknown,
): BindWorkContractInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const workContractId = readUuid(
    body.workContractId,
    'workContractId',
    true,
    details,
  );

  const derived = ['purchaseOrderId', 'vendorId', 'clientId', 'buildingId'].find(
    (field) => body[field] !== undefined,
  );
  if (derived) {
    details.push({
      field: derived,
      message:
        'This field is derived from the Work Contract (SPK) and must not be supplied.',
    });
  }

  if (!workContractId || details.length) fail(details);
  return { workContractId };
}

export function parseLinkReceivingBody(body: unknown): LinkReceivingInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const receivingId = readUuid(body.receivingId, 'receivingId', true, details);
  if (!receivingId || details.length) fail(details);
  return { receivingId };
}
