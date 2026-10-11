import { Router } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { readPicWorkspaceBearer } from '../handyman-pic-session';
import {
  readPicPortalApprovalEligibility,
  readPicPortalOwnDecision,
  readPicPortalQuotation,
} from './pic-portal.service';

/**
 * W03 PART 03D — the bounded PIC portal read surface: three GETs, no more.
 *
 * Authentication is 03C's own bearer seam (`readPicWorkspaceBearer`), so a PIC
 * credential is validated by exactly the same code that validates it at the
 * session endpoint, and a query string or a body carrying context is refused
 * before any query runs — the credential selects the scope, and rule 13 forbids
 * an input from widening it. There is deliberately no `authenticationMiddleware()`,
 * no `requirePermission()` and no tenant-company grant lookup here: the read is
 * authorized by the resolved thread's own lineage, so a staff token cannot borrow
 * it and a PIC token cannot reach a staff surface.
 *
 * Nothing on this router mutates. `03E` owns the decide path; the eligibility read
 * below reports that path's preconditions without entering it.
 */
export function createPicPortalRouter(): Router {
  const router = Router();

  router.get('/handyman/pic/requests/:handymanRequestId', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { token } = readPicWorkspaceBearer(
        req.header('authorization'),
        req.query,
        req.body,
      );
      sendSuccess(
        res,
        await readPicPortalQuotation(token, req.params.handymanRequestId),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/handyman/pic/requests/:handymanRequestId/approval-eligibility',
    async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const { token } = readPicWorkspaceBearer(
          req.header('authorization'),
          req.query,
          req.body,
        );
        sendSuccess(
          res,
          await readPicPortalApprovalEligibility(token, req.params.handymanRequestId),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/pic/quotation-versions/:quotationVersionId/decision',
    async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const { token } = readPicWorkspaceBearer(
          req.header('authorization'),
          req.query,
          req.body,
        );
        sendSuccess(
          res,
          await readPicPortalOwnDecision(token, req.params.quotationVersionId),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
