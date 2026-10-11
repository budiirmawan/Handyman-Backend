import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, it } from 'node:test';
import { withTransaction } from '../src/database';
import { migration0448HandymanDirectQuotationPolicy as migration } from '../src/database/migrations/0448_handyman_direct_quotation_policy';
import { recordHandymanRequestTriage } from '../src/modules/handyman-requests/handyman-request-triage.service';
import { recordHandymanDiagnosis } from '../src/modules/handyman-requests/handyman-request-diagnosis.service';
import { createHandymanQuotation, createHandymanQuotationRevision } from '../src/modules/handyman-quotations/handyman-quotation.service';
import { resolveTriagePolicy } from '../src/modules/handyman-requests/handyman-direct-quotation-policy';
import { handymanServiceRequestRepository } from '../src/modules/handyman-requests/handyman-service-request.repository';
import { api } from './helpers/http';
import { startDirectQuotationFixture, closeDirectQuotationFixture, auth, status, denied } from './helpers/handyman-direct-quotation';

let f: Awaited<ReturnType<typeof startDirectQuotationFixture>>;
const HM = '/api/v1/handyman/requests';
const REASON = 'Documented unit dimensions and fixed replacement specification make the scope sufficiently clear.';
const CODE = 'HANDYMAN_DIRECT_QUOTATION_NOT_AUTHORIZED';
before(async () => { f = await startDirectQuotationFixture(55509); });
after(closeDirectQuotationFixture);
const triage = (id: string, extra: object = {}, token = f.ops.token) => api().post(`${HM}/${id}/triage`).set(auth(token))
  .send({ disposition: 'DIAGNOSIS', note: 'Operations assessed the service scope.', scopeClarityConfirmed: true, directQuotationReason: REASON, ...extra });
const diagnose = (id: string) => api().post(`${HM}/${id}/diagnosis`).set(auth(f.ops.token)).send({ disciplineId: f.disciplineId, diagnosis: 'Replace specified component.' });
const draft = (id: string) => api().post(`${HM}/${id}/quotation`).set(auth(f.ops.token)).send({});
const revise = (id: string) => api().post(`/api/v1/handyman/quotations/${id}/versions`).set(auth(f.ops.token)).send({});
const noTriage = async (id: string) => {
  assert.equal((await f.q('SELECT * FROM handyman_request_triage_decisions WHERE handyman_request_id=$1', [id])).rowCount, 0);
  assert.equal((await f.q('SELECT status FROM handyman_service_requests WHERE id=$1', [id])).rows[0].status, 'INTAKE');
};

it('defaults existing/unconfigured services to inspection; note-only and caller-shaped policy never grant direct authority', async () => {
  const service = (await f.q('SELECT inspection_policy FROM service_catalog WHERE id=$1', [f.catalogId])).rows[0];
  assert.equal(service.inspection_policy, 'INSPECTION_REQUIRED');
  const r = await f.createRequest();
  denied(await triage(r.id, { serviceInspectionPolicy: 'DIRECT_ALLOWED', policyServiceCatalogId: randomUUID() }), 409, CODE, 'default service denies direct');
  await noTriage(r.id);
  const inspected = await api().post(`${HM}/${r.id}/triage`).set(auth(f.ops.token)).send({ note: 'Use the default inspection path.' });
  status(inspected, 201, 'omitted disposition defaults to inspection');
  assert.equal(inspected.body.data.triageDisposition, 'INSPECTION_REQUIRED');
  assert.equal(inspected.body.data.serviceInspectionPolicy, 'INSPECTION_REQUIRED');
  assert.equal(inspected.body.data.scopeClarityConfirmed, null);
  denied(await draft(r.id), 409, 'HANDYMAN_INSPECTION_ACCEPTED_REPORT_REQUIRED', 'inspection gate survives');
  status(await f.configure('DIRECT_ALLOWED'), 200, 'explicit configuration');
  const another = await f.createRequest();
  for (const extra of [
    { scopeClarityConfirmed: undefined, directQuotationReason: undefined },
    { scopeClarityConfirmed: false }, { scopeClarityConfirmed: 'true' },
    { directQuotationReason: 'ok' }, { directQuotationReason: ' '.repeat(30) },
    { directQuotationReason: 'a'.repeat(30) }, { directQuotationReason: 'word '.repeat(110) },
  ]) {
    status(await triage(another.id, extra), 400, 'explicit clarity and bounded meaningful reason required');
    await noTriage(another.id);
  }
});

it('enforces actor, exact Building and configuration authority in HTTP and direct service calls', async () => {
  const r = await f.createRequest();
  denied(await triage(r.id, {}, f.field.token), 403, 'PERMISSION_DENIED', 'Field cannot grant direct scope');
  denied(await triage(r.id, {}, f.otherOps.token), 403, 'BUILDING_ACCESS_DENIED', 'same Client does not grant Building');
  await assert.rejects(recordHandymanRequestTriage({ handymanRequestId: r.id, triageDisposition: 'DIAGNOSIS',
    triageNote: 'Service call', scopeClarityConfirmed: true, directQuotationReason: REASON }, f.field.userId), { code: 'PERMISSION_DENIED' });
  denied(await api().patch(`/api/v1/service-catalog/entries/${f.catalogId}`).set(auth(f.ops.token)).send({ inspectionPolicy: 'DIRECT_ALLOWED' }),
    403, 'PERMISSION_DENIED', 'Operations triage permission is not catalog management');
  status(await f.configure('SOMETIMES'), 400, 'unknown policy rejected');
  status(await api().patch(`/api/v1/service-catalog/entries/${f.catalogId}`).set(auth(f.master.token)).send({ inspectionPolicy: null }), 400, 'null policy rejected');
  await noTriage(r.id);
});

it('snapshots policy/service/actor/time/clarity/reason; later restriction affects only new decisions, not historical authorization', async () => {
  status(await f.configure('DIRECT_ALLOWED'), 200, 'enable direct');
  const r = await f.createRequest();
  const authorized = await triage(r.id);
  status(authorized, 201, 'authorized direct triage');
  const snapshot = authorized.body.data;
  assert.equal(snapshot.serviceInspectionPolicy, 'DIRECT_ALLOWED');
  assert.equal(snapshot.policyServiceCatalogId, f.catalogId);
  assert.equal(snapshot.scopeClarityConfirmed, true);
  assert.equal(snapshot.directQuotationReason, REASON);
  assert.equal(snapshot.actorUserId, f.ops.userId);
  assert.ok(snapshot.policyCatalogUpdatedAt);
  status(await f.configure('INSPECTION_REQUIRED'), 200, 'restrict future triage');
  const dx = await diagnose(r.id);
  status(dx, 201, 'saved authorization survives policy edit');
  assert.equal(dx.body.data.sourceInspectionReportId, null);
  const quote = await draft(r.id);
  status(quote, 201, 'direct DRAFT');
  status(await revise(quote.body.data.quotation.id), 201, 'direct revision');
  const read = await api().get(`${HM}/${r.id}/triage`).set(auth(f.ops.token));
  assert.deepEqual(read.body.data, snapshot);
  const newRequest = await f.createRequest();
  denied(await triage(newRequest.id), 409, CODE, 'new request uses restricted current policy');
  const audit = (await f.q("SELECT actor_user_id, metadata FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_REQUEST_TRIAGED'", [r.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_user_id, f.ops.userId);
  assert.equal(audit[0].metadata.directQuotationAuthorized, true);
  assert.equal(audit[0].metadata.policyServiceCatalogId, f.catalogId);
  assert.equal(audit[0].metadata.serviceInspectionPolicy, 'DIRECT_ALLOWED');
  assert.ok(!JSON.stringify(audit[0]).includes(REASON), 'reason stored on triage, not copied into journal');
  const configAudit = (await f.q("SELECT metadata FROM operational_events WHERE entity_id=$1 AND event_type='SERVICE_CATALOG_ENTRY_UPDATED' ORDER BY created_at DESC", [f.catalogId])).rows;
  assert.equal(configAudit[0].metadata.inspectionPolicy, 'INSPECTION_REQUIRED');
  await assert.rejects(f.q('UPDATE handyman_request_triage_decisions SET scope_clarity_confirmed=FALSE WHERE handyman_request_id=$1', [r.id]), /append|immutable/i);
  await assert.rejects(recordHandymanDiagnosis({ handymanRequestId: newRequest.id, disciplineId: f.disciplineId, diagnosis: 'Attempt bypass' }, f.field.userId));
  await assert.rejects(createHandymanQuotation({ handymanRequestId: r.id }, f.field.userId), { code: 'PERMISSION_DENIED' });
  await assert.rejects(createHandymanQuotationRevision(quote.body.data.quotation.id, f.field.userId), { code: 'PERMISSION_DENIED' });
});

it('missing/inactive services fail closed and a note cannot be converted into authority by raw triage insertion', async () => {
  const missing = await f.intake({ serviceCatalogId: randomUUID() });
  assert.ok(missing.status >= 400 && missing.status < 500, 'unknown selected service is rejected at intake');
  const r = await f.createRequest();
  await withTransaction(async tx => {
    const persisted = await handymanServiceRequestRepository.lockById(tx, r.id);
    assert.ok(persisted);
    await assert.rejects(resolveTriagePolicy(tx, { ...persisted, serviceCatalogId: randomUUID() }, {
      handymanRequestId: r.id, triageDisposition: 'DIAGNOSIS', triageNote: 'Missing service', scopeClarityConfirmed: true, directQuotationReason: REASON,
    }, f.ops.userId), { code: CODE });
  });
  await assert.rejects(f.q(`INSERT INTO handyman_request_triage_decisions
    (id,client_id,handyman_request_id,channel_attribution_id,building_id,triage_disposition,triage_note,actor_user_id)
    SELECT $1,client_id,id,channel_attribution_id,building_id,'DIAGNOSIS','A note is not authority',$3
    FROM handyman_service_requests WHERE id=$2`, [randomUUID(), r.id, f.ops.userId]), { code: '23514' });
  // Separate selected service so the shared fixture catalog remains usable.
  const service = await api().post('/api/v1/service-catalog/entries').set(auth(f.master.token)).send({ clientId: f.clientId,
    code: `INACTIVE_${randomUUID().slice(0,8)}`, name: 'Inactive candidate', category: 'HANDYMAN', inspectionPolicy: 'DIRECT_ALLOWED' });
  status(service, 201, 'create explicit policy');
  const inactiveRequest = await f.intake({ serviceCatalogId: service.body.data.id });
  status(inactiveRequest, 201, 'intake while ACTIVE');
  status(await api().post(`/api/v1/service-catalog/entries/${service.body.data.id}/deactivate`).set(auth(f.master.token)), 200, 'deactivate selected service');
  denied(await triage(inactiveRequest.body.data.id), 409, CODE, 'inactive service denied');
});

it('triage and catalog policy writes roll back with failed audit; retry writes exactly once', async () => {
  status(await f.configure('DIRECT_ALLOWED'), 200, 'policy setup');
  const r = await f.createRequest();
  // Test-only fault injection in fresh PostgreSQL: audit is not bypassed.
  await f.q(`CREATE FUNCTION test_direct_policy_audit_failure() RETURNS trigger AS $$ BEGIN
    IF NEW.event_type IN ('HANDYMAN_REQUEST_TRIAGED','SERVICE_CATALOG_ENTRY_UPDATED') THEN
      RAISE EXCEPTION 'test-only audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_direct_policy_audit_failure BEFORE INSERT ON operational_events
    FOR EACH ROW EXECUTE FUNCTION test_direct_policy_audit_failure()`);
  try {
    status(await triage(r.id), 500, 'failed triage audit');
    await noTriage(r.id);
    status(await f.configure('INSPECTION_REQUIRED'), 500, 'failed catalog audit');
    assert.equal((await f.q('SELECT inspection_policy FROM service_catalog WHERE id=$1', [f.catalogId])).rows[0].inspection_policy, 'DIRECT_ALLOWED');
    assert.equal((await f.q("SELECT * FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_REQUEST_TRIAGED'", [r.id])).rowCount, 0);
  } finally {
    await f.q('DROP TRIGGER test_direct_policy_audit_failure ON operational_events; DROP FUNCTION test_direct_policy_audit_failure()');
  }
  status(await triage(r.id), 201, 'retry after rollback');
  assert.equal((await f.q("SELECT * FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_REQUEST_TRIAGED'", [r.id])).rowCount, 1);
});

it('catalog edits and triage sampling serialize rather than recording a stale policy snapshot', async () => {
  status(await f.configure('DIRECT_ALLOWED'), 200, 'policy setup');
  const r = await f.createRequest();
  let writerPid: number;
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const edit = withTransaction(async tx => {
    writerPid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await tx.query("UPDATE service_catalog SET inspection_policy='INSPECTION_REQUIRED', updated_at=NOW() WHERE id=$1", [f.catalogId]);
    locked(); await hold;
  });
  await ready;
  try {
    const attempt = triage(r.id).then(response => response);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const waiting = await f.q('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked', [writerPid!]);
      if (waiting.rows[0].blocked) { blocked = true; break; }
      await delay(20);
    }
    assert.equal(blocked, true, 'triage waits on the catalog writer before sampling its policy');
    release(); await edit;
    denied(await attempt, 409, CODE, 'triage sees committed restriction');
    await noTriage(r.id);
  } finally { release(); await edit; }
});

it('additive migration preserves historical direct rows but never silently grants new diagnosis/DRAFT/revision authority', async () => {
  const r = await f.createRequest();
  const threadId = randomUUID();
  // Entire legacy-schema exercise rolls back, preserving every other test row.
  await withTransaction(async tx => {
    await migration.down(tx);
    await tx.query(`INSERT INTO handyman_request_triage_decisions
      (id,client_id,handyman_request_id,channel_attribution_id,building_id,triage_disposition,triage_note,actor_user_id)
      SELECT $1,client_id,id,channel_attribution_id,building_id,'DIAGNOSIS','Legacy note-only decision',$3
      FROM handyman_service_requests WHERE id=$2`, [randomUUID(), r.id, f.ops.userId]);
    const old = (await tx.query('SELECT * FROM handyman_request_triage_decisions WHERE handyman_request_id=$1', [r.id])).rows[0];
    await tx.query(`INSERT INTO handyman_request_diagnoses
      (id,client_id,handyman_request_id,channel_attribution_id,building_id,handyman_discipline_id,discipline_code,diagnosis,scope_classification,diagnosed_by_user_id)
      SELECT $1,client_id,id,channel_attribution_id,building_id,$3,'GENERAL_HANDYMAN','Legacy diagnosis','GENERAL_HANDYMAN',$4
      FROM handyman_service_requests WHERE id=$2`, [randomUUID(), r.id, f.disciplineId, f.ops.userId]);
    await tx.query('INSERT INTO handyman_quotations(id,client_id,handyman_request_id,created_by_user_id) VALUES($1,$2,$3,$4)', [threadId,f.clientId,r.id,f.ops.userId]);
    await tx.query("INSERT INTO handyman_quotation_versions(id,quotation_id,version_number,status,created_by_user_id) VALUES($1,$2,1,'DRAFT',$3)", [randomUUID(),threadId,f.ops.userId]);
    const version = (await tx.query('SELECT * FROM handyman_quotation_versions WHERE quotation_id=$1', [threadId])).rows[0];
    await migration.up(tx);
    const current = (await tx.query('SELECT * FROM handyman_request_triage_decisions WHERE handyman_request_id=$1', [r.id])).rows[0];
    assert.deepEqual(current, { ...old, service_inspection_policy: null, policy_service_catalog_id: null,
      policy_catalog_updated_at: null, scope_clarity_confirmed: null, direct_quotation_reason: null });
    assert.deepEqual((await tx.query('SELECT * FROM handyman_quotation_versions WHERE quotation_id=$1', [threadId])).rows[0], version);
    await tx.query("UPDATE service_catalog SET inspection_policy='DIRECT_ALLOWED' WHERE id=$1", [f.catalogId]);
    assert.equal((await tx.query('SELECT handyman_has_direct_quotation_authority($1) AS allowed', [r.id])).rows[0].allowed, false);
    await tx.query('SAVEPOINT denied_write');
    await assert.rejects(tx.query("INSERT INTO handyman_quotation_versions(id,quotation_id,version_number,status,created_by_user_id) VALUES($1,$2,2,'DRAFT',$3)", [randomUUID(),threadId,f.ops.userId]), { code: '23514' });
    await tx.query('ROLLBACK TO SAVEPOINT denied_write');
    // Explicit rollback by throwing a local sentinel; no schema changes survive.
    throw new Error('rollback legacy fixture');
  }).catch(error => { assert.equal(error.message, 'rollback legacy fixture'); });
  // No triage at all is also not direct authority, at both API and SQL seams.
  denied(await draft(r.id), 409, CODE, 'missing triage is not direct authorization');
  await assert.rejects(f.q(`INSERT INTO handyman_request_diagnoses
    (id,client_id,handyman_request_id,channel_attribution_id,building_id,handyman_discipline_id,discipline_code,diagnosis,scope_classification,diagnosed_by_user_id)
    SELECT $1,client_id,id,channel_attribution_id,building_id,$3,'GENERAL_HANDYMAN','No policy','GENERAL_HANDYMAN',$4
    FROM handyman_service_requests WHERE id=$2`, [randomUUID(),r.id,f.disciplineId,f.ops.userId]), { code: '23514' });
});
