import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { permissionRepository } from '../permissions';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from '../handyman-care-workspace/care-workspace.service';
import { parseCareHandymanPaymentProofSelection } from '../handyman-care-workspace/care-workspace-payment-proof.service';
import { WORKSPACE_OCCUPANCY_CTES } from '../handyman-care-workspace/care-workspace-occupancies.repository';
import { resolveHandymanDocumentIssuerSnapshot } from '../handyman-documents/handyman-document-issuer.service';
import { handymanDocumentIssuerProfileRepository } from '../handyman-documents/handyman-document-issuer.repository';
import { resolveHandymanDocumentBankAccountSnapshot } from '../handyman-documents/handyman-document-bank.service';
import { resolveHandymanDocumentSettingsSnapshot } from '../handyman-documents/handyman-document-settings.service';
import { renderHandymanDocumentPdf } from '../handyman-documents/handyman-document-pdf';
import type { HandymanDocumentLocale } from '../handyman-documents/handyman-document-pdf.types';
import type { CustomerTaxClassificationPin } from '../handyman-customer-tax';
import { calculateInclusiveHandymanInvoicePpnInSnapshot } from '../handyman-ppn-calculation/handyman-inclusive-invoice.service';
import { addText, blocks, exactText, verifyStoredQuotationDocument, type QuotationDocumentStored } from '../handyman-quotations/handyman-quotation-document.service';
import { verifyStoredVariationOffer, type VariationOfferStored } from '../handyman-scope-variations/handyman-variation-offer-document.service';

type Calculation = Awaited<ReturnType<typeof calculateInclusiveHandymanInvoicePpnInSnapshot>>;
type Issuer = Awaited<ReturnType<typeof resolveHandymanDocumentIssuerSnapshot>>;
type Bank = Awaited<ReturnType<typeof resolveHandymanDocumentBankAccountSnapshot>>;
type Settings = Awaited<ReturnType<typeof resolveHandymanDocumentSettingsSnapshot>>;
type Source = {
  schema: 'HANDYMAN_OFFICIAL_INVOICE_V1'; status: 'ISSUED';
  issuance: { id: string; number: string; issuedAt: string; actorUserId: string };
  calculation: Calculation;
  quotation: { documentId: string; number: string; sourceSha256: string; pdfSha256: string; snapshot: QuotationDocumentStored['source_snapshot'] };
  variations: Array<{ documentId: string; variationId: string; number: string; version: number; sourceSha256: string; pdfSha256: string;
    snapshot: VariationOfferStored['source_snapshot'] }>;
  lineDetails: Array<{ quotationLineId: string; quotationVersionId: string; description: string; unit: string }>;
  issuer: Issuer; bank: Bank; settings: Settings;
};
type Stored = {
  id: string; client_id: string; building_id: string; request_id: string; tenant_company_id: string;
  execution_scope_id: string; transaction_id: string; classification_id: string; issuer_profile_id: string;
  bank_version_id: string; settings_id: string; document_number: string; issued_by_user_id: string; issued_at: Date;
  currency: string; total_amount: string; source_snapshot: Source; source_canonical: string; source_sha256: string;
  pdf_filename: string; pdf_bytes: Buffer; pdf_size: number; pdf_sha256: string;
};
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const conflict = (message: string) => new AppError({ code: ERROR_CODES.HANDYMAN_OFFICIAL_INVOICE_CONFLICT, statusCode: 409, message });
const integrity = () => new AppError({ code: ERROR_CODES.HANDYMAN_OFFICIAL_INVOICE_INTEGRITY_ERROR, statusCode: 409,
  message: 'The issued invoice or its frozen source failed integrity verification.' });
const notFound = () => AppError.notFound('Official Handyman invoice not found.');
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation(`Invalid ${field}.`);
  return value.toLowerCase();
}

function verifiedDownload(row: Stored) {
  try {
    const s = row.source_snapshot, c = s.calculation, source = c.commercialSource;
    if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_bytes.length !== row.pdf_size || row.pdf_size < 1 || row.pdf_size > MAX_PDF_BYTES ||
        row.pdf_bytes.subarray(0,5).toString() !== '%PDF-' || sha(row.pdf_bytes) !== row.pdf_sha256 ||
        !/^invoice-[a-z0-9-]+\.pdf$/.test(row.pdf_filename) || stableJson(s) !== row.source_canonical || sha(row.source_canonical) !== row.source_sha256 ||
        s.schema !== 'HANDYMAN_OFFICIAL_INVOICE_V1' || s.status !== 'ISSUED' || s.issuance.id !== row.id ||
        s.issuance.number !== row.document_number || s.issuance.actorUserId !== row.issued_by_user_id ||
        s.issuance.issuedAt !== row.issued_at.toISOString() || c.clientId !== row.client_id || c.requestId !== row.request_id ||
        source.executionScopeId !== row.execution_scope_id || source.transactionId !== row.transaction_id ||
        source.buildingId !== row.building_id || source.tenantCompanyId !== row.tenant_company_id ||
        c.classification.pin.classificationId !== row.classification_id || c.totalIncludingPpn !== row.total_amount ||
        c.currency !== row.currency || s.issuer.profileId !== row.issuer_profile_id || s.bank.versionRowId !== row.bank_version_id ||
        s.settings.settingsId !== row.settings_id || sha(stableJson(source)) !== c.commercialSourceChecksum ||
        s.quotation.documentId !== source.quotationOffer.id || s.quotation.sourceSha256 !== source.quotationOffer.sourceSha256 ||
        s.quotation.pdfSha256 !== source.quotationOffer.pdfSha256 || sha(stableJson(s.quotation.snapshot)) !== s.quotation.sourceSha256)
      throw integrity();
    for (const v of s.variations) if (sha(stableJson(v.snapshot)) !== v.sourceSha256) throw integrity();
  } catch { throw integrity(); }
  return { id: row.id, number: row.document_number, filename: row.pdf_filename, fileSize: row.pdf_size,
    pdfChecksum: row.pdf_sha256, sourceChecksum: row.source_sha256, bytes: row.pdf_bytes };
}

/** Exact numeric strings are printed as text. No binary float/IDR rounding and
 * no derived paid/outstanding assertion is introduced by an invoice. */
async function renderInvoice(s: Source, sourceHash: string) {
  const c = s.calculation, original = s.quotation.snapshot;
  const items: Array<{ description: string }> = [];
  for (const [index, line] of c.commercialSource.lines.entries()) {
    const detail = s.lineDetails.find(d => d.quotationLineId === line.quotationLineId);
    const tax = c.lines.find(x => x.chargeLineId === line.chargeLineId);
    if (!detail || !tax) throw integrity();
    const rows: string[] = [];
    addText(rows, `${index+1} ${line.addVariationId ? 'ADD' : 'BASE'} ${line.lineKind}`, detail.description);
    addText(rows, 'Quantity', `${line.quantity} ${detail.unit}`);
    addText(rows, 'Unit price', `IDR ${line.unitAmount}`);
    addText(rows, 'Original charge', `IDR ${line.chargeAmount}`);
    if (line.addVariationId) {
      const offer = s.variations.find(v => v.variationId === line.addVariationId);
      if (!offer) throw integrity();
      addText(rows, 'Approved ADD', `${offer.number}, version ${offer.version}`);
    }
    for (const reduce of line.reductions) {
      const offer = s.variations.find(v => v.variationId === reduce.variationId);
      if (!offer) throw integrity();
      addText(rows, 'Approved REDUCE', `${offer.number}, version ${reduce.approvedVersion}, -IDR ${reduce.amount}`);
      addText(rows, 'Reduced quantity', `${offer.snapshot.variation.quantity} ${offer.snapshot.variation.unit}`);
    }
    addText(rows, 'Net gross inclusive', `IDR ${tax.grossAmount}`);
    addText(rows, 'Tax treatment', `${tax.applicability}; rate ${tax.ratePercent}%`);
    addText(rows, 'Consideration before PPN', `IDR ${tax.considerationBeforePpn}`);
    addText(rows, 'DPP', `IDR ${tax.dppAmount}`); addText(rows, 'PPN', `IDR ${tax.ppnAmount}`);
    addText(rows, 'Approved method', tax.basisMethodCode);
    rows.forEach(description => items.push({description}));
  }
  const totals: string[] = [];
  addText(totals, 'Quotation', `${s.quotation.number} / version ${original.quotation.versionNumber}`);
  addText(totals, 'Total consideration before PPN', `IDR ${c.considerationBeforePpn}`);
  addText(totals, 'Total DPP', `IDR ${c.dppAmount}`); addText(totals, 'Total PPN', `IDR ${c.ppnAmount}`);
  addText(totals, 'GRAND TOTAL (inclusive)', `IDR ${c.totalIncludingPpn}`);
  addText(totals, 'Tax date', c.taxDate); addText(totals, 'Tax point UTC', c.taxPointAt);
  addText(totals, 'Invoice is not evidence of payment', 'Payments and confirmed allocations are recorded separately.');
  const payment: string[] = [];
  addText(payment, 'Down payment required in approved quotation', original.quotation.dpRequired ? 'YES' : 'NO');
  addText(payment, 'Down payment percentage', original.quotation.dpPercentage);
  addText(payment, 'Down payment amount', original.quotation.dpAmount === null ? null : `IDR ${original.quotation.dpAmount}`);
  addText(payment, 'Approved down payment terms', original.quotation.dpTermsNotes);
  addText(payment, 'Approved quotation payment note', original.settings.paymentNote);
  addText(payment, 'Bank', s.bank.bankName); addText(payment, 'Bank code', s.bank.bankCode);
  addText(payment, 'Account number', s.bank.accountNumber); addText(payment, 'Account holder', s.bank.accountHolderName);
  addText(payment, 'Bank currency', s.bank.currency);
  const terms: string[] = [];
  original.settings.termsLines.forEach((v,i) => addText(terms, `Approved quotation term ${i+1}`, v));
  // Only the customer's approved quotation terms are contractual; current
  // invoice settings may have changed and must not silently add obligations.
  addText(terms, 'Contact note', s.settings.contactNote); addText(terms, 'Footer note', s.settings.footerNote);
  addText(terms, 'Signatory name', s.settings.signatoryName); addText(terms, 'Signatory title', s.settings.signatoryTitle);
  addText(terms, 'Invoice source SHA-256', sourceHash);
  const allTerms = [...blocks('Totals and tax', totals), ...blocks('Payment terms and verified bank', payment), ...blocks('Terms and references', terms)];
  if (items.length > 400 || allTerms.length > 12) throw conflict('The complete invoice exceeds PDF layout capacity.');
  return renderHandymanDocumentPdf({ locale: s.settings.language, utcOffsetMinutes: 0,
    document: { kind: 'INVOICE', number: s.issuance.number, issueDate: s.issuance.issuedAt, currency: 'IDR', reference: c.requestId },
    issuer: { name: exactText(s.issuer.legalName), addressLines: [exactText(s.issuer.registeredAddress),
      exactText(`${s.issuer.city}, ${s.issuer.province} ${s.issuer.postalCode}`)],
      taxId: s.issuer.taxId ? exactText(s.issuer.taxId) : null, phone: exactText(s.issuer.phone), email: exactText(s.issuer.email) },
    recipient: { name: exactText(original.customer.tenantName), attention: original.customer.tenantPicName ? exactText(original.customer.tenantPicName) : null,
      references: original.customer.legalName ? [{label:'Legal name',value:exactText(original.customer.legalName)}] : [] },
    property: { name: exactText(original.customer.buildingName), lines: original.customer.spaceName ? [exactText(original.customer.spaceName)] : [] },
    lineItems: items, terms: allTerms, status: {value:'ISSUED'},
  }, { filename: `invoice-${s.issuance.number.toLowerCase()}.pdf` });
}

export async function issueOfficialHandymanInvoice(actorInput: string, input: {
  executionScopeId: string; classification: CustomerTaxClassificationPin; documentLanguage?: HandymanDocumentLocale;
}) {
  const actor = uuid(actorInput, 'actorUserId'), scopeId = uuid(input?.executionScopeId, 'executionScopeId');
  if (!input || Object.keys(input).some(k => !['executionScopeId','classification','documentLanguage'].includes(k)) ||
      (input.documentLanguage !== undefined && !['id','en'].includes(input.documentLanguage))) throw AppError.validation('Invalid invoice issuance input.');
  try {
    return await withTransaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const scope = (await tx.query<{ client_id:string; building_id:string; handyman_request_id:string; tenant_company_id:string }>(
        'SELECT client_id,building_id,handyman_request_id,tenant_company_id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE', [scopeId])).rows[0];
      if (!scope) throw notFound();
      const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
      const user = (await tx.query('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
      if (user?.status !== 'ACTIVE' || !permissions.includes('handyman.finance.manage'))
        throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Active Finance issuance authority is required.'});
      await assertBuildingScopedResourceAccess(actor, {clientId:scope.client_id,buildingId:scope.building_id}, tx);
      const ledger = (await tx.query<{id:string}>(`SELECT id FROM handyman_customer_transactions
        WHERE execution_scope_id=$1 AND client_id=$2 FOR UPDATE`, [scopeId,scope.client_id])).rows[0];
      if (!ledger) throw conflict('An existing scoped customer ledger is required.');
      const fence = await tx.query('SELECT revision FROM handyman_invoice_source_fences WHERE execution_scope_id=$1 FOR UPDATE',[scopeId]);
      if (fence.rowCount !== 1) throw integrity();
      await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, scope.client_id);
      await tx.query('SELECT request_id FROM handyman_customer_tax_heads WHERE request_id=$1 FOR SHARE',[scope.handyman_request_id]);
      await tx.query('SELECT request_id FROM handyman_buyer_binding_heads WHERE request_id=$1 FOR SHARE',[scope.handyman_request_id]);
      if ((await tx.query('SELECT 1 FROM handyman_invoice_scope_claims WHERE execution_scope_id=$1',[scopeId])).rowCount)
        throw conflict('An invoice is already bound to this execution scope.');
      if ((await tx.query(`SELECT 1 FROM handyman_scope_variations WHERE execution_scope_id=$1
        AND tenant_decision_outcome IS NULL LIMIT 1`,[scopeId])).rowCount)
        throw conflict('Unresolved scope variations must be resolved before invoicing.');
      await tx.query('SET LOCAL synchronous_commit = on');
      const durable = (await tx.query<{fsync:string;full_page_writes:string;sync_commit:string;replica:boolean}>(`SELECT
        current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,
        current_setting('synchronous_commit') AS sync_commit,pg_is_in_recovery() AS replica`)).rows[0];
      if (durable?.fsync !== 'on' || durable.full_page_writes !== 'on' || durable.sync_commit !== 'on' || durable.replica)
        throw new AppError({code:ERROR_CODES.HANDYMAN_OFFICIAL_INVOICE_DURABILITY_UNAVAILABLE,statusCode:503,
          message:'Invoice issuance requires durable primary PostgreSQL storage.'});
      const calculation = await calculateInclusiveHandymanInvoicePpnInSnapshot(tx,actor,{clientId:scope.client_id,
        requestId:scope.handyman_request_id,classification:input.classification});
      const commercial = calculation.commercialSource;
      if (commercial.executionScopeId !== scopeId || commercial.transactionId !== ledger.id) throw integrity();
      // Lock every pinned window, detecting a retirement that committed after
      // the repeatable-read snapshot. New authority writers also take client lock.
      const ruleIds = [...new Set(calculation.lines.map(l => l.rule.id))];
      const lockedRules = await tx.query('SELECT rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY($1::uuid[]) FOR SHARE',[ruleIds]);
      const lockedIdentity = await tx.query('SELECT profile_id FROM handyman_tax_identity_windows WHERE profile_id=$1 FOR SHARE',[calculation.supplier.profileId]);
      if (lockedRules.rowCount !== ruleIds.length || lockedIdentity.rowCount !== 1) throw conflict('Tax authority changed during invoice issuance.');
      const languages = (await tx.query<{language:HandymanDocumentLocale}>(`SELECT language FROM handyman_document_issuer_document_settings
        WHERE client_id=$1 AND document_kind='INVOICE' AND status='ACTIVE' ORDER BY language`,[scope.client_id])).rows;
      const language = input.documentLanguage ?? (languages.length === 1 ? languages[0].language : undefined);
      if (!language) throw conflict('Select an active INVOICE settings language.');
      const issuer = await resolveHandymanDocumentIssuerSnapshot(scope.client_id, tx);
      const bank = await resolveHandymanDocumentBankAccountSnapshot(scope.client_id, 'IDR', tx);
      const settings = await resolveHandymanDocumentSettingsSnapshot(scope.client_id, 'INVOICE', language, tx);
      if (calculation.supplier.issuerProfileId !== issuer.profileId) throw conflict('The active issuer does not match the approved tax identity.');
      if (!bank.verifiedAt || !bank.verifiedByUserId || !bank.verificationReference) throw conflict('A verified IDR receiving bank is required.');
      for (const [table,id] of [['handyman_document_issuer_profiles',issuer.profileId],
        ['handyman_document_issuer_bank_accounts',bank.versionRowId],['handyman_document_issuer_document_settings',settings.settingsId]] as const) {
        const locked = await tx.query(`SELECT id FROM ${table} WHERE id=$1 AND status='ACTIVE' FOR SHARE`,[id]);
        if (locked.rowCount !== 1) throw conflict('An invoice issuance master was retired.');
      }
      const quote = (await tx.query<QuotationDocumentStored>('SELECT * FROM handyman_quotation_documents WHERE id=$1',[commercial.quotationOffer.id])).rows[0];
      if (!quote) throw integrity();
      verifyStoredQuotationDocument(quote);
      if (quote.source_sha256 !== commercial.quotationOffer.sourceSha256 || quote.pdf_sha256 !== commercial.quotationOffer.pdfSha256 ||
          quote.source_snapshot.customer.buildingId !== scope.building_id || quote.source_snapshot.customer.tenantCompanyId !== scope.tenant_company_id)
        throw integrity();
      const refs = [...commercial.additions.map(v=>({ id:v.offerDocumentId,variationId:v.variationId,sourceSha256:v.offerSourceSha256,pdfSha256:v.offerPdfSha256 })),
        ...commercial.lines.flatMap(l=>l.reductions.map(v=>({id:v.offerDocumentId,variationId:v.variationId,sourceSha256:v.offerSourceSha256,pdfSha256:v.offerPdfSha256})))];
      const variations: Source['variations'] = [];
      for (const ref of refs) {
        const v = (await tx.query<VariationOfferStored>('SELECT * FROM handyman_variation_offer_documents WHERE id=$1',[ref.id])).rows[0];
        if (!v) throw integrity();
        verifyStoredVariationOffer(v);
        if (v.execution_scope_id !== scopeId || v.variation_id !== ref.variationId || v.source_sha256 !== ref.sourceSha256 || v.pdf_sha256 !== ref.pdfSha256)
          throw integrity();
        variations.push({documentId:v.id,variationId:v.variation_id,number:v.document_number,version:v.variation_version,
          sourceSha256:v.source_sha256,pdfSha256:v.pdf_sha256,snapshot:v.source_snapshot});
      }
      // Render the exact description and unit that the customer saw, not a
      // mutable current UOM label. Re-prove every displayed term against the
      // approved original or the exact consented ADD revision.
      const lineDetails: Source['lineDetails'] = commercial.lines.map(line => {
        const approved = line.addVariationId
          ? variations.find(v => v.variationId === line.addVariationId)?.snapshot.revised
          : quote.source_snapshot;
        const offered = approved?.lines.find(v => v.id === line.quotationLineId);
        if (!offered || approved?.quotation.versionId !== line.quotationVersionId || offered.lineType !== line.lineKind ||
            offered.quantity !== line.quantity || offered.unitAmount !== line.unitAmount || offered.total !== line.quotedAmount ||
            offered.currency !== 'IDR' || offered.taxPriceBasis !== line.taxPriceBasis) throw integrity();
        return { quotationLineId: line.quotationLineId, quotationVersionId: line.quotationVersionId,
          description: offered.description, unit: offered.unit };
      });
      const allocation = (await tx.query<{number:string;issued_at:Date}>(`SELECT nextval('handyman_official_invoice_number_seq')::text AS number,
        clock_timestamp() AS issued_at`)).rows[0]!;
      const source: Source = {schema:'HANDYMAN_OFFICIAL_INVOICE_V1',status:'ISSUED',
        issuance:{id:randomUUID(),number:`${settings.documentPrefix}-${allocation.number.padStart(10,'0')}`,
          issuedAt:allocation.issued_at.toISOString(),actorUserId:actor},calculation,
        quotation:{documentId:quote.id,number:quote.document_number,sourceSha256:quote.source_sha256,pdfSha256:quote.pdf_sha256,snapshot:quote.source_snapshot},
        variations,lineDetails,issuer,bank,settings};
      const canonical=stableJson(source), sourceHash=sha(canonical), pdf=await renderInvoice(source,sourceHash);
      if (pdf.fileSize!==pdf.bytes.length || pdf.fileSize<1 || pdf.fileSize>MAX_PDF_BYTES || sha(pdf.bytes)!==pdf.checksum) throw integrity();
      const inserted=(await tx.query<Stored>(`INSERT INTO handyman_official_invoices(id,client_id,building_id,request_id,tenant_company_id,
        execution_scope_id,transaction_id,classification_id,issuer_profile_id,bank_version_id,settings_id,document_number,issued_by_user_id,
        issued_at,currency,total_amount,source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'IDR',$15,$16::text::jsonb,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [source.issuance.id,scope.client_id,scope.building_id,scope.handyman_request_id,scope.tenant_company_id,scopeId,ledger.id,
        calculation.classification.pin.classificationId,issuer.profileId,bank.versionRowId,settings.settingsId,source.issuance.number,actor,
        source.issuance.issuedAt,calculation.totalIncludingPpn,canonical,sourceHash,pdf.filename,pdf.bytes,pdf.fileSize,pdf.checksum])).rows[0];
      if (!inserted) throw integrity();
      const verified = verifiedDownload(inserted);
      // Publish a new fence version even for a base-only/upfront invoice. A
      // REPEATABLE READ source writer that started before ISSUE must abort,
      // rather than miss the newly committed invoice in its older snapshot.
      await tx.query('UPDATE handyman_invoice_source_fences SET revision=revision+1 WHERE execution_scope_id=$1',[scopeId]);
      // Mirror existing finalization for already eligible variations only; do
      // not imply that unfinished work or BAST has been accepted.
      await tx.query(`UPDATE handyman_scope_variations SET invoiced=TRUE,updated_at=NOW()
        WHERE execution_scope_id=$1 AND client_id=$2 AND status='FINAL_CHARGE_ELIGIBILITY'
          AND final_charge_eligible=TRUE AND invoiced=FALSE`,[scopeId,scope.client_id]);
      return {id:verified.id,number:verified.number,executionScopeId:scopeId,requestId:scope.handyman_request_id,status:'ISSUED' as const,
        currency:'IDR' as const,totalAmount:calculation.totalIncludingPpn,sourceChecksum:verified.sourceChecksum,pdfChecksum:verified.pdfChecksum,
        issuedAt:source.issuance.issuedAt};
    });
  } catch (error) {
    if (!(error instanceof AppError) && ['23505','23514','40001','40P01'].includes((error as {code?:string}).code ?? ''))
      throw conflict('Invoice issuance conflicted with a duplicate or changed billing source; reload and retry.');
    throw error;
  }
}

export async function downloadOfficialHandymanInvoice(actorInput:string, scopeInput:string, invoiceInput:string) {
  const actor=uuid(actorInput,'actorUserId'),scope=uuid(scopeInput,'executionScopeId'),invoice=uuid(invoiceInput,'invoiceId');
  return withTransaction(async tx => {
    const row=(await tx.query<Stored>('SELECT * FROM handyman_official_invoices WHERE id=$1 AND execution_scope_id=$2',[invoice,scope])).rows[0];
    if (!row) throw notFound();
    const user=(await tx.query('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
    const perms=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
    if (user?.status!=='ACTIVE' || !perms.includes('handyman.finance.read'))
      throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Finance invoice read authority is required.'});
    await assertBuildingScopedResourceAccess(actor,{clientId:row.client_id,buildingId:row.building_id},tx);
    return verifiedDownload(row);
  });
}

/** Current Care grant, represented occupancy and exact request/scope/document
 * binding are proved together with the immutable document read. */
export async function downloadOfficialHandymanInvoiceForCare(token:string, requestInput:unknown, invoiceInput:unknown, query:unknown) {
  const principal=await resolveCareWorkspacePrincipal(token), selection=parseCareHandymanPaymentProofSelection(query);
  const requestId=uuid(requestInput,'requestId'),invoiceId=uuid(invoiceInput,'invoiceId');
  const result=await getPool().query<Stored & {authenticated:boolean}>(`${WORKSPACE_OCCUPANCY_CTES}
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,d.* FROM (SELECT 1) singleton
    LEFT JOIN LATERAL (
      SELECT i.* FROM handyman_service_requests r
      JOIN records c ON c."clientId"=r.client_id AND c."tenantCompanyId"=r.tenant_company_id
        AND c."buildingId"=r.building_id AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id AND s.client_id=r.client_id
        AND s.building_id=r.building_id AND s.tenant_company_id=r.tenant_company_id AND s.space_id IS NOT DISTINCT FROM r.space_id
      JOIN handyman_official_invoices i ON i.execution_scope_id=s.id AND i.client_id=r.client_id
        AND i.request_id=r.id AND i.building_id=r.building_id AND i.tenant_company_id=r.tenant_company_id
      WHERE $5::text IS NULL AND $6::integer=1 AND r.id=$10 AND i.id=$11
        AND r.tenant_company_id=$7 AND r.building_id=$8 AND r.space_id IS NOT DISTINCT FROM $9::uuid LIMIT 1
    ) d ON TRUE`,[principal.sessionId,principal.careActorId,principal.integrationId,selection.propertyId,
      null,1,selection.tenantCompanyId,selection.buildingId,selection.spaceId,requestId,invoiceId]);
  const row=result.rows[0];
  if (!row?.authenticated) throw workspaceUnauthorized();
  if (!row.id) throw new AppError({code:ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,statusCode:404,
    message:'Care workspace resource not found.'});
  return verifiedDownload(row);
}
