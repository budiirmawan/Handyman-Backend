import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { stableJson } from '../src/shared/stable-json';
import { calculatePpnFromResolved, normalizePpnInput } from '../src/modules/handyman-ppn-calculation/handyman-ppn-core';
import type { ApprovedHandymanTaxIdentity, HandymanTaxIdentityOwner } from '../src/modules/handyman-tax-identity';
import type { TaxRuleResolution } from '../src/modules/handyman-tax-rules';
import type { CalculateApprovedPpnInput, PpnApplicability } from '../src/modules/handyman-ppn-calculation';

const id = () => randomUUID();
const hash = (v: unknown) => createHash('sha256').update(stableJson(v)).digest('hex');
const code = (expected: string) => (error: { code?: string }) => { assert.equal(error.code,expected); return true; };
const created = '2025-01-01T00:00:00.000Z', submittedAt = '2025-01-02T00:00:00.000Z', decidedAt = '2025-01-03T00:00:00.000Z';
const point = '2026-03-01T02:00:00.000Z', taxDate = '2026-03-01';
const fullDescription = 'P02A_V1|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN';
const exemptionDescription = 'P02A_V1|APPLICABILITY=EXEMPT|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=0|TOTAL=SOURCE';
const nonTaxDescription = 'P02A_V1|APPLICABILITY=NON_TAXABLE|SOURCE=EXCLUSIVE|DPP=0|PPN=0|TOTAL=SOURCE';
function classification(app: PpnApplicability, reverse = false) {
  const a = app === 'TAXABLE' ? 'TAX' : app === 'EXEMPT' ? 'EXEMPT' : 'NON_TAX';
  const bmPkp = reverse && app === 'TAXABLE';
  return { code:`P02A_${a}_E_${reverse && !bmPkp ? 'N' : 'P'}_E_${reverse || bmPkp ? 'P' : 'N'}_TEST_CASE`,
    description:`P02A_V1|APPLICABILITY=${app}|SUPPLIER=ENTITY,${reverse && !bmPkp ? 'NON_PKP' : 'PKP'}|RECIPIENT=ENTITY,${reverse || bmPkp ? 'PKP' : 'NON_PKP'}|CASE=TEST_CASE` };
}
function identity(clientId: string, ownerKind: 'HANDYMAN_ISSUER'|'BM_BENEFICIARY', pkpStatus: 'PKP'|'NON_PKP', identifierValue: string): ApprovedHandymanTaxIdentity {
  const ownerId = ownerKind === 'HANDYMAN_ISSUER' ? clientId : id(), createdByUserId = id(), profileId = id();
  const snapshot = { schema:'HANDYMAN_TAX_IDENTITY_V1' as const,id:profileId,clientId,ownerKind,ownerId,
    issuerProfileId:ownerKind === 'HANDYMAN_ISSUER' ? id() : null,counterpartyId:ownerKind === 'BM_BENEFICIARY' ? ownerId : null,
    verificationId:ownerKind === 'BM_BENEFICIARY' ? id() : null,version:1,legalName:ownerKind,
    taxpayerKind:'LEGAL_ENTITY' as const,individualResidency:null,identifierKind:'NPWP_15' as const,identifierValue,pkpStatus,
    approvalStatus:'UNAPPROVED' as const,effectiveFrom:created,declaredEffectiveTo:null,evidenceSource:'TEST',evidenceReference:'test/identity',
    createdByUserId,createdAt:created };
  const digest = hash(snapshot), submitId = id(), actor1 = id(), actor2 = id();
  const base = { profileId,clientId,ownerKind,ownerId,profileVersion:1,profileDigest:digest,
    evidenceSource:'TEST',evidenceReference:'test/review',reviewFrom:created,reviewTo:null,approvedFrom:null,approvedTo:null };
  const submission = { ...base,id:submitId,eventType:'SUBMIT' as const,submissionId:null,actorUserId:actor1,occurredAt:submittedAt };
  const decision = { ...base,id:id(),eventType:'APPROVE' as const,submissionId:submitId,actorUserId:actor2,occurredAt:decidedAt,approvedFrom:decidedAt };
  return { snapshot,digestAlgorithm:'SHA-256',digest,effectiveWindow:{from:created,to:null,identityWindowTo:null,issuerProfileSupersededAt:null,closure:null},
    approval:{submission,decision},taxUse:{allowed:true,reason:'FINANCE_APPROVED'} };
}
function approvedRule(clientId: string, taxClass: {code:string;description:string}, options: {
  context?: 'CUSTOMER_SERVICE_BILLING'|'BM_COMMISSION'; method?: string; methodDescription?: string;
  rate?: string; mode?: 'HALF_UP'|'HALF_EVEN'|'DOWN'|'UP'|'NO_ROUNDING'; scale?: number|null;
} = {}): Extract<TaxRuleResolution,{status:'APPROVED'}> {
  const ruleId=id(), createdByUserId=id();
  const snapshot = { schema:'HANDYMAN_TAX_RULE_V1' as const,id:ruleId,clientId,
    transactionContext:options.context ?? 'CUSTOMER_SERVICE_BILLING',taxCode:'PPN' as const,taxpayerClassification:taxClass.code,
    classificationDescription:taxClass.description,version:1,effectiveFrom:'2025-01-01',declaredEffectiveTo:null,
    basisMethodCode:options.method ?? 'PPN02A_EXCLUSIVE_FULL_V1',basisDescription:options.methodDescription ?? fullDescription,
    ratePercent:options.rate ?? '7.500000',roundingMode:options.mode ?? 'HALF_UP',roundingScale:options.scale === undefined ? 0 : options.scale,
    legalReference:'TEST-ONLY reference',legalSource:'TEST-ONLY legal source',evidenceSource:'TEST',evidenceReference:'test/rule',
    createdByUserId,createdAt:created };
  const digest = hash(snapshot), submitId=id();
  const base = { ruleId,clientId,ruleVersion:1,ruleDigest:digest,evidenceSource:'TEST',evidenceReference:'test/rule-review',
    reviewFrom:'2025-01-01',reviewTo:null };
  const submission = { ...base,id:submitId,eventType:'SUBMIT' as const,submissionId:null,sourceValidation:null,actorUserId:id(),occurredAt:submittedAt };
  const decision = { ...base,id:id(),eventType:'APPROVE' as const,submissionId:submitId,sourceValidation:'FINANCE_VALIDATED' as const,actorUserId:id(),occurredAt:decidedAt };
  return {status:'APPROVED',rule:{snapshot,digestAlgorithm:'SHA-256',digest,effectiveWindow:{from:'2025-01-01',to:null,closureId:null}},approval:{submission,decision}};
}
function owner(p: ApprovedHandymanTaxIdentity): HandymanTaxIdentityOwner {
  return p.snapshot.ownerKind === 'HANDYMAN_ISSUER' ? {kind:'HANDYMAN_ISSUER',clientId:p.snapshot.clientId} :
    {kind:'BM_BENEFICIARY',clientId:p.snapshot.clientId,counterpartyId:p.snapshot.ownerId};
}
function command(supplier: ApprovedHandymanTaxIdentity, recipient: ApprovedHandymanTaxIdentity,
  rule: Extract<TaxRuleResolution,{status:'APPROVED'}>, app: PpnApplicability = 'TAXABLE'): CalculateApprovedPpnInput {
  const pin = (p: ApprovedHandymanTaxIdentity) => ({owner:owner(p),profileId:p.snapshot.id,profileVersion:p.snapshot.version,
    profileDigest:p.digest,approvalDecisionId:p.approval.decision.id});
  return { clientId:supplier.snapshot.clientId,transactionContext:rule.rule.snapshot.transactionContext,taxDate,taxPointAt:point,currency:'IDR',
    amountBasis:'PPN_EXCLUSIVE',sourceAmount:'1000.00',applicability:app,taxpayerClassification:rule.rule.snapshot.taxpayerClassification,
    supplier:pin(supplier),recipient:pin(recipient),rule:{ruleId:rule.rule.snapshot.id,ruleVersion:rule.rule.snapshot.version,
      ruleDigest:rule.rule.digest,approvalDecisionId:rule.approval.decision.id} };
}
function setup(app: PpnApplicability = 'TAXABLE', reverse = true, options: Parameters<typeof approvedRule>[2] = {}) {
  const clientId=id(), issuer=identity(clientId,'HANDYMAN_ISSUER','PKP','012345678901001'),
    bm=identity(clientId,'BM_BENEFICIARY',reverse && app === 'TAXABLE' ? 'PKP' : 'NON_PKP','012345678901002');
  const supplier=reverse ? bm : issuer, recipient=reverse ? issuer : bm;
  const cls=classification(app,reverse), rule=approvedRule(clientId,cls,{context:reverse?'BM_COMMISSION':'CUSTOMER_SERVICE_BILLING',...options});
  const input=command(supplier,recipient,rule,app);
  return { supplier,recipient,rule,input,calc:(value=input) => calculatePpnFromResolved(normalizePpnInput(value),supplier,recipient,rule,point) };
}

describe('PART 02A pure PPN/DPP calculation', () => {
  it('uses exact synthetic Finance-approved BM snapshots, emits provenance and replays identically', () => {
    const f = setup(), a = f.calc(), b = f.calc();
    assert.deepEqual(a,b); assert.equal(a.sourceAmount,'1000.00'); assert.equal(a.dppAmount,'1000.00');
    assert.equal(a.ppnRatePercent,'7.500000'); assert.equal(a.ppnAmount,'75.00'); assert.equal(a.totalIncludingPpn,'1075.00');
    assert.equal(a.rule.id,f.rule.rule.snapshot.id); assert.equal(a.rule.digest,f.rule.rule.digest);
    assert.equal(a.rule.approval.decision.id,f.rule.approval.decision.id);
    assert.equal(a.rule.basisDescription,f.rule.rule.snapshot.basisDescription);assert.equal(a.rule.classificationDescription,f.rule.rule.snapshot.classificationDescription);
    assert.equal(a.supplier.profileDigest,f.supplier.digest); assert.equal(a.recipient.approval.decision.id,f.recipient.approval.decision.id);
    assert.equal(a.supplier.evidenceReference,f.supplier.snapshot.evidenceReference);
    assert.equal(a.transactionPartyBinding,'CALLER_SUPPLIED_NOT_VERIFIED');
    const { checksum,checksumAlgorithm,...body } = a; assert.equal(checksumAlgorithm,'SHA-256'); assert.equal(checksum,hash(body));
    assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.rule));
  });
  it('never substitutes a BM identity for an unapproved or unbound customer', () => {
    const hypothetical=setup('TAXABLE',false);
    assert.throws(()=>hypothetical.calc(),code('HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE'));
    const bm=setup(), normalized=normalizePpnInput(bm.input);
    assert.throws(()=>calculatePpnFromResolved({...normalized,transactionContext:'CUSTOMER_SERVICE_BILLING'},bm.supplier,bm.recipient,bm.rule,point),
      code('HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE'));
  });
  it('uses an explicitly approved ratio and rounds DPP before PPN without floating point drift', () => {
    const description='P02A_V1|SOURCE=EXCLUSIVE|DPP=ROUND(SOURCE*5/8)|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN';
    const f = setup('TAXABLE',true,{method:'PPN02A_EXCLUSIVE_RATIO_5_8_V1',methodDescription:description});
    const value=f.calc(); assert.equal(value.dppAmount,'625.00'); assert.equal(value.ppnAmount,'47.00'); assert.equal(value.totalIncludingPpn,'1047.00');
    const huge=f.calc({...f.input,sourceAmount:'9000000000000000.00'});
    assert.equal(huge.dppAmount,'5625000000000000.00');
    assert.equal(huge.totalIncludingPpn,'9421875000000000.00');
  });
  it('implements all authorized rounding modes at whole-rupiah precision and never silently rounds NO_ROUNDING', () => {
    for (const [mode, expected] of [['HALF_UP','3.00'],['HALF_EVEN','2.00'],['DOWN','2.00'],['UP','3.00']] as const) {
      const f=setup('TAXABLE',true,{rate:'2.500000',mode});
      assert.equal(f.calc({...f.input,sourceAmount:'100.00'}).ppnAmount,expected);
    }
    const even=setup('TAXABLE',true,{rate:'3.500000',mode:'HALF_EVEN'});
    assert.equal(even.calc({...even.input,sourceAmount:'100.00'}).ppnAmount,'4.00');
    const exact=setup('TAXABLE',true,{rate:'5.000000',mode:'NO_ROUNDING',scale:null});
    assert.equal(exact.calc({...exact.input,sourceAmount:'100.00'}).ppnAmount,'5.00');
    const inexact=setup('TAXABLE',true,{rate:'2.500000',mode:'NO_ROUNDING',scale:null});
    assert.throws(()=>inexact.calc({...inexact.input,sourceAmount:'100.00'}),code('HANDYMAN_PPN_UNSUPPORTED'));
    const fractional=setup('TAXABLE',true,{scale:2});
    assert.throws(()=>fractional.calc(),code('HANDYMAN_PPN_UNSUPPORTED'));
  });
  it('only applies explicitly approved exemption/non-taxable vocabulary and never assumes a missing rule is zero', () => {
    const exempt=setup('EXEMPT',true,{method:'PPN02A_EXEMPT_FULL_V1',methodDescription:exemptionDescription,rate:'0'});
    assert.equal(exempt.calc().dppAmount,'1000.00'); assert.equal(exempt.calc().ppnAmount,'0.00');
    const non=setup('NON_TAXABLE',true,{method:'PPN02A_NON_TAXABLE_V1',methodDescription:nonTaxDescription,rate:'0.000000'});
    assert.equal(non.calc().dppAmount,'0.00'); assert.equal(non.calc().totalIncludingPpn,'1000.00');
    const zeroTaxable=setup('TAXABLE',true,{rate:'0'}); assert.equal(zeroTaxable.calc().applicability,'TAXABLE');
    const contradictory=setup('EXEMPT',true,{method:'PPN02A_EXEMPT_FULL_V1',methodDescription:exemptionDescription,rate:'1'});
    assert.throws(()=>contradictory.calc(),code('HANDYMAN_PPN_UNSUPPORTED'));
    const unknown=setup('TAXABLE',true,{method:'FINANCE_CUSTOM_METHOD'});
    assert.throws(()=>unknown.calc(),code('HANDYMAN_PPN_UNSUPPORTED'));
    const misleading=setup('TAXABLE',true,{methodDescription:'Unrelated or insufficient formula'});
    assert.throws(()=>misleading.calc(),code('HANDYMAN_PPN_UNSUPPORTED'));
  });
  it('rejects invalid currencies, amounts, precision, dates, inclusivity and overflow', () => {
    const f=setup();
    for (const amount of ['-1.00','1.01','1','01.00','1e2','10000000000000000.00'])
      assert.throws(()=>f.calc({...f.input,sourceAmount:amount}),code('HANDYMAN_PPN_INVALID'));
    assert.throws(()=>f.calc({...f.input,currency:'USD' as 'IDR'}),code('HANDYMAN_PPN_INVALID'));
    assert.throws(()=>f.calc({...f.input,amountBasis:'GROSS_INCLUSIVE' as 'PPN_EXCLUSIVE'}),code('HANDYMAN_PPN_UNSUPPORTED'));
    assert.throws(()=>f.calc({...f.input,taxDate:'2025-02-30'}),code('HANDYMAN_PPN_INVALID'));
    assert.throws(()=>f.calc({...f.input,taxDate:'2026-03-02'}),code('HANDYMAN_PPN_INVALID'));
    assert.throws(()=>f.calc({...f.input,taxPointAt:'2026-03-01T02:00:00'}),code('HANDYMAN_PPN_INVALID'));
    assert.throws(()=>f.calc({...f.input,sourceAmount:'9999999999999999.00'}),code('HANDYMAN_PPN_INVALID'));
  });
  it('fails closed on conflicting applicability, supplier/recipient direction, identities and pins', () => {
    const f=setup();
    assert.throws(()=>f.calc({...f.input,applicability:'EXEMPT'}),code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    assert.throws(()=>f.calc({...f.input,supplier:f.input.recipient,recipient:f.input.supplier}),code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    assert.throws(()=>f.calc({...f.input,recipient:{...f.input.recipient,owner:{kind:'BM_BENEFICIARY',clientId:id(),counterpartyId:id()}}}),code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    assert.throws(()=>f.calc({...f.input,rule:{...f.input.rule,ruleDigest:'0'.repeat(64)}}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    assert.throws(()=>f.calc({...f.input,supplier:{...f.input.supplier,approvalDecisionId:id()}}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    const same=identity(f.input.clientId,'HANDYMAN_ISSUER','PKP',f.supplier.snapshot.identifierValue!);
    assert.throws(()=>calculatePpnFromResolved(normalizePpnInput({...f.input,recipient:{owner:owner(same),profileId:same.snapshot.id,
      profileVersion:1,profileDigest:same.digest,approvalDecisionId:same.approval.decision.id}}),f.supplier,same,f.rule,point),code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    const nonPkpSupplier=setup('EXEMPT',true), nonPkpClass={code:'P02A_TAX_E_N_E_P_TEST_CASE',
      description:'P02A_V1|APPLICABILITY=TAXABLE|SUPPLIER=ENTITY,NON_PKP|RECIPIENT=ENTITY,PKP|CASE=TEST_CASE'};
    const inconsistent=approvedRule(nonPkpSupplier.input.clientId,nonPkpClass,{context:'BM_COMMISSION'});
    const nonPkpCommand=command(nonPkpSupplier.supplier,nonPkpSupplier.recipient,inconsistent,'TAXABLE');
    assert.throws(()=>calculatePpnFromResolved(normalizePpnInput(nonPkpCommand),nonPkpSupplier.supplier,nonPkpSupplier.recipient,inconsistent,point),
      code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    const corrupt={...f.supplier,snapshot:{...f.supplier.snapshot,legalName:'tampered'}};
    assert.throws(()=>calculatePpnFromResolved(normalizePpnInput(f.input),corrupt,f.recipient,f.rule,point),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    const unapproved={...f.rule,approval:{...f.rule.approval,decision:{...f.rule.approval.decision,sourceValidation:null}}};
    assert.throws(()=>calculatePpnFromResolved(normalizePpnInput(f.input),f.supplier,f.recipient,unapproved as typeof f.rule,point),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
  });
  it('requires actual approval and half-open effective windows at the tax point', () => {
    const f=setup(), earlier={...f.input,taxDate:'2025-01-02',taxPointAt:'2025-01-02T01:00:00.000Z'};
    assert.throws(()=>f.calc(earlier),code('HANDYMAN_PPN_NOT_APPROVED'));
    assert.throws(()=>calculatePpnFromResolved(normalizePpnInput(f.input),f.supplier,f.recipient,f.rule,submittedAt),code('HANDYMAN_PPN_NOT_APPROVED'));
    const closed={...f.supplier,effectiveWindow:{...f.supplier.effectiveWindow,to:point,identityWindowTo:point,
      closure:{id:id(),kind:'CLOSED' as const,effectiveTo:point,reason:'TEST',createdByUserId:id(),createdAt:created}}};
    assert.throws(()=>calculatePpnFromResolved(normalizePpnInput(f.input),closed,f.recipient,f.rule,point),code('HANDYMAN_PPN_NOT_APPROVED'));
    const ruleEnd={...f.rule,rule:{...f.rule.rule,effectiveWindow:{...f.rule.rule.effectiveWindow,to:taxDate,closureId:id()}}};
    assert.throws(()=>calculatePpnFromResolved(normalizePpnInput(f.input),f.supplier,f.recipient,ruleEnd,point),code('HANDYMAN_PPN_NOT_APPROVED'));
  });
});
