import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * W03 PART 03B2 — binding-write refusal envelope (ADD-A MC3, A01 §9).
 *
 * MC3 is explicit: "Binding refusal reuses the existing validation/denial
 * envelope with a non-enumerating 404 for an inaccessible PIC" and no new
 * enumerable error code may be minted. Every refusal below therefore reuses an
 * EXISTING `ERROR_CODES` member (`HANDYMAN_QUOTATION_NOT_FOUND`,
 * `PERMISSION_DENIED`, `HANDYMAN_QUOTATION_DECISION_CONFLICT`, `CONFLICT`);
 * this module introduces ZERO new error codes.
 *
 * Non-enumeration is real, not decorative: `handymanQuotationNotFoundError()`
 * (the CR-HM-06 404 the whole quotation surface already uses) is the payload
 * of every eligibility-shaped refusal, and `bindingTargetUnavailableError()`
 * carries a single message regardless of which B1–B5 / R-1.1 prerequisite
 * failed. A caller cannot probe whether a PIC exists, belongs to another
 * tenant, or is inactive — all three answers are byte-identical.
 */

/** The uniform 404: unknown thread, unknown/foreign/inactive PIC, dead basis. */
export function bindingTargetUnavailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_NOT_FOUND,
    message: 'Handyman quotation thread or binding target is not available.',
    statusCode: 404,
  });
}

/**
 * MC1' (ADD-A §6): the granter may not select a signer who is themselves.
 * Denial envelope, existing code, no enumeration of the PIC beyond what the
 * caller already supplied.
 */
export function bindingSelfAuthorityError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message:
      'The user conferring a binding may not name a Tenant PIC linked to themselves.',
    statusCode: 403,
  });
}

/**
 * B18: once any version of the thread has a decision row, the authorization
 * context is frozen — no re-binding and no revocation. Reuses the decision
 * ledger's own conflict code because the cause IS a recorded decision.
 */
export function bindingFrozenByDecisionError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_DECISION_CONFLICT,
    message:
      'Handyman quotation approval bindings freeze once the thread has a decision (B18).',
    statusCode: 409,
  });
}

/**
 * B13: a binding is pinned while a version of the thread is ISSUED and
 * undecided. Re-binding is refused; revocation is not (B15 — safety outranks
 * the pin).
 */
export function bindingPinnedError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    message:
      'A binding is pinned while a quotation version is presented (B13); supersede or expire it first.',
    statusCode: 409,
  });
}

/**
 * R-1.2: the request already carries a BM-attested lineage PIC, and a binding
 * may never contradict it. 409 (A01 §9), never a 4xx that names the lineage
 * PIC's identity.
 */
export function bindingLineageConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    message:
      'A binding may not contradict the PIC already attested on the request (R-1.2).',
    statusCode: 409,
  });
}

/**
 * Lost race: the pre-check passed, then the thread's binding head moved under
 * us (`…_one_active` / `…_one_per_version` / the guard refused the write).
 * Nothing was committed; the caller reloads and retries.
 */
export function bindingConcurrentWriteError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    message:
      'A concurrent binding write changed this thread; reload and retry.',
    statusCode: 409,
  });
}

/**
 * A `effective_until` the caller could not legitimately mean: must be a parse
 *able instant strictly inside the window being granted (bind) or a cutoff that
 * only tightens an existing window (revoke). Validation envelope, existing
 * generic validation code — no new vocabulary.
 */
export function bindingWindowInvalidError(field: string): AppError {
  return AppError.validation('Handyman quotation approval binding validation failed.', [
    {
      field,
      message:
        field === 'effectiveUntil'
          ? 'effectiveUntil must be an ISO-8601 timestamp strictly after the binding start and, for a revocation, not in the future.'
          : `${field} is invalid.`,
    },
  ]);
}

/**
 * Map the `0437` guard's RAISE texts onto the ratified envelope. The guard is
 * the floor (B20), so a service-side miss must fail CLOSED into the same
 * contract instead of surfacing a raw 23514 (which would render as a 500).
 */
export function bindingGuardRefusalError(guardMessage: string): AppError {
  const message = guardMessage.trim();
  if (message.includes('(B18)')) return bindingFrozenByDecisionError();
  if (message.includes('(B13)')) return bindingPinnedError();
  if (message.includes('(R-1.2)')) return bindingLineageConflictError();
  if (message.includes('(MC1)')) return bindingSelfAuthorityError();
  if (message.includes('(B14)') || message.includes('(B14/B15)')) {
    return bindingConcurrentWriteError();
  }
  // B1/B2/B3/B4/B5/MC0/lineage-shape refusals: the uniform 404.
  return bindingTargetUnavailableError();
}
