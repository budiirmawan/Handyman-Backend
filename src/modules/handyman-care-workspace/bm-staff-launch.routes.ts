import type { Router } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { getAppConfig } from '../../config';
import { isLoginRateLimited, recordLoginFailure, recordLoginSuccess } from '../auth/login-rate-limit';
import { issueBmStaffLaunch, exchangeBmStaffLaunch, revokeBmStaffLaunch } from './bm-staff-launch.service';

/** Transport and explicitly provisioned staff admission; default deny. */
export function mountBmStaffLaunchRoutes(router: Router) {
  for (const action of ['launches','exchange','revoke'] as const) {
    router.post(`/handyman/care/staff-sso/${action}`,async(req,res,next)=>{
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('X-Handyman-Staff-SSO','explicit-authority-required');
      const key=`handyman-bm-staff-${action}:${req.socket.remoteAddress??'unknown'}`;
      try {
        if(isLoginRateLimited(key)) {
          res.setHeader('Retry-After',String(getAppConfig().security.loginRateLimitWindowMinutes*60));
          throw new AppError({code:'AUTH_RATE_LIMITED',statusCode:429,message:'Too many handoff attempts.'});
        }
        if(Object.keys(req.query).length) throw AppError.validation('Handoff credentials must be sent in the body, never URL parameters.');
        if(action==='launches') {
          const result=await issueBmStaffLaunch(req.body,req.header('x-hub-signature-256'));
          recordLoginSuccess(key);
          sendSuccess(res,result,202);
        } else {
          if(!req.body || typeof req.body!=='object' || Array.isArray(req.body) ||
             Object.keys(req.body).some(k=>!(action==='exchange'?['launchReference','tenantCompanyId']:['launchReference']).includes(k)) || !('launchReference' in req.body)) throw AppError.validation('Only launchReference and, for exchange, tenantCompanyId are accepted.');
          if(action==='exchange') { const session=await exchangeBmStaffLaunch(req.body.launchReference,req.body.tenantCompanyId); recordLoginSuccess(key); sendSuccess(res,session,201); }
          else { await revokeBmStaffLaunch(req.body.launchReference); recordLoginSuccess(key); res.status(204).end(); }
        }
      } catch(error) {
        if(error instanceof AppError && error.statusCode===401) recordLoginFailure(key);
        next(error);
      }
    });
  }
}
