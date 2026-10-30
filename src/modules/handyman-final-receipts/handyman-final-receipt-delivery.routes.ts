import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { workspaceRecorder } from '../handyman-quotations/handyman-quotation-delivery.service';
import { acknowledgeFinalDelivery, authorizeFinalDeliveryUpload, inspectFinalDeliveryForRecipient,
  listFinalDelivery, readFinalDeliveryEvidence, recordFinalDeliverySent, uploadFinalDeliveryEvidence,
  type DeliveryRecorder, type DeliveryScope } from './handyman-final-receipt-delivery.service';

const local='/handyman/care/buildings/:buildingId/requests/:requestId/final-receipts/:receiptId/versions/:version';
const workspace='/handyman/care/requests/:requestId/final-receipts/:receiptId/versions/:version';
const recipient='/handyman/final-receipts/:receiptId/versions/:version/delivery-events/:sentEventId/acknowledgement';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10_485_760,files:1,fields:1,parts:3}});
function file(req:Request,res:Response):Promise<Express.Multer.File> {
  return new Promise((resolve,reject)=>upload.single('file')(req,res,(error:unknown)=>{
    if (error) { reject(AppError.validation('A single evidence file up to 10 MB is required.')); return; }
    if (!req.file) { reject(AppError.validation('Multipart field file is required.')); return; }
    resolve(req.file);
  }));
}
function scope(p:Record<string,string|string[]>):DeliveryScope {
  return {buildingId:p.buildingId as string|undefined,requestId:p.requestId as string,receiptId:p.receiptId as string,version:p.version as string};
}
function clean(req:Request, body=false) {
  if (Object.keys(req.query).length || (body && req.body && (typeof req.body!=='object' || Array.isArray(req.body) || Object.keys(req.body).length)))
    throw AppError.validation('Unexpected query or body fields.');
}
function sendEvidence(res:Response,data:{buffer:Buffer;mimeType:string;fileName:string}) {
  res.set('Cache-Control','private, no-store'); res.set('X-Content-Type-Options','nosniff');
  res.set('Content-Type',data.mimeType); res.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(data.fileName)}`);
  res.send(data.buffer);
}
async function workspaceActor(req:Request):Promise<DeliveryRecorder> {
  const recorder=await workspaceRecorder(req.header('authorization'));
  if (!recorder.principal) throw AppError.notFound('Final Receipt delivery resource not found.');
  return {principal:recorder.principal};
}
export function createFinalReceiptDeliveryRouter():Router {
  const router=Router(), localAuth=[authenticationMiddleware,requirePermission('handyman.care.building')];
  router.use([local,workspace,recipient],(_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
  const localActor=(req:Request):DeliveryRecorder=>({userId:req.auth.userId,sessionId:req.auth.sessionId});
  router.get(`${local}/delivery-events`,...localAuth,async(req,res,next)=>{
    try {clean(req,true); sendSuccess(res,await listFinalDelivery(localActor(req),scope(req.params)));} catch(e){next(e);}
  });
  router.post(`${local}/delivery-events`,...localAuth,async(req,res,next)=>{
    try {clean(req); const result=await recordFinalDeliverySent(localActor(req),scope(req.params),req.body);
      sendSuccess(res,result,result.replayed?200:201);} catch(e){next(e);}
  });
  router.post(`${local}/delivery-evidence`,...localAuth,async(req,res,next)=>{
    try {clean(req); const actor=localActor(req), context=scope(req.params); await authorizeFinalDeliveryUpload(actor,context);
      const f=await file(req,res), result=await uploadFinalDeliveryEvidence(actor,context,req.body,f);
      sendSuccess(res,result,result.replayed?200:201);} catch(e){next(e);}
  });
  router.get(`${local}/delivery-evidence/:evidenceId`,...localAuth,async(req,res,next)=>{
    try {clean(req,true); sendEvidence(res,await readFinalDeliveryEvidence(localActor(req),scope(req.params),req.params.evidenceId as string));} catch(e){next(e);}
  });
  router.get(`${workspace}/delivery-events`,async(req,res,next)=>{
    try {clean(req,true); sendSuccess(res,await listFinalDelivery(await workspaceActor(req),scope(req.params)));} catch(e){next(e);}
  });
  router.post(`${workspace}/delivery-events`,async(req,res,next)=>{
    try {clean(req); const result=await recordFinalDeliverySent(await workspaceActor(req),scope(req.params),req.body);
      sendSuccess(res,result,result.replayed?200:201);} catch(e){next(e);}
  });
  router.post(`${workspace}/delivery-evidence`,async(req,res,next)=>{
    try {clean(req); const actor=await workspaceActor(req),context=scope(req.params); await authorizeFinalDeliveryUpload(actor,context);
      const f=await file(req,res), result=await uploadFinalDeliveryEvidence(actor,context,req.body,f);
      sendSuccess(res,result,result.replayed?200:201);} catch(e){next(e);}
  });
  router.get(`${workspace}/delivery-evidence/:evidenceId`,async(req,res,next)=>{
    try {clean(req,true); sendEvidence(res,await readFinalDeliveryEvidence(await workspaceActor(req),scope(req.params),req.params.evidenceId as string));} catch(e){next(e);}
  });
  router.get(recipient,authenticationMiddleware,async(req,res,next)=>{
    try {clean(req,true); sendSuccess(res,await inspectFinalDeliveryForRecipient(req.auth,req.params.receiptId as string,
      req.params.version as string,req.params.sentEventId as string));} catch(e){next(e);}
  });
  router.post(recipient,authenticationMiddleware,async(req,res,next)=>{
    try {clean(req); const result=await acknowledgeFinalDelivery(req.auth,req.params.receiptId as string,req.params.version as string,
      req.params.sentEventId as string,req.body); sendSuccess(res,result,result.replayed?200:201);} catch(e){next(e);}
  });
  return router;
}
