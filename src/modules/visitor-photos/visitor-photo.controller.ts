import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { visitorPhotoService } from './visitor-photo.service';
import {
  parseCreateVisitorPhotoBody,
  parseRecordVisitorPhotoOcrResultBody,
  parseReviewVisitorPhotoBody,
  parseVisitorPhotoIdParam,
  parseVisitorPhotoListQuery,
  parseVisitorPhotoVisitorIdParam,
} from './visitor-photo.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /visitors/:visitorId/photos
 *
 * Attaches a visitor photo or identity-document image REFERENCE (safe
 * storage reference + metadata — never a binary) to the shared BE-13A
 * visitor identity. `requestOcr: true` marks it queued for external
 * OCR processing.
 */
export async function attachVisitorPhotoHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const visitorId = parseVisitorPhotoVisitorIdParam(
      paramString(req.params.visitorId),
    );
    const body = parseCreateVisitorPhotoBody(req.body);
    const result = await visitorPhotoService.attachVisitorPhoto(
      { ...body, visitorId, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /visitors/:visitorId/photos
 *   ?photoType=&ocrStatus=&reviewStatus=&status=
 */
export async function listVisitorPhotosHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const visitorId = parseVisitorPhotoVisitorIdParam(
      paramString(req.params.visitorId),
    );
    const filters = parseVisitorPhotoListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await visitorPhotoService.listVisitorPhotos(
      visitorId,
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /visitor-photos/:id */
export async function getVisitorPhotoHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorPhotoIdParam(paramString(req.params.id));
    const result = await visitorPhotoService.getVisitorPhoto(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /visitor-photos/:id/ocr-result
 *
 * Records external OCR result metadata. Extracted fields are STAGED
 * on the photo row — the authoritative visitor identity is never
 * touched here.
 */
export async function recordVisitorPhotoOcrResultHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorPhotoIdParam(paramString(req.params.id));
    const body = parseRecordVisitorPhotoOcrResultBody(req.body);
    const result = await visitorPhotoService.recordVisitorPhotoOcrResult(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /visitor-photos/:id/review
 *
 * Explicit review over staged OCR output: APPLY pushes the reviewed
 * fields into the visitor identity via the BE-13A service; REJECT
 * discards them (kept for audit). Single-shot.
 */
export async function reviewVisitorPhotoHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorPhotoIdParam(paramString(req.params.id));
    const body = parseReviewVisitorPhotoBody(req.body);
    const result = await visitorPhotoService.reviewVisitorPhoto(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /visitor-photos/:id/remove — soft-remove (kept for audit). */
export async function removeVisitorPhotoHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorPhotoIdParam(paramString(req.params.id));
    const result = await visitorPhotoService.removeVisitorPhoto(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
