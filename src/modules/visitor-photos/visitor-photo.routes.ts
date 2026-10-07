import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  attachVisitorPhotoHandler,
  getVisitorPhotoHandler,
  listVisitorPhotosHandler,
  recordVisitorPhotoOcrResultHandler,
  removeVisitorPhotoHandler,
  reviewVisitorPhotoHandler,
} from './visitor-photo.controller';

/**
 * BE-13E — Visitor Photo / OCR Readiness endpoints.
 *
 *   POST /visitors/:visitorId/photos
 *   GET  /visitors/:visitorId/photos
 *   GET  /visitor-photos/:id
 *   POST /visitor-photos/:id/ocr-result
 *   POST /visitor-photos/:id/review
 *   POST /visitor-photos/:id/remove
 *
 * Readiness layer only: safe file references + OCR metadata (BE-07
 * evidence convention). No image binaries in PostgreSQL, no custom
 * OCR/AI engine. Staged OCR output requires an explicit review before
 * it can touch the authoritative BE-13A visitor identity.
 */
export function createVisitorPhotoRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('visitor_photo.manage');
  const read = requirePermission('visitor_photo.read');

  router.post(
    '/visitors/:visitorId/photos',
    auth,
    manage,
    attachVisitorPhotoHandler,
  );
  router.get(
    '/visitors/:visitorId/photos',
    auth,
    read,
    listVisitorPhotosHandler,
  );
  router.get('/visitor-photos/:id', auth, read, getVisitorPhotoHandler);
  router.post(
    '/visitor-photos/:id/ocr-result',
    auth,
    manage,
    recordVisitorPhotoOcrResultHandler,
  );
  router.post(
    '/visitor-photos/:id/review',
    auth,
    manage,
    reviewVisitorPhotoHandler,
  );
  router.post(
    '/visitor-photos/:id/remove',
    auth,
    manage,
    removeVisitorPhotoHandler,
  );

  return router;
}
