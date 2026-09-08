import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INVOICE_PAYMENT_STATUSES, isInvoicePaymentStatus,
  type InvoicePaymentStatus, type InvoicePaymentStatusFilters,
  type RecordInvoicePaymentStatusInput, type UpdateInvoicePaymentStatusInput,
} from './invoice-payment-status.types';
type Detail = { field: string; message: string };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function fail(details: Detail[]): never { throw AppError.validation('Request validation failed.', details); }
function parseId(raw: string, field: string): string { const value = raw.trim().toLowerCase(); if (!isValidUuid(value)) fail([{field,message:`${field} must be a valid UUID.`}]); return value; }
export const parseInvoicePaymentStatusIdParam = (raw: string): string => parseId(raw, 'invoicePaymentStatusId');
export const parseInvoicePaymentStatusInvoiceIdParam = (raw: string): string => parseId(raw, 'invoiceId');
export function parseRecordInvoicePaymentStatusBody(body: unknown): Omit<RecordInvoicePaymentStatusInput,'invoiceId'> {
  if (!isRecord(body)) fail([{field:'body',message:'Request body must be a JSON object.'}]);
  const details: Detail[] = []; const paidAmount = readAmount(body.paidAmount, true, details);
  const paidAt = readTimestamp(body.paidAt, 'paidAt', details);
  const paymentReference = readNullableString(body.paymentReference,'paymentReference',255,details);
  const notes = readNullableString(body.notes,'notes',2000,details);
  if (paidAmount === undefined || details.length) fail(details);
  return { paidAmount, ...(paidAt !== undefined ? {paidAt}:{}),
    ...(paymentReference !== undefined ? {paymentReference}:{}), ...(notes !== undefined ? {notes}:{}) };
}
export function parseUpdateInvoicePaymentStatusBody(body: unknown): UpdateInvoicePaymentStatusInput {
  if (!isRecord(body)) fail([{field:'body',message:'Request body must be a JSON object.'}]);
  const immutable = ['invoiceId','clientId','tenantCompanyId','buildingId','paymentStatus','outstandingAmount','invoiceTotal']
    .find(field=>body[field]!==undefined);
  if (immutable) fail([{field:immutable,message:'This field is derived or immutable.'}]);
  const details: Detail[]=[];
  const paidAmount = body.paidAmount===undefined ? undefined : readAmount(body.paidAmount,true,details);
  const paidAt = readTimestamp(body.paidAt,'paidAt',details);
  const paymentReference=readNullableString(body.paymentReference,'paymentReference',255,details);
  const notes=readNullableString(body.notes,'notes',2000,details);
  const result: UpdateInvoicePaymentStatusInput = {
    ...(paidAmount!==undefined?{paidAmount}:{}), ...(paidAt!==undefined?{paidAt}:{}),
    ...(paymentReference!==undefined?{paymentReference}:{}), ...(notes!==undefined?{notes}:{}),
  };
  if (!Object.keys(result).length && !details.length) details.push({field:'body',message:'At least one settlement field is required.'});
  if (details.length) fail(details); return result;
}
export function parseInvoicePaymentStatusFilters(query: unknown): InvoicePaymentStatusFilters {
  if (!isRecord(query)) return {}; const details: Detail[]=[];
  const tenantCompanyId=readId(query.tenantCompanyId,'tenantCompanyId',false,details);
  const buildingId=readId(query.buildingId,'buildingId',false,details);
  const status=readStatus(query.status,details); if(details.length)fail(details);
  return {...(tenantCompanyId?{tenantCompanyId}:{}),...(buildingId?{buildingId}:{}),...(status?{status}:{})};
}
function readId(value:unknown,field:string,required:boolean,details:Detail[]):string|undefined{
  if(value===undefined&&!required)return undefined;if(typeof value!=='string'||!isValidUuid(value.trim())){details.push({field,message:`${field} ${required?'is required and ':''}must be a valid UUID.`});return undefined;}return value.trim().toLowerCase();
}
function readAmount(value:unknown,required:boolean,details:Detail[]):number|undefined{
  if(value===undefined&&!required)return undefined;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>999_999_999_999.999999){details.push({field:'paidAmount',message:'paidAmount must be a finite, non-negative number within the supported range.'});return undefined;}
  if(Math.abs(value*1_000_000-Math.round(value*1_000_000))>1e-5){details.push({field:'paidAmount',message:'paidAmount must have at most six decimal places.'});return undefined;}return value;
}
function readTimestamp(value:unknown,field:string,details:Detail[]):Date|null|undefined{
  if(value===undefined)return undefined;if(value===null)return null;if(typeof value!=='string'||!value.trim()){details.push({field,message:`${field} must be a valid ISO-8601 timestamp or null.`});return undefined;}const date=new Date(value);if(Number.isNaN(date.getTime())){details.push({field,message:`${field} must be a valid ISO-8601 timestamp or null.`});return undefined;}return date;
}
function readNullableString(value:unknown,field:string,max:number,details:Detail[]):string|null|undefined{
  if(value===undefined)return undefined;if(value===null)return null;if(typeof value!=='string'){details.push({field,message:`${field} must be a string or null.`});return undefined;}const text=value.trim();if(!text)return null;if(text.length>max){details.push({field,message:`${field} must be at most ${max} characters.`});return undefined;}return text;
}
function readStatus(value:unknown,details:Detail[]):InvoicePaymentStatus|undefined{
  if(value===undefined)return undefined;if(!isInvoicePaymentStatus(value)){details.push({field:'status',message:`status must be one of: ${INVOICE_PAYMENT_STATUSES.join(', ')}.`});return undefined;}return value;
}
