import type{NextFunction,Request,Response}from'express';
import{sendSuccess}from'../../shared/api-response';import{authenticationRequiredError}from'../auth';
import{invoicePaymentStatusService}from'./invoice-payment-status.service';
import{parseInvoicePaymentStatusFilters,parseInvoicePaymentStatusIdParam,
parseInvoicePaymentStatusInvoiceIdParam,parseRecordInvoicePaymentStatusBody,
parseUpdateInvoicePaymentStatusBody}from'./invoice-payment-status.validation';
const param=(v:string|string[]|undefined):string=>Array.isArray(v)?(v[0]??''):(v??'');
function actor(req:Request):string{if(!req.auth)throw authenticationRequiredError();return req.auth.userId;}
export async function recordInvoicePaymentStatusHandler(req:Request,res:Response,next:NextFunction):Promise<void>{try{const invoiceId=parseInvoicePaymentStatusInvoiceIdParam(param(req.params.invoiceId));sendSuccess(res,await invoicePaymentStatusService.recordInvoicePaymentStatus({...parseRecordInvoicePaymentStatusBody(req.body),invoiceId},actor(req)),201);}catch(e){next(e)}}
export async function getInvoicePaymentStatusHandler(req:Request,res:Response,next:NextFunction):Promise<void>{try{sendSuccess(res,await invoicePaymentStatusService.getInvoicePaymentStatus(parseInvoicePaymentStatusInvoiceIdParam(param(req.params.invoiceId)),actor(req)));}catch(e){next(e)}}
export async function listInvoicePaymentStatusesHandler(req:Request,res:Response,next:NextFunction):Promise<void>{try{sendSuccess(res,await invoicePaymentStatusService.listInvoicePaymentStatuses(parseInvoicePaymentStatusFilters(req.query),actor(req)));}catch(e){next(e)}}
export async function updateInvoicePaymentStatusHandler(req:Request,res:Response,next:NextFunction):Promise<void>{try{sendSuccess(res,await invoicePaymentStatusService.updateInvoicePaymentStatus(parseInvoicePaymentStatusIdParam(param(req.params.id)),parseUpdateInvoicePaymentStatusBody(req.body),actor(req)));}catch(e){next(e)}}
