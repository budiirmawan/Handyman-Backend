import { AppError } from '../../shared/errors';
// Imported from the validation file rather than the `../clients` barrel so this
// module stays dependency-free (the barrel reaches `pg`). `client.validation.ts`
// imports only `shared/errors` and the pure `client.types`, so `isValidUuid` and
// `parseClientIdParam` are reused here instead of being duplicated.
import { isValidUuid, parseClientIdParam } from '../clients/client.validation';
import { isFxRateSource, isFxRateStatus } from './fx-rate.types';
import type {
  CreateFxRateInput,
  SupersedeFxRateInput,
} from './fx-rate-lifecycle.service';
import type { SetClientFxPolicyInput } from './client-fx-policy.service';
import type { FxRateFilters } from './fx-rate.types';

/**
 * CR-BE-FX-01 PART 02 — HTTP request parsing for the FX Rate lifecycle and
 * Client FX Policy surfaces.
 *
 * Kept separate from `fx-rate.validation.ts` on purpose: that module is the
 * dependency-free domain authority and is exercised by a test that runs without
 * `node_modules`, whereas this file imports `../clients` (which reaches `pg`).
 *
 * These parsers check SHAPE only. The governed rules — currency liveness, the
 * canonical rate shape, window validity, the transition table and maker-checker
 * — are enforced by the domain validators, the service and the `0333`
 * constraints.
 */

type Detail = { field: string; message: string };

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  return body as Record<string, unknown>;
}

export function parseFxRateId(raw: string): string {
  if (!isValidUuid(raw)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'rateId', message: 'Rate id must be a valid UUID.' },
    ]);
  }
  return raw.toLowerCase();
}

/** Reuses the existing Client-scoped UUID parser rather than duplicating it. */
export const parseClientId = parseClientIdParam;

export function parseCreateFxRateBody(body: unknown): CreateFxRateInput {
  const source = asObject(body);
  const details: Detail[] = [];

  const baseCurrencyCode = upperCode(source.baseCurrencyCode);
  if (!baseCurrencyCode) {
    details.push({ field: 'baseCurrencyCode', message: 'baseCurrencyCode must be a three-letter uppercase currency code.' });
  }
  const quoteCurrencyCode = upperCode(source.quoteCurrencyCode);
  if (!quoteCurrencyCode) {
    details.push({ field: 'quoteCurrencyCode', message: 'quoteCurrencyCode must be a three-letter uppercase currency code.' });
  }

  const rate = decimalString(source.rate);
  if (rate === null) {
    details.push({
      field: 'rate',
      message: 'rate must be a positive decimal. Convention: 1 BASE = RATE x QUOTE.',
    });
  }

  const effectiveFrom = dateString(source.effectiveFrom);
  if (effectiveFrom === null) {
    details.push({ field: 'effectiveFrom', message: 'effectiveFrom must be an ISO-8601 timestamp.' });
  }
  const effectiveTo = source.effectiveTo === undefined || source.effectiveTo === null
    ? null
    : dateString(source.effectiveTo);
  if (effectiveTo === undefined) {
    details.push({ field: 'effectiveTo', message: 'effectiveTo must be an ISO-8601 timestamp or null.' });
  }

  // FX-01 supports MANUAL_TREASURY only; there is no provider ingestion.
  const sourceValue = isFxRateSource(source.source) ? source.source : undefined;
  if (!sourceValue) {
    details.push({ field: 'source', message: "source must be 'MANUAL_TREASURY'. No external provider ingestion exists." });
  }

  const sourceReference = optionalText(source.sourceReference, 200);
  if (sourceReference === undefined) {
    details.push({ field: 'sourceReference', message: 'sourceReference must be a string of at most 200 characters.' });
  }

  if (details.length > 0) throw AppError.validation('Request validation failed.', details);

  return {
    baseCurrencyCode: baseCurrencyCode!,
    quoteCurrencyCode: quoteCurrencyCode!,
    rate: rate!,
    effectiveFrom: effectiveFrom!,
    effectiveTo: effectiveTo,
    source: sourceValue!,
    ...(sourceReference ? { sourceReference } : {}),
  };
}

export function parseSupersedeFxRateBody(body: unknown): SupersedeFxRateInput {
  const source = asObject(body);
  const details: Detail[] = [];

  // `rate` is optional: a window-only correction reuses the incumbent's exact
  // stored decimal. When present it must be a valid positive decimal literal.
  let rate: string | undefined;
  if (source.rate !== undefined && source.rate !== null) {
    const parsed = decimalString(source.rate);
    if (parsed === null) {
      details.push({ field: 'rate', message: 'rate must be a positive decimal. Convention: 1 BASE = RATE x QUOTE.' });
    } else {
      rate = parsed;
    }
  }

  const effectiveFrom = dateString(source.effectiveFrom);
  if (effectiveFrom === null) {
    details.push({ field: 'effectiveFrom', message: 'effectiveFrom must be an ISO-8601 timestamp.' });
  }
  const effectiveTo = source.effectiveTo === undefined || source.effectiveTo === null
    ? null
    : dateString(source.effectiveTo);
  if (effectiveTo === undefined) {
    details.push({ field: 'effectiveTo', message: 'effectiveTo must be an ISO-8601 timestamp or null.' });
  }

  const sourceReference = optionalText(source.sourceReference, 200);
  if (sourceReference === undefined) {
    details.push({ field: 'sourceReference', message: 'sourceReference must be a string of at most 200 characters.' });
  }

  if (details.length > 0) throw AppError.validation('Request validation failed.', details);

  return {
    ...(rate ? { rate } : {}),
    effectiveFrom: effectiveFrom!,
    effectiveTo,
    ...(sourceReference ? { sourceReference } : {}),
  };
}

/** Shared body shape for reject and deactivate: an optional free-text reason. */
export function parseReasonBody(body: unknown, field: string): string | null {
  if (body === undefined || body === null) return null;
  const source = asObject(body);
  const reason = source.reason;
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a string when provided.` },
    ]);
  }
  // A blank reason means "no reason given", not a malformed request.
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 500) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be at most 500 characters when provided.` },
    ]);
  }
  return trimmed;
}

export function parseSetClientFxPolicyBody(clientId: string, body: unknown): SetClientFxPolicyInput {
  const source = asObject(body);
  const details: Detail[] = [];

  const reportingCurrencyCode = upperCode(source.reportingCurrencyCode);
  if (!reportingCurrencyCode) {
    details.push({
      field: 'reportingCurrencyCode',
      message: 'reportingCurrencyCode must be a three-letter uppercase currency code equal to the client base currency.',
    });
  }

  if (!Array.isArray(source.permittedSources)) {
    details.push({ field: 'permittedSources', message: "permittedSources must be an array. FX-01 supports only 'MANUAL_TREASURY'." });
  } else {
    for (const candidate of source.permittedSources) {
      if (!isFxRateSource(candidate)) {
        details.push({
          field: 'permittedSources',
          message: "permittedSources may only contain 'MANUAL_TREASURY' in FX-01.",
        });
        break;
      }
    }
  }

  const maxStalenessDays = source.maxStalenessDays === undefined || source.maxStalenessDays === null
    ? null
    : typeof source.maxStalenessDays === 'number' && Number.isInteger(source.maxStalenessDays) && source.maxStalenessDays > 0
      ? source.maxStalenessDays
      : undefined;
  if (maxStalenessDays === undefined) {
    details.push({ field: 'maxStalenessDays', message: 'maxStalenessDays must be a positive integer or null.' });
  }

  if (details.length > 0) throw AppError.validation('Request validation failed.', details);

  return {
    clientId,
    // Explicit booleans only; an absent flag fails closed to false.
    fxEnabled: source.fxEnabled === true,
    reportingCurrencyCode: reportingCurrencyCode!,
    permittedSources: (source.permittedSources ?? []) as SetClientFxPolicyInput['permittedSources'],
    inversePermitted: source.inversePermitted === true,
    maxStalenessDays,
  };
}

export function parseFxRateFilters(query: Record<string, unknown>): FxRateFilters {
  const filters: FxRateFilters = {};
  const base = upperCode(query.baseCurrencyCode);
  if (base) filters.baseCurrencyCode = base;
  const quote = upperCode(query.quoteCurrencyCode);
  if (quote) filters.quoteCurrencyCode = quote;
  const status = isFxRateStatus(query.status) ? query.status : undefined;
  if (status) filters.status = status;
  const sourceValue = isFxRateSource(query.source) ? query.source : undefined;
  if (sourceValue) filters.source = sourceValue;
  const effectiveAt = dateString(query.effectiveAt);
  if (effectiveAt) filters.effectiveAt = effectiveAt;

  const limit = Number(query.limit);
  if (Number.isInteger(limit) && limit > 0) filters.limit = limit;
  const offset = Number(query.offset);
  if (Number.isInteger(offset) && offset >= 0) filters.offset = offset;

  return filters;
}

function upperCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Accepts a string or a finite number, returned as a plain decimal string.
 *
 * Exponent notation and non-finite values are rejected here so the governed
 * `NUMERIC(24,12)` validation in the domain layer sees only decimal literals.
 * A leading sign is rejected too: a rate is strictly positive by the frozen
 * model, so a signed literal is malformed input rather than a negative rate
 * worth a deeper diagnostic.
 */
function decimalString(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d+(?:\.\d+)?$|^\.\d+$/.test(trimmed) ? trimmed : null;
}

/** Returns null for a missing value, undefined for a malformed one. */
function dateString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Returns null when absent/blank, undefined when malformed. */
function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength || /[\r\n]/.test(trimmed) ? undefined : trimmed;
}
