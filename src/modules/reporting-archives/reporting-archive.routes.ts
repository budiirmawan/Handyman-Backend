import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createReportArchiveHandler,
  downloadReportArchiveHandler,
  getReportArchiveHandler,
  listReportArchivesHandler,
} from './reporting-archive.controller';

/**
 * CR-BE-EXP-01 PART 01 / PART 05 — export request/archive authority.
 *
 * PART 05 synchronously completes a bounded request through the canonical
 * dataset/renderer/storage seams and exposes a scoped completed download. It
 * does not add a worker, scheduler, or retry processor.
 */
export function createReportingArchiveRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const generate = requirePermission('report_export.generate');
  const read = requirePermission('report_archive.read');

  router.post('/reporting/exports', auth, generate, createReportArchiveHandler);
  router.get('/reporting/exports/:id', auth, read, getReportArchiveHandler);
  router.get('/reporting/archives', auth, read, listReportArchivesHandler);
  router.get('/reporting/archives/:id', auth, read, getReportArchiveHandler);
  router.get(
    '/reporting/archives/:id/download',
    auth,
    read,
    downloadReportArchiveHandler,
  );

  return router;
}
