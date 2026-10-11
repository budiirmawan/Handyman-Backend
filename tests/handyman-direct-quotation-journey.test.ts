import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, it } from 'node:test';
import type { PicWorkspaceAssertion } from '../src/modules/handyman-pic-session';
import { api } from './helpers/http';
import { startDirectQuotationFixture, closeDirectQuotationFixture, auth, status, denied } from './helpers/handyman-direct-quotation';

let f: Awaited<ReturnType<typeof startDirectQuotationFixture>>;
before(async () => { f = await startDirectQuotationFixture(55510); });
after(closeDirectQuotationFixture);
const HM = '/api/v1/handyman/requests';
const HQ = '/api/v1/handyman/quotations';
const HV = '/api/v1/handyman/quotation-versions';
const PIC = '/api/v1/handyman/pic';

it('direct quotation: signed Care intake → explicit authorized scope → diagnosis/DRAFT → signed PIC APPROVE → Execution Scope, without inspection', async (t) => {
  const { q, ops, tenantCompanyId, buildingId, tenantPicId, spaceId, picCode, picIntegrationId } = f;
  const step = (label: string) => t.diagnostic(`PASS: ${label}`);
  const intake = await f.intake();
  status(intake, 201, 'signed Care intake');
  const requestId = intake.body.data.id as string;
  assert.equal(intake.body.data.status, 'INTAKE');
  assert.equal(intake.body.data.tenantPicId, null);
  const noInspection = async () => {
    for (const table of ['handyman_request_inspection_assignments', 'handyman_request_inspections',
      'handyman_request_inspection_reports', 'handyman_request_inspection_report_reviews']) {
      assert.equal((await q(`SELECT count(*)::int AS n FROM ${table} WHERE handyman_request_id=$1`, [requestId])).rows[0].n, 0,
        `direct path must not manufacture ${table}`);
    }
  };
  const scopeCount = async () => (await q('SELECT count(*)::int AS n FROM handyman_execution_scopes WHERE handyman_request_id=$1', [requestId])).rows[0].n;
  const noScope = async () => assert.equal(await scopeCount(), 0, 'scope requires Tenant PIC approval');
  status(await f.configure('DIRECT_ALLOWED'), 200, 'catalog manager explicitly permits direct quotation');
  const triage = await api().post(`${HM}/${requestId}/triage`).set(auth(ops.token)).send({
    disposition: 'DIAGNOSIS', note: 'Operations reviewed documented scope.', scopeClarityConfirmed: true,
    directQuotationReason: 'Confirmed unit measurements and fixed component specification remove the need for a site inspection.',
  });
  status(triage, 201, 'Operations confirms sufficiently clear scope');
  const savedPolicy = triage.body.data;
  assert.equal(savedPolicy.serviceInspectionPolicy, 'DIRECT_ALLOWED');
  assert.equal(savedPolicy.policyServiceCatalogId, f.catalogId);
  assert.equal(savedPolicy.scopeClarityConfirmed, true);
  assert.equal(savedPolicy.actorUserId, ops.userId);
  // The service can change for future requests without retroactively altering
  // the saved Operations decision that authorizes this one.
  status(await f.configure('INSPECTION_REQUIRED'), 200, 'restrict future direct decisions');
  const diagnosis = await api().post(`${HM}/${requestId}/diagnosis`).set(auth(ops.token))
    .send({ disciplineId: f.disciplineId, diagnosis: 'Replace the specified pipe joint.' });
  status(diagnosis, 201, 'direct diagnosis from saved authorization');
  assert.equal(diagnosis.body.data.sourceInspectionReportId, null);
  const drafted = await api().post(`${HM}/${requestId}/quotation`).set(auth(ops.token)).send({});
  status(drafted, 201, 'direct DRAFT');
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
  await noInspection(); await noScope();
  step('explicit service permission and Operations decision persist; direct diagnosis and issue require no inspection');
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
  await noInspection();
  const policy = await api().get(`${HM}/${requestId}/triage`).set(auth(ops.token));
  assert.deepEqual(policy.body.data, savedPolicy, 'approval does not rewrite the direct authorization snapshot');
  step('Tenant PIC approval creates one correctly attributed Execution Scope; replay/conflict, audit and immutable intake/policy history');
});
