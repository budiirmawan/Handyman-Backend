import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  rfqComparisonIdempotencyKeyRequiredError,
} from './rfq-comparison.errors';
import type {
  CreateRfqEvaluationInput,
  CreateRfqComparisonInput,
  UpdateRfqEvaluationInput,
} from './rfq-comparison.types';

type ValidationDetail = { field: string; message: string };
const MAX_TEXT = 4000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function uuid(value: unknown, field: string, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function optionalUuid(value: unknown, field: string, details: ValidationDetail[]): string | undefined {
  if (value === undefined) return undefined;
  return uuid(value, field, details);
}

function observation(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) {
    details.push({ field, message: `${field} must be at most ${MAX_TEXT} characters.` });
  }
  return trimmed || null;
}

function idempotency(
  body: Record<string, unknown>,
  header: unknown,
  details: ValidationDetail[],
): string {
  const value = typeof header === 'string' && header.trim()
    ? header.trim()
    : body.idempotencyKey;
  if (typeof value !== 'string' || !value.trim()) {
    throw rfqComparisonIdempotencyKeyRequiredError();
  }
  const trimmed = value.trim();
  if (trimmed.length > 200) {
    details.push({ field: 'idempotencyKey', message: 'idempotencyKey must be at most 200 characters.' });
  }
  return trimmed;
}

export function parseCreateRfqComparisonBody(
  body: unknown,
  header: unknown,
  rfqId: string,
): CreateRfqComparisonInput {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const idempotencyKey = idempotency(body, header, details);
  if (details.length) fail(details);
  return { rfqId, idempotencyKey };
}

export function parseRfqComparisonIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'comparisonId', message: 'comparisonId must be a valid UUID.' }]);
  return value;
}

export function parseRfqEvaluationIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'evaluationId', message: 'evaluationId must be a valid UUID.' }]);
  return value;
}

export function parseRfqIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'rfqId', message: 'rfqId must be a valid UUID.' }]);
  return value;
}

function parseEvaluationFields(body: Record<string, unknown>, details: ValidationDetail[]): Omit<CreateRfqEvaluationInput, 'comparisonRunId' | 'evidenceId' | 'vendorId'>;
function parseEvaluationFields(body: Record<string, unknown>, details: ValidationDetail[]): Omit<CreateRfqEvaluationInput, 'comparisonRunId' | 'evidenceId' | 'vendorId'> {
  const commercialObservation = observation(body.commercialObservation, 'commercialObservation', details);
  const technicalObservation = observation(body.technicalObservation, 'technicalObservation', details);
  const complianceObservation = observation(body.complianceObservation, 'complianceObservation', details);
  const evaluatorNote = observation(body.evaluatorNote ?? body.evaluatorNotes ?? body.note, 'evaluatorNote', details);
  return {
    ...(commercialObservation !== undefined ? { commercialObservation } : {}),
    ...(technicalObservation !== undefined ? { technicalObservation } : {}),
    ...(complianceObservation !== undefined ? { complianceObservation } : {}),
    ...(evaluatorNote !== undefined ? { evaluatorNote } : {}),
  };
}

export function parseCreateRfqEvaluationBody(body: unknown): Omit<CreateRfqEvaluationInput, 'comparisonRunId'> {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const evidenceId = optionalUuid(body.evidenceId, 'evidenceId', details);
  const vendorId = optionalUuid(body.vendorId, 'vendorId', details);
  if (!evidenceId && !vendorId) {
    details.push({ field: 'evidenceId', message: 'Either evidenceId or vendorId is required.' });
  }
  const fields = parseEvaluationFields(body, details);
  if (details.length) fail(details);
  return { ...(evidenceId ? { evidenceId } : {}), ...(vendorId ? { vendorId } : {}), ...fields };
}

export function parseUpdateRfqEvaluationBody(body: unknown): UpdateRfqEvaluationInput {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: ValidationDetail[] = [];
  const fields = parseEvaluationFields(body, details);
  if (details.length) fail(details);
  return fields;
}
