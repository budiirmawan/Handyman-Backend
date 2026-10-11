import type { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';
import { provisionBmStaffBinding, grantBmStaffScope, revokeBmStaffAuthority, logoutBmStaffSession, revokeBmStaffSessionById } from './bm-staff-authority.service';

export function mountBmStaffAuthorityRoutes(router:Router) {
  const base='/handyman/care/staff-authority';
  router.post(`${base}/bindings`,authenticationMiddleware,async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try {if(Object.keys(req.query).length) throw AppError.validation('No query parameters.');
      sendSuccess(res,await provisionBmStaffBinding(req.auth.userId,req.body),201);
    } catch(e){next(adminError(e));}
  });
  router.post(`${base}/bindings/:bindingId/grants`,authenticationMiddleware,async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try {if(Object.keys(req.query).length) throw AppError.validation('No query parameters.');
      sendSuccess(res,await grantBmStaffScope(req.auth.userId,req.params.bindingId,req.body),201);
    } catch(e){next(adminError(e));}
  });
  for(const kind of ['bindings','grants','sessions'] as const) router.delete(`${base}/${kind}/:id`,authenticationMiddleware,async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try {
      if(Object.keys(req.query).length || (req.body!==undefined && (!req.body || typeof req.body!=='object' || Array.isArray(req.body) || Object.keys(req.body).length))) throw AppError.validation('No context fields accepted.');
      if(kind==='sessions') await revokeBmStaffSessionById(req.auth.userId,req.params.id);
      else await revokeBmStaffAuthority(req.auth.userId,kind,req.params.id);
      res.status(204).end();
    } catch(e){next(e);}
  });
  for(const method of ['get','delete'] as const) router[method]('/handyman/care/staff-sso/session',async(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try {
      if(Object.keys(req.query).length || (req.body!==undefined && (!req.body || typeof req.body!=='object' || Array.isArray(req.body) || Object.keys(req.body).length))) throw AppError.validation('No context fields accepted.');
      const match=/^Bearer (hbs_[A-Za-z0-9_-]{43})$/.exec(req.header('authorization')??'');
      if(!match) throw workspaceUnauthorized();
      if(method==='delete'){await logoutBmStaffSession(match[1]);res.status(204).end();}
      else {const p=await resolveCareWorkspacePrincipal(match[1]);sendSuccess(res,{principalType:'BM_STAFF',sessionId:p.sessionId,userId:p.staffUserId,buildingId:p.staffBuildingId,tenantCompanyId:p.staffTenantCompanyId,expiresAt:p.expiresAt});}
    } catch(e){next(e);}
  });
}
function adminError(e:unknown) {
  if((e as {code?:string})?.code==='23505') return new AppError({code:'CONFLICT',statusCode:409,message:'An active staff binding or scope already exists.'});
  return e;
}
