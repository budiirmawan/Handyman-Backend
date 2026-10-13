import {Router, type Request, type Response, type NextFunction} from 'express';
import {authenticationMiddleware} from '../auth/authentication.middleware';
import {sendSuccess} from '../../shared/api-response';
import {AppError} from '../../shared/errors';
import {readMyHandymanFieldFeed} from './handyman-field-feed.service';

export function createHandymanFieldFeedRouter():Router {
 const r=Router();
 r.get('/handyman/field/my-jobs',authenticationMiddleware,
  async(req:Request,res:Response,next:NextFunction)=>{
   try {
    if(Object.keys(req.query).length) throw AppError.validation('Query parameters not supported.');
    sendSuccess(res,await readMyHandymanFieldFeed(req.auth.userId));
   } catch(error){next(error);}
  });
 return r;
}
