import {
  parsePermitWorkNotesBody,
  parsePermitWorkPermitIdParam,
} from '../permit-work-lifecycle/permit-work-lifecycle.validation';
import type { PermitWorkNotesInput } from '../permit-work-lifecycle/permit-work-lifecycle.types';

/**
 * CR-BE-RN20-PERMIT-FIELD-01 — field route input parsing.
 *
 * Both inputs are parsed by the EXISTING BE-20K validators rather than copies,
 * so the UUID rule, lowercase normalization, the 2000-character / trimmed /
 * empty→null `notes` rule and the `VALIDATION_ERROR` envelope stay
 * single-sourced with `POST /permits/:permitId/work-start` and `work-close`.
 *
 * There are no query parameters and no other body fields: the caller supplies
 * a permit id and optional notes, never a status, action, building, worker or
 * application id.
 */
export function parseMobilePermitWorkPermitId(raw: string): string {
  return parsePermitWorkPermitIdParam(raw);
}

export function parseMobilePermitWorkNotesBody(body: unknown): PermitWorkNotesInput {
  return parsePermitWorkNotesBody(body);
}
