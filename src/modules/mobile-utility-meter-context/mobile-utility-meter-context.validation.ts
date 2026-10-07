import { parseReadingDueId } from '../utility-reading-dues';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 00 — mobile field meter-context validation.
 *
 * There is exactly ONE input: the `readingDueId` path parameter, which is the
 * field execution identity. It is parsed by the EXISTING BE-18 reading-due
 * validator rather than a copy, so the UUID rule, the lowercase normalization
 * and the `VALIDATION_ERROR` envelope stay single-sourced. Only the reported
 * field label differs, so a malformed id names the parameter the mobile caller
 * actually supplied.
 *
 * The request has no body and no query parameters: the meter is resolved from
 * the due, the client/Building from the meter, and the actor from the session.
 * Nothing about the target is accepted from the caller.
 */
export function parseMobileMeterContextReadingDueId(raw: string): string {
  return parseReadingDueId(raw, 'readingDueId');
}
