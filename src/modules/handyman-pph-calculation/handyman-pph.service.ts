import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { permissionRepository } from '../permissions';
import { resolveHandymanBmBuildingCoverageInSnapshot } from '../handyman-bm-binding/handyman-bm-binding.service';
import { calculateBmWithholdingFromResolved, cents, decimal, hash, pphError, pphIntegrity, uuid } from './handyman-pph-core';
import type { BmCommissionSource, VerifiedBmWithholdingBreakdown } from './handyman-pph.types';
import type { BmVerifiedCalculationInput } from '../handyman-bm-tax-case';

const iso = (d: Date): string => d.toISOString();
const maybeIso = (d: Date | null): string | null => d ? iso(d) : null;
const missing = () => pphError('HANDYMAN_PPH_SOURCE_NOT_FOUND', 'No eligible commission source exists in this Client.', 404);
const stale = () => pphError('HANDYMAN_PPH_SOURCE_STALE', 'The pinned commission source or its ledger basis has changed.');
const corrected = () => pphError('HANDYMAN_PPH_CORRECTION_UNSUPPORTED', 'Corrected entitlement projections require a separately governed calculation.');

async function financeRead(tx: PoolClient, actor: string): Promise<void> {
  const user = await tx.query('SELECT status FROM users WHERE id=$1', [actor]);
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actor,tx);
  if (user.rows[0]?.status !== 'ACTIVE' || !permissions.includes('handyman.finance.read'))
    throw new AppError({ code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'An active authenticated Finance reader is required.' });
}
function commercialFee(basis: bigint, percentage: string): bigint {
  if (typeof percentage !== 'string' || !/^(?:0?\d{1,2}|100)\.\d{4}$/.test(percentage)) throw pphIntegrity();
  const [whole,fraction] = percentage.split('.'), scaled = BigInt(whole)*10000n + BigInt(fraction);
  if (scaled <= 0n || scaled > 1000000n) throw pphIntegrity();
  return (basis * scaled + 500000n) / 1000000n;
}

/** Read only. This includes all charge/adjustment IDs in the source checksum, not merely their net sum. */
async function ledgerBasis(tx: PoolClient, transactionId: string, currency: string) {
  const charges = (await tx.query(`SELECT id, quotation_line_id, line_kind, currency, amount::text AS amount
    FROM handyman_charge_lines WHERE transaction_id=$1 ORDER BY id`, [transactionId])).rows;
  const adjustments = (await tx.query(`SELECT id, source_kind, source_charge_line_id, currency, amount::text AS amount
    FROM handyman_ledger_corrections WHERE transaction_id=$1 AND correction_kind='ADJUSTMENT' ORDER BY id`, [transactionId])).rows;
  if (!charges.length) throw pphIntegrity();
  let labor = 0n, material = 0n, laborAdjust = 0n, materialAdjust = 0n, transactionAdjust = 0n;
  const kinds = new Map<string,string>();
  for (const row of charges) {
    if (row.currency !== currency || !['LABOR','MATERIAL'].includes(row.line_kind)) throw pphIntegrity();
    kinds.set(row.id,row.line_kind);
    if (row.line_kind === 'LABOR') labor += cents(row.amount); else material += cents(row.amount);
  }
  for (const row of adjustments) {
    if (row.currency !== currency) throw pphIntegrity();
    const amount = cents(row.amount);
    if (row.source_kind === 'TRANSACTION' && row.source_charge_line_id === null) transactionAdjust += amount;
    else if (row.source_kind === 'CHARGE_LINE' && kinds.get(row.source_charge_line_id) === 'LABOR') laborAdjust += amount;
    else if (row.source_kind === 'CHARGE_LINE' && kinds.get(row.source_charge_line_id) === 'MATERIAL') materialAdjust += amount;
    else throw pphIntegrity();
  }
  if (laborAdjust > labor || materialAdjust > material || labor + material < laborAdjust + materialAdjust + transactionAdjust) throw pphIntegrity();
  const ledgerBasisDigest = hash({ schema:'HANDYMAN_BM_LEDGER_BASIS_V1', transactionId, charges, adjustments });
  return { ledgerBasisDigest, laborNet:decimal(labor-laborAdjust), materialNet:decimal(material-materialAdjust),
    chargedNet:decimal(labor+material-laborAdjust-materialAdjust-transactionAdjust), adjustedTransactionScope:decimal(transactionAdjust) };
}

/** Snapshot establishes the exact original entitlement, verified Building and commercial authority. */
export async function readHandymanBmCommissionSourceInSnapshot(tx: PoolClient, actor: string, clientId: string, entitlementId: string): Promise<BmCommissionSource> {
  await financeRead(tx,actor);
  const rows = await tx.query(`SELECT f.*, s.client_id AS scope_client_id, s.building_id AS scope_building_id,
      t.client_id AS transaction_client_id, t.execution_scope_id AS transaction_scope_id,
      t.currency AS transaction_currency, t.created_at AS transaction_created_at,
      term.rate_percent::text AS actual_term_rate,
      fb.basis_ex_vat::text AS fiscal_basis, fb.tenant_profile_id AS fiscal_tenant_profile_id,
      fb.bm_profile_id AS fiscal_bm_profile_id
    FROM handyman_entitlement_facts f
    JOIN handyman_execution_scopes s ON s.id=f.execution_scope_id
    JOIN handyman_customer_transactions t ON t.id=f.transaction_id
    JOIN handyman_bm_fee_term_definitions term ON term.id=f.bm_term_id
    LEFT JOIN handyman_bm_fee_fiscal_bases fb ON fb.entitlement_id=f.id
    WHERE f.id=$1 AND f.client_id=$2`, [entitlementId,clientId]);
  if (rows.rowCount !== 1) throw missing();
  const f = rows.rows[0];
  await assertBuildingScopedResourceAccess(actor,{clientId,buildingId:f.scope_building_id},tx);
  if (f.entitlement_kind !== 'BM_FEE' || f.fact_state !== 'EARNED' || f.basis_kind !== 'LABOR_ONLY' ||
      f.ledger_contract_version !== 'CR-HM-13-PART-06' || f.currency !== 'IDR' ||
      f.scope_client_id !== clientId || f.transaction_client_id !== clientId ||
      f.transaction_scope_id !== f.execution_scope_id || f.transaction_currency !== f.currency ||
      iso(f.transaction_created_at) !== iso(f.ledger_posted_at)) throw pphIntegrity();
  if ((await tx.query('SELECT 1 FROM handyman_entitlement_corrections WHERE entitlement_id=$1 LIMIT 1',[entitlementId])).rowCount) throw corrected();
  const ledger = await ledgerBasis(tx,f.transaction_id,f.currency);
  if (ledger.laborNet !== f.labor_net || ledger.materialNet !== f.material_net || ledger.chargedNet !== f.charged_net ||
      ledger.adjustedTransactionScope !== f.adjusted_transaction_scope) throw stale();
  const gross = cents(f.amount), labor = cents(f.labor_net), charged = cents(f.charged_net);
  if (gross > labor || gross > charged || f.actual_term_rate !== f.bm_term_rate_percent) throw pphIntegrity();
  const basis = f.fiscal_basis ?? f.labor_net;
  if (commercialFee(cents(basis),f.actual_term_rate) !== gross) throw pphIntegrity();
  const cov = await resolveHandymanBmBuildingCoverageInSnapshot(tx,clientId,f.scope_building_id,iso(f.ledger_posted_at));
  if (cov.clientId !== clientId || cov.buildingId !== f.scope_building_id || cov.agreementId !== f.agreement_id ||
      cov.agreementVersionId !== f.agreement_version_id || cov.agreementVersionNumber !== f.agreement_version_number ||
      iso(cov.agreementEffectiveFrom) !== iso(f.agreement_effective_from) ||
      cov.ruleId !== f.bm_rule_id || cov.termId !== f.bm_term_id ||
      (f.agreement_effective_to && (!cov.agreementEffectiveTo || cov.agreementEffectiveTo > f.agreement_effective_to))) throw pphIntegrity();
  const distinct = f.bm_beneficiary_kind === 'BM_LEGAL_COUNTERPARTY';
  if (distinct) {
    if (cov.beneficiaryKind !== 'BM_LEGAL_COUNTERPARTY' || cov.representedClientId !== null || cov.beneficiaryDefinitionId !== null ||
        f.bm_beneficiary_id !== null || f.bm_beneficiary_reference_id !== null || f.fiscal_basis !== null ||
        f.bm_counterparty_id !== cov.counterpartyId || f.bm_building_id !== cov.buildingId || f.bm_coverage_id !== cov.id ||
        f.bm_verification_id !== cov.verificationId || iso(f.bm_coverage_effective_from) !== iso(cov.effectiveFrom) ||
        (f.bm_coverage_effective_to && (!cov.effectiveTo || cov.effectiveTo > f.bm_coverage_effective_to))) throw pphIntegrity();
  } else if (f.bm_beneficiary_kind !== null || cov.beneficiaryKind !== 'CLIENT_ORGANIZATION' ||
      cov.representedClientId !== clientId || cov.beneficiaryDefinitionId !== f.bm_beneficiary_id ||
      f.bm_beneficiary_reference_id !== clientId) throw pphIntegrity();
  // Hash immutable party/verification evidence without returning registration or taxpayer identifiers.
  const anchors=(await tx.query(`SELECT p.created_by_user_id AS party_author,p.created_at AS party_created,
      v.evidence_reference,v.verified_by_user_id,v.verified_at,c.created_at <= f.derived_at AS coverage_existed_at_earning
    FROM handyman_bm_legal_counterparties p JOIN handyman_bm_counterparty_verifications v ON v.counterparty_id=p.id
    JOIN handyman_bm_building_coverages c ON c.counterparty_id=p.id AND c.verification_id=v.id
    JOIN handyman_entitlement_facts f ON f.id=$5
    WHERE p.id=$1 AND p.client_id=$2 AND v.id=$3 AND c.id=$4`,[cov.counterpartyId,clientId,cov.verificationId,cov.id,entitlementId])).rows;
  if (anchors.length !== 1 || anchors[0].coverage_existed_at_earning !== true || iso(anchors[0].verified_at) !== iso(cov.verifiedAt)) throw pphIntegrity();
  const a=anchors[0];
  const counterpartyChecksum=hash({ schema:'HANDYMAN_BM_COUNTERPARTY_ANCHOR_V1',id:cov.counterpartyId,clientId,
    legalName:cov.legalName,registrationNumber:cov.registrationNumber,representedClientId:cov.representedClientId,
    createdByUserId:a.party_author,createdAt:iso(a.party_created) });
  const verificationChecksum=hash({ schema:'HANDYMAN_BM_VERIFICATION_ANCHOR_V1',id:cov.verificationId,counterpartyId:cov.counterpartyId,
    evidenceReference:a.evidence_reference,verifiedByUserId:a.verified_by_user_id,verifiedAt:iso(a.verified_at) });
  const coverageChecksum=hash({ schema:'HANDYMAN_BM_COVERAGE_ANCHOR_V1',id:cov.id,clientId,buildingId:cov.buildingId,
    agreementVersionId:cov.agreementVersionId,counterpartyId:cov.counterpartyId,verificationId:cov.verificationId,
    beneficiaryKind:cov.beneficiaryKind,beneficiaryDefinitionId:cov.beneficiaryDefinitionId,effectiveFrom:iso(cov.effectiveFrom),
    declaredEffectiveTo:maybeIso(cov.originalEffectiveTo),createdByUserId:cov.createdByUserId,createdAt:iso(cov.createdAt) });
  const agreement={ id:cov.agreementId,versionId:cov.agreementVersionId,versionNumber:cov.agreementVersionNumber,
    effectiveFrom:iso(f.agreement_effective_from),effectiveToAtEarning:maybeIso(f.agreement_effective_to),ruleId:cov.ruleId,termId:cov.termId };
  const agreementChecksum=hash({ schema:'HANDYMAN_BM_COMMERCIAL_ANCHOR_V1',clientId,...agreement,ratePercent:f.actual_term_rate });
  const body = Object.freeze({ schema:'HANDYMAN_BM_COMMISSION_SOURCE_V1' as const, clientId,buildingId:cov.buildingId,
    executionScopeId:f.execution_scope_id,transactionId:f.transaction_id,entitlementId:f.id,
    ledgerContractVersion:'CR-HM-13-PART-06' as const,ledgerPostedAt:iso(f.ledger_posted_at),derivedAt:iso(f.derived_at),
    derivedByUserId:f.derived_by_user_id as string,currency:'IDR' as const,commissionBasis:'EARNED_BM_COMMISSION' as const,commissionGross:f.amount as string,
    laborNet:f.labor_net as string,materialNet:f.material_net as string,chargedNet:f.charged_net as string,
    adjustedTransactionScope:f.adjusted_transaction_scope as string,commercialBasis:basis as string,
    commercialBasisSource:f.fiscal_basis === null ? 'LEDGER_LABOR_NET' as const : 'EXISTING_FISCAL_BASIS' as const,
    commercialFiscalBasis:f.fiscal_basis === null ? null : Object.freeze({ tenantProfileId:f.fiscal_tenant_profile_id as string,bmProfileId:f.fiscal_bm_profile_id as string }),
    commercialRatePercent:f.actual_term_rate as string,ledgerBasisDigest:ledger.ledgerBasisDigest,
    agreement:Object.freeze({ ...agreement,anchorChecksum:agreementChecksum }),
    beneficiary:Object.freeze({ kind:cov.beneficiaryKind,counterpartyId:cov.counterpartyId,counterpartyChecksum,
      verificationId:cov.verificationId,verificationChecksum,verifiedAt:iso(cov.verifiedAt),
      beneficiaryDefinitionId:cov.beneficiaryDefinitionId,representedClientId:cov.representedClientId }),
    coverage:Object.freeze({ id:cov.id,effectiveFrom:iso(cov.effectiveFrom),declaredEffectiveTo:maybeIso(cov.originalEffectiveTo),
      effectiveToAtEarning:distinct ? maybeIso(f.bm_coverage_effective_to) : null,immutableChecksum:coverageChecksum }) });
  return Object.freeze({ ...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body) });
}

/** Read and pin an existing, uncorrected EARNED BM commission; this never creates one. */
export async function readHandymanBmCommissionSource(actorInput: string, input: { clientId: string; entitlementId: string }): Promise<BmCommissionSource> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['clientId','entitlementId'].includes(k)))
    throw pphError('HANDYMAN_PPH_INVALID','Invalid source request.',400);
  const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId'),entitlementId=uuid(input.entitlementId,'entitlementId');
  const tx = await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const source=await readHandymanBmCommissionSourceInSnapshot(tx,actor,clientId,entitlementId);
    await tx.query('COMMIT'); return source;
  } catch (err) { await tx.query('ROLLBACK').catch(()=>undefined); throw err; }
  finally { tx.release(); }
}

/** Only an independently approved, current case can reach this read-only projection. */
export async function calculateApprovedHandymanBmWithholding(actorInput: string, input: BmVerifiedCalculationInput): Promise<VerifiedBmWithholdingBreakdown> {
  const actor = uuid(actorInput,'actor');
  const {normalizeBmVerifiedCalculationInput}=await import('../handyman-bm-tax-case/handyman-bm-tax-case.service');
  const n=normalizeBmVerifiedCalculationInput(input), tx=await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await calculateApprovedHandymanBmWithholdingInSnapshot(tx,actor,n);
    await tx.query('COMMIT');return result;
  } catch (err) { await tx.query('ROLLBACK').catch(()=>undefined);throw err; }
  finally { tx.release(); }
}

/** Internal only: caller must hold one repeatable-read, read-only transaction. */
export async function calculateApprovedHandymanBmWithholdingInSnapshot(tx:PoolClient,actor:string,input:BmVerifiedCalculationInput):Promise<VerifiedBmWithholdingBreakdown> {
  const {requireApprovedBmTaxCaseInSnapshot}=await import('../handyman-bm-tax-case/handyman-bm-tax-case.service');
  const verified=await requireApprovedBmTaxCaseInSnapshot(tx,actor,input);
  const pure=calculateBmWithholdingFromResolved(verified.pphInput,verified.source,verified.pphBeneficiary,verified.pphRule,verified.readAt);
  const {schema:_schema,caseApplicability:_unverified,checksumAlgorithm:_algorithm,checksum:_checksum,...rest}=pure;
  const body=Object.freeze({...rest,schema:'HANDYMAN_VERIFIED_BM_PPH_WITHHOLDING_V1' as const,
    caseApplicability:'INDEPENDENTLY_FINANCE_APPROVED' as const,determination:verified.reference});
  return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
}
