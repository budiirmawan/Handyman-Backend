import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHandymanVisitProposal, parseCancelBody, parseVisitParam} from '../../src/modules/handyman-appointment-contract/handyman-visit-api.validation.ts';
const a='123e4567-e89b-42d3-a456-426614174000';
const b='123e4567-e89b-42d3-a456-426614174001';
const startAt='2031-11-13T10:00:00+07:00', endAt='2031-11-13T11:00:00+07:00';
const proposal={kind:'INSPECTION',resourceId:a,startAt,endAt};
test('inspection proposal is a strictly bounded DTO',()=>{
 const v=parseHandymanVisitProposal(proposal); assert.equal(v.executionScopeId,null);assert.equal(v.resourceId,a);
});
test('execution proposal requires target scope',()=>{
 assert.throws(()=>parseHandymanVisitProposal({...proposal,kind:'EXECUTION'}));
 assert.equal(parseHandymanVisitProposal({...proposal,kind:'EXECUTION',executionScopeId:b}).executionScopeId,b);
});
test('caller cannot forge tenant consent, actor, scope, verifiedByServer or readiness',()=>{
 for(const field of ['tenantChoiceEvidenceRef','actorUserId','clientId','buildingId','confirmedByUserId','verifiedByServer','policyEvaluated','state']) {
  assert.throws(()=>parseHandymanVisitProposal({...proposal,[field]:'spoof'}),field);
 }
});
test('invalid intervals and timezones without offsets refused',()=>{
 for(const input of [{...proposal,startAt:'2031-11-13T10:00:00'}, {...proposal,endAt:startAt},
 {...proposal,endAt:'2031-11-14T12:00:00+07:00'}, {...proposal,startAt:'2020-01-01T10:00:00Z'}])
   assert.throws(()=>parseHandymanVisitProposal(input));
});
test('strict UUID and cancel version',()=>{
 assert.equal(parseVisitParam(a),a);
 assert.throws(()=>parseVisitParam('1 OR 1=1'));
 assert.deepEqual(parseCancelBody({version:2}),{version:2});
 for(const candidate of [{version:0},{version:1,actorUserId:a},{version:1.5},null])
  assert.throws(()=>parseCancelBody(candidate));
});

test('execution reuses persisted request dates without a second date entry; inspection and partial pairs stay explicit', () => {
 assert.deepEqual(parseHandymanVisitProposal({kind:'EXECUTION',resourceId:a,executionScopeId:b}),
  {kind:'EXECUTION',resourceId:a,executionScopeId:b});
 assert.throws(()=>parseHandymanVisitProposal({kind:'INSPECTION',resourceId:a}));
 assert.throws(()=>parseHandymanVisitProposal({kind:'EXECUTION',resourceId:a,executionScopeId:b,startAt}));
 assert.throws(()=>parseHandymanVisitProposal({kind:'EXECUTION',resourceId:a,executionScopeId:b,endAt}));
});
