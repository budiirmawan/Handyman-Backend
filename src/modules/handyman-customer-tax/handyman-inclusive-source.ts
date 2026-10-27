import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { createHash } from 'node:crypto';
import { handymanScopeVariationRepository } from '../handyman-scope-variations/handyman-scope-variation.repository';
import { addLaborBindingFromEvents, addMaterialBindingFromEvents, assertPinnedVariationApproval } from '../handyman-scope-variations/handyman-scope-variation-material-authority';
import { validateHandymanTaxFacts } from '../handyman-pricing-contract/handyman-indonesia-tax';

const digest = (v: unknown) => createHash('sha256').update(stableJson(v)).digest('hex');
const conflict = (message: string): never => { throw new AppError({ code: 'HANDYMAN_FINANCIAL_RECONCILIATION_CONFLICT', statusCode: 409, message }); };
const whole = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})\.00$/.test(value))
    return conflict('Inclusive invoice tax requires exact whole-rupiah source amounts.');
  return BigInt(value.slice(0, -3));
};
const amount = (value: bigint): string => {
  if (value < 0n || value > 9_999_999_999_999_999n) return conflict('Inclusive commercial total is out of range.');
  return `${value}.00`;
};

export type InclusiveCommercialSource = Readonly<{
  schema: 'HANDYMAN_INCLUSIVE_COMMERCIAL_SOURCE_V1';
  clientId: string; buildingId: string; requestId: string; executionScopeId: string; tenantCompanyId: string;
  transactionId: string; quotationId: string; quotationVersionId: string; quotationDecisionId: string;
  quotationDecisionFingerprint: string; currency: 'IDR';
  profiles: ReadonlyArray<Readonly<{ id: string; quotationVersionId: string; digest: string; providerStatus: 'PKP'|'NON_PKP' }>>;
  lines: ReadonlyArray<Readonly<{
    chargeLineId: string; quotationLineId: string; quotationVersionId: string; chargeBasisId: string;
    lineKind: 'LABOR'|'MATERIAL'; quantity: string; unitAmount: string; quotedAmount: string; chargeAmount: string;
    compositionKind: string; grossAmount: string; addVariationId: string | null;
    reductions: ReadonlyArray<Readonly<{ bindingId: string; variationId: string; approvedVersion: number;
      decisionEventId: string; authorizationEventId: string; revisedQuotationVersionId: string;
      correctionId: string | null; amount: string }>>;
  }>>;
  additions: ReadonlyArray<Readonly<{ variationId: string; approvedVersion: number; revisedQuotationVersionId: string;
    quotationLineId: string; revisionEventId: string; decisionEventId: string; authorizationEventId: string }>>;
  grossAmount: string;
}>;

/**
 * Source-only projection: no invoicing, payments, PPN, or writes. Every
 * original quotation line and approved ADD must already have a full matching
 * charge. Only exact REDUCE bindings may reduce it; unexplained, transaction-
 * level, inspection and fiscal-credit adjustments need separate reconciliation.
 * Must be called in the caller's single database snapshot.
 */
export async function readInclusiveCommercialSource(tx: PoolClient, clientId: string, requestId: string,
  executionScopeId: string, taxDate: string): Promise<InclusiveCommercialSource> {
  const scope = (await tx.query(`SELECT s.id,s.client_id,s.building_id,s.handyman_request_id,s.tenant_company_id,
      s.quotation_id,s.approved_quotation_version_id,s.quotation_decision_id,t.id AS transaction_id,t.currency,
      d.request_fingerprint
    FROM handyman_execution_scopes s
    JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id
      AND r.building_id=s.building_id AND r.tenant_company_id=s.tenant_company_id
    JOIN handyman_quotations q ON q.id=s.quotation_id AND q.client_id=s.client_id AND q.handyman_request_id=s.handyman_request_id
    JOIN handyman_quotation_versions v ON v.id=s.approved_quotation_version_id AND v.quotation_id=q.id
    JOIN handyman_quotation_decisions d ON d.id=s.quotation_decision_id AND d.client_id=s.client_id
      AND d.quotation_id=q.id AND d.quotation_version_id=v.id AND d.tenant_company_id=s.tenant_company_id AND d.decision='APPROVE'
    JOIN handyman_customer_transactions t ON t.execution_scope_id=s.id AND t.client_id=s.client_id AND t.quotation_version_id=v.id
    WHERE s.id=$1 AND s.client_id=$2 AND s.handyman_request_id=$3`, [executionScopeId, clientId, requestId])).rows[0];
  if (!scope || scope.currency !== 'IDR') return conflict('The exact approved quotation and IDR customer transaction are required.');

  const original = (await tx.query<{ id: string }>('SELECT id FROM handyman_quotation_lines WHERE quotation_version_id=$1 ORDER BY id',
    [scope.approved_quotation_version_id])).rows;
  if (!original.length) return conflict('The approved quotation contains no billable source lines.');
  const expected = new Set(original.map(x => x.id));
  const versions = new Set<string>([scope.approved_quotation_version_id]);
  const variations = await handymanScopeVariationRepository.listByExecutionScope(executionScopeId, tx);
  const approved = variations.filter(v => v.tenantDecisionOutcome === 'APPROVED');
  const additions: InclusiveCommercialSource['additions'][number][] = [];
  const reductionByCharge = new Map<string, InclusiveCommercialSource['lines'][number]['reductions'][number][]>();
  const correctionIds = new Set<string>();

  for (const v of approved) {
    if (v.clientId !== clientId || v.buildingId !== scope.building_id || v.handymanRequestId !== requestId ||
        v.tenantCompanyId !== scope.tenant_company_id || !v.revisedQuotationVersionId ||
        !['AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY'].includes(v.status))
      return conflict('An approved variation is not yet exactly authorized for this commercial source.');
    const events = await handymanScopeVariationRepository.listEventsByVariation(v.id, tx);
    const decisions = events.filter(e => e.eventType === 'TENANT_DECISION');
    const authorizations = events.filter(e => e.eventType === 'AUTHORIZED_SCOPE');
    const revisions = events.filter(e => e.eventType === 'REVISED_QUOTATION' && e.actorRole === 'OPERATIONS_MANAGER');
    const approvedVersion = (decisions[0]?.metadata.consentSnapshot as { version?: unknown } | undefined)?.version;
    if (decisions.length !== 1 || authorizations.length !== 1 || revisions.length !== 1 ||
        authorizations[0].actorRole !== 'OPERATIONS_MANAGER' || authorizations[0].fromStatus !== 'TENANT_DECISION' ||
        typeof approvedVersion !== 'number' || !Number.isSafeInteger(approvedVersion) || approvedVersion < 1 || approvedVersion >= v.version)
      return conflict('The exact variation decision and Operations authorization are required.');
    await assertPinnedVariationApproval(tx, v, approvedVersion, events);
    const revision = (await tx.query(`SELECT 1 FROM handyman_quotation_versions x JOIN handyman_quotation_versions o
      ON o.id=$2 AND o.quotation_id=x.quotation_id WHERE x.id=$1 AND x.quotation_id=$3
      AND x.version_number>o.version_number AND x.status IN ('ISSUED','APPROVED','SUPERSEDED')`,
    [v.revisedQuotationVersionId, scope.approved_quotation_version_id, scope.quotation_id])).rowCount;
    if (!revision) return conflict('The approved variation quotation is outside the original quotation thread.');
    versions.add(v.revisedQuotationVersionId);

    if (v.variationType === 'ADD') {
      if (v.status !== 'FINAL_CHARGE_ELIGIBILITY' || !v.finalChargeEligible)
        return conflict('An approved ADD is not yet final-charge eligible.');
      const binding = addMaterialBindingFromEvents(v, events) ?? addLaborBindingFromEvents(v, events);
      if (!binding || expected.has(binding.revisedQuotationLineId)) return conflict('The ADD must pin one distinct approved revised line.');
      const exact = (await tx.query(`SELECT 1 FROM handyman_scope_variations x JOIN handyman_quotation_lines q
        ON q.id=$2 AND q.quotation_version_id=x.revised_quotation_version_id AND q.line_type=x.line_type
        AND q.quantity=x.quantity AND q.uom_id=x.uom_id AND q.final_quoted_unit_amount=x.quoted_unit_amount
        AND q.currency=x.currency AND q.line_total=x.quoted_total_delta
        WHERE x.id=$1 AND x.variation_type='ADD' AND x.quoted_total_delta>=0`, [v.id, binding.revisedQuotationLineId])).rowCount;
      if (!exact) return conflict('The ADD amount and exact approved quotation line do not match.');
      expected.add(binding.revisedQuotationLineId);
      additions.push({ variationId:v.id, approvedVersion, revisedQuotationVersionId:v.revisedQuotationVersionId,
        quotationLineId:binding.revisedQuotationLineId, revisionEventId:revisions[0].id, decisionEventId:decisions[0].id,
        authorizationEventId:authorizations[0].id });
    } else {
      const row = (await tx.query(`SELECT b.id,b.charge_line_id,b.correction_id,b.approved_variation_version,
          b.decision_event_id,b.authorization_event_id,b.revised_quotation_version_id,(-b.signed_amount)::numeric(18,2)::text AS amount,
          (b.client_id=$2 AND b.building_id=$3 AND b.execution_scope_id=$4 AND b.transaction_id=$5
           AND b.original_quotation_version_id=$6 AND b.revised_quotation_version_id=x.revised_quotation_version_id
           AND b.quotation_line_id=x.target_quotation_line_id AND b.approved_quantity=x.quantity
           AND b.approved_unit_amount=x.quoted_unit_amount AND b.currency=x.currency AND b.currency='IDR'
           AND b.signed_amount=x.quoted_total_delta AND b.signed_amount<=0 AND b.variation_version<=x.version
           AND l.id=b.charge_line_id AND l.transaction_id=b.transaction_id AND l.quotation_line_id=b.quotation_line_id
           AND ((b.signed_amount=0 AND b.correction_id IS NULL) OR
             (b.signed_amount<0 AND c.id=b.correction_id AND c.transaction_id=b.transaction_id
              AND c.correction_kind='ADJUSTMENT' AND c.source_kind='CHARGE_LINE'
              AND c.source_charge_line_id=l.id AND c.amount=-b.signed_amount AND c.currency='IDR'))) AS valid
        FROM handyman_reduce_financial_corrections b JOIN handyman_scope_variations x ON x.id=b.variation_id
        JOIN handyman_charge_lines l ON l.id=b.charge_line_id LEFT JOIN handyman_ledger_corrections c ON c.id=b.correction_id
        WHERE b.variation_id=$1`, [v.id, clientId, scope.building_id, executionScopeId, scope.transaction_id, scope.approved_quotation_version_id])).rows[0];
      if (!row || !row.valid || row.approved_variation_version !== approvedVersion || row.decision_event_id !== decisions[0].id ||
          row.authorization_event_id !== authorizations[0].id || !expected.has(v.targetQuotationLineId!))
        return conflict('Every approved REDUCE must have its exact current signed ledger binding.');
      const entry = {bindingId:row.id, variationId:v.id, approvedVersion, decisionEventId:row.decision_event_id,
        authorizationEventId:row.authorization_event_id, revisedQuotationVersionId:row.revised_quotation_version_id,
        correctionId:row.correction_id as string|null, amount:row.amount as string};
      whole(entry.amount);
      if (entry.correctionId) correctionIds.add(entry.correctionId);
      const list = reductionByCharge.get(row.charge_line_id) ?? []; list.push(entry); reductionByCharge.set(row.charge_line_id, list);
    }
  }
  additions.sort((a,b) => a.variationId.localeCompare(b.variationId));
  const adjustments = (await tx.query<{ id: string }>(`SELECT id FROM handyman_ledger_corrections
    WHERE transaction_id=$1 AND correction_kind='ADJUSTMENT' ORDER BY id`, [scope.transaction_id])).rows;
  if (adjustments.length !== correctionIds.size || adjustments.some(x => !correctionIds.has(x.id)))
    return conflict('Unattributed, transaction-level, inspection or fiscal adjustments require independent tax reconciliation.');

  const profiles: InclusiveCommercialSource['profiles'][number][] = [];
  for (const version of [...versions].sort()) {
    const row = (await tx.query(`SELECT id,facts FROM handyman_financial_tax_profiles WHERE quotation_version_id=$1`, [version])).rows[0];
    if (!row) return conflict('Every approved quotation version requires its own prior reviewed inclusive-price facts.');
    const facts = validateHandymanTaxFacts(row.facts);
    if (facts.priceBasis !== 'GROSS_INCLUSIVE' || taxDate < facts.effectiveFrom || taxDate > facts.effectiveTo)
      return conflict('The approved quotation has no effective inclusive price basis at this tax point.');
    profiles.push({id:row.id, quotationVersionId:version, digest:digest(row.facts), providerStatus:facts.providerStatus});
  }
  const charges = (await tx.query(`SELECT l.id,l.quotation_line_id,l.line_kind,l.currency,l.amount::text AS amount,
      q.quotation_version_id,q.quantity::text AS quantity,q.final_quoted_unit_amount::text AS unit_amount,q.line_total::text AS quoted_amount,
      q.line_type,q.currency AS quote_currency,b.id AS basis_id,b.composition_kind,b.amount::text AS basis_amount,
      b.client_id AS basis_client,b.transaction_id AS basis_transaction,b.quotation_line_id AS basis_line,b.currency AS basis_currency,
      b.line_kind AS basis_kind,b.unit_amount::text AS basis_unit
    FROM handyman_charge_lines l JOIN handyman_quotation_lines q ON q.id=l.quotation_line_id
    JOIN handyman_charge_line_bases b ON b.charge_line_id=l.id WHERE l.transaction_id=$1 AND l.client_id=$2 ORDER BY l.id`,
  [scope.transaction_id, clientId])).rows;
  if (charges.length !== expected.size || charges.some(c => !expected.has(c.quotation_line_id)))
    return conflict('Every original and approved ADD line must have exactly one charge; unrelated or missing lines are not inferred.');
  const lines: InclusiveCommercialSource['lines'][number][] = [];
  let total = 0n;
  for (const c of charges) {
    if (c.currency !== 'IDR' || c.quote_currency !== 'IDR' || c.line_type !== c.line_kind || c.amount !== c.quoted_amount ||
        c.basis_amount !== c.amount || c.basis_client !== clientId || c.basis_transaction !== scope.transaction_id ||
        c.basis_line !== c.quotation_line_id || c.basis_currency !== c.currency || c.basis_kind !== c.line_kind || c.basis_unit !== c.unit_amount)
      return conflict('Partial, mismatched or ungoverned charges need separate commercial reconciliation.');
    const reductions = (reductionByCharge.get(c.id) ?? []).sort((a,b) => a.variationId.localeCompare(b.variationId));
    const net = whole(c.amount) - reductions.reduce((sum,r) => sum + whole(r.amount), 0n);
    if (net < 0n) return conflict('Approved reductions exceed the original charge.');
    total += net;
    const addition = additions.find(a => a.quotationLineId === c.quotation_line_id);
    lines.push({chargeLineId:c.id, quotationLineId:c.quotation_line_id, quotationVersionId:c.quotation_version_id,
      chargeBasisId:c.basis_id, lineKind:c.line_kind, quantity:c.quantity, unitAmount:c.unit_amount,
      quotedAmount:c.quoted_amount, chargeAmount:c.amount, compositionKind:c.composition_kind,
      grossAmount:amount(net), addVariationId:addition?.variationId ?? null, reductions});
  }
  if ([...reductionByCharge.keys()].some(id => !charges.some(c => c.id===id)))
    return conflict('A REDUCE references a missing commercial charge.');
  return {schema:'HANDYMAN_INCLUSIVE_COMMERCIAL_SOURCE_V1',clientId,buildingId:scope.building_id,requestId,
    executionScopeId,tenantCompanyId:scope.tenant_company_id,transactionId:scope.transaction_id,quotationId:scope.quotation_id,
    quotationVersionId:scope.approved_quotation_version_id,quotationDecisionId:scope.quotation_decision_id,
    quotationDecisionFingerprint:scope.request_fingerprint,currency:'IDR',profiles,lines,additions,grossAmount:amount(total)};
}
