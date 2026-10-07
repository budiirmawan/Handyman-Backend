import { AppError, ERROR_CODES } from '../../shared/errors';

export function rfqComparisonNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_NOT_FOUND, message: 'RFQ comparison run not found.', statusCode: 404 });
}

export function rfqComparisonIdempotencyKeyRequiredError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_IDEMPOTENCY_KEY_REQUIRED, message: 'An idempotency key is required to create an RFQ comparison run.', statusCode: 400 });
}

export function rfqComparisonIdempotencyConflictError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_IDEMPOTENCY_CONFLICT, message: 'The comparison idempotency key was already used with a different request.', statusCode: 409 });
}

export function rfqComparisonRfqInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_RFQ_INVALID, message: 'The RFQ is not in a state that can be compared.', statusCode: 409 });
}

export function rfqComparisonEvidenceInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_EVIDENCE_INVALID, message: 'A quotation does not have one valid applicable SUBMITTED revision for this RFQ.', statusCode: 409 });
}

export function rfqComparisonRevisionAmbiguousError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_REVISION_AMBIGUOUS, message: 'The applicable submitted quotation revision is ambiguous.', statusCode: 409 });
}

export function rfqComparisonCurrencyInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_CURRENCY_INVALID, message: 'Quotation currency must match the RFQ currency for comparison.', statusCode: 409 });
}

export function rfqComparisonLineInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_LINE_INVALID, message: 'A submitted quotation is missing or has inconsistent required RFQ lines.', statusCode: 409 });
}

export function rfqComparisonEvaluationNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_EVALUATION_NOT_FOUND, message: 'RFQ comparison evaluation not found.', statusCode: 404 });
}

export function rfqComparisonEvaluationAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_EVALUATION_ALREADY_EXISTS, message: 'An evaluation already exists for this Vendor evidence in the comparison.', statusCode: 409 });
}

export function rfqComparisonEvaluationEvidenceInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.RFQ_COMPARISON_EVALUATION_EVIDENCE_INVALID, message: 'Evaluation evidence must belong to the comparison run.', statusCode: 400 });
}

/**
 * CR-BE-PRICE-01 PART 04 — the reference-price resolver observed structural
 * ambiguity while building a run. Run creation fails closed (nothing is
 * snapshotted); the incident itself is already audited by the resolver's
 * auto-committed PRICE_CATALOG_AMBIGUITY_REJECTED event (governance §8/§17).
 */
export function rfqComparisonReferenceAmbiguousError(): AppError {
  return new AppError({
    code: ERROR_CODES.RFQ_COMPARISON_REFERENCE_AMBIGUOUS,
    message:
      'The comparison run was not created: the reference-price authority returned an ambiguous result. No run was recorded; the integrity incident was logged for investigation.',
    statusCode: 409,
  });
}
