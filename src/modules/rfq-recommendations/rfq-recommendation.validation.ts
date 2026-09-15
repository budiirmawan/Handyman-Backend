import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { rfqRecommendationReasonRequiredError } from './rfq-recommendation.errors';
import type {
  CreateRfqAwardInput,
  CreateRfqRecommendationInput,
  RfqRecommendationOutcome,
} from './rfq-recommendation.types';

type Detail = { field: string; message: string };
const MAX_TEXT = 4000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
function uuid(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function text(value: unknown, field: string, required: boolean, details: Detail[]): string | null | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field, message: `${field} is required.` });
    return required ? undefined : value === null ? null : undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string${required ? '' : ' or null'}.` });
    return undefined;
  }
  const result = value.trim();
  if (required && !result) details.push({ field, message: `${field} is required.` });
  if (result.length > MAX_TEXT) details.push({ field, message: `${field} must be at most ${MAX_TEXT} characters.` });
  return result || (required ? null : null);
}

export function parseRfqRecommendationIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'recommendationId', message: 'recommendationId must be a valid UUID.' }]);
  return value;
}
export function parseRfqAwardIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'awardId', message: 'awardId must be a valid UUID.' }]);
  return value;
}
export function parseRfqRecommendationRfqIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'rfqId', message: 'rfqId must be a valid UUID.' }]);
  return value;
}

export function parseCreateRfqRecommendationBody(body: unknown): Omit<CreateRfqRecommendationInput, 'rfqId'> {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const comparisonRunId = uuid(body.comparisonRunId ?? body.comparisonId, 'comparisonRunId', true, details);
  const evidenceId = uuid(body.evidenceId ?? body.selectedEvidenceId, 'evidenceId', false, details);
  const vendorId = uuid(body.vendorId ?? body.selectedVendorId ?? body.recommendedVendorId, 'vendorId', false, details);
  const quotationRevisionId = uuid(body.quotationRevisionId ?? body.revisionId ?? body.selectedQuotationRevisionId ?? body.recommendedQuotationRevisionId, 'quotationRevisionId', false, details);
  const rawOutcome = body.outcome ?? body.recommendationOutcome ?? 'VENDOR';
  const outcome = typeof rawOutcome === 'string' ? rawOutcome.trim().toUpperCase() : rawOutcome;
  if (outcome !== 'VENDOR' && outcome !== 'NO_AWARD') {
    details.push({ field: 'outcome', message: 'outcome must be VENDOR or NO_AWARD.' });
  }
  const reason = text(body.reason ?? body.recommendationReason, 'reason', true, details);
  const notes = text(body.notes ?? body.recommendationNotes, 'notes', false, details);
  if (details.length || !comparisonRunId || !reason) {
    if (!reason && !details.some((detail) => detail.field === 'reason')) throw rfqRecommendationReasonRequiredError();
    fail(details);
  }
  return {
    comparisonRunId,
    outcome: outcome as RfqRecommendationOutcome,
    reason,
    ...(evidenceId ? { evidenceId } : {}),
    ...(vendorId ? { vendorId } : {}),
    ...(quotationRevisionId ? { quotationRevisionId } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseCreateRfqAwardBody(body: unknown): Omit<CreateRfqAwardInput, 'recommendationId'> {
  if (body === undefined || body === null) return {};
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const awardReason = text(body.awardReason ?? body.reason, 'awardReason', false, details);
  if (details.length) fail(details);
  return awardReason !== undefined ? { awardReason } : {};
}
