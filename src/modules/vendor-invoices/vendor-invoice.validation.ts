import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_INVOICE_CURRENCIES,
  VENDOR_INVOICE_STATUSES,
  isValidVendorPaymentAmount,
  isVendorInvoiceCurrency,
  isVendorInvoiceStatus,
  type CreateVendorInvoiceInput,
  type UpdateVendorInvoiceInput,
  type VendorInvoiceCurrency,
  type VendorInvoiceFilters,
  type VendorInvoiceStatus,
} from './vendor-invoice.types';

type Detail = { field: string; message: string };

const NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value))
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}

export const parseVendorInvoiceIdParam = (raw: string): string =>
  parseId(raw, 'vendorInvoiceId');

export const parseVendorInvoiceVendorIdParam = (raw: string): string =>
  parseId(raw, 'vendorId');

export function parseCreateVendorInvoiceBody(
  body: unknown,
): Omit<CreateVendorInvoiceInput, 'vendorId'> {
  if (!isRecord(body))
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);

  const details: Detail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const invoiceNumber = readInvoiceNumber(body.invoiceNumber, details);
  const invoiceDate = readDate(body.invoiceDate, 'invoiceDate', true, details);
  const receivedDate = readDate(
    body.receivedDate,
    'receivedDate',
    true,
    details,
  );
  const currency = readCurrency(body.currency, details);
  const invoiceAmount = readAmount(body.invoiceAmount, details);
  const vendorReference = readString(
    body.vendorReference,
    'vendorReference',
    255,
    details,
  );
  const vendorWorkId = readId(body.vendorWorkId, 'vendorWorkId', false, details);
  const workOrderId = readId(body.workOrderId, 'workOrderId', false, details);
  const completionReportId = readId(
    body.completionReportId,
    'completionReportId',
    false,
    details,
  );
  const serviceReportId = readId(
    body.serviceReportId,
    'serviceReportId',
    false,
    details,
  );
  const bastDocumentId = readId(
    body.bastDocumentId,
    'bastDocumentId',
    false,
    details,
  );
  // CR-BE-R2P-01 PART 06 — optional procurement linkage.
  const purchaseOrderId = readId(
    body.purchaseOrderId,
    'purchaseOrderId',
    false,
    details,
  );
  const workContractId = readId(
    body.workContractId,
    'workContractId',
    false,
    details,
  );

  // Client and Vendor are authoritative context, never caller-supplied: the
  // Vendor comes from the route and the Client from that Vendor. Accepting
  // them here would open a side channel around the PO/SPK chain validation.
  const derived = ['clientId', 'vendorId'].find(
    (field) => body[field] !== undefined,
  );
  if (derived) {
    details.push({
      field: derived,
      message:
        'This field is derived from the Vendor and procurement chain and must not be supplied.',
    });
  }

  // An SPK is executed under a PO; it can never be linked on its own.
  if (workContractId && !purchaseOrderId) {
    details.push({
      field: 'workContractId',
      message:
        'workContractId requires purchaseOrderId — an SPK is executed under a Purchase Order.',
    });
  }

  const notes = readString(body.notes, 'notes', 2000, details);

  if (
    !buildingId ||
    !invoiceNumber ||
    !invoiceDate ||
    !receivedDate ||
    !currency ||
    invoiceAmount === undefined ||
    details.length
  )
    fail(details);

  return {
    buildingId,
    invoiceNumber,
    invoiceDate,
    receivedDate,
    currency,
    invoiceAmount,
    ...(vendorReference !== undefined ? { vendorReference } : {}),
    ...(vendorWorkId ? { vendorWorkId } : {}),
    ...(workOrderId ? { workOrderId } : {}),
    ...(completionReportId ? { completionReportId } : {}),
    ...(serviceReportId ? { serviceReportId } : {}),
    ...(bastDocumentId ? { bastDocumentId } : {}),
    ...(purchaseOrderId ? { purchaseOrderId } : {}),
    ...(workContractId ? { workContractId } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateVendorInvoiceBody(
  body: unknown,
): UpdateVendorInvoiceInput {
  if (!isRecord(body))
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);

  const immutable = [
    'clientId',
    'buildingId',
    'vendorId',
    'invoiceNumber',
    'status',
    'vendorWorkId',
    'workOrderId',
    'completionReportId',
    'serviceReportId',
    'bastDocumentId',
    'purchaseOrderId',
    'workContractId',
    'finalizedAt',
    'cancelledAt',
  ].find((field) => body[field] !== undefined);
  if (immutable)
    fail([{ field: immutable, message: 'This Vendor Invoice field is immutable.' }]);

  const details: Detail[] = [];
  const invoiceDate =
    body.invoiceDate === undefined
      ? undefined
      : readDate(body.invoiceDate, 'invoiceDate', true, details);
  const receivedDate =
    body.receivedDate === undefined
      ? undefined
      : readDate(body.receivedDate, 'receivedDate', true, details);
  const currency =
    body.currency === undefined
      ? undefined
      : readCurrency(body.currency, details);
  const invoiceAmount =
    body.invoiceAmount === undefined
      ? undefined
      : readAmount(body.invoiceAmount, details);
  const vendorReference =
    body.vendorReference === null
      ? null
      : readString(body.vendorReference, 'vendorReference', 255, details);
  const notes =
    body.notes === null
      ? null
      : readString(body.notes, 'notes', 2000, details);

  const result: UpdateVendorInvoiceInput = {
    ...(invoiceDate ? { invoiceDate } : {}),
    ...(receivedDate ? { receivedDate } : {}),
    ...(currency ? { currency } : {}),
    ...(invoiceAmount !== undefined ? { invoiceAmount } : {}),
    ...(vendorReference !== undefined ? { vendorReference } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  if (Object.keys(result).length === 0 && details.length === 0)
    details.push({
      field: 'body',
      message: 'At least one draft field is required.',
    });
  if (details.length) fail(details);
  return result;
}

export function parseVendorInvoiceFilters(
  query: unknown,
): VendorInvoiceFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const vendorId = readId(query.vendorId, 'vendorId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const workOrderId = readId(
    query.workOrderId,
    'workOrderId',
    false,
    details,
  );
  // CR-BE-R2P-01 PART 06 — trace filters over the commercial chain.
  const purchaseOrderId = readId(
    query.purchaseOrderId,
    'purchaseOrderId',
    false,
    details,
  );
  const workContractId = readId(
    query.workContractId,
    'workContractId',
    false,
    details,
  );
  const status = readStatus(query.status, details);
  const invoiceDateFrom = readDate(
    query.invoiceDateFrom,
    'invoiceDateFrom',
    false,
    details,
  );
  const invoiceDateTo = readDate(
    query.invoiceDateTo,
    'invoiceDateTo',
    false,
    details,
  );
  if (invoiceDateFrom && invoiceDateTo && invoiceDateTo < invoiceDateFrom) {
    details.push({
      field: 'invoiceDateTo',
      message: 'invoiceDateTo must be the same as or after invoiceDateFrom.',
    });
  }
  if (details.length) fail(details);
  return {
    ...(vendorId ? { vendorId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(workOrderId ? { workOrderId } : {}),
    ...(purchaseOrderId ? { purchaseOrderId } : {}),
    ...(workContractId ? { workContractId } : {}),
    ...(status ? { status } : {}),
    ...(invoiceDateFrom ? { invoiceDateFrom } : {}),
    ...(invoiceDateTo ? { invoiceDateTo } : {}),
  };
}

function readId(
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

function readInvoiceNumber(
  value: unknown,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'invoiceNumber',
      message: 'invoiceNumber is required.',
    });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!NUMBER_PATTERN.test(normalized)) {
    details.push({
      field: 'invoiceNumber',
      message: 'invoiceNumber has an invalid format.',
    });
    return undefined;
  }
  return normalized;
}

function readDate(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid YYYY-MM-DD date.`,
    });
    return undefined;
  }
  return value;
}

function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function readAmount(
  value: unknown,
  details: Detail[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    details.push({
      field: 'invoiceAmount',
      message: 'invoiceAmount must be a finite non-negative number.',
    });
    return undefined;
  }
  return value;
}

function readCurrency(
  value: unknown,
  details: Detail[],
): VendorInvoiceCurrency | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'currency',
      message: `currency must be one of: ${VENDOR_INVOICE_CURRENCIES.join(', ')}.`,
    });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isVendorInvoiceCurrency(normalized)) {
    details.push({
      field: 'currency',
      message: `currency must be one of: ${VENDOR_INVOICE_CURRENCIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const result = value.trim();
  if (!result) return null;
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}

function readStatus(
  value: unknown,
  details: Detail[],
): VendorInvoiceStatus | undefined {
  if (value === undefined) return undefined;
  if (!isVendorInvoiceStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${VENDOR_INVOICE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

// ─── PART 02: Verify body parser ────────────────────────────────

export function parseVerifyVendorInvoiceBody(
  body: unknown,
): { notes?: string } {
  if (body === undefined || body === null) return {};
  if (!isRecord(body))
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);

  const details: Detail[] = [];
  const notes = readString(body.notes, 'notes', 2000, details);
  if (details.length) fail(details);
  return notes !== undefined && notes !== null ? { notes } : {};
}

// ─── PART 03: Record payment body parser ────────────────────────

export function parseRecordVendorPaymentBody(
  body: unknown,
): { amount: number; paymentDate?: string; notes?: string } {
  if (!isRecord(body))
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);

  const details: Detail[] = [];

  if (!isValidVendorPaymentAmount(body.amount)) {
    details.push({
      field: 'amount',
      message:
        'amount must be positive, have at most two decimal places, and fit NUMERIC(18,2).',
    });
  }

  const paymentDate = readDate(body.paymentDate, 'paymentDate', false, details);
  const notes = readString(body.notes, 'notes', 2000, details);

  if (details.length) fail(details);

  return {
    amount: body.amount as number,
    ...(paymentDate ? { paymentDate } : {}),
    ...(notes !== undefined && notes !== null ? { notes } : {}),
  };
}
