import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { downloadHandymanMonthlyServiceReport } from './handyman-bm-report.service';

/** Manager-only, non-persisted Building-wide monthly preview. */
export function createHandymanBmReportRouter(): Router {
  const router = Router();
  router.get('/handyman/clients/:clientId/buildings/:buildingId/monthly-service-report.pdf',
    authenticationMiddleware, requirePermission('handyman.commercial.manage'), requirePermission('tenant_company.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).some(k => k !== 'month') || typeof req.query.month !== 'string') {
          throw AppError.validation('Only the UTC month (YYYY-MM) is accepted.');
        }
        const result = await downloadHandymanMonthlyServiceReport(req.auth.userId, {
          clientId: req.params.clientId as string, buildingId: req.params.buildingId as string, month: req.query.month,
        });
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.setHeader('Content-Length', String(result.fileSize));
        res.setHeader('X-Report-Source-SHA256', result.sourceChecksum);
        res.setHeader('X-Content-SHA256', result.checksum);
        res.send(result.bytes);
      } catch (error) { next(error); }
    });
  return router;
}
