import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { migration0451HandymanCareCommunications } from '../src/database/migrations/0451_handyman_care_communications';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { api } from './helpers/http';
import { createAdminUser } from './helpers/access';

const V1 = '/api/v1';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const routes = (b: string, r: string) => `${V1}/handyman/care/buildings/${b}/requests/${r}/communications`;
let pg: EmbeddedPostgres;
let dir = '';
let pool: Pool;
let adminId = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-care-communications-'));
  const port = 56000 + Math.floor(Math.random() * 800);
  pg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'password', persistent: false });
  await pg.initialise(); await pg.start();
  pool = await initDatabase({ host: '127.0.0.1', port, name: 'postgres', user: 'postgres', password: 'password', ssl: false, poolMin: 1, poolMax: 12 });
  await migrateUp(pool);
  const admin = await createAdminUser(); adminId = admin.userId;
});
after(async () => { await closePool(getPool()).catch(() => undefined); if (pg) await pg.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function setup(withCarePermission = true) {
  const tag = suffix();
  const client = await clientService.createClient({ code: `CC_${tag}`, name: `Client ${tag}` });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${tag}`, name: 'Care Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${tag}`, name: 'Care Building' });
  const sibling = await buildingService.createBuilding({ propertyId: property.id, code: `S_${tag}`, name: 'Sibling' });
  await buildingAssignmentService.createAssignment(adminId, { buildingId: building.id });
  const company = await tenantCompanyService.createTenantCompany({ clientId: client.id, tenantCode: `T_${tag}`, tenantName: 'Tenant' }, adminId);
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${tag}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${tag}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${tag}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `SP_${tag}`, name: 'Unit' });
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id }, adminId);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: company.id, buildingId: building.id }, adminId);
  const attribution = await createChannelAttribution({ tenantCompanyId: company.id, buildingId: building.id, originChannel: 'BM_SUPER_APP', originReference: `ref-${tag}` });
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: client.id, code: `SV_${tag}`, name: 'Repair', category: 'HANDYMAN' }, adminId);
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attribution.id, serviceCatalogId: service.id }, adminId);
  const email = `care-${tag.toLowerCase()}@example.test`; const password = `Password-${tag}!1`;
  const user = await userService.createUser({ email, displayName: 'Building Care' });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: `CARE_${tag}`, name: 'Care' });
  if (withCarePermission) {
    let perm = await permissionRepository.findByCode(HANDYMAN_CARE_BUILDING_PERMISSION);
    if (!perm) perm = await permissionService.createPermission({ code: HANDYMAN_CARE_BUILDING_PERMISSION, name: 'Building care' });
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const assignment = await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { client, building, sibling, request, user, token: login.body.data.sessionToken, assignment };
}
const payload = (key: string, extra = {}) => ({ purpose: 'SERVICE_REQUEST_FOLLOW_UP', reportedContactName: 'Tenant PIC', channel: 'PHONE', statement: 'Tenant called about the repair.', reportedStatement: 'CONFIRM', idempotencyKey: key, ...extra });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('CR-HM-BM-CARE-EVIDENCE-01 real authenticated HTTP intake', () => {
  it('persists scoped communication and exact-request active evidence; lists it and replays idempotently', async () => {
    const f = await setup();
    const evidenceId = randomUUID();
    await pool.query(`INSERT INTO evidence_submissions (id,client_id,execution_type,execution_id,evidence_type,file_reference,original_file_name,mime_type,file_size,submitted_by_user_id) VALUES ($1,$2,'HANDYMAN_REQUEST',$3,'DOCUMENT','test/key','call.pdf','application/pdf',12,$4)`, [evidenceId, f.client.id, f.request.id, f.user.id]);
    const path = routes(f.building.id, f.request.id); const body = payload(`idem-${suffix()}`, { evidenceIds: [evidenceId] });
    const beforeBusiness = await pool.query(`SELECT (SELECT count(*) FROM handyman_quotation_versions) q, (SELECT count(*) FROM handyman_scope_variations) v, (SELECT count(*) FROM handyman_bast_documents) b, (SELECT count(*) FROM handyman_customer_payments) p, (SELECT count(*) FROM work_orders) w`);
    const post = await api().post(path).set(auth(f.token)).send(body);
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal(post.body.data.recorded_by_user_id, f.user.id);
    assert.equal(post.body.data.verification_state, 'PENDING_VERIFICATION');
    const replay = await api().post(path).set(auth(f.token)).send(body);
    assert.equal(replay.status, 200); assert.equal(replay.body.data.id, post.body.data.id); assert.equal(replay.body.data.replayed, true);
    const changed = await api().post(path).set(auth(f.token)).send({ ...body, statement: 'Changed intent' });
    assert.equal(changed.status, 400);
    const get = await api().get(path).set(auth(f.token));
    assert.equal(get.status, 200); assert.equal(get.body.data.length, 1); assert.deepEqual(get.body.data[0].evidenceIds, [evidenceId]);
    assert.equal(Number((await pool.query('SELECT count(*)::int n FROM handyman_care_communications')).rows[0].n), 1);
    assert.equal(Number((await pool.query('SELECT count(*)::int n FROM handyman_care_communication_evidence')).rows[0].n), 1);
    const afterBusiness = await pool.query(`SELECT (SELECT count(*) FROM handyman_quotation_versions) q, (SELECT count(*) FROM handyman_scope_variations) v, (SELECT count(*) FROM handyman_bast_documents) b, (SELECT count(*) FROM handyman_customer_payments) p, (SELECT count(*) FROM work_orders) w`);
    assert.deepEqual(afterBusiness.rows, beforeBusiness.rows);
  });
  it('denies unauthenticated, sibling/wrong Building, actor spoof, foreign/inactive evidence, and non-Care user', async () => {
    const f = await setup(); const path = routes(f.building.id, f.request.id); const body = payload(`security-${suffix()}`);
    assert.equal((await api().post(path).send(body)).status, 401);
    assert.notEqual((await api().post(routes(f.sibling.id, f.request.id)).set(auth(f.token)).send(body)).status, 201);
    assert.notEqual((await api().get(routes(f.sibling.id, f.request.id)).set(auth(f.token))).status, 200);
    assert.equal((await api().post(path).set(auth(f.token)).send({ ...body, recordedByUserId: adminId })).status, 400);
    const noPermission = await setup(false);
    assert.notEqual((await api().post(routes(noPermission.building.id, noPermission.request.id)).set(auth(noPermission.token)).send(payload(`no-perm-${suffix()}`))).status, 201);
    const other = await setup();
    assert.notEqual((await api().get(routes(f.building.id, other.request.id)).set(auth(f.token))).status, 200);
    assert.notEqual((await api().post(routes(f.building.id, other.request.id)).set(auth(f.token)).send(payload(`cross-client-${suffix()}`))).status, 201);
    const foreign = randomUUID();
    await pool.query(`INSERT INTO evidence_submissions (id,client_id,execution_type,execution_id,evidence_type,file_reference,original_file_name,mime_type,file_size,status) VALUES ($1,$2,'HANDYMAN_REQUEST',$3,'DOCUMENT','foreign/key','x.pdf','application/pdf',1,'ACTIVE')`, [foreign, other.client.id, other.request.id]);
    assert.equal((await api().post(path).set(auth(f.token)).send(payload(`foreign-${suffix()}`, { evidenceIds: [foreign] }))).status, 400);
    const inactive = randomUUID();
    await pool.query(`INSERT INTO evidence_submissions (id,client_id,execution_type,execution_id,evidence_type,file_reference,original_file_name,mime_type,file_size,status) VALUES ($1,$2,'HANDYMAN_REQUEST',$3,'DOCUMENT','inactive/key','x.pdf','application/pdf',1,'REMOVED')`, [inactive, f.client.id, f.request.id]);
    assert.equal((await api().post(path).set(auth(f.token)).send(payload(`inactive-${suffix()}`, { evidenceIds: [inactive] }))).status, 400);
  });
  it('serializes concurrent identical POSTs to one row; revoked Building access denies replay and GET', async () => {
    const f = await setup(); const path = routes(f.building.id, f.request.id); const body = payload(`parallel-${suffix()}`);
    const pair = await Promise.all([api().post(path).set(auth(f.token)).send(body), api().post(path).set(auth(f.token)).send(body)]);
    assert.ok(pair.every(x => x.status === 200 || x.status === 201), JSON.stringify(pair.map(x => [x.status, x.body])));
    assert.equal(pair[0].body.data.id, pair[1].body.data.id);
    assert.equal(Number((await pool.query('SELECT count(*)::int n FROM handyman_care_communications WHERE idempotency_key=$1', [body.idempotencyKey])).rows[0].n), 1);
    await buildingAssignmentService.deactivateAssignment(f.user.id, f.building.id);
    assert.notEqual((await api().post(path).set(auth(f.token)).send(body)).status, 200);
    assert.notEqual((await api().get(path).set(auth(f.token))).status, 200);
  });
  it('0451 rolls back and reapplies cleanly without changing evidence owner vocabulary', async () => {
    const client = await pool.connect();
    try {
      await migration0451HandymanCareCommunications.down(client);
      await migration0451HandymanCareCommunications.up(client);
      const types = await client.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='evidence_submission_execution'`);
      assert.equal(types.rows.length, 1);
      assert.match(types.rows[0].d, /HANDYMAN_REQUEST/);
      assert.equal((await client.query(`SELECT to_regclass('handyman_care_communications') AS t`)).rows[0].t, 'handyman_care_communications');
    } finally { client.release(); }
  });
});
