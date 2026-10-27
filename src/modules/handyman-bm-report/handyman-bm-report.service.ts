import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { hasVerifiedHandymanBastCustomerAcceptance } from '../handyman-bast/handyman-bast-customer-consent';
import { resolveHandymanDocumentIssuerSnapshot } from '../handyman-documents/handyman-document-issuer.service';
import { hash } from '../handyman-pph-calculation/handyman-pph-core';
import { permissionRepository } from '../permissions';
import { renderReportingPdf, type PdfRenderSnapshot } from '../reporting-export/pdf-renderer';
import type { ReportingExportRow, ReportingExportTable } from '../reporting-export/reporting-export.types';

/** A Building-wide, live preview; no report issuance or artifact is persisted. */
export type MonthlyServiceReportInput = Readonly<{
  clientId: string;
  buildingId: string;
  month: string;
}>;

// Bound every source read and the combined snapshot. Never return a partial report.
const SOURCE_LIMIT = 500;
const iso = (value: Date) => value.toISOString();

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value) ||
      /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-', ''))) {
    throw AppError.validation(`Invalid ${field}.`);
  }
  return value.toLowerCase();
}

export function normalizeMonthlyServiceReportInput(input: MonthlyServiceReportInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['clientId', 'buildingId', 'month'].includes(key))) {
    throw AppError.validation('Unexpected monthly service report request fields.');
  }
  const clientId = uuid(input.clientId, 'clientId');
  const buildingId = uuid(input.buildingId, 'buildingId');
  if (typeof input.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) ||
      input.month.startsWith('0000-') || input.month === '9999-12') {
    throw AppError.validation('month must be a supported UTC YYYY-MM.');
  }
  const from = `${input.month}-01T00:00:00.000Z`;
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const toExclusive = iso(next);
  const lastDay = iso(new Date(next.getTime() - 86400000)).slice(0, 10);
  return { clientId, buildingId, month: input.month, from, toExclusive, lastDay };
}

type RequestRow = { id: string; status: string; created_at: Date; service_catalog_id: string; category: string };
type ScopeRow = { id: string; request_id: string };
type SessionRow = { id: string; scope_id: string; status: string };
type BastRow = { id: string; scope_id: string };
type CoverageRow = { id: string; counterparty_id: string; legal_name: string; verification_id: string;
  agreement_version_id: string; effective_from: Date; effective_to: Date | null };
type EventRow = { event_id: string; parent_id: string; scope_id: string; request_id: string;
  event_type: string; occurred_at: Date; outcome: string | null };
type EventFamily = 'WORK' | 'QC' | 'BAST' | 'CLAIM' | 'REWORK';

/** Only constants appear in the SQL fragments; caller input is always parameterized. */
const EVENT_SOURCES: ReadonlyArray<{
  family: EventFamily; events: string; parents: string; parentKey: string; filter: string; outcome: string;
}> = [
  { family: 'WORK', events: 'handyman_work_session_events', parents: 'handyman_work_sessions', parentKey: 'session_id',
    filter: "e.event_type IN ('START_WORK','COMPLETE')", outcome: 'NULL::text' },
  { family: 'QC', events: 'handyman_qc_run_events', parents: 'handyman_qc_runs', parentKey: 'run_id',
    filter: "e.event_type = 'FINISH'", outcome: `CASE
      WHEN e.metadata->>'outcome' IN ('PASSED','FAILED') AND e.metadata->>'outcome' = p.status THEN p.status
      WHEN e.metadata->>'outcome' IS NULL AND p.status IN ('PASSED','FAILED') THEN p.status
      ELSE 'UNKNOWN' END` },
  { family: 'BAST', events: 'handyman_bast_events', parents: 'handyman_bast_documents', parentKey: 'bast_id',
    filter: 'TRUE', outcome: 'NULL::text' },
  { family: 'CLAIM', events: 'handyman_service_warranty_claim_events', parents: 'handyman_service_warranty_claims',
    parentKey: 'claim_id', filter: 'TRUE', outcome: 'NULL::text' },
  { family: 'REWORK', events: 'handyman_service_warranty_rework_events', parents: 'handyman_service_warranty_reworks',
    parentKey: 'rework_id', filter: 'TRUE', outcome: 'NULL::text' },
];

async function readSnapshot(actor: string, n: ReturnType<typeof normalizeMonthlyServiceReportInput>, existingTx?: PoolClient, snapshotAsOf?: string) {
  const read = async (tx: PoolClient) => {
    // First MVCC read establishes the snapshot, with a clock not earlier than it.
    const user = (await tx.query<{ status: string; as_of: Date }>(
      'SELECT status,clock_timestamp() AS as_of FROM users WHERE id=$1', [actor])).rows[0];
    const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
    if (user?.status !== 'ACTIVE' || !permissions.includes('handyman.commercial.manage') ||
        !permissions.includes('tenant_company.read')) {
      throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403,
        message: 'Manager commercial authority and tenant company read permission are required.' });
    }
    await assertBuildingScopedResourceAccess(actor, { clientId: n.clientId, buildingId: n.buildingId }, tx);
    const asOf = snapshotAsOf ?? iso(user.as_of);
    const building = (await tx.query<{ name: string; code: string }>(`SELECT b.name,b.code FROM buildings b
      JOIN properties p ON p.id=b.property_id AND p.client_id=$1 WHERE b.id=$2`, [n.clientId, n.buildingId])).rows[0];
    if (!building) throw AppError.notFound('Building not found in this Client.');
    const issuer = await resolveHandymanDocumentIssuerSnapshot(n.clientId, tx);
    const params = [n.clientId, n.buildingId, n.from, n.toExclusive, SOURCE_LIMIT + 1];
    let sourceRows = 0;
    function bounded<T>(rows: T[]): T[] {
      sourceRows += rows.length;
      if (sourceRows > SOURCE_LIMIT) {
        throw AppError.validation(`Monthly report exceeds ${SOURCE_LIMIT} source rows; no partial PDF was generated.`);
      }
      return rows;
    }

    // Coverage identifies verified parties and intervals, not who sourced a request.
    const coverageRows = bounded((await tx.query<CoverageRow>(`SELECT c.id,c.counterparty_id,p.legal_name,
      c.verification_id,c.agreement_version_id,c.effective_from,c.effective_to
      FROM handyman_bm_building_coverages c
      JOIN handyman_bm_legal_counterparties p ON p.id=c.counterparty_id AND p.client_id=c.client_id
      JOIN handyman_bm_counterparty_verifications v ON v.id=c.verification_id AND v.counterparty_id=p.id
      JOIN handyman_commercial_agreement_versions av ON av.id=c.agreement_version_id
      JOIN handyman_commercial_agreements a ON a.id=av.agreement_id AND a.client_id=c.client_id
      WHERE c.client_id=$1 AND c.building_id=$2 AND c.cancelled_at IS NULL
        AND c.effective_from < $4::timestamptz AND (c.effective_to IS NULL OR c.effective_to > $3::timestamptz)
      ORDER BY c.effective_from,c.id LIMIT $5`, params)).rows);
    const coverage = coverageRows.map(c => ({ id: c.id, counterpartyId: c.counterparty_id, legalName: c.legal_name,
      verificationId: c.verification_id, agreementVersionId: c.agreement_version_id,
      effectiveFrom: iso(c.effective_from), effectiveTo: c.effective_to ? iso(c.effective_to) : null }));

    // Creation cohort only. Do not select tenant, PIC, unit, notes, contacts or evidence.
    const requestRows = bounded((await tx.query<RequestRow>(`SELECT r.id,r.status,r.created_at,r.service_catalog_id,c.category
      FROM handyman_service_requests r JOIN service_catalog c ON c.id=r.service_catalog_id AND c.client_id=r.client_id
      WHERE r.client_id=$1 AND r.building_id=$2 AND r.created_at >= $3::timestamptz AND r.created_at < $4::timestamptz
      ORDER BY r.created_at,r.id LIMIT $5`, params)).rows);
    const scopeRows = bounded((await tx.query<ScopeRow>(`SELECT s.id,r.id AS request_id
      FROM handyman_execution_scopes s JOIN handyman_service_requests r ON r.id=s.handyman_request_id
        AND r.client_id=s.client_id AND r.building_id=s.building_id
      WHERE r.client_id=$1 AND r.building_id=$2 AND r.created_at >= $3::timestamptz AND r.created_at < $4::timestamptz
      ORDER BY s.id LIMIT $5`, params)).rows);
    const sessionRows = bounded((await tx.query<SessionRow>(`SELECT w.id,w.execution_scope_id AS scope_id,w.status
      FROM handyman_work_sessions w JOIN handyman_execution_scopes s ON s.id=w.execution_scope_id AND s.client_id=w.client_id
      JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id AND r.building_id=s.building_id
      WHERE r.client_id=$1 AND r.building_id=$2 AND r.created_at >= $3::timestamptz AND r.created_at < $4::timestamptz
        AND w.status IN ('IN_PROGRESS','PAUSED','MATERIAL_RUN') ORDER BY w.id LIMIT $5`, params)).rows);
    const bastRows = bounded((await tx.query<BastRow>(`SELECT b.id,b.execution_scope_id AS scope_id
      FROM handyman_bast_documents b JOIN handyman_execution_scopes s ON s.id=b.execution_scope_id AND s.client_id=b.client_id
      JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id AND r.building_id=s.building_id
      WHERE r.client_id=$1 AND r.building_id=$2 AND r.created_at >= $3::timestamptz AND r.created_at < $4::timestamptz
        AND b.status='ACCEPTED' ORDER BY b.id LIMIT $5`, params)).rows);

    // Activity uses the event's UTC occurrence, independently of request creation.
    const events: Array<{ family: EventFamily; type: string; id: string; parentId: string; scopeId: string;
      requestId: string; occurredAt: string; outcome: string | null }> = [];
    for (const source of EVENT_SOURCES) {
      const rows = bounded((await tx.query<EventRow>(`SELECT e.id AS event_id,p.id AS parent_id,
        s.id AS scope_id,r.id AS request_id,e.event_type,e.occurred_at,${source.outcome} AS outcome
        FROM ${source.events} e JOIN ${source.parents} p ON p.id=e.${source.parentKey} AND p.client_id=e.client_id
        JOIN handyman_execution_scopes s ON s.id=p.execution_scope_id AND s.client_id=p.client_id
        JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id AND r.building_id=s.building_id
        WHERE s.client_id=$1 AND s.building_id=$2 AND e.occurred_at >= $3::timestamptz AND e.occurred_at < $4::timestamptz
          AND ${source.filter} ORDER BY e.occurred_at,e.id LIMIT $5`, params)).rows);
      events.push(...rows.map(e => ({ family: source.family, type: e.event_type, id: e.event_id, parentId: e.parent_id,
        scopeId: e.scope_id, requestId: e.request_id, occurredAt: iso(e.occurred_at), outcome: e.outcome })));
    }
    const bastIds = [...new Set([...bastRows.map(b => b.id),
      ...events.filter(e => e.family === 'BAST' && e.type === 'ACCEPT').map(e => e.parentId)])].sort();
    const verified = new Map<string, boolean>();
    for (const id of bastIds) verified.set(id, await hasVerifiedHandymanBastCustomerAcceptance(tx, id));
    const scopes = scopeRows.map(s => ({ id: s.id, requestId: s.request_id }));
    const activeSessions = sessionRows.map(s => ({ id: s.id, scopeId: s.scope_id, status: s.status }));
    const basts = bastRows.map(b => ({ id: b.id, scopeId: b.scope_id, verified: verified.get(b.id) === true }));
    const activeScopeIds = new Set(activeSessions.map(s => s.scopeId));
    const acceptedScopeIds = new Set(basts.filter(b => b.verified).map(b => b.scopeId));
    const requests = requestRows.map(r => {
      const ownScopes = scopes.filter(s => s.requestId === r.id);
      // Exclusive precedence, deliberately a conservative proxy, not an authoritative request lifecycle.
      const bucket = r.status === 'CANCELLED' ? 'CANCELLED' :
        ownScopes.some(s => activeScopeIds.has(s.id)) ? 'ONGOING_PROXY' :
        ownScopes.length > 0 && ownScopes.every(s => acceptedScopeIds.has(s.id)) ? 'ACCEPTED_ALL_SCOPES_PROXY' : 'UNCLASSIFIED';
      return { id: r.id, createdAt: iso(r.created_at), status: r.status, serviceCatalogId: r.service_catalog_id,
        category: r.category, bucket };
    });
    const categories = [...new Set(requests.map(r => r.category))].sort().map(category => ({ category,
      count: requests.filter(r => r.category === category).length }));
    const countRequests = (bucket: string) => requests.filter(r => r.bucket === bucket).length;
    const countEvents = (family: EventFamily, type: string, byScope = false) => new Set(events
      .filter(e => e.family === family && e.type === type).map(e => byScope ? e.scopeId : e.parentId)).size;
    const qcRuns = new Map<string, Set<string>>();
    for (const e of events.filter(e => e.family === 'QC')) {
      const outcomes = qcRuns.get(e.parentId) ?? new Set<string>();
      outcomes.add(e.outcome ?? 'UNKNOWN'); qcRuns.set(e.parentId, outcomes);
    }
    const qcOutcomeCount = (outcome: string) => [...qcRuns.values()].filter(outcomes =>
      outcome === 'UNKNOWN' ? outcomes.size !== 1 || outcomes.has('UNKNOWN') : outcomes.size === 1 && outcomes.has(outcome)).length;
    const activity = {
      work: { startedScopes: countEvents('WORK', 'START_WORK', true), completedSessionScopes: countEvents('WORK', 'COMPLETE', true) },
      qc: { finishedRuns: qcRuns.size, passed: qcOutcomeCount('PASSED'), failed: qcOutcomeCount('FAILED'), unknown: qcOutcomeCount('UNKNOWN') },
      bast: Object.fromEntries(['PREPARE','ISSUE','ACCEPT','REJECT','VOID'].map(type => [type, countEvents('BAST', type)])),
      verifiedBastAcceptances: new Set(events.filter(e => e.family === 'BAST' && e.type === 'ACCEPT' && verified.get(e.parentId))
        .map(e => e.parentId)).size,
      claims: Object.fromEntries(['OPEN','SUBMIT','APPROVE','REJECT','WITHDRAW'].map(type => [type, countEvents('CLAIM', type)])),
      reworks: Object.fromEntries(['PROPOSE','ACCEPT','START','COMPLETE','VERIFY'].map(type => [type, countEvents('REWORK', type)])),
    };
    return {
      status: 'DRAFT_PREVIEW' as const, asOf, clientId: n.clientId,
      period: { month: n.month, from: n.from, toExclusive: n.toExclusive, lastDay: n.lastDay, timezone: 'UTC' as const },
      issuer: { profileId: issuer.profileId, version: issuer.version, payloadChecksum: issuer.payloadChecksum,
        legalName: issuer.legalName, registeredAddress: issuer.registeredAddress, city: issuer.city, province: issuer.province,
        postalCode: issuer.postalCode, email: issuer.email, phone: issuer.phone },
      building: { id: n.buildingId, name: building.name, code: building.code }, coverage,
      totals: { requests: requests.length, cancelled: countRequests('CANCELLED'), ongoingProxy: countRequests('ONGOING_PROXY'),
        acceptedAllScopesProxy: countRequests('ACCEPTED_ALL_SCOPES_PROXY'), unclassified: countRequests('UNCLASSIFIED') },
      categories, activity, requests, scopes, activeSessions, basts,
      verifiedMonthlyBastIds: bastIds.filter(id => verified.get(id) && events.some(e => e.family === 'BAST' && e.type === 'ACCEPT' && e.parentId === id)),
      events,
    };
  };
  if (existingTx) return read(existingTx);
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return read(tx);
  });
}

export async function readMonthlyServiceReportSource(tx: PoolClient, actorInput: string, input: MonthlyServiceReportInput, snapshotAsOf: string) {
  return readSnapshot(uuid(actorInput, 'actorUserId'), normalizeMonthlyServiceReportInput(input), tx, snapshotAsOf);
}

type MonthlySource = Awaited<ReturnType<typeof readSnapshot>>;
type Issuance = { id: string; issuedAt: string; issuedBy: string };
/** Official reports exclude unsupported request-lifecycle proxy metrics. */
export function issuedMonthlyServiceReportSource(s: MonthlySource, issuance: Issuance) {
  return { ...s, schema: 'HANDYMAN_BM_MONTHLY_SERVICE_REPORT_ISSUED_V1' as const, status: 'ISSUED' as const, issuance,
    totals: { requests: s.totals.requests, cancelled: s.totals.cancelled },
    requests: s.requests.map(({ bucket: _bucket, ...request }) => request) };
}
type IssuedMonthlySource = ReturnType<typeof issuedMonthlyServiceReportSource>;

/** Match BM-04's lossless encoding/chunking around the shared renderer's cell limits. */
function exactPdfText(value: string): string {
  const chars = Array.from(value);
  return chars.map((ch, i) => {
    if (ch === '\\') return '\\\\';
    if (ch === ' ' && i > 0 && i < chars.length - 1 && chars[i-1] !== ' ' && chars[i+1] !== ' ') return ch;
    const cp = ch.codePointAt(0)!;
    return cp >= 0x21 && cp <= 0x7e ? ch : `\\u{${cp.toString(16).toUpperCase()}}`;
  }).join('');
}
function add(rows: ReportingExportRow[], label: string, value: string | number | null | undefined): void {
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
function table(key: string, label: string, rows: ReportingExportRow[], issued: boolean): ReportingExportTable {
  return { key, label: `${issued ? 'ISSUED' : 'DRAFT/PREVIEW'} - ${label}`, columns: [
    { key: 'field', label: 'Field', type: 'STRING' }, { key: 'value', label: 'Value', type: 'STRING' },
  ], rows, rowCount: rows.length };
}
function renderInput(s: MonthlySource | IssuedMonthlySource, checksum: string): PdfRenderSnapshot {
  const identity: ReportingExportRow[] = [], summary: ReportingExportRow[] = [], activity: ReportingExportRow[] = [],
    categories: ReportingExportRow[] = [], references: ReportingExportRow[] = [];
  const issued = s.status === 'ISSUED';
  add(identity, 'Status', issued ? 'ISSUED - immutable stored document' : 'DRAFT/PREVIEW - this preview is not issued or stored');
  if (s.status === 'ISSUED') { add(identity, 'Issuance ID', s.issuance.id); add(identity, 'Issued at UTC', s.issuance.issuedAt); }
  add(identity, 'Reporting month UTC', s.period.month);
  add(identity, 'Period start inclusive UTC', s.period.from); add(identity, 'Period end exclusive UTC', s.period.toExclusive);
  add(identity, 'Generated as of UTC', s.asOf);
  add(identity, 'Issuer current legal name', s.issuer.legalName); add(identity, 'Issuer registered address', s.issuer.registeredAddress);
  add(identity, 'Issuer city and province', `${s.issuer.city}, ${s.issuer.province} ${s.issuer.postalCode}`);
  add(identity, 'Issuer email', s.issuer.email); add(identity, 'Issuer phone', s.issuer.phone);
  add(identity, 'Issuer profile ID and version', `${s.issuer.profileId} / ${s.issuer.version}`);
  add(identity, 'Issuer profile SHA-256', s.issuer.payloadChecksum);
  add(identity, 'Client ID', s.clientId); add(identity, 'Building', s.building.name);
  add(identity, 'Building code', s.building.code); add(identity, 'Building ID', s.building.id);
  add(identity, 'Source snapshot SHA-256', checksum);
  add(identity, 'Text encoding', 'Non-ASCII and repeated or edge spaces use \\u{HEX}; backslashes doubled.');
  if (!s.coverage.length) add(identity, 'BM coverage', 'No verified BM coverage overlaps this month.');
  s.coverage.forEach((c, i) => {
    const prefix = `BM${i+1}`;
    add(identity, `${prefix} legal name`, c.legalName); add(identity, `${prefix} counterparty ID`, c.counterpartyId);
    add(identity, `${prefix} coverage ID`, c.id); add(identity, `${prefix} verification ID`, c.verificationId);
    add(identity, `${prefix} agreement version ID`, c.agreementVersionId);
    add(identity, `${prefix} coverage from inclusive UTC`, c.effectiveFrom);
    add(identity, `${prefix} coverage to exclusive UTC`, c.effectiveTo ?? 'Open-ended');
  });
  add(summary, 'Scope', 'All totals are Building-wide, not attributed to a BM. Coverage may cover only part of the month.');
  add(summary, 'Cohort', 'Requests created in this UTC month; status and categories are current at generation, not historical month-end.');
  add(summary, 'Requests total', s.totals.requests); add(summary, 'Cancelled requests as of generation', s.totals.cancelled);
  if (s.status === 'DRAFT_PREVIEW') {
    add(summary, 'Ongoing work proxy', s.totals.ongoingProxy);
    add(summary, 'All scopes customer-accepted proxy', s.totals.acceptedAllScopesProxy);
    add(summary, 'Unclassified requests', s.totals.unclassified);
    add(summary, 'Proxy precedence', 'Cancelled; else active, paused or material-run session; else all current scopes have verified customer-accepted BAST; else unclassified.');
  }
  add(summary, 'Lifecycle gap', issued ? 'Authoritative request completed and ongoing statuses are unavailable and omitted.' :
    'No authoritative request completed or ongoing status exists; proxies are not request completion.');
  add(summary, 'Work Order gap', 'No authoritative Handyman request to FM Work Order link; Work Order progress and completion omitted.');
  if (!issued) add(summary, 'Issuance', 'This live preview is not an issued or stored report.');
  add(activity, 'Activity basis', 'UTC event occurrence in this month, including requests created outside the month.');
  add(activity, 'Counting rule', 'Distinct scopes for work, QC runs for QC, and parent documents or claims or reworks per milestone; milestones are not additive.');
  add(activity, 'Work started scopes', s.activity.work.startedScopes);
  add(activity, 'Work session completed scopes', s.activity.work.completedSessionScopes);
  add(activity, 'Work session caveat', 'Session completion is not request, job or FM Work Order completion.');
  add(activity, 'QC finished runs', s.activity.qc.finishedRuns); add(activity, 'QC passed runs', s.activity.qc.passed);
  add(activity, 'QC failed runs', s.activity.qc.failed); add(activity, 'QC unknown outcome runs', s.activity.qc.unknown);
  add(activity, 'QC outcome basis', 'Finish event outcome, or current final run status for legacy events; inconsistent outcomes are unknown.');
  for (const [type, count] of Object.entries(s.activity.bast)) add(activity, `BAST ${type} documents`, count);
  add(activity, 'Verified customer BAST acceptances', s.activity.verifiedBastAcceptances);
  add(activity, 'BAST acceptance basis', 'ACCEPT is recorded history; verified subset uses current customer-consent authority as of generation.');
  for (const [type, count] of Object.entries(s.activity.claims)) add(activity, `Warranty claim ${type}`, count);
  for (const [type, count] of Object.entries(s.activity.reworks)) add(activity, `Warranty rework ${type}`, count);
  add(categories, 'Category basis', 'Current mutable service catalog categories for the request creation cohort, not historical snapshots.');
  if (!s.categories.length) add(categories, 'Categories', 'No requests created in this month.');
  s.categories.forEach((c, i) => add(categories, `Category ${i+1} requests`, `${c.category}: ${c.count}`));
  add(references, 'Privacy', 'Only neutral source IDs are included; tenant identity, unit, notes, contact and evidence are excluded.');
  if (s.status === 'DRAFT_PREVIEW') s.requests.forEach((r, i) => {
    const p = `R${i+1}`; add(references, `${p} request ID`, r.id); add(references, `${p} current status / bucket`, `${r.status} / ${r.bucket}`);
    add(references, `${p} service catalog ID`, r.serviceCatalogId);
  });
  else s.requests.forEach((r, i) => {
    const p = `R${i+1}`; add(references, `${p} request ID`, r.id); add(references, `${p} current status`, r.status);
    add(references, `${p} service catalog ID`, r.serviceCatalogId);
  });
  s.scopes.forEach((x, i) => add(references, `S${i+1} scope / request ID`, `${x.id} / ${x.requestId}`));
  s.activeSessions.forEach((x, i) => add(references, `W${i+1} active session / scope`, `${x.id} / ${x.scopeId} / ${x.status}`));
  s.basts.forEach((x, i) => add(references, `B${i+1} BAST / scope / verified`, `${x.id} / ${x.scopeId} / ${x.verified ? 'YES' : 'NO'}`));
  s.events.forEach((e, i) => {
    const p = `E${i+1} ${e.family} ${e.type}`;
    add(references, `${p} event ID`, e.id); add(references, `${p} parent ID`, e.parentId);
    add(references, `${p} scope ID`, e.scopeId); add(references, `${p} occurred UTC`, e.occurredAt);
  });
  return { metadata: { dataset: issued ? 'HANDYMAN_MONTHLY_SERVICE_REPORT_ISSUED' : 'HANDYMAN_MONTHLY_SERVICE_REPORT_PREVIEW',
    datasetLabel: `${issued ? 'ISSUED' : 'DRAFT/PREVIEW'} - Monthly Building Service Report`,
    buildingId: s.building.id, buildingScope: [s.building.id], period: { dateFrom: s.period.from.slice(0, 10), dateTo: s.period.lastDay },
    filters: {}, asOf: s.asOf }, generatedAt: s.asOf, kpis: [], tables: [
    table('identity', 'Issuer, Building, BM and period', identity, issued), table('summary', 'Operational summary', summary, issued),
    table('activity', 'Monthly activity', activity, issued), table('categories', 'Service categories', categories, issued),
    table('references', 'Source references', references, issued),
  ] };
}

export async function downloadHandymanMonthlyServiceReport(actorInput: string, input: MonthlyServiceReportInput) {
  const actor = uuid(actorInput, 'actorUserId'), n = normalizeMonthlyServiceReportInput(input);
  const snapshot = await readSnapshot(actor, n), sourceChecksum = hash(snapshot);
  const pdf = await renderReportingPdf(renderInput(snapshot, sourceChecksum), { filename: `monthly-service-report-${n.month}-preview.pdf` });
  return { ...pdf, sourceChecksum, snapshot };
}

/** Render an issued snapshot using the same report renderer, without preview-only proxies. */
export async function renderIssuedMonthlyServiceReport(s: IssuedMonthlySource, checksum: string) {
  return renderReportingPdf(renderInput(s, checksum), { filename: `monthly-service-report-${s.period.month}-${s.issuance.id}.pdf` });
}

/** Independently count raw scoped parents/events: an inner-join omission is not a complete source. */
export async function assertMonthlyServiceReportComplete(tx: PoolClient, input: MonthlyServiceReportInput, s: MonthlySource) {
  const n = normalizeMonthlyServiceReportInput(input), params = [n.clientId, n.buildingId, n.from, n.toExclusive];
  const expectCount = async (sql: string, expected: number) => {
    const result = await tx.query<{ count: number }>(sql, params);
    if (result.rows[0]?.count !== expected) throw new AppError({ code: ERROR_CODES.HANDYMAN_BM_DOCUMENT_INTEGRITY_ERROR,
      statusCode: 409, message: 'Monthly report source coverage could not be proven complete.' });
  };
  await expectCount(`SELECT count(*)::int AS count FROM handyman_bm_building_coverages c
    WHERE c.client_id=$1 AND c.building_id=$2 AND c.cancelled_at IS NULL AND c.effective_from < $4::timestamptz
      AND (c.effective_to IS NULL OR c.effective_to > $3::timestamptz)`, s.coverage.length);
  await expectCount(`SELECT count(*)::int AS count FROM handyman_service_requests r
    WHERE r.client_id=$1 AND r.building_id=$2 AND r.created_at >= $3::timestamptz AND r.created_at < $4::timestamptz`, s.requests.length);
  const cohort = `JOIN handyman_service_requests r ON r.id=s.handyman_request_id
    WHERE s.client_id=$1 AND s.building_id=$2 AND r.created_at >= $3::timestamptz AND r.created_at < $4::timestamptz`;
  await expectCount(`SELECT count(*)::int AS count FROM handyman_execution_scopes s ${cohort}`, s.scopes.length);
  await expectCount(`SELECT count(*)::int AS count FROM handyman_work_sessions w
    JOIN handyman_execution_scopes s ON s.id=w.execution_scope_id ${cohort}
    AND w.status IN ('IN_PROGRESS','PAUSED','MATERIAL_RUN')`, s.activeSessions.length);
  await expectCount(`SELECT count(*)::int AS count FROM handyman_bast_documents b
    JOIN handyman_execution_scopes s ON s.id=b.execution_scope_id ${cohort} AND b.status='ACCEPTED'`, s.basts.length);
  for (const source of EVENT_SOURCES) {
    await expectCount(`SELECT count(*)::int AS count FROM ${source.events} e
      JOIN ${source.parents} p ON p.id=e.${source.parentKey}
      JOIN handyman_execution_scopes s ON s.id=p.execution_scope_id
      WHERE s.client_id=$1 AND s.building_id=$2 AND e.occurred_at >= $3::timestamptz AND e.occurred_at < $4::timestamptz
        AND ${source.filter}`, s.events.filter(e => e.family === source.family).length);
  }
}
