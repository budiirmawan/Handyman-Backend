import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_QUOTATION_CURRENCIES,
  HANDYMAN_QUOTATION_DECISIONS,
  HANDYMAN_QUOTATION_LINE_TYPES,
  type AddHandymanQuotationLineInput,
  type DecideHandymanQuotationInput,
} from '../handyman-quotations';

/**
 * CR-HM-06 PART 07A — Handyman quotation API input validation.
 * Whitelist parsers ONLY: callers may submit exactly the fields an
 * existing PART 01–05 public service consumes. Everything else —
 * clientId, quotation lineage, tenant/company/PIC, building/floor/
 * area/room/space, createdBy/decidedBy, status, lineTotal, reference
 * amounts, executionScopeId, workOrderId, crewId, scheduleId, any
 * arrival/QR/geofence field — is structurally ignored (never spread).
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function fail(message: string, details: { field: string; message: string }[]) {
  throw AppError.validation(message, details);
}

function uuid(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isValidUuid(raw)) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return raw;
}

export function parseQuotationApiUuidParam(
  value: string | string[] | undefined,
  field: string,
): string {
  return uuid(p(value), field);
}

/** POST /requests/:id/quotation — request identity comes from the URL. */
export function parseQuotationCreate(): Record<string, never> {
  return {};
}

export function parseQuotationLineBody(
  body: unknown,
): AddHandymanQuotationLineInput {
  const src = (body ?? {}) as Record<string, unknown>;
  const lineType = typeof src.lineType === 'string' ? src.lineType : '';
  if (
    !(HANDYMAN_QUOTATION_LINE_TYPES as readonly string[]).includes(lineType)
  ) {
    fail('Request validation failed.', [
      { field: 'lineType', message: 'lineType must be LABOR or MATERIAL.' },
    ]);
  }
  const description =
    typeof src.description === 'string' ? src.description.trim() : '';
  if (description.length < 1 || description.length > 1000) {
    fail('Request validation failed.', [
      {
        field: 'description',
        message: 'description is required (1-1000 characters).',
      },
    ]);
  }
  const quantity = typeof src.quantity === 'number' ? src.quantity : NaN;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    fail('Request validation failed.', [
      { field: 'quantity', message: 'quantity must be a number > 0.' },
    ]);
  }
  const finalQuotedUnitAmount =
    typeof src.finalQuotedUnitAmount === 'number'
      ? src.finalQuotedUnitAmount
      : NaN;
  if (!Number.isFinite(finalQuotedUnitAmount) || finalQuotedUnitAmount < 0) {
    fail('Request validation failed.', [
      {
        field: 'finalQuotedUnitAmount',
        message: 'finalQuotedUnitAmount must be a number >= 0.',
      },
    ]);
  }
  const uomId = uuid(src.uomId, 'uomId');
  const currency = typeof src.currency === 'string' ? src.currency : '';
  if (
    !(HANDYMAN_QUOTATION_CURRENCIES as readonly string[]).includes(currency)
  ) {
    fail('Request validation failed.', [
      {
        field: 'currency',
        message: 'currency must be one of the governed currencies.',
      },
    ]);
  }
  let sourceItemId: string | undefined;
  if (src.sourceItemId !== undefined && src.sourceItemId !== null) {
    sourceItemId = uuid(src.sourceItemId, 'sourceItemId');
  }
  return {
    lineType: lineType as AddHandymanQuotationLineInput['lineType'],
    description,
    quantity,
    uomId,
    currency: currency as AddHandymanQuotationLineInput['currency'],
    finalQuotedUnitAmount,
    ...(sourceItemId ? { sourceItemId } : {}),
  };
}

export function parseQuotationIssueBody(body: unknown): { validUntil: string } {
  const src = (body ?? {}) as Record<string, unknown>;
  const validUntil =
    typeof src.validUntil === 'string' ? src.validUntil.trim() : '';
  if (validUntil.length < 1 || validUntil.length > 64) {
    fail('Request validation failed.', [
      { field: 'validUntil', message: 'validUntil (ISO 8601) is required.' },
    ]);
  }
  if (!Number.isFinite(new Date(validUntil).getTime())) {
    fail('Request validation failed.', [
      { field: 'validUntil', message: 'validUntil must be a valid ISO date.' },
    ]);
  }
  return { validUntil };
}

export function parseQuotationDecisionBody(body: unknown): {
  decision: DecideHandymanQuotationInput['decision'];
} {
  const src = (body ?? {}) as Record<string, unknown>;
  const decision = typeof src.decision === 'string' ? src.decision : '';
  if (
    !(HANDYMAN_QUOTATION_DECISIONS as readonly string[]).includes(decision)
  ) {
    fail('Request validation failed.', [
      { field: 'decision', message: 'decision must be APPROVE or REJECT.' },
    ]);
  }
  return { decision: decision as DecideHandymanQuotationInput['decision'] };
}
