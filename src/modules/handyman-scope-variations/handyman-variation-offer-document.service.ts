import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { permissionRepository } from '../permissions';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from '../handyman-care-workspace/care-workspace.service';
import { parseCareHandymanPaymentProofSelection } from '../handyman-care-workspace/care-workspace-payment-proof.service';
import { WORKSPACE_OCCUPANCY_CTES } from '../handyman-care-workspace/care-workspace-occupancies.repository';
import { renderHandymanDocumentPdf } from '../handyman-documents/handyman-document-pdf';
import { assertHandymanQuotationPricingAuthority } from '../handyman-quotations/handyman-quotation-access';
import { HANDYMAN_TAX_PRICE_BASES, QUOTATION_PRICE_BASIS_PROTOCOL, VARIATION_PRICE_BASIS_PROTOCOL,
  taxPriceBasisLabel, type HandymanTaxPriceBasis } from '../handyman-quotations/handyman-quotation-price-basis';
import {
  addText, blocks, exactText, verifyStoredQuotationDocument,
  type QuotationDocumentSource, type QuotationDocumentStored,
} from '../handyman-quotations/handyman-quotation-document.service';
import { variationConsentSnapshot, type AddMaterialBinding } from './handyman-scope-variation-material-authority';
import type { HandymanScopeVariationEventRecord, HandymanScopeVariationRecord } from './handyman-scope-variation.types';

type Reference = { id: string; number: string; sourceSha256: string; pdfSha256: string };
type PriorVariation = { id: string; variationType: string; lineType: string; title: string;
  description: string; quantity: string; unit: string; quotedUnitAmount: string; quotedTotalDelta: string; currency: string };
type Source = {
  schema: 'HANDYMAN_VARIATION_OFFER_V1'; status: 'ISSUED'; clientId: string; requestId: string; executionScopeId: string;
  priceBasisProtocol?: typeof VARIATION_PRICE_BASIS_PROTOCOL;
  issuance: { id: string; number: string; issuedAt: string; actorUserId: string };
  originalReference: Reference; original: QuotationDocumentSource;
  revisedReference: Reference; revised: QuotationDocumentSource;
  variation: ReturnType<typeof variationConsentSnapshot> & { id: string; unit: string;
    priceBasisLineId?: string; taxPriceBasis?: HandymanTaxPriceBasis };
  previousAuthorizedVariations: PriorVariation[];
  reconciliation: { mode: 'STANDALONE' | 'CUMULATIVE'; originalQuotedTotal: string; revisedQuotedTotal: string };
};
export type VariationOfferStored = {
  id: string; client_id: string; request_id: string; execution_scope_id: string; variation_id: string;
  variation_version: number; original_quotation_document_id: string; revised_quotation_document_id: string;
  revised_quotation_version_id: string; document_number: string; issued_by_user_id: string; issued_at: Date;
  source_snapshot: Source; source_canonical: string; source_sha256: string; pdf_filename: string;
  pdf_bytes: Buffer; pdf_size: number; pdf_sha256: string;
};
type Stored = VariationOfferStored;
export type VariationOfferConsent = { offerDocumentId: string; offerDocumentVersion: number; offerPdfSha256: string };
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const conflict = (message: string) => new AppError({ code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION, statusCode: 409, message });
const integrity = () => conflict('The issued variation document or its frozen source failed integrity verification.');
const notFound = () => AppError.notFound('Issued variation offer document not found.');
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation(`Invalid ${field}.`);
  return value.toLowerCase();
}
function reference(row: QuotationDocumentStored): Reference {
  return { id: row.id, number: row.document_number, sourceSha256: row.source_sha256, pdfSha256: row.pdf_sha256 };
}

/** Call under the execution-scope lock at both issuance and decision. */
async function priorAuthorizedVariations(tx: PoolClient, variation: HandymanScopeVariationRecord): Promise<PriorVariation[]> {
  return (await tx.query<PriorVariation>(`SELECT v.id,
    v.variation_type AS "variationType",v.line_type AS "lineType",v.title,v.description,
    v.quantity::numeric(18,3)::text AS quantity,COALESCE(d.source_snapshot#>>'{variation,unit}',v.uom_id::text) AS unit,
    v.quoted_unit_amount::numeric(18,2)::text AS "quotedUnitAmount",
    v.quoted_total_delta::numeric(18,2)::text AS "quotedTotalDelta",v.currency
    FROM handyman_scope_variations v
    LEFT JOIN handyman_variation_offer_documents d ON d.variation_id=v.id AND d.client_id=v.client_id
    WHERE v.execution_scope_id=$1 AND v.id<>$2 AND v.quoted_total_delta IS NOT NULL
      AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
    ORDER BY v.created_at,v.id`, [variation.executionScopeId, variation.id])).rows;
}

/** Called under the scope and variation locks, inside Operations' REVISED_QUOTATION transaction. */
export async function createIssuedVariationOfferDocument(
  tx: PoolClient,
  variation: HandymanScopeVariationRecord,
  actorUserId: string,
  binding: AddMaterialBinding | null,
  reconciliation: Source['reconciliation'],
): Promise<VariationOfferConsent & { number: string; sourceSha256: string }> {
  await tx.query('SET LOCAL synchronous_commit = on');
  const durable = (await tx.query<{ fsync: string; full_page_writes: string; sync_commit: string; replica: boolean }>(`SELECT
    current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes,
    current_setting('synchronous_commit') AS sync_commit, pg_is_in_recovery() AS replica`)).rows[0];
  if (durable?.fsync !== 'on' || durable.full_page_writes !== 'on' || durable.sync_commit !== 'on' || durable.replica) {
    throw new AppError({ code: ERROR_CODES.HANDYMAN_VARIATION_DOCUMENT_DURABILITY_UNAVAILABLE, statusCode: 503,
      message: 'Variation offer documents require durable primary PostgreSQL storage.' });
  }
  const originals = await tx.query<QuotationDocumentStored>(`SELECT d.* FROM handyman_execution_scopes s
    JOIN handyman_quotation_documents d ON d.quotation_version_id=s.approved_quotation_version_id
      AND d.quotation_id=s.quotation_id AND d.client_id=s.client_id AND d.request_id=s.handyman_request_id
    WHERE s.id=$1 AND s.client_id=$2`, [variation.executionScopeId, variation.clientId]);
  const revisions = await tx.query<QuotationDocumentStored>(`SELECT d.* FROM handyman_execution_scopes s
    JOIN handyman_quotation_versions v ON v.id=$3 AND v.quotation_id=s.quotation_id
      AND v.status='ISSUED' AND v.valid_until>clock_timestamp()
    JOIN handyman_quotation_documents d ON d.quotation_version_id=v.id AND d.quotation_id=s.quotation_id
      AND d.client_id=s.client_id AND d.request_id=s.handyman_request_id
    WHERE s.id=$1 AND s.client_id=$2`, [variation.executionScopeId, variation.clientId, variation.revisedQuotationVersionId]);
  const original = originals.rows[0], revised = revisions.rows[0];
  if (!original || !revised) {
    throw conflict('The original approved quotation and the current revised offer must both have official immutable quotation documents; historical missing documents cannot be backfilled.');
  }
  verifyStoredQuotationDocument(original);
  verifyStoredQuotationDocument(revised);
  if (revised.source_snapshot.priceBasisProtocol !== QUOTATION_PRICE_BASIS_PROTOCOL) {
    throw conflict('The revised offer must disclose a price basis for every line.');
  }
  if (variation.variationType === 'REDUCE' && original.source_snapshot.priceBasisProtocol !== QUOTATION_PRICE_BASIS_PROTOCOL) {
    throw conflict('The original offer did not disclose this line basis; an authorized supplemental agreement is required.');
  }
  // An unbound legacy-style ADD labor offer can still be issued only when one
  // exact revised line resolves the disclosed basis. No Work Order is invented.
  let priceBasisLineId = variation.variationType === 'REDUCE' ? variation.targetQuotationLineId : binding?.revisedQuotationLineId;
  if (variation.variationType === 'ADD' && !priceBasisLineId) {
    const matches = await tx.query<{ id: string }>(`SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id=$1 AND line_type=$2 AND uom_id=$3 AND quantity=$4::numeric
        AND final_quoted_unit_amount=$5::numeric AND currency=$6 AND line_total=$7::numeric`,
    [variation.revisedQuotationVersionId, variation.lineType, variation.uomId, variation.quantity,
      variation.quotedUnitAmount, variation.currency, variation.quotedTotalDelta]);
    if (matches.rows.length !== 1) throw conflict('The ADD price basis requires one exact revised quotation line.');
    priceBasisLineId = matches.rows[0].id;
  }
  // A REDUCE refers to the original approved line, not an assumed revised one.
  const unitLine = (variation.variationType === 'REDUCE' ? original : revised).source_snapshot.lines
    .find(line => line.id === priceBasisLineId);
  if (!unitLine || unitLine.uomId !== variation.uomId || !unitLine.unit || !unitLine.taxPriceBasis) {
    throw conflict('The affected line has no disclosed commercial price basis; an authorized supplemental agreement is required.');
  }
  const unit = unitLine.unit, taxPriceBasis = unitLine.taxPriceBasis;
  // Show previously authorized work even for a standalone re-quote, but make
  // clear whether those adjustments are included in this quotation's total.
  const previous = await priorAuthorizedVariations(tx, variation);
  const allocation = (await tx.query<{ number: string; issued_at: Date }>(
    `SELECT nextval('handyman_variation_offer_document_number_seq')::text AS number,clock_timestamp() AS issued_at`)).rows[0]!;
  // Use the exact quotation settings already frozen at commercial ISSUE. This
  // preserves the offered issuer, payment terms and bank rather than silently
  // substituting today's settings; VO makes the document number distinct.
  const number = `${revised.source_snapshot.settings.documentPrefix}-VO-${allocation.number.padStart(10, '0')}`;
  const source: Source = { schema: 'HANDYMAN_VARIATION_OFFER_V1', status: 'ISSUED', clientId: variation.clientId,
    priceBasisProtocol: VARIATION_PRICE_BASIS_PROTOCOL,
    requestId: variation.handymanRequestId, executionScopeId: variation.executionScopeId,
    issuance: { id: randomUUID(), number, issuedAt: allocation.issued_at.toISOString(), actorUserId },
    originalReference: reference(original), original: original.source_snapshot,
    revisedReference: reference(revised), revised: revised.source_snapshot,
    variation: { id: variation.id, ...variationConsentSnapshot(variation, variation.version, binding), unit,
      priceBasisLineId: unitLine.id, taxPriceBasis },
    previousAuthorizedVariations: previous, reconciliation };
  const canonical = stableJson(source), sourceHash = sha(canonical);
  const pdf = await renderOffer(source, sourceHash);
  if (pdf.bytes.length !== pdf.fileSize || pdf.fileSize < 1 || pdf.fileSize > MAX_PDF_BYTES ||
      pdf.bytes.subarray(0, 5).toString() !== '%PDF-' || sha(pdf.bytes) !== pdf.checksum) throw integrity();
  const live = await tx.query<{ valid: boolean }>(`SELECT status='ISSUED' AND valid_until>clock_timestamp() AS valid
    FROM handyman_quotation_versions WHERE id=$1`, [variation.revisedQuotationVersionId]);
  if (!live.rows[0]?.valid) throw conflict('The revised quotation offer expired before document issuance.');
  const stored = (await tx.query<Stored>(`INSERT INTO handyman_variation_offer_documents
    (id,client_id,request_id,execution_scope_id,variation_id,variation_version,original_quotation_document_id,
     revised_quotation_document_id,revised_quotation_version_id,document_number,issued_by_user_id,issued_at,
     source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::jsonb,$13::text,$14,$15,$16,$17,$18) RETURNING *`,
  [source.issuance.id, source.clientId, source.requestId, source.executionScopeId, variation.id, variation.version,
    original.id, revised.id, variation.revisedQuotationVersionId, number, actorUserId, source.issuance.issuedAt,
    canonical, sourceHash, pdf.filename, pdf.bytes, pdf.fileSize, pdf.checksum])).rows[0];
  if (!stored) throw integrity();
  verifyStored(stored);
  return { offerDocumentId: stored.id, offerDocumentVersion: stored.variation_version,
    offerPdfSha256: stored.pdf_sha256, number, sourceSha256: sourceHash };
}

async function renderOffer(s: Source, sourceHash: string) {
  // Render exact numeric strings in full-width blocks: the shared numeric
  // table rounds quantities and currency and can compress descriptions.
  const items: string[] = [];
  function item(label: string, value: unknown) { addText(items, label, value); }
  const v = s.variation;
  item('Current offered change', `${v.variationType} ${v.lineType}`);
  item('Title', v.title); item('Description', v.description); item('Technical finding', v.technicalFinding);
  item('Quantity', `${v.quantity} ${v.unit}`);
  item('Unit price', `${v.currency} ${v.quotedUnitAmount}`);
  item('Current price difference', `${v.currency} ${v.quotedTotalDelta}`);
  item('Current change tax price basis', taxPriceBasisLabel(v.taxPriceBasis));
  item('Price basis quotation line ID', v.priceBasisLineId);
  item('Original quotation line ID', v.targetQuotationLineId);
  item('Revised quotation line ID', v.revisedQuotationLineId);
  item('Work Order ID', v.workOrderId);
  if (s.previousAuthorizedVariations.length) item('Prior changes in revised total',
    s.reconciliation.mode === 'CUMULATIVE' ? 'YES' : 'NO - standalone quotation');
  for (const [i, prior] of s.previousAuthorizedVariations.entries()) {
    item(`Prior authorized change ${i + 1}`, `${prior.variationType} ${prior.lineType}`);
    item('Title', prior.title); item('Description', prior.description); item('Quantity', `${prior.quantity} ${prior.unit}`);
    item('Unit price', `${prior.currency} ${prior.quotedUnitAmount}`);
    item('Prior price difference', `${prior.currency} ${prior.quotedTotalDelta}`);
  }
  function quotationLines(label: string, quote: QuotationDocumentSource) {
    quote.lines.forEach((line, i) => {
      item(`${label} ${i + 1}`, line.lineType);
      item('Item', line.description); item('Quantity', `${line.quantity} ${line.unit}`);
      item('Unit price', `${line.currency} ${line.unitAmount}`);
      item('Line total', `${line.currency} ${line.total}`);
      item('Tax price basis', taxPriceBasisLabel(
        quote.priceBasisProtocol === QUOTATION_PRICE_BASIS_PROTOCOL ? line.taxPriceBasis : undefined));
    });
  }
  quotationLines('Original approved scope', s.original);
  quotationLines('Revised quotation scope', s.revised);
  const scope: string[] = [];
  addText(scope, 'Issuer legal name', s.revised.issuer.legalName);
  addText(scope, 'Issuer registered address', s.revised.issuer.registeredAddress);
  addText(scope, 'Issuer city', s.revised.issuer.city); addText(scope, 'Issuer province', s.revised.issuer.province);
  addText(scope, 'Issuer postal code', s.revised.issuer.postalCode); addText(scope, 'Issuer email', s.revised.issuer.email);
  addText(scope, 'Issuer phone', s.revised.issuer.phone); addText(scope, 'Issuer tax ID', s.revised.issuer.taxId);
  addText(scope, 'Offer document ID', s.issuance.id); addText(scope, 'Variation ID', v.id);
  addText(scope, 'Offer variation version', v.version);
  addText(scope, 'Original quotation number', s.originalReference.number);
  addText(scope, 'Original quotation version', s.original.quotation.versionNumber);
  addText(scope, 'Original quotation PDF SHA-256', s.originalReference.pdfSha256);
  addText(scope, 'Revised quotation number', s.revisedReference.number);
  addText(scope, 'Revised quotation version', s.revised.quotation.versionNumber);
  addText(scope, 'Revised quotation PDF SHA-256', s.revisedReference.pdfSha256);
  addText(scope, 'Request ID', s.requestId); addText(scope, 'Offer tenant', s.revised.customer.tenantName);
  addText(scope, 'Offer tenant legal name', s.revised.customer.legalName); addText(scope, 'Offer contact', s.revised.customer.tenantPicName);
  addText(scope, 'Offer building', s.revised.customer.buildingName); addText(scope, 'Offer space', s.revised.customer.spaceName);
  addText(scope, 'Original tenant', s.original.customer.tenantName); addText(scope, 'Original building', s.original.customer.buildingName);
  addText(scope, 'Original space', s.original.customer.spaceName); addText(scope, 'Service', s.original.customer.serviceName);
  addText(scope, 'Request description', s.original.customer.requestDescription);
  s.original.requestItems.forEach((item, i) => {
    addText(scope, `Original service item ${i + 1}`, item.serviceName); addText(scope, 'Variant', item.variantName);
    addText(scope, 'Quantity', `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`);
    addText(scope, 'Description', item.description); addText(scope, 'Attributes', item.attributes);
    addText(scope, 'Inherited attributes', item.inheritedAttributes); addText(scope, 'Access condition', item.accessCondition);
  });
  const summary: string[] = [];
  addText(summary, 'Offer status', 'ISSUED - NOT APPROVED');
  addText(summary, 'Execution authority', 'NONE - Tenant PIC consent and Operations authorization required');
  addText(summary, 'Issued at UTC', s.issuance.issuedAt); addText(summary, 'Valid until UTC', s.revised.quotation.validUntil);
  addText(summary, 'Reconciliation', s.reconciliation.mode);
  addText(summary, 'Original total', `${v.currency} ${s.reconciliation.originalQuotedTotal}`);
  addText(summary, 'Current variation difference', `${v.currency} ${v.quotedTotalDelta}`);
  addText(summary, 'Revised labor subtotal', `${v.currency} ${s.revised.totals.labor}`);
  addText(summary, 'Revised material subtotal', `${v.currency} ${s.revised.totals.material}`);
  addText(summary, 'Revised quoted line total', `${v.currency} ${s.reconciliation.revisedQuotedTotal}`);
  addText(summary, 'Tax note', 'Totals exclude any applicable PPN on lines marked EXCLUSIVE. Applicability is determined separately.');
  addText(summary, 'Basis precedence', 'Per-line price basis controls over general tax terms / basis per item berlaku atas ketentuan pajak umum.');
  addText(summary, 'Down payment required', s.revised.quotation.dpRequired ? 'YES' : 'NO');
  addText(summary, 'Down payment percentage', s.revised.quotation.dpPercentage);
  addText(summary, 'Down payment amount', s.revised.quotation.dpAmount === null ? null : `${v.currency} ${s.revised.quotation.dpAmount}`);
  addText(summary, 'Down payment terms', s.revised.quotation.dpTermsNotes);
  const payment: string[] = [];
  addText(payment, 'Bank', s.revised.bank.bankName); addText(payment, 'Bank code', s.revised.bank.bankCode);
  addText(payment, 'Account number', s.revised.bank.accountNumber); addText(payment, 'Account holder', s.revised.bank.accountHolderName);
  addText(payment, 'Currency', s.revised.bank.currency); addText(payment, 'Payment terms', s.revised.settings.paymentNote);
  const terms: string[] = [];
  s.revised.settings.termsLines.forEach((line, i) => addText(terms, `Term ${i + 1}`, line));
  addText(terms, 'Warranty note', s.revised.settings.warrantyNote); addText(terms, 'Contact note', s.revised.settings.contactNote);
  addText(terms, 'Footer note', s.revised.settings.footerNote); addText(terms, 'Signatory name', s.revised.settings.signatoryName);
  addText(terms, 'Signatory title', s.revised.settings.signatoryTitle); addText(terms, 'Source SHA-256', sourceHash);
  const allTerms = [...blocks('Variation and quotation lines', items), ...blocks('Scope and quotation references', scope),
    ...blocks('Variation totals and down payment', summary), ...blocks('Payment', payment), ...blocks('Terms', terms)];
  if (items.length > 400 || allTerms.length > 12) throw conflict('Variation source exceeds the complete PDF layout capacity.');
  const issuer = s.revised.issuer, customer = s.revised.customer;
  return renderHandymanDocumentPdf({ locale: s.revised.settings.language, utcOffsetMinutes: 0,
    document: { kind: 'VARIATION_ORDER', typeLabel: 'Scope Variation Offer', number: s.issuance.number,
      version: v.version, issueDate: s.issuance.issuedAt, validUntil: s.revised.quotation.validUntil,
      currency: s.revised.quotation.currency, reference: s.requestId },
    issuer: { name: exactText(issuer.legalName), addressLines: [exactText(issuer.registeredAddress),
      exactText(`${issuer.city}, ${issuer.province} ${issuer.postalCode}`)], taxId: issuer.taxId ? exactText(issuer.taxId) : null,
      phone: exactText(issuer.phone), email: exactText(issuer.email) },
    recipient: { name: exactText(customer.tenantName) },
    property: { name: exactText(customer.buildingName), lines: customer.spaceName ? [exactText(customer.spaceName)] : [] },
    terms: allTerms, status: { value: 'ISSUED - OFFER ONLY',
      lines: ['Not Tenant PIC approval. Not authorization to execute work.'] },
  }, { filename: `variation-offer-${s.issuance.number.toLowerCase()}.pdf` });
}

function verifyStored(row: Stored): void {
  try {
    const s = row.source_snapshot;
    if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_bytes.length !== row.pdf_size || row.pdf_size < 1 || row.pdf_size > MAX_PDF_BYTES ||
        row.pdf_bytes.subarray(0, 5).toString() !== '%PDF-' || sha(row.pdf_bytes) !== row.pdf_sha256 ||
        !/^[a-z0-9-]+\.pdf$/.test(row.pdf_filename) || stableJson(s) !== row.source_canonical || sha(row.source_canonical) !== row.source_sha256 ||
        s.schema !== 'HANDYMAN_VARIATION_OFFER_V1' || s.status !== 'ISSUED' || s.clientId !== row.client_id ||
        s.requestId !== row.request_id || s.executionScopeId !== row.execution_scope_id ||
        s.variation.id !== row.variation_id || s.variation.version !== row.variation_version ||
        s.variation.revisedQuotationVersionId !== row.revised_quotation_version_id ||
        s.originalReference.id !== row.original_quotation_document_id || s.revisedReference.id !== row.revised_quotation_document_id ||
        s.revised.quotation.versionId !== row.revised_quotation_version_id ||
        s.issuance.id !== row.id || s.issuance.number !== row.document_number || s.issuance.actorUserId !== row.issued_by_user_id ||
        s.issuance.issuedAt !== row.issued_at.toISOString() ||
        (s.priceBasisProtocol !== undefined && (s.priceBasisProtocol !== VARIATION_PRICE_BASIS_PROTOCOL ||
          !s.variation.priceBasisLineId || !(HANDYMAN_TAX_PRICE_BASES as readonly string[]).includes(s.variation.taxPriceBasis ?? '')))) throw integrity();
  } catch { throw integrity(); }
}
export { verifyStored as verifyStoredVariationOffer };
function asDownload(row: Stored) {
  verifyStored(row);
  return { id: row.id, version: row.variation_version, filename: row.pdf_filename, fileSize: row.pdf_size,
    sourceChecksum: row.source_sha256, pdfChecksum: row.pdf_sha256, bytes: row.pdf_bytes };
}

/** Require the PIC to identify the bytes, not merely the current variation or quotation head. */
export async function requireVariationOfferForDecision(tx: PoolClient, variation: HandymanScopeVariationRecord,
  events: HandymanScopeVariationEventRecord[], binding: AddMaterialBinding | null,
  input: { offerDocumentId?: unknown; offerDocumentVersion?: unknown; offerPdfSha256?: unknown }): Promise<VariationOfferConsent> {
  const id = uuid(input.offerDocumentId, 'offerDocumentId');
  const version = Number(input.offerDocumentVersion);
  if ((typeof input.offerDocumentVersion !== 'number' && typeof input.offerDocumentVersion !== 'string') ||
      !Number.isInteger(version) || version < 1) throw AppError.validation('offerDocumentVersion must be a positive integer.');
  if (typeof input.offerPdfSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.offerPdfSha256)) {
    throw AppError.validation('offerPdfSha256 must be the exact lowercase SHA-256 of the issued offer.');
  }
  const row = (await tx.query<Stored>('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1 AND execution_scope_id=$2',
    [variation.id, variation.executionScopeId])).rows[0];
  if (!row) throw conflict('No official offer exists for this historical variation; issue a new governed variation for fresh consent.');
  verifyStored(row);
  const prior = await priorAuthorizedVariations(tx, variation);
  if (stableJson(prior) !== stableJson(row.source_snapshot.previousAuthorizedVariations)) {
    throw conflict('The authorized scope changed after this offer; issue a new governed offer for fresh Tenant consent.');
  }
  const revision = events.find(e => e.eventType === 'REVISED_QUOTATION' && e.actorRole === 'OPERATIONS_MANAGER');
  const ref = revision?.metadata.offerDocument as { id?: unknown; version?: unknown; pdfSha256?: unknown; sourceSha256?: unknown } | undefined;
  const terms = variationConsentSnapshot(variation, row.variation_version, binding);
  if (id !== row.id || version !== row.variation_version || input.offerPdfSha256 !== row.pdf_sha256 ||
      ref?.id !== row.id || ref?.version !== row.variation_version || ref?.pdfSha256 !== row.pdf_sha256 || ref?.sourceSha256 !== row.source_sha256 ||
      !Object.entries(terms).every(([key, value]) => (row.source_snapshot.variation as Record<string, unknown>)[key] === value)) {
    throw conflict('Tenant decision must identify the exact immutable issued offer, version, checksum and terms.');
  }
  return { offerDocumentId: row.id, offerDocumentVersion: row.variation_version, offerPdfSha256: row.pdf_sha256 };
}

/** Local Operations or Building Care, with the same current building checks as quotation downloads. */
export async function downloadVariationOfferDocument(actorInput: string, scopeInput: string, variationInput: string) {
  const actor = uuid(actorInput, 'actorUserId'), scopeId = uuid(scopeInput, 'executionScopeId');
  const variationId = uuid(variationInput, 'variationId');
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const context = (await tx.query<{ client_id: string; request_id: string; building_id: string; user_status: string }>(`SELECT
      s.client_id,s.handyman_request_id AS request_id,s.building_id,u.status AS user_status
      FROM handyman_execution_scopes s JOIN handyman_scope_variations v ON v.execution_scope_id=s.id AND v.client_id=s.client_id
      JOIN users u ON u.id=$3 WHERE s.id=$1 AND v.id=$2`, [scopeId, variationId, actor])).rows[0];
    if (!context) throw notFound();
    const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
    if (context.user_status !== 'ACTIVE') throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Active user required.' });
    if (permissions.includes('handyman.commercial.manage')) {
      await assertBuildingScopedResourceAccess(actor, { clientId: context.client_id, buildingId: context.building_id }, tx);
      await assertHandymanQuotationPricingAuthority({ clientId: context.client_id, handymanRequestId: context.request_id, actorUserId: actor }, tx);
    } else if (permissions.includes('handyman.care.building')) {
      const buildings = await resolveBuildingsForUser(actor, tx);
      if (!buildings.some(b => b.client?.id === context.client_id && b.building.id === context.building_id)) throw notFound();
    } else throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Variation offer requires Operations or Building Care authority.' });
    const row = (await tx.query<Stored>(`SELECT * FROM handyman_variation_offer_documents
      WHERE variation_id=$1 AND execution_scope_id=$2 AND client_id=$3 AND request_id=$4`,
    [variationId, scopeId, context.client_id, context.request_id])).rows[0];
    if (!row) throw notFound();
    return asDownload(row);
  });
}

/** Care workspace credential + current property grant + exact represented occupancy/request. */
export async function downloadVariationOfferDocumentForCare(token: string, requestInput: unknown, variationInput: unknown, query: unknown) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const selection = parseCareHandymanPaymentProofSelection(query);
  const requestId = uuid(requestInput, 'requestId'), variationId = uuid(variationInput, 'variationId');
  const result = await getPool().query<Stored & { authenticated: boolean }>(`${WORKSPACE_OCCUPANCY_CTES}
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,d.* FROM (SELECT 1) singleton
    LEFT JOIN LATERAL (
      SELECT doc.* FROM handyman_service_requests r
      JOIN records c ON c."clientId"=r.client_id AND c."tenantCompanyId"=r.tenant_company_id
        AND c."buildingId"=r.building_id AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id AND s.client_id=r.client_id
      JOIN handyman_scope_variations v ON v.execution_scope_id=s.id AND v.client_id=s.client_id
      JOIN handyman_variation_offer_documents doc ON doc.variation_id=v.id AND doc.execution_scope_id=s.id
        AND doc.request_id=r.id AND doc.client_id=r.client_id
      WHERE $5::text IS NULL AND $6::integer=1 AND r.id=$10 AND v.id=$11
        AND r.tenant_company_id=$7 AND r.building_id=$8 AND r.space_id IS NOT DISTINCT FROM $9::uuid
      LIMIT 1
    ) d ON TRUE`, [principal.sessionId, principal.careActorId, principal.integrationId, selection.propertyId,
    null, 1, selection.tenantCompanyId, selection.buildingId, selection.spaceId, requestId, variationId]);
  const row = result.rows[0];
  if (!row?.authenticated) throw workspaceUnauthorized();
  if (!row.id) throw new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    statusCode: 404, message: 'Care workspace resource not found.' });
  return asDownload(row);
}
