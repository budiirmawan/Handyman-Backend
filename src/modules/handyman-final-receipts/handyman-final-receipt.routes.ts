import { Router, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { downloadFinalReceipt, issueFinalReceipt } from './handyman-final-receipt.service';

const base='/handyman/execution-scopes/:executionScopeId/invoices/:invoiceId/final-receipt';
export function sendFinalReceiptPdf(res:Response,receipt:Awaited<ReturnType<typeof downloadFinalReceipt>>) {
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${receipt.filename}"`);
  res.setHeader('Content-Length',String(receipt.fileSize));
  res.setHeader('X-Document-Source-SHA256',receipt.sourceChecksum); res.setHeader('X-Content-SHA256',receipt.pdfChecksum);
  res.setHeader('X-Final-Receipt-Number',receipt.number); res.send(receipt.bytes);
}
export function createHandymanFinalReceiptRouter():Router {
  const router=Router();
  router.post(base,authenticationMiddleware,requirePermission('handyman.finance.manage'),async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length || (req.body!==undefined && (!req.body || typeof req.body!=='object' ||
          Array.isArray(req.body) || Object.keys(req.body).length))) throw AppError.validation('No caller-supplied settlement or issuer fields are accepted.');
      const receipt=await issueFinalReceipt(req.auth,req.params.executionScopeId as string,req.params.invoiceId as string);
      const downloadPath=`/api/v1/handyman/execution-scopes/${receipt.executionScopeId}/invoices/${receipt.invoiceId}/final-receipt.pdf`;
      res.setHeader('Location',downloadPath);res.status(receipt.replayed?200:201).json({data:{...receipt,downloadPath}});
    } catch(error) {next(error);}
  });
  router.get(`${base}.pdf`,authenticationMiddleware,async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length || (req.body && Object.keys(req.body).length)) throw AppError.validation('No query or body fields are accepted.');
      sendFinalReceiptPdf(res,await downloadFinalReceipt(req.auth,req.params.executionScopeId as string,req.params.invoiceId as string));
    } catch(error) {next(error);}
  });
  return router;
}
