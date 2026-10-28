import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { getHandymanRequestScopeSet } from './handyman-request-scope-set.service';

export function createHandymanRequestScopeSetRouter(): Router {
  const router=Router();
  router.get('/handyman/requests/:handymanRequestId/scope-set', authenticationMiddleware, async (req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('Unexpected scope-set query parameters.');
      sendSuccess(res,await getHandymanRequestScopeSet(req.params.handymanRequestId,req.auth.userId));
    } catch (error) { next(error); }
  });
  return router;
}
