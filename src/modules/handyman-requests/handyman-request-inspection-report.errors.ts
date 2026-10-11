import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-INSPECTION-01 PART B — versioned Field report / Operations review
 * errors. The module-canonical request 404 and the PART A assignment errors
 * live in their own files and are reused directly.
 */

/** A report version requires the request's recorded 0381 physical inspection. */
export function handymanInspectionReportInspectionRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_INSPECTION_REQUIRED,
    message:
      'A Field inspection report requires the request\'s recorded inspection.',
    statusCode: 409,
  });
}

/** Only a returned version may be corrected; a pending version may not be replaced. */
export function handymanInspectionReportPendingReviewError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_PENDING_REVIEW,
    message:
      'The latest Field inspection report version is awaiting review; it cannot be replaced.',
    statusCode: 409,
  });
}

/** Acceptance is terminal for the request's report chain. */
export function handymanInspectionReportAlreadyAcceptedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_ALREADY_ACCEPTED,
    message:
      'This Handyman request already carries an accepted Field inspection report.',
    statusCode: 409,
  });
}

/** Version allocation is monotonic and serialized; the race is a 409. */
export function handymanInspectionReportVersionConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_VERSION_CONFLICT,
    message:
      'A concurrent Field inspection report version already changed this request.',
    statusCode: 409,
  });
}

export function handymanInspectionReportNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_NOT_FOUND,
    message: 'Handyman request inspection report not found.',
    statusCode: 404,
  });
}

/** Only the latest submitted version may be reviewed. */
export function handymanInspectionReportNotLatestError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_NOT_LATEST,
    message: 'Only the latest Field inspection report version may be reviewed.',
    statusCode: 409,
  });
}

/** A version carries exactly one decision, forever. */
export function handymanInspectionReportAlreadyReviewedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_ALREADY_REVIEWED,
    message: 'This Field inspection report version already has its decision.',
    statusCode: 409,
  });
}

/**
 * A version's submitter cannot review it — separation of duties is enforced
 * by the database constraint as well as by this service refusal.
 */
export function handymanInspectionReportSelfReviewDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_SELF_REVIEW_DENIED,
    message:
      'The Field user who submitted a report version cannot review that version.',
    statusCode: 403,
  });
}

/** Returning a version demands a bounded correction reason. */
export function handymanInspectionReportReturnReasonRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_RETURN_REASON_REQUIRED,
    message:
      'Returning a Field inspection report requires a reason (1-1000 characters).',
    statusCode: 400,
  });
}

/** Technical estimate lines carry quantities and units only, and stay bounded. */
export function handymanInspectionReportEstimateInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_ESTIMATE_INVALID,
    message:
      'Each estimate line requires a LABOR/MATERIAL type, a description ' +
      '(1-500 characters), a positive quantity and an existing unit of measure.',
    statusCode: 400,
  });
}

/** The recommended catalogue anchor must match the selected discipline. */
export function handymanInspectionReportRecommendationInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_REPORT_RECOMMENDATION_INVALID,
    message:
      'The recommended service must be ACTIVE, belong to the request Client, ' +
      'and be associated with the selected Handyman discipline.',
    statusCode: 400,
  });
}
