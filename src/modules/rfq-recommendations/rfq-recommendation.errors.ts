import { AppError, ERROR_CODES } from '../../shared/errors';

function make(code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number): AppError {
  return new AppError({ code, message, statusCode });
}

export function rfqRecommendationNotFoundError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_NOT_FOUND, 'RFQ recommendation not found.', 404);
}
export function rfqRecommendationAlreadyExistsError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_ALREADY_EXISTS, 'An RFQ recommendation already exists for this RFQ.', 409);
}
export function rfqRecommendationRfqInvalidError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_RFQ_INVALID, 'The RFQ is not in an awardable state.', 409);
}
export function rfqRecommendationComparisonInvalidError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_COMPARISON_INVALID, 'The comparison run is not valid for this RFQ.', 409);
}
export function rfqRecommendationEvidenceInvalidError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_EVIDENCE_INVALID, 'The selected quotation evidence does not belong to the comparison run.', 400);
}
export function rfqRecommendationStaleComparisonError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_STALE_COMPARISON, 'The comparison is stale because the applicable quotation revision changed.', 409);
}
export function rfqRecommendationQuotationInvalidError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_QUOTATION_INVALID, 'The selected quotation is no longer valid for recommendation.', 409);
}
export function rfqRecommendationReasonRequiredError(): AppError {
  return make(ERROR_CODES.RFQ_RECOMMENDATION_REASON_REQUIRED, 'A recommendation reason is required.', 400);
}
export function rfqAwardNotFoundError(): AppError {
  return make(ERROR_CODES.RFQ_AWARD_NOT_FOUND, 'RFQ award not found.', 404);
}
export function rfqAwardAlreadyExistsError(): AppError {
  return make(ERROR_CODES.RFQ_AWARD_ALREADY_EXISTS, 'This RFQ already has an immutable award decision.', 409);
}
export function rfqAwardNotApprovedError(): AppError {
  return make(ERROR_CODES.RFQ_AWARD_NOT_APPROVED, 'An approved RFQ award recommendation is required.', 409);
}
export function rfqAwardRfqInvalidError(): AppError {
  return make(ERROR_CODES.RFQ_AWARD_RFQ_INVALID, 'The RFQ is no longer awardable.', 409);
}
export function rfqAwardQuotationInvalidError(): AppError {
  return make(ERROR_CODES.RFQ_AWARD_QUOTATION_INVALID, 'The selected quotation is no longer valid for award.', 409);
}
export function rfqAwardRecommendationInvalidError(): AppError {
  return make(ERROR_CODES.RFQ_AWARD_RECOMMENDATION_INVALID, 'The recommendation and approval do not match the requested award.', 409);
}
