import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { tenantInvoiceNotFoundError, tenantInvoiceRepository } from '../tenant-invoices';
import {
  invoicePaymentStatusAlreadyExistsError, invoicePaymentStatusAmountInvalidError,
  invoicePaymentStatusCancelledError, invoicePaymentStatusInvoiceInvalidError,
  invoicePaymentStatusNotFoundError, invoicePaymentStatusPaidAtRequiredError,
} from './invoice-payment-status.errors';
import { invoicePaymentStatusRepository } from './invoice-payment-status.repository';
import type {
  InvoicePaymentStatus, InvoicePaymentStatusFilters, InvoicePaymentStatusRecord,
  NewInvoicePaymentStatus, PublicInvoicePaymentStatus,
  RecordInvoicePaymentStatusInput, UpdateInvoicePaymentStatusInput,
} from './invoice-payment-status.types';

function toPublic(record: InvoicePaymentStatusRecord): PublicInvoicePaymentStatus {
  const { invoiceTotal: _invoiceTotal, invoiceDueDate: _invoiceDueDate,
    invoiceStatus: _invoiceStatus, ...base } = record;
  return { ...base, paidAmount:Number(record.paidAmount),
    outstandingAmount:Number(record.outstandingAmount),
    paidAt:record.paidAt?.toISOString()??null,
    createdAt:record.createdAt.toISOString(),updatedAt:record.updatedAt.toISOString() };
}
function isUniqueViolation(error:unknown):boolean{return typeof error==='object'&&error!==null&&'code'in error&&error.code==='23505';}
export function resolveInvoicePaymentStatus(input:{
  invoiceStatus:string; invoiceTotal:number; paidAmount:number; dueDate:string; now?:Date;
}):{paymentStatus:InvoicePaymentStatus;outstandingAmount:number}{
  if(input.paidAmount<0||input.paidAmount>input.invoiceTotal)throw invoicePaymentStatusAmountInvalidError();
  const outstandingAmount=Math.max(input.invoiceTotal-input.paidAmount,0);
  if(input.invoiceStatus==='CANCELLED')return{paymentStatus:'CANCELLED',outstandingAmount};
  if(outstandingAmount===0)return{paymentStatus:'PAID',outstandingAmount:0};
  const today=(input.now??new Date()).toISOString().slice(0,10);
  if(input.dueDate<today)return{paymentStatus:'OVERDUE',outstandingAmount};
  if(input.paidAmount>0)return{paymentStatus:'PARTIALLY_PAID',outstandingAmount};
  return{paymentStatus:'UNPAID',outstandingAmount};
}
function assertPaidAt(paidAmount:number,paidAt:Date|null):void{
  if(paidAmount>0&&!paidAt)throw invoicePaymentStatusPaidAtRequiredError();
}
async function loadAccessibleById(id:string,actor:string):Promise<InvoicePaymentStatusRecord>{
  const record=await invoicePaymentStatusRepository.findById(id);if(!record)throw invoicePaymentStatusNotFoundError();
  await contextAccessService.assertBuildingAccess(actor,record.buildingId);return record;
}
export async function recordInvoicePaymentStatus(input:RecordInvoicePaymentStatusInput,actor:string):Promise<PublicInvoicePaymentStatus>{
  const invoice=await tenantInvoiceRepository.findById(input.invoiceId);if(!invoice)throw tenantInvoiceNotFoundError();
  await contextAccessService.assertBuildingAccess(actor,invoice.buildingId);
  if(!['FINALIZED','CANCELLED'].includes(invoice.status))throw invoicePaymentStatusInvoiceInvalidError();
  if(await invoicePaymentStatusRepository.findByInvoiceId(invoice.id))throw invoicePaymentStatusAlreadyExistsError();
  const paidAt=input.paidAmount===0?null:(input.paidAt??null);assertPaidAt(input.paidAmount,paidAt);
  const resolved=resolveInvoicePaymentStatus({invoiceStatus:invoice.status,invoiceTotal:Number(invoice.totalAmount),paidAmount:input.paidAmount,dueDate:invoice.dueDate});
  const payload:NewInvoicePaymentStatus={invoiceId:invoice.id,clientId:invoice.clientId,
    tenantCompanyId:invoice.tenantCompanyId,buildingId:invoice.buildingId,
    ...resolved,paidAmount:input.paidAmount,paidAt,
    paymentReference:input.paymentReference?.trim()||null,notes:input.notes?.trim()||null,
    recordedByUserId:actor};
  try{const record=await invoicePaymentStatusRepository.create(payload);
    await recordOperationalEvent({clientId:record.clientId,buildingId:record.buildingId,
      eventType:'INVOICE_PAYMENT_STATUS_RECORDED',entityType:'INVOICE_PAYMENT_STATUS',entityId:record.id,
      actorUserId:actor,summary:`Invoice settlement status recorded as ${record.paymentStatus}.`,
      metadata:{invoiceId:record.invoiceId,paidAmount:record.paidAmount,outstandingAmount:record.outstandingAmount}});
    return toPublic(record);}catch(error){if(isUniqueViolation(error))throw invoicePaymentStatusAlreadyExistsError();throw error;}
}
export async function getInvoicePaymentStatus(invoiceId:string,actor:string):Promise<PublicInvoicePaymentStatus>{
  let record=await invoicePaymentStatusRepository.findByInvoiceId(invoiceId);if(!record)throw invoicePaymentStatusNotFoundError();
  await contextAccessService.assertBuildingAccess(actor,record.buildingId);
  await invoicePaymentStatusRepository.refreshDerivedForInvoice(invoiceId,actor);
  record=await invoicePaymentStatusRepository.findByInvoiceId(invoiceId);return toPublic(record!);
}
export async function listInvoicePaymentStatuses(filters:InvoicePaymentStatusFilters,actor:string):Promise<PublicInvoicePaymentStatus[]>{
  if(filters.buildingId)await contextAccessService.assertBuildingAccess(actor,filters.buildingId);
  const ids=await contextAccessService.getAccessibleBuildingIds(actor);
  await invoicePaymentStatusRepository.refreshDerivedForBuildings(ids,actor);
  return(await invoicePaymentStatusRepository.list(filters,ids)).map(toPublic);
}
export async function updateInvoicePaymentStatus(id:string,input:UpdateInvoicePaymentStatusInput,actor:string):Promise<PublicInvoicePaymentStatus>{
  const current=await loadAccessibleById(id,actor);if(current.invoiceStatus==='CANCELLED'||current.paymentStatus==='CANCELLED')throw invoicePaymentStatusCancelledError();
  const paidAmount=input.paidAmount??Number(current.paidAmount);
  const paidAt=paidAmount===0?null:(input.paidAt===undefined?current.paidAt:input.paidAt);
  assertPaidAt(paidAmount,paidAt);
  const resolved=resolveInvoicePaymentStatus({invoiceStatus:current.invoiceStatus,
    invoiceTotal:Number(current.invoiceTotal),paidAmount,dueDate:current.invoiceDueDate});
  const updated=await invoicePaymentStatusRepository.update(id,{...input,paidAmount,paidAt,...resolved},actor);
  if(!updated)throw invoicePaymentStatusNotFoundError();
  await recordOperationalEvent({clientId:updated.clientId,buildingId:updated.buildingId,
    eventType:'INVOICE_PAYMENT_STATUS_UPDATED',entityType:'INVOICE_PAYMENT_STATUS',entityId:updated.id,
    actorUserId:actor,summary:`Invoice settlement status updated to ${updated.paymentStatus}.`,
    metadata:{invoiceId:updated.invoiceId,paidAmount:updated.paidAmount,outstandingAmount:updated.outstandingAmount}});
  return toPublic(updated);
}
export const invoicePaymentStatusService={getInvoicePaymentStatus,listInvoicePaymentStatuses,
  recordInvoicePaymentStatus,resolveInvoicePaymentStatus,updateInvoicePaymentStatus};
