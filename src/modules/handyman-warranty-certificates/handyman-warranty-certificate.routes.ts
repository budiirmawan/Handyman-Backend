import { Router, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { downloadWarrantyCertificate, issueWarrantyCertificate } from './handyman-warranty-certificate.service';

export function sendWarrantyCertificatePdf(res:Response, doc:Awaited<ReturnType<typeof downloadWarrantyCertificate>>, historical=false) {
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${historical ? `historical-${doc.filename}` : doc.filename}"`);
  res.setHeader('Content-Length',String(doc.fileSize));
  res.setHeader('X-Document-Source-SHA256',doc.sourceChecksum); res.setHeader('X-Content-SHA256',doc.pdfChecksum);
  res.setHeader('X-Warranty-Certificate-Id',doc.id); res.setHeader('X-Warranty-Certificate-Number',doc.number);
  res.send(doc.bytes);
}
export function createHandymanWarrantyCertificateRouter():Router {
  const router=Router(),base='/handyman/execution-scopes/:executionScopeId/warranty-certificates';
  router.post(base,authenticationMiddleware,requirePermission('handyman.commercial.manage'),async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length || !req.body || typeof req.body!=='object' || Array.isArray(req.body) ||
          Object.keys(req.body).some(k=>!['warrantyId','bastId','manifestId','manifestVersion','manifestSha256','idempotencyKey','documentLanguage'].includes(k)))
        throw AppError.validation('Exact reviewed warranty, BAST and manifest pins are required.');
      const doc=await issueWarrantyCertificate(req.auth.userId,{executionScopeId:req.params.executionScopeId as string,...req.body});
      const downloadPath=`/api/v1/handyman/execution-scopes/${req.params.executionScopeId}/warranty-certificates/${doc.id}.pdf`;
      res.setHeader('Location',downloadPath); res.status(doc.replayed?200:201).json({data:{...doc,downloadPath}});
    } catch(error){next(error);}
  });
  router.get(`${base}/:certificateId.pdf`,authenticationMiddleware,async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
      sendWarrantyCertificatePdf(res,await downloadWarrantyCertificate(req.auth.userId,req.params.executionScopeId as string,req.params.certificateId as string));
    }catch(error){next(error);}
  });
  router.get(`${base}/:certificateId/historical.pdf`,authenticationMiddleware,async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store'); res.setHeader('X-Warranty-Certificate-Status','HISTORICAL');
      if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
      sendWarrantyCertificatePdf(res,await downloadWarrantyCertificate(req.auth.userId,req.params.executionScopeId as string,req.params.certificateId as string,true),true);
    }catch(error){next(error);}
  });
  return router;
}
