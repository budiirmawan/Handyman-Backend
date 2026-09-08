import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FINDING_SOURCE_TYPES,
  isFindingSourceType,
} from './finding.types';
import type { UpdateFindingSourceInput } from './finding-source.types';

type Detail = { field: string; message: string };

export function parseUpdateFindingSourceBody(
  body: unknown,
): UpdateFindingSourceInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const value = body as Record<string, unknown>;
  if (value.sourceType === null && value.sourceId === null) {
    return { sourceType: null, sourceId: null };
  }

  const details: Detail[] = [];
  if (!isFindingSourceType(value.sourceType)) {
    details.push({
      field: 'sourceType',
      message: `Source type must be one of: ${FINDING_SOURCE_TYPES.join(', ')}.`,
    });
  }
  if (typeof value.sourceId !== 'string' || !isValidUuid(value.sourceId.trim())) {
    details.push({
      field: 'sourceId',
      message: 'Source id must be a valid UUID.',
    });
  }
  if (details.length) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    sourceType: value.sourceType as UpdateFindingSourceInput['sourceType'],
    sourceId: (value.sourceId as string).trim().toLowerCase(),
  };
}
