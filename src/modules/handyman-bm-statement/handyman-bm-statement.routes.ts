import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { downloadHandymanBmStatement } from './handyman-bm-statement.service';

/** GET selects only the scope and UTC ledger-posting period; amounts never come from the caller. */
export function createHandymanBmStatementRouter(): Router {
  const router = Router();
  router.get('/handyman/clients/:clientId/buildings/:buildingId/bm-beneficiaries/:counterpartyId/commission-statement.pdf',
    authenticationMiddleware, requirePermission('handyman.commercial.manage'), requirePermission('handyman.finance.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).some(k => !['agreementVersionId', 'dateFrom', 'dateTo'].includes(k)) ||
            typeof req.query.agreementVersionId !== 'string' || typeof req.query.dateFrom !== 'string' || typeof req.query.dateTo !== 'string') {
          throw AppError.validation('Only agreementVersionId, dateFrom and dateTo are accepted.');
        }
        const result = await downloadHandymanBmStatement(req.auth.userId, {
          clientId: req.params.clientId as string, buildingId: req.params.buildingId as string,
          counterpartyId: req.params.counterpartyId as string, agreementVersionId: req.query.agreementVersionId,
          dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
        });
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.setHeader('Content-Length', String(result.fileSize));
        res.setHeader('X-Statement-Source-SHA256', result.sourceChecksum);
        res.setHeader('X-Content-SHA256', result.checksum);
        res.send(result.bytes);
      } catch (error) { next(error); }
    });
  return router;
}
