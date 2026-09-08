import{randomUUID}from'node:crypto';import type{PoolClient}from'pg';import{getPool,withTransaction}from'../../database';
import type{NewPaymentReceipt,PaymentReceiptFilters,PaymentReceiptRecord}from'./payment-receipt.types';
const SELECT=`id,receipt_number AS "receiptNumber",invoice_id AS "invoiceId",
 invoice_payment_status_id AS "invoicePaymentStatusId",client_id AS "clientId",
 tenant_company_id AS "tenantCompanyId",building_id AS "buildingId",
 received_amount::text AS "receivedAmount",received_at AS "receivedAt",
 payment_reference AS "paymentReference",payment_method AS "paymentMethod",status,notes,
 issued_by_user_id AS "issuedByUserId",voided_at AS "voidedAt",
 voided_by_user_id AS "voidedByUserId",created_at AS "createdAt",updated_at AS "updatedAt"`;
type Action='ISSUED'|'VOIDED';
async function appendHistory(c:PoolClient,r:PaymentReceiptRecord,action:Action,actor:string){await c.query(
 `INSERT INTO payment_receipt_history(id,payment_receipt_id,action,status,received_amount,
  received_at,payment_reference,payment_method,notes,changed_by_user_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),r.id,action,r.status,r.receivedAmount,r.receivedAt,r.paymentReference,r.paymentMethod,r.notes,actor]);}
async function createIfCovered(input:NewPaymentReceipt):Promise<PaymentReceiptRecord|null>{return withTransaction(async c=>{
 const lock=await c.query(`SELECT id FROM invoice_payment_status WHERE id=$1 FOR UPDATE`,[input.invoicePaymentStatusId]);if(!lock.rowCount)return null;
 const result=await c.query<PaymentReceiptRecord>(`INSERT INTO payment_receipts
  (id,receipt_number,invoice_id,invoice_payment_status_id,client_id,tenant_company_id,
   building_id,received_amount,received_at,payment_reference,payment_method,notes,issued_by_user_id)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
  FROM invoice_payment_status ps WHERE ps.id=$4
   AND $8::numeric+(SELECT COALESCE(SUM(received_amount),0) FROM payment_receipts
     WHERE invoice_payment_status_id=$4 AND status='ISSUED')<=ps.paid_amount
  RETURNING ${SELECT}`,[randomUUID(),input.receiptNumber,input.invoiceId,input.invoicePaymentStatusId,
   input.clientId,input.tenantCompanyId,input.buildingId,input.receivedAmount,input.receivedAt,
   input.paymentReference,input.paymentMethod,input.notes,input.issuedByUserId]);
 const record=result.rows[0]??null;if(record)await appendHistory(c,record,'ISSUED',input.issuedByUserId);return record;});}
async function findById(id:string){const r=await getPool().query<PaymentReceiptRecord>(`SELECT ${SELECT} FROM payment_receipts WHERE id=$1`,[id]);return r.rows[0]??null;}
async function list(filters:PaymentReceiptFilters,buildingIds:string[]):Promise<PaymentReceiptRecord[]>{if(!buildingIds.length)return[];const values:unknown[]=[buildingIds],clauses=['building_id=ANY($1::uuid[])'];
 const exact:[keyof PaymentReceiptFilters,string][]=[['tenantCompanyId','tenant_company_id'],['invoiceId','invoice_id'],['buildingId','building_id'],['status','status']];
 for(const[key,col]of exact)if(filters[key]!==undefined){values.push(filters[key]);clauses.push(`${col}=$${values.length}`)}
 if(filters.receivedFrom){values.push(filters.receivedFrom);clauses.push(`received_at>=$${values.length}`)}
 if(filters.receivedTo){values.push(filters.receivedTo);clauses.push(`received_at<=$${values.length}`)}
 const r=await getPool().query<PaymentReceiptRecord>(`SELECT ${SELECT} FROM payment_receipts WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC,created_at DESC`,values);return r.rows;}
async function sumIssuedForPaymentStatus(id:string):Promise<string>{const r=await getPool().query<{total:string}>(`SELECT COALESCE(SUM(received_amount),0)::text AS total FROM payment_receipts WHERE invoice_payment_status_id=$1 AND status='ISSUED'`,[id]);return r.rows[0]?.total??'0';}
async function voidReceipt(id:string,actor:string):Promise<PaymentReceiptRecord|null>{return withTransaction(async c=>{const r=await c.query<PaymentReceiptRecord>(`UPDATE payment_receipts SET status='VOID',voided_at=NOW(),voided_by_user_id=$2,updated_at=NOW() WHERE id=$1 AND status='ISSUED' RETURNING ${SELECT}`,[id,actor]);const record=r.rows[0]??null;if(record)await appendHistory(c,record,'VOIDED',actor);return record;});}
export const paymentReceiptRepository={createIfCovered,findById,list,sumIssuedForPaymentStatus,voidReceipt};
