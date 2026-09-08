import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { RFQ_CURRENCIES, isRfqCurrency } from '../rfqs';
import {
  VENDOR_QUOTATION_TECHNICAL_COMPLIANCE,
  isVendorQuotationTechnicalCompliance,
  type CreateQuotationAttachmentInput,
  type CreateVendorQuotationInput,
  type CreateVendorQuotationLineInput,
  type CreateVendorQuotationRevisionInput,
  type UpdateVendorQuotationLineInput,
  type UpdateVendorQuotationRevisionInput,
  type VendorQuotationFilters,
  type VendorQuotationStatus,
} from './vendor-quotation.types';
import { vendorQuotationIdempotencyKeyRequiredError } from './vendor-quotation.errors';

export type ValidationDetail = { field: string; message: string };
const MAX_TEXT = 2000;
const MAX_SHORT_TEXT = 500;
const MAX_NUMBER = 128;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: ValidationDetail[]): never { throw AppError.validation('Request validation failed.', details); }
function uuid(value: unknown, field: string, required: boolean, details: ValidationDetail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function text(value: unknown, field: string, max: number, details: ValidationDetail[], nullable = true): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string') { details.push({ field, message: `${field} must be a string${nullable ? ' or null' : ''}.` }); return undefined; }
  const v = value.trim();
  if (v.length > max) details.push({ field, message: `${field} must be at most ${max} characters.` });
  return v || (nullable ? null : undefined);
}
function idempotency(body: Record<string, unknown>, header: unknown, details: ValidationDetail[]): string {
  const raw = typeof header === 'string' && header.trim() ? header : body.idempotencyKey;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw vendorQuotationIdempotencyKeyRequiredError();
  }
  const value = raw.trim();
  if (value.length > 200) details.push({ field: 'idempotencyKey', message: 'idempotencyKey must be at most 200 characters.' });
  return value;
}
function currency(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string' || !isRfqCurrency(value.trim().toUpperCase())) {
    details.push({ field: 'currency', message: `currency must be one of: ${RFQ_CURRENCIES.join(', ')}.` });
    return undefined;
  }
  return value.trim().toUpperCase();
}
function validUntil(value: unknown, field: string, details: ValidationDetail[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: `${field} must be a valid ISO date or null.` }); return undefined;
  }
  return new Date(value).toISOString().slice(0, 10);
}
function numberValue(value: unknown, field: string, details: ValidationDetail[], nullable = true): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    details.push({ field, message: `${field} must be a non-negative number${nullable ? ' or null' : ''}.` }); return undefined;
  }
  return value;
}
function integerValue(value: unknown, field: string, details: ValidationDetail[]): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    details.push({ field, message: `${field} must be an integer >= 0 or null.` }); return undefined;
  }
  return value;
}
function compliance(value: unknown, field: string, details: ValidationDetail[]): CreateVendorQuotationLineInput['technicalCompliance'] | undefined {
  if (value === undefined) return undefined;
  const v = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isVendorQuotationTechnicalCompliance(v)) {
    details.push({ field, message: `${field} must be one of: ${VENDOR_QUOTATION_TECHNICAL_COMPLIANCE.join(', ')}.` }); return undefined;
  }
  return v;
}
function price(value: unknown, field: string, details: ValidationDetail[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    details.push({ field, message: `${field} must be a non-negative number.` }); return undefined;
  }
  return value;
}

function parseLine(value: unknown, index: number, details: ValidationDetail[]): CreateVendorQuotationLineInput | undefined {
  if (!record(value)) { details.push({ field: `lines[${index}]`, message: 'Each quotation line must be an object.' }); return undefined; }
  const rfqLineId = uuid(value.rfqLineId, `lines[${index}].rfqLineId`, true, details);
  const quotedQuantity = numberValue(value.quotedQuantity ?? value.quantity, `lines[${index}].quotedQuantity`, details);
  const unitPrice = price(value.unitPrice, `lines[${index}].unitPrice`, details);
  const description = text(value.description ?? value.offeredDescription, `lines[${index}].description`, MAX_SHORT_TEXT, details);
  const technicalCompliance = compliance(value.technicalCompliance ?? value.technicalComplianceStatus, `lines[${index}].technicalCompliance`, details);
  const deviationNotes = text(value.deviationNotes ?? value.deviation, `lines[${index}].deviationNotes`, MAX_TEXT, details);
  if (!rfqLineId || unitPrice === undefined) return undefined;
  return {
    rfqLineId,
    unitPrice,
    ...(quotedQuantity !== undefined ? { quotedQuantity } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(technicalCompliance !== undefined ? { technicalCompliance } : {}),
    ...(deviationNotes !== undefined ? { deviationNotes } : {}),
  };
}

export function parseCreateVendorQuotationLineBody(body: unknown): CreateVendorQuotationLineInput {
  const details: ValidationDetail[] = [];
  const line = parseLine(body, 0, details);
  if (details.length || !line) fail(details);
  return line;
}

function parseLines(value: unknown, details: ValidationDetail[]): CreateVendorQuotationLineInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { details.push({ field: 'lines', message: 'lines must be an array.' }); return []; }
  return value.map((item, index) => parseLine(item, index, details)).filter((item): item is CreateVendorQuotationLineInput => item !== undefined);
}

function parseRevisionFields(body: Record<string, unknown>, details: ValidationDetail[]): Omit<CreateVendorQuotationRevisionInput, 'quotationId'|'idempotencyKey'|'lines'> {
  const c = currency(body.currency, details);
  const v = validUntil(body.validUntil ?? body.validityDate, 'validUntil', details);
  const leadTimeDays = integerValue(body.leadTimeDays ?? body.leadTime, 'leadTimeDays', details);
  const deliveryTerms = text(body.deliveryTerms, 'deliveryTerms', MAX_TEXT, details);
  const serviceTerms = text(body.serviceTerms, 'serviceTerms', MAX_TEXT, details);
  const notes = text(body.notes, 'notes', MAX_TEXT, details);
  if (!c) return { currency: '' };
  return {
    currency: c,
    ...(v !== undefined ? { validUntil: v } : {}),
    ...(leadTimeDays !== undefined ? { leadTimeDays } : {}),
    ...(deliveryTerms !== undefined ? { deliveryTerms } : {}),
    ...(serviceTerms !== undefined ? { serviceTerms } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseCreateVendorQuotationBody(body: unknown, header: unknown): Omit<CreateVendorQuotationInput, 'invitationId'> {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const quotationNumber = text(body.quotationNumber ?? body.quotationReference ?? body.vendorReference ?? body.quoteNumber, 'quotationNumber', MAX_NUMBER, details);
  const fields = parseRevisionFields(body, details);
  const lines = parseLines(body.lines, details);
  const idempotencyKey = idempotency(body, header, details);
  if (details.length || !fields.currency) fail(details);
  return { ...(quotationNumber !== undefined ? { quotationNumber: quotationNumber ?? undefined } : {}), ...fields, idempotencyKey, lines };
}

export function parseCreateVendorQuotationRevisionBody(body: unknown, header: unknown): Omit<CreateVendorQuotationRevisionInput, 'quotationId'> {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const fields = parseRevisionFields(body, details);
  const lines = parseLines(body.lines, details);
  const idempotencyKey = idempotency(body, header, details);
  if (details.length || !fields.currency) fail(details);
  return { ...fields, idempotencyKey, lines };
}

export function parseUpdateVendorQuotationRevisionBody(body: unknown): UpdateVendorQuotationRevisionInput {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const currencyValue = body.currency === undefined ? undefined : currency(body.currency, details);
  const valid = validUntil(body.validUntil, 'validUntil', details);
  const lead = integerValue(body.leadTimeDays, 'leadTimeDays', details);
  const delivery = text(body.deliveryTerms, 'deliveryTerms', MAX_TEXT, details);
  const service = text(body.serviceTerms, 'serviceTerms', MAX_TEXT, details);
  const notes = text(body.notes, 'notes', MAX_TEXT, details);
  if (details.length) fail(details);
  return {
    ...(currencyValue ? { currency: currencyValue } : {}),
    ...(valid !== undefined ? { validUntil: valid } : {}),
    ...(lead !== undefined ? { leadTimeDays: lead } : {}),
    ...(delivery !== undefined ? { deliveryTerms: delivery } : {}),
    ...(service !== undefined ? { serviceTerms: service } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateVendorQuotationLineBody(body: unknown): UpdateVendorQuotationLineInput {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const quotedQuantity = numberValue(body.quotedQuantity, 'quotedQuantity', details);
  const unitPrice = body.unitPrice === undefined ? undefined : price(body.unitPrice, 'unitPrice', details);
  const description = text(body.description, 'description', MAX_SHORT_TEXT, details);
  const technicalCompliance = compliance(body.technicalCompliance, 'technicalCompliance', details);
  const deviationNotes = text(body.deviationNotes, 'deviationNotes', MAX_TEXT, details);
  if (details.length) fail(details);
  return {
    ...(quotedQuantity !== undefined ? { quotedQuantity } : {}),
    ...(unitPrice !== undefined ? { unitPrice } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(technicalCompliance !== undefined ? { technicalCompliance } : {}),
    ...(deviationNotes !== undefined ? { deviationNotes } : {}),
  };
}

export function parseCreateQuotationAttachmentBody(body: unknown): Omit<CreateQuotationAttachmentInput, 'quotationRevisionId'> {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const documentNumber = text(body.documentNumber, 'documentNumber', MAX_NUMBER, details, false);
  const documentType = text(body.documentType, 'documentType', 128, details, false);
  const title = text(body.title, 'title', MAX_SHORT_TEXT, details, false);
  const description = text(body.description, 'description', MAX_TEXT, details);
  const fileReference = text(body.fileReference, 'fileReference', 512, details, false);
  if (details.length || !documentNumber || !documentType || !title || !fileReference) fail(details);
  return { documentNumber, documentType, title, fileReference, ...(description !== undefined ? { description } : {}) };
}

export function parseQuotationIdParam(raw: string): string { return parseUuid(raw, 'quotationId'); }
export function parseQuotationRevisionIdParam(raw: string): string { return parseUuid(raw, 'revisionId'); }
export function parseQuotationLineIdParam(raw: string): string { return parseUuid(raw, 'lineId'); }
export function parseInvitationIdParam(raw: string): string { return parseUuid(raw, 'invitationId'); }
function parseUuid(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}

export function parseQuotationFilters(query: unknown): VendorQuotationFilters {
  if (!record(query)) return {};
  const details: ValidationDetail[] = [];
  const vendorId = query.vendorId === undefined ? undefined : uuid(query.vendorId, 'vendorId', true, details);
  let status: VendorQuotationStatus | undefined;
  if (query.status !== undefined) {
    const candidate = typeof query.status === 'string' ? query.status.trim().toUpperCase() : query.status;
    if (!['DRAFT', 'SUBMITTED', 'WITHDRAWN'].includes(candidate as string)) details.push({ field: 'status', message: 'status is invalid.' }); else status = candidate as VendorQuotationStatus;
  }
  if (details.length) fail(details);
  return { ...(vendorId ? { vendorId } : {}), ...(status ? { status } : {}) };
}
