import { Router, Request, Response, NextFunction } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { hasPaginationParams, parsePagination, buildPaginationMeta } from '../../shared/pagination';
import {
  createReview,
  decideReview,
  toPublicReview,
} from './review.service';

const p = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : value;

const targets = ['FORM_INSTANCE', 'CHECKLIST_EXECUTION'];

async function getReviewRow(reviewId: string, userId: string) {
  const result = await getPool().query(
    'SELECT * FROM reviews WHERE id = $1',
    [reviewId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound('Review not found.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) {
    throw buildingAccessDeniedError();
  }
  return row;
}

export function createReviewRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('review.manage');
  const read = requirePermission('review.read');

  router.post('/reviews', auth, manage, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body ?? {};
      if (!targets.includes(body.targetType) || !body.targetId) {
        throw AppError.validation();
      }
      sendSuccess(
        res,
        await createReview(body.targetType, body.targetId, req.auth.userId, body.notes),
        201,
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/reviews/:id', auth, read, async (req: Request, res: Response, next: NextFunction) => {
    try {
      sendSuccess(res, toPublicReview(await getReviewRow(p(req.params.id), req.auth.userId)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/reviews', auth, read, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientIds = await contextAccessService.getAccessibleClientIds(req.auth.userId);
      const where =
        '($1::text IS NULL OR target_type=$1) AND ($2::uuid IS NULL OR target_id=$2) AND client_id = ANY($3::uuid[])';
      const params = [req.query.targetType || null, req.query.targetId || null, clientIds];
      if (hasPaginationParams(req.query)) {
        const pg = parsePagination(req.query);
        const total = (
          await getPool().query(`SELECT count(*)::int AS n FROM reviews WHERE ${where}`, [
            ...params,
          ])
        ).rows[0].n;
        const rows = await getPool().query(
          `SELECT * FROM reviews WHERE ${where} ORDER BY created_at DESC, id LIMIT $4 OFFSET $5`,
          [...params, pg.limit, pg.offset],
        );
        sendSuccess(res, rows.rows.map(toPublicReview), 200, buildPaginationMeta(pg.page, pg.pageSize, total));
        return;
      }
      const rows = await getPool().query(
        `SELECT * FROM reviews WHERE ${where} ORDER BY created_at DESC`,
        [...params],
      );
      sendSuccess(res, rows.rows.map(toPublicReview));
    } catch (error) {
      next(error);
    }
  });

  router.post('/reviews/:id/decision', auth, manage, async (req: Request, res: Response, next: NextFunction) => {
    try {
      sendSuccess(
        res,
        await decideReview(p(req.params.id), req.auth.userId, req.body?.decision, req.body?.notes),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
