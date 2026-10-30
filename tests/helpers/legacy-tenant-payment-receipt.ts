/** Frozen pre-0532 implementation used only to create genuine legacy artifacts
 * before the numbering migration in its PostgreSQL upgrade test. Do not use in application code. */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../src/database';
import { AppError, ERROR_CODES } from '../../src/shared/errors';
import { stableJson } from '../../src/shared/stable-json';
import { isValidUuid } from '../../src/modules/clients';
import { assertBuildingScopedResourceAccess } from '../../src/modules/context-access';
import { resolveHandymanDocumentIssuerSnapshot } from '../../src/modules/handyman-documents/handyman-document-issuer.service';
import { permissionRepository } from '../../src/modules/permissions';
import { renderReportingPdf, type PdfRenderSnapshot } from '../../src/modules/reporting-export/pdf-renderer';
import type { ReportingExportRow, ReportingExportTable } from '../../src/modules/reporting-export/reporting-export.types';

type Scope = { executionScopeId: string; paymentId: string };
type ScopeRow = { id: string; client_id: string; building_id: string; as_of: Date };
type PaymentRow = { id: string; client_id: string; transaction_id: string; status: string; amount: string; currency: string;
  channel: string; obligation_stage: string; provider_name: string | null; provider_reference: string | null;
  external_reference: string | null; received_at: Date; recorded_by_user_id: string; decided_at: Date | null;
  decided_by_user_id: string | null; recorded_at_exact: string; decided_at_exact: string | null; quotation_version_id: string; request_id: string; tenant_company_id: string;
  space_id: string | null; tenant_name: string; legal_name: string | null; building_name: string; building_code: string;
  invoice_id: string | null; invoice_number: string | null; invoice_status: string | null };
type PaymentEvent = { id: string; event_type: string; actor_user_id: string; occurred_at_exact: string };
type Reconciliation = { id: string; bank_reference: string; actual_received_at_exact: string; verified_by_user_id: string; verified_at_exact: string };
type Allocation = { id: string; charge_line_id: string; line_kind: string; currency: string; amount: string;
  allocated_by_user_id: string; occurred_at_exact: string };
type Correction = { id: string; correction_kind: string; source_kind: string; source_payment_id: string | null;
  source_allocation_id: string | null; currency: string; amount: string; corrected_by_user_id: string; occurred_at_exact: string };
type ReceiptSource = {
  schema: 'HANDYMAN_TENANT_PAYMENT_RECEIPT_V1'; status: 'ISSUED'; clientId: string; asOf: string;
  issuance: { id: string; issuedByUserId: string; issuedAt: string };
  issuer: Awaited<ReturnType<typeof resolveHandymanDocumentIssuerSnapshot>>;
  building: { id: string; code: string; name: string };
  payer: { tenantCompanyId: string; tenantName: string; legalName: string | null; basis: 'EXECUTION_SCOPE_CUSTOMER'; remitterIdentity: 'NOT_VERIFIED' };
  reference: { requestId: string; executionScopeId: string; transactionId: string; quotationVersionId: string; spaceId: string | null;
    invoice: { id: string; number: string; status: string } | null };
  payment: { id: string; amount: string; currency: string; channel: string; obligationStage: string; recordedAt: string;
    recordedByUserId: string; recordEventId: string; recordEventOccurredAt: string; providerName: string | null; providerReference: string | null; externalReference: string | null };
  verification: { confirmationEventId: string; confirmationEventOccurredAt: string; confirmedByUserId: string; confirmedAt: string; basis: 'INDEPENDENT_CONFIRMATION' | 'INDEPENDENT_RECONCILIATION';
    reconciliation: { id: string; bankReference: string; actualReceivedAt: string; verifiedByUserId: string; verifiedAt: string } | null };
  allocations: Array<{ id: string; chargeLineId: string; lineKind: string; currency: string; amount: string; allocatedByUserId: string; occurredAt: string }>;
  corrections: Array<{ id: string; kind: string; sourceKind: string; sourceId: string; currency: string; amount: string; correctedByUserId: string; occurredAt: string }>;
};
type Stored = { id: string; client_id: string; building_id: string; tenant_company_id: string; request_id: string;
  execution_scope_id: string; transaction_id: string; payment_id: string; record_event_id: string; confirmation_event_id: string;
  issuer_profile_id: string; issued_by_user_id: string;
  issued_at: Date; source_as_of: Date; source_snapshot: ReceiptSource; source_canonical: string; source_sha256: string;
  pdf_filename: string; pdf_bytes: Buffer; pdf_size: number; pdf_sha256: string };

const MAX_SOURCES = 500, MAX_PDF_BYTES = 10 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const iso = (value: Date) => value.toISOString();
const conflict = (message: string) => new AppError({ code: ERROR_CODES.HANDYMAN_TENANT_RECEIPT_CONFLICT, statusCode: 409, message });
const integrity = () => new AppError({ code: ERROR_CODES.HANDYMAN_TENANT_RECEIPT_INTEGRITY_ERROR, statusCode: 409,
  message: 'Receipt or its pinned source failed integrity verification.' });
const notFound = () => new AppError({ code: ERROR_CODES.HANDYMAN_TENANT_RECEIPT_NOT_FOUND, statusCode: 404,
  message: 'Issued payment receipt not found.' });
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-', ''))) {
    throw AppError.validation(`Invalid ${field}.`);
  }
  return value.toLowerCase();
}
function inputScope(input: Scope): Scope {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['executionScopeId', 'paymentId'].includes(k))) throw AppError.validation('Unexpected receipt request fields.');
  return { executionScopeId: uuid(input.executionScopeId, 'executionScopeId'), paymentId: uuid(input.paymentId, 'paymentId') };
}
async function scopeAndPermissions(tx: PoolClient, actor: string, executionScopeId: string) {
  // This first MVCC read also timestamps the exact repeatable-read source view.
  const scope = (await tx.query<ScopeRow>(`SELECT s.id,s.client_id,s.building_id,clock_timestamp() AS as_of
    FROM handyman_execution_scopes s WHERE s.id=$1`, [executionScopeId])).rows[0];
  if (!scope) throw AppError.notFound();
  const user = (await tx.query<{ status: string }>('SELECT status FROM users WHERE id=$1', [actor])).rows[0];
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
  if (user?.status !== 'ACTIVE') throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Active user authority is required.' });
  return { scope, permissions };
}
async function financeAuthority(tx: PoolClient, actor: string, scope: ScopeRow, permissions: string[], required: string) {
  if (!permissions.includes(required)) throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403,
    message: `Explicit ${required} authority is required.` });
  await assertBuildingScopedResourceAccess(actor, { clientId: scope.client_id, buildingId: scope.building_id }, tx);
}
async function requireDurablePrimary(tx: PoolClient): Promise<void> {
  const row = (await tx.query<{ fsync: string; full_page_writes: string; sync_commit: string; replica: boolean }>(`SELECT
    current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_page_writes,
    current_setting('synchronous_commit') AS sync_commit, pg_is_in_recovery() AS replica`)).rows[0];
  if (row?.fsync !== 'on' || row.full_page_writes !== 'on' || row.sync_commit !== 'on' || row.replica) {
    throw new AppError({ code: ERROR_CODES.HANDYMAN_TENANT_RECEIPT_DURABILITY_UNAVAILABLE, statusCode: 503,
      message: 'Durable primary PostgreSQL storage with fsync, full_page_writes and synchronous commit is required for receipt issuance.' });
  }
}
function metadata(row: Stored) {
  return { id: row.id, status: 'ISSUED' as const, paymentId: row.payment_id, executionScopeId: row.execution_scope_id,
    clientId: row.client_id, buildingId: row.building_id, issuedAt: iso(row.issued_at), sourceAsOf: iso(row.source_as_of),
    sourceChecksum: row.source_sha256, pdfChecksum: row.pdf_sha256, filename: row.pdf_filename, fileSize: row.pdf_size };
}
export type TenantPaymentReceiptStored = Stored;
export function verifyStoredTenantPaymentReceipt(row: Stored): void {
  const s = row.source_snapshot;
  if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_bytes.length !== row.pdf_size || row.pdf_bytes.length > MAX_PDF_BYTES ||
      row.pdf_bytes.subarray(0, 5).toString() !== '%PDF-' || digest(row.pdf_bytes) !== row.pdf_sha256 ||
      stableJson(s) !== row.source_canonical || digest(row.source_canonical) !== row.source_sha256 ||
      s?.schema !== 'HANDYMAN_TENANT_PAYMENT_RECEIPT_V1' || s.status !== 'ISSUED' || s.clientId !== row.client_id ||
      s.building.id !== row.building_id || s.payer.tenantCompanyId !== row.tenant_company_id || s.reference.requestId !== row.request_id ||
      s.reference.executionScopeId !== row.execution_scope_id || s.reference.transactionId !== row.transaction_id ||
      s.payment.id !== row.payment_id || s.issuer.profileId !== row.issuer_profile_id || s.issuance.id !== row.id ||
      s.issuance.issuedByUserId !== row.issued_by_user_id || s.issuance.issuedAt !== iso(row.issued_at) || s.asOf !== iso(row.source_as_of)) throw integrity();
}

/** Reuse the shared PDF renderer with lossless, bounded cell encoding before durable storage. */
function exactPdfText(value: string): string {
  const chars = Array.from(value);
  return chars.map((ch, i) => {
    if (ch === '\\') return '\\\\';
    if (ch === ' ' && i > 0 && i < chars.length - 1 && chars[i-1] !== ' ' && chars[i+1] !== ' ') return ch;
    const cp = ch.codePointAt(0)!;
    return cp >= 0x21 && cp <= 0x7e ? ch : `\\u{${cp.toString(16).toUpperCase()}}`;
  }).join('');
}
function add(rows: ReportingExportRow[], label: string, value: string | number | null | undefined) {
  if (value === null || value === undefined) return;
  let text = exactPdfText(String(value));
  if (/^[=+\-@]/.test(text)) text = `value: ${text}`;
  const chunks = text.match(/[\s\S]{1,48}/g) ?? [''];
  chunks.forEach((part, i) => {
    let chunk = part.replace(/^ /, '\\u{20}').replace(/ $/, '\\u{20}');
    if (/^[=+\-@]/.test(chunk)) chunk = `value: ${chunk}`;
    rows.push({ field: chunks.length === 1 ? label : `${label} (${i+1}/${chunks.length})`, value: chunk });
  });
}
function table(key: string, label: string, rows: ReportingExportRow[]): ReportingExportTable {
  return { key, label, columns: [{ key: 'field', label: 'Field', type: 'STRING' }, { key: 'value', label: 'Value', type: 'STRING' }],
    rows, rowCount: rows.length };
}
async function renderReceipt(s: ReceiptSource, sourceChecksum: string) {
  const identity: ReportingExportRow[] = [], payment: ReportingExportRow[] = [], allocations: ReportingExportRow[] = [];
  add(identity, 'Status', 'ISSUED - immutable Payment Receipt'); add(identity, 'Receipt ID', s.issuance.id);
  add(identity, 'Issued at UTC', s.issuance.issuedAt); add(identity, 'Source as of UTC', s.asOf);
  add(identity, 'Issuer legal name', s.issuer.legalName); add(identity, 'Issuer address', s.issuer.registeredAddress);
  add(identity, 'Issuer city', `${s.issuer.city}, ${s.issuer.province} ${s.issuer.postalCode}`);
  add(identity, 'Issuer profile ID', s.issuer.profileId); add(identity, 'Issuer profile version', s.issuer.version);
  add(identity, 'Issuer profile SHA-256', s.issuer.payloadChecksum); add(identity, 'Source snapshot SHA-256', sourceChecksum);
  add(identity, 'Payer account - tenant name', s.payer.tenantName); add(identity, 'Tenant legal name', s.payer.legalName);
  add(identity, 'Payer account tenant ID', s.payer.tenantCompanyId);
  add(identity, 'Payer identity basis', 'Tenant customer bound to execution scope; actual remitting account identity is not independently verified.');
  add(identity, 'Building', s.building.name); add(identity, 'Building ID', s.building.id);
  add(identity, 'Request ID', s.reference.requestId); add(identity, 'Execution scope ID', s.reference.executionScopeId);
  add(identity, 'Invoice reference', s.reference.invoice ? `${s.reference.invoice.number} (${s.reference.invoice.status})` : 'Not available at issuance');
  if (s.reference.invoice) add(identity, 'Invoice ID', s.reference.invoice.id);
  add(identity, 'Text encoding', 'Non-ASCII and repeated or edge spaces use \\u{HEX}; backslashes doubled.');
  add(payment, 'Verified incoming payment', `${s.payment.currency} ${s.payment.amount}`);
  add(payment, 'Payment ID', s.payment.id); add(payment, 'Obligation stage code', s.payment.obligationStage);
  add(payment, 'Payment channel', s.payment.channel); add(payment, 'Payment recorded at UTC', s.payment.recordedAt);
  add(payment, 'Confirmation event ID', s.verification.confirmationEventId);
  add(payment, 'Confirmed by user ID', s.verification.confirmedByUserId); add(payment, 'Confirmed at UTC', s.verification.confirmedAt);
  add(payment, 'Independent verification basis', s.verification.basis);
  if (s.verification.reconciliation) {
    add(payment, 'Reconciliation ID', s.verification.reconciliation.id);
    add(payment, 'Actual receipt UTC - reconciled', s.verification.reconciliation.actualReceivedAt);
    add(payment, 'Reconciled by user ID', s.verification.reconciliation.verifiedByUserId);
  }
  add(payment, 'Receipt scope', 'This acknowledges one original incoming payment only; it does not certify any invoice is fully paid.');
  add(payment, 'Stage caveat', 'DP, TERMIN or PELUNASAN is the recorded payment stage, not proof of invoice settlement.');
  add(payment, 'History caveat', 'Allocation and correction facts are as of issuance; later governed facts do not change this receipt.');
  add(allocations, 'Allocations at issuance', s.allocations.length);
  for (const [index, item] of s.allocations.entries()) {
    const label = `Allocation ${index + 1}`;
    add(allocations, `${label} ID`, item.id); add(allocations, `${label} charge line ID`, item.chargeLineId);
    add(allocations, `${label} kind and amount`, `${item.lineKind} / ${item.currency} ${item.amount}`);
  }
  add(allocations, 'Separate corrections at issuance', s.corrections.length);
  for (const [index, item] of s.corrections.entries()) {
    const label = `Correction ${index + 1}`;
    add(allocations, `${label} ID`, item.id); add(allocations, `${label} kind`, `${item.kind} / ${item.sourceKind}`);
    add(allocations, `${label} source ID`, item.sourceId); add(allocations, `${label} amount`, `${item.currency} ${item.amount}`);
  }
  const date = s.issuance.issuedAt.slice(0, 10);
  const input: PdfRenderSnapshot = { metadata: { dataset: 'HANDYMAN_TENANT_PAYMENT_RECEIPT',
    datasetLabel: 'ISSUED - Tenant Payment Receipt', buildingId: s.building.id, buildingScope: [s.building.id],
    period: { dateFrom: date, dateTo: date }, filters: {}, asOf: s.asOf }, generatedAt: s.issuance.issuedAt, kpis: [],
    tables: [table('identity', 'Issuer, payer account and references', identity), table('payment', 'Verified incoming payment', payment),
      table('allocations', 'Allocation and correction facts at issuance', allocations)] };
  return renderReportingPdf(input, { filename: `payment-receipt-${s.issuance.id}.pdf` });
}

async function readSource(tx: PoolClient, scope: ScopeRow, input: Scope, actor: string): Promise<ReceiptSource> {
  // Allocation/correction writers use the same ledger row lock; the repeatable-read
  // view remains the as-of snapshot even if a concurrent writer commits while waiting.
  const anchor = (await tx.query<{ id: string }>('SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE',
    [input.executionScopeId])).rows[0];
  if (!anchor) throw conflict('No posted customer financial transaction exists for this execution scope.');
  const p = (await tx.query<PaymentRow>(`SELECT p.*,
    to_char(p.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at_exact,
    to_char(p.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at_exact,
    t.quotation_version_id, s.handyman_request_id AS request_id,
    s.tenant_company_id,s.space_id,tc.tenant_name,tc.legal_name,b.name AS building_name,b.code AS building_code,
    COALESCE(oi.id,i.id) AS invoice_id, COALESCE(oi.document_number,i.invoice_number) AS invoice_number,
    CASE WHEN oi.id IS NOT NULL THEN 'ISSUED' ELSE i.status END AS invoice_status
    FROM handyman_customer_payments p JOIN handyman_customer_transactions t ON t.id=p.transaction_id AND t.client_id=p.client_id
    JOIN handyman_execution_scopes s ON s.id=t.execution_scope_id AND s.client_id=t.client_id
    JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id AND r.building_id=s.building_id
      AND r.tenant_company_id=s.tenant_company_id AND r.space_id IS NOT DISTINCT FROM s.space_id
    JOIN tenant_companies tc ON tc.id=s.tenant_company_id AND tc.client_id=s.client_id
    JOIN buildings b ON b.id=s.building_id JOIN properties prop ON prop.id=b.property_id AND prop.client_id=s.client_id
    LEFT JOIN tenant_invoices i ON i.handyman_execution_scope_id=s.id AND i.client_id=s.client_id
      AND i.tenant_company_id=s.tenant_company_id AND i.building_id=s.building_id
      AND i.space_id IS NOT DISTINCT FROM s.space_id AND i.currency_code=t.currency
    LEFT JOIN handyman_official_invoice_payment_links link ON link.payment_id=p.id
    LEFT JOIN handyman_official_invoices oi ON oi.id=link.invoice_id AND oi.execution_scope_id=s.id
      AND oi.transaction_id=t.id AND oi.client_id=s.client_id AND oi.request_id=s.handyman_request_id
      AND oi.tenant_company_id=s.tenant_company_id AND oi.building_id=s.building_id AND oi.currency=t.currency
    WHERE p.id=$1 AND t.id=$2 AND s.id=$3 AND s.client_id=$4 AND s.building_id=$5`,
  [input.paymentId, anchor.id, input.executionScopeId, scope.client_id, scope.building_id])).rows[0];
  if (!p) throw AppError.notFound('Payment not found in this execution scope.');
  if (p.status !== 'CONFIRMED' || !p.decided_by_user_id || !p.decided_at || !p.decided_at_exact) {
    throw conflict('Only a confirmed incoming payment with an independent verification may be receipted.');
  }
  const events = (await tx.query<PaymentEvent>(`SELECT id,event_type,actor_user_id,
    to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_exact FROM handyman_customer_payment_events
    WHERE payment_id=$1 AND client_id=$2 AND transaction_id=$3 AND event_type IN ('RECORD_PAYMENT','CONFIRM_PAYMENT')
    ORDER BY occurred_at,id`, [p.id, p.client_id, p.transaction_id])).rows;
  const recorded = events.filter(e => e.event_type === 'RECORD_PAYMENT'), confirmed = events.filter(e => e.event_type === 'CONFIRM_PAYMENT');
  if (recorded.length !== 1 || confirmed.length !== 1 || recorded[0]!.actor_user_id !== p.recorded_by_user_id ||
      confirmed[0]!.actor_user_id !== p.decided_by_user_id) throw conflict('Payment verification event provenance is missing or ambiguous.');
  const reconciliation = (await tx.query<Reconciliation>(`SELECT id,bank_reference,verified_by_user_id,
    to_char(actual_received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS actual_received_at_exact,
    to_char(verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS verified_at_exact
    FROM handyman_payment_reconciliations WHERE payment_id=$1 AND client_id=$2`, [p.id, p.client_id])).rows[0] ?? null;
  const independentConfirmation = p.decided_by_user_id !== p.recorded_by_user_id;
  if (!independentConfirmation && (!reconciliation || reconciliation.verified_by_user_id === p.recorded_by_user_id)) {
    throw conflict('The payment has no verification independent of the original reporter.');
  }
  const allocations = (await tx.query<Allocation>(`SELECT id,charge_line_id,line_kind,currency,amount,allocated_by_user_id,
    to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_exact
    FROM handyman_payment_allocations WHERE payment_id=$1 ORDER BY occurred_at,id LIMIT $2`, [p.id, MAX_SOURCES + 1])).rows;
  const corrections = (await tx.query<Correction>(`SELECT c.id,c.correction_kind,c.source_kind,c.source_payment_id,c.source_allocation_id,
    c.currency,c.amount,c.corrected_by_user_id,
    to_char(c.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_exact FROM handyman_ledger_corrections c
    WHERE c.source_payment_id=$1 OR c.source_allocation_id IN (SELECT id FROM handyman_payment_allocations WHERE payment_id=$1)
    ORDER BY c.occurred_at,c.id LIMIT $2`, [p.id, MAX_SOURCES + 1])).rows;
  if (allocations.length > MAX_SOURCES || corrections.length > MAX_SOURCES) {
    throw conflict('Payment allocation or correction history exceeds the complete receipt source limit.');
  }
  const issuer = await resolveHandymanDocumentIssuerSnapshot(scope.client_id, tx);
  const issuedAt = iso((await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now);
  return { schema: 'HANDYMAN_TENANT_PAYMENT_RECEIPT_V1', status: 'ISSUED', clientId: scope.client_id, asOf: iso(scope.as_of),
    issuance: { id: randomUUID(), issuedByUserId: actor, issuedAt }, issuer,
    building: { id: scope.building_id, code: p.building_code, name: p.building_name },
    payer: { tenantCompanyId: p.tenant_company_id, tenantName: p.tenant_name, legalName: p.legal_name,
      basis: 'EXECUTION_SCOPE_CUSTOMER', remitterIdentity: 'NOT_VERIFIED' },
    reference: { requestId: p.request_id, executionScopeId: input.executionScopeId, transactionId: p.transaction_id,
      quotationVersionId: p.quotation_version_id, spaceId: p.space_id,
      invoice: p.invoice_id && p.invoice_number && p.invoice_status ? { id: p.invoice_id, number: p.invoice_number, status: p.invoice_status } : null },
    payment: { id: p.id, amount: p.amount, currency: p.currency, channel: p.channel, obligationStage: p.obligation_stage,
      recordedAt: p.recorded_at_exact, recordedByUserId: p.recorded_by_user_id, recordEventId: recorded[0]!.id,
      recordEventOccurredAt: recorded[0]!.occurred_at_exact,
      providerName: p.provider_name, providerReference: p.provider_reference, externalReference: p.external_reference },
    verification: { confirmationEventId: confirmed[0]!.id, confirmationEventOccurredAt: confirmed[0]!.occurred_at_exact,
      confirmedByUserId: p.decided_by_user_id, confirmedAt: p.decided_at_exact,
      basis: independentConfirmation ? 'INDEPENDENT_CONFIRMATION' : 'INDEPENDENT_RECONCILIATION',
      reconciliation: reconciliation ? { id: reconciliation.id, bankReference: reconciliation.bank_reference,
        actualReceivedAt: reconciliation.actual_received_at_exact, verifiedByUserId: reconciliation.verified_by_user_id, verifiedAt: reconciliation.verified_at_exact } : null },
    allocations: allocations.map(a => ({ id: a.id, chargeLineId: a.charge_line_id, lineKind: a.line_kind, currency: a.currency,
      amount: a.amount, allocatedByUserId: a.allocated_by_user_id, occurredAt: a.occurred_at_exact })),
    corrections: corrections.map(c => ({ id: c.id, kind: c.correction_kind, sourceKind: c.source_kind,
      sourceId: (c.source_payment_id ?? c.source_allocation_id)!, currency: c.currency, amount: c.amount,
      correctedByUserId: c.corrected_by_user_id, occurredAt: c.occurred_at_exact })) };
}

/** One payment is the idempotency key. Replays always return the first immutable artifact. */
export async function issueTenantPaymentReceipt(actorInput: string, raw: Scope) {
  const actor = uuid(actorInput, 'actorUserId'), input = inputScope(raw);
  const run = () => withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.query('SET LOCAL synchronous_commit = on');
    const { scope, permissions } = await scopeAndPermissions(tx, actor, input.executionScopeId);
    await financeAuthority(tx, actor, scope, permissions, 'handyman.finance.manage');
    const existing = (await tx.query<Stored>('SELECT * FROM handyman_tenant_payment_receipts WHERE payment_id=$1 AND execution_scope_id=$2',
      [input.paymentId, input.executionScopeId])).rows[0];
    if (existing) { verifyStoredTenantPaymentReceipt(existing); return { ...metadata(existing), replayed: true }; }
    await requireDurablePrimary(tx);
    const source = await readSource(tx, scope, input, actor), canonical = stableJson(source), sourceHash = digest(canonical);
    const pdf = await renderReceipt(source, sourceHash);
    if (pdf.fileSize !== pdf.bytes.length || pdf.fileSize < 1 || pdf.fileSize > MAX_PDF_BYTES ||
        pdf.checksum !== digest(pdf.bytes) || pdf.bytes.subarray(0, 5).toString() !== '%PDF-') {
      throw conflict('The complete PDF exceeds the durable artifact limit or failed integrity verification.');
    }
    const row = (await tx.query<Stored>(`INSERT INTO handyman_tenant_payment_receipts
      (id,client_id,building_id,tenant_company_id,request_id,execution_scope_id,transaction_id,payment_id,record_event_id,
       confirmation_event_id,issuer_profile_id,issued_by_user_id,issued_at,source_as_of,source_snapshot,source_canonical,source_sha256,
       pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text::jsonb,$15::text,$16,$17,$18,$19,$20) RETURNING *`,
    [source.issuance.id, source.clientId, source.building.id, source.payer.tenantCompanyId, source.reference.requestId,
      input.executionScopeId, source.reference.transactionId, input.paymentId, source.payment.recordEventId,
      source.verification.confirmationEventId, source.issuer.profileId, actor, source.issuance.issuedAt, source.asOf,
      canonical, sourceHash, pdf.filename, pdf.bytes, pdf.fileSize, pdf.checksum])).rows[0];
    if (!row) throw integrity(); verifyStoredTenantPaymentReceipt(row);
    return { ...metadata(row), replayed: false };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await run(); }
    catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (attempt < 2 && (pg.code === '40001' || (pg.code === '23505' && pg.constraint === 'hm_tenant_receipt_one_per_payment'))) continue;
      throw error;
    }
  }
  throw conflict('Concurrent receipt issuance could not be resolved.');
}
