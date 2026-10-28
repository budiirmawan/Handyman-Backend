import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { permissionRepository } from '../permissions';
import { calculateInclusiveHandymanInvoicePpnInSnapshot } from '../handyman-ppn-calculation/handyman-inclusive-invoice.service';
import { verifyStoredOfficialInvoice, type OfficialInvoiceStored } from '../handyman-official-invoices/handyman-official-invoice.service';
import { readCurrentFinalReceiptReconciliation, verifyStoredFinalReceipt, type FinalReceiptStored } from '../handyman-final-receipts/handyman-final-receipt.service';
import { readScopeWarrantyCoverage } from '../handyman-warranty-certificates/handyman-warranty-certificate.service';
import { readAuthorizedHandymanRequestScopeSetInTransaction } from './handyman-request-scope-set.service';

type Blocker = { code:string; message:string; executionScopeId:string|null; invoiceId:string|null };
type Member = Awaited<ReturnType<typeof readAuthorizedHandymanRequestScopeSetInTransaction>>['scopes'][number];
type Invoice = OfficialInvoiceStored;

function financeReason(error:AppError) {
  const message=error.message;
  if (/refund/i.test(message)) return 'REFUND_UNRESOLVED';
  if (/Payment Receipt/i.test(message)) return 'PAYMENT_RECEIPT_UNVERIFIED';
  if (/pending/i.test(message)) return 'PAYMENT_VERIFICATION_PENDING';
  if (/adjustment|correction/i.test(message)) return 'FINANCIAL_CORRECTION_UNRESOLVED';
  if (/balance|overpayment|unlinked funds/i.test(message)) return 'FINANCIAL_BALANCE_UNRESOLVED';
  return 'PAYMENT_RECONCILIATION_UNVERIFIED';
}

/** This is a live read, not a CLOSE command or authorization to close. Scope
 * locks precede ledger and billing-source locks; money writers use the same
 * ledger anchor. A caller must perform a fresh assessment for any later act. */
export async function getHandymanRequestCloseReadiness(requestId:unknown,actor:string) {
  return withTransaction(async tx=>{
    const scopeSet=await readAuthorizedHandymanRequestScopeSetInTransaction(tx,requestId,actor);
    const permissions=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
    if (!permissions.includes('handyman.finance.read') || !permissions.includes('handyman.customer_tax.read')) {
      throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,
        message:'Finance read and customer tax read authority are required for Request close readiness.'});
    }
    const blockers:Blocker[]=scopeSet.completionReadiness.blockers.map(b=>({...b,invoiceId:null}));
    const add=(code:string,message:string,executionScopeId:string|null,invoiceId:string|null=null)=>{
      if (!blockers.some(b=>b.code===code && b.executionScopeId===executionScopeId && b.invoiceId===invoiceId))
        blockers.push({code,message,executionScopeId,invoiceId});
    };
    const ids=scopeSet.scopes.map(s=>s.executionScopeId);
    const invoices=(await tx.query<Invoice>(`SELECT * FROM handyman_official_invoices
      WHERE request_id=$1 OR execution_scope_id=ANY($2::uuid[]) ORDER BY execution_scope_id,id`,[scopeSet.requestId,ids])).rows;
    for (const invoice of invoices) {
      if (!ids.includes(invoice.execution_scope_id)) add('INVOICE_SCOPE_UNIDENTIFIED',
        'An issued invoice is not linked to an established required original scope.',null,invoice.id);
    }
    const scopes:Array<{executionScopeId:string;invoiceId:string|null;finalReceiptId:string|null;
      deliveryStatus:'ACKNOWLEDGED'|'NOT_ACKNOWLEDGED'|'UNKNOWN';warrantyStatus:string;warrantyCertificateId:string|null}>=[];
    for (const member of scopeSet.scopes) {
      const view={executionScopeId:member.executionScopeId,invoiceId:null as string|null,finalReceiptId:null as string|null,
        deliveryStatus:'UNKNOWN' as 'ACKNOWLEDGED'|'NOT_ACKNOWLEDGED'|'UNKNOWN',warrantyStatus:'UNVERIFIED',warrantyCertificateId:null as string|null};
      scopes.push(view);
      await checkWarranty(tx,member,view,add);
      const matching=invoices.filter(i=>i.execution_scope_id===member.executionScopeId);
      if (!matching.length) { add('OFFICIAL_INVOICE_MISSING','No issued official invoice covers this original scope.',member.executionScopeId); continue; }
      if (matching.length!==1) { add('INVOICE_LINKAGE_AMBIGUOUS','Multiple invoices claim this original scope.',member.executionScopeId); continue; }
      const invoice=matching[0]; view.invoiceId=invoice.id;
      if (invoice.client_id!==scopeSet.clientId || invoice.building_id!==scopeSet.buildingId ||
          invoice.request_id!==scopeSet.requestId || invoice.tenant_company_id!==scopeSet.tenantCompanyId) {
        add('INVOICE_SCOPE_BINDING_INVALID','The official invoice does not match the exact Request and tenant context.',member.executionScopeId,invoice.id); continue;
      }
      const ledger=(await tx.query(`SELECT id FROM handyman_customer_transactions
        WHERE id=$1 AND execution_scope_id=$2 AND client_id=$3 FOR UPDATE`,[invoice.transaction_id,member.executionScopeId,scopeSet.clientId])).rowCount;
      if (!ledger) { add('INVOICE_LEDGER_BINDING_INVALID','The invoice has no exact scoped customer ledger.',member.executionScopeId,invoice.id); continue; }
      const fence=await tx.query('SELECT revision FROM handyman_invoice_source_fences WHERE execution_scope_id=$1 FOR SHARE',[member.executionScopeId]);
      if (!fence.rowCount) { add('INVOICE_SOURCE_FENCE_MISSING','The invoice source cannot be checked for currentness.',member.executionScopeId,invoice.id); continue; }
      await checkInvoice(tx,actor,invoice,member,add);
      await checkSettlement(tx,invoice,view,add);
    }
    const observed=(await tx.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
    return {protocol:'HANDYMAN_REQUEST_CLOSE_READINESS_V1',requestId:scopeSet.requestId,clientId:scopeSet.clientId,
      buildingId:scopeSet.buildingId,tenantCompanyId:scopeSet.tenantCompanyId,observedAt:observed.toISOString(),
      status:blockers.length?'BLOCKED' as const:'READY' as const,operationalReadiness:scopeSet.completionReadiness,
      scopeSetRevision:scopeSet.revision,scopeSetFingerprint:scopeSet.fingerprint,scopes,blockers};
  });
}

type Add = (code:string,message:string,scopeId:string|null,invoiceId?:string|null)=>void;
async function checkWarranty(tx:PoolClient,member:Member,view:{warrantyStatus:string;warrantyCertificateId:string|null},add:Add) {
  const c=member.completion,b=member.bastAcceptance;
  if (c.status!=='VERIFIED' || c.workState!=='COMPLETED' || b.status!=='VERIFIED' || !b.bastId || !b.officialDocumentId ||
      !c.manifestId || !c.manifestVersion || !c.manifestSha256 || !c.verificationId) {
    add('WARRANTY_SCOPE_EVIDENCE_UNVERIFIED','Warranty terms cannot be established without the current accepted completed scope.',member.executionScopeId); return;
  }
  try {
    const coverage=await readScopeWarrantyCoverage(tx,{executionScopeId:member.executionScopeId,bastId:b.bastId,
      officialBastId:b.officialDocumentId,manifestId:c.manifestId,manifestVersion:c.manifestVersion,
      manifestSha256:c.manifestSha256,verificationId:c.verificationId});
    view.warrantyStatus=coverage.status; view.warrantyCertificateId=coverage.certificateId;
    if (coverage.status==='CERTIFICATE_REQUIRED') add('WARRANTY_CERTIFICATE_MISSING',
      'A certificate is required for one or more customer-agreed covered items.',member.executionScopeId);
  } catch(error) {
    if (!(error instanceof AppError)) throw error;
    const reason=error.code===ERROR_CODES.HANDYMAN_WARRANTY_CERTIFICATE_INTEGRITY_ERROR ? 'WARRANTY_CERTIFICATE_INTEGRITY_INVALID' :
      /certificate/i.test(error.message) ? 'WARRANTY_CERTIFICATE_CONFLICT' : 'WARRANTY_TERMS_UNVERIFIED';
    add(reason,error.message,member.executionScopeId);
  }
}

async function checkInvoice(tx:PoolClient,actor:string,invoice:Invoice,member:Member,add:Add) {
  try {
    verifyStoredOfficialInvoice(invoice);
    const source=invoice.source_snapshot.calculation.commercialSource;
    if (source.executionScopeId!==member.executionScopeId || source.quotationId!==member.quotationId ||
        source.quotationVersionId!==member.approvalVersionId || source.quotationDecisionId!==member.approvalDecisionId)
      throw new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,message:'Invoice approval lineage does not match the original scope.'});
    if ((await tx.query(`SELECT 1 FROM handyman_scope_variations WHERE execution_scope_id=$1 AND tenant_decision_outcome IS NULL LIMIT 1`,
      [member.executionScopeId])).rowCount) {
      add('VARIATION_UNRESOLVED','A scope variation is awaiting a customer decision.',member.executionScopeId,invoice.id);
    }
    // These are the same authority heads/windows fenced by official issuance.
    await tx.query('SELECT request_id FROM handyman_customer_tax_heads WHERE request_id=$1 FOR SHARE',[invoice.request_id]);
    await tx.query('SELECT request_id FROM handyman_buyer_binding_heads WHERE request_id=$1 FOR SHARE',[invoice.request_id]);
    const rules=[...new Set(invoice.source_snapshot.calculation.lines.map(l=>l.rule.id))];
    const locked=await tx.query('SELECT rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY($1::uuid[]) FOR SHARE',[rules]);
    const identity=await tx.query('SELECT profile_id FROM handyman_tax_identity_windows WHERE profile_id=$1 FOR SHARE',
      [invoice.source_snapshot.calculation.supplier.profileId]);
    if (locked.rowCount!==rules.length || identity.rowCount!==1) throw new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,
      message:'The invoice tax approval authority is unavailable.'});
    const current=await calculateInclusiveHandymanInvoicePpnInSnapshot(tx,actor,{clientId:invoice.client_id,requestId:invoice.request_id,
      classification:invoice.source_snapshot.calculation.classification.pin});
    if (stableJson(current)!==stableJson(invoice.source_snapshot.calculation)) throw new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,
      message:'The current approved billable scope, ADD/REDUCE, corrections or tax classification differ from the invoice.'});
  } catch(error) {
    if (!(error instanceof AppError)) throw error;
    const reason=error.code===ERROR_CODES.HANDYMAN_OFFICIAL_INVOICE_INTEGRITY_ERROR ? 'INVOICE_INTEGRITY_INVALID' :
      /^HANDYMAN_(CUSTOMER_TAX|TAX_RULE|TAX_IDENTITY|BUYER_BINDING)_/.test(error.code) ? 'INVOICE_APPROVAL_UNVERIFIED' : 'INVOICE_COVERAGE_UNVERIFIED';
    add(reason,error.message,member.executionScopeId,invoice.id);
  }
}

async function checkSettlement(tx:PoolClient,invoice:Invoice,
  view:{finalReceiptId:string|null;deliveryStatus:'ACKNOWLEDGED'|'NOT_ACKNOWLEDGED'|'UNKNOWN'},add:Add) {
  const scopeId=invoice.execution_scope_id;
  if ((await tx.query(`SELECT 1 FROM handyman_ledger_corrections WHERE transaction_id=$1 AND correction_kind='REFUND' LIMIT 1`,[invoice.transaction_id])).rowCount)
    add('REFUND_UNRESOLVED','Refund corrections have no independently verified outbound settlement.',scopeId,invoice.id);
  if ((await tx.query(`SELECT 1 FROM handyman_customer_payments WHERE transaction_id=$1 AND status='PENDING' LIMIT 1`,[invoice.transaction_id])).rowCount)
    add('PAYMENT_VERIFICATION_PENDING','A customer payment remains pending verification.',scopeId,invoice.id);
  const status=(await tx.query(`SELECT * FROM handyman_official_invoice_payment_status WHERE invoice_id=$1`,[invoice.id])).rows[0];
  if (!status || status.status!=='PAID' || status.outstanding_amount!=='0.00' || status.applied_amount!==invoice.total_amount ||
      status.verified_received_amount!==invoice.total_amount || status.unallocated_verified_amount!=='0.00' ||
      status.excess_funds_amount!=='0.00' || status.unlinked_allocation_amount!=='0.00' || Number(status.unlinked_verified_count)!==0)
    add('FINANCIAL_BALANCE_UNRESOLVED','Invoice balance, unlinked funds or excess funds remain unresolved.',scopeId,invoice.id);
  if ((await tx.query(`SELECT 1 FROM handyman_payment_allocations a
      WHERE a.transaction_id=$1 AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections c WHERE c.correction_kind='REVERSAL' AND c.source_allocation_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM handyman_tenant_payment_receipts r WHERE r.payment_id=a.payment_id AND r.transaction_id=$1
          AND r.execution_scope_id=$2 AND r.client_id=$3 AND r.building_id=$4 AND r.tenant_company_id=$5 AND r.request_id=$6) LIMIT 1`,
    [invoice.transaction_id,scopeId,invoice.client_id,invoice.building_id,invoice.tenant_company_id,invoice.request_id])).rowCount)
    add('PAYMENT_RECEIPT_MISSING','Every allocated verified payment requires an issued Finance Payment Receipt.',scopeId,invoice.id);
  let reconciliation:Awaited<ReturnType<typeof readCurrentFinalReceiptReconciliation>>|null=null;
  try { reconciliation=await readCurrentFinalReceiptReconciliation(tx,invoice); }
  catch(error) {
    if (!(error instanceof AppError)) throw error;
    add(financeReason(error),error.message,scopeId,invoice.id);
  }
  const receipts=(await tx.query<FinalReceiptStored>(`SELECT * FROM handyman_final_receipts
    WHERE invoice_id=$1 OR (execution_scope_id=$2 AND request_id=$3) ORDER BY id`,[invoice.id,scopeId,invoice.request_id])).rows;
  if (!receipts.length) {add('FINAL_RECEIPT_MISSING','No official Final Receipt is issued for this invoice.',scopeId,invoice.id);return;}
  if (receipts.length!==1 || receipts[0].invoice_id!==invoice.id) {
    add('FINAL_RECEIPT_LINKAGE_AMBIGUOUS','Conflicting Final Receipts claim this scope or invoice.',scopeId,invoice.id);return;
  }
  const receipt=receipts[0];view.finalReceiptId=receipt.id;
  try {
    verifyStoredFinalReceipt(receipt);
    const s=receipt.source_snapshot,inv=invoice.source_snapshot;
    if (receipt.client_id!==invoice.client_id || receipt.building_id!==invoice.building_id || receipt.request_id!==invoice.request_id ||
        receipt.tenant_company_id!==invoice.tenant_company_id || receipt.execution_scope_id!==scopeId || receipt.transaction_id!==invoice.transaction_id ||
        s.invoice.sourceSha256!==invoice.source_sha256 || s.invoice.pdfSha256!==invoice.pdf_sha256 ||
        s.invoice.classificationId!==invoice.classification_id || receipt.invoice_total!==invoice.total_amount ||
        stableJson(s.invoice.lines)!==stableJson(inv.calculation.commercialSource.lines) ||
        stableJson(s.invoice.additions)!==stableJson(inv.calculation.commercialSource.additions))
      throw new AppError({code:ERROR_CODES.CONFLICT,statusCode:409,message:'Final Receipt does not bind the exact issued invoice.'});
    if (!reconciliation || stableJson(s.payments)!==stableJson(reconciliation.payments) ||
        stableJson(s.corrections)!==stableJson(reconciliation.corrections) || s.settlement.settledAt!==reconciliation.settledAt)
      add('FINAL_RECEIPT_STALE','The issued Final Receipt does not reflect current independently reconciled Finance facts.',scopeId,invoice.id);
  } catch(error) {
    if (!(error instanceof AppError)) throw error;
    add('FINAL_RECEIPT_BINDING_UNVERIFIED',error.message,scopeId,invoice.id);return;
  }
  // The journal's append-only DELIVERED trigger attests the live recipient PIC
  // session at the time; don't rewrite history using today's PIC assignment.
  const ack=(await tx.query(`SELECT d.id FROM handyman_final_receipt_delivery_events d
    JOIN handyman_final_receipt_delivery_events sent ON sent.id=d.sent_event_id AND sent.event_type='SENT'
    WHERE d.event_type='DELIVERED' AND d.receipt_id=$1 AND sent.receipt_id=d.receipt_id
      AND d.client_id=$2 AND sent.client_id=d.client_id AND d.building_id=$3 AND sent.building_id=d.building_id
      AND d.request_id=$4 AND sent.request_id=d.request_id AND d.tenant_company_id=$5 AND sent.tenant_company_id=d.tenant_company_id
      AND d.document_version=1 AND sent.document_version=1 AND d.source_sha256=$6 AND sent.source_sha256=d.source_sha256
      AND d.pdf_sha256=$7 AND sent.pdf_sha256=d.pdf_sha256 AND d.recipient_pic_id IS NOT NULL
      AND sent.recipient_pic_id=d.recipient_pic_id AND d.actor_user_id IS NOT NULL AND d.actor_user_session_id IS NOT NULL
      AND d.channel=sent.channel AND d.recipient_name=sent.recipient_name
      AND d.recipient_contact IS NOT DISTINCT FROM sent.recipient_contact LIMIT 1`,
    [receipt.id,invoice.client_id,invoice.building_id,invoice.request_id,invoice.tenant_company_id,receipt.source_sha256,receipt.pdf_sha256])).rowCount;
  view.deliveryStatus=ack?'ACKNOWLEDGED':'NOT_ACKNOWLEDGED';
  if (!ack) add('FINAL_RECEIPT_DELIVERY_UNACKNOWLEDGED','Care-reported SENT is not an authenticated recipient acknowledgment.',scopeId,invoice.id);
}
