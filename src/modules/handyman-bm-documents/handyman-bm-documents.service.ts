import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { stableJson } from '../../shared/stable-json';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assertMonthlyServiceReportComplete, issuedMonthlyServiceReportSource, normalizeMonthlyServiceReportInput,
  readMonthlyServiceReportSource, renderIssuedMonthlyServiceReport, type MonthlyServiceReportInput } from '../handyman-bm-report/handyman-bm-report.service';
import { issuedBmStatementSource, normalizeBmStatementInput, readBmStatementSource, renderIssuedBmStatement,
  type BmStatementCoveragePin, type BmStatementInput } from '../handyman-bm-statement/handyman-bm-statement.service';
import { permissionRepository } from '../permissions';

type Kind = 'COMMISSION_STATEMENT' | 'MONTHLY_SERVICE_REPORT';
type Scope = { clientId: string; buildingId: string };
type StatementRequest = BmStatementInput & { idempotencyKey: string };
type MonthlyRequest = MonthlyServiceReportInput & { idempotencyKey: string };
type Metadata = { id: string; status: 'ISSUED'; documentType: Kind; clientId: string; buildingId: string;
  periodFrom: string; periodTo: string; issuedAt: string; sourceAsOf: string; sourceChecksum: string;
  pdfChecksum: string; fileSize: number; filename: string };
type Stored = {
  id: string; client_id: string; building_id: string; document_type: Kind; period_from: string; period_to: string;
  issued_at: Date; source_as_of: Date; source_sha256: string; pdf_sha256: string; pdf_size: number; pdf_filename: string;
  pdf_bytes: Buffer; source_snapshot: unknown; source_canonical: string; request_intent: unknown; request_canonical: string; request_sha256: string;
};
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const conflict = (message = 'The idempotency key is already bound to a different issuance intent.') => new AppError({
  code: ERROR_CODES.HANDYMAN_BM_DOCUMENT_CONFLICT, statusCode: 409, message });
const integrity = () => new AppError({ code: ERROR_CODES.HANDYMAN_BM_DOCUMENT_INTEGRITY_ERROR, statusCode: 409,
  message: 'Issued BM document or source coverage failed integrity verification.' });
const notFound = () => new AppError({ code: ERROR_CODES.HANDYMAN_BM_DOCUMENT_NOT_FOUND, statusCode: 404,
  message: 'Issued BM document not found in this Client and Building.' });
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-', ''))) {
    throw AppError.validation(`Invalid ${field}.`);
  }
  return value.toLowerCase();
}
function key(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw AppError.validation('Invalid idempotencyKey.');
  }
  return value;
}
function scope(input: Scope): Scope {
  return { clientId: uuid(input.clientId, 'clientId'), buildingId: uuid(input.buildingId, 'buildingId') };
}
function documentKind(value: unknown): Kind {
  if (value !== 'COMMISSION_STATEMENT' && value !== 'MONTHLY_SERVICE_REPORT') throw AppError.validation('Invalid documentType.');
  return value;
}
async function authorize(tx: PoolClient, actor: string, s: Scope, kind: Kind): Promise<string> {
  // This is the transaction's first MVCC read and timestamps the frozen source view.
  const user = (await tx.query<{ status: string; as_of: Date }>('SELECT status,clock_timestamp() AS as_of FROM users WHERE id=$1', [actor])).rows[0];
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
  const required = kind === 'COMMISSION_STATEMENT' ? 'handyman.finance.read' : 'tenant_company.read';
  if (user?.status !== 'ACTIVE' || !permissions.includes('handyman.commercial.manage') || !permissions.includes(required)) {
    throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Active Manager and document-specific read authority are required.' });
  }
  await assertBuildingScopedResourceAccess(actor, s, tx);
  return user.as_of.toISOString();
}
async function requireDurableDatabase(tx: PoolClient): Promise<void> {
  const row = (await tx.query<{ fsync: string; full_page_writes: string; sync_commit: string; replica: boolean }>(`SELECT
    current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,
    current_setting('synchronous_commit') AS sync_commit,pg_is_in_recovery() AS replica`)).rows[0];
  if (row?.fsync !== 'on' || row.full_page_writes !== 'on' || row.sync_commit !== 'on' || row.replica) {
    throw new AppError({ code: ERROR_CODES.HANDYMAN_BM_DOCUMENT_DURABILITY_UNAVAILABLE, statusCode: 503,
      message: 'Durable primary PostgreSQL storage with fsync, full_page_writes and synchronous commit is required for issuance.' });
  }
}
function metadata(row: Stored): Metadata {
  return { id: row.id, status: 'ISSUED', documentType: row.document_type, clientId: row.client_id, buildingId: row.building_id,
    periodFrom: row.period_from, periodTo: row.period_to, issuedAt: row.issued_at.toISOString(), sourceAsOf: row.source_as_of.toISOString(),
    sourceChecksum: row.source_sha256, pdfChecksum: row.pdf_sha256, fileSize: row.pdf_size, filename: row.pdf_filename };
}
function verifyStored(row: Stored): void {
  if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_bytes.length !== row.pdf_size || row.pdf_bytes.subarray(0, 5).toString() !== '%PDF-' ||
      sha256(row.pdf_bytes) !== row.pdf_sha256 || stableJson(row.source_snapshot) !== row.source_canonical ||
      sha256(row.source_canonical) !== row.source_sha256 || stableJson(row.request_intent) !== row.request_canonical ||
      sha256(row.request_canonical) !== row.request_sha256) throw integrity();
  const source = row.source_snapshot as { status?: string; clientId?: string; building?: { id?: string };
    asOf?: string; issuance?: { id?: string; issuedAt?: string } };
  if (source?.status !== 'ISSUED' || source.clientId !== row.client_id || source.building?.id !== row.building_id ||
      source.issuance?.id !== row.id || source.issuance?.issuedAt !== row.issued_at.toISOString() ||
      source.asOf !== row.source_as_of.toISOString()) throw integrity();
}
async function statementCoverage(tx: PoolClient, n: BmStatementInput): Promise<BmStatementCoveragePin[]> {
  const params = [n.clientId,n.buildingId,n.counterpartyId,n.agreementVersionId];
  const raw = (await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM handyman_bm_building_coverages
    WHERE client_id=$1 AND building_id=$2 AND counterparty_id=$3 AND agreement_version_id=$4 AND cancelled_at IS NULL`, params)).rows[0]?.count;
  const rows = (await tx.query<{ id: string; verification_id: string; effective_from: Date; effective_to: Date | null }>(`
    SELECT c.id,c.verification_id,c.effective_from,c.effective_to FROM handyman_bm_building_coverages c
    JOIN handyman_bm_counterparty_verifications v ON v.id=c.verification_id AND v.counterparty_id=c.counterparty_id
    WHERE c.client_id=$1 AND c.building_id=$2 AND c.counterparty_id=$3 AND c.agreement_version_id=$4 AND c.cancelled_at IS NULL
    ORDER BY c.effective_from,c.id LIMIT 101`, params)).rows;
  if (!raw || rows.length !== raw || rows.length > 100) throw conflict('Verified BM coverage is missing or cannot be proven complete.');
  return rows.map(r => ({ id: r.id, verificationId: r.verification_id, effectiveFrom: r.effective_from.toISOString(),
    effectiveTo: r.effective_to?.toISOString() ?? null }));
}
async function assertStatementComplete(tx: PoolClient, n: BmStatementInput, source: Awaited<ReturnType<typeof readBmStatementSource>>) {
  const result = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM handyman_bm_commission_ledger l
    LEFT JOIN handyman_entitlement_facts f ON f.id=l.entitlement_id
    WHERE l.client_id=$1 AND l.building_id=$2 AND l.counterparty_id=$3 AND (f.agreement_version_id=$4 OR f.id IS NULL)
      AND l.created_at >= ($5::date::timestamp AT TIME ZONE 'UTC')
      AND l.created_at < (($6::date + 1)::timestamp AT TIME ZONE 'UTC')`,
    [n.clientId,n.buildingId,n.counterpartyId,n.agreementVersionId,n.dateFrom,n.dateTo]);
  if (result.rows[0]?.count !== source.entries.length) throw integrity();
}
function validateKeys(input: unknown, allowed: string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) {
    throw AppError.validation('Unexpected issuance request fields.');
  }
}

/** Both source read and insert run under one repeatable-read transaction; the bytea and snapshot commit together. */
async function issue(actor: string, kind: Kind, n: BmStatementInput | ReturnType<typeof normalizeMonthlyServiceReportInput>, idempotencyKey: string) {
  const sourceInput = kind === 'COMMISSION_STATEMENT' ? n : { clientId: n.clientId, buildingId: n.buildingId,
    month: (n as ReturnType<typeof normalizeMonthlyServiceReportInput>).month };
  const intent = { documentType: kind, actorUserId: actor, source: sourceInput }, intentCanonical = stableJson(intent), intentDigest = sha256(intentCanonical);
  const run = () => withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.query('SET LOCAL synchronous_commit = on');
    const asOf = await authorize(tx, actor, n, kind);
    const existing = (await tx.query<Stored>('SELECT * FROM handyman_bm_issued_documents WHERE client_id=$1 AND building_id=$2 AND idempotency_key=$3',
      [n.clientId, n.buildingId, idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_sha256 !== intentDigest || existing.request_canonical !== intentCanonical) throw conflict();
      verifyStored(existing);
      return { ...metadata(existing), replayed: true };
    }
    await requireDurableDatabase(tx);
    const issuance = { id: randomUUID(), issuedBy: actor, issuedAt: '' };
    let source: ReturnType<typeof issuedBmStatementSource> | ReturnType<typeof issuedMonthlyServiceReportSource>;
    let pdf: Awaited<ReturnType<typeof renderIssuedBmStatement>>;
    let periodFrom: string, periodTo: string, counterparty: string | null = null, agreement: string | null = null;
    if (kind === 'COMMISSION_STATEMENT') {
      const statement = n as BmStatementInput;
      if (statement.dateTo >= asOf.slice(0,10)) throw conflict('The statement period has not ended in UTC; only a preview is available.');
      const raw = await readBmStatementSource(tx, actor, statement, asOf);
      await assertStatementComplete(tx, statement, raw);
      const coverage = await statementCoverage(tx, statement);
      issuance.issuedAt = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
      source = issuedBmStatementSource(raw, issuance, coverage);
      pdf = await renderIssuedBmStatement(source, sha256(stableJson(source)));
      periodFrom = statement.dateFrom; periodTo = statement.dateTo; counterparty = statement.counterpartyId; agreement = statement.agreementVersionId;
    } else {
      const monthly = n as ReturnType<typeof normalizeMonthlyServiceReportInput>;
      if (monthly.toExclusive > asOf) throw conflict('The reporting month has not ended in UTC; only a preview is available.');
      const input = { clientId: monthly.clientId, buildingId: monthly.buildingId, month: monthly.month };
      const raw = await readMonthlyServiceReportSource(tx, actor, input, asOf);
      await assertMonthlyServiceReportComplete(tx, input, raw);
      if (!raw.coverage.length) throw conflict('No verified BM Building coverage overlaps this reporting month.');
      issuance.issuedAt = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
      source = issuedMonthlyServiceReportSource(raw, issuance);
      pdf = await renderIssuedMonthlyServiceReport(source, sha256(stableJson(source)));
      periodFrom = monthly.from.slice(0,10); periodTo = monthly.lastDay;
    }
    const canonical = stableJson(source), sourceDigest = sha256(canonical);
    if (pdf.fileSize !== pdf.bytes.length || pdf.fileSize < 1 || pdf.fileSize > MAX_PDF_BYTES ||
        pdf.checksum !== sha256(pdf.bytes) || pdf.bytes.subarray(0,5).toString() !== '%PDF-') {
      throw conflict('The complete PDF exceeds the durable artifact size limit or failed integrity verification.');
    }
    const inserted = await tx.query<Stored>(`INSERT INTO handyman_bm_issued_documents
      (id,client_id,building_id,document_type,issuer_profile_id,counterparty_id,agreement_version_id,period_from,period_to,
       issued_by,issued_at,source_as_of,idempotency_key,request_intent,request_canonical,request_sha256,
       source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text::jsonb,$14::text,$15,$16::text::jsonb,$16::text,$17,$18,$19,$20,$21) RETURNING *`,
    [issuance.id,n.clientId,n.buildingId,kind,source.issuer.profileId,counterparty,agreement,periodFrom,periodTo,
      actor,issuance.issuedAt,asOf,idempotencyKey,intentCanonical,intentDigest,canonical,sourceDigest,pdf.filename,pdf.bytes,pdf.fileSize,pdf.checksum]);
    const row = inserted.rows[0]; if (!row) throw integrity(); verifyStored(row);
    return { ...metadata(row), replayed: false };
  });
  // Repeatable-read conflicts can occur when two identical requests race; retry sees the committed immutable row.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await run(); }
    catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (attempt < 2 && (pg.code === '40001' || (pg.code === '23505' && pg.constraint === 'hm_bm_document_idempotency_unique'))) continue;
      throw error;
    }
  }
  throw conflict('Concurrent issuance could not be resolved.');
}
export async function issueBmCommissionStatement(actorInput: string, input: StatementRequest) {
  validateKeys(input, ['clientId','buildingId','counterpartyId','agreementVersionId','dateFrom','dateTo','idempotencyKey']);
  const { idempotencyKey, ...source } = input;
  return issue(uuid(actorInput,'actorUserId'), 'COMMISSION_STATEMENT', normalizeBmStatementInput(source), key(idempotencyKey));
}
export async function issueBmMonthlyServiceReport(actorInput: string, input: MonthlyRequest) {
  validateKeys(input, ['clientId','buildingId','month','idempotencyKey']);
  const { idempotencyKey, ...source } = input;
  return issue(uuid(actorInput,'actorUserId'), 'MONTHLY_SERVICE_REPORT', normalizeMonthlyServiceReportInput(source), key(idempotencyKey));
}

export async function downloadIssuedBmDocument(actorInput: string, input: Scope & { documentId: string }) {
  validateKeys(input, ['clientId','buildingId','documentId']);
  const actor = uuid(actorInput,'actorUserId'), s = scope(input), documentId = uuid(input.documentId,'documentId');
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Common wall before the scoped document lookup, then the document-specific capability.
    const user = (await tx.query<{ status: string }>('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
    const permissions = await permissionRepository.listActivePermissionCodesForUser(actor,tx);
    if (user?.status !== 'ACTIVE' || !permissions.includes('handyman.commercial.manage')) {
      throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Active Manager authority is required.' });
    }
    await assertBuildingScopedResourceAccess(actor,s,tx);
    const row = (await tx.query<Stored>('SELECT * FROM handyman_bm_issued_documents WHERE id=$1 AND client_id=$2 AND building_id=$3',
      [documentId,s.clientId,s.buildingId])).rows[0];
    if (!row) throw notFound();
    const required = row.document_type === 'COMMISSION_STATEMENT' ? 'handyman.finance.read' : 'tenant_company.read';
    if (!permissions.includes(required)) throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403,
      message: 'Document-specific read authority is required.' });
    verifyStored(row);
    return { ...metadata(row), bytes: row.pdf_bytes };
  });
}

export async function listIssuedBmDocuments(actorInput: string, input: Scope & { documentType: Kind; limit?: number; after?: string }) {
  validateKeys(input, ['clientId','buildingId','documentType','limit','after']);
  const actor = uuid(actorInput,'actorUserId'), s = scope(input), kind = documentKind(input.documentType);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw AppError.validation('limit must be between 1 and 100.');
  const after = input.after === undefined ? null : uuid(input.after,'after');
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await authorize(tx,actor,s,kind);
    let anchor: Date | null = null;
    if (after) {
      const a = (await tx.query<{ issued_at: Date }>(`SELECT issued_at FROM handyman_bm_issued_documents
        WHERE id=$1 AND client_id=$2 AND building_id=$3 AND document_type=$4`,[after,s.clientId,s.buildingId,kind])).rows[0];
      if (!a) throw AppError.validation('Invalid history cursor for this document scope.');
      anchor = a.issued_at;
    }
    const rows = (await tx.query<Stored>(`SELECT id,client_id,building_id,document_type,period_from,period_to,issued_at,source_as_of,
      source_sha256,pdf_sha256,pdf_size,pdf_filename FROM handyman_bm_issued_documents
      WHERE client_id=$1 AND building_id=$2 AND document_type=$3
        AND ($4::timestamptz IS NULL OR (issued_at,id)<($4::timestamptz,$5::uuid))
      ORDER BY issued_at DESC,id DESC LIMIT $6`,[s.clientId,s.buildingId,kind,anchor,after,limit+1])).rows;
    const page = rows.slice(0,limit);
    return { items: page.map(metadata), nextAfter: rows.length > limit ? page[page.length-1]!.id : null };
  });
}
