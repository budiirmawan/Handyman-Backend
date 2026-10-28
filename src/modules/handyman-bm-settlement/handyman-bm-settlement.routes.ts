import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getHandymanBmSettlementDetail, listHandymanBmSettlements } from './handyman-bm-settlement.service';

const base = '/handyman/clients/:clientId/buildings/:buildingId/bm-settlements';
const readScope = requirePermission('handyman.finance.read');

/** Read-only Operations/Manager settlement contract: scoped, cursor-paginated
 *  list plus the authoritative detail projection. No write or action routes. */
export function createHandymanBmSettlementRouter(): Router {
  const router = Router();
  router.get(base, authenticationMiddleware, readScope,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).some(k => !['limit', 'after'].includes(k)) ||
            (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^[1-9][0-9]*$/.test(req.query.limit))) ||
            (req.query.after !== undefined && typeof req.query.after !== 'string')) {
          throw AppError.validation('Invalid settlement list query.');
        }
        const result = await listHandymanBmSettlements(req.auth.userId, {
          clientId: req.params.clientId as string, buildingId: req.params.buildingId as string,
          ...(req.query.limit === undefined ? {} : { limit: Number(req.query.limit) }),
          ...(req.query.after === undefined ? {} : { after: req.query.after as string }),
        });
        res.json({ data: result });
      } catch (error) { next(error); }
    });
  router.get(`${base}/:settlementId`, authenticationMiddleware, readScope,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const detail = await getHandymanBmSettlementDetail(req.auth.userId, {
          clientId: req.params.clientId as string, buildingId: req.params.buildingId as string,
          settlementId: req.params.settlementId as string,
        });
        res.json({ data: detail });
      } catch (error) { next(error); }
    });
  return router;
}
