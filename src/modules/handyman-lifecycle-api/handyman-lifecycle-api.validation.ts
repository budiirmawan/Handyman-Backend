import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { HANDYMAN_TRIAGE_DISPOSITIONS } from '../handyman-requests';
import { HANDYMAN_INSPECTION_RESULTS } from '../handyman-requests';
import type {
  CreateHandymanDiagnosisInput,
  CreateHandymanInspectionInput,
  CreateHandymanReferralInput,
  CreateHandymanRequestTriageInput,
} from '../handyman-requests';

/**
 * CR-HM-03 PART 05A — request/DTO parsing for the Handyman lifecycle
 * surface (FROZEN F8). Validation-only: the PART 01–04 services remain the
 * sole business authority (state machine, discipline/classification
 * derivation, referral eligibility, scope, immutability).
 *
 * Authority rule: bodies expose ONLY caller-owned inputs
 * (disposition/note · result/notes · disciplineId/diagnosis/optional
 * recommendation · note). Any smuggled keys — actor/user ids, Client,
 * building/space/channel context, scopeClassification, referralType,
 * targetDisciplineId — are structurally IGNORED: parsers never spread the
 * source object, so smuggled fields cannot even reach the service layer.
 */

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readText(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
  max: number,
): string {
  if (typeof value !== 'string') {
    if (required) {
      details.push({ field, message: `${field} is required.` });
    } else if (value !== undefined) {
      details.push({ field, message: `${field} must be a string.` });
    }
    return '';
  }
  const trimmed = value.trim();
  if (
    (required && trimmed.length < 1) ||
    (value.trim() !== '' && trimmed.length > max)
  ) {
    details.push({
      field,
      message: `${field} must be between 1 and ${max} characters.`,
    });
  }
  return trimmed;
}

function readEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  details: Detail[],
): T[number] | undefined {
  if (
    typeof value === 'string' &&
    (allowed as readonly string[]).includes(value.trim())
  ) {
    return value.trim() as T[number];
  }
  details.push({
    field,
    message: `${field} must be one of: ${allowed.join(', ')}.`,
  });
  return undefined;
}

/** Path parameter authority: the Handyman request id in the URL. */
export function parseLifecycleHandymanRequestIdParam(value: unknown): string {
  const details: Detail[] = [];
  const id = readId(value, 'handymanRequestId', true, details);
  if (!id || details.length) fail(details);
  return id;
}

export function parseLifecycleTriageBody(
  body: unknown,
): Omit<CreateHandymanRequestTriageInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const disposition = readEnum(
    source.disposition,
    'disposition',
    HANDYMAN_TRIAGE_DISPOSITIONS,
    details,
  );
  const note = readText(source.note, 'note', true, details, 500);
  if (!disposition || details.length) fail(details);
  return { triageDisposition: disposition, triageNote: note };
}

export function parseLifecycleInspectionBody(
  body: unknown,
): Omit<CreateHandymanInspectionInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const result = readEnum(
    source.result,
    'result',
    HANDYMAN_INSPECTION_RESULTS,
    details,
  );
  const notes = readText(source.notes, 'notes', true, details, 1000);
  if (!result || details.length) fail(details);
  return { inspectionResult: result, inspectionNotes: notes };
}

export function parseLifecycleDiagnosisBody(
  body: unknown,
): Omit<CreateHandymanDiagnosisInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const disciplineId = readId(source.disciplineId, 'disciplineId', true, details);
  const diagnosis = readText(source.diagnosis, 'diagnosis', true, details, 1000);
  const recommendedServiceCatalogId = readId(
    source.recommendedServiceCatalogId,
    'recommendedServiceCatalogId',
    false,
    details,
  );
  if (!disciplineId || details.length) fail(details);
  return { disciplineId, diagnosis, recommendedServiceCatalogId };
}

export function parseLifecycleReferralBody(
  body: unknown,
): Omit<CreateHandymanReferralInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const note = readText(source.note, 'note', true, details, 1000);
  if (details.length) fail(details);
  return { referralNote: note };
}
