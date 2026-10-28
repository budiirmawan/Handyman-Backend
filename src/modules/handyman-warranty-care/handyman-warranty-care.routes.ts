import { Router, type RequestHandler, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../handyman-care-authority';
import { runSingleFileUpload } from '../handyman-api/handyman-api.controller';
import { getCareWarrantyCertificate, listCareWarrantyCertificates } from './handyman-warranty-care-certificate.service';
import {
  authorizeComplaintUpload, confirmComplaintReporter, createComplaint, getAssessorComplaint,
  getComplaintDetail, getComplaintStatus, listComplaints, readAssessorComplaintEvidence,
  readCareComplaintEvidence, submitComplaintClaim, uploadComplaintEvidence,
} from './handyman-warranty-care.service';

const param = (v: string | string[]) => Array.isArray(v) ? v[0] : v;
const noStore: RequestHandler = (_req,res,next) => { res.set('Cache-Control','private, no-store'); next(); };
function sendFile(res: Response, file: {buffer:Buffer;mimeType:string;fileName:string}) {
  res.set('Cache-Control','private, no-store');
  res.set('X-Content-Type-Options','nosniff');
  res.set('Content-Type',file.mimeType);
  res.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.send(file.buffer);
}

/** Dedicated local Care routes; no new assessment or commercial permissions. */
export function createHandymanWarrantyCareRouter(): Router {
  const router=Router(), auth=authenticationMiddleware, care=requirePermission(HANDYMAN_CARE_BUILDING_PERMISSION);
  const certificates='/handyman/care/buildings/:buildingId/warranty-certificates';
  router.get(certificates,noStore,auth,care,async(req,res,next)=>{
    try { sendSuccess(res,await listCareWarrantyCertificates(req.auth.userId,param(req.params.buildingId),
      req.query as Record<string,unknown>,req.body)); } catch(e){next(e);}
  });
  router.get(`${certificates}/:certificateId`,noStore,auth,care,async(req,res,next)=>{
    try { sendSuccess(res,await getCareWarrantyCertificate(req.auth.userId,param(req.params.buildingId),
      param(req.params.certificateId),req.query as Record<string,unknown>,req.body)); } catch(e){next(e);}
  });
  const base='/handyman/care/buildings/:buildingId/warranty-complaints', detail=`${base}/:complaintId`;
  router.post(base,auth,care,async(req,res,next)=>{
    try { const result=await createComplaint(req.auth,param(req.params.buildingId),req.body);
      sendSuccess(res,result,result.replayed?200:201); } catch(e){next(e);}
  });
  router.get(base,auth,care,async(req,res,next)=>{
    try {
      if (req.query.requestId!==undefined && typeof req.query.requestId!=='string') throw AppError.validation('requestId must be a UUID.');
      sendSuccess(res,await listComplaints(req.auth,param(req.params.buildingId),req.query.requestId as string | undefined));
    } catch(e){next(e);}
  });
  router.get(detail,auth,care,async(req,res,next)=>{
    try { sendSuccess(res,await getComplaintDetail(req.auth,param(req.params.buildingId),param(req.params.complaintId))); } catch(e){next(e);}
  });
  router.get(`${detail}/status`,auth,care,async(req,res,next)=>{
    try { sendSuccess(res,await getComplaintStatus(req.auth,param(req.params.buildingId),param(req.params.complaintId))); } catch(e){next(e);}
  });
  router.post(`${detail}/evidence`,auth,care,async(req,res,next)=>{
    try {
      const buildingId=param(req.params.buildingId),complaintId=param(req.params.complaintId);
      await authorizeComplaintUpload(req.auth,buildingId,complaintId);
      const file=await runSingleFileUpload(req,res);
      const result=await uploadComplaintEvidence(req.auth,buildingId,complaintId,req.body,file);
      sendSuccess(res,result,result.replayed?200:201);
    } catch(e){next(e);}
  });
  router.get(`${detail}/evidence/:evidenceId`,auth,care,async(req,res,next)=>{
    try { sendFile(res,await readCareComplaintEvidence(req.auth,param(req.params.buildingId),param(req.params.complaintId),param(req.params.evidenceId))); }
    catch(e){next(e);}
  });
  router.post(`${detail}/submit-claim`,auth,care,async(req,res,next)=>{
    try { const result=await submitComplaintClaim(req.auth,param(req.params.buildingId),param(req.params.complaintId),req.body);
      sendSuccess(res,result,result.replayed?200:201); } catch(e){next(e);}
  });
  // This is solely a self-identification statement from the authenticated PIC,
  // not a Care assertion, commercial consent or a warranty assessment.
  router.post('/handyman/warranty-complaints/:complaintId/reporter-confirmation',auth,async(req,res,next)=>{
    try { const result=await confirmComplaintReporter(req.auth,param(req.params.complaintId),req.body);
      sendSuccess(res,result,result.replayed?200:201); } catch(e){next(e);}
  });
  // The assessment principal must be independently authorized for this exact
  // claim. These projections never include internal Care notes or storage keys.
  router.get('/handyman/service-warranty-claims/:claimId/complaint',auth,async(req,res,next)=>{
    try { sendSuccess(res,await getAssessorComplaint(req.auth,param(req.params.claimId))); } catch(e){next(e);}
  });
  router.get('/handyman/service-warranty-claims/:claimId/complaint/evidence/:evidenceId',auth,async(req,res,next)=>{
    try { sendFile(res,await readAssessorComplaintEvidence(req.auth,param(req.params.claimId),param(req.params.evidenceId))); }
    catch(e){next(e);}
  });
  return router;
}
