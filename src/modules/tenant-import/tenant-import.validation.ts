import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isTenantIdentityDocumentType,
  type TenantIdentityDocumentType,
} from '../tenant-companies/tenant-company.types';
import {
  assertPartyIdentity,
  isValidTenantCompanyCode,
  normalizeIdentityDocumentNumber,
  normalizeTenantCompanyCode,
} from '../tenant-companies/tenant-company.validation';
import {
  TENANT_IMPORT_RELATIONS,
  isTenantImportRelation,
  isTenantVerificationStatus,
  rowKeyForParty,
  type TenantImportPicInput,
  type TenantImportRelation,
  type TenantImportRowErrorCode,
  type TenantImportRowInput,
  type TenantImportUnitLinkInput,
  type TenantVerificationStatus,
} from './tenant-import.types';

type Detail = { field: string; message: string };

/** Hard cap per batch: hundreds of rows are the target, 2000 bounds abuse. */
export const MAX_IMPORT_ROWS = 2000;
const MAX_PICS_PER_ROW = 10;
const MAX_LINKS_PER_ROW = 10;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-.\s]{5,}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number, details: Detail[], field: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (required || value !== '') details.push({ field, message: `${field} must be a non-empty string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function optionalEmail(value: unknown, details: Detail[], field = 'email'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim())) {
    details.push({ field, message: `${field} must be a valid email address.` });
    return undefined;
  }
  return value.trim();
}

function optionalPhone(value: unknown, details: Detail[], field = 'phone'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !PHONE_PATTERN.test(value.trim())) {
    details.push({ field, message: `${field} must be a valid phone number.` });
    return undefined;
  }
  return value.trim();
}

function parseParty(raw: unknown, details: Detail[]): TenantImportRowInput['party'] | null {
  if (!object(raw)) {
    details.push({ field: 'party', message: 'party must be a JSON object.' });
    return null;
  }
  const tenantName = str(raw.tenantName, 160, details, 'party.tenantName', true);
  const tenantCodeRaw = raw.tenantCode === undefined || raw.tenantCode === null || raw.tenantCode === ''
    ? undefined
    : str(raw.tenantCode, 64, details, 'party.tenantCode');
  let tenantCode: string | undefined;
  if (tenantCodeRaw !== undefined) {
    tenantCode = normalizeTenantCompanyCode(tenantCodeRaw);
    if (!isValidTenantCompanyCode(tenantCode)) {
      details.push({ field: 'party.tenantCode', message: 'party.tenantCode must match [A-Z][A-Z0-9_-]* (2-64 chars).' });
    }
  }
  const partyKindRaw = raw.partyKind;
  let partyKind: 'INDIVIDUAL' | 'LEGAL_ENTITY' | undefined;
  if (partyKindRaw !== undefined && partyKindRaw !== null) {
    if (partyKindRaw === 'INDIVIDUAL' || partyKindRaw === 'LEGAL_ENTITY') partyKind = partyKindRaw;
    else details.push({ field: 'party.partyKind', message: 'party.partyKind must be INDIVIDUAL or LEGAL_ENTITY.' });
  }
  const legalName = raw.legalName === undefined || raw.legalName === null || raw.legalName === ''
    ? undefined
    : str(raw.legalName, 255, details, 'party.legalName');
  let identityDocumentType: TenantIdentityDocumentType | undefined;
  const identityDocumentTypeRaw = raw.identityDocumentType === undefined || raw.identityDocumentType === null || raw.identityDocumentType === ''
    ? undefined
    : str(raw.identityDocumentType, 32, details, 'party.identityDocumentType')?.toUpperCase();
  if (identityDocumentTypeRaw !== undefined) {
    if (isTenantIdentityDocumentType(identityDocumentTypeRaw)) {
      identityDocumentType = identityDocumentTypeRaw;
    } else {
      details.push({
        field: 'party.identityDocumentType',
        message: 'party.identityDocumentType must be one of: KTP, PASSPORT, KITAS, NPWP, NIB.',
      });
    }
  }
  const identityDocumentNumber = raw.identityDocumentNumber === undefined || raw.identityDocumentNumber === null || raw.identityDocumentNumber === ''
    ? undefined
    : str(raw.identityDocumentNumber, 64, details, 'party.identityDocumentNumber');
  const normalizedNumber = identityDocumentNumber
    ? normalizeIdentityDocumentNumber(identityDocumentNumber)
    : undefined;
  const email = optionalEmail(raw.email, details, 'party.email');
  const phone = optionalPhone(raw.phone, details, 'party.phone');
  const address = raw.address === undefined || raw.address === null || raw.address === ''
    ? undefined
    : str(raw.address, 512, details, 'party.address');
  let status: 'ACTIVE' | 'INACTIVE' | undefined;
  if (raw.status !== undefined && raw.status !== null) {
    if (raw.status === 'ACTIVE' || raw.status === 'INACTIVE') status = raw.status;
    else details.push({ field: 'party.status', message: 'party.status must be ACTIVE or INACTIVE.' });
  }
  if (details.length) return null;
  if (!tenantName) return null;
  try {
    // The single authoritative party-shape rule (shared with create/PATCH).
    assertPartyIdentity(partyKind ?? 'LEGAL_ENTITY', {
      legalName: legalName ?? null,
      identityDocumentType: identityDocumentType ?? null,
      identityDocumentNumber: normalizedNumber ?? null,
    });
  } catch (error) {
    if (error instanceof AppError && Array.isArray(error.details)) {
      for (const detail of error.details as Detail[]) {
        details.push({ field: `party.${detail.field}`, message: detail.message });
      }
    } else {
      details.push({ field: 'party', message: 'party identity fields are invalid.' });
    }
    return null;
  }
  return {
    ...(tenantCode ? { tenantCode: normalizeTenantCompanyCode(tenantCode) } : {}),
    tenantName,
    ...(partyKind ? { partyKind } : {}),
    ...(legalName ? { legalName } : {}),
    ...(identityDocumentType ? { identityDocumentType } : {}),
    ...(normalizedNumber ? { identityDocumentNumber: normalizedNumber } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(status ? { status } : {}),
  };
}

function parsePics(raw: unknown, details: Detail[]): TenantImportPicInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    details.push({ field: 'pics', message: 'pics must be an array.' });
    return [];
  }
  if (raw.length > MAX_PICS_PER_ROW) {
    details.push({ field: 'pics', message: `pics must contain at most ${MAX_PICS_PER_ROW} entries.` });
    return [];
  }
  const seen = new Set<string>();
  const pics: TenantImportPicInput[] = [];
  raw.forEach((entry, index) => {
    const field = `pics[${index}]`;
    const before = details.length;
    if (!object(entry)) {
      details.push({ field, message: `${field} must be a JSON object.` });
      return;
    }
    const picName = str(entry.picName, 160, details, `${field}.picName`, true);
    const email = optionalEmail(entry.email, details, `${field}.email`);
    const phone = optionalPhone(entry.phone, details, `${field}.phone`);
    const roleTitle = entry.roleTitle === undefined || entry.roleTitle === null || entry.roleTitle === ''
      ? undefined
      : str(entry.roleTitle, 120, details, `${field}.roleTitle`);
    let isPrimary: boolean | undefined;
    if (entry.isPrimary !== undefined && entry.isPrimary !== null) {
      if (typeof entry.isPrimary === 'boolean') isPrimary = entry.isPrimary;
      else details.push({ field: `${field}.isPrimary`, message: `${field}.isPrimary must be a boolean.` });
    }
    let status: 'ACTIVE' | 'INACTIVE' | undefined;
    if (entry.status !== undefined && entry.status !== null) {
      if (entry.status === 'ACTIVE' || entry.status === 'INACTIVE') status = entry.status;
      else details.push({ field: `${field}.status`, message: `${field}.status must be ACTIVE or INACTIVE.` });
    }
    if (details.length > before) return;
    if (!picName) return;
    const identity = (email ?? picName).trim().toLowerCase();
    if (seen.has(identity)) {
      details.push({ field, message: `${field} duplicates another PIC in the same row (email/name).` });
      return;
    }
    seen.add(identity);
    pics.push({
      picName,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(roleTitle ? { roleTitle } : {}),
      ...(isPrimary !== undefined ? { isPrimary } : {}),
      ...(status ? { status } : {}),
    });
  });
  return pics;
}

function parseIsoDate(value: unknown, field: string, details: Detail[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    details.push({ field, message: `${field} must be an ISO-8601 date-time.` });
    return undefined;
  }
  return new Date(value).toISOString();
}

function parseUnitLinks(raw: unknown, details: Detail[]): TenantImportUnitLinkInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    details.push({ field: 'unitLinks', message: 'unitLinks must be an array.' });
    return [];
  }
  if (raw.length > MAX_LINKS_PER_ROW) {
    details.push({ field: 'unitLinks', message: `unitLinks must contain at most ${MAX_LINKS_PER_ROW} entries.` });
    return [];
  }
  const links: TenantImportUnitLinkInput[] = [];
  raw.forEach((entry, index) => {
    const field = `unitLinks[${index}]`;
    const before = details.length;
    if (!object(entry)) {
      details.push({ field, message: `${field} must be a JSON object.` });
      return;
    }
    const buildingId = str(entry.buildingId, 64, details, `${field}.buildingId`, true);
    if (buildingId && !isValidUuid(buildingId)) {
      details.push({ field: `${field}.buildingId`, message: `${field}.buildingId must be a UUID.` });
    }
    const unitId = entry.unitId === undefined || entry.unitId === null || entry.unitId === ''
      ? undefined
      : str(entry.unitId, 64, details, `${field}.unitId`);
    if (unitId && !isValidUuid(unitId)) {
      details.push({ field: `${field}.unitId`, message: `${field}.unitId must be a UUID.` });
    }
    const unitCode = entry.unitCode === undefined || entry.unitCode === null || entry.unitCode === ''
      ? undefined
      : str(entry.unitCode, 64, details, `${field}.unitCode`);
    if (!unitId && !unitCode) {
      details.push({ field, message: `${field} requires unitId or unitCode.` });
    }
    let relation: TenantImportRelation | undefined;
    if (isTenantImportRelation(entry.relation)) relation = entry.relation;
    else {
      details.push({
        field: `${field}.relation`,
        message: `${field}.relation must be one of: ${TENANT_IMPORT_RELATIONS.join(', ')}.`,
      });
    }
    const effectiveFrom = parseIsoDate(entry.effectiveFrom, `${field}.effectiveFrom`, details);
    const effectiveUntil = parseIsoDate(entry.effectiveUntil, `${field}.effectiveUntil`, details);
    if (effectiveFrom && effectiveUntil && Date.parse(effectiveUntil) < Date.parse(effectiveFrom)) {
      details.push({ field: `${field}.effectiveUntil`, message: `${field}.effectiveUntil must not be before effectiveFrom.` });
    }
    let replaceExisting: boolean | undefined;
    if (entry.replaceExisting !== undefined && entry.replaceExisting !== null) {
      if (typeof entry.replaceExisting === 'boolean') replaceExisting = entry.replaceExisting;
      else details.push({ field: `${field}.replaceExisting`, message: `${field}.replaceExisting must be a boolean.` });
    }
    if (details.length > before) return;
    if (!buildingId || !relation) return;
    links.push({
      buildingId: buildingId.toLowerCase(),
      ...(unitId ? { unitId: unitId.toLowerCase() } : {}),
      ...(unitCode ? { unitCode } : {}),
      relation,
      ...(effectiveFrom ? { effectiveFrom } : {}),
      ...(effectiveUntil ? { effectiveUntil } : {}),
      ...(replaceExisting !== undefined ? { replaceExisting } : {}),
    });
  });
  return links;
}

export type ParsedRow =
  | { ok: true; row: TenantImportRowInput; rowKey: string }
  | {
      ok: false;
      rowKey: string;
      error: { code: TenantImportRowErrorCode; message: string };
    };

/**
 * Structural row parse (no database). `rowKey` is always derivable so the
 * row can be stored and shown with its own per-row error.
 */
export function parseImportRow(raw: unknown, rowNumber: number): ParsedRow {
  const details: Detail[] = [];
  if (!object(raw)) {
    return {
      ok: false,
      rowKey: `ROW:${rowNumber}`,
      error: { code: 'VALIDATION', message: 'Row must be a JSON object.' },
    };
  }
  const externalRef = raw.externalRef === undefined || raw.externalRef === null || raw.externalRef === ''
    ? undefined
    : str(raw.externalRef, 120, details, 'externalRef');
  const hasParty = object(raw.party) && Object.keys(raw.party).length > 0;
  if (!hasParty) {
    return {
      ok: false,
      rowKey: `ROW:${rowNumber}`,
      error: {
        code: 'PARTY_REQUIRED',
        message:
          'A row must carry the real party being registered; placeholder parties are never created for Units with unknown occupants.',
      },
    };
  }
  const party = parseParty(raw.party, details);
  if (!party) {
    const message = details.map((d) => `${d.field}: ${d.message}`).join(' ');
    const rawParty = object(raw.party) ? raw.party : {};
    return {
      ok: false,
      rowKey: rowKeyForParty({
        tenantCode: typeof rawParty.tenantCode === 'string' ? rawParty.tenantCode : undefined,
        tenantName: typeof rawParty.tenantName === 'string' ? rawParty.tenantName : undefined,
        identityDocumentType: typeof rawParty.identityDocumentType === 'string' ? rawParty.identityDocumentType : undefined,
        identityDocumentNumber: typeof rawParty.identityDocumentNumber === 'string' ? rawParty.identityDocumentNumber : undefined,
        email: typeof rawParty.email === 'string' ? rawParty.email : undefined,
      }),
      error: { code: 'VALIDATION', message: message || 'party is invalid.' },
    };
  }
  let verificationStatus: TenantVerificationStatus | undefined;
  if (raw.verificationStatus !== undefined && raw.verificationStatus !== null) {
    if (
      isTenantVerificationStatus(raw.verificationStatus) &&
      raw.verificationStatus !== 'REJECTED'
    ) {
      verificationStatus = raw.verificationStatus;
    } else {
      details.push({
        field: 'verificationStatus',
        message: 'verificationStatus must be PENDING_VERIFICATION or VERIFIED.',
      });
    }
  }
  const pics = parsePics(raw.pics, details);
  const unitLinks = parseUnitLinks(raw.unitLinks, details);
  if (details.length) {
    return {
      ok: false,
      rowKey: rowKeyForParty(party),
      error: {
        code: 'VALIDATION',
        message: details.map((d) => `${d.field}: ${d.message}`).join(' '),
      },
    };
  }
  return {
    ok: true,
    rowKey: rowKeyForParty(party),
    row: {
      ...(externalRef ? { externalRef } : {}),
      party,
      ...(verificationStatus ? { verificationStatus } : {}),
      ...(pics.length ? { pics } : {}),
      ...(unitLinks.length ? { unitLinks } : {}),
    },
  };
}

export function parseUploadBody(body: unknown): {
  sourceName: string;
  idempotencyKey?: string;
  rows: unknown[];
} {
  if (!object(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  const sourceName =
    body.sourceName === undefined || body.sourceName === null || body.sourceName === ''
      ? 'tenant-import'
      : str(body.sourceName, 200, details, 'sourceName');
  let idempotencyKey: string | undefined;
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null && body.idempotencyKey !== '') {
    idempotencyKey = str(body.idempotencyKey, 120, details, 'idempotencyKey');
    if (idempotencyKey && !/^[A-Za-z0-9._:-]{4,120}$/.test(idempotencyKey)) {
      details.push({
        field: 'idempotencyKey',
        message: 'idempotencyKey must be 4-120 chars of [A-Za-z0-9._:-].',
      });
    }
  }
  if (!Array.isArray(body.rows)) {
    details.push({ field: 'rows', message: 'rows must be an array.' });
  } else if (body.rows.length === 0) {
    throw AppError.validation('Request validation failed.', [
      { field: 'rows', message: 'rows must contain at least one row.' },
    ]);
  } else if (body.rows.length > MAX_IMPORT_ROWS) {
    details.push({
      field: 'rows',
      message: `rows must contain at most ${MAX_IMPORT_ROWS} rows per batch.`,
    });
  }
  if (details.length) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    sourceName: sourceName ?? 'tenant-import',
    ...(idempotencyKey ? { idempotencyKey } : {}),
    rows: (body.rows as unknown[]).slice(0, MAX_IMPORT_ROWS),
  };
}

export function parseVerificationStatusParam(value: unknown): TenantVerificationStatus {
  if (!isTenantVerificationStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: 'status must be PENDING_VERIFICATION, VERIFIED or REJECTED.' },
    ]);
  }
  return value;
}
