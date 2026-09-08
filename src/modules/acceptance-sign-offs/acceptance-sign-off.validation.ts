import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isSignOffDecision, SIGN_OFF_DECISIONS, type SignOffDecision } from './acceptance-sign-off.types';

export type ValidationDetail = { field: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function fail(d: ValidationDetail[]): never { throw AppError.validation('Request validation failed.', d); }

function readUuid(v: unknown, field: string, required: boolean, d: ValidationDetail[]): string | undefined {
  if (v === undefined || v === null) { if (required) d.push({ field, message: `${field} is required.` }); return undefined; }
  if (typeof v !== 'string' || !isValidUuid(v.trim())) { d.push({ field, message: `${field} must be a valid UUID.` }); return undefined; }
  return v.trim().toLowerCase();
}
function readOptionalString(v: unknown, field: string, max: number, d: ValidationDetail[]): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') { d.push({ field, message: `${field} must be a string or null.` }); return undefined; }
  const t = v.trim(); if (t === '') return null; if (t.length > max) d.push({ field, message: `${field} must be at most ${max} characters.` }); return t;
}
function readDecision(v: unknown, d: ValidationDetail[]): SignOffDecision | undefined {
  if (v === undefined || v === null) { d.push({ field: 'decision', message: 'decision is required.' }); return undefined; }
  const n = typeof v === 'string' ? v.trim().toUpperCase() : v;
  if (!isSignOffDecision(n)) { d.push({ field: 'decision', message: `decision must be one of: ${SIGN_OFF_DECISIONS.join(', ')}.` }); return undefined; }
  return n;
}

export function parseCreateAcceptanceSignOffBody(body: unknown): { bastDocumentId?: string | null; handoverDocumentId?: string | null; decision: SignOffDecision; notes?: string | null } {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const d: ValidationDetail[] = [];
  const bastDocumentId = readUuid(body.bastDocumentId, 'bastDocumentId', false, d);
  const handoverDocumentId = readUuid(body.handoverDocumentId, 'handoverDocumentId', false, d);
  const decision = readDecision(body.decision, d);
  const notes = readOptionalString(body.notes, 'notes', 4000, d);

  const hasBast = bastDocumentId !== undefined;
  const hasHandover = handoverDocumentId !== undefined;
  if (hasBast === hasHandover) {
    // Exactly one target required
    d.push({ field: 'bastDocumentId', message: 'Provide exactly one of bastDocumentId or handoverDocumentId.' });
  }

  if (!decision || d.length > 0) fail(d);

  return {
    ...(bastDocumentId !== undefined ? { bastDocumentId } : {}),
    ...(handoverDocumentId !== undefined ? { handoverDocumentId } : {}),
    decision: decision!,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseAcceptanceSignOffIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) fail([{ field: 'id', message: 'Sign-off id must be a valid UUID.' }]);
  return v;
}

export function parseAcceptanceSignOffFilters(query: unknown): {
  bastDocumentId?: string;
  handoverDocumentId?: string;
  buildingId?: string;
  contextType?: 'INTERNAL' | 'TENANT' | 'VENDOR';
  decision?: SignOffDecision;
  clientId?: string;
  signerUserId?: string;
} {
  if (!isRecord(query)) return {};
  const d: ValidationDetail[] = [];
  let bastDocumentId: string | undefined;
  let handoverDocumentId: string | undefined;
  let buildingId: string | undefined;
  let contextType: 'INTERNAL' | 'TENANT' | 'VENDOR' | undefined;
  let decision: SignOffDecision | undefined;
  let clientId: string | undefined;
  let signerUserId: string | undefined;

  if (query.bastDocumentId !== undefined) {
    if (typeof query.bastDocumentId !== 'string' || !isValidUuid(query.bastDocumentId.trim())) d.push({ field: 'bastDocumentId', message: 'bastDocumentId must be a valid UUID.' }); else bastDocumentId = query.bastDocumentId.trim().toLowerCase();
  }
  if (query.handoverDocumentId !== undefined) {
    if (typeof query.handoverDocumentId !== 'string' || !isValidUuid(query.handoverDocumentId.trim())) d.push({ field: 'handoverDocumentId', message: 'handoverDocumentId must be a valid UUID.' }); else handoverDocumentId = query.handoverDocumentId.trim().toLowerCase();
  }
  if (query.buildingId !== undefined) {
    if (typeof query.buildingId !== 'string' || !isValidUuid(query.buildingId.trim())) d.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' }); else buildingId = query.buildingId.trim().toLowerCase();
  }
  if (query.contextType !== undefined) {
    const n = typeof query.contextType === 'string' ? query.contextType.trim().toUpperCase() : query.contextType;
    if (n !== 'INTERNAL' && n !== 'TENANT' && n !== 'VENDOR') d.push({ field: 'contextType', message: 'contextType must be one of: INTERNAL, TENANT, VENDOR.' }); else contextType = n as any;
  }
  if (query.decision !== undefined) {
    const n = typeof query.decision === 'string' ? query.decision.trim().toUpperCase() : query.decision;
    if (!isSignOffDecision(n)) d.push({ field: 'decision', message: `decision must be one of: ${SIGN_OFF_DECISIONS.join(', ')}.` }); else decision = n;
  }
  if (query.clientId !== undefined) {
    if (typeof query.clientId !== 'string' || !isValidUuid(query.clientId.trim())) d.push({ field: 'clientId', message: 'clientId must be a valid UUID.' }); else clientId = query.clientId.trim().toLowerCase();
  }
  if (query.signerUserId !== undefined) {
    if (typeof query.signerUserId !== 'string' || !isValidUuid(query.signerUserId.trim())) d.push({ field: 'signerUserId', message: 'signerUserId must be a valid UUID.' }); else signerUserId = query.signerUserId.trim().toLowerCase();
  }
  if (d.length > 0) fail(d);
  return { ...(bastDocumentId ? { bastDocumentId } : {}), ...(handoverDocumentId ? { handoverDocumentId } : {}), ...(buildingId ? { buildingId } : {}), ...(contextType ? { contextType } : {}), ...(decision ? { decision } : {}), ...(clientId ? { clientId } : {}), ...(signerUserId ? { signerUserId } : {}) };
}
