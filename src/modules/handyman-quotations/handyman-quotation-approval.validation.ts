import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_QUOTATION_APPROVAL_DECISIONS,
  HANDYMAN_QUOTATION_APPROVED_FOR_TYPES,
  type HandymanQuotationApprovalDecision,
} from './handyman-quotation-approval.types';

/**
 * CR-HM-BE-03 RUN 4 — strict HTTP contract for the customer approval
 * surfaces (IN_APP decision, ASSISTED recorded decision, approval reads and
 * the staff secure-link readiness endpoints). The transport layer accepts
 * ONLY the allowlisted fields; every other key — above all the protected
 * authority fields (`approvedFor`/`recordedBy` on the IN_APP decision,
 * `recordedBy` on the ASSISTED decision, token/hash and link lifecycle
 * internals) — is rejected with 400 VALIDATION_ERROR details. All business
 * authority (PIC resolution from the authenticated session, approved-for
 * validation against the request context, lifecycle guards, atomic
 * single-use consumption) stays in the Run 3 services; this module only
 * governs the wire shape.
 */

type Detail = { field: string; message: string };

/** IN_APP decision body allowlist — decision + optional notes ONLY. */
export const DECIDE_APPROVAL_IN_APP_HTTP_BODY_FIELDS = ['decision', 'notes'] as const;

/** ASSISTED decision body allowlist — approvedFor must be explicit. */
export const RECORD_APPROVAL_ASSISTED_HTTP_BODY_FIELDS = [
  'decision',
  'approvedFor',
  'notes',
] as const;

export const ISSUE_APPROVAL_LINK_HTTP_BODY_FIELDS = [
  'recipientName',
  'recipientPhone',
  'recipientEmail',
  'expiresAt',
] as const;

const APPROVAL_PROTECTED_FIELDS: Record<string, string> = {
  id: 'Approval id is server-generated.',
  approvalId: 'Approval identity is resolved by the governed service.',
  quotationId: 'Quotation id comes from the route and is not accepted in the body.',
  quotationRevisionId:
    'The approval is bound to the exact sent revision by the governed service.',
  status: 'Approval status is server-managed by the governed lifecycle.',
  method: 'Decision method is derived from the endpoint, never supplied.',
  decidedAt: 'Timestamps are server-generated.',
  decisionNotes: 'Decision notes are submitted through the notes field.',
  clientId: 'Client identity is derived from the governed quotation.',
  buildingId: 'Building scope is derived from the governed quotation.',
  createdByUserId: 'Created-by identity comes from the authenticated actor.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

/** IN_APP: the caller can NEVER submit approved-for or recorded-by
 * authority — the actor identity comes only from the authenticated session
 * and the approved-for snapshot is resolved by the governed service. */
const IN_APP_DECISION_PROTECTED_FIELDS: Record<string, string> = {
  ...APPROVAL_PROTECTED_FIELDS,
  approvedFor:
    'approvedFor authority cannot be submitted on the IN_APP decision; the approved party is the authenticated linked tenant PIC resolved by the service.',
  approvedForType:
    'approvedFor authority cannot be submitted on the IN_APP decision; the approved party is the authenticated linked tenant PIC resolved by the service.',
  approvedForTenantCompanyId:
    'approvedFor identity is resolved from the governed request context, never supplied.',
  approvedForTenantPicId:
    'approvedFor identity is resolved from the governed request context, never supplied.',
  approvedForName: 'approvedFor snapshot fields are server-resolved.',
  approvedForCustomerName: 'approvedFor snapshot fields are server-resolved.',
  approvedForCustomerPhone: 'approvedFor snapshot fields are server-resolved.',
  approvedForCustomerEmail: 'approvedFor snapshot fields are server-resolved.',
  recordedBy:
    'recordedBy authority cannot be submitted on the IN_APP decision; a direct in-app decision has no staff recorder.',
  recordedByUserId:
    'recordedBy authority cannot be submitted on the IN_APP decision; a direct in-app decision has no staff recorder.',
};

/** ASSISTED: approvedFor must be explicit; recordedBy is ALWAYS the
 * authenticated actor and can never be supplied. */
const ASSISTED_DECISION_PROTECTED_FIELDS: Record<string, string> = {
  ...APPROVAL_PROTECTED_FIELDS,
  approvedForType:
    'The approved-for party type is carried inside the approvedFor object.',
  approvedForTenantCompanyId:
    'approvedFor identity is carried inside the approvedFor object.',
  approvedForTenantPicId: 'approvedFor identity is carried inside the approvedFor object.',
  approvedForName: 'approvedFor snapshot fields are server-resolved.',
  approvedForCustomerName: 'approvedFor snapshot fields are server-resolved.',
  approvedForCustomerPhone: 'approvedFor snapshot fields are server-resolved.',
  approvedForCustomerEmail: 'approvedFor snapshot fields are server-resolved.',
  recordedBy:
    'recordedBy is derived only from the authenticated session; the recording staff actor can never be supplied.',
  recordedByUserId:
    'recordedBy is derived only from the authenticated session; the recording staff actor can never be supplied.',
};

const ISSUE_LINK_PROTECTED_FIELDS: Record<string, string> = {
  id: 'Link id is server-generated.',
  approvalId: 'Approval id comes from the route and is not accepted in the body.',
  quotationId: 'Quotation scope is derived from the governed approval.',
  clientId: 'Client identity is derived from the governed approval.',
  buildingId: 'Building scope is derived from the governed approval.',
  token: 'Tokens are generated server-side with crypto-strong randomness.',
  rawToken: 'Tokens are generated server-side with crypto-strong randomness.',
  tokenHash: 'Token hashes are computed server-side and never accepted.',
  maxUses: 'maxUses is fixed at 1 by the governed schema.',
  usesCount: 'Usage accounting is server-managed.',
  status: 'Link status is server-managed by the governed lifecycle.',
  issuedByUserId: 'Issued-by identity comes from the authenticated actor.',
  issuedAt: 'Timestamps are server-generated.',
  usedAt: 'Timestamps are server-generated.',
  revokedAt: 'Timestamps are server-generated.',
  revokedByUserId: 'Revoked-by identity comes from the authenticated actor.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

const DECISION_VALUES = new Set<string>(HANDYMAN_QUOTATION_APPROVAL_DECISIONS);
const APPROVED_FOR_TYPE_VALUES = new Set<string>(HANDYMAN_QUOTATION_APPROVED_FOR_TYPES);

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

function readDecision(
  value: unknown,
  details: Detail[],
): HandymanQuotationApprovalDecision | null {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'decision', message: 'Decision is required.' });
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!DECISION_VALUES.has(normalized)) {
    details.push({
      field: 'decision',
      message: `Decision must be one of ${HANDYMAN_QUOTATION_APPROVAL_DECISIONS.join(', ')}.`,
    });
    return null;
  }
  return normalized as HandymanQuotationApprovalDecision;
}

/** `POST /handyman-quotations/:quotationId/approvals/in-app-decision` body →
 * `{ decision, notes? }` — the strict allowlist. approvedFor/recordedBy are
 * rejected outright (see protected-field messages). */
export function parseDecideApprovalInAppHttpBody(body: unknown): {
  decision: HandymanQuotationApprovalDecision;
  notes: string | null;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    DECIDE_APPROVAL_IN_APP_HTTP_BODY_FIELDS,
    IN_APP_DECISION_PROTECTED_FIELDS,
    details,
  );

  const decision = readDecision(body.decision, details);

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      details.push({ field: 'notes', message: 'Notes must be a string.' });
    } else if (body.notes.trim().length > 2000) {
      details.push({ field: 'notes', message: 'Notes must be at most 2000 characters.' });
    } else {
      notes = body.notes.trim();
    }
  }

  if (details.length > 0) fail(details);
  return { decision: decision as HandymanQuotationApprovalDecision, notes };
}

/** The explicit approved-for party of an ASSISTED decision — a strict
 * discriminated union; unknown keys inside approvedFor are rejected. */
function parseApprovedFor(
  value: unknown,
  details: Detail[],
):
  | { type: 'TENANT_COMPANY'; tenantCompanyId: string }
  | { type: 'TENANT_PIC'; tenantPicId: string }
  | { type: 'CUSTOMER' }
  | null {
  if (!isRecord(value)) {
    details.push({
      field: 'approvedFor',
      message:
        'approvedFor is required and must explicitly identify the approving party.',
    });
    return null;
  }
  const rawType = value.type;
  if (typeof rawType !== 'string' || rawType.trim() === '') {
    details.push({ field: 'approvedFor.type', message: 'approvedFor.type is required.' });
    return null;
  }
  const type = rawType.trim().toUpperCase();
  if (!APPROVED_FOR_TYPE_VALUES.has(type)) {
    details.push({
      field: 'approvedFor.type',
      message: `approvedFor.type must be one of ${HANDYMAN_QUOTATION_APPROVED_FOR_TYPES.join(', ')}.`,
    });
    return null;
  }

  const allowedKeys: Record<string, string[]> = {
    TENANT_COMPANY: ['type', 'tenantCompanyId'],
    TENANT_PIC: ['type', 'tenantPicId'],
    CUSTOMER: ['type'],
  };
  for (const field of Object.keys(value)) {
    if (!allowedKeys[type].includes(field)) {
      details.push({
        field: `approvedFor.${field}`,
        message: `approvedFor.${field} is not allowed for a ${type} approved-for party.`,
      });
    }
  }

  if (type === 'TENANT_COMPANY') {
    const tenantCompanyId = value.tenantCompanyId;
    if (typeof tenantCompanyId !== 'string' || tenantCompanyId.trim() === '') {
      details.push({
        field: 'approvedFor.tenantCompanyId',
        message: 'approvedFor.tenantCompanyId is required for a TENANT_COMPANY party.',
      });
      return null;
    }
    if (!isValidUuid(tenantCompanyId.trim().toLowerCase())) {
      details.push({
        field: 'approvedFor.tenantCompanyId',
        message: 'approvedFor.tenantCompanyId must be a valid UUID.',
      });
      return null;
    }
    return { type: 'TENANT_COMPANY', tenantCompanyId: tenantCompanyId.trim().toLowerCase() };
  }

  if (type === 'TENANT_PIC') {
    const tenantPicId = value.tenantPicId;
    if (typeof tenantPicId !== 'string' || tenantPicId.trim() === '') {
      details.push({
        field: 'approvedFor.tenantPicId',
        message: 'approvedFor.tenantPicId is required for a TENANT_PIC party.',
      });
      return null;
    }
    if (!isValidUuid(tenantPicId.trim().toLowerCase())) {
      details.push({
        field: 'approvedFor.tenantPicId',
        message: 'approvedFor.tenantPicId must be a valid UUID.',
      });
      return null;
    }
    return { type: 'TENANT_PIC', tenantPicId: tenantPicId.trim().toLowerCase() };
  }

  return { type: 'CUSTOMER' };
}

/** `POST /handyman-quotations/:quotationId/approvals/assisted-decision`
 * body → `{ decision, approvedFor, notes }`; notes are mandatory (the
 * Run 3 service re-asserts the 1..2000 rule for programmatic callers). */
export function parseRecordApprovalAssistedHttpBody(body: unknown): {
  decision: HandymanQuotationApprovalDecision;
  approvedFor:
    | { type: 'TENANT_COMPANY'; tenantCompanyId: string }
    | { type: 'TENANT_PIC'; tenantPicId: string }
    | { type: 'CUSTOMER' };
  notes: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    RECORD_APPROVAL_ASSISTED_HTTP_BODY_FIELDS,
    ASSISTED_DECISION_PROTECTED_FIELDS,
    details,
  );

  const decision = readDecision(body.decision, details);
  const approvedFor = parseApprovedFor(body.approvedFor, details);

  let notes: string | null = null;
  if (body.notes === undefined || body.notes === null) {
    details.push({
      field: 'notes',
      message: 'Decision notes are mandatory for an assisted decision.',
    });
  } else if (typeof body.notes !== 'string') {
    details.push({ field: 'notes', message: 'Notes must be a string.' });
  } else if (body.notes.trim().length === 0) {
    details.push({
      field: 'notes',
      message: 'Decision notes are mandatory for an assisted decision.',
    });
  } else if (body.notes.trim().length > 2000) {
    details.push({ field: 'notes', message: 'Notes must be at most 2000 characters.' });
  } else {
    notes = body.notes.trim();
  }

  if (details.length > 0) fail(details);
  return {
    decision: decision as HandymanQuotationApprovalDecision,
    approvedFor: approvedFor as NonNullable<typeof approvedFor>,
    notes: notes as string,
  };
}

/** `POST /handyman-quotation-approvals/:approvalId/links` body →
 * `{ recipientName, recipientPhone?, recipientEmail?, expiresAt }`. The raw
 * token is generated server-side and returned exactly once; the future
 * expiry check stays in the Run 3 service. */
export function parseIssueApprovalLinkHttpBody(body: unknown): {
  recipientName: string;
  recipientPhone: string | null;
  recipientEmail: string | null;
  expiresAt: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    ISSUE_APPROVAL_LINK_HTTP_BODY_FIELDS,
    ISSUE_LINK_PROTECTED_FIELDS,
    details,
  );

  let recipientName: string | null = null;
  if (typeof body.recipientName !== 'string' || body.recipientName.trim() === '') {
    details.push({ field: 'recipientName', message: 'Recipient name is required.' });
  } else if (body.recipientName.trim().length > 200) {
    details.push({
      field: 'recipientName',
      message: 'Recipient name must be at most 200 characters.',
    });
  } else {
    recipientName = body.recipientName.trim();
  }

  let recipientPhone: string | null = null;
  if (body.recipientPhone !== undefined && body.recipientPhone !== null) {
    if (typeof body.recipientPhone !== 'string' || body.recipientPhone.trim() === '') {
      details.push({
        field: 'recipientPhone',
        message: 'recipientPhone must be a non-empty string or null.',
      });
    } else if (body.recipientPhone.trim().length > 50) {
      details.push({
        field: 'recipientPhone',
        message: 'recipientPhone must be at most 50 characters.',
      });
    } else {
      recipientPhone = body.recipientPhone.trim();
    }
  }

  let recipientEmail: string | null = null;
  if (body.recipientEmail !== undefined && body.recipientEmail !== null) {
    if (typeof body.recipientEmail !== 'string' || body.recipientEmail.trim() === '') {
      details.push({
        field: 'recipientEmail',
        message: 'recipientEmail must be a non-empty string or null.',
      });
    } else if (body.recipientEmail.trim().length > 254) {
      details.push({
        field: 'recipientEmail',
        message: 'recipientEmail must be at most 254 characters.',
      });
    } else {
      recipientEmail = body.recipientEmail.trim();
    }
  }

  let expiresAt: string | null = null;
  if (typeof body.expiresAt !== 'string' || body.expiresAt.trim() === '') {
    details.push({ field: 'expiresAt', message: 'expiresAt is required.' });
  } else if (Number.isNaN(new Date(body.expiresAt.trim()).getTime())) {
    details.push({
      field: 'expiresAt',
      message: 'expiresAt must be a valid ISO-8601 date-time.',
    });
  } else {
    expiresAt = body.expiresAt.trim();
  }

  if (details.length > 0) fail(details);
  return {
    recipientName: recipientName as string,
    recipientPhone,
    recipientEmail,
    expiresAt: expiresAt as string,
  };
}

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export function parseHandymanQuotationApprovalIdParam(raw: string): string {
  return parseUuidParam(raw, 'approvalId', 'Approval id');
}

export function parseHandymanQuotationApprovalLinkIdParam(raw: string): string {
  return parseUuidParam(raw, 'linkId', 'Approval link id');
}
