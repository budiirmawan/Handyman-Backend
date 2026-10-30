import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { hasVerifiedHandymanBastCustomerAcceptance } from '../handyman-bast';
import { cents, hash, pphError, pphIntegrity, uuid } from '../handyman-pph-calculation/handyman-pph-core';
import { readHandymanBmOriginalCommissionAnchorInSnapshot } from '../handyman-pph-calculation/handyman-pph.service';
import type {
  BmCommissionCorrectionLineage, BmLineageBlocker, BmLineageCharge,
  BmLineageEntitlementCorrection, BmLineageLedgerCorrection, BmLineageOriginal,
  BmLineageVariation, LegacyBmEarnedAnchor,
} from './handyman-bm-correction-lineage.types';

const iso = (value: Date): string => value.toISOString();
const maybeIso = (value: Date | null): string | null => value ? iso(value) : null;
const signed = (amount: string, negative: boolean): string => {
  cents(amount); // Validate exact decimal strings; no rate/rounding is introduced here.
  return `${negative ? '-' : '+'}${amount}`;
};

/**
 * Old EARNED rows predate Building coverage. Only called after the shared
 * source reader has checked Finance/Building access and the immutable fact,
 * then specifically failed to find historical coverage. Never attach a
 * present-day party to such a row or present it as verified.
 */
async function legacyAnchor(tx: PoolClient, clientId: string, entitlementId: string): Promise<LegacyBmEarnedAnchor> {
  const rows = await tx.query(`SELECT f.*, s.client_id AS scope_client, s.building_id,
      t.client_id AS tx_client, t.execution_scope_id AS tx_scope, t.currency AS tx_currency,
      t.created_at AS tx_created, a.client_id AS agreement_client,
      av.agreement_id AS actual_agreement, av.version_number AS actual_version,
      av.effective_from AS actual_from, av.effective_to AS actual_to, av.status AS agreement_status,
      r.agreement_version_id AS rule_version, r.mode, r.basis,
      term.agreement_version_id AS term_version, term.term_kind, term.rate_percent::text AS actual_rate,
      fb.basis_ex_vat::text AS fiscal_basis, fb.tenant_profile_id AS fiscal_tenant_profile_id,
      fb.bm_profile_id AS fiscal_bm_profile_id,
      b.agreement_version_id AS beneficiary_version, b.beneficiary_kind AS actual_beneficiary_kind,
      b.beneficiary_reference_id AS beneficiary_client, p.client_id AS building_client
    FROM handyman_entitlement_facts f
    JOIN handyman_execution_scopes s ON s.id=f.execution_scope_id
    JOIN handyman_customer_transactions t ON t.id=f.transaction_id
    JOIN buildings building ON building.id=s.building_id
    JOIN properties p ON p.id=building.property_id
    JOIN handyman_commercial_agreements a ON a.id=f.agreement_id
    JOIN handyman_commercial_agreement_versions av ON av.id=f.agreement_version_id
    JOIN handyman_bm_fee_rule_definitions r ON r.id=f.bm_rule_id
    JOIN handyman_bm_fee_term_definitions term ON term.id=f.bm_term_id
    JOIN handyman_bm_fee_beneficiary_definitions b ON b.id=f.bm_beneficiary_id
    LEFT JOIN handyman_bm_fee_fiscal_bases fb ON fb.entitlement_id=f.id
    WHERE f.id=$1 AND f.client_id=$2 AND f.bm_beneficiary_kind IS NULL`, [entitlementId,clientId]);
  if (rows.rowCount !== 1) throw pphIntegrity();
  const f = rows.rows[0];
  if (f.entitlement_kind !== 'BM_FEE' || f.fact_state !== 'EARNED' || f.basis_kind !== 'LABOR_ONLY' ||
      f.ledger_contract_version !== 'CR-HM-13-PART-06' || f.currency !== 'IDR' ||
      f.scope_client !== clientId || f.tx_client !== clientId || f.building_client !== clientId ||
      f.tx_scope !== f.execution_scope_id || f.tx_currency !== f.currency ||
      iso(f.tx_created) !== iso(f.ledger_posted_at) || f.agreement_client !== clientId ||
      f.actual_agreement !== f.agreement_id || f.actual_version !== f.agreement_version_number ||
      iso(f.actual_from) !== iso(f.agreement_effective_from) ||
      (f.agreement_effective_to && (!f.actual_to || f.actual_to > f.agreement_effective_to)) ||
      f.ledger_posted_at < f.agreement_effective_from ||
      (f.agreement_effective_to && f.ledger_posted_at >= f.agreement_effective_to) ||
      !['ACTIVE','SUPERSEDED'].includes(f.agreement_status) || f.rule_version !== f.agreement_version_id ||
      f.mode !== 'DEFAULT' || f.basis !== 'LABOR_ONLY' || f.term_version !== f.agreement_version_id ||
      f.term_kind !== 'PERCENTAGE_OF_BASIS' || f.actual_rate !== f.bm_term_rate_percent ||
      f.beneficiary_version !== f.agreement_version_id || f.actual_beneficiary_kind !== 'CLIENT_ORGANIZATION' ||
      f.beneficiary_client !== clientId || f.bm_beneficiary_reference_id !== clientId) throw pphIntegrity();
  const body = {
    schema:'HANDYMAN_BM_LEGACY_EARNED_ANCHOR_V1' as const, clientId, buildingId:f.building_id as string,
    executionScopeId:f.execution_scope_id as string, transactionId:f.transaction_id as string,
    entitlementId:f.id as string, ledgerContractVersion:'CR-HM-13-PART-06' as const,
    ledgerPostedAt:iso(f.ledger_posted_at), derivedAt:iso(f.derived_at), derivedByUserId:f.derived_by_user_id as string,
    currency:'IDR' as const, commissionBasis:'EARNED_BM_COMMISSION' as const, commissionGross:f.amount as string,
    laborNet:f.labor_net as string, materialNet:f.material_net as string, chargedNet:f.charged_net as string,
    adjustedTransactionScope:f.adjusted_transaction_scope as string,
    commercialBasis:(f.fiscal_basis ?? f.labor_net) as string,
    commercialBasisSource:f.fiscal_basis === null ? 'LEDGER_LABOR_NET' as const : 'EXISTING_FISCAL_BASIS' as const,
    commercialFiscalBasis:f.fiscal_basis === null ? null : {tenantProfileId:f.fiscal_tenant_profile_id as string,
      bmProfileId:f.fiscal_bm_profile_id as string}, commercialRatePercent:f.actual_rate as string,
    agreement:{id:f.agreement_id as string,versionId:f.agreement_version_id as string,
      versionNumber:f.agreement_version_number as number,effectiveFrom:iso(f.agreement_effective_from),
      effectiveToAtEarning:maybeIso(f.agreement_effective_to),ruleId:f.bm_rule_id as string,termId:f.bm_term_id as string},
    beneficiary:{kind:'CLIENT_ORGANIZATION' as const,beneficiaryDefinitionId:f.bm_beneficiary_id as string,
      representedClientId:clientId,counterpartyId:null,verificationId:null}, coverage:null,
  };
  return {...body,checksumAlgorithm:'SHA-256',checksum:hash(body)};
}

async function originalAt(tx: PoolClient, actor: string, clientId: string, entitlementId: string): Promise<BmLineageOriginal> {
  let anchor: BmLineageOriginal['anchor'];
  let bindingStatus: BmLineageOriginal['bindingStatus'] = 'VERIFIED_HISTORICAL_BINDING';
  try {
    anchor = await readHandymanBmOriginalCommissionAnchorInSnapshot(tx,actor,clientId,entitlementId);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== ERROR_CODES.HANDYMAN_BM_BINDING_NOT_EFFECTIVE) throw err;
    anchor = await legacyAnchor(tx,clientId,entitlementId);
    bindingStatus = 'LEGACY_COVERAGE_UNRESOLVED';
  }
  const scope = (await tx.query(`SELECT handyman_request_id FROM handyman_execution_scopes
    WHERE id=$1 AND client_id=$2 AND building_id=$3`, [anchor.executionScopeId,clientId,anchor.buildingId])).rows[0];
  if (!scope) throw pphIntegrity();
  return {bindingStatus,anchor,requestId:scope.handyman_request_id};
}

/** Read recorded, guarded final lifecycle events, never a quoted delta as posted money. */
async function variationsAt(tx: PoolClient, original: BmLineageOriginal, blockers: BmLineageBlocker[]): Promise<BmLineageVariation[]> {
  const a = original.anchor;
  const vars = (await tx.query(`SELECT v.*, qv.version_number AS quote_version, qv.status AS quote_status,
      qv.quotation_id AS quote_thread, s.quotation_id AS scope_thread,
      oq.id AS original_quote_id, oq.version_number AS original_quote_version, s.tenant_company_id AS scope_tenant,
      target.quotation_version_id AS target_quote_id, target.line_type AS target_line_type,
      target.uom_id AS target_uom_id, target.currency AS target_currency,
      (v.quoted_total_delta = CASE WHEN v.variation_type='REDUCE' THEN -1 ELSE 1 END *
        ROUND(v.quantity * v.quoted_unit_amount,2)) AS quote_delta_consistent,
      qr.status AS qc_status, qr.client_id AS qc_client, qr.execution_scope_id AS qc_scope,
      (SELECT id FROM handyman_qc_runs x WHERE x.execution_scope_id=s.id AND x.client_id=s.client_id
        ORDER BY x.created_at DESC,x.id DESC LIMIT 1) AS latest_qc_id,
      EXISTS (SELECT 1 FROM handyman_qc_run_events e
        JOIN handyman_qc_scope_checklist_bindings cb ON cb.execution_scope_id=s.id
        JOIN handyman_qc_checklist_specs spec ON spec.execution_scope_id=s.id AND spec.client_id=s.client_id
        JOIN handyman_qc_checklist_versions cv ON cv.id=cb.checklist_version_id
          AND cv.client_id=s.client_id AND cv.required_item_keys=spec.required_item_keys
        WHERE e.run_id=qr.id AND e.client_id=s.client_id AND e.event_type='FINISH'
          AND e.metadata->>'outcome'='PASSED' AND e.metadata ? 'expectedVersion'
          AND e.metadata->>'templateVersionId'=cb.checklist_version_id::text
          AND spec.checklist_identity=qr.checklist_identity
          AND spec.configured_at<=qr.created_at AND cb.bound_at<=qr.created_at) AS guarded_qc_finish,
      bd.client_id AS bast_client, bd.execution_scope_id AS bast_scope, bd.status AS bast_status
    FROM handyman_scope_variations v
    JOIN handyman_execution_scopes s ON s.id=v.execution_scope_id
    JOIN handyman_quotation_versions oq ON oq.id=s.approved_quotation_version_id
    LEFT JOIN handyman_quotation_versions qv ON qv.id=v.revised_quotation_version_id
    LEFT JOIN handyman_quotation_lines target ON target.id=v.target_quotation_line_id
    LEFT JOIN handyman_qc_runs qr ON qr.id=v.qc_run_id
    LEFT JOIN handyman_bast_documents bd ON bd.id=v.bast_id
    WHERE v.execution_scope_id=$1 AND v.status='FINAL_CHARGE_ELIGIBILITY' ORDER BY v.id`, [a.executionScopeId])).rows;
  if (!vars.length) return [];
  const ids = vars.map(v => v.id as string);
  const events = (await tx.query(`SELECT e.*,
      to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_occurred_at,
      EXISTS (SELECT 1 FROM handyman_field_evidence_uploads u
        WHERE u.attachment_reference=e.evidence_reference AND u.upload_status='VERIFIED'
          AND u.verified_at IS NOT NULL AND u.verified_at<=e.occurred_at
          AND u.verified_byte_size>0 AND length(u.sha256_checksum)>0
          AND u.client_id=$2 AND u.building_id=$3 AND u.handyman_request_id=$4
          AND (u.execution_scope_id IS NULL OR u.execution_scope_id=$5)) AS evidence_verified
    FROM handyman_scope_variation_events e WHERE e.variation_id=ANY($1::uuid[])
    ORDER BY e.variation_id,e.occurred_at,e.id`,
    [ids,a.clientId,a.buildingId,original.requestId,a.executionScopeId])).rows;
  // 0458 permits the composition anchor to retain the original transaction
  // version even when its quotation line is on a revised version. Match the
  // line's own version, not the basis row's version.
  const charges = (await tx.query(`SELECT l.id, l.line_kind, ql.quotation_version_id
    FROM handyman_charge_lines l JOIN handyman_charge_line_bases b ON b.charge_line_id=l.id
      AND b.quotation_line_id=l.quotation_line_id AND b.transaction_id=l.transaction_id AND b.client_id=l.client_id
    JOIN handyman_quotation_lines ql ON ql.id=l.quotation_line_id
    WHERE l.transaction_id=$1 AND l.client_id=$2 ORDER BY l.id`, [a.transactionId,a.clientId])).rows;
  const adjustments = (await tx.query(`SELECT c.id, l.quotation_line_id FROM handyman_ledger_corrections c
    JOIN handyman_charge_lines l ON l.id=c.source_charge_line_id AND l.transaction_id=c.transaction_id
    WHERE c.transaction_id=$1 AND c.client_id=$2 AND c.correction_kind='ADJUSTMENT' ORDER BY c.id`,
    [a.transactionId,a.clientId])).rows;
  const result: BmLineageVariation[] = [];
  for (const v of vars) {
    if (v.client_id !== a.clientId || v.building_id !== a.buildingId ||
        v.handyman_request_id !== original.requestId || v.tenant_company_id !== v.scope_tenant) {
      blockers.push({code:'VARIATION_SCOPE_OR_BUILDING_MISMATCH',sourceId:v.id}); continue;
    }
    if ((v.variation_type === 'REDUCE' || v.target_quotation_line_id !== null) &&
        (v.target_quote_id !== v.original_quote_id || v.target_line_type !== v.line_type ||
         v.target_uom_id !== v.uom_id || v.target_currency !== a.currency)) {
      blockers.push({code:'VARIATION_TARGET_MISMATCH',sourceId:v.id}); continue;
    }
    const ev = events.filter(e => e.variation_id === v.id && e.client_id === a.clientId &&
      e.execution_scope_id === a.executionScopeId && e.evidence_verified === true);
    const pick = (predicate: (e: any) => boolean) => ev.filter(predicate);
    const finding = pick(e => e.event_type === 'FIELD_FINDING' && e.from_status === null &&
      e.to_status === 'FIELD_FINDING' && e.actor_user_id === v.origin_actor_user_id && e.actor_role === v.origin_actor_role &&
      e.metadata?.variationType === v.variation_type && e.metadata?.lineType === v.line_type);
    const proposal = pick(e => e.event_type === 'PROPOSAL' && e.from_status === 'FIELD_FINDING' &&
      e.to_status === 'PROPOSAL' && e.actor_role === 'PIC_PEKERJAAN' && e.metadata?.variationType === v.variation_type);
    const review = pick(e => e.event_type === 'OPERATIONS_REVIEW' && ['FIELD_FINDING','PROPOSAL'].includes(e.from_status) &&
      e.to_status === 'OPERATIONS_REVIEW' && e.actor_role === 'OPERATIONS_MANAGER' && e.actor_user_id !== v.origin_actor_user_id &&
      e.metadata?.variationType === v.variation_type && e.metadata?.targetQuotationLineId === v.target_quotation_line_id);
    const revised = pick(e => e.event_type === 'REVISED_QUOTATION' && e.from_status === 'OPERATIONS_REVIEW' &&
      e.to_status === 'REVISED_QUOTATION' && e.actor_role === 'OPERATIONS_MANAGER' && e.actor_user_id !== v.origin_actor_user_id &&
      e.metadata?.revisedQuotationVersionId === v.revised_quotation_version_id && e.metadata?.revisedVersionNumber === v.quote_version &&
      e.metadata?.quotedUnitAmount === v.quoted_unit_amount && e.metadata?.quotedTotalDelta === v.quoted_total_delta &&
      e.metadata?.currency === v.currency);
    const tenant = pick(e => e.event_type === 'TENANT_DECISION' && e.from_status === 'REVISED_QUOTATION' &&
      e.to_status === 'TENANT_DECISION' && e.actor_role === 'TENANT' && e.actor_user_id === v.tenant_decided_by_user_id &&
      e.metadata?.decisionOutcome === 'APPROVED');
    const authorized = pick(e => e.event_type === 'AUTHORIZED_SCOPE' && e.from_status === 'TENANT_DECISION' &&
      e.to_status === 'AUTHORIZED_SCOPE' && e.actor_role === 'OPERATIONS_MANAGER' && e.actor_user_id !== v.origin_actor_user_id &&
      e.metadata?.variationType === v.variation_type && e.metadata?.targetQuotationLineId === v.target_quotation_line_id);
    const execution = pick(e => e.event_type === 'EXECUTION' && e.from_status === 'AUTHORIZED_SCOPE' &&
      e.to_status === 'EXECUTION' && e.actor_role === 'PIC_PEKERJAAN' && e.metadata?.variationType === v.variation_type);
    const qc = pick(e => e.event_type === 'QC' && ['EXECUTION','QC'].includes(e.from_status) && e.to_status === 'QC' &&
      e.actor_role === 'SUPERVISOR' && e.actor_user_id === v.qc_verified_by_user_id && e.actor_user_id !== v.origin_actor_user_id &&
      e.metadata?.qcOutcome === 'PASSED' && e.metadata?.qcRunId === v.qc_run_id);
    const final = pick(e => e.event_type === 'FINAL_CHARGE_ELIGIBILITY' && e.from_status === 'QC' &&
      e.to_status === 'FINAL_CHARGE_ELIGIBILITY' && e.actor_role === 'OPERATIONS_MANAGER' && e.actor_user_id !== v.origin_actor_user_id &&
      e.metadata?.finalChargeEligible === true && e.metadata?.qcRunId === v.qc_run_id &&
      e.metadata?.bastId === v.bast_id && e.metadata?.variationType === v.variation_type &&
      e.metadata?.revisedQuotationVersionId === v.revised_quotation_version_id &&
      e.metadata?.quotedTotalDelta === v.quoted_total_delta && e.metadata?.currency === v.currency);
    const valid = v.tenant_decision_outcome === 'APPROVED' && v.tenant_decided_at &&
      v.qc_outcome === 'PASSED' && v.qc_verified_at && v.final_charge_eligible === true &&
      v.currency === a.currency && v.quote_delta_consistent === true && v.quote_thread === v.scope_thread &&
      v.quote_version > v.original_quote_version && ['ISSUED','APPROVED','SUPERSEDED'].includes(v.quote_status) &&
      v.qc_status === 'PASSED' && v.qc_client === a.clientId && v.qc_scope === a.executionScopeId &&
      v.latest_qc_id === v.qc_run_id && v.guarded_qc_finish === true &&
      v.bast_client === a.clientId && v.bast_scope === a.executionScopeId && v.bast_status === 'ACCEPTED' &&
      finding.length === 1 && review.length === 1 && revised.length === 1 && tenant.length === 1 &&
      authorized.length === 1 && execution.length === 1 && qc.length === 1 && final.length === 1 &&
      ((review[0]?.from_status === 'PROPOSAL' && proposal.length === 1) ||
       (review[0]?.from_status === 'FIELD_FINDING' && proposal.length === 0));
    if (!valid || !(await hasVerifiedHandymanBastCustomerAcceptance(tx,v.bast_id))) {
      blockers.push({code:'VARIATION_LIFECYCLE_OR_EVIDENCE_UNVERIFIED',sourceId:v.id}); continue;
    }
    // Same-instant stages can be written by one transaction. An inverted
    // audit stream is not a provable lifecycle and must not be promoted.
    const eventRows = [finding[0],...proposal,review[0],revised[0],tenant[0],authorized[0],execution[0],qc[0],final[0]];
    if (eventRows.some((e,i) => i > 0 && eventRows[i-1].exact_occurred_at > e.exact_occurred_at)) {
      blockers.push({code:'VARIATION_LIFECYCLE_ORDER_UNPROVEN',sourceId:v.id}); continue;
    }
    const candidateChargeLineIds = v.variation_type === 'ADD'
      ? charges.filter(c => c.quotation_version_id === v.revised_quotation_version_id && c.line_kind === v.line_type).map(c => c.id as string).sort()
      : [];
    const candidateLedgerCorrectionIds = v.variation_type === 'REDUCE'
      ? adjustments.filter(c => c.quotation_line_id === v.target_quotation_line_id).map(c => c.id as string).sort()
      : [];
    result.push({variationId:v.id,kind:v.variation_type,lineKind:v.line_type,variationVersion:v.version,
      revisedQuotationVersionId:v.revised_quotation_version_id,revisedQuotationVersionNumber:v.quote_version,
      targetQuotationLineId:v.target_quotation_line_id,currency:v.currency,authorizedQuoteDelta:v.quoted_total_delta,
      relationToEarning:'UNKNOWN',lifecycleEvents:eventRows.map(e => ({id:e.id,type:e.event_type,
        actorUserId:e.actor_user_id,actorRole:e.actor_role,occurredAt:iso(e.occurred_at),evidenceReference:e.evidence_reference})),
      qcRunId:v.qc_run_id,bastId:v.bast_id,candidateChargeLineIds,candidateLedgerCorrectionIds,
      financialLink:'UNPROVEN',commissionImpact:null});
    blockers.push({code:'VARIATION_FINANCIAL_LINK_UNPROVEN',sourceId:v.id});
  }
  return result;
}

async function candidateChargesAt(tx: PoolClient, original: BmLineageOriginal, variations: BmLineageVariation[],
  blockers: BmLineageBlocker[], basisChanged: boolean): Promise<BmLineageCharge[]> {
  // When totals changed without a variation link, expose the posted source
  // facts as candidates, not as proven post-earning additions.
  const all = basisChanged ? (await tx.query(`SELECT id FROM handyman_charge_lines
    WHERE transaction_id=$1 AND client_id=$2 ORDER BY id`,
    [original.anchor.transactionId,original.anchor.clientId])).rows.map(r => r.id as string) : [];
  const ids = [...new Set([...all,...variations.flatMap(v => v.candidateChargeLineIds)])].sort();
  if (!ids.length) return [];
  const rows = (await tx.query(`SELECT l.id,l.quotation_line_id,l.line_kind,l.currency,l.amount::text AS amount,
      b.id AS basis_id,b.quotation_version_id AS basis_quotation_version_id,
      qv.id AS quotation_version_id,qv.version_number,
      array_agg(e.id ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL) AS event_ids
    FROM handyman_charge_lines l
    JOIN handyman_charge_line_bases b ON b.charge_line_id=l.id AND b.transaction_id=l.transaction_id
      AND b.client_id=l.client_id AND b.quotation_line_id=l.quotation_line_id
    JOIN handyman_quotation_lines ql ON ql.id=l.quotation_line_id
    JOIN handyman_quotation_versions qv ON qv.id=ql.quotation_version_id
    LEFT JOIN handyman_customer_transaction_events e ON e.charge_line_id=l.id AND e.transaction_id=l.transaction_id
      AND e.client_id=l.client_id AND e.event_type='POST_CHARGE_LINE'
    WHERE l.id=ANY($1::uuid[]) AND l.transaction_id=$2 AND l.client_id=$3
    GROUP BY l.id,b.id,qv.id ORDER BY l.id`, [ids,original.anchor.transactionId,original.anchor.clientId])).rows;
  const result: BmLineageCharge[] = [];
  for (const r of rows) {
    if (!r.event_ids || r.event_ids.length !== 1 || r.currency !== original.anchor.currency) {
      blockers.push({code:'CHARGE_EVENT_UNVERIFIED_OR_DUPLICATED',sourceId:r.id}); continue;
    }
    result.push({chargeLineId:r.id,transactionEventId:r.event_ids[0],basisId:r.basis_id,
      quotationLineId:r.quotation_line_id,quotationVersionId:r.quotation_version_id,quotationVersionNumber:r.version_number,
      basisQuotationVersionId:r.basis_quotation_version_id,lineKind:r.line_kind,currency:r.currency,
      signedPostedCharge:signed(r.amount,false),relationToEarning:'UNKNOWN',
      candidateVariationIds:variations.filter(v => v.candidateChargeLineIds.includes(r.id)).map(v => v.variationId).sort()});
  }
  for (const id of ids) if (!rows.some(r => r.id === id)) blockers.push({code:'CHARGE_SOURCE_UNVERIFIED',sourceId:id});
  return result;
}

/** A row without its governed source is not admitted as a ledger event. */
function ledgerSource(r: any, original: BmLineageOriginal) {
  const a = original.anchor;
  const validPayment = r.payment_status === 'CONFIRMED' && r.payment_decided_at && r.payment_decider &&
    r.payment_currency === a.currency && r.payment_confirmation_count === 1 && r.payment_confirmation_id;
  const validAllocation = r.allocation_id && r.allocation_amount === r.amount && r.allocation_currency === a.currency &&
    r.allocation_line_kind === r.allocation_kind && r.allocation_line_client === a.clientId &&
    r.allocation_payment_status === 'CONFIRMED' && r.allocation_payment_decided_at && r.allocation_payment_decider &&
    r.allocation_payment_currency === a.currency && r.allocation_confirmation_count === 1 && r.allocation_confirmation_id;
  const validLine = r.line_tx === a.transactionId && r.line_client === a.clientId && r.line_currency === a.currency &&
    ['LABOR','MATERIAL'].includes(r.charge_kind);
  const valid = r.currency === a.currency && Boolean(r.correction_kind === 'REFUND'
    ? r.source_kind === 'PAYMENT' && validPayment && cents(r.amount) <= cents(r.payment_amount)
    : r.correction_kind === 'REVERSAL'
      ? (r.source_kind === 'PAYMENT' && validPayment && r.payment_amount === r.amount) ||
        (r.source_kind === 'ALLOCATION' && validAllocation)
      : r.correction_kind === 'ADJUSTMENT' && ((r.source_kind === 'TRANSACTION' && !r.source_charge_line_id) ||
        (r.source_kind === 'CHARGE_LINE' && validLine)));
  return {valid,validLine:Boolean(validLine),validAllocation:Boolean(validAllocation)};
}

async function correctionsAt(tx: PoolClient, original: BmLineageOriginal, blockers: BmLineageBlocker[]) {
  const a = original.anchor;
  // The 0417 cause is deliberately not an FK: only join same-transaction,
  // same-client facts here. Foreign/missing causes never expose their details.
  const rows = (await tx.query(`SELECT c.*, l.line_kind AS charge_kind, l.client_id AS line_client,
      l.transaction_id AS line_tx, l.currency AS line_currency,
      p.status AS payment_status, p.amount::text AS payment_amount, p.currency AS payment_currency,
      p.decided_at AS payment_decided_at, p.decided_by_user_id AS payment_decider,
      (SELECT count(*)::int FROM handyman_customer_payment_events pe WHERE pe.payment_id=p.id
        AND pe.transaction_id=c.transaction_id AND pe.client_id=c.client_id AND pe.event_type='CONFIRM_PAYMENT') AS payment_confirmation_count,
      (SELECT min(pe.id::text) FROM handyman_customer_payment_events pe WHERE pe.payment_id=p.id
        AND pe.transaction_id=c.transaction_id AND pe.client_id=c.client_id AND pe.event_type='CONFIRM_PAYMENT'
        AND pe.actor_user_id=p.decided_by_user_id AND pe.occurred_at=p.decided_at) AS payment_confirmation_id,
      al.id AS allocation_id, al.amount::text AS allocation_amount, al.line_kind AS allocation_kind,
      al.currency AS allocation_currency, al_line.line_kind AS allocation_line_kind, al_line.client_id AS allocation_line_client,
      ap.status AS allocation_payment_status, ap.decided_at AS allocation_payment_decided_at,
      ap.decided_by_user_id AS allocation_payment_decider, ap.currency AS allocation_payment_currency,
      (SELECT count(*)::int FROM handyman_customer_payment_events pe WHERE pe.payment_id=ap.id
        AND pe.transaction_id=c.transaction_id AND pe.client_id=c.client_id AND pe.event_type='CONFIRM_PAYMENT') AS allocation_confirmation_count,
      (SELECT min(pe.id::text) FROM handyman_customer_payment_events pe WHERE pe.payment_id=ap.id
        AND pe.transaction_id=c.transaction_id AND pe.client_id=c.client_id AND pe.event_type='CONFIRM_PAYMENT'
        AND pe.actor_user_id=ap.decided_by_user_id AND pe.occurred_at=ap.decided_at) AS allocation_confirmation_id,
      e.id AS ent_id,e.fact_kind AS ent_kind,e.amount::text AS ent_amount,e.actor_user_id AS ent_actor,
      e.occurred_at AS ent_occurred,e.idempotency_key AS ent_key,
      (c.occurred_at>f.derived_at) AS source_after_earning,
      (e.occurred_at>=c.occurred_at) AS entitlement_after_source
    FROM handyman_ledger_corrections c
    JOIN handyman_entitlement_facts f ON f.id=$3
    LEFT JOIN handyman_charge_lines l ON l.id=c.source_charge_line_id AND l.transaction_id=c.transaction_id
    LEFT JOIN handyman_customer_payments p ON p.id=c.source_payment_id AND p.transaction_id=c.transaction_id AND p.client_id=c.client_id
    LEFT JOIN handyman_payment_allocations al ON al.id=c.source_allocation_id AND al.transaction_id=c.transaction_id AND al.client_id=c.client_id
    LEFT JOIN handyman_charge_lines al_line ON al_line.id=al.charge_line_id AND al_line.transaction_id=c.transaction_id
    LEFT JOIN handyman_customer_payments ap ON ap.id=al.payment_id AND ap.transaction_id=c.transaction_id AND ap.client_id=c.client_id
    LEFT JOIN handyman_entitlement_corrections e ON e.entitlement_id=f.id AND e.ledger_correction_id=c.id
    WHERE c.transaction_id=$1 AND c.client_id=$2 ORDER BY c.id`, [a.transactionId,a.clientId,a.entitlementId])).rows;
  const facts = (await tx.query(`SELECT id,ledger_correction_id,fact_kind,amount::text AS amount,
      actor_user_id,occurred_at,idempotency_key,
      to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_occurred_at
    FROM handyman_entitlement_corrections WHERE entitlement_id=$1 ORDER BY occurred_at,id`, [a.entitlementId])).rows;
  const fingerprint = (r: any) => [r.correction_kind,r.source_kind,
    r.source_payment_id ?? r.source_allocation_id ?? r.source_charge_line_id ?? r.transaction_id,r.amount].join(':');
  const counts = new Map<string,number>();
  for (const r of rows) counts.set(fingerprint(r),(counts.get(fingerprint(r)) ?? 0)+1);
  const exactTimes = new Map<string,number>();
  for (const f of facts) exactTimes.set(f.exact_occurred_at,(exactTimes.get(f.exact_occurred_at) ?? 0)+1);
  const entChecks = new Map<string,string[]>();
  const rowByEntitlementCorrection = new Map<string,any>(rows.filter(r => r.ent_id).map(r => [r.ent_id,r]));
  let remainingRecorded = cents(a.commissionGross), previousUnresolved = false, reversed = false;
  for (const f of facts) {
    const r = rowByEntitlementCorrection.get(f.id), reasons: string[] = [];
    if (!r) reasons.push('ENTITLEMENT_CAUSE_UNLINKED_OR_CROSS_TRANSACTION');
    else {
      if (!ledgerSource(r,original).valid) reasons.push('LEDGER_SOURCE_UNVERIFIED');
      if (r.currency !== a.currency || r.correction_kind !== 'ADJUSTMENT' || r.source_kind !== 'CHARGE_LINE' ||
          r.line_tx !== a.transactionId || r.line_client !== a.clientId || r.line_currency !== a.currency || r.charge_kind !== 'LABOR')
        reasons.push('COMMISSION_CAUSE_OR_LABOR_BASIS_UNPROVEN');
      if (!r.source_after_earning || !r.entitlement_after_source) reasons.push('CORRECTION_CHRONOLOGY_UNPROVEN');
      if ((counts.get(fingerprint(r)) ?? 0) > 1) reasons.push('POSSIBLE_DUPLICATE_ECONOMIC_CAUSE');
    }
    if (f.fact_kind === 'ADJUSTED_INCREASE') reasons.push('CORRECTION_DIRECTION_MISMATCH');
    if (original.bindingStatus !== 'VERIFIED_HISTORICAL_BINDING') reasons.push('BENEFICIARY_COVERAGE_UNVERIFIED');
    if ((exactTimes.get(f.exact_occurred_at) ?? 0) > 1) reasons.push('CORRECTION_ORDER_UNPROVEN');
    if (previousUnresolved) reasons.push('PRIOR_CORRECTION_UNRESOLVED');
    if (reversed) reasons.push('CORRECTION_AFTER_REVERSAL_UNSUPPORTED');
    const magnitude = cents(f.amount);
    if (!previousUnresolved && !reversed && f.fact_kind !== 'ADJUSTED_INCREASE') {
      if (magnitude > remainingRecorded) reasons.push('RECORDED_COMMISSION_EXCEEDS_PRIOR_BALANCE');
      else if (f.fact_kind === 'REVERSED' && magnitude !== remainingRecorded) reasons.push('REVERSAL_AMOUNT_MISMATCH');
      else if (f.fact_kind === 'ADJUSTED_DECREASE' && magnitude === remainingRecorded) reasons.push('REVERSAL_KIND_MISMATCH');
    }
    // A private consistency bound over recorded facts, not a recomputation or
    // published balance. Once a link/order is unresolved no later fact is applied.
    if (reasons.length) previousUnresolved = true;
    else { remainingRecorded -= magnitude; if (f.fact_kind === 'REVERSED') reversed = true; }
    entChecks.set(f.id,reasons);
  }
  const linked = new Set<string>();
  const result: BmLineageLedgerCorrection[] = [];
  for (const r of rows) {
    const {valid,validLine,validAllocation} = ledgerSource(r,original);
    if (!valid) { blockers.push({code:'LEDGER_SOURCE_UNVERIFIED',sourceId:r.id}); continue; }
    const reasons: string[] = [];
    const duplicate = (counts.get(fingerprint(r)) ?? 0) > 1;
    if (duplicate) reasons.push('POSSIBLE_DUPLICATE_ECONOMIC_CAUSE');
    // An amount in 0414 is always a ledger dimension, never a BM fee delta.
    const dimension = r.correction_kind === 'REFUND' ? 'CUSTOMER_REFUND' as const
      : r.correction_kind === 'REVERSAL' && r.source_kind === 'PAYMENT' ? 'PAYMENT_RECORD_REVERSAL' as const
      : r.correction_kind === 'REVERSAL' ? 'ALLOCATION_UNAPPLICATION' as const : 'CHARGE_REDUCTION' as const;
    let ent: BmLineageEntitlementCorrection | null = null;
    if (r.ent_id) {
      linked.add(r.ent_id);
      const entReasons = entChecks.get(r.ent_id) ?? ['ENTITLEMENT_CAUSE_UNLINKED_OR_CROSS_TRANSACTION'];
      ent = {id:r.ent_id,factKind:r.ent_kind,recordedAmount:r.ent_amount,actorUserId:r.ent_actor,
        occurredAt:iso(r.ent_occurred),idempotencyKey:r.ent_key,sourceVersion:'CR-HM-14-PART-02',
        signedRecordedCommissionImpact:entReasons.length ? null : signed(r.ent_amount,true),
        status:entReasons.length ? 'UNRESOLVED' : 'RECORDED_LINKED_FACT',reasons:entReasons};
      for (const reason of entReasons) blockers.push({code:reason,sourceId:r.ent_id});
    }
    // Even a valid ledger event cannot establish if it was included in the
    // original EARNED snapshot; 0416 did not store its constituent ledger IDs.
    blockers.push({code:'LEDGER_BASELINE_OR_COMMISSION_EFFECT_UNPROVEN',sourceId:r.id});
    for (const reason of reasons) blockers.push({code:reason,sourceId:r.id});
    result.push({id:r.id,kind:r.correction_kind,sourceKind:r.source_kind,sourcePaymentId:r.source_payment_id,
      sourceAllocationId:r.source_allocation_id,paymentConfirmationEventId:r.source_kind === 'PAYMENT' ? r.payment_confirmation_id :
        r.source_kind === 'ALLOCATION' ? r.allocation_confirmation_id : null,sourceChargeLineId:r.source_charge_line_id,
      sourceLineKind:r.source_kind === 'CHARGE_LINE' && validLine ? r.charge_kind :
        r.source_kind === 'ALLOCATION' && validAllocation ? r.allocation_kind : null,
      currency:r.currency,amount:r.amount,reason:r.reason,actorUserId:r.corrected_by_user_id,
      idempotencyKey:r.idempotency_key,occurredAt:iso(r.occurred_at),createdAt:iso(r.created_at),
      sourceVersion:'CR-HM-13-PART-06',relationToEarning:'UNKNOWN',
      ledgerImpact:valid ? {dimension,signedAmount:signed(r.amount,true)} : null,
      entitlementCorrection:ent,status:reasons.length ? 'UNRESOLVED' : 'RECORDED_LEDGER_FACT',reasons});
  }
  const unlinked = facts.filter(f => !linked.has(f.id)).map(f => {
    const reasons = entChecks.get(f.id) ?? ['ENTITLEMENT_CAUSE_UNLINKED_OR_CROSS_TRANSACTION'];
    for (const reason of reasons) blockers.push({code:reason,sourceId:f.id});
    return {id:f.id,ledgerCorrectionId:f.ledger_correction_id,factKind:f.fact_kind,recordedAmount:f.amount,
      actorUserId:f.actor_user_id,occurredAt:iso(f.occurred_at),idempotencyKey:f.idempotency_key,
      sourceVersion:'CR-HM-14-PART-02' as const,signedRecordedCommissionImpact:null,status:'UNRESOLVED' as const,
      reasons};
  });
  return {ledgerCorrections:result,unlinkedEntitlementCorrections:unlinked};
}

/** Compare totals only as a warning, never as proof of individual earning-time membership. */
async function currentBasisDiffers(tx: PoolClient, original: BmLineageOriginal): Promise<boolean> {
  const a = original.anchor;
  const row = (await tx.query(`WITH charges AS (
      SELECT COALESCE(SUM(amount) FILTER (WHERE line_kind='LABOR'),0) AS labor,
             COALESCE(SUM(amount) FILTER (WHERE line_kind='MATERIAL'),0) AS material
        FROM handyman_charge_lines WHERE transaction_id=$1 AND client_id=$2
    ), adjustments AS (
      SELECT COALESCE(SUM(c.amount) FILTER (WHERE l.line_kind='LABOR'),0) AS labor,
             COALESCE(SUM(c.amount) FILTER (WHERE l.line_kind='MATERIAL'),0) AS material,
             COALESCE(SUM(c.amount) FILTER (WHERE c.source_kind='TRANSACTION'),0) AS transaction_scope
        FROM handyman_ledger_corrections c LEFT JOIN handyman_charge_lines l
          ON l.id=c.source_charge_line_id AND l.transaction_id=c.transaction_id
       WHERE c.transaction_id=$1 AND c.client_id=$2 AND c.correction_kind='ADJUSTMENT'
    ) SELECT (c.labor-d.labor)::numeric(18,2)::text AS labor,
             (c.material-d.material)::numeric(18,2)::text AS material,
             (c.labor+c.material-d.labor-d.material-d.transaction_scope)::numeric(18,2)::text AS charged,
             d.transaction_scope::numeric(18,2)::text AS transaction_scope
        FROM charges c CROSS JOIN adjustments d`, [a.transactionId,a.clientId])).rows[0];
  return row.labor !== a.laborNet || row.material !== a.materialNet || row.charged !== a.chargedNet ||
    row.transaction_scope !== a.adjustedTransactionScope;
}

function normalize(actorInput: unknown, input: {clientId: string; entitlementId: string}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['clientId','entitlementId'].includes(k)))
    throw pphError('HANDYMAN_PPH_INVALID','Invalid lineage request.',400);
  return {actor:uuid(actorInput,'actorUserId'),clientId:uuid(input.clientId,'clientId'),
    entitlementId:uuid(input.entitlementId,'entitlementId')};
}

/** Re-resolves every source within one active read-only repeatable-read snapshot. */
export async function readHandymanBmCommissionCorrectionLineageInSnapshot(tx: PoolClient, actorInput: string,
  input: {clientId: string; entitlementId: string}): Promise<BmCommissionCorrectionLineage> {
  const n = normalize(actorInput,input);
  const snapshotRequired = () => new AppError({code:ERROR_CODES.HANDYMAN_BM_TAX_PROJECTION_SNAPSHOT_REQUIRED,
    statusCode:409,message:'An active repeatable-read, read-only transaction is required for correction lineage.'});
  if (tx.getTransactionStatus() !== 'T') throw snapshotRequired();
  const mode = (await tx.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`)).rows[0];
  if (tx.getTransactionStatus() !== 'T' || mode.isolation !== 'repeatable read' || mode.read_only !== 'on') throw snapshotRequired();
  return lineageAt(tx,n);
}

/** Internal write-side revalidation: serialize the ledger before reading its immutable facts. */
export async function readHandymanBmCommissionCorrectionLineageInLockedTransaction(tx: PoolClient, actorInput: string,
  input: {clientId: string; entitlementId: string}): Promise<BmCommissionCorrectionLineage> {
  const n=normalize(actorInput,input);
  const required=()=>new AppError({code:ERROR_CODES.HANDYMAN_BM_TAX_PROJECTION_SNAPSHOT_REQUIRED,statusCode:409,
    message:'An active read-committed transaction with a locked ledger is required for correction approval.'});
  if(tx.getTransactionStatus()!=='T') throw required();
  const mode=(await tx.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`)).rows[0];
  if(tx.getTransactionStatus()!=='T' || mode.isolation!=='read committed' || mode.read_only!=='off') throw required();
  const locked=await tx.query(`SELECT t.id FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id
    WHERE f.id=$1 AND f.client_id=$2 FOR UPDATE OF t`,[n.entitlementId,n.clientId]);
  if(!locked.rowCount) throw pphIntegrity();
  return lineageAt(tx,n);
}

async function lineageAt(tx:PoolClient,n:ReturnType<typeof normalize>):Promise<BmCommissionCorrectionLineage> {
  const original = await originalAt(tx,n.actor,n.clientId,n.entitlementId);
  const blockers: BmLineageBlocker[] = [];
  if (original.bindingStatus !== 'VERIFIED_HISTORICAL_BINDING')
    blockers.push({code:'LEGACY_BENEFICIARY_COVERAGE_UNVERIFIED',sourceId:n.entitlementId});
  const basisChanged = await currentBasisDiffers(tx,original);
  if (basisChanged) blockers.push({code:'CURRENT_LEDGER_BASIS_DIFFERS_FROM_EARNED',sourceId:n.entitlementId});
  const rawVariations = await variationsAt(tx,original,blockers);
  const candidateCharges = await candidateChargesAt(tx,original,rawVariations,blockers,basisChanged);
  const corrections = await correctionsAt(tx,original,blockers);
  const chargeIds = new Set(candidateCharges.map(c => c.chargeLineId));
  const correctionIds = new Set(corrections.ledgerCorrections.map(c => c.id));
  const variations = rawVariations.map(v => ({...v,
    candidateChargeLineIds:v.candidateChargeLineIds.filter(id => chargeIds.has(id)),
    candidateLedgerCorrectionIds:v.candidateLedgerCorrectionIds.filter(id => correctionIds.has(id))}));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  blockers.sort((a,b) => compare(a.sourceId,b.sourceId) || compare(a.code,b.code));
  const body = {schema:'HANDYMAN_BM_COMMISSION_CORRECTION_LINEAGE_V1' as const,authority:'READ_ONLY_LINEAGE' as const,
    original,variations,candidateCharges,...corrections,blockers,
    resolution:(blockers.length ? 'UNRESOLVED' : 'NO_CORRECTIONS_OBSERVED') as 'UNRESOLVED' | 'NO_CORRECTIONS_OBSERVED',
    correctedCommission:null,correctedTaxCalculation:'UNSUPPORTED' as const,
    historicalTaxCase:'UNCHANGED' as const,historicalSettlement:'UNCHANGED' as const};
  return {...body,checksumAlgorithm:'SHA-256',checksum:hash(body)};
}

/** This internal domain read does not create or authorize any financial fact. */
export async function readHandymanBmCommissionCorrectionLineage(actor: string,
  input: {clientId: string; entitlementId: string}): Promise<BmCommissionCorrectionLineage> {
  const n = normalize(actor,input),tx = await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readHandymanBmCommissionCorrectionLineageInSnapshot(tx,n.actor,{clientId:n.clientId,entitlementId:n.entitlementId});
    await tx.query('COMMIT'); return result;
  } catch (err) { await tx.query('ROLLBACK').catch(() => undefined); throw err; }
  finally { tx.release(); }
}
