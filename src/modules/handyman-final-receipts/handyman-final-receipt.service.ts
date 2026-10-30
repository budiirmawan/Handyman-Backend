import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { stableJson } from '../../shared/stable-json';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { permissionRepository } from '../permissions';
import { verifyStoredOfficialInvoice, type OfficialInvoiceStored } from '../handyman-official-invoices/handyman-official-invoice.service';
import { verifyStoredTenantPaymentReceipt, type TenantPaymentReceiptStored } from '../handyman-tenant-receipts/handyman-tenant-receipt.service';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from '../handyman-care-workspace/care-workspace.service';
import { parseCareHandymanPaymentProofSelection } from '../handyman-care-workspace/care-workspace-payment-proof.service';
import { WORKSPACE_OCCUPANCY_CTES } from '../handyman-care-workspace/care-workspace-occupancies.repository';
import { renderReportingPdf, type PdfRenderSnapshot } from '../reporting-export/pdf-renderer';
import type { ReportingExportRow, ReportingExportTable } from '../reporting-export/reporting-export.types';

type Actor={userId:string;sessionId:string};
type InvoiceSource=OfficialInvoiceStored['source_snapshot'];
type Allocation={id:string;chargeLineId:string;amount:string;occurredAt:string};
type Payment={paymentId:string;amount:string;allocatedAmount:string;stage:string;confirmationEventId:string;
  confirmedByUserId:string;confirmedAt:string;verificationBasis:string;reconciliationId:string|null;
  reconciliationVerifiedByUserId:string|null;reconciliationVerifiedAt:string|null;
  receiptId:string;receiptSourceSha256:string;receiptPdfSha256:string;allocations:Allocation[]};
type Correction={id:string;kind:string;sourceKind:string;sourceId:string|null;amount:string;currency:string;actorUserId:string;occurredAt:string};
type Source={schema:'HANDYMAN_FINAL_RECEIPT_V1';status:'ISSUED';
  issuance:{id:string;number:string;actorUserId:string;actorName:string;issuedAt:string};
  scope:{clientId:string;buildingId:string;requestId:string;tenantCompanyId:string;executionScopeId:string;transactionId:string};
  issuer:InvoiceSource['issuer']; tenant:{name:string;legalName:string|null;buildingName:string};
  invoice:{id:string;number:string;sourceSha256:string;pdfSha256:string;classificationId:string;
    lines:InvoiceSource['calculation']['commercialSource']['lines'];
    additions:InvoiceSource['calculation']['commercialSource']['additions'];
    variations:Array<{variationId:string;number:string;version:number;sourceSha256:string;pdfSha256:string}>};
  settlement:{currency:string;invoiceTotal:string;totalSettled:string;remaining:string;settledAt:string};
  payments:Payment[];corrections:Correction[]};
export type FinalReceiptStored={id:string;document_number:string;invoice_id:string;transaction_id:string;execution_scope_id:string;
  client_id:string;building_id:string;request_id:string;tenant_company_id:string;issued_by_user_id:string;issued_session_id:string;
  issued_at:Date;settled_at:Date;currency:string;invoice_total:string;settled_total:string;remaining_amount:string;
  source_snapshot:Source;source_canonical:string;source_sha256:string;pdf_filename:string;pdf_bytes:Buffer;pdf_size:number;pdf_sha256:string};
type PaymentRow={id:string;amount:string;obligation_stage:string;decided_at:Date;decided_by_user_id:string;recorded_by_user_id:string;
  confirmation_id:string|null;record_count:number;confirmation_count:number;independent:boolean;allocated_amount:string;linked:boolean};
type AllocationRow={id:string;payment_id:string;charge_line_id:string;amount:string;occurred_at_exact:string};
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const conflict=(message:string)=>new AppError({code:ERROR_CODES.HANDYMAN_FINAL_RECEIPT_RECONCILIATION_REQUIRED,statusCode:409,message});
const integrity=()=>new AppError({code:ERROR_CODES.HANDYMAN_FINAL_RECEIPT_INTEGRITY_ERROR,statusCode:409,message:'Final Receipt or its pinned source failed integrity verification.'});
function uuid(v:unknown,field:string) {
  if (typeof v!=='string' || !isValidUuid(v)) throw AppError.validation(`Invalid ${field}.`);
  return v.toLowerCase();
}
function metadata(row:FinalReceiptStored) {
  return {id:row.id,number:row.document_number,version:1 as const,status:'ISSUED' as const,invoiceId:row.invoice_id,
    executionScopeId:row.execution_scope_id,issuedByUserId:row.issued_by_user_id,issuedAt:row.issued_at.toISOString(),
    settledAt:row.settled_at.toISOString(),invoiceTotal:row.invoice_total,totalSettled:row.settled_total,
    remaining:row.remaining_amount,currency:row.currency,sourceChecksum:row.source_sha256,pdfChecksum:row.pdf_sha256,
    filename:row.pdf_filename,fileSize:row.pdf_size};
}
export function verifyStoredFinalReceipt(row:FinalReceiptStored) {
  try {
    const s=row.source_snapshot;
    if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_size!==row.pdf_bytes.length || row.pdf_size<1 || row.pdf_size>10485760 ||
      row.pdf_bytes.subarray(0,5).toString()!=='%PDF-' || sha(row.pdf_bytes)!==row.pdf_sha256 ||
      !/^final-receipt-frc-[0-9]+\.pdf$/.test(row.pdf_filename) || stableJson(s)!==row.source_canonical || sha(row.source_canonical)!==row.source_sha256 ||
      s.schema!=='HANDYMAN_FINAL_RECEIPT_V1' || s.status!=='ISSUED' || s.issuance.id!==row.id || s.issuance.number!==row.document_number ||
      s.issuance.actorUserId!==row.issued_by_user_id || s.issuance.issuedAt!==row.issued_at.toISOString() ||
      s.invoice.id!==row.invoice_id || s.scope.transactionId!==row.transaction_id || s.scope.executionScopeId!==row.execution_scope_id ||
      s.scope.clientId!==row.client_id || s.scope.buildingId!==row.building_id || s.scope.requestId!==row.request_id ||
      s.scope.tenantCompanyId!==row.tenant_company_id || s.settlement.currency!==row.currency ||
      s.settlement.invoiceTotal!==row.invoice_total || s.settlement.totalSettled!==row.settled_total ||
      s.settlement.remaining!==row.remaining_amount || s.settlement.settledAt!==row.settled_at.toISOString()) throw integrity();
  } catch { throw integrity(); }
  return {...metadata(row),bytes:row.pdf_bytes};
}
async function authority(tx:PoolClient,actor:Actor,invoice:OfficialInvoiceStored,write:boolean) {
  const permissions=await permissionRepository.listActivePermissionCodesForUser(actor.userId,tx);
  if (write ? !permissions.includes('handyman.finance.manage') :
      !permissions.includes('handyman.finance.read') && !permissions.includes('handyman.care.building'))
    throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Scoped Finance issuance or Finance/Customer Care read authority is required.'});
  await assertBuildingScopedResourceAccess(actor.userId,{clientId:invoice.client_id,buildingId:invoice.building_id},tx);
  const code=write?'handyman.finance.manage':permissions.includes('handyman.finance.read')?'handyman.finance.read':'handyman.care.building';
  const active=await tx.query(`SELECT u.display_name FROM users u JOIN user_sessions s ON s.user_id=u.id
    JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=$3 AND a.status='ACTIVE'
    JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
    JOIN properties pr ON pr.id=b.property_id AND pr.client_id=$4
    JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
    JOIN roles role ON role.id=ura.role_id AND role.status='ACTIVE'
    JOIN role_permission_assignments rpa ON rpa.role_id=role.id AND rpa.status='ACTIVE'
    JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE' AND perm.code=$5
    WHERE u.id=$1 AND u.status='ACTIVE' AND s.id=$2 AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
    FOR SHARE OF u,s,a,b,pr,ura,role,rpa,perm`,[actor.userId,actor.sessionId,invoice.building_id,invoice.client_id,code]);
  if (!active.rowCount) throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Active scoped authority and authenticated session are required.'});
  return active.rows[0].display_name as string;
}
function text(v:string) {
  const chars=Array.from(v);
  return chars.map((ch,i)=> {
    if (ch==='\\') return '\\\\';
    if (ch===' ' && i>0 && i<chars.length-1 && chars[i-1]!==' ' && chars[i+1]!==' ') return ch;
    const cp=ch.codePointAt(0)!; return cp>=0x21 && cp<=0x7e ? ch : `\\u{${cp.toString(16).toUpperCase()}}`;
  }).join('');
}
function add(rows:ReportingExportRow[],label:string,value:string|number|null|undefined) {
  if (value===null || value===undefined) return;
  const chunks=text(String(value)).match(/[\s\S]{1,48}/g) ?? [''];
  chunks.forEach((v,i)=>{
    let part=v.replace(/^ /,'\\u{20}').replace(/ $/,'\\u{20}');
    if (/^[=+\-@]/.test(part)) part=`value: ${part}`;
    rows.push({field:chunks.length===1?label:`${label} (${i+1}/${chunks.length})`,value:part});
  });
}
function table(key:string,label:string,rows:ReportingExportRow[]):ReportingExportTable {
  return {key,label,columns:[{key:'field',label:'Field',type:'STRING'},{key:'value',label:'Value',type:'STRING'}],rows,rowCount:rows.length};
}
async function render(source:Source,checksum:string) {
  const identity:ReportingExportRow[]=[],changes:ReportingExportRow[]=[],payments:ReportingExportRow[]=[];
  add(identity,'FINAL RECEIPT',source.issuance.number); add(identity,'Status','ISSUED - immutable settlement snapshot');
  add(identity,'Issuer',source.issuer.legalName); add(identity,'Issuer address',source.issuer.registeredAddress);
  add(identity,'Issuer city',`${source.issuer.city}, ${source.issuer.province} ${source.issuer.postalCode}`);
  add(identity,'Tenant',source.tenant.name); add(identity,'Tenant legal name',source.tenant.legalName);
  add(identity,'Tenant account ID',source.scope.tenantCompanyId); add(identity,'Building',source.tenant.buildingName);
  add(identity,'Invoice number',source.invoice.number); add(identity,'Invoice ID',source.invoice.id);
  add(identity,'Final billable total',`${source.settlement.currency} ${source.settlement.invoiceTotal}`);
  add(identity,'Total settled',`${source.settlement.currency} ${source.settlement.totalSettled}`);
  add(identity,'Remaining balance',`${source.settlement.currency} ${source.settlement.remaining}`);
  add(identity,'Final settlement date UTC',source.settlement.settledAt);
  add(identity,'Issued at UTC',source.issuance.issuedAt); add(identity,'Issued by',source.issuance.actorName);
  add(identity,'Issuer user ID',source.issuance.actorUserId); add(identity,'Source SHA-256',checksum);
  add(identity,'Document scope','Consolidates previous receipts.');
  add(identity,'Payment disclaimer','This is not another payment.');
  add(identity,'Settlement caveat','Settlement is as of the recorded date.');
  add(identity,'Text encoding','Non-ASCII and repeated or edge spaces use \\u{HEX}; backslashes doubled.');
  for (const line of source.invoice.lines) {
    if (line.addVariationId) {
      const offer=source.invoice.variations.find(v=>v.variationId===line.addVariationId);
      add(changes,'Approved ADD',`${offer?.number ?? line.addVariationId} / ${source.settlement.currency} ${line.chargeAmount}`);
      add(changes,'ADD charge line ID',line.chargeLineId);
    }
    for (const reduce of line.reductions) {
      const offer=source.invoice.variations.find(v=>v.variationId===reduce.variationId);
      add(changes,'Approved REDUCE',`${offer?.number ?? reduce.variationId} / minus ${source.settlement.currency} ${reduce.amount}`);
      add(changes,'REDUCE binding ID',reduce.bindingId);
    }
  }
  if (!changes.length) add(changes,'Approved changes','No ADD or REDUCE in the issued invoice.');
  for (const [i,p] of source.payments.entries()) {
    const label=`Payment ${i+1}`;
    add(payments,`${label} ID`,p.paymentId); add(payments,`${label} stage`,p.stage);
    add(payments,`${label} verified amount`,`${source.settlement.currency} ${p.amount}`);
    add(payments,`${label} allocated`,`${source.settlement.currency} ${p.allocatedAmount}`);
    add(payments,`${label} confirmation`,p.confirmationEventId); add(payments,`${label} confirmed at`,p.confirmedAt);
    add(payments,`${label} independent verification`,p.verificationBasis);
    add(payments,`${label} bank reconciliation`,p.reconciliationId);
    add(payments,`${label} verified by user`,p.reconciliationVerifiedByUserId ?? p.confirmedByUserId);
    add(payments,`${label} official Payment Receipt`,p.receiptId);
    add(payments,`${label} receipt SHA-256`,p.receiptPdfSha256);
    for (const allocation of p.allocations) add(payments,`${label} allocation`,`${allocation.id} / ${source.settlement.currency} ${allocation.amount}`);
  }
  const date=source.issuance.issuedAt.slice(0,10);
  const snapshot:PdfRenderSnapshot={metadata:{dataset:'HANDYMAN_FINAL_RECEIPT',datasetLabel:'ISSUED - Official Final Receipt',
    buildingId:source.scope.buildingId,buildingScope:[source.scope.buildingId],period:{dateFrom:date,dateTo:date},filters:{},
    asOf:source.issuance.issuedAt},generatedAt:source.issuance.issuedAt,kpis:[],
    tables:[table('identity','Issuer, tenant and settlement',identity),table('changes','Approved invoice corrections',changes),
      table('payments','Independently verified payments and existing receipts',payments)]};
  return renderReportingPdf(snapshot,{filename:`final-receipt-${source.issuance.number.toLowerCase()}.pdf`});
}

/** All reads below occur after the existing ledger lock, at READ COMMITTED. */
async function reconcile(tx:PoolClient,invoice:OfficialInvoiceStored):Promise<{payments:Payment[];corrections:Correction[];settledAt:string}> {
  verifyStoredOfficialInvoice(invoice);
  const refund=(await tx.query(`SELECT 1 FROM handyman_ledger_corrections WHERE transaction_id=$1 AND correction_kind='REFUND' LIMIT 1`,[invoice.transaction_id])).rowCount;
  if (refund) throw conflict('Refund settlement cannot be independently established: the existing refund correction has no outbound settlement verification.');
  const status=(await tx.query(`SELECT * FROM handyman_official_invoice_payment_status WHERE invoice_id=$1`,[invoice.id])).rows[0];
  if (!status || status.status!=='PAID' || status.outstanding_amount!=='0.00' || status.applied_amount!==invoice.total_amount ||
      status.verified_received_amount!==invoice.total_amount || status.unallocated_verified_amount!=='0.00' ||
      status.excess_funds_amount!=='0.00' || status.unlinked_allocation_amount!=='0.00' || Number(status.unlinked_verified_count)!==0)
    throw conflict('Invoice balance, verified allocations, unlinked funds or overpayment is unresolved.');
  if ((await tx.query("SELECT 1 FROM handyman_customer_payments WHERE transaction_id=$1 AND status='PENDING' LIMIT 1",[invoice.transaction_id])).rowCount)
    throw conflict('A payment claim is still pending verification.');
  const corrections=(await tx.query<Correction>(`SELECT id,correction_kind AS kind,source_kind AS "sourceKind",
    coalesce(source_payment_id,source_allocation_id,source_charge_line_id) AS "sourceId",amount::text,currency,
    corrected_by_user_id AS "actorUserId",to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
    FROM handyman_ledger_corrections WHERE transaction_id=$1 ORDER BY occurred_at,id LIMIT 501`,[invoice.transaction_id])).rows;
  if (corrections.length>500) throw conflict('Correction history exceeds the complete Final Receipt source limit.');
  const lines=invoice.source_snapshot.calculation.commercialSource.lines;
  const pinned=lines.flatMap(l=>l.reductions.map(r=>r.correctionId).filter((v):v is string=>v!==null));
  const adjustments=corrections.filter(c=>c.kind==='ADJUSTMENT').map(c=>c.id);
  if (new Set(pinned).size!==pinned.length || adjustments.length!==pinned.length || adjustments.some(c=>!pinned.includes(c)))
    throw conflict('A ledger adjustment is not represented by the approved immutable invoice; independent correction is required.');
  const allocations=(await tx.query<AllocationRow>(`SELECT a.id,a.payment_id,a.charge_line_id,a.amount::text,
    to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_exact
    FROM handyman_payment_allocations a WHERE a.transaction_id=$1 AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections c
      WHERE c.correction_kind='REVERSAL' AND c.source_allocation_id=a.id) ORDER BY a.occurred_at,a.id LIMIT 501`,[invoice.transaction_id])).rows;
  if (!allocations.length || allocations.length>500) throw conflict('The complete verified allocation source is missing or exceeds the supported limit.');
  const rows=(await tx.query<PaymentRow>(`SELECT p.id,p.amount::text,p.obligation_stage,p.decided_at,p.decided_by_user_id,p.recorded_by_user_id,
    (SELECT id FROM handyman_customer_payment_events e WHERE e.payment_id=p.id AND e.transaction_id=p.transaction_id
      AND e.client_id=p.client_id AND e.event_type='CONFIRM_PAYMENT' AND e.actor_user_id=p.decided_by_user_id LIMIT 1) AS confirmation_id,
    (SELECT count(*)::int FROM handyman_customer_payment_events e WHERE e.payment_id=p.id AND e.transaction_id=p.transaction_id
      AND e.client_id=p.client_id AND e.event_type='RECORD_PAYMENT' AND e.actor_user_id=p.recorded_by_user_id) AS record_count,
    (SELECT count(*)::int FROM handyman_customer_payment_events e WHERE e.payment_id=p.id AND e.transaction_id=p.transaction_id
      AND e.client_id=p.client_id AND e.event_type='CONFIRM_PAYMENT') AS confirmation_count,
    (p.decided_by_user_id<>p.recorded_by_user_id OR EXISTS (SELECT 1 FROM handyman_payment_reconciliations rec
      WHERE rec.payment_id=p.id AND rec.client_id=p.client_id AND rec.verified_by_user_id<>p.recorded_by_user_id)) AS independent,
    (SELECT coalesce(sum(a.amount),0)::numeric(18,2)::text FROM handyman_payment_allocations a WHERE a.payment_id=p.id
      AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections c WHERE c.correction_kind='REVERSAL' AND c.source_allocation_id=a.id)) AS allocated_amount,
    EXISTS (SELECT 1 FROM handyman_official_invoice_payment_links l WHERE l.payment_id=p.id AND l.invoice_id=$2) AS linked
    FROM handyman_customer_payments p WHERE p.transaction_id=$1 AND p.id=ANY($3::uuid[]) ORDER BY p.received_at,p.id`,
  [invoice.transaction_id,invoice.id,[...new Set(allocations.map(a=>a.payment_id))]])).rows;
  const payments:Payment[]=[];
  for (const p of rows) {
    if (!p.independent || !p.confirmation_id || p.confirmation_count!==1 || p.record_count!==1 || !p.linked || p.amount!==p.allocated_amount)
      throw conflict('Each allocated payment must be independently confirmed, exactly linked and fully allocated.');
    const r=(await tx.query<TenantPaymentReceiptStored>(`SELECT * FROM handyman_tenant_payment_receipts
      WHERE payment_id=$1 AND transaction_id=$2 AND execution_scope_id=$3 AND client_id=$4 AND building_id=$5
        AND tenant_company_id=$6 AND request_id=$7`,[p.id,invoice.transaction_id,invoice.execution_scope_id,
      invoice.client_id,invoice.building_id,invoice.tenant_company_id,invoice.request_id])).rows[0];
    if (!r) throw conflict('Every allocated payment requires its separately issued official Payment Receipt.');
    verifyStoredTenantPaymentReceipt(r);
    if (r.confirmation_event_id!==p.confirmation_id || r.source_snapshot.payment.amount!==p.amount)
      throw conflict('An official Payment Receipt does not match its independent payment confirmation.');
    payments.push({paymentId:p.id,amount:p.amount,allocatedAmount:p.allocated_amount,stage:p.obligation_stage,
      confirmationEventId:p.confirmation_id,confirmedByUserId:p.decided_by_user_id,confirmedAt:p.decided_at.toISOString(),
      verificationBasis:r.source_snapshot.verification.basis,reconciliationId:r.source_snapshot.verification.reconciliation?.id ?? null,
      reconciliationVerifiedByUserId:r.source_snapshot.verification.reconciliation?.verifiedByUserId ?? null,
      reconciliationVerifiedAt:r.source_snapshot.verification.reconciliation?.verifiedAt ?? null,
      receiptId:r.id,receiptSourceSha256:r.source_sha256,receiptPdfSha256:r.pdf_sha256,
      allocations:allocations.filter(a=>a.payment_id===p.id).map(a=>({id:a.id,chargeLineId:a.charge_line_id,amount:a.amount,occurredAt:a.occurred_at_exact}))});
  }
  if (payments.length!==new Set(allocations.map(a=>a.payment_id)).size) throw conflict('An allocated payment is missing from the invoice ledger.');
  const date=(await tx.query<{settled_at:Date}>(`SELECT greatest(i.issued_at,
    coalesce((SELECT max(p.decided_at) FROM handyman_customer_payments p WHERE p.id=ANY($2::uuid[])),i.issued_at),
    coalesce((SELECT max(a.occurred_at) FROM handyman_payment_allocations a WHERE a.id=ANY($3::uuid[])),i.issued_at),
    coalesce((SELECT max(l.linked_at) FROM handyman_official_invoice_payment_links l WHERE l.payment_id=ANY($2::uuid[])),i.issued_at),
    coalesce((SELECT max(rec.verified_at) FROM handyman_payment_reconciliations rec WHERE rec.payment_id=ANY($2::uuid[])),i.issued_at),
    coalesce((SELECT max(c.occurred_at) FROM handyman_ledger_corrections c WHERE c.transaction_id=i.transaction_id),i.issued_at)) AS settled_at
    FROM handyman_official_invoices i WHERE i.id=$1`,[invoice.id,payments.map(p=>p.paymentId),allocations.map(a=>a.id)])).rows[0];
  if (!date) throw integrity();
  return {payments,corrections,settledAt:date.settled_at.toISOString()};
}

export async function issueFinalReceipt(actor:Actor,scopeInput:string,invoiceInput:string) {
  const scope=uuid(scopeInput,'executionScopeId'),invoiceId=uuid(invoiceInput,'invoiceId');
  try { return await withTransaction(async tx=>{
    await tx.query('SET LOCAL synchronous_commit=on');
    const invoice=(await tx.query<OfficialInvoiceStored>(`SELECT * FROM handyman_official_invoices WHERE id=$1 AND execution_scope_id=$2`,[invoiceId,scope])).rows[0];
    if (!invoice) throw AppError.notFound('Official Handyman invoice not found.');
    const actorName=await authority(tx,actor,invoice,true);
    await tx.query('SELECT id FROM handyman_customer_transactions WHERE id=$1 FOR UPDATE',[invoice.transaction_id]);
    const existing=(await tx.query<FinalReceiptStored>('SELECT * FROM handyman_final_receipts WHERE invoice_id=$1',[invoice.id])).rows[0];
    if (existing) {const result=verifyStoredFinalReceipt(existing); const {bytes,...data}=result; return {...data,replayed:true};}
    const durable=(await tx.query<{fsync:string;full_page_writes:string;sync_commit:string;replica:boolean}>(`SELECT
      current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,
      current_setting('synchronous_commit') AS sync_commit,pg_is_in_recovery() AS replica`)).rows[0];
    if (durable?.fsync!=='on' || durable.full_page_writes!=='on' || durable.sync_commit!=='on' || durable.replica)
      throw new AppError({code:ERROR_CODES.HANDYMAN_FINAL_RECEIPT_DURABILITY_UNAVAILABLE,statusCode:503,message:'Final Receipt requires durable primary PostgreSQL storage.'});
    const data=await reconcile(tx,invoice);
    const sequence=(await tx.query<{number:string;issued_at:Date}>("SELECT nextval('handyman_final_receipt_number_seq')::text AS number,clock_timestamp() AS issued_at")).rows[0];
    const inv=invoice.source_snapshot, number=`FRC-${sequence.number.padStart(10,'0')}`;
    const source:Source={schema:'HANDYMAN_FINAL_RECEIPT_V1',status:'ISSUED',
      issuance:{id:randomUUID(),number,actorUserId:actor.userId,actorName,issuedAt:sequence.issued_at.toISOString()},
      scope:{clientId:invoice.client_id,buildingId:invoice.building_id,requestId:invoice.request_id,tenantCompanyId:invoice.tenant_company_id,
        executionScopeId:invoice.execution_scope_id,transactionId:invoice.transaction_id},issuer:inv.issuer,
      tenant:{name:inv.quotation.snapshot.customer.tenantName,legalName:inv.quotation.snapshot.customer.legalName,
        buildingName:inv.quotation.snapshot.customer.buildingName},
      invoice:{id:invoice.id,number:invoice.document_number,sourceSha256:invoice.source_sha256,pdfSha256:invoice.pdf_sha256,
        classificationId:invoice.classification_id,lines:inv.calculation.commercialSource.lines,additions:inv.calculation.commercialSource.additions,
        variations:inv.variations.map(v=>({variationId:v.variationId,number:v.number,version:v.version,sourceSha256:v.sourceSha256,pdfSha256:v.pdfSha256}))},
      settlement:{currency:invoice.currency,invoiceTotal:invoice.total_amount,totalSettled:invoice.total_amount,remaining:'0.00',settledAt:data.settledAt},
      payments:data.payments,corrections:data.corrections};
    const canonical=stableJson(source),sourceHash=sha(canonical),pdf=await render(source,sourceHash);
    if (pdf.fileSize!==pdf.bytes.length || pdf.fileSize<1 || pdf.fileSize>10485760 || pdf.checksum!==sha(pdf.bytes) ||
        pdf.bytes.subarray(0,5).toString()!=='%PDF-') throw integrity();
    const row=(await tx.query<FinalReceiptStored>(`INSERT INTO handyman_final_receipts
      (id,document_number,invoice_id,transaction_id,execution_scope_id,client_id,building_id,request_id,tenant_company_id,
       issued_by_user_id,issued_session_id,issued_at,settled_at,currency,invoice_total,settled_total,remaining_amount,
       source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,0,$16::text::jsonb,$16::text,$17,$18,$19,$20,$21) RETURNING *`,
    [source.issuance.id,number,invoice.id,invoice.transaction_id,scope,invoice.client_id,invoice.building_id,invoice.request_id,
      invoice.tenant_company_id,actor.userId,actor.sessionId,source.issuance.issuedAt,source.settlement.settledAt,invoice.currency,
      invoice.total_amount,canonical,sourceHash,pdf.filename,pdf.bytes,pdf.fileSize,pdf.checksum])).rows[0];
    if (!row) throw integrity(); const {bytes,...result}=verifyStoredFinalReceipt(row); return {...result,replayed:false};
  }); } catch(error) {
    if (!(error instanceof AppError) && ['23505','23514'].includes((error as {code?:string}).code ?? ''))
      throw conflict('Invoice sources changed or are not fully reconciled; no Final Receipt was issued.');
    throw error;
  }
}
export async function downloadFinalReceipt(actor:Actor,scopeInput:string,invoiceInput:string) {
  const scope=uuid(scopeInput,'executionScopeId'),invoice=uuid(invoiceInput,'invoiceId');
  return withTransaction(async tx=>{
    const inv=(await tx.query<OfficialInvoiceStored>('SELECT * FROM handyman_official_invoices WHERE id=$1 AND execution_scope_id=$2',[invoice,scope])).rows[0];
    if (!inv) throw AppError.notFound('Official Handyman invoice not found.');
    await authority(tx,actor,inv,false);
    const row=(await tx.query<FinalReceiptStored>(`SELECT * FROM handyman_final_receipts WHERE invoice_id=$1 AND execution_scope_id=$2
      AND client_id=$3 AND building_id=$4`,[invoice,scope,inv.client_id,inv.building_id])).rows[0];
    if (!row) throw AppError.notFound('Issued Final Receipt not found.');
    return verifyStoredFinalReceipt(row);
  });
}
/** The workspace uses the same occupancy/grant check as official invoices. */
export async function downloadFinalReceiptForCare(token:string,requestInput:unknown,invoiceInput:unknown,query:unknown) {
  const principal=await resolveCareWorkspacePrincipal(token),selection=parseCareHandymanPaymentProofSelection(query);
  const request=uuid(requestInput,'requestId'),invoice=uuid(invoiceInput,'invoiceId');
  const result=await getPool().query<FinalReceiptStored & {authenticated:boolean}>(`${WORKSPACE_OCCUPANCY_CTES}
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,d.* FROM (SELECT 1) singleton LEFT JOIN LATERAL (
      SELECT f.* FROM handyman_service_requests r JOIN records c ON c."clientId"=r.client_id AND c."tenantCompanyId"=r.tenant_company_id
        AND c."buildingId"=r.building_id AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id AND s.client_id=r.client_id AND s.building_id=r.building_id
        AND s.tenant_company_id=r.tenant_company_id AND s.space_id IS NOT DISTINCT FROM r.space_id
      JOIN handyman_official_invoices i ON i.execution_scope_id=s.id AND i.client_id=r.client_id AND i.request_id=r.id
        AND i.building_id=r.building_id AND i.tenant_company_id=r.tenant_company_id
      JOIN handyman_final_receipts f ON f.invoice_id=i.id AND f.execution_scope_id=s.id AND f.transaction_id=i.transaction_id
        AND f.client_id=i.client_id AND f.building_id=i.building_id AND f.tenant_company_id=i.tenant_company_id AND f.request_id=i.request_id
      WHERE $5::text IS NULL AND $6::integer=1 AND r.id=$10 AND i.id=$11 AND r.tenant_company_id=$7 AND r.building_id=$8
        AND r.space_id IS NOT DISTINCT FROM $9::uuid LIMIT 1) d ON TRUE`,
    [principal.sessionId,principal.careActorId,principal.integrationId,selection.propertyId,null,1,
      selection.tenantCompanyId,selection.buildingId,selection.spaceId,request,invoice]);
  const row=result.rows[0];
  if (!row?.authenticated) throw workspaceUnauthorized();
  if (!row.id) throw new AppError({code:ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,statusCode:404,message:'Care workspace resource not found.'});
  return verifyStoredFinalReceipt(row);
}
