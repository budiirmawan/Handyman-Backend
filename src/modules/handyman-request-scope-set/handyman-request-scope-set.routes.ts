import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { getHandymanRequestScopeSet } from './handyman-request-scope-set.service';
import { getHandymanRequestCloseReadiness } from './handyman-request-close-readiness.service';
import { closeHandymanRequest, getHandymanRequestClose } from './handyman-request-close.service';

export function createHandymanRequestScopeSetRouter(): Router {
  const router=Router();
  router.get('/handyman/requests/:handymanRequestId/scope-set', authenticationMiddleware, async (req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('Unexpected scope-set query parameters.');
      sendSuccess(res,await getHandymanRequestScopeSet(req.params.handymanRequestId,req.auth.userId));
    } catch (error) { next(error); }
  });
  router.get('/handyman/requests/:handymanRequestId/close-readiness', authenticationMiddleware, async (req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('Unexpected close-readiness query parameters.');
      sendSuccess(res,await getHandymanRequestCloseReadiness(req.params.handymanRequestId,req.auth.userId));
    } catch (error) { next(error); }
  });
  router.get('/handyman/requests/:handymanRequestId/close', authenticationMiddleware, async (req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('Unexpected Request close query parameters.');
      sendSuccess(res,await getHandymanRequestClose(req.params.handymanRequestId,req.auth));
    } catch (error) { next(error); }
  });
  router.post('/handyman/requests/:handymanRequestId/close', authenticationMiddleware, async (req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('Unexpected Request close query parameters.');
      const result=await closeHandymanRequest(req.params.handymanRequestId,req.auth,req.body);
      sendSuccess(res,result,result.replayed?200:201);
    } catch (error) { next(error); }
  });
  return router;
}
