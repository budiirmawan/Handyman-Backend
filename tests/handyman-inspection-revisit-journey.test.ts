import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, it } from 'node:test';
import type { PicWorkspaceAssertion } from '../src/modules/handyman-pic-session';
import { api } from './helpers/http';
import { startRevisitFixture, closeDirectQuotationFixture, auth, status, denied } from './helpers/handyman-inspection-revisit';

let f: Awaited<ReturnType<typeof startRevisitFixture>>;
before(async () => { f = await startRevisitFixture(55512); });
after(closeDirectQuotationFixture);
const HM = '/api/v1/handyman/requests';
const HQ = '/api/v1/handyman/quotations';
const HV = '/api/v1/handyman/quotation-versions';
const PIC = '/api/v1/handyman/pic';

it('revisit E2E: signed Care → unsuccessful accepted attempt → preferred-window retry → successful corrected/accepted report → signed PIC → one scope', async (t) => {
  const { q, ops, tenantCompanyId, buildingId, tenantPicId, spaceId, picCode, picIntegrationId } = f;
  const step = (label: string) => t.diagnostic(`PASS: ${label}`);
  const failed = await f.failed();
  const requestId = failed.request.id;
  const savedPolicy = (await api().get(`${HM}/${requestId}/triage`).set(auth(ops.token))).body.data;
  const scopeCount = async () => (await q('SELECT count(*)::int AS n FROM handyman_execution_scopes WHERE handyman_request_id=$1', [requestId])).rows[0].n;
  const noScope = async () => assert.equal(await scopeCount(), 0, 'scope requires signed Tenant PIC approval');
  denied(await f.diagnose(requestId), 409, 'HANDYMAN_INSPECTION_NOT_QUOTABLE', 'accepted failure never authorizes preparation');
  denied(await f.draft(requestId), 409, 'HANDYMAN_INSPECTION_NOT_QUOTABLE', 'failure never authorizes quotation');
  const planned = await f.plan(requestId, failed.input); status(planned, 201, 'Operations plans a distinct retry');
  assert.notEqual(planned.body.data.inspectionAssignmentId, failed.assignment.id);
  assert.equal(planned.body.data.schedulingReadinessId, failed.readiness.id);
  assert.equal(planned.body.data.schedulingAuthority, 'PREFERRED_WINDOW_ONLY');
  const success = await f.capture(requestId, 'INSPECTED'); status(success, 201, 'physical retry succeeds');
  assert.equal(success.body.data.attemptNumber, 2);
  assert.equal(success.body.data.revisitAttemptId, planned.body.data.id);
  const pending = await f.submit(requestId); status(pending, 201, 'retry report');
  assert.equal(pending.body.data.handymanRequestInspectionId, success.body.data.id);
  status(await f.review(requestId, pending.body.data.id, 'RETURNED'), 201, 'Operations requires correction');
  status(await f.diagnose(requestId), 409, 'returned report still blocks diagnosis');
  const accepted = await f.submit(requestId); status(accepted, 201, 'corrected report');
  assert.equal(accepted.body.data.handymanRequestInspectionId, success.body.data.id, 'correction is NOT another physical visit');
  assert.equal(accepted.body.data.versionNumber, 3);
  status(await f.review(requestId, accepted.body.data.id), 201, 'accept successful corrected report');
  const diagnosis = await f.diagnose(requestId); status(diagnosis, 201, 'diagnosis from latest successful accepted report');
  assert.equal(diagnosis.body.data.sourceInspectionReportId, accepted.body.data.id);
  const tables = ['handyman_request_inspections','handyman_request_inspection_reports', 'handyman_request_inspection_report_reviews', 'handyman_inspection_revisit_attempts'];
  const snapshots = await Promise.all(tables.map(table => q(`SELECT * FROM ${table} WHERE handyman_request_id=$1 ORDER BY id`, [requestId]).then(r => r.rows)));
  assert.deepEqual(snapshots.map(rows => rows.length), [2,3,3,1]);
  const preservedHistory = async () => {
    for (let n=0; n<tables.length; n++) assert.deepEqual((await q(`SELECT * FROM ${tables[n]} WHERE handyman_request_id=$1 ORDER BY id`, [requestId])).rows, snapshots[n]);
  };
  await noScope();
  step('failed and successful physical attempts, fresh assignment, preferred readiness and immutable report corrections are separately traceable');
  const drafted = await api().post(`${HM}/${requestId}/quotation`).set(auth(ops.token)).send({});
  status(drafted, 201, 'successful retry DRAFT');
  const quotationId = drafted.body.data.quotation.id as string;
  const versionId = drafted.body.data.versions[0].id as string;
  const scopeRead = () => api().get(`${HV}/${versionId}/execution-scope`).set(auth(ops.token));
  denied(await scopeRead(), 404, 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND', 'no premature scope at DRAFT');
  const line = await api().post(`${HV}/${versionId}/lines`).set(auth(ops.token)).send({
    lineType: 'LABOR', description: 'Fixed scope replacement', quantity: 2, uomId: f.uomId,
    currency: 'IDR', finalQuotedUnitAmount: 150_000,
  });
  status(line, 201, 'quotation line');
  assert.equal((await q('SELECT * FROM handyman_quotation_approval_bindings WHERE quotation_id=$1', [quotationId])).rowCount, 0);
  const issued = await api().post(`${HV}/${versionId}/issue`).set(auth(ops.token))
    .send({ validUntil: new Date(Date.now() + 3_600_000).toISOString() });
  status(issued, 200, 'B12 OFF: issue succeeds without binding');
  assert.equal(issued.body.data.status, 'ISSUED');
  await preservedHistory(); await noScope();
  step('successful accepted retry unlocks guarded diagnosis and quotation; B12 remains OFF');
  // A staff credential, like Care, is not a PIC credential. The shared fixture's
  // Care session is intentionally not exposed after intake.
  const picAssertion: PicWorkspaceAssertion = {
    purpose: 'HANDYMAN_PIC_WORKSPACE', integrationCode: picCode, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    representation: { tenantCompanyId, buildingId, tenantPicId, spaceId },
  };
  const admitPic = () => api().post(`${PIC}/session`)
    .set('x-hub-signature-256', f.signPic(picAssertion)).send(picAssertion);
  const admission = await admitPic();
  status(admission, 201, 'signed PIC HTTP admission');
  assert.equal(admission.headers['cache-control'], 'no-store');
  const picToken = admission.body.data.workspaceToken as string;
  denied(await admitPic(), 401, 'HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED', 'PIC assertion replay');
  const sessions = await q('SELECT id, integration_id, tenant_pic_id FROM handyman_pic_workspace_sessions WHERE token_hash = $1',
    [createHash('sha256').update(picToken).digest('hex')]);
  assert.equal(sessions.rowCount, 1);
  assert.equal(sessions.rows[0].integration_id, picIntegrationId);
  assert.equal(sessions.rows[0].tenant_pic_id, tenantPicId);
  const sessionId = sessions.rows[0].id as string;
  const decisionKey = randomUUID();
  const decide = (token: string, body: object = { decision: 'APPROVE' }, key = decisionKey) =>
    api().post(`${PIC}/quotation-versions/${versionId}/decision`).set(auth(token)).set('Idempotency-Key', key).send(body);
  denied(await decide(ops.token), 401, 'HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED', 'staff token is not PIC session authority');
  denied(await decide(picToken), 409, 'HANDYMAN_QUOTATION_DECISION_CONFLICT', 'PIC cannot approve without explicit binding');
  const staff = await api().post(`${HV}/${versionId}/decision`).set(auth(ops.token))
    .set('Idempotency-Key', randomUUID()).send({ decision: 'APPROVE' });
  denied(staff, 403, 'PERMISSION_DENIED', 'S1 staff approval stays closed');
  assert.equal(staff.headers.deprecation, 'true');
  await noScope();
  denied(await scopeRead(), 404, 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND', 'premature Execution Scope after issue');
  const bindKey = randomUUID();
  const bind = () => api().post(`${HQ}/${quotationId}/approval-binding`).set(auth(ops.token))
    .set('Idempotency-Key', bindKey).send({ tenantPicId });
  const binding = await bind();
  status(binding, 201, 'explicit staff binding, not approval');
  const bindingId = binding.body.data.binding.id as string;
  const bindingReplay = await bind();
  status(bindingReplay, 201, 'binding replay');
  assert.equal(bindingReplay.body.data.replayed, true);
  assert.equal(bindingReplay.body.data.binding.id, bindingId);
  const eligible = await api().get(`${PIC}/requests/${requestId}/approval-eligibility`).set(auth(picToken));
  status(eligible, 200, 'PIC eligibility HTTP read');
  assert.equal(eligible.body.data.eligible, true, 'signed representation plus explicit binding authorizes approval');
  await noScope();
  step('signed PIC session, assertion replay denial, credential separation, unbound refusal, S1 staff 403 and binding replay');

  const approved = await decide(picToken);
  status(approved, 201, 'Tenant PIC APPROVE');
  const data = approved.body.data;
  assert.equal(data.decision.decision, 'APPROVE');
  assert.equal(data.decision.decisionActorType, 'TENANT_PIC');
  assert.equal(data.decision.decidedByTenantPicId, tenantPicId);
  assert.equal(data.decision.decidedByPicSessionId, sessionId);
  assert.equal(data.decision.approvalBindingId, bindingId);
  assert.equal(data.executionScope.status, 'AUTHORIZED');
  assert.equal(data.executionScope.handymanRequestId, requestId);
  assert.equal(data.executionScope.approvedQuotationVersionId, versionId);
  assert.equal(data.executionScope.buildingId, buildingId);
  assert.equal(data.executionScope.spaceId, spaceId);
  assert.equal(await scopeCount(), 1);
  const scope = await scopeRead();
  status(scope, 200, 'authorized Execution Scope HTTP read');
  assert.equal(scope.body.data.id, data.executionScope.executionScopeId);
  const ledger = await q('SELECT * FROM handyman_quotation_decisions WHERE quotation_version_id = $1', [versionId]);
  assert.equal(ledger.rowCount, 1);
  assert.equal(ledger.rows[0].decided_by_user_id, null);
  assert.equal(ledger.rows[0].decided_by_pic_session_id, sessionId);
  const scopeRow = (await q('SELECT * FROM handyman_execution_scopes WHERE handyman_request_id = $1', [requestId])).rows[0];
  assert.equal(scopeRow.created_by_actor_type, 'TENANT_PIC');
  assert.equal(scopeRow.created_by_user_id, null);
  assert.equal(scopeRow.created_by_tenant_pic_id, tenantPicId);
  assert.equal(scopeRow.created_by_pic_session_id, sessionId);
  assert.equal(scopeRow.quotation_decision_id, ledger.rows[0].id);
  const replayed = await decide(picToken);
  status(replayed, 201, 'PIC decision replay');
  assert.deepEqual(replayed.body.data, data, 'replay returns original decision and Execution Scope');
  denied(await decide(picToken, { decision: 'REJECT' }), 409, 'HANDYMAN_QUOTATION_DECISION_CONFLICT', 'changed-body decision replay');
  assert.equal(await scopeCount(), 1);
  assert.equal((await q('SELECT * FROM handyman_quotation_decisions WHERE quotation_version_id = $1', [versionId])).rowCount, 1);
  const events = await q("SELECT * FROM operational_events WHERE entity_id = $1 AND event_type = 'HANDYMAN_QUOTATION_APPROVED'", [versionId]);
  assert.equal(events.rowCount, 1, 'approval and replay emit exactly one approval event');
  assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id = $1', [versionId])).rows[0].status, 'APPROVED');
  assert.equal((await q('SELECT tenant_pic_id FROM handyman_service_requests WHERE id = $1', [requestId])).rows[0].tenant_pic_id, null, 'late PIC binding does not rewrite Care intake history');
  await preservedHistory();
  const policy = await api().get(`${HM}/${requestId}/triage`).set(auth(ops.token));
  assert.deepEqual(policy.body.data, savedPolicy, 'approval does not rewrite the inspection triage snapshot');
  step('Tenant PIC approval creates one correctly attributed Execution Scope; replay/conflict, audit and immutable intake/attempt/report history');
});
