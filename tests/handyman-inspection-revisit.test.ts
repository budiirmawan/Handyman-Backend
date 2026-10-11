import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import { withTransaction } from '../src/database';
import { cancelHandymanPrequotation } from '../src/modules/handyman-requests/handyman-prequotation-operations.service';
import { planHandymanInspectionRevisit } from '../src/modules/handyman-requests/handyman-inspection-revisit.service';
import { createFieldInspectorSession } from './helpers/access';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { api } from './helpers/http';
import { startRevisitFixture, closeDirectQuotationFixture, auth, status, denied, HM } from './helpers/handyman-inspection-revisit';

let f: Awaited<ReturnType<typeof startRevisitFixture>>;
before(async () => { f = await startRevisitFixture(55511); });
after(closeDirectQuotationFixture);
const count = async (table: string, id: string) => (await f.q(`SELECT count(*)::int AS n FROM ${table} WHERE handyman_request_id=$1`, [id])).rows[0].n;
const noCommercialAuthority = async (id: string) => {
  for (const table of ['handyman_quotations','handyman_execution_scopes']) assert.equal(await count(table,id), 0);
};

it('Operations-only cancellation is scoped, audited, terminal, and permits only a new intake reference', async () => {
  const r = await f.createRequest();
  status(await api().post(`${HM}/${r.id}/prequotation-cancellation`).send({ reason: 'Customer withdrew request.' }), 401, 'authentication');
  denied(await f.cancel(r.id, f.field.token), 403, 'PERMISSION_DENIED', 'Field cannot cancel');
  denied(await f.cancel(r.id, f.otherOps.token), 403, 'BUILDING_ACCESS_DENIED', 'exact Building');
  await assert.rejects(cancelHandymanPrequotation(r.id, 'Customer withdrew request.', f.field.userId), { code: 'PERMISSION_DENIED' });
  status(await f.post(r.id, 'prequotation-cancellation', { reason: 'no' }), 400, 'reason required');
  const cancelled = await f.cancel(r.id); status(cancelled, 201, 'cancel');
  assert.equal(cancelled.body.data.cancelledByUserId, f.ops.userId);
  assert.equal(cancelled.body.data.status, 'CANCELLED_PRE_QUOTATION');
  status(await f.cancel(r.id), 409, 'duplicate cancellation');
  status(await f.post(r.id, 'triage', { note: 'Attempt to reopen.' }), 409, 'no reopening');
  const history = await api().get(`${HM}/${r.id}/prequotation-history`).set(auth(f.ops.token));
  status(history, 200, 'read history'); assert.equal(history.body.data.cancellation.cancelled_by_user_id, f.ops.userId);
  await assert.rejects(f.q("UPDATE handyman_service_requests SET status='INTAKE' WHERE id=$1", [r.id]), { constraint: 'handyman_prequotation_cancelled' });
  await assert.rejects(f.q('DELETE FROM handyman_prequotation_cancellations WHERE handyman_request_id=$1', [r.id]), /append-only/);
  await assert.rejects(f.q("UPDATE handyman_prequotation_cancellations SET reason='Changed reason later.' WHERE handyman_request_id=$1", [r.id]), /append-only/);
  const next = await f.createRequest();
  status(await f.post(next.id, 'cancelled-predecessor', { cancelledRequestId: r.id }), 201, 'new intake references cancelled predecessor');
  status(await f.post(next.id, 'cancelled-predecessor', { cancelledRequestId: r.id }), 409, 'immutable reference');
  assert.equal((await f.q('SELECT status FROM handyman_service_requests WHERE id=$1', [next.id])).rows[0].status, 'INTAKE');
  assert.equal((await f.q("SELECT * FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_PREQUOTATION_CANCELLED'", [r.id])).rowCount, 1);
  denied(await api().get(`${HM}/${r.id}/prequotation-history`).set(auth(f.otherOps.token)),403,'BUILDING_ACCESS_DENIED','cancelled history stays scoped');
  await noCommercialAuthority(r.id); await noCommercialAuthority(next.id);
});

it('cancelled failed attempts keep history but block assignment, review, revisit and readiness writes', async () => {
  const x = await f.failed(false); const id=x.request.id;
  const before = (await f.q('SELECT * FROM handyman_request_inspections WHERE handyman_request_id=$1', [id])).rows;
  status(await f.cancel(id), 201, 'cancel pending unsuccessful review');
  status(await f.post(id, 'inspection-assignment', { assignedFieldUserId: f.field.userId }), 409, 'same-target no-op also denied');
  status(await f.review(id, x.report.id), 409, 'review denied');
  status(await f.plan(id, x.input), 409, 'revisit denied');
  status(await f.capture(id), 409, 'capture denied');
  status(await f.diagnose(id), 409, 'diagnosis denied');
  status(await f.draft(id), 409, 'quotation denied');
  const supersede = await api().post(`/api/v1/handyman/scheduling-readiness/${x.readiness.id}/supersede`).set(auth(f.ops.token))
    .send({ preferredWindowStart: new Date(Date.now()+2*86_400_000).toISOString(), preferredWindowEnd: new Date(Date.now()+3*86_400_000).toISOString() });
  status(supersede, 409, 'readiness cannot change after cancellation');
  assert.deepEqual((await f.q('SELECT * FROM handyman_request_inspections WHERE handyman_request_id=$1', [id])).rows, before);
  assert.equal((await f.q('SELECT status FROM handyman_scheduling_readiness WHERE id=$1', [x.readiness.id])).rows[0].status, 'ACTIVE');
  await noCommercialAuthority(id);
});

it('NOT_INSPECTABLE requires structured reason and exact-request evidence; accepted failure blocks diagnosis and quotation including SQL', async () => {
  const x = await f.assigned(); const id=x.request.id;
  status(await f.capture(id, 'NOT_INSPECTABLE', { unsuccessfulReason: undefined }), 400, 'reason absent');
  status(await f.capture(id, 'NOT_INSPECTABLE', { unsuccessfulReason: 'MADE_UP' }), 400, 'reason vocabulary');
  status(await f.capture(id, 'INSPECTED', { unsuccessfulReason: 'ACCESS_DENIED' }), 400, 'success cannot carry failure reason');
  status(await f.capture(id, 'NOT_INSPECTABLE', { evidenceSubmissionId: randomUUID() }), 400, 'unknown evidence');
  const other = await f.createRequest();
  const evidenceId = randomUUID();
  await f.q(`INSERT INTO evidence_submissions
    (id,client_id,execution_type,execution_id,evidence_type,file_reference,original_file_name,mime_type,file_size,captured_at,submitted_by_user_id,content_sha256,content_hashed_at,hash_algorithm)
    VALUES ($1,$2,'HANDYMAN_REQUEST',$3,'PHOTO','fixture/evidence.jpg','evidence.jpg','image/jpeg',100,NOW(),$4,$5,NOW(),'SHA-256')`,
    [evidenceId,f.clientId,other.id,f.field.userId,'a'.repeat(64)]);
  status(await f.capture(id, 'NOT_INSPECTABLE', { evidenceSubmissionId: evidenceId }), 400, 'foreign request evidence');
  // Existing evidence engine fact can be referenced only by its own request.
  const ownEvidenceId=randomUUID();
  await f.q(`INSERT INTO evidence_submissions
    (id,client_id,execution_type,execution_id,evidence_type,file_reference,original_file_name,mime_type,file_size,captured_at,submitted_by_user_id,content_sha256,content_hashed_at,hash_algorithm)
    VALUES ($1,$2,'HANDYMAN_REQUEST',$3,'PHOTO','fixture/locked.jpg','locked.jpg','image/jpeg',100,NOW(),$4,$5,NOW(),'SHA-256')`,
    [ownEvidenceId,f.clientId,id,f.field.userId,'b'.repeat(64)]);
  const captured=await f.capture(id,'NOT_INSPECTABLE',{evidenceSubmissionId:ownEvidenceId}); status(captured,201,'failure with evidence provenance');
  assert.equal(captured.body.data.evidenceSubmissionId,ownEvidenceId);
  const report=await f.submit(id); status(report,201,'failure report'); status(await f.review(id,report.body.data.id),201,'accept unsuccessful account');
  denied(await f.diagnose(id),409,'HANDYMAN_INSPECTION_NOT_QUOTABLE','failure cannot authorize diagnosis');
  denied(await f.draft(id),409,'HANDYMAN_INSPECTION_NOT_QUOTABLE','failure cannot authorize quote');
  await assert.rejects(f.q(`INSERT INTO handyman_request_diagnoses
    (id,client_id,handyman_request_id,channel_attribution_id,building_id,handyman_discipline_id,discipline_code,diagnosis,scope_classification,diagnosed_by_user_id,source_inspection_report_id)
    SELECT $1,client_id,id,channel_attribution_id,building_id,$3,'GENERAL_HANDYMAN','Raw failed diagnosis','GENERAL_HANDYMAN',$4,$5
    FROM handyman_service_requests WHERE id=$2`, [randomUUID(),id,f.disciplineId,f.ops.userId,report.body.data.id]), { constraint:'handyman_successful_inspection_required' });
  await assert.rejects(withTransaction(async tx => {
    const quotationId=randomUUID();
    await tx.query('INSERT INTO handyman_quotations(id,client_id,handyman_request_id,created_by_user_id) VALUES ($1,$2,$3,$4)',[quotationId,f.clientId,id,f.ops.userId]);
    await tx.query(`INSERT INTO handyman_quotation_versions(id,quotation_id,version_number,status,created_by_user_id)
      VALUES ($1,$2,1,'DRAFT',$3)`,[randomUUID(),quotationId,f.ops.userId]);
  }),{constraint:'handyman_successful_inspection_required'});
  assert.equal(await count('handyman_request_diagnoses',id),0); await noCommercialAuthority(id);
});

it('revisit authority requires latest accepted failure, exact active readiness and eligible scoped Field; pending/returned reports use correction', async () => {
  const x = await f.failed(false); const id=x.request.id;
  status(await f.plan(id,x.input),409,'pending report cannot authorize revisit');
  status(await f.review(id,x.report.id,'RETURNED'),201,'Operations returns correction');
  status(await f.plan(id,x.input),409,'returned report cannot authorize a second visit');
  const corrected=await f.submit(id); status(corrected,201,'correction on SAME physical attempt');
  assert.equal(corrected.body.data.handymanRequestInspectionId,x.inspection.id);
  assert.equal(await count('handyman_request_inspections',id),1);
  status(await f.review(id,corrected.body.data.id),201,'accept corrected unsuccessful account');
  status(await f.plan(id,x.input),409,'stale report denied');
  const input={...x.input,precedingReportId:corrected.body.data.id};
  denied(await f.plan(id,input,f.field.token),403,'PERMISSION_DENIED','Field cannot plan');
  denied(await f.plan(id,input,f.otherOps.token),403,'BUILDING_ACCESS_DENIED','same Client is insufficient');
  await assert.rejects(planHandymanInspectionRevisit({handymanRequestId:id,...input},f.field.userId),{code:'PERMISSION_DENIED'});
  status(await f.plan(id,{...input,assignedFieldUserId:f.otherOps.userId}),400,'non-Field target');
  const other=await f.failed();
  status(await f.plan(id,{...input,schedulingReadinessId:other.readiness.id}),409,'foreign readiness');
  const superseded=await api().post(`/api/v1/handyman/scheduling-readiness/${x.readiness.id}/supersede`).set(auth(f.ops.token))
    .send({preferredWindowStart:new Date(Date.now()+2*86_400_000).toISOString(),preferredWindowEnd:new Date(Date.now()+3*86_400_000).toISOString()});
  status(superseded,201,'new preferred version');
  status(await f.plan(id,input),409,'inactive preferred version');
  const active=(await f.q("SELECT id FROM handyman_scheduling_readiness WHERE handyman_request_id=$1 AND status='ACTIVE'",[id])).rows[0].id;
  const planned=await f.plan(id,{...input,schedulingReadinessId:active}); status(planned,201,'authorized revisit');
  assert.notEqual(planned.body.data.inspectionAssignmentId,x.assignment.id,'same Field still gets a NEW assignment');
  assert.equal(planned.body.data.schedulingAuthority,'PREFERRED_WINDOW_ONLY');
  status(await f.submit(id),409,'correction cannot impersonate pending visit');
  await assert.rejects(f.q('DELETE FROM handyman_inspection_revisit_attempts WHERE handyman_request_id=$1',[id]),/append-only/);
  await assert.rejects(f.q("UPDATE handyman_scheduling_readiness SET preferred_window_end=preferred_window_end+INTERVAL '1 hour' WHERE id=$1",[active]),/never rewritten/);
  await assert.rejects(f.q(`INSERT INTO handyman_request_inspections
    (id,client_id,handyman_request_id,channel_attribution_id,building_id,inspection_result,inspection_notes,inspected_by_user_id,attempt_number)
    SELECT $1,client_id,id,channel_attribution_id,building_id,'INSPECTED','Forged unplanned capture',$3,2
    FROM handyman_service_requests WHERE id=$2`,[randomUUID(),id,f.field.userId]),{constraint:'handyman_physical_attempt_invalid'});
  assert.equal(await count('handyman_request_inspections',id),1);
  await noCommercialAuthority(id);
});

it('concurrent plans and captures have one winner; retry ownership, repeated failures and all report/review history remain traceable', async () => {
  const x=await f.failed(); const id=x.request.id;
  const replacement=await createFieldInspectorSession();
  await buildingAssignmentService.createAssignment(replacement.userId,{buildingId:f.buildingId});
  const input={...x.input,assignedFieldUserId:replacement.userId};
  const plans=await Promise.all([f.plan(id,input),f.plan(id,input)]);
  assert.deepEqual(plans.map(r=>r.status).sort(),[201,409]);
  denied(await f.capture(id),403,'HANDYMAN_INSPECTION_FIELD_DENIED','old Field lost attempt ownership');
  const captures=await Promise.all([f.capture(id,'NOT_INSPECTABLE',{},replacement.token),f.capture(id,'NOT_INSPECTABLE',{},replacement.token)]);
  assert.deepEqual(captures.map(r=>r.status).sort(),[201,400]);
  const second=captures.find(r=>r.status===201)!.body.data;
  assert.equal(second.attemptNumber,2);
  const report=await f.submit(id,replacement.token); status(report,201,'second physical report');
  assert.equal(report.body.data.versionNumber,2); assert.equal(report.body.data.supersedesReportId,x.report.id);
  status(await f.review(id,report.body.data.id),201,'accept second unsuccessful visit');
  status(await f.diagnose(id),409,'second failure still blocks diagnosis');
  const third=await f.plan(id,{...input,precedingInspectionId:second.id,precedingReportId:report.body.data.id}); status(third,201,'third physical attempt');
  const success=await f.capture(id,'INSPECTED',{},replacement.token); status(success,201,'third visit succeeds');
  assert.equal(success.body.data.attemptNumber,3);
  const successfulReport=await f.submit(id,replacement.token); status(successfulReport,201,'successful report');
  status(await f.diagnose(id),409,'pending success still blocked');
  const reviews=await Promise.all([f.review(id,successfulReport.body.data.id),f.review(id,successfulReport.body.data.id)]);
  assert.deepEqual(reviews.map(r=>r.status).sort(),[201,409]);
  status(await f.plan(id,{...input,precedingInspectionId:success.body.data.id,precedingReportId:successfulReport.body.data.id}),409,'success is not a failed revisit source');
  const diagnoses=await Promise.all([f.diagnose(id),f.diagnose(id)]); assert.deepEqual(diagnoses.map(r=>r.status).sort(),[201,400]);
  assert.equal(diagnoses.find(r=>r.status===201)!.body.data.sourceInspectionReportId,successfulReport.body.data.id);
  assert.equal(await count('handyman_request_inspections',id),3);
  assert.equal(await count('handyman_request_inspection_report_reviews',id),3);
  assert.equal(await count('handyman_request_inspection_assignments',id),3);
  const read=await api().get(`${HM}/${id}/inspection-attempts`).set(auth(f.ops.token)); status(read,200,'all attempt history');
  assert.equal(read.body.data.revisits.length,2); assert.equal(read.body.data.inspections.length,3);
});

it('cancellation versus revisit is serialized, terminal, and cannot manufacture quotation or scope', async () => {
  const x=await f.failed(); const id=x.request.id;
  const [cancelled,planned]=await Promise.all([f.cancel(id),f.plan(id,x.input)]);
  status(cancelled,201,'cancellation wins or closes planned request'); assert.ok([201,409].includes(planned.status));
  assert.equal((await f.q('SELECT status FROM handyman_service_requests WHERE id=$1',[id])).rows[0].status,'CANCELLED_PRE_QUOTATION');
  status(await f.capture(id,'INSPECTED'),409,'no late physical attempt');
  assert.equal(await count('handyman_inspection_revisit_attempts',id),planned.status===201?1:0);
  assert.equal(await count('handyman_request_inspection_assignments',id),planned.status===201?2:1);
  await noCommercialAuthority(id);
});

it('cancellation versus first DRAFT is serialized; any existing quotation prevents cancellation', async () => {
  const x=await f.assigned(); const id=x.request.id;
  status(await f.capture(id,'INSPECTED'),201,'successful inspection');
  const report=await f.submit(id); status(report,201,'report'); status(await f.review(id,report.body.data.id),201,'accept');
  status(await f.diagnose(id),201,'diagnose');
  const pair=await Promise.all([f.draft(id),f.cancel(id)]); assert.deepEqual(pair.map(r=>r.status).sort(),[201,409]);
  const quotationCount=await count('handyman_quotations',id); const cancellationCount=await count('handyman_prequotation_cancellations',id);
  assert.equal(quotationCount+cancellationCount,1);
  if(quotationCount) status(await f.cancel(id),409,'DRAFT blocks cancellation');
  else status(await f.draft(id),409,'cancellation blocks DRAFT');
  // Deterministic existing-DRAFT denial, independent of which race won.
  const next=await f.assigned(); status(await f.capture(next.request.id,'INSPECTED'),201,'success');
  const rp=await f.submit(next.request.id); status(await f.review(next.request.id,rp.body.data.id),201,'accept');
  status(await f.diagnose(next.request.id),201,'diagnose'); status(await f.draft(next.request.id),201,'draft');
  status(await f.cancel(next.request.id),409,'existing quotation explicitly blocks cancellation');
  assert.equal(await count('handyman_prequotation_cancellations',next.request.id),0);
});

it('concurrent cancellations record one immutable decision and block raw readiness deletion/reparenting and quotation insertion', async () => {
  const x=await f.failed(); const id=x.request.id;
  const responses=await Promise.all([f.cancel(id),f.cancel(id)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
  assert.equal(await count('handyman_prequotation_cancellations',id),1);
  await assert.rejects(f.q('DELETE FROM handyman_scheduling_readiness WHERE id=$1',[x.readiness.id]),{constraint:'handyman_prequotation_cancelled'});
  const other=await f.createRequest();
  await assert.rejects(f.q('UPDATE handyman_scheduling_readiness SET handyman_request_id=$2 WHERE id=$1',[x.readiness.id,other.id]),/cannot be reparented/);
  await assert.rejects(f.q('INSERT INTO handyman_quotations(id,client_id,handyman_request_id,created_by_user_id) VALUES ($1,$2,$3,$4)',[randomUUID(),f.clientId,id,f.ops.userId]),{constraint:'handyman_prequotation_cancelled'});
  await noCommercialAuthority(id);
});
