import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { calculateBmWithholdingFromResolved, hash, normalizePphInput } from '../src/modules/handyman-pph-calculation/handyman-pph-core';
import type { ApprovedHandymanTaxIdentity } from '../src/modules/handyman-tax-identity';
import type { TaxRuleResolution } from '../src/modules/handyman-tax-rules';
import type { BmCommissionSource, BmWithholdingTreatment, CalculateApprovedBmWithholdingInput } from '../src/modules/handyman-pph-calculation';

const id=()=>randomUUID(), created='2025-01-01T00:00:00.000Z', submitted='2025-01-02T00:00:00.000Z', decided='2025-01-03T00:00:00.000Z';
const point='2026-03-01T02:00:00.000Z', taxDate='2026-03-01';
const code=(expected:string)=>(err:{code?:string})=>{assert.equal(err.code,expected);return true;};
const grossDescription='P02B_V1|BASIS=GROSS|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH';
type Kind='E'|'IR'|'IN';
function identity(clientId:string,kind:Kind):ApprovedHandymanTaxIdentity {
  const ownerId=id(), createdByUserId=id(),profileId=id();
  const snapshot={schema:'HANDYMAN_TAX_IDENTITY_V1' as const,id:profileId,clientId,ownerKind:'BM_BENEFICIARY' as const,ownerId,
    issuerProfileId:null,counterpartyId:ownerId,verificationId:id(),version:1,legalName:'TEST ONLY',
    taxpayerKind:kind==='E'?'LEGAL_ENTITY' as const:'INDIVIDUAL' as const,
    individualResidency:kind==='E'?null:kind==='IR'?'RESIDENT' as const:'NON_RESIDENT' as const,
    identifierKind:'NPWP_15' as const,identifierValue:'012345678901002',pkpStatus:'NON_PKP' as const,
    approvalStatus:'UNAPPROVED' as const,effectiveFrom:created,declaredEffectiveTo:null,evidenceSource:'TEST',evidenceReference:'test/identity',
    createdByUserId,createdAt:created};
  const digest=hash(snapshot), submissionId=id(),base={profileId,clientId,ownerKind:'BM_BENEFICIARY' as const,ownerId,
    profileVersion:1,profileDigest:digest,evidenceSource:'TEST',evidenceReference:'test/review',reviewFrom:created,reviewTo:null,approvedFrom:null,approvedTo:null};
  const submission={...base,id:submissionId,eventType:'SUBMIT' as const,submissionId:null,actorUserId:id(),occurredAt:submitted};
  const decision={...base,id:id(),eventType:'APPROVE' as const,submissionId,actorUserId:id(),occurredAt:decided,approvedFrom:decided};
  return {snapshot,digestAlgorithm:'SHA-256',digest,effectiveWindow:{from:created,to:null,identityWindowTo:null,issuerProfileSupersededAt:null,closure:null},
    approval:{submission,decision},taxUse:{allowed:true,reason:'FINANCE_APPROVED'}};
}
function classification(treatment:BmWithholdingTreatment,kind:Kind) {
  const name=kind==='E'?'ENTITY':kind==='IR'?'INDIVIDUAL_RESIDENT':'INDIVIDUAL_NON_RESIDENT';
  return {code:`P02B_${treatment==='WITHHOLD'?'TAX':treatment}_${kind}_TEST_CASE`,
    description:`P02B_V1|TREATMENT=${treatment}|BENEFICIARY=${name}|CASE=TEST_CASE`};
}
function source(bm:ApprovedHandymanTaxIdentity,gross:string):BmCommissionSource {
  const body={schema:'HANDYMAN_BM_COMMISSION_SOURCE_V1' as const,clientId:bm.snapshot.clientId,buildingId:id(),executionScopeId:id(),transactionId:id(),
    entitlementId:id(),ledgerContractVersion:'CR-HM-13-PART-06' as const,ledgerPostedAt:created,derivedAt:submitted,derivedByUserId:id(),
    currency:'IDR' as const,commissionBasis:'EARNED_BM_COMMISSION' as const,commissionGross:gross,laborNet:gross,materialNet:'0.00',chargedNet:gross,
    adjustedTransactionScope:'0.00',commercialBasis:gross,commercialBasisSource:'LEDGER_LABOR_NET' as const,commercialFiscalBasis:null,
    commercialRatePercent:'100.0000',ledgerBasisDigest:'b'.repeat(64),
    agreement:{id:id(),versionId:id(),versionNumber:1,effectiveFrom:created,effectiveToAtEarning:null,ruleId:id(),termId:id(),anchorChecksum:'c'.repeat(64)},
    beneficiary:{kind:'BM_LEGAL_COUNTERPARTY' as const,counterpartyId:bm.snapshot.ownerId,counterpartyChecksum:'d'.repeat(64),
      verificationId:bm.snapshot.verificationId!,verificationChecksum:'e'.repeat(64),verifiedAt:created,beneficiaryDefinitionId:null,representedClientId:null},
    coverage:{id:id(),effectiveFrom:created,declaredEffectiveTo:null,effectiveToAtEarning:null,immutableChecksum:'f'.repeat(64)}};
  return {...body,checksumAlgorithm:'SHA-256',checksum:hash(body)};
}
type Options={method?:string;description?:string;rate?:string;mode?:'HALF_UP'|'HALF_EVEN'|'DOWN'|'UP'|'NO_ROUNDING';scale?:0|2|null};
function approvedRule(clientId:string,cls:ReturnType<typeof classification>,options:Options={}):Extract<TaxRuleResolution,{status:'APPROVED'}> {
  const ruleId=id(),createdByUserId=id();
  const snapshot={schema:'HANDYMAN_TAX_RULE_V1' as const,id:ruleId,clientId,transactionContext:'BM_COMMISSION' as const,
    taxCode:'PPH_WITHHOLDING' as const,taxpayerClassification:cls.code,classificationDescription:cls.description,
    version:1,effectiveFrom:'2025-01-01',declaredEffectiveTo:null,basisMethodCode:options.method??'PPH02B_GROSS_V1',
    basisDescription:options.description??grossDescription,ratePercent:options.rate??'7.500000',roundingMode:options.mode??'HALF_UP' as const,
    roundingScale:options.scale===undefined?0:options.scale,legalReference:'TEST-ONLY reference',legalSource:'TEST-ONLY source',
    evidenceSource:'TEST',evidenceReference:'test/rule',createdByUserId,createdAt:created};
  const digest=hash(snapshot),submissionId=id(),base={ruleId,clientId,ruleVersion:1,ruleDigest:digest,evidenceSource:'TEST',
    evidenceReference:'test/review',reviewFrom:'2025-01-01',reviewTo:null};
  const submission={...base,id:submissionId,eventType:'SUBMIT' as const,submissionId:null,sourceValidation:null,actorUserId:id(),occurredAt:submitted};
  const decision={...base,id:id(),eventType:'APPROVE' as const,submissionId,sourceValidation:'FINANCE_VALIDATED' as const,actorUserId:id(),occurredAt:decided};
  return {status:'APPROVED',rule:{snapshot,digestAlgorithm:'SHA-256',digest,effectiveWindow:{from:'2025-01-01',to:null,closureId:null}},approval:{submission,decision}};
}
function setup(options:Options={},treatment:BmWithholdingTreatment='WITHHOLD',kind:Kind='E',gross='1000.00') {
  const clientId=id(),bm=identity(clientId,kind),src=source(bm,gross),cls=classification(treatment,kind),rule=approvedRule(clientId,cls,options);
  const input:CalculateApprovedBmWithholdingInput={clientId,entitlementId:src.entitlementId,sourceChecksum:src.checksum,currency:'IDR',
    commissionBasis:'EARNED_BM_COMMISSION',commissionGross:gross,taxDate,taxPointAt:point,treatment,taxpayerClassification:cls.code,
    beneficiary:{owner:{kind:'BM_BENEFICIARY',clientId,counterpartyId:bm.snapshot.ownerId},profileId:bm.snapshot.id,profileVersion:1,
      profileDigest:bm.digest,approvalDecisionId:bm.approval.decision.id},
    rule:{ruleId:rule.rule.snapshot.id,ruleVersion:1,ruleDigest:rule.rule.digest,approvalDecisionId:rule.approval.decision.id}};
  return {bm,source:src,rule,input,calc:(value=input)=>calculateBmWithholdingFromResolved(value,src,bm,rule,point)};
}

describe('PART 02B pure withholding projection (all rates synthetic)',()=>{
  it('replays exactly, pins provenance and never exposes NPWP/NIK values',()=>{
    const f=setup(),a=f.calc();assert.deepEqual(a,f.calc());
    assert.equal(a.commissionGross,'1000.00');assert.equal(a.taxableWithholdingBasis,'1000.00');
    assert.equal(a.ratePercent,'7.500000');assert.equal(a.pphWithheld,'75.00');assert.equal(a.projectedNetCommission,'925.00');
    assert.equal(a.source.checksum,f.source.checksum);assert.equal(a.source.coverage.id,f.source.coverage.id);
    assert.equal(a.beneficiaryTaxIdentity.profileDigest,f.bm.digest);assert.equal(a.rule.approval.decision.id,f.rule.approval.decision.id);
    assert.equal(a.authority,'READ_ONLY_PROJECTION');assert.equal(a.caseApplicability,'CALLER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED');
    assert.equal(JSON.stringify(a).includes(f.bm.snapshot.identifierValue!),false);
    const {checksum,checksumAlgorithm,...body}=a;assert.equal(checksumAlgorithm,'SHA-256');assert.equal(checksum,hash(body));
  });
  it('uses an explicitly approved fractional basis, decimal-safe huge amounts and 0/2-scale rounding',()=>{
    const description='P02B_V1|BASIS=ROUND(GROSS*5/8)|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH';
    const f=setup({method:'PPH02B_RATIO_5_8_V1',description},'WITHHOLD','E','1000.00');
    assert.equal(f.calc().taxableWithholdingBasis,'625.00');assert.equal(f.calc().pphWithheld,'47.00');
    assert.equal(f.calc().projectedNetCommission,'953.00');
    const uplift=setup({method:'PPH02B_RATIO_5_4_V1',scale:2,
      description:'P02B_V1|BASIS=ROUND(GROSS*5/4)|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH'}).calc();
    assert.equal(uplift.taxableWithholdingBasis,'1250.00');assert.equal(uplift.pphWithheld,'93.75');
    const big=setup({rate:'7.500000',scale:2},'WITHHOLD','E','9000000000000000.99').calc();
    assert.equal(big.pphWithheld,'675000000000000.07');assert.equal(big.projectedNetCommission,'8325000000000000.92');
    const fractional=setup({rate:'7.500000',scale:2},'WITHHOLD','E','12.34').calc();
    assert.equal(fractional.pphWithheld,'0.93');assert.equal(fractional.projectedNetCommission,'11.41');
  });
  it('honors each rounding mode and rejects inexact NO_ROUNDING',()=>{
    for(const [mode,expected] of [['HALF_UP','3.00'],['HALF_EVEN','2.00'],['DOWN','2.00'],['UP','3.00']] as const)
      assert.equal(setup({rate:'2.500000',mode},'WITHHOLD','E','100.00').calc().pphWithheld,expected);
    assert.equal(setup({rate:'3.500000',mode:'HALF_EVEN'},'WITHHOLD','E','100.00').calc().pphWithheld,'4.00');
    assert.equal(setup({rate:'0.005000',mode:'HALF_EVEN',scale:2},'WITHHOLD','E','100.00').calc().pphWithheld,'0.00');
    assert.equal(setup({rate:'0.005000',mode:'HALF_UP',scale:2},'WITHHOLD','E','100.00').calc().pphWithheld,'0.01');
    assert.throws(()=>setup({rate:'0.010000',mode:'UP',scale:0},'WITHHOLD','E','0.01').calc(),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    assert.equal(setup({rate:'5.000000',mode:'NO_ROUNDING',scale:null},'WITHHOLD','E','100.00').calc().pphWithheld,'5.00');
    assert.throws(()=>setup({rate:'2.500000',mode:'NO_ROUNDING',scale:null},'WITHHOLD','E','100.01').calc(),code('HANDYMAN_PPH_UNSUPPORTED'));
  });
  it('requires independently approved explicit exempt/non-withholding classifications and zero methods',()=>{
    for(const treatment of ['EXEMPT','NON_WITHHOLD'] as const){
      const f=setup({method:`PPH02B_${treatment}_V1`,rate:'0.000000',
        description:`P02B_V1|TREATMENT=${treatment}|BASIS=0|PPH=0|NET=GROSS`},treatment);
      assert.equal(f.calc().taxableWithholdingBasis,'0.00');assert.equal(f.calc().pphWithheld,'0.00');
      assert.equal(f.calc().projectedNetCommission,'1000.00');
    }
    assert.throws(()=>setup({rate:'0.000000'}).calc(),code('HANDYMAN_PPH_UNSUPPORTED'));
    assert.throws(()=>setup({method:'PPH02B_EXEMPT_V1',description:'P02B_V1|TREATMENT=EXEMPT|BASIS=0|PPH=0|NET=GROSS',rate:'1.000000'},'EXEMPT').calc(),code('HANDYMAN_PPH_UNSUPPORTED'));
    assert.throws(()=>setup({method:'DEFAULT'}).calc(),code('HANDYMAN_PPH_UNSUPPORTED'));
  });
  it('distinguishes legal entities, resident individuals and nonresident individuals without inferring a rate',()=>{
    for(const [kind,rate] of [['E','7.500000'],['IR','12.000000'],['IN','30.000000']] as const){
      const f=setup({rate},'WITHHOLD',kind);assert.equal(f.calc().ratePercent,rate);
      assert.throws(()=>f.calc({...f.input,taxpayerClassification:`P02B_TAX_${kind==='E'?'IR':'E'}_TEST_CASE`}),code('HANDYMAN_PPH_IDENTITY_MISMATCH'));
    }
  });
  it('rejects wrong source, beneficiary, verification, case, rule and approval pins',()=>{
    const f=setup();
    assert.throws(()=>f.calc({...f.input,commissionGross:'100.00'}),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    assert.throws(()=>f.calc({...f.input,sourceChecksum:'0'.repeat(64)}),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    assert.throws(()=>f.calc({...f.input,beneficiary:{...f.input.beneficiary,owner:{kind:'BM_BENEFICIARY',clientId:f.input.clientId,counterpartyId:id()}}}),code('HANDYMAN_PPH_IDENTITY_MISMATCH'));
    assert.throws(()=>f.calc({...f.input,rule:{...f.input.rule,ruleDigest:'0'.repeat(64)}}),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    assert.throws(()=>f.calc({...f.input,beneficiary:{...f.input.beneficiary,approvalDecisionId:id()}}),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    assert.throws(()=>f.calc({...f.input,taxpayerClassification:'P02B_TAX_E_DEFAULT'}),code('HANDYMAN_PPH_UNSUPPORTED'));
    const unverified={...f.bm,snapshot:{...f.bm.snapshot,verificationId:id()}};
    assert.throws(()=>calculateBmWithholdingFromResolved(f.input,f.source,unverified,f.rule,point),code('HANDYMAN_PPH_IDENTITY_MISMATCH'));
    const unapproved={...f.rule,approval:{...f.rule.approval,decision:{...f.rule.approval.decision,sourceValidation:null}}};
    assert.throws(()=>calculateBmWithholdingFromResolved(f.input,f.source,f.bm,unapproved as typeof f.rule,point),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
  });
  it('requires valid explicit amounts, Jakarta date, zoned instant and approval/effective boundaries',()=>{
    const f=setup();
    for(const amount of ['-1.00','1','01.00','1e2','10000000000000000.00'])
      assert.throws(()=>normalizePphInput({...f.input,commissionGross:amount}),code('HANDYMAN_PPH_INVALID'));
    assert.throws(()=>normalizePphInput({...f.input,currency:'USD' as 'IDR'}),code('HANDYMAN_PPH_UNSUPPORTED'));
    assert.throws(()=>normalizePphInput({...f.input,taxDate:'2025-02-30'}),code('HANDYMAN_PPH_INVALID'));
    assert.throws(()=>normalizePphInput({...f.input,taxDate:'2026-03-02'}),code('HANDYMAN_PPH_INVALID'));
    assert.throws(()=>normalizePphInput({...f.input,taxPointAt:'2026-03-01T02:00:00'}),code('HANDYMAN_PPH_INVALID'));
    assert.throws(()=>calculateBmWithholdingFromResolved(f.input,f.source,f.bm,f.rule,submitted),code('HANDYMAN_PPH_NOT_APPROVED'));
    assert.throws(()=>f.calc({...f.input,taxDate:'2025-01-02',taxPointAt:'2025-01-02T10:00:00.000Z'}),code('HANDYMAN_PPH_NOT_APPROVED'));
    assert.throws(()=>f.calc({...f.input,taxDate:'2024-12-31',taxPointAt:'2024-12-31T10:00:00.000Z'}),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    const closed={...f.rule,rule:{...f.rule.rule,effectiveWindow:{...f.rule.rule.effectiveWindow,to:taxDate,closureId:id()}}};
    assert.throws(()=>calculateBmWithholdingFromResolved(f.input,f.source,f.bm,closed,point),code('HANDYMAN_PPH_NOT_APPROVED'));
  });
});
