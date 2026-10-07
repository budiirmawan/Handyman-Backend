import { Buffer } from 'node:buffer';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  CMS_CONTENT_STATUSES,
  CMS_CONTENT_TYPES,
  type CmsContentFilters,
  type CmsContentStatus,
  type CmsContentType,
  type CreateCmsContentInput,
  type UpdateCmsContentInput,
} from './cms-content.types';

type Detail = { field: string; message: string };
const SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const RAW_HTML = /<\s*\/?\s*[a-z][^>]*>/i;
const UNSAFE_PROTOCOL = /(?:javascript|vbscript|data|file)\s*:/i;
const EVENT_HANDLER = /\bon[a-z]+\s*=/i;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export const parseCmsContentClientId = (value: string): string =>
  parseUuid(value, 'clientId');
export const parseCmsContentBuildingId = (value: string): string =>
  parseUuid(value, 'buildingId');
export const parseCmsContentId = (value: string): string =>
  parseUuid(value, 'cmsContentId');

function readContentType(
  value: unknown,
  details: Detail[],
  required: boolean,
): CmsContentType | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (
    typeof normalized !== 'string' ||
    !(CMS_CONTENT_TYPES as readonly string[]).includes(normalized)
  ) {
    details.push({
      field: 'contentType',
      message: `contentType must be one of: ${CMS_CONTENT_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized as CmsContentType;
}

function readStatus(
  value: unknown,
  details: Detail[],
  required: boolean,
): CmsContentStatus | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (
    typeof normalized !== 'string' ||
    !(CMS_CONTENT_STATUSES as readonly string[]).includes(normalized)
  ) {
    details.push({
      field: 'status',
      message: `status must be one of: ${CMS_CONTENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized as CmsContentStatus;
}

function readSlug(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'slug', message: 'slug is required.' });
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 1 || normalized.length > 120 || !SLUG.test(normalized)) {
    details.push({
      field: 'slug',
      message:
        'slug must contain lowercase letters or digits separated by dots, hyphens, or underscores, and be at most 120 characters.',
    });
    return undefined;
  }
  return normalized;
}

function safeText(
  value: unknown,
  field: 'title' | 'body',
  maxBytes: number,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    details.push({ field, message: `${field} must be at most ${maxBytes} bytes.` });
    return undefined;
  }
  if (
    RAW_HTML.test(normalized) ||
    UNSAFE_PROTOCOL.test(normalized) ||
    EVENT_HANDLER.test(normalized) ||
    UNSAFE_CONTROL.test(normalized)
  ) {
    details.push({
      field,
      message:
        `${field} must be safe plain text or Markdown without raw HTML, scripts, event handlers, or unsafe URL schemes.`,
    });
    return undefined;
  }
  return normalized;
}

export function parseCreateCmsContentBody(body: unknown): CreateCmsContentInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['contentType', 'slug', 'title', 'body', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const contentType = readContentType(body.contentType, details, true);
  const slug = readSlug(body.slug, details);
  const title = safeText(body.title, 'title', 240, details);
  const content = safeText(body.body, 'body', 100_000, details);
  const status = body.status === undefined
    ? 'DRAFT'
    : readStatus(body.status, details, true);
  if (details.length > 0 || !contentType || !slug || !title || !content || !status) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { contentType, slug, title, body: content, status };
}

export function parseUpdateCmsContentBody(body: unknown): UpdateCmsContentInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['title', 'body', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const title = body.title === undefined
    ? undefined
    : safeText(body.title, 'title', 240, details);
  const content = body.body === undefined
    ? undefined
    : safeText(body.body, 'body', 100_000, details);
  const status = readStatus(body.status, details, false);
  if (
    body.title === undefined &&
    body.body === undefined &&
    body.status === undefined &&
    details.length === 0
  ) {
    details.push({ field: 'body', message: 'At least one field is required.' });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(content === undefined ? {} : { body: content }),
    ...(status === undefined ? {} : { status }),
  };
}

function singleQuery(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a single string value.` },
    ]);
  }
  return value;
}

export function parseCmsContentFilters(
  contentType: unknown,
  status: unknown,
): CmsContentFilters {
  const details: Detail[] = [];
  const parsedType = readContentType(
    singleQuery(contentType, 'contentType'),
    details,
    false,
  );
  const parsedStatus = readStatus(singleQuery(status, 'status'), details, false);
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(parsedType ? { contentType: parsedType } : {}),
    ...(parsedStatus ? { status: parsedStatus } : {}),
  };
}

export function parseEffectiveCmsContentType(
  contentType: unknown,
): CmsContentType | undefined {
  return parseCmsContentFilters(contentType, undefined).contentType;
}
