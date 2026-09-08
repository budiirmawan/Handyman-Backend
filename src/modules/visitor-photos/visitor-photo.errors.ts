import { AppError, ERROR_CODES } from '../../shared/errors';

/** The visitor photo row could not be located. */
export function visitorPhotoNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PHOTO_NOT_FOUND,
    message: 'Visitor photo not found.',
    statusCode: 404,
  });
}

/** The photo row is REMOVED and can no longer change. */
export function visitorPhotoRemovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PHOTO_REMOVED,
    message: 'A removed visitor photo can no longer be modified.',
    statusCode: 409,
  });
}

/** OCR result metadata can only be recorded after OCR was requested. */
export function visitorPhotoOcrNotRequestedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PHOTO_OCR_NOT_REQUESTED,
    message:
      'OCR was not requested for this photo. Request OCR before recording a result.',
    statusCode: 409,
  });
}

/** Review requires a PROCESSED OCR result. */
export function visitorPhotoOcrNotProcessedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PHOTO_OCR_NOT_PROCESSED,
    message:
      'Only a PROCESSED OCR result can be reviewed. The photo has no processed OCR output.',
    statusCode: 409,
  });
}

/** The staged OCR output was already reviewed (applied or rejected). */
export function visitorPhotoAlreadyReviewedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PHOTO_ALREADY_REVIEWED,
    message: 'The OCR output of this photo has already been reviewed.',
    statusCode: 409,
  });
}

/** APPLY requires at least one staged extracted field. */
export function visitorPhotoNothingToApplyError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_PHOTO_NOTHING_TO_APPLY,
    message: 'The OCR result contains no extracted fields to apply.',
    statusCode: 400,
  });
}
