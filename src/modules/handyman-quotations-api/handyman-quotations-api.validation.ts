import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_QUOTATION_CURRENCIES,
  HANDYMAN_QUOTATION_DECISIONS,
  HANDYMAN_QUOTATION_LINE_ORIGIN_KINDS,
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

function fail(message: string, details: { field: string; message: string }[]): never {
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

export function parseQuotationDpTermsBody(body: unknown): {
  dpRequired?: boolean;
  dpPercentage?: number | null;
  dpAmount?: number | null;
  dpTermsNotes?: string | null;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: {
    dpRequired?: boolean;
    dpPercentage?: number | null;
    dpAmount?: number | null;
    dpTermsNotes?: string | null;
  } = {};
  if (src.dpRequired !== undefined) {
    if (typeof src.dpRequired !== 'boolean') {
      return fail('Request validation failed.', [
        { field: 'dpRequired', message: 'dpRequired must be a boolean.' },
      ]);
    }
    out.dpRequired = src.dpRequired;
  }
  if (src.dpPercentage !== undefined) {
    if (src.dpPercentage === null) {
      out.dpPercentage = null;
    } else if (typeof src.dpPercentage === 'number' && Number.isFinite(src.dpPercentage)) {
      out.dpPercentage = src.dpPercentage;
    } else {
      fail('Request validation failed.', [
        { field: 'dpPercentage', message: 'dpPercentage must be a finite number or null.' },
      ]);
    }
  }
  if (src.dpAmount !== undefined) {
    if (src.dpAmount === null) {
      out.dpAmount = null;
    } else if (typeof src.dpAmount === 'number' && Number.isFinite(src.dpAmount)) {
      out.dpAmount = src.dpAmount;
    } else {
      fail('Request validation failed.', [
        { field: 'dpAmount', message: 'dpAmount must be a finite number or null.' },
      ]);
    }
  }
  if (src.dpTermsNotes !== undefined) {
    if (src.dpTermsNotes === null) {
      out.dpTermsNotes = null;
    } else if (typeof src.dpTermsNotes === 'string') {
      out.dpTermsNotes = src.dpTermsNotes.trim();
    } else {
      fail('Request validation failed.', [
        { field: 'dpTermsNotes', message: 'dpTermsNotes must be a string or null.' },
      ]);
    }
  }
  return out;
}

/**
 * POST /quotations/:id/versions — a DRAFT revision. Optional DP terms (a
 * declared policy replaces the predecessor's; omitting every DP key INHERITS
 * the predecessor's policy instead of silently resetting it) and the
 * manual-origin carry-forward SELECTION, which is the only authorized way to
 * remove a line from a manual quotation (nothing is deleted: the new immutable
 * snapshot simply omits the line). IDs are validated as UUIDs and bounded; they
 * must belong to the immediately previous version, which the service verifies.
 */
export function parseQuotationRevisionBody(body: unknown): {
  dpRequired?: boolean;
  dpPercentage?: number | null;
  dpAmount?: number | null;
  dpTermsNotes?: string | null;
  carryForwardLineIds?: string[];
} {
  const src = (body ?? {}) as Record<string, unknown>;
  const dpTerms = parseQuotationDpTermsBody(src);
  if (
    src.carryForwardLineIds === undefined ||
    src.carryForwardLineIds === null
  ) {
    return dpTerms;
  }
  if (!Array.isArray(src.carryForwardLineIds)) {
    return fail('Request validation failed.', [
      {
        field: 'carryForwardLineIds',
        message: 'carryForwardLineIds must be an array of line UUIDs.',
      },
    ]);
  }
  if (src.carryForwardLineIds.length > 200) {
    return fail('Request validation failed.', [
      {
        field: 'carryForwardLineIds',
        message: 'carryForwardLineIds may carry at most 200 lines.',
      },
    ]);
  }
  const carryForwardLineIds = src.carryForwardLineIds.map((value) =>
    uuid(value, 'carryForwardLineIds'),
  );
  return { ...dpTerms, carryForwardLineIds };
}

/** POST /requests/:id/quotation — request identity comes from the URL; optional DP terms may be supplied. */
export function parseQuotationCreate(body?: unknown): {
  dpRequired?: boolean;
  dpPercentage?: number | null;
  dpAmount?: number | null;
  dpTermsNotes?: string | null;
} {
  return parseQuotationDpTermsBody(body);
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
  /*
   * CR-HM-MANUAL-QUOTATION-01 PART 03A: the optional origin DECLARATION is
   * whitelisted here, but it is never self-granting — the service re-derives
   * the authoritative origin from the parent request's lane (a CATALOG claim on
   * the manual/unlisted-intake lane and an ungrounded MANUAL_ONE_TIME claim on
   * the catalog lane are both refused) and the database law (0489) backstops
   * it. Unknown keys are still dropped by this explicit whitelist.
   */
  let originKind: AddHandymanQuotationLineInput['originKind'];
  if (src.originKind !== undefined && src.originKind !== null) {
    if (
      typeof src.originKind !== 'string' ||
      !(HANDYMAN_QUOTATION_LINE_ORIGIN_KINDS as readonly string[]).includes(
        src.originKind,
      )
    ) {
      fail('Request validation failed.', [
        {
          field: 'originKind',
          message: 'originKind must be CATALOG or MANUAL_ONE_TIME.',
        },
      ]);
    }
    originKind = src.originKind as AddHandymanQuotationLineInput['originKind'];
  }
  return {
    lineType: lineType as AddHandymanQuotationLineInput['lineType'],
    description,
    quantity,
    uomId,
    currency: currency as AddHandymanQuotationLineInput['currency'],
    finalQuotedUnitAmount,
    ...(sourceItemId ? { sourceItemId } : {}),
    ...(originKind ? { originKind } : {}),
  };
}

export function parseQuotationIssueBody(body: unknown): {
  validUntil: string;
  dpRequired?: boolean;
  dpPercentage?: number | null;
  dpAmount?: number | null;
  dpTermsNotes?: string | null;
  documentLanguage?: 'id' | 'en';
} {
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
  if (src.documentLanguage !== undefined && src.documentLanguage !== 'id' && src.documentLanguage !== 'en') {
    fail('Request validation failed.', [{ field: 'documentLanguage', message: 'documentLanguage must be id or en.' }]);
  }
  return {
    validUntil,
    ...parseQuotationDpTermsBody(body),
    ...(src.documentLanguage ? { documentLanguage: src.documentLanguage as 'id' | 'en' } : {}),
  };
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
