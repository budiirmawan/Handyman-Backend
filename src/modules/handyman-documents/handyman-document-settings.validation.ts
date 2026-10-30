/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — settings input validation.
 *
 * Every rule here mirrors a CHECK in migration 0492 or a hard rule of the frozen
 * PDF layout, so an accepted setting can always be rendered and a rejected one is
 * explained by a field-level detail that never echoes the submitted text back.
 * The writable vocabulary is EXACTLY the eight content fields plus the version
 * anchor: a body cannot name a kind, a language, a provider, an amount, a
 * number, an acceptance or a signature, so this parse step is also the escalation
 * guard.
 */
import { handymanDocumentSettingsValidationError } from './handyman-document-settings.errors';
import type { HandymanDocumentSettingsField } from './handyman-document-settings.types';
import {
  HANDYMAN_DOCUMENT_SETTINGS_FIELDS,
  HANDYMAN_DOCUMENT_SETTINGS_LANGUAGES,
  HANDYMAN_DOCUMENT_SETTINGS_KINDS,
  HANDYMAN_DOCUMENT_SETTINGS_REQUIRED_FIELDS,
  isHandymanDocumentSettingsKind,
  isHandymanDocumentSettingsLanguage,
  type HandymanDocumentSettingsContent,
  type HandymanDocumentSettingsLanguage,
  type HandymanDocumentSettingsKind,
  type HandymanDocumentSettingsUpdateInput,
} from './handyman-document-settings.types';
import { HANDYMAN_DOCUMENT_PDF_LIMITS } from './handyman-document-pdf.types';
import { handymanDocumentText } from './handyman-document-format';
import { parseClientIdParam } from './handyman-document-issuer.validation';
import type { FieldIssue } from './handyman-document-issuer.validation';

export { parseClientIdParam, parseHistoryQuery } from './handyman-document-issuer.validation';

const PREFIX = /^[A-Z][A-Z0-9-]{0,14}[A-Z0-9]$/;
/** The same control-character class the renderer refuses (never a guess). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** An account-number-shaped run: payment wording never carries a destination. */
const ACCOUNT_NUMBER_SHAPED = /\d{10,}/;

const MAX_NOTE_LENGTH = HANDYMAN_DOCUMENT_PDF_LIMITS.maxTextLength;
const MAX_TERMS_LINES = HANDYMAN_DOCUMENT_PDF_LIMITS.maxTermsLines;

export type HandymanDocumentSettingsTarget = {
  clientId: string;
  documentKind: HandymanDocumentSettingsKind;
  language: HandymanDocumentSettingsLanguage;
};

function isPlainBody(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Collapses whitespace runs; it never rewrites the text itself. */
function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readText(
  body: Record<string, unknown>,
  field: keyof HandymanDocumentSettingsContent,
  issues: FieldIssue[],
  options: { required: boolean; maxLength: number; label?: string },
): string | null {
  const raw = body[field];
  if (raw === undefined) {
    if (options.required) issues.push({ field, message: `${field} is required.` });
    return null;
  }
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (options.required) issues.push({ field, message: `${field} cannot be empty.` });
    return null;
  }
  if (typeof raw !== 'string') {
    issues.push({ field, message: `${field} must be a string.` });
    return null;
  }
  if (CONTROL_CHARS.test(raw)) {
    issues.push({
      field,
      message: `${field} must not contain control characters.`,
    });
    return null;
  }
  const value = normalizeText(raw);
  if (value.length > options.maxLength) {
    issues.push({
      field,
      message: `${field} must not exceed ${options.maxLength} characters.`,
    });
    return null;
  }
  // Text the frozen layout would erase entirely is refused, not stored to be
  // silently dropped later: what a Manager writes is what a document prints.
  if (handymanDocumentText(value) === '') {
    issues.push({
      field,
      message: `${field} must contain characters the document can render.`,
    });
    return null;
  }
  if (field === 'paymentNote' && ACCOUNT_NUMBER_SHAPED.test(value)) {
    issues.push({
      field,
      message:
        'paymentNote is wording only: an account number never belongs in document settings, because the payment destination comes from the verified bank account.',
    });
    return null;
  }
  if (field === 'documentPrefix') {
    const upper = value.toUpperCase();
    if (!PREFIX.test(upper)) {
      issues.push({
        field,
        message:
          'documentPrefix must be 2-16 uppercase letters, digits or inner dashes, starting with a letter and ending with a letter or digit.',
      });
      return null;
    }
    return upper;
  }
  if (
    (field === 'signatoryName' || field === 'signatoryTitle')
    && !/[A-Za-z\u00c0-\u024f]/.test(value)
  ) {
    issues.push({
      field,
      message: `${field} must contain letters - it names a human being, not a symbol.`,
    });
    return null;
  }
  return value;
}

function readTermsLines(body: Record<string, unknown>, issues: FieldIssue[]): string[] {
  const raw = body.termsLines;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push({ field: 'termsLines', message: 'termsLines must be an array of strings.' });
    return [];
  }
  if (raw.length > MAX_TERMS_LINES) {
    issues.push({
      field: 'termsLines',
      message: `termsLines must not exceed ${MAX_TERMS_LINES} lines.`,
    });
    return [];
  }
  const lines: string[] = [];
  raw.forEach((entry, index) => {
    const field = `termsLines[${index}]`;
    if (typeof entry !== 'string') {
      issues.push({ field, message: 'each terms line must be a string.' });
      return;
    }
    if (CONTROL_CHARS.test(entry)) {
      issues.push({ field, message: 'each terms line must be free of control characters.' });
      return;
    }
    const value = normalizeText(entry);
    if (value === '') {
      issues.push({ field, message: 'each terms line must not be blank.' });
      return;
    }
    if (value.length > MAX_NOTE_LENGTH) {
      issues.push({
        field,
        message: `each terms line must not exceed ${MAX_NOTE_LENGTH} characters.`,
      });
      return;
    }
    if (handymanDocumentText(value) === '') {
      issues.push({
        field,
        message: 'each terms line must contain characters the document can render.',
      });
      return;
    }
    lines.push(value);
  });
  return lines;
}

function readContent(
  body: Record<string, unknown>,
  issues: FieldIssue[],
): HandymanDocumentSettingsContent | null {
  const content = {} as HandymanDocumentSettingsContent;
  for (const field of HANDYMAN_DOCUMENT_SETTINGS_FIELDS) {
    if (field === 'termsLines') continue;
    const required = (
      HANDYMAN_DOCUMENT_SETTINGS_REQUIRED_FIELDS as readonly string[]
    ).includes(field);
    const value = readText(body, field, issues, {
      required,
      maxLength: field === 'documentPrefix' ? 16 : field.startsWith('signatory') ? 120 : MAX_NOTE_LENGTH,
    });
    (content as Record<string, unknown>)[field] = value;
  }
  content.termsLines = readTermsLines(body, issues);
  if (issues.length > 0) return null;
  return content;
}

export function parseSettingsTarget(params: {
  clientId: string | string[] | undefined;
  documentKind: string | string[] | undefined;
  language: string | string[] | undefined;
}): HandymanDocumentSettingsTarget {
  const clientId = parseClientIdParam(params.clientId);
  const issues: FieldIssue[] = [];
  const kindRaw = Array.isArray(params.documentKind) ? params.documentKind[0] : params.documentKind;
  const languageRaw = Array.isArray(params.language) ? params.language[0] : params.language;
  const documentKind = typeof kindRaw === 'string' ? kindRaw.trim().toUpperCase() : '';
  const language = typeof languageRaw === 'string' ? languageRaw.trim().toLowerCase() : '';
  if (!isHandymanDocumentSettingsKind(documentKind)) {
    issues.push({
      field: 'documentKind',
      message: `documentKind must be one of: ${HANDYMAN_DOCUMENT_SETTINGS_KINDS.join(', ')}.`,
    });
  }
  if (!isHandymanDocumentSettingsLanguage(language)) {
    issues.push({
      field: 'language',
      message: `language must be one of: ${HANDYMAN_DOCUMENT_SETTINGS_LANGUAGES.join(', ')}.`,
    });
  }
  if (issues.length > 0) throw handymanDocumentSettingsValidationError(issues);
  return {
    clientId,
    documentKind: documentKind as HandymanDocumentSettingsKind,
    language: language as HandymanDocumentSettingsLanguage,
  };
}

export function parseSettingsUpdate(
  body: unknown,
  target: HandymanDocumentSettingsTarget,
): HandymanDocumentSettingsUpdateInput {
  const issues: FieldIssue[] = [];
  if (!isPlainBody(body)) {
    throw handymanDocumentSettingsValidationError([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const allowed: Array<HandymanDocumentSettingsField | 'expectedVersion'> = [
    ...HANDYMAN_DOCUMENT_SETTINGS_FIELDS,
    'expectedVersion',
  ];
  for (const key of Object.keys(body)) {
    if (!(allowed as string[]).includes(key)) {
      issues.push({
        field: key,
        message:
          'Unsupported field for Handyman document settings: only wording, prefix and signatory identity are configurable.',
      });
    }
  }
  const expectedVersion: number | null | undefined = body.expectedVersion as
    | number
    | null
    | undefined;
  if (expectedVersion === undefined) {
    issues.push({
      field: 'expectedVersion',
      message:
        'expectedVersion is required: send the version you read, or null when this document type has no settings yet.',
    });
  } else if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    issues.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be null or a positive integer.',
    });
  }
  const content = readContent(body, issues);
  if (issues.length > 0 || !content) {
    throw handymanDocumentSettingsValidationError(
      issues.length > 0
        ? issues
        : [{ field: 'body', message: 'A complete settings record must be supplied.' }],
    );
  }
  return {
    ...target,
    expectedVersion: (expectedVersion ?? null) as number | null,
    ...content,
  };
}
