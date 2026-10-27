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
import { handymanDocumentIssuerProfileRepository } from '../handyman-documents/handyman-document-issuer.repository';
import { resolveHandymanDocumentIssuerSnapshot } from '../handyman-documents/handyman-document-issuer.service';
import { resolveHandymanDocumentBankAccountSnapshot } from '../handyman-documents/handyman-document-bank.service';
import { resolveHandymanDocumentSettingsSnapshot } from '../handyman-documents/handyman-document-settings.service';
import { renderHandymanDocumentPdf } from '../handyman-documents/handyman-document-pdf';
import type { HandymanDocumentLocale, HandymanDocumentTermsBlock } from '../handyman-documents/handyman-document-pdf.types';
import { assertHandymanQuotationPricingAuthority } from './handyman-quotation-access';
import { assertHandymanTenantDecisionActor } from '../handyman-tenant-decision-authority/handyman-tenant-decision-authority';
import { HANDYMAN_TAX_PRICE_BASES, QUOTATION_PRICE_BASIS_PROTOCOL, taxPriceBasisLabel,
  type HandymanTaxPriceBasis } from './handyman-quotation-price-basis';
import type { HandymanQuotationRecord, HandymanQuotationVersionRecord } from './handyman-quotation.types';

type Line = { id: string; lineType: string; description: string; quantity: string; uomId: string;
  unit: string; unitAmount: string; total: string; currency: string; taxPriceBasis?: HandymanTaxPriceBasis };
type Customer = { requestId: string; tenantCompanyId: string; tenantName: string; legalName: string | null;
  tenantPicName: string | null; buildingId: string; buildingName: string; spaceId: string | null;
  spaceName: string | null; serviceName: string | null; requestDescription: string | null };
type RequestItem = { id: string; serviceName: string; variantName: string | null; quantity: string;
  unit: string | null; description: string | null; attributes: unknown; inheritedAttributes: unknown; accessCondition: string | null };
export type QuotationDocumentSource = {
  schema: 'HANDYMAN_QUOTATION_DOCUMENT_V1'; status: 'ISSUED'; clientId: string;
  /** Absent on historical documents; never inferred or backfilled. */
  priceBasisProtocol?: typeof QUOTATION_PRICE_BASIS_PROTOCOL;
  issuance: { id: string; number: string; issuedAt: string; actorUserId: string };
  quotation: { id: string; versionId: string; versionNumber: number; validUntil: string; currency: string;
    dpRequired: boolean; dpPercentage: string | null; dpAmount: string | null; dpTermsNotes: string | null };
  customer: Customer; requestItems: RequestItem[]; lines: Line[];
  totals: { labor: string; material: string; total: string };
  issuer: Awaited<ReturnType<typeof resolveHandymanDocumentIssuerSnapshot>>;
  bank: Awaited<ReturnType<typeof resolveHandymanDocumentBankAccountSnapshot>>;
  settings: Awaited<ReturnType<typeof resolveHandymanDocumentSettingsSnapshot>>;
};
export type QuotationDocumentStored = { id: string; client_id: string; request_id: string; quotation_id: string; quotation_version_id: string;
  document_number: string; issuer_profile_id: string; bank_version_id: string; settings_id: string;
  issued_by_user_id: string; issued_at: Date; source_snapshot: QuotationDocumentSource; source_canonical: string; source_sha256: string;
  pdf_filename: string; pdf_bytes: Buffer; pdf_size: number; pdf_sha256: string };
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const conflict = (message: string) => new AppError({ code: 'HANDYMAN_QUOTATION_DOCUMENT_CONFLICT', statusCode: 409, message });
const notFound = () => AppError.notFound('Issued quotation document not found.');
const integrity = () => new AppError({ code: 'HANDYMAN_QUOTATION_DOCUMENT_INTEGRITY_ERROR', statusCode: 409,
  message: 'Quotation document or its frozen source failed integrity verification.' });
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation(`Invalid ${field}.`);
  return value.toLowerCase();
}

/** This is called ONLY from the already-authorized, version-locked ISSUE transaction. */
export async function createIssuedQuotationDocument(
  tx: PoolClient, quotation: HandymanQuotationRecord, issued: HandymanQuotationVersionRecord,
  actorUserId: string, language?: HandymanDocumentLocale,
): Promise<void> {
  if (issued.status !== 'ISSUED' || !issued.validUntil || issued.quotationId !== quotation.id) {
    throw conflict('The exact newly issued quotation version is required.');
  }
  // 0490, 0491 and 0492 writers all take this same provider lock. Their
  // independently versioned ACTIVE records cannot change while being pinned.
  await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, quotation.clientId);
  await tx.query('SET LOCAL synchronous_commit = on');
  const durable = (await tx.query<{ fsync: string; full_page_writes: string; sync_commit: string; replica: boolean }>(`SELECT
    current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes,
    current_setting('synchronous_commit') AS sync_commit, pg_is_in_recovery() AS replica`)).rows[0];
  if (durable?.fsync !== 'on' || durable.full_page_writes !== 'on' || durable.sync_commit !== 'on' || durable.replica) {
    throw new AppError({ code: 'HANDYMAN_QUOTATION_DOCUMENT_DURABILITY_UNAVAILABLE', statusCode: 503,
      message: 'Quotation documents require durable primary PostgreSQL storage.' });
  }
  const langs = (await tx.query<{ language: HandymanDocumentLocale }>(`SELECT language
    FROM handyman_document_issuer_document_settings WHERE client_id=$1 AND document_kind='QUOTATION' AND status='ACTIVE'
    ORDER BY language`, [quotation.clientId])).rows;
  if (language !== undefined && language !== 'id' && language !== 'en') throw AppError.validation('Invalid quotation document language.');
  const selected = language ?? (langs.length === 1 ? langs[0]?.language : undefined);
  if (!selected) throw conflict('Exactly one quotation settings language must be configured, or documentLanguage must be selected.');
  const issuer = await resolveHandymanDocumentIssuerSnapshot(quotation.clientId, tx);
  const settings = await resolveHandymanDocumentSettingsSnapshot(quotation.clientId, 'QUOTATION', selected, tx);
  const version = (await tx.query<{ valid_until: Date; dp_required: boolean; dp_percentage: string | null;
    dp_amount: string | null; dp_terms_notes: string | null }>(`SELECT valid_until,dp_required,dp_percentage::text,dp_amount::text,dp_terms_notes
      FROM handyman_quotation_versions WHERE id=$1 AND quotation_id=$2 AND status='ISSUED'`, [issued.id, quotation.id])).rows[0];
  if (!version?.valid_until) throw conflict('Issued quotation source version is unavailable.');
  const lines = (await tx.query<Line>(`SELECT l.id,l.line_type AS "lineType",l.description,l.quantity::text AS quantity,
      l.uom_id AS "uomId",u.symbol AS unit,l.final_quoted_unit_amount::text AS "unitAmount",l.line_total::text AS total,l.currency,
      b.tax_price_basis AS "taxPriceBasis"
    FROM handyman_quotation_lines l JOIN units_of_measure u ON u.id=l.uom_id AND u.client_id=$2
    JOIN handyman_quotation_line_price_bases b ON b.quotation_line_id=l.id AND b.quotation_version_id=l.quotation_version_id
    WHERE l.quotation_version_id=$1 ORDER BY l.created_at,l.id`, [issued.id, quotation.clientId])).rows;
  const sums = (await tx.query<{ count: string; currencies: string; currency: string | null; labor: string; material: string; total: string }>(`
    SELECT count(*)::text AS count,count(DISTINCT currency)::text AS currencies,min(currency) AS currency,
      COALESCE(sum(line_total) FILTER (WHERE line_type='LABOR'),0)::text AS labor,
      COALESCE(sum(line_total) FILTER (WHERE line_type='MATERIAL'),0)::text AS material,
      COALESCE(sum(line_total),0)::text AS total FROM handyman_quotation_lines WHERE quotation_version_id=$1`, [issued.id])).rows[0];
  if (!sums || lines.length === 0 || lines.length !== Number(sums.count) || sums.currencies !== '1' || !sums.currency) {
    throw conflict('Complete quotation lines and one source currency are required.');
  }
  const bank = await resolveHandymanDocumentBankAccountSnapshot(quotation.clientId, sums.currency, tx);
  if (!bank.verifiedAt || !bank.verifiedByUserId || !bank.verificationReference) throw conflict('A verified default receiving bank is required.');
  // Under REPEATABLE READ, locking each chosen row also detects a concurrent
  // retirement that committed after the transaction's snapshot (40001),
  // rather than issuing under a stale ACTIVE view.
  for (const [table, id] of [
    ['handyman_document_issuer_profiles', issuer.profileId],
    ['handyman_document_issuer_bank_accounts', bank.versionRowId],
    ['handyman_document_issuer_document_settings', settings.settingsId],
  ] as const) {
    const locked = await tx.query(`SELECT id FROM ${table} WHERE id=$1 AND status='ACTIVE' FOR SHARE`, [id]);
    if (locked.rowCount !== 1) throw conflict('An issuance master was retired during quotation issuance.');
  }
  const customer = (await tx.query<Customer>(`SELECT r.id AS "requestId",tc.id AS "tenantCompanyId",tc.tenant_name AS "tenantName",
    tc.legal_name AS "legalName",tp.pic_name AS "tenantPicName",b.id AS "buildingId",b.name AS "buildingName",
    sp.id AS "spaceId",sp.name AS "spaceName",sc.name AS "serviceName",r.description AS "requestDescription"
    FROM handyman_service_requests r JOIN tenant_companies tc ON tc.id=r.tenant_company_id AND tc.client_id=r.client_id
    JOIN buildings b ON b.id=r.building_id JOIN properties p ON p.id=b.property_id AND p.client_id=r.client_id
    LEFT JOIN spaces sp ON sp.id=r.space_id LEFT JOIN tenant_pics tp ON tp.id=r.tenant_pic_id AND tp.tenant_company_id=tc.id
    LEFT JOIN service_catalog sc ON sc.id=r.service_catalog_id AND sc.client_id=r.client_id
    WHERE r.id=$1 AND r.client_id=$2`, [quotation.handymanRequestId, quotation.clientId])).rows[0];
  if (!customer?.tenantName || !customer.buildingName || (customer.spaceId && !customer.spaceName)) {
    throw conflict('The quotation customer and property scope are incomplete.');
  }
  const requestItems = (await tx.query<RequestItem>(`SELECT ri.id,sc.name AS "serviceName",sv.name AS "variantName",
    ri.quantity::text AS quantity,u.symbol AS unit,ri.item_description AS description,ri.attribute_values AS attributes,
    ri.inherited_attribute_values AS "inheritedAttributes",ri.access_condition AS "accessCondition"
    FROM handyman_service_request_items ri JOIN service_catalog sc ON sc.id=ri.service_catalog_id AND sc.client_id=ri.client_id
    LEFT JOIN handyman_service_variants sv ON sv.id=ri.service_variant_id AND sv.client_id=ri.client_id
    LEFT JOIN units_of_measure u ON u.id=ri.uom_id AND u.client_id=ri.client_id
    WHERE ri.handyman_request_id=$1 AND ri.client_id=$2 AND ri.status='ACTIVE' ORDER BY ri.created_at,ri.id`,
  [quotation.handymanRequestId, quotation.clientId])).rows;
  const allocation = (await tx.query<{ number: string; issued_at: Date }>(
    `SELECT nextval('handyman_quotation_document_number_seq')::text AS number, clock_timestamp() AS issued_at`)).rows[0]!;
  const documentNumber = `${settings.documentPrefix}-${allocation.number.padStart(10, '0')}`;
  if (version.valid_until.getTime() <= allocation.issued_at.getTime()) throw conflict('Quotation validity ended before document issuance.');
  const source: QuotationDocumentSource = { schema: 'HANDYMAN_QUOTATION_DOCUMENT_V1', status: 'ISSUED', clientId: quotation.clientId,
    priceBasisProtocol: QUOTATION_PRICE_BASIS_PROTOCOL,
    issuance: { id: randomUUID(), number: documentNumber, issuedAt: allocation.issued_at.toISOString(), actorUserId },
    quotation: { id: quotation.id, versionId: issued.id, versionNumber: issued.versionNumber,
      validUntil: version.valid_until.toISOString(), currency: sums.currency, dpRequired: version.dp_required,
      dpPercentage: version.dp_percentage, dpAmount: version.dp_amount, dpTermsNotes: version.dp_terms_notes },
    customer, requestItems, lines, totals: { labor: sums.labor, material: sums.material, total: sums.total }, issuer, bank, settings };
  const canonical = stableJson(source), sourceHash = sha(canonical);
  const pdf = await renderQuotation(source, sourceHash);
  if (pdf.bytes.length !== pdf.fileSize || pdf.fileSize < 1 || pdf.fileSize > MAX_PDF_BYTES ||
      pdf.bytes.subarray(0, 5).toString() !== '%PDF-' || sha(pdf.bytes) !== pdf.checksum) throw integrity();
  if (version.valid_until.getTime() <= Date.now()) throw conflict('Quotation validity ended before document persistence.');
  const stored = (await tx.query<QuotationDocumentStored>(`INSERT INTO handyman_quotation_documents
    (id,client_id,request_id,quotation_id,quotation_version_id,document_number,issuer_profile_id,bank_version_id,settings_id,
     issued_by_user_id,issued_at,source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb,$12::text,$13,$14,$15,$16,$17) RETURNING *`,
  [source.issuance.id, source.clientId, customer.requestId, quotation.id, issued.id, documentNumber,
    issuer.profileId, bank.versionRowId, settings.settingsId, actorUserId, source.issuance.issuedAt,
    canonical, sourceHash, pdf.filename, pdf.bytes, pdf.fileSize, pdf.checksum])).rows[0];
  if (!stored) throw integrity();
  verifyStoredQuotationDocument(stored);
}

/** WinAnsi PDF fonts cannot encode every input; losslessly escape unsupported
 * code points instead of silently dropping a customer's scope or payment data. */
export function exactText(value: string): string {
  const chars = Array.from(value);
  return chars.map((ch, i) => {
    if (ch === '\\') return '\\\\';
    if (ch === ' ' && (i === 0 || i === chars.length - 1 || chars[i - 1] === ' ' || chars[i + 1] === ' ')) return '\\u{20}';
    const n = ch.codePointAt(0)!;
    return n >= 0x20 && n <= 0x7e ? ch : `\\u{${n.toString(16).toUpperCase()}}`;
  }).join('');
}
function pieces(value: string, width = 55): string[] {
  const text = exactText(value);
  return (text.match(new RegExp(`[\\s\\S]{1,${width}}`, 'g')) ?? [''])
    .map(chunk => chunk.replace(/^ /, '\\u{20}').replace(/ $/, '\\u{20}'));
}
export function addText(target: string[], label: string, value: unknown): void {
  if (value === null || value === undefined) return;
  const text = typeof value === 'string' ? value : stableJson(value);
  const chunks = pieces(`${label}: ${text}`);
  chunks.forEach((chunk, index) => target.push(index === 0 ? chunk : `[continued] ${chunk}`));
}
export function blocks(heading: string, lines: string[]): HandymanDocumentTermsBlock[] {
  const out: HandymanDocumentTermsBlock[] = [];
  for (let i = 0; i < lines.length; i += 60) out.push({ heading: i ? `${heading} (continued)` : heading, lines: lines.slice(i, i + 60) });
  return out;
}
async function renderQuotation(s: QuotationDocumentSource, sourceHash: string) {
  // The shared layout rounds IDR/JPY and limits numeric quantities to three
  // decimals. Print DB numeric strings as text instead, so the issued prices,
  // totals and quantities are never silently rounded by presentation.
  const lineItems: Array<{ description: string }> = [];
  s.lines.forEach((line, index) => {
    const rows: string[] = [];
    addText(rows, `${index + 1} ${line.lineType}`, line.description);
    addText(rows, 'Quantity', `${line.quantity} ${line.unit}`);
    addText(rows, 'Unit price', `${line.currency} ${line.unitAmount}`);
    addText(rows, 'Line total', `${line.currency} ${line.total}`);
    addText(rows, 'Tax price basis', taxPriceBasisLabel(line.taxPriceBasis));
    rows.forEach(description => lineItems.push({ description }));
  });
  const scope: string[] = [];
  addText(scope, 'Issuer legal name', s.issuer.legalName);
  addText(scope, 'Issuer registered address', s.issuer.registeredAddress);
  addText(scope, 'Issuer city', s.issuer.city); addText(scope, 'Issuer province', s.issuer.province);
  addText(scope, 'Issuer postal code', s.issuer.postalCode); addText(scope, 'Issuer email', s.issuer.email);
  addText(scope, 'Issuer phone', s.issuer.phone); addText(scope, 'Issuer tax ID', s.issuer.taxId);
  addText(scope, 'Request ID', s.customer.requestId);
  addText(scope, 'Tenant', s.customer.tenantName); addText(scope, 'Legal name', s.customer.legalName);
  addText(scope, 'Contact', s.customer.tenantPicName); addText(scope, 'Building', s.customer.buildingName);
  addText(scope, 'Space', s.customer.spaceName); addText(scope, 'Service', s.customer.serviceName);
  addText(scope, 'Request description', s.customer.requestDescription);
  s.requestItems.forEach((item, i) => {
    addText(scope, `Service item ${i + 1}`, item.serviceName);
    addText(scope, 'Variant', item.variantName); addText(scope, 'Quantity', `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`);
    addText(scope, 'Description', item.description); addText(scope, 'Attributes', item.attributes);
    addText(scope, 'Inherited attributes', item.inheritedAttributes); addText(scope, 'Access condition', item.accessCondition);
  });
  const summary: string[] = [];
  addText(summary, 'Offer document ID', s.issuance.id);
  addText(summary, 'Issued at UTC', s.issuance.issuedAt);
  addText(summary, 'Valid until UTC', s.quotation.validUntil);
  addText(summary, 'Labor subtotal', `${s.quotation.currency} ${s.totals.labor}`);
  addText(summary, 'Material subtotal', `${s.quotation.currency} ${s.totals.material}`);
  addText(summary, 'Quoted line total', `${s.quotation.currency} ${s.totals.total}`);
  addText(summary, 'Tax note', 'Totals exclude any applicable PPN on lines marked EXCLUSIVE. Applicability is determined separately.');
  addText(summary, 'Basis precedence', 'Per-line price basis controls over general tax terms / basis per item berlaku atas ketentuan pajak umum.');
  addText(summary, 'Down payment required', s.quotation.dpRequired ? 'YES' : 'NO');
  addText(summary, 'Down payment percentage', s.quotation.dpPercentage);
  addText(summary, 'Down payment amount', s.quotation.dpAmount === null ? null : `${s.quotation.currency} ${s.quotation.dpAmount}`);
  addText(summary, 'Down payment terms', s.quotation.dpTermsNotes);
  const payment: string[] = [];
  addText(payment, 'Bank', s.bank.bankName); addText(payment, 'Bank code', s.bank.bankCode);
  addText(payment, 'Account number', s.bank.accountNumber); addText(payment, 'Account holder', s.bank.accountHolderName);
  addText(payment, 'Currency', s.bank.currency); addText(payment, 'Payment terms', s.settings.paymentNote);
  const terms: string[] = [];
  s.settings.termsLines.forEach((line, i) => addText(terms, `Term ${i + 1}`, line));
  addText(terms, 'Warranty note', s.settings.warrantyNote); addText(terms, 'Contact note', s.settings.contactNote);
  addText(terms, 'Footer note', s.settings.footerNote); addText(terms, 'Signatory name', s.settings.signatoryName);
  addText(terms, 'Signatory title', s.settings.signatoryTitle); addText(terms, 'Source SHA-256', sourceHash);
  const allTerms = [...blocks('Customer and service scope', scope), ...blocks('Quotation totals and down payment', summary),
    ...blocks('Payment', payment), ...blocks('Terms', terms)];
  if (lineItems.length > 400 || allTerms.length > 12) throw conflict('Quotation source exceeds the complete PDF layout capacity.');
  return renderHandymanDocumentPdf({ locale: s.settings.language, utcOffsetMinutes: 0,
    document: { kind: 'QUOTATION', number: s.issuance.number, version: s.quotation.versionNumber,
      issueDate: s.issuance.issuedAt, validUntil: s.quotation.validUntil, currency: s.quotation.currency,
      reference: s.customer.requestId },
    issuer: { name: exactText(s.issuer.legalName), addressLines: [exactText(s.issuer.registeredAddress),
      exactText(`${s.issuer.city}, ${s.issuer.province} ${s.issuer.postalCode}`)],
      taxId: s.issuer.taxId ? exactText(s.issuer.taxId) : null, phone: exactText(s.issuer.phone), email: exactText(s.issuer.email) },
    recipient: { name: exactText(s.customer.tenantName) },
    property: { name: exactText(s.customer.buildingName), lines: s.customer.spaceName ? [exactText(s.customer.spaceName)] : [] },
    lineItems, terms: allTerms, status: { value: 'ISSUED' },
  }, { filename: `quotation-${s.issuance.number.toLowerCase()}.pdf` });
}

export function verifyStoredQuotationDocument(row: QuotationDocumentStored): void {
  try {
    const s = row.source_snapshot;
    if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_bytes.length !== row.pdf_size || row.pdf_size < 1 || row.pdf_size > MAX_PDF_BYTES ||
        row.pdf_bytes.subarray(0, 5).toString() !== '%PDF-' || sha(row.pdf_bytes) !== row.pdf_sha256 ||
        !/^[a-z0-9-]+\.pdf$/.test(row.pdf_filename) || stableJson(s) !== row.source_canonical || sha(row.source_canonical) !== row.source_sha256 ||
        s.schema !== 'HANDYMAN_QUOTATION_DOCUMENT_V1' || s.status !== 'ISSUED' || s.clientId !== row.client_id ||
        s.customer.requestId !== row.request_id || s.quotation.id !== row.quotation_id || s.quotation.versionId !== row.quotation_version_id ||
        s.issuance.id !== row.id || s.issuance.number !== row.document_number || s.issuance.actorUserId !== row.issued_by_user_id ||
        s.issuance.issuedAt !== row.issued_at.toISOString() || s.issuer.profileId !== row.issuer_profile_id ||
        s.bank.versionRowId !== row.bank_version_id || s.settings.settingsId !== row.settings_id || !s.lines.length ||
        (s.priceBasisProtocol !== undefined && (s.priceBasisProtocol !== QUOTATION_PRICE_BASIS_PROTOCOL ||
          s.lines.some(line => !(HANDYMAN_TAX_PRICE_BASES as readonly string[]).includes(line.taxPriceBasis ?? '')) ||
          new Set(s.lines.map(line => line.id)).size !== s.lines.length))) throw integrity();
  } catch { throw integrity(); }
}
export type QuotationDecisionOffer = { id: string; sourceSha256: string; pdfSha256: string };

/** Legacy documents deliberately return no binding; they are never upgraded. */
export async function findQuotationDecisionOffer(tx: Pick<PoolClient, 'query'>, versionId: string): Promise<QuotationDecisionOffer | null> {
  const row = (await tx.query<QuotationDocumentStored>(
    'SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [versionId])).rows[0];
  if (!row) return null;
  verifyStoredQuotationDocument(row);
  return row.source_snapshot.priceBasisProtocol === QUOTATION_PRICE_BASIS_PROTOCOL
    ? { id: row.id, sourceSha256: row.source_sha256, pdfSha256: row.pdf_sha256 } : null;
}

function asDownload(row: QuotationDocumentStored) {
  verifyStoredQuotationDocument(row);
  return { id: row.id, filename: row.pdf_filename, fileSize: row.pdf_size, pdfChecksum: row.pdf_sha256,
    sourceChecksum: row.source_sha256, bytes: row.pdf_bytes };
}

/** Local Operations or locally assigned Building Care; never a pricing command. */
export async function downloadQuotationDocument(actorInput: string, versionInput: string) {
  const actor = uuid(actorInput, 'actorUserId'), versionId = uuid(versionInput, 'quotationVersionId');
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const context = (await tx.query<{ client_id: string; request_id: string; building_id: string; tenant_company_id: string; user_status: string; is_pic: boolean }>(`
      SELECT q.client_id,q.handyman_request_id AS request_id,r.building_id,r.tenant_company_id,u.status AS user_status,
        EXISTS (SELECT 1 FROM tenant_pics tp WHERE tp.id=r.tenant_pic_id AND tp.user_id=u.id) AS is_pic
      FROM handyman_quotation_versions v JOIN handyman_quotations q ON q.id=v.quotation_id
      JOIN handyman_service_requests r ON r.id=q.handyman_request_id AND r.client_id=q.client_id
      JOIN users u ON u.id=$2 WHERE v.id=$1 AND v.status<>'DRAFT'`, [versionId, actor])).rows[0];
    if (!context) throw notFound();
    const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
    if (context.user_status !== 'ACTIVE') throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Active user required.' });
    if (context.is_pic && permissions.includes('tenant_company.manage')) {
      await assertBuildingScopedResourceAccess(actor, { clientId: context.client_id, buildingId: context.building_id }, tx);
      await assertHandymanTenantDecisionActor(tx, { actorUserId: actor, handymanRequestId: context.request_id,
        clientId: context.client_id, tenantCompanyId: context.tenant_company_id, buildingId: context.building_id });
    } else if (permissions.includes('handyman.commercial.manage')) {
      await assertBuildingScopedResourceAccess(actor, { clientId: context.client_id, buildingId: context.building_id }, tx);
      await assertHandymanQuotationPricingAuthority({ clientId: context.client_id, handymanRequestId: context.request_id, actorUserId: actor }, tx);
    } else if (permissions.includes('handyman.care.building')) {
      const buildings = await resolveBuildingsForUser(actor, tx);
      if (!buildings.some(b => b.client?.id === context.client_id && b.building.id === context.building_id)) throw notFound();
    } else throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Quotation document requires the request Tenant PIC, Operations or Building Care authority.' });
    const row = (await tx.query<QuotationDocumentStored>(`SELECT * FROM handyman_quotation_documents
      WHERE quotation_version_id=$1 AND client_id=$2 AND request_id=$3`, [versionId, context.client_id, context.request_id])).rows[0];
    if (!row) throw notFound();
    return asDownload(row);
  });
}

/** Care workspace credential + current property grant + exact represented occupancy,
 * request and version are checked in the same statement as the immutable read. */
export async function downloadQuotationDocumentForCare(token: string, requestInput: unknown, versionInput: unknown, query: unknown) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const selection = parseCareHandymanPaymentProofSelection(query);
  const requestId = uuid(requestInput, 'requestId'), versionId = uuid(versionInput, 'quotationVersionId');
  const result = await getPool().query<QuotationDocumentStored & { authenticated: boolean }>(`${WORKSPACE_OCCUPANCY_CTES}
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,d.* FROM (SELECT 1) singleton
    LEFT JOIN LATERAL (
      SELECT doc.* FROM handyman_service_requests r
      JOIN records c ON c."clientId"=r.client_id AND c."tenantCompanyId"=r.tenant_company_id
        AND c."buildingId"=r.building_id AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      JOIN handyman_quotations q ON q.handyman_request_id=r.id AND q.client_id=r.client_id
      JOIN handyman_quotation_versions v ON v.quotation_id=q.id AND v.status<>'DRAFT'
      JOIN handyman_quotation_documents doc ON doc.quotation_version_id=v.id AND doc.quotation_id=q.id
        AND doc.request_id=r.id AND doc.client_id=r.client_id
      WHERE $5::text IS NULL AND $6::integer=1 AND r.id=$10 AND v.id=$11
        AND r.tenant_company_id=$7 AND r.building_id=$8 AND r.space_id IS NOT DISTINCT FROM $9::uuid
      LIMIT 1
    ) d ON TRUE`, [principal.sessionId, principal.careActorId, principal.integrationId, selection.propertyId,
    null, 1, selection.tenantCompanyId, selection.buildingId, selection.spaceId, requestId, versionId]);
  const row = result.rows[0];
  if (!row?.authenticated) throw workspaceUnauthorized();
  if (!row.id) throw new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    statusCode: 404, message: 'Care workspace resource not found.' });
  return asDownload(row);
}
