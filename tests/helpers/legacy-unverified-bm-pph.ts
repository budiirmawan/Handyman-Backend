// TEST-ONLY legacy projection. It is explicitly unverified and is not exported by production modules.
import { getPool } from '../../src/database';
import { readHandymanBmCommissionSourceInSnapshot } from '../../src/modules/handyman-pph-calculation/handyman-pph.service';
import { requireApprovedIdentityAtInSnapshot } from '../../src/modules/handyman-tax-identity/handyman-tax-identity.service';
import { resolveHandymanTaxRuleInSnapshot } from '../../src/modules/handyman-tax-rules/handyman-tax-rules.service';
import { calculateBmWithholdingFromResolved, normalizePphInput, pphError, pphIntegrity, uuid } from '../../src/modules/handyman-pph-calculation/handyman-pph-core';
import type { ApprovedBmWithholdingBreakdown, CalculateApprovedBmWithholdingInput } from '../../src/modules/handyman-pph-calculation';
const iso=(d:Date)=>d.toISOString();
const stale=()=>pphError('HANDYMAN_PPH_SOURCE_STALE','Source changed.');

/** Shared immutable snapshot of source, Building authority, approved identity and exact approved rule. */
export async function calculateUnverifiedBmWithholding(actorInput: string,
  input: CalculateApprovedBmWithholdingInput): Promise<ApprovedBmWithholdingBreakdown> {
  const actor=uuid(actorInput,'actorUserId'), n=normalizePphInput(input), tx=await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const readAt=iso((await tx.query("SELECT date_trunc('milliseconds',transaction_timestamp()) AS read_at")).rows[0].read_at);
    const source=await readHandymanBmCommissionSourceInSnapshot(tx,actor,n.clientId,n.entitlementId);
    if (source.checksum !== n.sourceChecksum || source.commissionGross !== n.commissionGross) throw stale();
    if (n.beneficiary.owner.kind !== 'BM_BENEFICIARY' || n.beneficiary.owner.counterpartyId !== source.beneficiary.counterpartyId)
      throw pphError('HANDYMAN_PPH_IDENTITY_MISMATCH','The pinned identity is not the exact verified BM beneficiary.');
    const identity=await requireApprovedIdentityAtInSnapshot(tx,actor,n.beneficiary.owner,n.taxPointAt);
    const cutoff=new Date(Math.min(Date.parse(readAt),Date.parse(n.taxPointAt))).toISOString();
    const rule=await resolveHandymanTaxRuleInSnapshot(tx,actor,{ clientId:n.clientId,transactionContext:'BM_COMMISSION',
      taxCode:'PPH_WITHHOLDING',taxpayerClassification:n.taxpayerClassification,taxDate:n.taxDate,knownAt:cutoff });
    if (rule.status === 'MISSING') throw pphError('HANDYMAN_PPH_MISSING_RULE','No exact withholding rule exists for this classification and date.');
    if (rule.status === 'AMBIGUOUS') throw pphError('HANDYMAN_PPH_AMBIGUOUS_RULE','More than one withholding rule matches this classification and date.');
    if (rule.status === 'NOT_APPROVED') throw pphError('HANDYMAN_PPH_NOT_APPROVED','The withholding rule was not approved by the required instant.');
    if (rule.status === 'INTEGRITY_ERROR') throw pphIntegrity();
    if (rule.status !== 'APPROVED') throw pphError('HANDYMAN_PPH_NOT_APPROVED','The withholding rule is not approved.');
    const result=calculateBmWithholdingFromResolved(n,source,identity,rule,readAt);
    await tx.query('COMMIT'); return result;
  } catch (err) { await tx.query('ROLLBACK').catch(()=>undefined); throw err; }
  finally { tx.release(); }
}
