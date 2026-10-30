import { Router, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { downloadOfficialHandymanInvoice, issueOfficialHandymanInvoice } from './handyman-official-invoice.service';
import { linkOfficialInvoicePayment, readOfficialInvoicePaymentStatus,
  recordObservedOfficialInvoicePayment } from './handyman-official-invoice-payment.service';

export function sendOfficialInvoicePdf(res:Response, document:Awaited<ReturnType<typeof downloadOfficialHandymanInvoice>>) {
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${document.filename}"`);
  res.setHeader('Content-Length',String(document.fileSize));
  res.setHeader('X-Document-Source-SHA256',document.sourceChecksum);
  res.setHeader('X-Content-SHA256',document.pdfChecksum);
  res.setHeader('X-Invoice-Id',document.id); res.setHeader('X-Invoice-Number',document.number);
  res.send(document.bytes);
}
export function createHandymanOfficialInvoiceRouter():Router {
  const router=Router(),base='/handyman/execution-scopes/:executionScopeId/invoices';
  router.post(base,authenticationMiddleware,requirePermission('handyman.finance.manage'),async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length || !req.body || typeof req.body!=='object' || Array.isArray(req.body) ||
          Object.keys(req.body).some(k=>!['classification','documentLanguage'].includes(k))) throw AppError.validation('An exact reviewed classification pin is required.');
      const invoice=await issueOfficialHandymanInvoice(req.auth.userId,{executionScopeId:req.params.executionScopeId as string,
        classification:req.body.classification,documentLanguage:req.body.documentLanguage});
      const downloadPath=`/api/v1/handyman/execution-scopes/${invoice.executionScopeId}/invoices/${invoice.id}.pdf`;
      res.setHeader('Location',downloadPath); res.status(201).json({data:{...invoice,downloadPath}});
    } catch(error) {next(error);}
  });
  router.post(`${base}/:invoiceId/payments/observed`,authenticationMiddleware,requirePermission('handyman.finance.manage'),async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
      const result=await recordObservedOfficialInvoicePayment(req.auth.userId,req.params.executionScopeId as string,
        req.params.invoiceId as string,req.body);
      res.status(result.replayed ? 200 : 201).json({data:result});
    } catch(error) {next(error);}
  });
  router.post(`${base}/:invoiceId/payments/:paymentId/link`,authenticationMiddleware,requirePermission('handyman.finance.manage'),async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length || (req.body !== undefined && (!req.body || typeof req.body!=='object' ||
          Array.isArray(req.body) || Object.keys(req.body).length))) throw AppError.validation('No body or query fields are accepted.');
      const result=await linkOfficialInvoicePayment(req.auth.userId,req.params.executionScopeId as string,
        req.params.invoiceId as string,req.params.paymentId as string);
      res.status(result.replayed ? 200 : 201).json({data:result});
    } catch(error) {next(error);}
  });
  router.get(`${base}/:invoiceId/payment-status`,authenticationMiddleware,requirePermission('handyman.finance.read'),async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
      const result=await readOfficialInvoicePaymentStatus(req.auth.userId,req.params.executionScopeId as string,req.params.invoiceId as string);
      res.status(200).json({data:result});
    } catch(error) {next(error);}
  });
  router.get(`${base}/:invoiceId.pdf`,authenticationMiddleware,async(req,res,next)=>{
    try {
      res.setHeader('Cache-Control','private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
      sendOfficialInvoicePdf(res,await downloadOfficialHandymanInvoice(req.auth.userId,req.params.executionScopeId as string,req.params.invoiceId as string));
    } catch(error) {next(error);}
  });
  return router;
}
