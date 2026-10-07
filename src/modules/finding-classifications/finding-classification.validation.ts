import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FINDING_CLASSIFICATION_STATUSES,
  isFindingClassificationStatus,
  type CreateFindingClassificationInput,
  type FindingClassificationStatus,
  type UpdateFindingClassificationInput,
} from './finding-classification.types';

const CODE = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE = 64;
const MAX_NAME = 160;
const MAX_DESCRIPTION = 512;
type Detail = { field: string; message: string };

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function normalizeFindingClassificationCode(value: string): string {
  return value.trim().toUpperCase();
}
export function isValidFindingClassificationCode(value: string): boolean {
  return value.length >= 2 && value.length <= MAX_CODE && CODE.test(value);
}
export function parseFindingClassificationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) fail([{ field: 'findingClassificationId', message: 'Finding classification id must be a valid UUID.' }]);
  return value.toLowerCase();
}
export function parseFindingClassificationClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) fail([{ field: 'clientId', message: 'Client id must be a valid UUID.' }]);
  return value.toLowerCase();
}

export function parseCreateFindingClassificationBody(
  body: unknown,
): Omit<CreateFindingClassificationInput, 'clientId'> {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readDescription(body.description, details);
  const status = readStatus(body.status, details);
  if (!code || !name || details.length) fail(details);
  return { code, name, ...(typeof description === 'string' ? { description } : {}), ...(status === undefined ? {} : { status }) };
}

export function parseUpdateFindingClassificationBody(
  body: unknown,
): UpdateFindingClassificationInput {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const name = body.name === undefined ? undefined : readName(body.name, details);
  const description = body.description === undefined ? undefined : readDescription(body.description, details, true);
  const status = body.status === undefined ? undefined : readStatus(body.status, details);
  if (details.length) fail(details);
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), ...(status === undefined ? {} : { status }) };
}

function readCode(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') { details.push({ field: 'code', message: 'Finding classification code is required.' }); return undefined; }
  const code = normalizeFindingClassificationCode(value);
  if (!isValidFindingClassificationCode(code)) { details.push({ field: 'code', message: 'Finding classification code is invalid.' }); return undefined; }
  return code;
}
function readName(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) { details.push({ field: 'name', message: 'Finding classification name is required.' }); return undefined; }
  const name = value.trim();
  if (name.length > MAX_NAME) { details.push({ field: 'name', message: `name must be at most ${MAX_NAME} characters.` }); return undefined; }
  return name;
}
function readDescription(value: unknown, details: Detail[], nullable = false): string | null | undefined {
  if (value === undefined || value === null) return value === null && nullable ? null : undefined;
  if (typeof value !== 'string') { details.push({ field: 'description', message: 'description must be a string.' }); return undefined; }
  const description = value.trim();
  if (!description) return nullable ? null : undefined;
  if (description.length > MAX_DESCRIPTION) { details.push({ field: 'description', message: `description must be at most ${MAX_DESCRIPTION} characters.` }); return undefined; }
  return description;
}
function readStatus(value: unknown, details: Detail[]): FindingClassificationStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isFindingClassificationStatus(value)) { details.push({ field: 'status', message: `Status must be one of: ${FINDING_CLASSIFICATION_STATUSES.join(', ')}.` }); return undefined; }
  return value;
}
