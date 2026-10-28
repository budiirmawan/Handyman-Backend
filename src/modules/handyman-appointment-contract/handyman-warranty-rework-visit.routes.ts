import { Router, type Request, type Response, type NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { parseVisitParam } from './handyman-visit-api.validation';
import { cancelWarrantyReworkVisit, consentWarrantyReworkVisit, proposeWarrantyReworkVisit, readWarrantyReworkVisit } from './handyman-warranty-rework-visit.service';

const param=(v:string|string[]|undefined)=>parseVisitParam(Array.isArray(v)?v[0]:v);
function body(value:unknown, allowed:string[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))
    throw AppError.validation('Invalid rework appointment input.');
  return value as Record<string,unknown>;
}
const wrap=(fn:(req:Request,res:Response)=>Promise<void>)=>async(req:Request,res:Response,next:NextFunction)=>{
  try { if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not supported.'); await fn(req,res); }
  catch(error) { if (error instanceof Error && /^INVALID_/.test(error.message)) return next(AppError.validation('Invalid rework appointment identifier.')); next(error); }
};
export function createHandymanWarrantyReworkVisitRouter():Router {
  const r=Router(), base='/handyman/service-warranty-reworks/:reworkId/appointments';
  r.get(base,authenticationMiddleware,wrap(async(req,res)=>{
    sendSuccess(res,await readWarrantyReworkVisit(req.auth.userId,param(req.params.reworkId)));
  }));
  r.post(base,authenticationMiddleware,requirePermission('tenant_company.manage'),wrap(async(req,res)=>{
    const b=body(req.body,['startAt','endAt','idempotencyKey','supersedesAppointmentId']);
    const supersedes=b.supersedesAppointmentId==null?null:parseVisitParam(b.supersedesAppointmentId);
    const result=await proposeWarrantyReworkVisit(req.auth.userId,param(req.params.reworkId),{
      startAt:b.startAt as string,endAt:b.endAt as string,idempotencyKey:b.idempotencyKey as string,supersedesAppointmentId:supersedes});
    sendSuccess(res,result,result.replayed?200:201);
  }));
  r.post(`${base}/:appointmentId/consent`,authenticationMiddleware,wrap(async(req,res)=>{
    const b=body(req.body,['version','idempotencyKey']);
    sendSuccess(res,await consentWarrantyReworkVisit(req.auth.userId,req.auth.sessionId,param(req.params.reworkId),param(req.params.appointmentId),
      {version:b.version as number,idempotencyKey:b.idempotencyKey as string}));
  }));
  r.post(`${base}/:appointmentId/cancel`,authenticationMiddleware,requirePermission('tenant_company.manage'),wrap(async(req,res)=>{
    const b=body(req.body,['version','reason']);
    sendSuccess(res,await cancelWarrantyReworkVisit(req.auth.userId,param(req.params.reworkId),param(req.params.appointmentId),
      {version:b.version as number,reason:b.reason as string}));
  }));
  return r;
}
