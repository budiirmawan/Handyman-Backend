import { claimCareQuotationHandoff, resolveAssistedQuotationVersion } from '../handyman-care-workspace/care-quotation-pic.service';
import { assistanceObject } from '../handyman-care-workspace/care-quotation.validation';
import { Router } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { readPicWorkspaceBearer } from '../handyman-pic-session';
import { submitPicQuotationDecision } from './pic-portal-decide.service';
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
 * The three GETs still mutate nothing, and `03E` adds exactly one write to this
 * router — the decide path below — which is authorized the same way: by the
 * credential and the thread's own binding, never by a staff grant. The
 * eligibility read reports that path's preconditions without entering it.
 *
 * The POST differs in one mechanical respect: `readPicWorkspaceBearer` refuses ANY
 * body, which is correct while the surface is read-only and impossible for a
 * decision. So the route passes `undefined` in the body slot — the query rule
 * stays enforced in full — and `parsePicDecisionBody` inside the service holds the
 * body to exactly `{decision}`, refusing every other key with the same 400 class.
 * There is no way to smuggle a tenant, a PIC, a session or a binding in here.
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

  router.post(
    '/handyman/pic/quotation-versions/:quotationVersionId/decision',
    async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const { token } = readPicWorkspaceBearer(
          req.header('authorization'),
          req.query,
          undefined,
        );
        sendSuccess(
          res,
          await submitPicQuotationDecision(
            token,
            req.params.quotationVersionId,
            req.body,
            // A header, not a body key: the key identifies this ATTEMPT, and
            // trimming and the 1-200 bound are enforced in the service so both
            // surfaces validate a key the same way.
            req.header('Idempotency-Key'),
          ),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/handyman/pic/quotation-handoffs/:handoffId/claim',async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try {
      const {token}=readPicWorkspaceBearer(req.header('authorization'),req.query,undefined);
      assistanceObject(req.body??{},[]);
      sendSuccess(res,await claimCareQuotationHandoff(token,req.params.handoffId),201);
    } catch(error) {next(error);}
  });
  router.post('/handyman/pic/quotation-handoffs/:handoffId/decision',async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try {
      const {token}=readPicWorkspaceBearer(req.header('authorization'),req.query,undefined);
      const versionId=await resolveAssistedQuotationVersion(token,req.params.handoffId);
      sendSuccess(res,await submitPicQuotationDecision(token,versionId,req.body,req.header('Idempotency-Key'),String(req.params.handoffId)),201);
    } catch(error) {next(error);}
  });
  return router;
}
