import { AppError } from '../../shared/errors';

/**
 * MOB-C05 PART 03 — Mobile checklist-execution Finding command body
 * validation.
 *
 * The mobile Finding command accepts ONLY field content the worker genuinely
 * provides (`title`, optional `description`). Every authoritative context
 * field (clientId, buildingId, findingNumber, reportedByUserId,
 * generatedTaskId, checklistTemplateId, workforceProfileId, shift,
 * sourceType/sourceId, status/state, assignee, reviewer) is derived
 * server-side and is REJECTED if a client attempts to send it — a strict
 * payload prevents a client from redirecting Building / Client / source /
 * numbering authority.
 *
 * Title/description limits mirror the existing generic Finding validation.
 */

export const MOBILE_FINDING_MAX_TITLE_LENGTH = 200;
export const MOBILE_FINDING_MAX_DESCRIPTION_LENGTH = 2000;

export type ValidationDetail = { field: string; message: string };

export type MobileFindingBody = {
  title: string;
  description?: string;
};

const ALLOWED_FIELDS = new Set(['title', 'description']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validation(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseCreateMobileFindingBody(body: unknown): MobileFindingBody {
  if (!isRecord(body)) {
    validation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  // Strict schema: reject any authoritative-context or unknown field a client
  // must never control (prevents Building/Client/source/number redirects).
  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      details.push({
        field,
        message: `Field '${field}' is not accepted. This command accepts only title and optional description; all authoritative context is resolved server-side.`,
      });
    }
  }

  const title = readTitle(body.title, details);
  const description = readDescription(body.description, details);

  if (!title || details.length > 0) validation(details);

  return {
    title: title as string,
    ...(description === undefined ? {} : { description }),
  };
}

function readTitle(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'title', message: 'Finding title is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MOBILE_FINDING_MAX_TITLE_LENGTH) {
    details.push({
      field: 'title',
      message: `Finding title must be at most ${MOBILE_FINDING_MAX_TITLE_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readDescription(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    details.push({
      field: 'description',
      message: 'description must be a string.',
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > MOBILE_FINDING_MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `description must be at most ${MOBILE_FINDING_MAX_DESCRIPTION_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}
