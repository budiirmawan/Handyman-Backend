import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { migration0447HandymanDiagnosisInspectionSource as migration } from '../src/database/migrations/0447_handyman_diagnosis_inspection_source';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handymanServiceRequestService, handymanServiceRequestTriageService } from '../src/modules/handyman-requests';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser, grantPermissionToUser } from './helpers/access';
import { assignFieldInspectorFixture, initHandymanFixtures, realmFixture, locationChain } from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';
import { api } from './helpers/http';

// Only this focused file runs. An unavailable DB is a failure, never a skip.
const embedded = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
if (embedded) Object.assign(process.env, {
  DB_HOST: '127.0.0.1', DB_PORT: '55507', DB_USER: 'postgres', DB_PASSWORD: '',
  DB_NAME: 'handyman_part_c_test', DB_SSL: 'false',
});
let pg: EmbeddedPostgres | undefined;
let dataDir: string | undefined;
let pool: Pool;
let adminUserId: string;
let adminToken: string;
let fieldUserId: string;
let fieldToken: string;
let outsiderToken: string;
let disciplineId: string;
const HM = '/api/v1/handyman/requests';
const HQ = '/api/v1/handyman/quotations';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

before(async () => {
  if (embedded) {
    dataDir = await mkdtemp(join(tmpdir(), 'handyman-part-c-'));
    pg = new EmbeddedPostgres({ databaseDir: dataDir, port: 55507,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await pg.initialise();
    await pg.start();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'PART C requires isolated PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;
  outsiderToken = (await createAdminUser()).token;
  const field = await userService.createUser({ email: `field-${suffix()}@example.com`, displayName: 'Field' });
  fieldUserId = field.id;
  const { credentialService } = await import('../src/modules/auth');
  await credentialService.createInitialCredential({ userId: field.id, password: 'FieldPass123' });
  const login = await api().post('/api/v1/auth/login').send({ email: field.email, password: 'FieldPass123' });
  assert.equal(login.status, 200);
  fieldToken = login.body.data.sessionToken;
  await grantPermissionToUser(adminUserId, 'handyman.operations.inspection.report.review', 'Review reports');
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  disciplineId = discipline.id;
  initHandymanFixtures({ adminUserId, disciplineId, query: q });
});
after(async () => {
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function fixture(options: { direct?: boolean; notInspectable?: boolean } = {}) {
  const realm = await realmFixture('PART C');
  const { client, building } = realm;
  const chain = await locationChain(realm);
  const company = await tenantCompanyService.createTenantCompany({
    clientId: client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId: chain.space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    tenantPicId: pic.id,
    spaceId: chain.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({
    handymanRequestId: request.id,
    triageDisposition: options.direct ? 'DIAGNOSIS' : 'INSPECTION_REQUIRED',
    triageNote: options.direct ? 'Existing direct path; eligibility policy deferred.' : 'Inspect on site.',
  }, adminUserId);
  if (!options.direct) {
    await buildingAssignmentService.createAssignment(fieldUserId, { buildingId: building.id });
    await assignFieldInspectorFixture(request.id, fieldUserId, adminUserId);
    const inspected = await api().post(`${HM}/${request.id}/inspection`).set(auth(fieldToken))
      .send({ result: options.notInspectable ? 'NOT_INSPECTABLE' : 'INSPECTED', notes: 'Physical inspection fact.' });
    assert.equal(inspected.status, 201, JSON.stringify(inspected.body));
  }
  return { request, client, building };
}

async function report(requestId: string, selectedDiscipline = disciplineId) {
  const response = await api().post(`${HM}/${requestId}/inspection-reports`).set(auth(fieldToken))
    .send({ disciplineId: selectedDiscipline, technicalFindings: 'Pipe findings.', proposedDiagnosis: 'Repair joint.' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}
async function review(requestId: string, reportId: string, decision = 'ACCEPTED') {
  const response = await api().post(`${HM}/${requestId}/inspection-reports/${reportId}/review`).set(auth())
    .send({ decision, ...(decision === 'RETURNED' ? { returnReason: 'Clarify findings.' } : {}) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}
const diagnose = (requestId: string, extra: Record<string, unknown> = {}, token = adminToken) =>
  api().post(`${HM}/${requestId}/diagnosis`).set(auth(token))
    .send({ disciplineId, diagnosis: 'Operations diagnosis after review.', ...extra });
const draft = (requestId: string, token = adminToken) =>
  api().post(`${HM}/${requestId}/quotation`).set(auth(token)).send({});
const revise = (quotationId: string, token = adminToken) =>
  api().post(`${HQ}/${quotationId}/versions`).set(auth(token)).send({});
function conflict(response: { status: number; body: any }, code: string) {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}
const ACCEPTED_REQUIRED = 'HANDYMAN_INSPECTION_ACCEPTED_REPORT_REQUIRED';
const SOURCE_REQUIRED = 'HANDYMAN_INSPECTION_DIAGNOSIS_SOURCE_REQUIRED';

/** Historical thread fixture only: deliberately no new service gate involved. */
async function historicalThread(requestId: string) {
  const id = randomUUID();
  await q(`INSERT INTO handyman_quotations (id, client_id, handyman_request_id, created_by_user_id)
    SELECT $1, client_id, id, $3 FROM handyman_service_requests WHERE id = $2`, [id, requestId, adminUserId]);
  await q(`INSERT INTO handyman_quotation_versions (id, quotation_id, version_number, status, created_by_user_id)
    VALUES ($1, $2, 1, 'DRAFT', $3)`, [randomUUID(), id, adminUserId]);
  return id;
}

describe('CR-HM-INSPECTION-01 PART C — diagnosis and DRAFT prerequisite', () => {
  it('0447 up/down preserves historical rows; no backfill, no missing-report grandfathering', async () => {
    // First test, before any linked diagnosis exists. Exercise ONLY the new
    // migration in one transaction; no old migration or trigger is changed.
    const f = await fixture();
    const thread = await historicalThread(f.request.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await migration.down(client);
      await client.query(`INSERT INTO handyman_request_diagnoses
        (id, client_id, handyman_request_id, channel_attribution_id, building_id,
         handyman_discipline_id, discipline_code, diagnosis, scope_classification, diagnosed_by_user_id)
        SELECT $1, r.client_id, r.id, r.channel_attribution_id, r.building_id,
          d.id, d.code, 'Historical diagnosis', 'GENERAL_HANDYMAN', $3
        FROM handyman_service_requests r CROSS JOIN handyman_disciplines d
        WHERE r.id = $2 AND d.id = $4`, [randomUUID(), f.request.id, adminUserId, disciplineId]);
      const before = (await client.query('SELECT * FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [f.request.id])).rows[0];
      await migration.up(client);
      const after = (await client.query('SELECT * FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [f.request.id])).rows[0];
      assert.deepEqual(after, { ...before, source_inspection_report_id: null });
      const fk = await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'handyman_diagnosis_inspection_source_fk'`);
      assert.match(fk.rows[0].definition, /FOREIGN KEY \(source_inspection_report_id, handyman_request_id\)/);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    const snapshot = (await q('SELECT * FROM handyman_quotation_versions WHERE quotation_id = $1', [thread])).rows;
    const read = await api().get(`${HM}/${f.request.id}/diagnosis`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.sourceInspectionReportId, null);
    conflict(await draft(f.request.id), ACCEPTED_REQUIRED);
    conflict(await revise(thread), ACCEPTED_REQUIRED);
    const accepted = await report(f.request.id);
    await review(f.request.id, accepted.id);
    // Acceptance does not rewrite historical diagnosis or manufacture a link.
    conflict(await draft(f.request.id), SOURCE_REQUIRED);
    conflict(await revise(thread), SOURCE_REQUIRED);
    assert.deepEqual((await q('SELECT * FROM handyman_quotation_versions WHERE quotation_id = $1', [thread])).rows, snapshot);
    assert.equal((await q('SELECT source_inspection_report_id FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [f.request.id])).rows[0].source_inspection_report_id, null);
  });

  it('missing, pending, returned and pending-correction reports block diagnosis and both DRAFT writers', async () => {
    const f = await fixture();
    const thread = await historicalThread(f.request.id);
    const checkBlocked = async () => {
      conflict(await diagnose(f.request.id, { sourceInspectionReportId: randomUUID() }), ACCEPTED_REQUIRED);
      conflict(await draft(f.request.id), ACCEPTED_REQUIRED);
      conflict(await revise(thread), ACCEPTED_REQUIRED);
      assert.equal((await q('SELECT * FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [f.request.id])).rowCount, 0);
      assert.equal((await q("SELECT * FROM operational_events WHERE entity_id = $1 AND event_type = 'HANDYMAN_DIAGNOSIS_RECORDED'", [f.request.id])).rowCount, 0);
      assert.equal((await q('SELECT status FROM handyman_service_requests WHERE id = $1', [f.request.id])).rows[0].status, 'DIAGNOSIS');
      assert.equal((await q('SELECT * FROM handyman_quotation_versions WHERE quotation_id = $1', [thread])).rowCount, 1);
    };
    await checkBlocked();
    const v1 = await report(f.request.id);
    await checkBlocked();
    await review(f.request.id, v1.id, 'RETURNED');
    await checkBlocked();
    const v2 = await report(f.request.id);
    assert.equal(v2.supersedesReportId, v1.id);
    await checkBlocked();
    await review(f.request.id, v2.id);
    const diagnosis = await diagnose(f.request.id, { sourceInspectionReportId: v1.id });
    assert.equal(diagnosis.status, 201, JSON.stringify(diagnosis.body));
    assert.equal(diagnosis.body.data.sourceInspectionReportId, v2.id);
    assert.equal((await revise(thread)).status, 201);
  });

  it('accepted source is server-derived; separate diagnosis actor, atomic audit and concurrent DRAFT revisions survive', async () => {
    const f = await fixture();
    const accepted = await report(f.request.id);
    await review(f.request.id, accepted.id);
    assert.equal((await q('SELECT * FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [f.request.id])).rowCount, 0);
    conflict(await draft(f.request.id), SOURCE_REQUIRED);
    const responses = await Promise.all([diagnose(f.request.id, {
      sourceInspectionReportId: randomUUID(), diagnosedByUserId: fieldUserId,
      scopeClassification: 'OUT_OF_HANDYMAN_SCOPE',
    }), diagnose(f.request.id)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const diagnosis = responses.find(r => r.status === 201)!.body.data;
    assert.equal(diagnosis.sourceInspectionReportId, accepted.id);
    assert.equal(diagnosis.diagnosedByUserId, adminUserId);
    assert.equal(diagnosis.scopeClassification, 'GENERAL_HANDYMAN');
    const read = await api().get(`${HM}/${f.request.id}/diagnosis`).set(auth());
    assert.deepEqual(read.body.data, diagnosis);
    const events = await q("SELECT metadata FROM operational_events WHERE entity_id = $1 AND event_type = 'HANDYMAN_DIAGNOSIS_RECORDED'", [f.request.id]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].metadata.sourceInspectionReportId, accepted.id);
    const created = await draft(f.request.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const thread = created.body.data.quotation.id;
    const revisions = await Promise.all([revise(thread), revise(thread)]);
    assert.ok(revisions.every(r => r.status === 201), JSON.stringify(revisions.map(r => r.body)));
    assert.deepEqual(revisions.map(r => r.body.data.versionNumber).sort(), [2, 3]);
    assert.equal((await q('SELECT * FROM handyman_execution_scopes WHERE handyman_request_id = $1', [f.request.id])).rowCount, 0);
    const staff = await api().post(`/api/v1/handyman/quotation-versions/${created.body.data.versions[0].id}/decision`)
      .set(auth()).send({ decision: 'APPROVED' });
    assert.equal(staff.status, 403, JSON.stringify(staff.body));
  });

  it('accepted NOT_INSPECTABLE cannot authorize initial or revision DRAFT', async () => {
    const f = await fixture({ notInspectable: true });
    const accepted = await report(f.request.id);
    await review(f.request.id, accepted.id);
    assert.equal((await diagnose(f.request.id)).status, 201);
    conflict(await draft(f.request.id), 'HANDYMAN_INSPECTION_NOT_QUOTABLE');
    const thread = await historicalThread(f.request.id);
    conflict(await revise(thread), 'HANDYMAN_INSPECTION_NOT_QUOTABLE');
    assert.equal((await q('SELECT * FROM handyman_quotation_versions WHERE quotation_id = $1', [thread])).rowCount, 1);
  });

  it('accepted reports do not override F9 non-quoteable diagnosis, including revisions', async () => {
    const f = await fixture();
    const out = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'OUT_OF_HANDYMAN_SCOPE');
    assert.ok(out);
    const accepted = await report(f.request.id, out.id);
    await review(f.request.id, accepted.id);
    const diagnosis = await diagnose(f.request.id, { disciplineId: out.id });
    assert.equal(diagnosis.status, 201, JSON.stringify(diagnosis.body));
    conflict(await draft(f.request.id), 'HANDYMAN_QUOTATION_SCOPE_INSUFFICIENT');
    const thread = await historicalThread(f.request.id);
    conflict(await revise(thread), 'HANDYMAN_QUOTATION_SCOPE_INSUFFICIENT');
  });

  it('direct DIAGNOSIS retains null provenance and existing draft/revision behavior; policy remains deferred', async () => {
    const f = await fixture({ direct: true });
    const diagnosis = await diagnose(f.request.id, { sourceInspectionReportId: randomUUID() });
    assert.equal(diagnosis.status, 201, JSON.stringify(diagnosis.body));
    assert.equal(diagnosis.body.data.sourceInspectionReportId, null);
    const created = await draft(f.request.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await revise(created.body.data.quotation.id)).status, 201);
    assert.equal((await q('SELECT * FROM handyman_request_inspection_reports WHERE handyman_request_id = $1', [f.request.id])).rowCount, 0);
  });

  it('existing exact-Building and manage authority precede the prerequisite', async () => {
    const f = await fixture();
    const thread = await historicalThread(f.request.id);
    for (const token of [outsiderToken, fieldToken]) {
      assert.equal((await diagnose(f.request.id, {}, token)).status, 403);
      assert.equal((await draft(f.request.id, token)).status, 403);
      assert.equal((await revise(thread, token)).status, 403);
    }
    assert.equal((await api().post(`${HM}/${f.request.id}/diagnosis`).send({ disciplineId, diagnosis: 'Denied.' })).status, 401);
  });

  it('database refuses missing/pending/returned/cross-request sources and mutation of a linked diagnosis', async () => {
    const f = await fixture();
    const other = await fixture();
    const acceptedOther = await report(other.request.id);
    await review(other.request.id, acceptedOther.id);
    const insert = (source: string | null) => q(`INSERT INTO handyman_request_diagnoses
      (id, client_id, handyman_request_id, channel_attribution_id, building_id,
       handyman_discipline_id, discipline_code, diagnosis, scope_classification, diagnosed_by_user_id, source_inspection_report_id)
      SELECT $1, r.client_id, r.id, r.channel_attribution_id, r.building_id,
        d.id, d.code, 'Raw insertion', 'GENERAL_HANDYMAN', $3, $5
      FROM handyman_service_requests r CROSS JOIN handyman_disciplines d
      WHERE r.id = $2 AND d.id = $4`, [randomUUID(), f.request.id, adminUserId, disciplineId, source]);
    for (const source of [null, randomUUID(), acceptedOther.id]) {
      await assert.rejects(insert(source), { code: '23514', constraint: 'handyman_diagnosis_accepted_inspection_source' });
    }
    const pending = await report(f.request.id);
    await assert.rejects(insert(pending.id), { code: '23514' });
    await review(f.request.id, pending.id, 'RETURNED');
    await assert.rejects(insert(pending.id), { code: '23514' });
    const accepted = await report(f.request.id);
    await review(f.request.id, accepted.id);
    await insert(accepted.id);
    await assert.rejects(q('UPDATE handyman_request_diagnoses SET source_inspection_report_id = NULL WHERE handyman_request_id = $1', [f.request.id]), /append|immutable/i);
    await assert.rejects(q('DELETE FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [f.request.id]), /append|immutable/i);
  });
});
