import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { PRICE_CATALOG_CURRENCIES, type PriceCatalogCurrency } from '../price-catalog-entries/price-catalog-entry.types';
import { HANDYMAN_QUOTATION_LINE_TYPES, type HandymanQuotationLineType } from './handyman-quotation.types';

/**
 * CR-HM-BE-03 RUN 4 — strict HTTP contract for the customer quotation
 * commerce surfaces (quotation create/read, revision create/read, DRAFT line
 * authoring, submit, governed send and withdraw). The transport layer accepts
 * ONLY the allowlisted fields; every other key — including protected
 * server-derived authority fields (derived totals, client/building authority,
 * customer snapshot, revision_number, quotation_number, sent_revision_id,
 * pricing provenance) — is rejected with 400 VALIDATION_ERROR details. All
 * business authority (lifecycle guards, pricing governance through the
 * UNCHANGED catalog lookup, access enforcement, idempotency) stays in the
 * Run 2 services; this module only governs the wire shape.
 */

type Detail = { field: string; message: string };

export const CREATE_HANDYMAN_QUOTATION_HTTP_BODY_FIELDS = ['currency'] as const;

export const CREATE_HANDYMAN_QUOTATION_REVISION_HTTP_BODY_FIELDS = [
  'notes',
  'validUntil',
] as const;

export const ADD_HANDYMAN_QUOTATION_LINE_HTTP_BODY_FIELDS = [
  'lineType',
  'serviceCatalogId',
  'inventoryItemId',
  'uomId',
  'quantity',
  'description',
  'unitPrice',
  'deviationNote',
] as const;

export const UPDATE_HANDYMAN_QUOTATION_LINE_HTTP_BODY_FIELDS = [
  'unitPrice',
  'quantity',
  'description',
  'deviationNote',
] as const;

/** The governed send command carries exactly the explicit revision
 * identifier; the sent envelope itself is server-managed. */
export const SEND_HANDYMAN_QUOTATION_HTTP_BODY_FIELDS = ['revisionId'] as const;

const SERVER_MANAGED_ENVELOPE_FIELDS: Record<string, string> = {
  id: 'Quotation id is server-generated.',
  quotationNumber: 'quotationNumber is server-generated and never accepted.',
  status: 'Quotation status is server-managed by the governed lifecycle.',
  clientId: 'Client identity is derived from the governed request.',
  buildingId: 'Building scope is derived from the governed request.',
  tenantCompanyId: 'Tenant identity is derived from the governed request.',
  tenantPicId: 'Tenant PIC identity is derived from the governed request.',
  customerName: 'The customer snapshot is derived from the governed request.',
  customerPhone: 'The customer snapshot is derived from the governed request.',
  customerEmail: 'The customer snapshot is derived from the governed request.',
  sentRevisionId:
    'sentRevisionId is server-managed; the governed send command identifies the revision through revisionId only.',
  sentAt: 'Timestamps are server-generated.',
  withdrawnAt: 'Timestamps are server-generated.',
  createdByUserId: 'Created-by identity comes from the authenticated actor.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

const CREATE_QUOTATION_PROTECTED_FIELDS: Record<string, string> = {
  ...SERVER_MANAGED_ENVELOPE_FIELDS,
  requestId: 'Request id comes from the route and is not accepted in the body.',
  idempotencyKey:
    'idempotencyKey is accepted only through the Idempotency-Key header.',
  idempotencyFingerprint:
    'idempotencyFingerprint is server-computed and never accepted.',
  revisionId: 'The first revision is created by the service, never by the caller.',
};

const CREATE_REVISION_PROTECTED_FIELDS: Record<string, string> = {
  id: 'Revision id is server-generated.',
  quotationId: 'Quotation id comes from the route and is not accepted in the body.',
  revisionNumber: 'revisionNumber is server-assigned (sequential per quotation).',
  status: 'Revision status is server-managed (DRAFT on creation).',
  totals: 'Totals are derived from stored lines and never accepted.',
  submittedAt: 'Timestamps are server-generated.',
  submittedByUserId: 'Submitted-by identity comes from the authenticated actor.',
  supersededAt: 'Supersede lifecycle is server-managed (immutable history).',
  supersededByUserId: 'Supersede lifecycle is server-managed (immutable history).',
  clientId: 'Client identity is derived from the governed quotation.',
  buildingId: 'Building scope is derived from the governed quotation.',
  createdByUserId: 'Created-by identity comes from the authenticated actor.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
  lines: 'Lines are authored through the governed line endpoints.',
};

const LINE_COMMERCIAL_PROTECTED_FIELDS: Record<string, string> = {
  lineTotal: 'lineTotal is derived (GENERATED column) and never accepted.',
  lineNumber: 'lineNumber is server-assigned (sequential per revision).',
  subjectCode: 'Subject identity is resolved from the governed catalog reference.',
  subjectName: 'Subject identity is resolved from the governed catalog reference.',
  uomCode: 'UOM identity is resolved from the governed reference.',
  referenceResolution: 'Pricing provenance is resolved by the governed lookup.',
  referencePriceEntryId: 'Pricing provenance is resolved by the governed lookup.',
  referenceScopeTier: 'Pricing provenance is resolved by the governed lookup.',
  referenceUnitPrice: 'Pricing provenance is resolved by the governed lookup.',
  referenceAsOf: 'Pricing provenance is resolved by the governed lookup.',
  unitPriceOverride: 'Pricing is service-authoritative; no override channel exists.',
  discount: 'No discount surface exists in CR-HM-BE-03.',
  currency: 'Currency is fixed by the quotation envelope.',
};

const ADD_LINE_PROTECTED_FIELDS: Record<string, string> = {
  ...LINE_COMMERCIAL_PROTECTED_FIELDS,
  id: 'Line id is server-generated.',
  revisionId: 'Revision id comes from the route and is not accepted in the body.',
  quotationId: 'Quotation scope is derived from the governed revision.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

const UPDATE_LINE_PROTECTED_FIELDS: Record<string, string> = {
  ...LINE_COMMERCIAL_PROTECTED_FIELDS,
  id: 'Line id is server-generated.',
  revisionId: 'Line-to-revision binding is immutable.',
  quotationId: 'Quotation scope is derived from the governed revision.',
  lineType: 'Line type is immutable; remove and re-add under governance instead.',
  serviceCatalogId: 'Subject identity is immutable; remove and re-add under governance instead.',
  inventoryItemId: 'Subject identity is immutable; remove and re-add under governance instead.',
  uomId: 'UOM identity is immutable; remove and re-add under governance instead.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

const SEND_QUOTATION_PROTECTED_FIELDS: Record<string, string> = {
  ...SERVER_MANAGED_ENVELOPE_FIELDS,
  quotationId: 'Quotation id comes from the route and is not accepted in the body.',
  requestId: 'Request scope is derived from the governed quotation.',
  approvalId: 'The PENDING approval is created by the governed send transaction.',
  idempotencyKey: 'Send is idempotent through its guarded envelope transition.',
};

const CURRENCY_VALUES = new Set<string>(PRICE_CATALOG_CURRENCIES);
const LINE_TYPE_VALUES = new Set<string>(HANDYMAN_QUOTATION_LINE_TYPES);

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(raw: unknown, field: string, label: string): string {
  if (typeof raw !== 'string') {
    fail([{ field, message: `${label} must be a string.` }]);
  }
  const value = (raw as string).trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${label} must be a valid UUID.` }]);
  }
  return value;
}

function assertAllowedFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  protectedFields: Record<string, string>,
  details: Detail[],
): void {
  for (const field of Object.keys(body)) {
    const protectedMessage = protectedFields[field];
    if (protectedMessage) {
      details.push({ field, message: protectedMessage });
      continue;
    }
    if (!(allowed as readonly string[]).includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: Detail[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} must be a non-empty string or null.` });
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return null;
  }
  return normalized;
}

function readOptionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return null;
  }
  return trimmed;
}

/** Numeric wire check only: a finite number or non-empty numeric string.
 * Positivity, precision (≤2dp price / ≤3dp quantity) and range remain
 * service-authoritative (Run 2 pricing governance). */
function readNumeric(value: unknown, field: string, details: Detail[]): boolean {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      details.push({ field, message: `${field} must be a finite number.` });
      return false;
    }
    return true;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    if (!Number.isFinite(Number(value))) {
      details.push({ field, message: `${field} must be numeric.` });
      return false;
    }
    return true;
  }
  details.push({ field, message: `${field} must be a number or numeric string.` });
  return false;
}

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export function parseHandymanQuotationRequestIdParam(raw: string): string {
  return parseUuidParam(raw, 'handymanRequestId', 'Handyman request id');
}

export function parseHandymanQuotationIdParam(raw: string): string {
  return parseUuidParam(raw, 'quotationId', 'Quotation id');
}

export function parseHandymanQuotationRevisionIdParam(raw: string): string {
  return parseUuidParam(raw, 'revisionId', 'Revision id');
}

export function parseHandymanQuotationLineIdParam(raw: string): string {
  return parseUuidParam(raw, 'lineId', 'Quotation line id');
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** `POST /handyman-requests/:handymanRequestId/quotations` body →
 * `{ currency }`. The optional `Idempotency-Key` header is read by the
 * controller and forwarded to the existing Run 2 service. */
export function parseCreateHandymanQuotationHttpBody(body: unknown): {
  currency: PriceCatalogCurrency;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    CREATE_HANDYMAN_QUOTATION_HTTP_BODY_FIELDS,
    CREATE_QUOTATION_PROTECTED_FIELDS,
    details,
  );

  const currency = body.currency;
  if (typeof currency !== 'string' || currency.trim() === '') {
    details.push({ field: 'currency', message: 'Currency is required.' });
  } else if (!CURRENCY_VALUES.has(currency.trim().toUpperCase())) {
    details.push({
      field: 'currency',
      message: `Currency must be one of ${PRICE_CATALOG_CURRENCIES.join(', ')}.`,
    });
  }

  if (details.length > 0) fail(details);
  return { currency: (currency as string).trim().toUpperCase() as PriceCatalogCurrency };
}

/** `POST /handyman-quotations/:quotationId/revisions` body →
 * `{ notes?, validUntil? }`. The YYYY-MM-DD calendar check stays in the
 * Run 2 revision service. */
export function parseCreateHandymanQuotationRevisionHttpBody(body: unknown): {
  notes: string | null;
  validUntil: string | null;
} {
  const record = body === undefined || body === null ? {} : body;
  if (!isRecord(record)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    record,
    CREATE_HANDYMAN_QUOTATION_REVISION_HTTP_BODY_FIELDS,
    CREATE_REVISION_PROTECTED_FIELDS,
    details,
  );

  const notes = readOptionalBoundedString(record.notes, 'notes', 2000, details);
  let validUntil: string | null = null;
  if (record.validUntil !== undefined && record.validUntil !== null) {
    if (typeof record.validUntil !== 'string' || record.validUntil.trim() === '') {
      details.push({
        field: 'validUntil',
        message: 'validUntil must be a non-empty YYYY-MM-DD string or null.',
      });
    } else {
      validUntil = record.validUntil.trim();
    }
  }

  if (details.length > 0) fail(details);
  return { notes, validUntil };
}

/** `POST /handyman-quotation-revisions/:revisionId/lines` body → the DRAFT
 * line authoring allowlist. Subject/price governance (LABOR consistency with
 * ACTIVE request services, MATERIAL item/UOM rules, reference-price lookup,
 * deviation notes) remains service-authoritative. */
export function parseAddHandymanQuotationLineHttpBody(body: unknown): {
  lineType: HandymanQuotationLineType;
  serviceCatalogId: string | null;
  inventoryItemId: string | null;
  uomId: string | null;
  quantity: number | string | null;
  description: string | null;
  unitPrice: number | string;
  deviationNote: string | null;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    ADD_HANDYMAN_QUOTATION_LINE_HTTP_BODY_FIELDS,
    ADD_LINE_PROTECTED_FIELDS,
    details,
  );

  const lineType = body.lineType;
  if (typeof lineType !== 'string' || lineType.trim() === '') {
    details.push({ field: 'lineType', message: 'Line type is required.' });
  } else if (!LINE_TYPE_VALUES.has(lineType.trim().toUpperCase())) {
    details.push({
      field: 'lineType',
      message: `Line type must be one of ${HANDYMAN_QUOTATION_LINE_TYPES.join(', ')}.`,
    });
  }

  const serviceCatalogId = readOptionalUuid(
    body.serviceCatalogId,
    'serviceCatalogId',
    'Service catalog id',
    details,
  );
  const inventoryItemId = readOptionalUuid(
    body.inventoryItemId,
    'inventoryItemId',
    'Inventory item id',
    details,
  );
  const uomId = readOptionalUuid(body.uomId, 'uomId', 'UOM id', details);

  let quantity: number | string | null = null;
  if (body.quantity !== undefined && body.quantity !== null) {
    if (readNumeric(body.quantity, 'quantity', details)) {
      quantity = body.quantity as number | string;
    }
  }

  const description = readOptionalBoundedString(body.description, 'description', 1000, details);
  const deviationNote = readOptionalBoundedString(
    body.deviationNote,
    'deviationNote',
    1000,
    details,
  );

  let unitPrice: number | string | undefined;
  if (body.unitPrice === undefined || body.unitPrice === null) {
    details.push({ field: 'unitPrice', message: 'Unit price is required.' });
  } else if (readNumeric(body.unitPrice, 'unitPrice', details)) {
    unitPrice = body.unitPrice as number | string;
  }

  if (details.length > 0) fail(details);
  return {
    lineType: (lineType as string).trim().toUpperCase() as HandymanQuotationLineType,
    serviceCatalogId,
    inventoryItemId,
    uomId,
    quantity,
    description,
    unitPrice: unitPrice as number | string,
    deviationNote,
  };
}

/** `PATCH /handyman-quotation-lines/:lineId` body → the mutable commercial
 * facts only; at least one field must be present. */
export function parseUpdateHandymanQuotationLineHttpBody(body: unknown): {
  unitPrice?: number | string;
  quantity?: number | string | null;
  description?: string | null;
  deviationNote?: string | null;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    UPDATE_HANDYMAN_QUOTATION_LINE_HTTP_BODY_FIELDS,
    UPDATE_LINE_PROTECTED_FIELDS,
    details,
  );

  const present = (UPDATE_HANDYMAN_QUOTATION_LINE_HTTP_BODY_FIELDS as readonly string[]).filter(
    (field) => body[field] !== undefined,
  );
  if (present.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one updatable line field is required.',
    });
  }

  const result: {
    unitPrice?: number | string;
    quantity?: number | string | null;
    description?: string | null;
    deviationNote?: string | null;
  } = {};

  if (body.unitPrice !== undefined) {
    if (body.unitPrice === null) {
      details.push({ field: 'unitPrice', message: 'unitPrice cannot be null.' });
    } else if (readNumeric(body.unitPrice, 'unitPrice', details)) {
      result.unitPrice = body.unitPrice as number | string;
    }
  }
  if (body.quantity !== undefined) {
    if (body.quantity === null) {
      result.quantity = null;
    } else if (readNumeric(body.quantity, 'quantity', details)) {
      result.quantity = body.quantity as number | string;
    }
  }
  if (body.description !== undefined) {
    result.description = readOptionalBoundedString(
      body.description,
      'description',
      1000,
      details,
    );
  }
  if (body.deviationNote !== undefined) {
    result.deviationNote = readOptionalBoundedString(
      body.deviationNote,
      'deviationNote',
      1000,
      details,
    );
  }

  if (details.length > 0) fail(details);
  return result;
}

/** `POST /handyman-quotations/:quotationId/send` body → `{ revisionId }` —
 * the explicit revision identifier required by the governed send command.
 * This is the ONLY caller-supplied revision authority; the envelope
 * (sentRevisionId/sentAt/status) and the PENDING approval are server-managed. */
export function parseSendHandymanQuotationHttpBody(body: unknown): {
  revisionId: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    SEND_HANDYMAN_QUOTATION_HTTP_BODY_FIELDS,
    SEND_QUOTATION_PROTECTED_FIELDS,
    details,
  );

  const revisionId = body.revisionId;
  if (typeof revisionId !== 'string' || revisionId.trim() === '') {
    details.push({
      field: 'revisionId',
      message: 'revisionId is required — the governed send command sends exactly one revision.',
    });
  } else if (!isValidUuid(revisionId.trim().toLowerCase())) {
    details.push({ field: 'revisionId', message: 'revisionId must be a valid UUID.' });
  }

  if (details.length > 0) fail(details);
  return { revisionId: (revisionId as string).trim().toLowerCase() };
}
