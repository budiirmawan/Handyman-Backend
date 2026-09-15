import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { FINDING_SEVERITY_STATUSES, isFindingSeverityStatus, type CreateFindingSeverityInput, type FindingSeverityStatus, type UpdateFindingSeverityInput } from './finding-severity.types';

const CODE = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE = 64, MAX_NAME = 160, MAX_DESCRIPTION = 512;
type Detail = { field: string; message: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function fail(details: Detail[]): never { throw AppError.validation('Request validation failed.', details); }
export function normalizeFindingSeverityCode(value: string): string { return value.trim().toUpperCase(); }
export function isValidFindingSeverityCode(value: string): boolean { return value.length >= 2 && value.length <= MAX_CODE && CODE.test(value); }
export function parseFindingSeverityIdParam(raw: string): string {
  const value = raw.trim(); if (!isValidUuid(value)) fail([{ field: 'findingSeverityId', message: 'Finding severity id must be a valid UUID.' }]); return value.toLowerCase();
}
export function parseFindingSeverityClientIdParam(raw: string): string {
  const value = raw.trim(); if (!isValidUuid(value)) fail([{ field: 'clientId', message: 'Client id must be a valid UUID.' }]); return value.toLowerCase();
}
export function parseCreateFindingSeverityBody(body: unknown): Omit<CreateFindingSeverityInput, 'clientId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const code = readCode(body.code, details), name = readName(body.name, details), rank = readRank(body.rank, details);
  const description = readDescription(body.description, details), status = readStatus(body.status, details);
  if (!code || !name || rank === undefined || details.length) fail(details);
  return { code, name, rank, ...(typeof description === 'string' ? { description } : {}), ...(status === undefined ? {} : { status }) };
}
export function parseUpdateFindingSeverityBody(body: unknown): UpdateFindingSeverityInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const name = body.name === undefined ? undefined : readName(body.name, details);
  const rank = body.rank === undefined ? undefined : readRank(body.rank, details);
  const description = body.description === undefined ? undefined : readDescription(body.description, details, true);
  const status = body.status === undefined ? undefined : readStatus(body.status, details);
  if (details.length) fail(details);
  return { ...(name === undefined ? {} : { name }), ...(rank === undefined ? {} : { rank }), ...(description === undefined ? {} : { description }), ...(status === undefined ? {} : { status }) };
}
function readCode(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') { details.push({ field: 'code', message: 'Finding severity code is required.' }); return; }
  const code = normalizeFindingSeverityCode(value); if (!isValidFindingSeverityCode(code)) { details.push({ field: 'code', message: 'Finding severity code is invalid.' }); return; } return code;
}
function readName(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) { details.push({ field: 'name', message: 'Finding severity name is required.' }); return; }
  const name = value.trim(); if (name.length > MAX_NAME) { details.push({ field: 'name', message: `name must be at most ${MAX_NAME} characters.` }); return; } return name;
}
function readRank(value: unknown, details: Detail[]): number | undefined {
  if (!Number.isInteger(value) || (value as number) <= 0) { details.push({ field: 'rank', message: 'Severity rank must be a positive integer.' }); return; } return value as number;
}
function readDescription(value: unknown, details: Detail[], nullable = false): string | null | undefined {
  if (value === undefined || value === null) return value === null && nullable ? null : undefined;
  if (typeof value !== 'string') { details.push({ field: 'description', message: 'description must be a string.' }); return; }
  const description = value.trim(); if (!description) return nullable ? null : undefined;
  if (description.length > MAX_DESCRIPTION) { details.push({ field: 'description', message: `description must be at most ${MAX_DESCRIPTION} characters.` }); return; } return description;
}
function readStatus(value: unknown, details: Detail[]): FindingSeverityStatus | undefined {
  if (value === undefined || value === null) return;
  if (!isFindingSeverityStatus(value)) { details.push({ field: 'status', message: `Status must be one of: ${FINDING_SEVERITY_STATUSES.join(', ')}.` }); return; } return value;
}
