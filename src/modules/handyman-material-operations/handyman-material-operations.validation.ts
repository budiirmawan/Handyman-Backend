import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type {
  HandymanMaterialApprovalDecision,
  HandymanMaterialApprovedForType,
  HandymanMaterialCancellationReason,
  HandymanMaterialSupplySource,
} from '../handyman-material-demands';
import type { HandymanMaterialUsageKind } from '../handyman-material-inventory';

/**
 * CR-HM-BE-07 RUN 3 — Strict HTTP contract for the material operations
 * surface (demands, addenda, approvals, reservations, issues, usages,
 * returns). The transport layer accepts ONLY the allowlisted business facts
 * of the EXISTING Run-1/Run-2 service commands and forwards them unchanged
 * (wire vocabulary == service input names; timestamps keep the service
 * names `issuedAt`/`usedAt`/`returnedAt`).
 *
 * Idempotency travels ONLY through the `Idempotency-Key` header (the
 * requests/quotations convention); a body `idempotencyKey` is rejected.
 * Every other key — caller-controlled identity, pricing, balances,
 * movement links, server timestamps, customer authority — is rejected with
 * 400 VALIDATION_ERROR details. No mass assignment: the actor always comes
 * from the authenticated session. Domain conflicts are never converted
 * into transport errors.
 */

type Detail = { field: string; message: string };

/** Operational lanes accept only the two non-chargeable source contexts. */
export type HandymanMaterialOperationalSourceContext =
  | 'INTERNAL_OPERATION'
  | 'FIELD_DISCOVERED';

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MATERIAL_OPERATIONS_PROTECTED_FIELDS: Record<string, string> = {
  clientId: 'Client scope is derived server-side from the job/demand chain.',
  customerId: 'Customer identity is never accepted from a caller.',
  tenantCompanyId: 'Tenant identity is derived server-side from the request context.',
  tenantPicId: 'Tenant PIC identity is derived server-side from the request context.',
  approvedForTenantCompanyId: 'Approved-for identity is derived server-side; only the approved-for class is accepted.',
  approvedForTenantPicId: 'Approved-for identity is derived server-side; only the approved-for class is accepted.',
  approvedForName: 'Approved-for identity is derived server-side and never exposed.',
  recordedByUserId: 'Recorder identity comes from the authenticated actor.',
  createdByUserId: 'Attribution comes from the authenticated actor.',
  actorUserId: 'Actor identity comes from the authenticated session.',
  performedByUserId: 'Actor identity comes from the authenticated session.',
  requestId: 'Request identity is derived server-side from the job.',
  handymanRequestId: 'Request identity is derived server-side from the job.',
  buildingId: 'Building authority is derived server-side from the job.',
  handymanJobId: 'Job identity comes from the route or the addressed fact.',
  jobId: 'Job identity comes from the route or the addressed fact.',
  workOrderId: 'Work Order identity is server-resolved; its lifecycle stays on the existing owner.',
  warehouseAuthority: 'Warehouse authority is service-owned; only the warehouse link is accepted.',
  inventoryBalanceId: 'Inventory balances are never accepted from a caller.',
  balanceId: 'Inventory balances are never accepted from a caller.',
  availableQuantity: 'Available quantity is computed server-side by inventory authority.',
  reservedQuantity: 'Reserved quantity is computed server-side by inventory authority.',
  onHandQuantity: 'On-hand quantity is computed server-side by inventory authority.',
  quantityOnHand: 'On-hand quantity is computed server-side by inventory authority.',
  remainingQuantity: 'Remainders are computed server-side by inventory authority.',
  stockMovementId: 'Stock movements are created server-side by inventory authority.',
  inventoryStockMovementId: 'Stock movements are created server-side by inventory authority.',
  movementId: 'Stock movements are created server-side by inventory authority.',
  unitPrice: 'Pricing is governed server-side; caller prices are never accepted.',
  totalPrice: 'Pricing is governed server-side; caller prices are never accepted.',
  unitCommercialAmount: 'Commercial amounts are resolved server-side through the price catalog.',
  totalCommercialAmount: 'Commercial amounts are resolved server-side through the price catalog.',
  currency: 'Currency is resolved server-side from governed context.',
  quotationTotal: 'Quotation totals are never accepted from a caller.',
  invoiceAmount: 'Invoices are outside CR07; amounts are never accepted.',
  paymentAmount: 'Payments are outside CR07; facts are never accepted.',
  bmFee: 'BM fees are outside CR07; facts are never accepted.',
  feeAmount: 'Fees are outside CR07; facts are never accepted.',
  settlementAmount: 'Settlement is outside CR07; facts are never accepted.',
  status: 'Lifecycle status is server-managed by the domain.',
  state: 'Lifecycle state is server-managed by the domain.',
  decisionNotes: 'Decision notes travel only through the governed notes field.',
  approvedFor: 'Approved-for detail is derived server-side; only the class selector is accepted where documented.',
  idempotencyKey: 'The idempotency key is accepted only through the Idempotency-Key header.',
  idempotencyFingerprint: 'Idempotency fingerprints are server-computed and never accepted.',
  terminalIdempotencyKey: 'Terminal idempotency facts are server-managed.',
  createdAt: 'Server timestamps are server-generated.',
  updatedAt: 'Server timestamps are server-generated.',
  issuedAtServer: 'Server timestamps are server-generated.',
  secureToken: 'Secure tokens are never accepted on this surface.',
  token: 'Secure tokens are never accepted on this surface.',
  documentStorageKey: 'Document storage keys are never accepted from a caller.',
  storageKey: 'Document storage keys are never accepted from a caller.',
  fileReference: 'Evidence attaches through the supporting-documents authority, not material commands.',
};

function assertAllowedFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  details: Detail[],
): void {
  for (const key of Object.keys(body)) {
    if ((allowed as readonly string[]).includes(key)) continue;
    const protectedMessage = MATERIAL_OPERATIONS_PROTECTED_FIELDS[key];
    details.push({
      field: key,
      message: protectedMessage ?? `Unknown field '${key}' is not accepted.`,
    });
  }
}

function readUuid(
  value: unknown,
  field: string,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
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

function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  details: Detail[],
): T | undefined {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    details.push({ field, message: `${field} must be one of: ${allowed.join(', ')}.` });
    return undefined;
  }
  return value as T;
}

function readOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  details: Detail[],
): T | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readEnum(value, field, allowed, details);
}

/** Transport shape only: positive decimal, at most 4 fraction digits. */
function readQuantity(value: unknown, details: Detail[]): string | undefined {
  const raw =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : ''
      : typeof value === 'string'
        ? value.trim()
        : '';
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(raw);
  if (!match) {
    details.push({
      field: 'quantity',
      message: 'Quantity must be a positive decimal with at most 4 fraction digits.',
    });
    return undefined;
  }
  const integer = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  if (canonical === '0' || integer.length > 14) {
    details.push({
      field: 'quantity',
      message: 'Quantity must be greater than zero and fit the material quantity precision.',
    });
    return undefined;
  }
  return canonical;
}

function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
    return undefined;
  }
  return text;
}

function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (value.trim().length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
    return undefined;
  }
  return value.trim();
}

function readOptionalDateTime(
  value: unknown,
  field: string,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    details.push({ field, message: `${field} must be an ISO-8601 timestamp.` });
    return undefined;
  }
  return value.trim();
}

/** All mutating CR07 commands require the key through the header only. */
export function parseIdempotencyKeyHeader(raw: unknown): string {
  if (typeof raw !== 'string') {
    fail([{ field: 'Idempotency-Key', message: 'Idempotency-Key header is required.' }]);
  }
  const key = raw.trim();
  if (key.length === 0 || key.length > 200) {
    fail([{ field: 'Idempotency-Key', message: 'Idempotency-Key header is required.' }]);
  }
  return key;
}

function parseUuidParam(raw: string, field: string): string {
  if (!isValidUuid(raw.trim())) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return raw.trim().toLowerCase();
}

export function parseHandymanJobIdParam(raw: string): string {
  return parseUuidParam(raw, 'jobId');
}

export function parseMaterialDemandIdParam(raw: string): string {
  return parseUuidParam(raw, 'demandId');
}

export function parseMaterialAddendumIdParam(raw: string): string {
  return parseUuidParam(raw, 'addendumId');
}

export function parseMaterialApprovalIdParam(raw: string): string {
  return parseUuidParam(raw, 'approvalId');
}

export function parseMaterialReservationIdParam(raw: string): string {
  return parseUuidParam(raw, 'reservationId');
}

export function parseMaterialIssueIdParam(raw: string): string {
  return parseUuidParam(raw, 'issueId');
}

function parseMaterialSubjectBody(
  body: Record<string, unknown>,
  details: Detail[],
): {
  supplySource?: HandymanMaterialSupplySource;
  inventoryItemId?: string | null;
  uomId?: string;
  description?: string | null;
  quantity?: string;
  sourceContext?: HandymanMaterialOperationalSourceContext;
  handymanServiceVisitId?: string | null;
} {
  const supplySource =
    body.supplySource === undefined
      ? undefined
      : readEnum<HandymanMaterialSupplySource>(
          body.supplySource,
          'supplySource',
          ['PROVIDER_STOCK', 'CUSTOMER_SUPPLIED'],
          details,
        );
  const inventoryItemId = readOptionalUuid(body.inventoryItemId, 'inventoryItemId', details);
  const uomId =
    body.uomId === undefined
      ? (details.push({ field: 'uomId', message: 'uomId is required.' }), undefined)
      : readUuid(body.uomId, 'uomId', details);
  const description = readOptionalText(body.description, 'description', 1000, details);
  const quantity = body.quantity === undefined
    ? (details.push({ field: 'quantity', message: 'quantity is required.' }), undefined)
    : readQuantity(body.quantity, details);
  const sourceContext =
    readOptionalEnum<HandymanMaterialOperationalSourceContext>(
      body.sourceContext,
      'sourceContext',
      ['INTERNAL_OPERATION', 'FIELD_DISCOVERED'],
      details,
    ) ?? undefined;
  const handymanServiceVisitId = readOptionalUuid(
    body.handymanServiceVisitId,
    'handymanServiceVisitId',
    details,
  );
  return {
    ...(supplySource === undefined ? {} : { supplySource }),
    ...(inventoryItemId === undefined ? {} : { inventoryItemId }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(description === undefined ? {} : { description }),
    ...(quantity === undefined ? {} : { quantity }),
    ...(sourceContext === undefined ? {} : { sourceContext }),
    ...(handymanServiceVisitId === undefined ? {} : { handymanServiceVisitId }),
  };
}

export const CREATE_QUOTATION_INCLUDED_DEMAND_HTTP_BODY_FIELDS = [
  'handymanQuotationLineId',
] as const;

export function parseCreateQuotationIncludedDemandHttpBody(body: unknown): {
  handymanQuotationLineId: string;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, CREATE_QUOTATION_INCLUDED_DEMAND_HTTP_BODY_FIELDS, details);
  const handymanQuotationLineId =
    body.handymanQuotationLineId === undefined
      ? (details.push({
          field: 'handymanQuotationLineId',
          message: 'handymanQuotationLineId is required.',
        }),
        undefined)
      : readUuid(body.handymanQuotationLineId, 'handymanQuotationLineId', details);
  if (details.length > 0 || !handymanQuotationLineId) fail(details);
  return { handymanQuotationLineId: handymanQuotationLineId as string };
}

export const CREATE_OPERATIONAL_DEMAND_HTTP_BODY_FIELDS = [
  'supplySource',
  'inventoryItemId',
  'uomId',
  'description',
  'quantity',
  'sourceContext',
  'handymanServiceVisitId',
] as const;

export function parseCreateOperationalDemandHttpBody(body: unknown): {
  supplySource: HandymanMaterialSupplySource;
  inventoryItemId?: string | null;
  uomId: string;
  description?: string | null;
  quantity: string;
  sourceContext?: HandymanMaterialOperationalSourceContext;
  handymanServiceVisitId?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, CREATE_OPERATIONAL_DEMAND_HTTP_BODY_FIELDS, details);
  if (body.supplySource === undefined) {
    details.push({ field: 'supplySource', message: 'supplySource is required.' });
  }
  const subject = parseMaterialSubjectBody(body, details);
  if (details.length > 0 || !subject.supplySource || !subject.uomId || !subject.quantity) {
    fail(details);
  }
  return {
    supplySource: subject.supplySource as HandymanMaterialSupplySource,
    ...(subject.inventoryItemId === undefined ? {} : { inventoryItemId: subject.inventoryItemId }),
    uomId: subject.uomId as string,
    ...(subject.description === undefined ? {} : { description: subject.description }),
    quantity: subject.quantity as string,
    ...(subject.sourceContext === undefined ? {} : { sourceContext: subject.sourceContext }),
    ...(subject.handymanServiceVisitId === undefined
      ? {}
      : { handymanServiceVisitId: subject.handymanServiceVisitId }),
  };
}

export const CREATE_CUSTOMER_SUPPLIED_DEMAND_HTTP_BODY_FIELDS = [
  'inventoryItemId',
  'uomId',
  'description',
  'quantity',
  'sourceContext',
  'handymanServiceVisitId',
] as const;

/** Supply source is pinned server-side to CUSTOMER_SUPPLIED. */
export function parseCreateCustomerSuppliedDemandHttpBody(body: unknown): {
  inventoryItemId?: string | null;
  uomId: string;
  description?: string | null;
  quantity: string;
  sourceContext?: HandymanMaterialOperationalSourceContext;
  handymanServiceVisitId?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, CREATE_CUSTOMER_SUPPLIED_DEMAND_HTTP_BODY_FIELDS, details);
  const subject = parseMaterialSubjectBody(body, details);
  if (details.length > 0 || !subject.uomId || !subject.quantity) fail(details);
  return {
    ...(subject.inventoryItemId === undefined ? {} : { inventoryItemId: subject.inventoryItemId }),
    uomId: subject.uomId as string,
    ...(subject.description === undefined ? {} : { description: subject.description }),
    quantity: subject.quantity as string,
    ...(subject.sourceContext === undefined ? {} : { sourceContext: subject.sourceContext }),
    ...(subject.handymanServiceVisitId === undefined
      ? {}
      : { handymanServiceVisitId: subject.handymanServiceVisitId }),
  };
}

export const SUPERSEDE_DEMAND_HTTP_BODY_FIELDS =
  CREATE_OPERATIONAL_DEMAND_HTTP_BODY_FIELDS;

/**
 * Successor facts only; the predecessor comes from the route and the job is
 * resolved server-side from it. A body `supersedesDemandId` is rejected.
 */
export const parseSupersedeDemandHttpBody = parseCreateOperationalDemandHttpBody;

export const CANCEL_MATERIAL_HTTP_BODY_FIELDS = ['reason'] as const;

export function parseCancelMaterialHttpBody(body: unknown): {
  reason: HandymanMaterialCancellationReason;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, CANCEL_MATERIAL_HTTP_BODY_FIELDS, details);
  const reason = readEnum<HandymanMaterialCancellationReason>(
    body.reason,
    'reason',
    ['CUSTOMER_WITHDREW', 'SCOPE_NO_LONGER_REQUIRED', 'OTHER_OPERATIONAL'],
    details,
  );
  if (details.length > 0 || !reason) fail(details);
  return { reason: reason as HandymanMaterialCancellationReason };
}

export const CREATE_MATERIAL_ADDENDUM_HTTP_BODY_FIELDS = [
  'supplySource',
  'inventoryItemId',
  'uomId',
  'description',
  'quantity',
  'supersedesAddendumId',
] as const;

export function parseCreateMaterialAddendumHttpBody(body: unknown): {
  supplySource: HandymanMaterialSupplySource;
  inventoryItemId?: string | null;
  uomId: string;
  description?: string | null;
  quantity: string;
  supersedesAddendumId?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, CREATE_MATERIAL_ADDENDUM_HTTP_BODY_FIELDS, details);
  if (body.supplySource === undefined) {
    details.push({ field: 'supplySource', message: 'supplySource is required.' });
  }
  const subject = parseMaterialSubjectBody(body, details);
  const supersedesAddendumId = readOptionalUuid(
    body.supersedesAddendumId,
    'supersedesAddendumId',
    details,
  );
  if (subject.sourceContext !== undefined || subject.handymanServiceVisitId !== undefined) {
    details.push({
      field: 'sourceContext',
      message: 'Addenda carry no field source context; use the demand lanes.',
    });
  }
  if (details.length > 0 || !subject.supplySource || !subject.uomId || !subject.quantity) {
    fail(details);
  }
  return {
    supplySource: subject.supplySource as HandymanMaterialSupplySource,
    ...(subject.inventoryItemId === undefined ? {} : { inventoryItemId: subject.inventoryItemId }),
    uomId: subject.uomId as string,
    ...(subject.description === undefined ? {} : { description: subject.description }),
    quantity: subject.quantity as string,
    ...(supersedesAddendumId === undefined ? {} : { supersedesAddendumId }),
  };
}

export const DECIDE_MATERIAL_APPROVAL_IN_APP_HTTP_BODY_FIELDS = [
  'decision',
  'notes',
] as const;

export function parseDecideMaterialApprovalInAppHttpBody(body: unknown): {
  decision: HandymanMaterialApprovalDecision;
  notes?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, DECIDE_MATERIAL_APPROVAL_IN_APP_HTTP_BODY_FIELDS, details);
  const decision = readEnum<HandymanMaterialApprovalDecision>(
    body.decision,
    'decision',
    ['APPROVED', 'REJECTED'],
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', 2000, details);
  if (details.length > 0 || !decision) fail(details);
  return {
    decision: decision as HandymanMaterialApprovalDecision,
    ...(notes === undefined ? {} : { notes }),
  };
}

export const DECIDE_MATERIAL_APPROVAL_ASSISTED_HTTP_BODY_FIELDS = [
  'decision',
  'approvedFor',
  'notes',
] as const;

function readApprovedForClass(
  value: unknown,
  details: Detail[],
): { type: HandymanMaterialApprovedForType } | undefined {
  if (!isRecord(value)) {
    details.push({
      field: 'approvedFor',
      message: 'approvedFor must be an object with exactly the customer class.',
    });
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'type') {
    details.push({
      field: 'approvedFor',
      message:
        'approvedFor accepts only the customer class; any customer/tenant identity is derived server-side.',
    });
    return undefined;
  }
  const type = readEnum<HandymanMaterialApprovedForType>(
    value.type,
    'approvedFor.type',
    ['TENANT_COMPANY', 'TENANT_PIC', 'CUSTOMER'],
    details,
  );
  if (!type) return undefined;
  return { type };
}

export function parseDecideMaterialApprovalAssistedHttpBody(body: unknown): {
  decision: HandymanMaterialApprovalDecision;
  approvedFor: { type: HandymanMaterialApprovedForType };
  notes: string;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, DECIDE_MATERIAL_APPROVAL_ASSISTED_HTTP_BODY_FIELDS, details);
  const decision = readEnum<HandymanMaterialApprovalDecision>(
    body.decision,
    'decision',
    ['APPROVED', 'REJECTED'],
    details,
  );
  const approvedFor =
    body.approvedFor === undefined
      ? (details.push({ field: 'approvedFor', message: 'approvedFor is required.' }), undefined)
      : readApprovedForClass(body.approvedFor, details);
  const notes = readRequiredText(body.notes, 'notes', 2000, details);
  if (details.length > 0 || !decision || !approvedFor || !notes) fail(details);
  return {
    decision: decision as HandymanMaterialApprovalDecision,
    approvedFor: approvedFor as { type: HandymanMaterialApprovedForType },
    notes: notes as string,
  };
}

export const RESERVE_MATERIAL_HTTP_BODY_FIELDS = [
  'warehouseId',
  'itemId',
  'uomId',
  'quantity',
  'notes',
] as const;

export function parseReserveMaterialHttpBody(body: unknown): {
  warehouseId: string;
  itemId?: string | null;
  uomId?: string | null;
  quantity: string;
  notes?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, RESERVE_MATERIAL_HTTP_BODY_FIELDS, details);
  const warehouseId =
    body.warehouseId === undefined
      ? (details.push({ field: 'warehouseId', message: 'warehouseId is required.' }), undefined)
      : readUuid(body.warehouseId, 'warehouseId', details);
  const itemId = readOptionalUuid(body.itemId, 'itemId', details);
  const uomId = readOptionalUuid(body.uomId, 'uomId', details);
  const quantity =
    body.quantity === undefined
      ? (details.push({ field: 'quantity', message: 'quantity is required.' }), undefined)
      : readQuantity(body.quantity, details);
  const notes = readOptionalText(body.notes, 'notes', 1000, details);
  if (details.length > 0 || !warehouseId || !quantity) fail(details);
  return {
    warehouseId: warehouseId as string,
    ...(itemId === undefined ? {} : { itemId }),
    ...(uomId === undefined ? {} : { uomId }),
    quantity: quantity as string,
    ...(notes === undefined ? {} : { notes }),
  };
}

/** Release/cancel carry NO business body (service input is id + header key). */
export function assertEmptyTerminalReservationHttpBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (Object.keys(body).length > 0) {
    fail(
      Object.keys(body).map((key) => ({
        field: key,
        message:
          MATERIAL_OPERATIONS_PROTECTED_FIELDS[key] ??
          'This command accepts no business body; the reservation comes from the route.',
      })),
    );
  }
}

export const ISSUE_MATERIAL_HTTP_BODY_FIELDS = [
  'warehouseId',
  'itemId',
  'uomId',
  'inventoryMaterialReservationId',
  'handymanServiceVisitId',
  'handymanWorkSessionId',
  'quantity',
  'issuedAt',
  'reference',
  'notes',
] as const;

export function parseIssueMaterialHttpBody(body: unknown): {
  warehouseId: string;
  itemId?: string | null;
  uomId?: string | null;
  inventoryMaterialReservationId?: string | null;
  handymanServiceVisitId?: string | null;
  handymanWorkSessionId?: string | null;
  quantity: string;
  issuedAt?: string | null;
  reference?: string | null;
  notes?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, ISSUE_MATERIAL_HTTP_BODY_FIELDS, details);
  const warehouseId =
    body.warehouseId === undefined
      ? (details.push({ field: 'warehouseId', message: 'warehouseId is required.' }), undefined)
      : readUuid(body.warehouseId, 'warehouseId', details);
  const itemId = readOptionalUuid(body.itemId, 'itemId', details);
  const uomId = readOptionalUuid(body.uomId, 'uomId', details);
  const inventoryMaterialReservationId = readOptionalUuid(
    body.inventoryMaterialReservationId,
    'inventoryMaterialReservationId',
    details,
  );
  const handymanServiceVisitId = readOptionalUuid(
    body.handymanServiceVisitId,
    'handymanServiceVisitId',
    details,
  );
  const handymanWorkSessionId = readOptionalUuid(
    body.handymanWorkSessionId,
    'handymanWorkSessionId',
    details,
  );
  const quantity =
    body.quantity === undefined
      ? (details.push({ field: 'quantity', message: 'quantity is required.' }), undefined)
      : readQuantity(body.quantity, details);
  const issuedAt = readOptionalDateTime(body.issuedAt, 'issuedAt', details);
  const reference = readOptionalText(body.reference, 'reference', 200, details);
  const notes = readOptionalText(body.notes, 'notes', 1000, details);
  if (details.length > 0 || !warehouseId || !quantity) fail(details);
  return {
    warehouseId: warehouseId as string,
    ...(itemId === undefined ? {} : { itemId }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(inventoryMaterialReservationId === undefined ? {} : { inventoryMaterialReservationId }),
    ...(handymanServiceVisitId === undefined ? {} : { handymanServiceVisitId }),
    ...(handymanWorkSessionId === undefined ? {} : { handymanWorkSessionId }),
    quantity: quantity as string,
    ...(issuedAt === undefined ? {} : { issuedAt }),
    ...(reference === undefined ? {} : { reference }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export const RECORD_MATERIAL_USAGE_HTTP_BODY_FIELDS = [
  'handymanMaterialControlledIssueId',
  'handymanServiceVisitId',
  'handymanWorkSessionId',
  'usageKind',
  'quantity',
  'usedAt',
  'notes',
] as const;

export function parseRecordMaterialUsageHttpBody(body: unknown): {
  handymanMaterialControlledIssueId?: string | null;
  handymanServiceVisitId?: string | null;
  handymanWorkSessionId?: string | null;
  usageKind?: HandymanMaterialUsageKind;
  quantity: string;
  usedAt?: string | null;
  notes?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, RECORD_MATERIAL_USAGE_HTTP_BODY_FIELDS, details);
  const handymanMaterialControlledIssueId = readOptionalUuid(
    body.handymanMaterialControlledIssueId,
    'handymanMaterialControlledIssueId',
    details,
  );
  const handymanServiceVisitId = readOptionalUuid(
    body.handymanServiceVisitId,
    'handymanServiceVisitId',
    details,
  );
  const handymanWorkSessionId = readOptionalUuid(
    body.handymanWorkSessionId,
    'handymanWorkSessionId',
    details,
  );
  const usageKind = readOptionalEnum<HandymanMaterialUsageKind>(
    body.usageKind,
    'usageKind',
    ['USED', 'INSTALLED'],
    details,
  );
  const quantity =
    body.quantity === undefined
      ? (details.push({ field: 'quantity', message: 'quantity is required.' }), undefined)
      : readQuantity(body.quantity, details);
  const usedAt = readOptionalDateTime(body.usedAt, 'usedAt', details);
  const notes = readOptionalText(body.notes, 'notes', 1000, details);
  if (details.length > 0 || !quantity) fail(details);
  return {
    ...(handymanMaterialControlledIssueId === undefined
      ? {}
      : { handymanMaterialControlledIssueId }),
    ...(handymanServiceVisitId === undefined ? {} : { handymanServiceVisitId }),
    ...(handymanWorkSessionId === undefined ? {} : { handymanWorkSessionId }),
    ...(usageKind === undefined || usageKind === null ? {} : { usageKind }),
    quantity: quantity as string,
    ...(usedAt === undefined ? {} : { usedAt }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export const RETURN_MATERIAL_HTTP_BODY_FIELDS = [
  'quantity',
  'returnedAt',
  'reference',
  'notes',
] as const;

export function parseReturnMaterialHttpBody(body: unknown): {
  quantity: string;
  returnedAt?: string | null;
  reference?: string | null;
  notes?: string | null;
} {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  assertAllowedFields(body, RETURN_MATERIAL_HTTP_BODY_FIELDS, details);
  const quantity =
    body.quantity === undefined
      ? (details.push({ field: 'quantity', message: 'quantity is required.' }), undefined)
      : readQuantity(body.quantity, details);
  const returnedAt = readOptionalDateTime(body.returnedAt, 'returnedAt', details);
  const reference = readOptionalText(body.reference, 'reference', 200, details);
  const notes = readOptionalText(body.notes, 'notes', 1000, details);
  if (details.length > 0 || !quantity) fail(details);
  return {
    quantity: quantity as string,
    ...(returnedAt === undefined ? {} : { returnedAt }),
    ...(reference === undefined ? {} : { reference }),
    ...(notes === undefined ? {} : { notes }),
  };
}
