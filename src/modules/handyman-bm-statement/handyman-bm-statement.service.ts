import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { resolveHandymanDocumentIssuerSnapshot } from '../handyman-documents/handyman-document-issuer.service';
import { maskHandymanDocumentAccountNumber } from '../handyman-documents/handyman-document-bank.types';
import { hash } from '../handyman-pph-calculation/handyman-pph-core';
import { permissionRepository } from '../permissions';
import { renderReportingPdf, type PdfRenderSnapshot } from '../reporting-export/pdf-renderer';
import type { ReportingExportRow, ReportingExportTable } from '../reporting-export/reporting-export.types';

/** A live, read-only commission statement source and preview. */
export type BmStatementInput = Readonly<{
  clientId: string;
  buildingId: string;
  counterpartyId: string;
  agreementVersionId: string;
  dateFrom: string;
  dateTo: string;
}>;

const LIMIT = 100;
const integrity = () => new AppError({
  code: ERROR_CODES.HANDYMAN_BM_STATEMENT_INTEGRITY_ERROR,
  statusCode: 409,
  message: 'BM statement source provenance or settlement evidence failed integrity checks.',
});
const notFound = () => new AppError({
  code: ERROR_CODES.HANDYMAN_BM_STATEMENT_NOT_FOUND,
  statusCode: 404,
  message: 'No matching BM Building coverage and agreement were found in this Client.',
});
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-', ''))) {
    throw AppError.validation(`Invalid ${field}.`);
  }
  return value.toLowerCase();
}
function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw AppError.validation(`Invalid ${field}.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000-')) {
    throw AppError.validation(`Invalid ${field}.`);
  }
  return value;
}
export function normalizeBmStatementInput(input: BmStatementInput): BmStatementInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['clientId', 'buildingId', 'counterpartyId', 'agreementVersionId', 'dateFrom', 'dateTo'].includes(key))) {
    throw AppError.validation('Unexpected BM statement request fields.');
  }
  const n = {
    clientId: uuid(input.clientId, 'clientId'), buildingId: uuid(input.buildingId, 'buildingId'),
    counterpartyId: uuid(input.counterpartyId, 'counterpartyId'), agreementVersionId: uuid(input.agreementVersionId, 'agreementVersionId'),
    dateFrom: date(input.dateFrom, 'dateFrom'), dateTo: date(input.dateTo, 'dateTo'),
  };
  if (n.dateFrom > n.dateTo) throw AppError.validation('dateFrom must not be after dateTo.');
  return n;
}
async function access(tx: PoolClient, actor: string, n: BmStatementInput): Promise<string> {
  // This first MVCC read establishes the repeatable-read snapshot; its clock
  // value is not earlier than the snapshot that actually selected the user.
  const user = (await tx.query('SELECT status,clock_timestamp() AS as_of FROM users WHERE id=$1', [actor])).rows[0];
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actor, tx);
  if (user?.status !== 'ACTIVE' || !permissions.includes('handyman.commercial.manage') || !permissions.includes('handyman.finance.read')) {
    throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403,
      message: 'Manager commercial authority and Finance read permission are required.' });
  }
  await assertBuildingScopedResourceAccess(actor, { clientId: n.clientId, buildingId: n.buildingId }, tx);
  return iso(user.as_of);
}
function signedCents(value: string): bigint {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)\.\d{2}$/.test(value)) throw integrity();
  const negative = value.startsWith('-'), raw = negative ? value.slice(1) : value;
  const [whole, fraction] = raw.split('.');
  const result = BigInt(whole!) * 100n + BigInt(fraction!);
  return negative ? -result : result;
}
function signedMoney(value: bigint): string {
  const n = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}
const iso = (value: Date) => value.toISOString();

/** All reads, including permission and Building scope, use one repeatable-read DB snapshot. */
async function readSnapshot(actor: string, n: BmStatementInput, existingTx?: PoolClient, snapshotAsOf?: string) {
  const read = async (tx: PoolClient) => {
    const currentAsOf = await access(tx, actor, n);
    const asOf = snapshotAsOf ?? currentAsOf;
    const master = (await tx.query(`SELECT b.name AS building_name,b.code AS building_code,
      p.legal_name,p.registration_number,v.id AS verification_id,
      a.id AS agreement_id,av.id AS agreement_version_id,av.version_number,av.effective_from,av.effective_to
      FROM buildings b JOIN properties property ON property.id=b.property_id AND property.client_id=$1
      JOIN handyman_bm_legal_counterparties p ON p.id=$3 AND p.client_id=$1
      JOIN handyman_bm_counterparty_verifications v ON v.counterparty_id=p.id
      JOIN handyman_commercial_agreement_versions av ON av.id=$4
      JOIN handyman_commercial_agreements a ON a.id=av.agreement_id AND a.client_id=$1
      WHERE b.id=$2 AND EXISTS(SELECT 1 FROM handyman_bm_building_coverages c
        WHERE c.client_id=$1 AND c.building_id=b.id AND c.counterparty_id=p.id AND c.agreement_version_id=av.id)`,
      [n.clientId, n.buildingId, n.counterpartyId, n.agreementVersionId])).rows[0];
    if (!master) throw notFound();
    const issuer = await resolveHandymanDocumentIssuerSnapshot(n.clientId, tx);
    const result = await tx.query(`SELECT l.*,f.transaction_id,f.execution_scope_id,x.handyman_request_id,
      original.id AS original_id,original.digest AS original_digest,original.snapshot AS original_snapshot,
      ec.fact_kind AS correction_kind,ec.amount::text AS correction_amount,ec.ledger_correction_id,
      lc.reason AS correction_reason
      FROM handyman_bm_commission_ledger l
      JOIN handyman_entitlement_facts f ON f.id=l.entitlement_id AND f.client_id=l.client_id
        AND f.agreement_version_id=$4 AND f.entitlement_kind='BM_FEE' AND f.fact_state='EARNED'
      JOIN handyman_execution_scopes x ON x.id=f.execution_scope_id AND x.client_id=l.client_id AND x.building_id=l.building_id
      JOIN handyman_bm_commission_ledger original ON original.entitlement_id=l.entitlement_id AND original.sequence=1
      LEFT JOIN handyman_entitlement_corrections ec ON ec.id=l.correction_id AND ec.entitlement_id=l.entitlement_id
      LEFT JOIN handyman_ledger_corrections lc ON lc.id=ec.ledger_correction_id AND lc.transaction_id=f.transaction_id
      WHERE l.client_id=$1 AND l.building_id=$2 AND l.counterparty_id=$3
        AND l.created_at >= ($5::date::timestamp AT TIME ZONE 'UTC')
        AND l.created_at < (($6::date + 1)::timestamp AT TIME ZONE 'UTC')
      ORDER BY l.created_at,l.id LIMIT $7`,
      [n.clientId, n.buildingId, n.counterpartyId, n.agreementVersionId, n.dateFrom, n.dateTo, LIMIT + 1]);
    if (result.rows.length > LIMIT) throw AppError.validation(`More than ${LIMIT} ledger entries; request a shorter UTC period.`);

    const entries = result.rows.map((r: any) => {
      const s = r.snapshot, original = r.original_snapshot, source = original?.projection?.ppn?.source;
      if (!s || hash(s) !== r.digest || hash(original) !== r.original_digest || s.id !== r.id ||
          s.clientId !== n.clientId || s.buildingId !== n.buildingId || s.counterpartyId !== n.counterpartyId ||
          s.entitlementId !== r.entitlement_id || s.currency !== 'IDR' || s.entryType !== r.entry_type ||
          s.sourceChecksum !== r.source_checksum || s.projectionChecksum !== r.projection_checksum ||
          s.assertions?.withholding !== 'NOT_ASSERTED' || s.assertions?.remittance !== 'NOT_ASSERTED' ||
          s.assertions?.payment !== 'NOT_ASSERTED' || s.delta?.gross !== r.gross_delta || s.delta?.ppn !== r.ppn_delta ||
          s.delta?.pph !== r.pph_delta || s.delta?.net !== r.net_delta || original?.id !== r.original_id ||
          source?.transactionId !== r.transaction_id || source?.entitlementId !== r.entitlement_id ||
          source?.agreement?.versionId !== n.agreementVersionId || source?.beneficiary?.counterpartyId !== n.counterpartyId ||
          (r.entry_type === 'CORRECTION_ADJUSTMENT' && (!r.correction_kind || !r.ledger_correction_id || !r.correction_reason ||
            s.projection?.source?.correctionFactId !== r.correction_id || s.projection?.source?.ledgerCorrectionId !== r.ledger_correction_id))) {
        throw integrity();
      }
      // The original basis is deliberately historical; the correction's signed
      // impact is the posted delta, not a newly inferred commission calculation.
      return {
        id: r.id as string, digest: r.digest as string, sourceChecksum: r.source_checksum as string,
        projectionChecksum: r.projection_checksum as string, createdAt: iso(r.created_at),
        type: r.entry_type as string, sequence: r.sequence as number, entitlementId: r.entitlement_id as string,
        transactionId: r.transaction_id as string, executionScopeId: r.execution_scope_id as string,
        requestId: r.handyman_request_id as string, previousEntryId: r.previous_entry_id as string | null,
        basis: { kind: source.commissionBasis as string, commercialBasis: source.commercialBasis as string,
          commercialBasisSource: source.commercialBasisSource as string, ratePercent: source.commercialRatePercent as string,
          laborNet: source.laborNet as string, materialNet: source.materialNet as string, chargedNet: source.chargedNet as string,
          ledgerBasisDigest: source.ledgerBasisDigest as string, ruleId: source.agreement.ruleId as string,
          termId: source.agreement.termId as string, coverageId: source.coverage.id as string,
          originalEntryId: r.original_id as string, originalDigest: r.original_digest as string },
        tax: { ppnTaxPointAt: s.projection.ppn.taxPointAt as string, ppnApplicability: s.projection.ppn.applicability as string,
          pphTaxPointAt: s.projection.pph.taxPointAt as string, pphTreatment: s.projection.pph.treatment as string },
        delta: { gross: r.gross_delta as string, ppn: r.ppn_delta as string, pph: r.pph_delta as string, net: r.net_delta as string },
        correction: r.correction_id ? { factId: r.correction_id as string, kind: r.correction_kind as string,
          ledgerCorrectionId: r.ledger_correction_id as string, reason: r.correction_reason as string,
          signedCommissionImpact: s.projection.source.signedAmount as string } : null,
      };
    });
    const ids = [...new Set(entries.map(e => e.entitlementId))];
    const ledgerRows = ids.length ? (await tx.query(`SELECT id,entitlement_id,digest FROM handyman_bm_commission_ledger
      WHERE entitlement_id=ANY($1::uuid[])`, [ids])).rows : [];
    const ledgerPins = new Map(ledgerRows.map((r: any) => [r.id, r]));
    const settlementRows = ids.length ? (await tx.query(`SELECT s.*, b.bank_name,b.account_number,
      hm_bm_settlement_anchors_valid(s,true) AS current_anchors_valid,
      a.id AS approval_id,a.settlement_digest AS approval_digest,a.actor_user_id AS approval_actor,a.occurred_at AS approved_at,
      p.id AS payment_id,p.approval_id AS payment_approval_id,p.amount::text AS payment_amount,p.currency AS payment_currency,
      p.transfer_reference,p.transferred_at,p.evidence_id,p.content_sha256 AS payment_sha,p.recorded_by_user_id,
      v.id AS verification_id,v.payment_id AS verified_payment_id,v.evidence_read_id,v.content_sha256 AS verification_sha,
      v.method,v.actor_user_id AS verifier_id,v.occurred_at AS verified_at,v.evidence_reference AS verification_reference,
      er.payment_id AS read_payment_id,er.actor_user_id AS reader_id,er.content_sha256 AS read_sha
      FROM handyman_bm_settlements s
      JOIN handyman_bm_bank_account_versions b ON b.id=s.bank_version_id
      LEFT JOIN handyman_bm_settlement_approvals a ON a.settlement_id=s.id
      LEFT JOIN handyman_bm_settlement_payments p ON p.settlement_id=s.id
      LEFT JOIN handyman_bm_settlement_verifications v ON v.settlement_id=s.id
      LEFT JOIN handyman_bm_settlement_evidence_reads er ON er.id=v.evidence_read_id
      WHERE s.client_id=$1 AND s.building_id=$2 AND s.counterparty_id=$3 AND s.agreement_version_id=$4
        AND s.entitlement_id=ANY($5::uuid[]) ORDER BY s.id`,
      [n.clientId, n.buildingId, n.counterpartyId, n.agreementVersionId, ids])).rows : [];
    const settlements = settlementRows.map((r: any) => {
      const pins = r.snapshot?.ledgerEntries;
      if (hash(r.snapshot) !== r.digest || r.snapshot?.id !== r.id || r.snapshot?.clientId !== n.clientId ||
          r.snapshot?.buildingId !== n.buildingId || r.snapshot?.counterpartyId !== n.counterpartyId ||
          r.snapshot?.entitlementId !== r.entitlement_id || r.snapshot?.agreementVersionId !== n.agreementVersionId ||
          r.snapshot?.netPayable !== r.net_payable || r.snapshot?.currency !== 'IDR' ||
          r.snapshot?.assertions?.withholding !== 'NOT_ASSERTED' || r.snapshot?.assertions?.remittance !== 'NOT_ASSERTED' ||
          !Array.isArray(pins) || pins.length < 1 || pins.length > 2 ||
          pins.some((p: any) => !ledgerPins.has(p.id) || ledgerPins.get(p.id).entitlement_id !== r.entitlement_id || ledgerPins.get(p.id).digest !== p.digest) ||
          (r.approval_id && r.approval_digest !== r.digest) ||
          (r.payment_id && (!r.approval_id || r.payment_approval_id !== r.approval_id || r.payment_amount !== r.net_payable || r.payment_currency !== 'IDR')) ||
          (r.verification_id && (!r.payment_id || r.verified_payment_id !== r.payment_id || r.read_payment_id !== r.payment_id ||
            r.payment_sha !== r.verification_sha || r.read_sha !== r.verification_sha || r.reader_id !== r.verifier_id ||
            r.verifier_id === r.created_by_user_id || r.verifier_id === r.recorded_by_user_id || r.method !== 'FINANCE_MANUAL_DOCUMENT_REVIEW'))) {
        throw integrity();
      }
      const lifecycle = r.verification_id ? 'SETTLED' : r.payment_id ? 'PAYMENT_RECORDED' : r.approval_id ? 'APPROVED' : 'PREPARED';
      const status = r.verification_id ? 'PAID' : !r.current_anchors_valid ? 'STALE_NOT_PAYABLE' : r.approval_id ? 'PAYABLE' : 'CALCULATED';
      return {
        id: r.id as string, digest: r.digest as string, entitlementId: r.entitlement_id as string,
        ledgerEntries: pins as Array<{id:string;digest:string}>, lifecycle, status,
        currentAnchorsValid: r.current_anchors_valid as boolean, netPayable: r.net_payable as string,
        bankVersionId: r.bank_version_id as string, bankDecisionId: r.bank_decision_id as string,
        bankName: r.bank_name as string, accountNumberMasked: maskHandymanDocumentAccountNumber(r.account_number),
        approval: r.approval_id ? { id: r.approval_id as string, occurredAt: iso(r.approved_at) } : null,
        // An unverified payment claim is not a verified reference and is never printed as one.
        unverifiedPaymentRecorded: Boolean(r.payment_id && !r.verification_id),
        verifiedPayment: r.verification_id ? { id: r.payment_id as string, transferReference: r.transfer_reference as string,
          amount: r.payment_amount as string, transferredAt: iso(r.transferred_at), evidenceId: r.evidence_id as string,
          contentSha256: r.payment_sha as string, verificationId: r.verification_id as string, evidenceReadId: r.evidence_read_id as string,
          method: r.method as string, verifierId: r.verifier_id as string, verifiedAt: iso(r.verified_at),
          verificationReference: r.verification_reference as string } : null,
      };
    });
    const byEntitlement = new Map(settlements.map(s => [s.entitlementId, s]));
    const statementEntries = entries.map(e => {
      const settlement = byEntitlement.get(e.entitlementId);
      const covered = settlement?.ledgerEntries.some(p => p.id === e.id && p.digest === e.digest) ?? false;
      return { ...e, settlement: !settlement ? { coverage: 'NO_SETTLEMENT', id: null, digest: null, status: 'CALCULATED' } :
        !covered ? { coverage: 'NOT_COVERED', id: settlement.id, digest: settlement.digest, status: 'CALCULATED' } :
        { coverage: 'COVERED', id: settlement.id, digest: settlement.digest, status: settlement.status } };
    });
    // Do not attach an old payment/reference to an adjustment absent from its pin.
    const includedSettlements = settlements.filter(s => statementEntries.some(e => e.settlement.id === s.id && e.settlement.coverage === 'COVERED'));
    const total = { gross: 0n, ppn: 0n, pph: 0n, net: 0n };
    for (const e of statementEntries) for (const k of ['gross', 'ppn', 'pph', 'net'] as const) total[k] += signedCents(e.delta[k]);
    return {
      schema: 'HANDYMAN_BM_COMMISSION_STATEMENT_PREVIEW_V1' as const,
      status: 'DRAFT_PREVIEW' as const, asOf, clientId: n.clientId,
      period: { dateFrom: n.dateFrom, dateTo: n.dateTo, timezone: 'UTC' as const, basis: 'LEDGER_POSTED_AT' as const },
      issuer: { profileId: issuer.profileId, version: issuer.version, payloadChecksum: issuer.payloadChecksum,
        legalName: issuer.legalName, registeredAddress: issuer.registeredAddress, city: issuer.city, province: issuer.province,
        postalCode: issuer.postalCode, email: issuer.email, phone: issuer.phone, taxId: issuer.taxId,
        businessRegistrationId: issuer.businessRegistrationId },
      building: { id: n.buildingId, name: master.building_name as string, code: master.building_code as string },
      beneficiary: { id: n.counterpartyId, legalName: master.legal_name as string, registrationNumber: master.registration_number as string,
        verificationId: master.verification_id as string },
      agreement: { id: master.agreement_id as string, versionId: n.agreementVersionId, versionNumber: master.version_number as number,
        effectiveFrom: master.effective_from ? iso(master.effective_from) : null, effectiveTo: master.effective_to ? iso(master.effective_to) : null },
      currency: 'IDR' as const, calculated: { gross: signedMoney(total.gross), ppn: signedMoney(total.ppn),
        pphProjection: signedMoney(total.pph), netProjection: signedMoney(total.net) },
      assertions: { withholding: 'NOT_ASSERTED' as const, taxRemittance: 'NOT_ASSERTED' as const },
      entries: statementEntries, settlements: includedSettlements,
    };
  };
  if (existingTx) return read(existingTx);
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return read(tx);
  });
}

/** Issuance shares the same complete source reader inside its own repeatable-read transaction. */
export async function readBmStatementSource(tx: PoolClient, actorInput: string, input: BmStatementInput, snapshotAsOf: string) {
  return readSnapshot(uuid(actorInput, 'actorUserId'), normalizeBmStatementInput(input), tx, snapshotAsOf);
}

type StatementSource = Awaited<ReturnType<typeof readSnapshot>>;
export type BmIssuance = { id: string; issuedAt: string; issuedBy: string };
export type BmStatementCoveragePin = { id: string; verificationId: string; effectiveFrom: string; effectiveTo: string | null };
export function issuedBmStatementSource(s: StatementSource, issuance: BmIssuance, coverage: BmStatementCoveragePin[]) {
  return { ...s, schema: 'HANDYMAN_BM_COMMISSION_STATEMENT_ISSUED_V1' as const, status: 'ISSUED' as const, issuance, coverage };
}
type IssuedStatementSource = ReturnType<typeof issuedBmStatementSource>;

/** Preserve otherwise unsupported characters and exact spaces instead of silently changing legal names or references. */
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
  // The shared renderer caps a cell at three lines. Small labelled chunks make
  // every character, including long payment references and SHA-256 pins, visible.
  const chunks = text.match(/[\s\S]{1,48}/g) ?? [''];
  chunks.forEach((part, i) => {
    // Trimming by the shared renderer must not erase spaces at a split boundary.
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
function renderInput(s: StatementSource | IssuedStatementSource, checksum: string): PdfRenderSnapshot {
  const identity: ReportingExportRow[] = [], totals: ReportingExportRow[] = [], rows: ReportingExportRow[] = [], payments: ReportingExportRow[] = [];
  const issued = s.status === 'ISSUED';
  add(identity, 'Status', issued ? 'ISSUED - immutable stored document' : 'DRAFT/PREVIEW - this preview is not issued or stored');
  if (s.status === 'ISSUED') {
    add(identity, 'Issuance ID', s.issuance.id); add(identity, 'Issued at UTC', s.issuance.issuedAt);
    s.coverage.forEach((c, i) => {
      add(identity, `BM coverage ${i+1} ID`, c.id); add(identity, `BM coverage ${i+1} verification ID`, c.verificationId);
      add(identity, `BM coverage ${i+1} from UTC`, c.effectiveFrom);
      add(identity, `BM coverage ${i+1} to exclusive UTC`, c.effectiveTo ?? 'Open-ended');
    });
  }
  add(identity, 'Source snapshot as of UTC', s.asOf);
  add(identity, 'Issuer legal name (current profile)', s.issuer.legalName);
  add(identity, 'Issuer registered address', s.issuer.registeredAddress);
  add(identity, 'Issuer city / province', `${s.issuer.city}, ${s.issuer.province} ${s.issuer.postalCode}`);
  add(identity, 'Issuer email', s.issuer.email); add(identity, 'Issuer phone', s.issuer.phone);
  add(identity, 'Issuer tax ID', s.issuer.taxId); add(identity, 'Issuer registration ID', s.issuer.businessRegistrationId);
  add(identity, 'Issuer profile ID / version', `${s.issuer.profileId} / ${s.issuer.version}`);
  add(identity, 'Issuer profile SHA-256', s.issuer.payloadChecksum);
  add(identity, 'Client ID', s.clientId); add(identity, 'Building', s.building.name); add(identity, 'Building code', s.building.code);
  add(identity, 'Building ID', s.building.id); add(identity, 'BM legal name', s.beneficiary.legalName);
  add(identity, 'BM registration number', s.beneficiary.registrationNumber); add(identity, 'BM counterparty ID', s.beneficiary.id);
  add(identity, 'BM verification ID', s.beneficiary.verificationId); add(identity, 'Agreement ID', s.agreement.id);
  add(identity, 'Agreement version ID', s.agreement.versionId); add(identity, 'Agreement version number', s.agreement.versionNumber);
  add(identity, 'Agreement effective from UTC', s.agreement.effectiveFrom); add(identity, 'Agreement effective to UTC', s.agreement.effectiveTo);
  add(identity, 'Period basis', 'Ledger posting dates in UTC, inclusive; settlement status as of source snapshot');
  add(identity, 'Text encoding', 'Non-ASCII and repeated or edge spaces use \\u{HEX}; backslashes doubled.');
  add(identity, 'Snapshot SHA-256', checksum);
  add(totals, 'CALCULATED gross', `IDR ${s.calculated.gross}`); add(totals, 'CALCULATED PPN', `IDR ${s.calculated.ppn}`);
  add(totals, 'CALCULATED PPh projection', `IDR ${s.calculated.pphProjection}`);
  add(totals, 'CALCULATED net projection', `IDR ${s.calculated.netProjection}`);
  add(totals, 'Calculation scope', 'Sum of signed original and correction deltas posted in the selected period.');
  add(totals, 'Ledger scope', 'Only posted entries are included; unposted earnings or corrections are not represented.');
  add(totals, 'Withholding', 'NOT ASSERTED by this ledger or settlement; PPh is a projection.');
  add(totals, 'Tax remittance', 'NOT ASSERTED; payment or calculation is not remittance evidence.');
  add(totals, 'PAYABLE and PAID', 'Whole-entitlement settlement details below; not period totals.');
  if (!s.entries.length) add(rows, 'Entries', 'No commission ledger entries posted in this UTC period.');
  s.entries.forEach((e, i) => {
    const n = `E${i+1}`;
    add(rows, `${n} type / posted UTC`, `${e.type} / ${e.createdAt}`); add(rows, `${n} ledger entry ID`, e.id);
    add(rows, `${n} ledger digest`, e.digest); add(rows, `${n} source SHA-256`, e.sourceChecksum);
    add(rows, `${n} projection SHA-256`, e.projectionChecksum); add(rows, `${n} transaction ID`, e.transactionId);
    add(rows, `${n} execution scope ID`, e.executionScopeId); add(rows, `${n} request ID`, e.requestId);
    add(rows, `${n} entitlement ID`, e.entitlementId); add(rows, `${n} previous entry ID`, e.previousEntryId);
    add(rows, `${n} original basis type`, e.basis.kind); add(rows, `${n} original commercial basis`, `IDR ${e.basis.commercialBasis}`);
    add(rows, `${n} basis source`, e.basis.commercialBasisSource); add(rows, `${n} commission rate`, `${e.basis.ratePercent}%`);
    add(rows, `${n} original labor net`, `IDR ${e.basis.laborNet}`); add(rows, `${n} original material net`, `IDR ${e.basis.materialNet}`);
    add(rows, `${n} original charged net`, `IDR ${e.basis.chargedNet}`); add(rows, `${n} original basis SHA-256`, e.basis.ledgerBasisDigest);
    add(rows, `${n} agreement rule ID`, e.basis.ruleId); add(rows, `${n} agreement term ID`, e.basis.termId);
    add(rows, `${n} Building coverage ID`, e.basis.coverageId); add(rows, `${n} original ledger ID`, e.basis.originalEntryId);
    add(rows, `${n} original ledger digest`, e.basis.originalDigest);
    add(rows, `${n} PPN tax point UTC`, e.tax.ppnTaxPointAt); add(rows, `${n} PPN applicability`, e.tax.ppnApplicability);
    add(rows, `${n} PPh tax point UTC`, e.tax.pphTaxPointAt); add(rows, `${n} PPh treatment`, e.tax.pphTreatment);
    add(rows, `${n} gross delta`, `IDR ${e.delta.gross}`); add(rows, `${n} PPN delta`, `IDR ${e.delta.ppn}`);
    add(rows, `${n} PPh projection delta`, `IDR ${e.delta.pph}`); add(rows, `${n} net projection delta`, `IDR ${e.delta.net}`);
    if (e.correction) {
      add(rows, `${n} correction fact ID`, e.correction.factId); add(rows, `${n} correction kind`, e.correction.kind);
      add(rows, `${n} ledger correction ID`, e.correction.ledgerCorrectionId); add(rows, `${n} correction reason`, e.correction.reason);
      add(rows, `${n} recorded commission impact`, `IDR ${e.correction.signedCommissionImpact}`);
    }
    add(rows, `${n} settlement coverage`, e.settlement.coverage); add(rows, `${n} entry status`, e.settlement.status);
    add(rows, `${n} settlement ID`, e.settlement.id); add(rows, `${n} settlement digest`, e.settlement.digest);
    if (e.settlement.coverage === 'NOT_COVERED') add(rows, `${n} warning`, 'No payment asserted for this entry; settlement does not cover it.');
  });
  if (!s.settlements.length) add(payments, 'Settlement', 'No settlement covers an entry in this period.');
  s.settlements.forEach((p, i) => {
    const n = `S${i+1}`;
    add(payments, `${n} settlement ID`, p.id); add(payments, `${n} settlement digest`, p.digest);
    add(payments, `${n} lifecycle / evidence`, `${p.lifecycle} / ${p.status}`);
    add(payments, `${n} whole-entitlement net`, `IDR ${p.netPayable}`);
    add(payments, `${n} anchors current`, p.currentAnchorsValid ? 'YES' : 'NO - stale; historical payment covers only pinned entries');
    p.ledgerEntries.forEach((pin, index) => { add(payments, `${n} covered ledger ${index+1}`, pin.id); add(payments, `${n} covered digest ${index+1}`, pin.digest); });
    add(payments, `${n} bank name`, p.bankName); add(payments, `${n} bank account`, p.accountNumberMasked);
    add(payments, `${n} bank version / decision`, `${p.bankVersionId} / ${p.bankDecisionId}`);
    add(payments, `${n} bank authentication`, 'NOT VERIFIED BY SYSTEM');
    if (p.approval) { add(payments, `${n} approval ID`, p.approval.id); add(payments, `${n} approved UTC`, p.approval.occurredAt); }
    if (p.unverifiedPaymentRecorded) add(payments, `${n} payment claim`, 'Recorded but NOT VERIFIED; no payment asserted.');
    if (p.verifiedPayment) {
      const v = p.verifiedPayment;
      add(payments, `${n} payment status`, 'PAID - Finance manual document review; not bank authenticated.');
      add(payments, `${n} verified transfer reference`, v.transferReference); add(payments, `${n} verified amount`, `IDR ${v.amount}`);
      add(payments, `${n} transferred UTC`, v.transferredAt); add(payments, `${n} payment ID`, v.id);
      add(payments, `${n} evidence ID`, v.evidenceId); add(payments, `${n} evidence SHA-256`, v.contentSha256);
      add(payments, `${n} evidence read ID`, v.evidenceReadId); add(payments, `${n} verification ID`, v.verificationId);
      add(payments, `${n} verification method`, v.method); add(payments, `${n} verifier ID`, v.verifierId);
      add(payments, `${n} verified UTC`, v.verifiedAt); add(payments, `${n} review reference`, v.verificationReference);
    }
  });
  return { metadata: { dataset: issued ? 'BM_COMMISSION_STATEMENT_ISSUED' : 'BM_COMMISSION_STATEMENT_PREVIEW',
      datasetLabel: `${issued ? 'ISSUED' : 'DRAFT/PREVIEW'} - BM Commission Statement`,
      buildingId: s.building.id, buildingScope: [s.building.id], period: { dateFrom: s.period.dateFrom, dateTo: s.period.dateTo },
      filters: {}, asOf: s.asOf }, generatedAt: s.asOf, kpis: [], tables: [
      table('identity', 'Identity and source', identity, issued), table('totals', 'Calculated totals', totals, issued),
      table('entries', 'Transactions and corrections', rows, issued), table('settlements', 'Settlement and payment', payments, issued),
    ] };
}

/** Authorized, non-persisted PDF plus canonical source and byte checksums. */
export async function downloadHandymanBmStatement(actorInput: string, input: BmStatementInput) {
  const actor = uuid(actorInput, 'actorUserId'), n = normalizeBmStatementInput(input);
  const snapshot = await readSnapshot(actor, n), sourceChecksum = hash(snapshot);
  const pdf = await renderReportingPdf(renderInput(snapshot, sourceChecksum), { filename: 'bm-commission-statement-preview.pdf' });
  return { ...pdf, sourceChecksum, snapshot };
}

/** Render an issued snapshot using the same statement renderer, without preview labels. */
export async function renderIssuedBmStatement(s: IssuedStatementSource, checksum: string) {
  return renderReportingPdf(renderInput(s, checksum), { filename: `bm-commission-statement-${s.issuance.id}.pdf` });
}
