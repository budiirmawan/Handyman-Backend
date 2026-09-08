import { AppError } from '../../shared/errors';
import {
  FINDING_STATUSES,
  isFindingStatus,
} from './finding.types';
import type { TransitionFindingStateInput } from './finding-state.types';

export function parseTransitionFindingStateBody(
  body: unknown,
): TransitionFindingStateInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const state = (body as Record<string, unknown>).state;
  if (!isFindingStatus(state)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'state',
        message: `State must be one of: ${FINDING_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return { state };
}
