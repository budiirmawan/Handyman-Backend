import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import type { Response } from 'supertest';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { sessionService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { createEvidenceStorage } from '../src/modules/evidence/storage';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  handymanServiceRequestDiagnosisService, handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine, createHandymanQuotation, createHandymanQuotationRevision,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import { handymanQuotationDecisionRepository } from '../src/modules/handyman-quotations/handyman-quotation-decision.repository';
import { handymanScopeVariationRepository } from '../src/modules/handyman-scope-variations/handyman-scope-variation.repository';
import { bootstrapOwner } from '../src/modules/iam-bootstrap/owner-bootstrap.service';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleRepository, roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicRepository, tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** PART 03: real HTTP/session/RBAC/domain SQL, actual immutable-history
 * constraints and observed PostgreSQL lock waits. No external DB or skips.
 * Variations seed an existing REVISED_QUOTATION prestate; this is not a field,
 * Finance or BAST workflow certification. Managed evidence uses real bytes.
 */
type Actor = { token: string; userId: string };
let pool: Pool;
let embedded: EmbeddedTestDatabase | undefined;
let evidenceDir: string;
let admin: Actor;
let operations: Actor;
let care: Actor;
let defaultCare: Actor;
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

async function actor(codes: readonly string[] = ['tenant_company.manage', 'tenant_company.read']) {
  const token = await createSessionWithPermissions(codes.map((code) => ({ code, name: code })));
  return { token, userId: (await sessionService.resolveSessionContext(token)).userId };
}
async function canonicalActor(code: string) {
  const token = await createPlainSession();
  const userId = (await sessionService.resolveSessionContext(token)).userId;
  const role = await roleRepository.findByCode(code);
  assert.ok(role);
  await roleService.assignRoleToUser(userId, role.id);
  return { token, userId };
}
async function assign(who: Actor, buildingId: string) {
  await buildingAssignmentService.createAssignment(who.userId, { buildingId });
}
function patch(who: Actor, picId: string, body: object) {
  return api().patch(`/api/v1/tenant-pics/${picId}`).set(auth(who)).send(body);
}
function quoteDecision(who: Actor, versionId: string, key = randomUUID(), claims: object = {}) {
  return api().post(`/api/v1/handyman/quotation-versions/${versionId}/decision`)
    .set(auth(who)).set('Idempotency-Key', key).send({ ...claims, decision: 'APPROVE' });
}
function variationDecision(who: Actor, f: VariationFixture, key = randomUUID(), claims: object = {}) {
  return api().post(`/api/v1/handyman/execution-scopes/${f.scopeId}/variations/${f.variationId}/tenant-decision`)
    .set(auth(who)).send({
      ...claims, decision: 'APPROVED', revisedQuotationVersionId: f.revised.id,
      evidenceReference: f.evidenceRef, idempotencyKey: key, expectedVersion: 1,
    });
}

async function fixture() {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'PIC Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  const customer = await actor();
  const replacement = await actor();
  for (const who of [admin, operations, care, defaultCare, customer, replacement]) await assign(who, building.id);
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Unit' });
  const company = await tenantCompanyService.createTenantCompany({
    clientId: client.id, tenantCode: `T_${suffix()}`, tenantName: 'Customer Company',
  }, admin.userId);
  const relationship = await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id,
  }, admin.userId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id, buildingId: building.id,
  }, admin.userId);
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id, picName: 'Customer PIC', email: 'contact@example.com',
    userId: customer.userId, isPrimary: true,
  }, admin.userId);
  return { client, property, building, space, company, relationship, pic, customer, replacement };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function issuedFixture() {
  const f = await fixture();
  const attribution = await createChannelAttribution({
    tenantCompanyId: f.company.id, tenantPicId: f.pic.id, buildingId: f.building.id,
    spaceId: f.space.id, originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`, createdByUserId: f.customer.userId,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: f.client.id, code: `HM_${suffix()}`, name: 'Handyman', category: 'FM_HINT_TEXT',
  }, admin.userId);
  const request = await handymanServiceRequestService.createHandymanServiceRequest({
    channelAttributionId: attribution.id, serviceCatalogId: service.id,
  }, admin.userId);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({
    handymanRequestId: request.id, triageDisposition: 'DIAGNOSIS', triageNote: 'Direct diagnosis',
  }, admin.userId);
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({
    handymanRequestId: request.id, disciplineId: discipline.id, diagnosis: 'Minor repair',
  }, admin.userId);
  const bundle = await createHandymanQuotation({ handymanRequestId: request.id }, admin.userId);
  const version = bundle.versions[0]!;
  const uomId = randomUUID();
  await pool.query(`INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
    VALUES ($1,$2,$3,'Meter','m','LENGTH')`, [uomId, f.client.id, `M_${suffix()}`]);
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'Base work', quantity: 1, uomId, currency: 'IDR', finalQuotedUnitAmount: 100,
  }, admin.userId);
  await issueHandymanQuotationVersion(version.id, { validUntil: new Date(Date.now() + 86_400_000) }, admin.userId);
  return { ...f, request, bundle, version, uomId };
}

async function variationFixture() {
  const f = await issuedFixture();
  const approval = await quoteDecision(f.customer, f.version.id);
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  const scopeId = approval.body.data.executionScope.id as string;
  const revised = await createHandymanQuotationRevision(f.bundle.quotation.id, admin.userId);
  await addHandymanQuotationLine(revised.id, {
    lineType: 'LABOR', description: 'Revised total', quantity: 1, uomId: f.uomId,
    currency: 'IDR', finalQuotedUnitAmount: 150,
  }, admin.userId);
  await issueHandymanQuotationVersion(revised.id, { validUntil: new Date(Date.now() + 86_400_000) }, admin.userId);
  const variationId = randomUUID();
  const evidenceId = randomUUID();
  const evidenceRef = `hm-ev://${evidenceId}`;
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(evidenceId)]);
  await createEvidenceStorage().put(`evidence/${evidenceId}`, { buffer: bytes, mimeType: 'image/png' });
  await pool.query(`INSERT INTO handyman_scope_variations
    (id, client_id, execution_scope_id, handyman_request_id, tenant_company_id, building_id,
     variation_type, line_type, title, description, technical_finding, quantity, uom_id,
     quoted_unit_amount, quoted_total_delta, currency, status, revised_quotation_version_id,
     origin_actor_user_id, origin_actor_role, latest_evidence_reference, create_idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6,'ADD','LABOR','Extra work','Approved review fixture','Finding',1,$7,
      50,50,'IDR','REVISED_QUOTATION',$8,$9,'INSPECTOR',$10,$11)`,
  [variationId, f.client.id, scopeId, f.request.id, f.company.id, f.building.id, f.uomId,
    revised.id, operations.userId, evidenceRef, randomUUID()]);
  await pool.query(`INSERT INTO handyman_field_evidence_uploads
    (id, client_id, tenant_company_id, building_id, handyman_request_id, execution_scope_id, variation_id,
     purpose, upload_status, original_file_name, mime_type, storage_key, declared_byte_size,
     verified_byte_size, sha256_checksum, attachment_reference, uploaded_by_user_id, uploaded_by_role,
     idempotency_key, verified_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'VARIATION_FINDING','VERIFIED','proof.png','image/png',$8,$9,$9,$10,$11,$12,
      'OPERATIONS_MANAGER',$13,NOW())`,
  [evidenceId, f.client.id, f.company.id, f.building.id, f.request.id, scopeId, variationId,
    `evidence/${evidenceId}`, bytes.length, createHash('sha256').update(bytes).digest('hex'),
    evidenceRef, operations.userId, randomUUID()]);
  return { ...f, scopeId, revised, variationId, evidenceRef };
}
type VariationFixture = Awaited<ReturnType<typeof variationFixture>>;

async function state() {
  const tables = ['tenant_pics', 'handyman_quotation_versions', 'handyman_quotation_decisions',
    'handyman_execution_scopes', 'handyman_scope_variations', 'handyman_scope_variation_events', 'operational_events'];
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tables) snapshot[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return snapshot;
}
async function denied(request: () => PromiseLike<Response>, code = 'PERMISSION_DENIED', status = 403) {
  const before = await state();
  const response = await request();
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
  assert.deepEqual(await state(), before, 'no PIC, decision, scope, history or event mutation');
}
async function linkEvents(picId: string) {
  return (await pool.query(`SELECT * FROM operational_events
    WHERE entity_id = $1 AND event_type = 'tenant_pic.identity_link_changed' ORDER BY occurred_at, id`, [picId])).rows;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function enteredBeforeResponse(entered: Promise<void>, pending: Promise<Response>) {
  await Promise.race([entered, pending.then((r) => { throw new Error(`expected transaction barrier, got HTTP ${r.status}: ${JSON.stringify(r.body)}`); })]);
}
async function waitForBlockedQuery(fragment: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE $1
    ) AS blocked`, [`%${fragment}%`]);
    if (result.rows[0]!.blocked) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`no observed PostgreSQL lock wait for ${fragment}`);
}

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'hm-pic-evidence-'));
  process.env.EVIDENCE_STORAGE_DIR = evidenceDir;
  embedded = await startEmbeddedTestDatabase({ dir: `/tmp/hm-pic-authority-${randomUUID()}`, port: 55584 });
  const db = await ensureTestDatabase();
  assert.ok(db, 'disposable PIC authority database must be available');
  pool = await initDatabase(db);
  await migrateUp(pool);
  await bootstrapOwner({ email: 'pic-owner@example.com', displayName: 'PIC Owner', password: 'PicOwnerPass123' });
  admin = await createAdminUser();
  operations = await canonicalActor('OPERATIONS');
  care = await canonicalActor('CUSTOMER_CARE');
  defaultCare = await canonicalActor('CUSTOMER_CARE');
  // Explicit extra role, not a default-role change: prove Care remains denied
  // at the identity service boundary even when ordinary contact manage is delegated.
  const contactRole = await roleService.createRole({ code: `PIC_CONTACT_${suffix()}`, name: 'Contact maintenance fixture' });
  const manage = await permissionRepository.findByCode('tenant_company.manage');
  assert.ok(manage);
  await permissionService.assignPermissionToRole(contactRole.id, manage.id);
  await roleService.assignRoleToUser(care.userId, contactRole.id);
});
after(async () => {
  try {
    if (pool) await closePool(pool);
  } finally {
    await embedded?.stop();
    if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true });
  }
});

describe('PART 03 — PIC identity and customer approval authority', () => {
  it('preserves Operations and explicitly delegated Care contact edits without changing identity', async () => {
    const f = await issuedFixture();
    const events = await linkEvents(f.pic.id);
    for (const who of [operations, care, f.customer]) {
      const response = await patch(who, f.pic.id, {
        picName: 'Updated contact', email: 'different-login@example.com', phone: '+62 812 3456789',
        roleTitle: 'Contact', userId: f.customer.userId,
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.userId, f.customer.userId);
    }
    assert.deepEqual(await linkEvents(f.pic.id), events, 'unchanged userId is not a new identity grant');
    await denied(() => patch(defaultCare, f.pic.id, { phone: '+62 812 111111' }));
    const approved = await quoteDecision(f.customer, f.version.id);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.decidedByUserId, f.customer.userId);
  });

  it('allows a scoped non-Owner identity administrator to relink with atomic server-attributed audit', async () => {
    const f = await issuedFixture();
    assert.equal((await roleService.listRolesForUser(admin.userId)).some((r) => r.code === 'PLATFORM_ADMIN'), false);
    const response = await patch(admin, f.pic.id, { userId: f.replacement.userId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const events = (await linkEvents(f.pic.id)).filter((e) => e.metadata.previousUserId === f.customer.userId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actor_user_id, admin.userId);
    assert.equal(events[0]!.request_id, response.headers['x-request-id']);
    assert.equal(events[0]!.source, 'HTTP');
    assert.equal(events[0]!.client_id, f.client.id);
    assert.deepEqual(events[0]!.metadata, {
      tenantCompanyId: f.company.id, previousUserId: f.customer.userId,
      nextUserId: f.replacement.userId, authority: 'IDENTITY_ADMIN', buildingIds: [f.building.id],
    });
    await denied(() => quoteDecision(f.customer, f.version.id), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    const approved = await quoteDecision(f.replacement, f.version.id);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.decidedByUserId, f.replacement.userId);
  });

  for (const label of ['Operations', 'Customer Care'] as const) {
    it(`denies ${label} self-rebind and initial self-link with complete non-mutation`, async () => {
      const f = await issuedFixture();
      const who = label === 'Operations' ? operations : care;
      await denied(() => patch(who, f.pic.id, { userId: who.userId, picName: 'Hijacked', isPrimary: true }));
      await denied(() => api().post(`/api/v1/tenant-companies/${f.company.id}/pics`).set(auth(who))
        .send({ picName: 'Self-appointed customer', userId: who.userId, isPrimary: true }));
      await denied(() => quoteDecision(who, f.version.id, randomUUID(), {
        actorUserId: f.customer.userId, decidedByUserId: f.customer.userId, tenantPicId: f.pic.id,
      }), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    });
  }

  it('denies initial self-binding even for an identity administrator', async () => {
    const f = await fixture();
    await denied(() => patch(admin, f.pic.id, { userId: admin.userId }));
  });

  it('denies appointing another account without identity-administration authority, including forged actor claims', async () => {
    const f = await issuedFixture();
    for (const who of [operations, care, f.customer]) {
      await denied(() => patch(who, f.pic.id, {
        userId: f.replacement.userId, actorUserId: admin.userId,
        permissions: ['tenant_company.manage', 'user.manage'], roleCodes: ['PLATFORM_ADMIN'],
        clientId: f.client.id, buildingId: f.building.id,
      }));
    }
  });

  it('allows the existing customer to unlink themselves, but not transfer another account', async () => {
    const f = await issuedFixture();
    await denied(() => patch(f.customer, f.pic.id, { userId: f.replacement.userId }));
    const response = await patch(f.customer, f.pic.id, { userId: null, phone: '+62 812 222222' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.userId, null);
    const event = (await linkEvents(f.pic.id)).find((e) => e.metadata.previousUserId === f.customer.userId);
    assert.equal(event!.metadata.authority, 'SELF_UNLINK');
    await denied(() => quoteDecision(f.customer, f.version.id), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    await denied(() => patch(f.customer, f.pic.id, { userId: f.customer.userId }));
  });

  it('preserves unbound contact creation and allows authorized initial linking without creating an identity', async () => {
    const f = await fixture();
    const contact = await api().post(`/api/v1/tenant-companies/${f.company.id}/pics`).set(auth(operations))
      .send({ picName: 'New customer contact' });
    assert.equal(contact.status, 201, JSON.stringify(contact.body));
    assert.equal(contact.body.data.userId, null);
    await denied(() => patch(operations, contact.body.data.id, { userId: f.replacement.userId }));
    const users = (await pool.query('SELECT * FROM users ORDER BY id')).rows;
    const linked = await patch(admin, contact.body.data.id, { userId: f.replacement.userId });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual((await pool.query('SELECT * FROM users ORDER BY id')).rows, users);
    assert.equal((await linkEvents(contact.body.data.id)).length, 1);
  });

  it('denies a foreign-company user even in the same Building and denies a customer changing another company PIC', async () => {
    const f = await issuedFixture();
    const company = await tenantCompanyService.createTenantCompany({
      clientId: f.client.id, tenantCode: `T_${suffix()}`, tenantName: 'Other customer',
    }, admin.userId);
    const foreignUser = await actor();
    await assign(foreignUser, f.building.id);
    const foreignPic = await tenantPicService.createTenantPic({
      tenantCompanyId: company.id, picName: 'Foreign customer', userId: foreignUser.userId,
    }, admin.userId);
    await denied(() => patch(admin, f.pic.id, { userId: foreignUser.userId }));
    await denied(() => patch(f.customer, foreignPic.id, { userId: f.replacement.userId }));
    await denied(() => quoteDecision(foreignUser, f.version.id), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
  });

  it('denies cross-Client and same-Client sibling-Building actors and replacement users', async () => {
    const f = await issuedFixture();
    const sibling = await buildingService.createBuilding({ propertyId: f.property.id, code: `B_${suffix()}`, name: 'Sibling' });
    const siblingAdmin = await actor(['tenant_company.manage', 'user.manage']);
    const siblingUser = await actor();
    await assign(siblingAdmin, sibling.id);
    await assign(siblingUser, sibling.id);
    await denied(() => patch(siblingAdmin, f.pic.id, { userId: f.replacement.userId }), 'BUILDING_ACCESS_DENIED');
    await denied(() => patch(admin, f.pic.id, { userId: siblingUser.userId }), 'TENANT_PIC_USER_CLIENT_MISMATCH', 400);
    const foreign = await fixture();
    const foreignAdmin = await actor(['tenant_company.manage', 'user.manage']);
    await assign(foreignAdmin, foreign.building.id);
    await denied(() => patch(foreignAdmin, f.pic.id, { userId: f.replacement.userId }), 'BUILDING_ACCESS_DENIED');
    await denied(() => patch(admin, f.pic.id, { userId: foreign.replacement.userId }), 'TENANT_PIC_USER_CLIENT_MISMATCH', 400);
  });

  it('enforces affected request Buildings even when a company-wide contact is used in more than one Building', async () => {
    const f = await issuedFixture();
    const sibling = await buildingService.createBuilding({ propertyId: f.property.id, code: `B_${suffix()}`, name: 'Other request Building' });
    await assign(admin, sibling.id);
    await assign(f.customer, sibling.id);
    const floor = await floorService.createFloor({ buildingId: sibling.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
    const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
    const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
    const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Other unit' });
    await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: f.company.id, buildingId: sibling.id, spaceId: space.id }, admin.userId);
    await tenantBuildingContextService.createTenantBuildingContext({
      tenantCompanyId: f.company.id, buildingId: sibling.id,
    }, admin.userId);
    const attribution = await createChannelAttribution({
      tenantCompanyId: f.company.id, tenantPicId: f.pic.id, buildingId: sibling.id, spaceId: space.id,
      originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
      createdByUserId: f.customer.userId,
    });
    const service = await serviceCatalogService.createServiceCatalogEntry({
      clientId: f.client.id, code: `HM_${suffix()}`, name: 'Sibling request', category: 'FM_HINT_TEXT',
    }, admin.userId);
    await handymanServiceRequestService.createHandymanServiceRequest({
      channelAttributionId: attribution.id, serviceCatalogId: service.id,
    }, admin.userId);
    await denied(() => patch(admin, f.pic.id, { userId: f.replacement.userId }), 'TENANT_PIC_USER_CLIENT_MISMATCH', 400);
    await assign(f.replacement, sibling.id);
    const response = await patch(admin, f.pic.id, { userId: f.replacement.userId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  });

  it('retains unknown-user and duplicate-company binding errors and denies inactive targets', async () => {
    const f = await fixture();
    await denied(() => patch(admin, f.pic.id, { userId: randomUUID() }), 'USER_NOT_FOUND', 404);
    await pool.query("UPDATE users SET status = 'INACTIVE' WHERE id = $1", [f.replacement.userId]);
    await denied(() => patch(admin, f.pic.id, { userId: f.replacement.userId }));
    await pool.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [f.replacement.userId]);
    const contact = await tenantPicService.createTenantPic({ tenantCompanyId: f.company.id, picName: 'Second contact' }, admin.userId);
    await denied(() => patch(admin, contact.id, { userId: f.customer.userId }), 'TENANT_PIC_USER_ALREADY_LINKED', 409);
  });

  it('does not use contact edits or relinks to override revoked or expired customer relationships', async () => {
    const f = await issuedFixture();
    await pool.query("UPDATE tenant_space_relationships SET status = 'INACTIVE' WHERE id = $1", [f.relationship.id]);
    assert.equal((await patch(operations, f.pic.id, { email: 'maintenance@example.com' })).status, 200);
    await denied(() => patch(admin, f.pic.id, { userId: f.replacement.userId }));
    await denied(() => quoteDecision(f.customer, f.version.id), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    await pool.query("UPDATE tenant_space_relationships SET status = 'ACTIVE', effective_until = NOW() - INTERVAL '1 day' WHERE id = $1", [f.relationship.id]);
    await denied(() => patch(admin, f.pic.id, { userId: f.replacement.userId }));
    await denied(() => quoteDecision(f.customer, f.version.id), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
  });

  it('allows scoped PIC maintenance after a historical closed request lease expires without rewriting decisions', async () => {
    const f = await issuedFixture();
    // Seed an existing closed historical prestate with actual schema and
    // immutable decision constraints. This does not certify Finance/close.
    const historicalDecision = await handymanQuotationDecisionRepository.insertDecision(pool, {
      clientId: f.client.id, quotationId: f.bundle.quotation.id, quotationVersionId: f.version.id,
      decision: 'APPROVE', tenantCompanyId: f.company.id, tenantPicId: f.pic.id,
      decidedByUserId: f.customer.userId, idempotencyKey: randomUUID(),
      requestFingerprint: createHash('sha256').update(`history:${f.version.id}`).digest('hex'),
    });
    await pool.query("UPDATE handyman_quotation_versions SET status = 'APPROVED' WHERE id = $1", [f.version.id]);
    await pool.query(`INSERT INTO handyman_execution_scopes
      (id, client_id, handyman_request_id, channel_attribution_id, quotation_id, approved_quotation_version_id,
       quotation_decision_id, tenant_company_id, tenant_pic_id, building_id, space_id, status,
       created_by_user_id, closed_at, closed_by_user_id, close_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CLOSED',$12,NOW(),$13,'Historical closed fixture')`,
    [randomUUID(), f.client.id, f.request.id, f.request.channelAttributionId, f.bundle.quotation.id,
      f.version.id, historicalDecision.id, f.company.id, f.pic.id, f.building.id, f.space.id, f.customer.userId, admin.userId]);
    await pool.query("UPDATE tenant_space_relationships SET effective_until = NOW() - INTERVAL '1 day' WHERE id = $1", [f.relationship.id]);
    const decisions = (await pool.query('SELECT * FROM handyman_quotation_decisions ORDER BY id')).rows;
    const scopes = (await pool.query('SELECT * FROM handyman_execution_scopes ORDER BY id')).rows;
    const response = await patch(admin, f.pic.id, { userId: f.replacement.userId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((await pool.query('SELECT * FROM handyman_quotation_decisions ORDER BY id')).rows, decisions);
    assert.deepEqual((await pool.query('SELECT * FROM handyman_execution_scopes ORDER BY id')).rows, scopes);
    await denied(() => quoteDecision(f.replacement, f.version.id), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
  });

  it('denies unauthenticated and unknown service actors without side effects', async () => {
    const f = await fixture();
    await denied(() => api().patch(`/api/v1/tenant-pics/${f.pic.id}`).send({ userId: f.replacement.userId }), 'AUTHENTICATION_REQUIRED', 401);
    const before = await state();
    await assert.rejects(tenantPicService.updateTenantPic(f.pic.id, { userId: f.replacement.userId }, randomUUID()), {
      statusCode: 403, code: 'BUILDING_ACCESS_DENIED',
    });
    assert.deepEqual(await state(), before);
  });

  it('denies unauthorized variation decisions and preserves the legitimate customer decision', async () => {
    const f = await variationFixture();
    for (const who of [operations, care, f.replacement]) {
      await denied(() => variationDecision(who, f, randomUUID(), { actorUserId: f.customer.userId }), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    }
    const response = await variationDecision(f.customer, f);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.variation.tenantDecidedByUserId, f.customer.userId);
    assert.equal(response.body.data.events.find((e: { eventType: string }) => e.eventType === 'TENANT_DECISION').actorUserId, f.customer.userId);
  });

  it('preserves immutable quotation and variation provenance after authorized PIC replacement', async () => {
    const f = await variationFixture();
    const key = randomUUID();
    const decision = await variationDecision(f.customer, f, key);
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    const beforeDecisions = (await pool.query('SELECT * FROM handyman_quotation_decisions ORDER BY id')).rows;
    const beforeHistory = (await pool.query('SELECT * FROM handyman_scope_variation_events ORDER BY id')).rows;
    const beforeVariation = (await pool.query('SELECT * FROM handyman_scope_variations WHERE id = $1', [f.variationId])).rows;
    assert.equal((await patch(admin, f.pic.id, { userId: f.replacement.userId, picName: 'New contact' })).status, 200);
    assert.deepEqual((await pool.query('SELECT * FROM handyman_quotation_decisions ORDER BY id')).rows, beforeDecisions);
    assert.deepEqual((await pool.query('SELECT * FROM handyman_scope_variation_events ORDER BY id')).rows, beforeHistory);
    assert.deepEqual((await pool.query('SELECT * FROM handyman_scope_variations WHERE id = $1', [f.variationId])).rows, beforeVariation);
    await denied(() => variationDecision(f.customer, f, key), 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
    const replay = await variationDecision(f.replacement, f, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.variation.tenantDecidedByUserId, f.customer.userId);
    await assert.rejects(pool.query('UPDATE handyman_quotation_decisions SET decided_by_user_id = $1 WHERE quotation_version_id = $2',
      [f.replacement.userId, f.version.id]), /immutable/i);
  });

  for (const kind of ['quotation', 'variation'] as const) {
    it(`serializes relink-first versus ${kind} approval and refuses the old customer`, { timeout: 30_000 }, async (t) => {
      const f = kind === 'quotation' ? await issuedFixture() : await variationFixture();
      const entered = deferred();
      const release = deferred();
      const original = tenantPicRepository.update;
      const mocked = t.mock.method(tenantPicRepository, 'update', async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
      let relink: Promise<Response> | undefined;
      let approval: Promise<Response> | undefined;
      try {
        relink = patch(admin, f.pic.id, { userId: f.replacement.userId }).then((r) => r);
        await enteredBeforeResponse(entered.promise, relink);
        approval = (kind === 'quotation' ? quoteDecision(f.customer, f.version.id)
          : variationDecision(f.customer, f as VariationFixture)).then((r) => r);
        await waitForBlockedQuery('SELECT r.tenant_pic_id');
        release.resolve();
        const [changed, deniedApproval] = await Promise.all([relink, approval]);
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        assert.equal(deniedApproval.status, 403, JSON.stringify(deniedApproval.body));
        assert.equal(deniedApproval.body.error.code, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
        const allowed = kind === 'quotation' ? await quoteDecision(f.replacement, f.version.id)
          : await variationDecision(f.replacement, f as VariationFixture);
        assert.equal(allowed.status, kind === 'quotation' ? 201 : 200, JSON.stringify(allowed.body));
      } finally {
        release.resolve();
        await Promise.allSettled([relink, approval].filter(Boolean));
        mocked.mock.restore();
      }
    });

    it(`serializes ${kind}-approval-first versus relink without FK deadlock or provenance rewrite`, { timeout: 30_000 }, async (t) => {
      const f = kind === 'quotation' ? await issuedFixture() : await variationFixture();
      const entered = deferred();
      const release = deferred();
      const wait = async () => { entered.resolve(); await release.promise; };
      const quoteOriginal = handymanQuotationDecisionRepository.insertDecision;
      const varOriginal = handymanScopeVariationRepository.updateVariationState;
      const mocked = kind === 'quotation'
        ? t.mock.method(handymanQuotationDecisionRepository, 'insertDecision', async (...args: Parameters<typeof quoteOriginal>) => {
          await wait(); return quoteOriginal(...args);
        })
        : t.mock.method(handymanScopeVariationRepository, 'updateVariationState', async (...args: Parameters<typeof varOriginal>) => {
          await wait(); return varOriginal(...args);
        });
      const key = randomUUID();
      let approval: Promise<Response> | undefined;
      let relink: Promise<Response> | undefined;
      try {
        approval = (kind === 'quotation' ? quoteDecision(f.customer, f.version.id, key)
          : variationDecision(f.customer, f as VariationFixture, key)).then((r) => r);
        await enteredBeforeResponse(entered.promise, approval);
        relink = patch(admin, f.pic.id, { userId: f.replacement.userId }).then((r) => r);
        await waitForBlockedQuery('FROM tenant_pics WHERE id = $1 FOR UPDATE');
        release.resolve();
        const [decided, changed] = await Promise.all([approval, relink]);
        assert.equal(decided.status, kind === 'quotation' ? 201 : 200, JSON.stringify(decided.body));
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        const oldActor = kind === 'quotation' ? decided.body.data.decidedByUserId : decided.body.data.variation.tenantDecidedByUserId;
        assert.equal(oldActor, f.customer.userId);
        if (kind === 'quotation') {
          const formerReplay = await quoteDecision(f.customer, f.version.id, key);
          assert.equal(formerReplay.status, 403, JSON.stringify(formerReplay.body));
          assert.equal(formerReplay.body.error.code, 'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN');
          const newIntent = await quoteDecision(f.replacement, f.version.id, randomUUID());
          assert.equal(newIntent.status, 409, JSON.stringify(newIntent.body));
          assert.equal(newIntent.body.error.code, 'HANDYMAN_QUOTATION_DECISION_CONFLICT');
        }
        const replay = kind === 'quotation' ? await quoteDecision(f.replacement, f.version.id, key)
          : await variationDecision(f.replacement, f as VariationFixture, key);
        assert.equal(replay.status, kind === 'quotation' ? 201 : 200, JSON.stringify(replay.body));
        assert.equal(kind === 'quotation' ? replay.body.data.decidedByUserId : replay.body.data.variation.tenantDecidedByUserId, f.customer.userId);
        if (kind === 'quotation') {
          assert.equal(replay.body.data.id, decided.body.data.id);
          assert.equal(replay.body.data.executionScope.id, decided.body.data.executionScope.id);
          const decisions = await pool.query<{ id: string; decided_by_user_id: string }>(
            `SELECT id, decided_by_user_id FROM handyman_quotation_decisions WHERE quotation_version_id = $1`,
            [f.version.id],
          );
          assert.equal(decisions.rows.length, 1);
          assert.equal(decisions.rows[0]!.id, decided.body.data.id);
          assert.equal(decisions.rows[0]!.decided_by_user_id, f.customer.userId);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([approval, relink].filter(Boolean));
        mocked.mock.restore();
      }
    });
  }

  for (const mode of ['omitted', 'stale'] as const) {
    it(`classifies ${mode} userId contact edits from the locked current PIC after a concurrent relink`, { timeout: 30_000 }, async (t) => {
      const f = await issuedFixture();
      const entered = deferred();
      const release = deferred();
      const original = tenantPicRepository.update;
      const mocked = t.mock.method(tenantPicRepository, 'update', async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (args[2].userId === f.replacement.userId) { entered.resolve(); await release.promise; }
        return result;
      });
      let relink: Promise<Response> | undefined;
      let contact: Promise<Response> | undefined;
      try {
        relink = patch(admin, f.pic.id, { userId: f.replacement.userId }).then((r) => r);
        await enteredBeforeResponse(entered.promise, relink);
        contact = patch(operations, f.pic.id, {
          phone: '+62 812 333333', ...(mode === 'stale' ? { userId: f.customer.userId } : {}),
        }).then((r) => r);
        await waitForBlockedQuery('FROM tenant_companies WHERE id = $1 FOR NO KEY UPDATE');
        release.resolve();
        const [changed, edited] = await Promise.all([relink, contact]);
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        assert.equal(edited.status, mode === 'omitted' ? 200 : 403, JSON.stringify(edited.body));
        if (mode === 'stale') assert.equal(edited.body.error.code, 'PERMISSION_DENIED');
        const current = await tenantPicRepository.findById(f.pic.id);
        assert.equal(current!.userId, f.replacement.userId);
        assert.equal(current!.phone, mode === 'omitted' ? '+62 812 333333' : null);
        assert.equal((await linkEvents(f.pic.id)).length, 2, 'original link and exactly one administrative relink');
      } finally {
        release.resolve();
        await Promise.allSettled([relink, contact].filter(Boolean));
        mocked.mock.restore();
      }
    });
  }

  it('serializes cross-company races to the same replacement account', { timeout: 30_000 }, async (t) => {
    const first = await issuedFixture();
    const second = await issuedFixture();
    await assign(first.replacement, second.building.id);
    const entered = deferred();
    const release = deferred();
    const original = tenantPicRepository.update;
    const mocked = t.mock.method(tenantPicRepository, 'update', async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (args[0] === first.pic.id) { entered.resolve(); await release.promise; }
      return result;
    });
    let a: Promise<Response> | undefined;
    let b: Promise<Response> | undefined;
    try {
      a = patch(admin, first.pic.id, { userId: first.replacement.userId }).then((r) => r);
      await enteredBeforeResponse(entered.promise, a);
      b = patch(admin, second.pic.id, { userId: first.replacement.userId }).then((r) => r);
      await waitForBlockedQuery('SELECT id, status FROM users');
      release.resolve();
      const results = await Promise.all([a, b]);
      assert.equal(results[0].status, 200, JSON.stringify(results[0].body));
      assert.equal(results[1].status, 403, JSON.stringify(results[1].body));
      assert.equal(results[1].body.error.code, 'PERMISSION_DENIED');
      assert.equal((await tenantPicRepository.findById(second.pic.id))!.userId, second.customer.userId);
      assert.equal((await linkEvents(second.pic.id)).length, 1, 'only original creation audit');
    } finally {
      release.resolve();
      await Promise.allSettled([a, b].filter(Boolean));
      mocked.mock.restore();
    }
  });

  it('uses the mutation connection for existing scope resolution when no second pool slot is available', { timeout: 30_000 }, async () => {
    const f = await issuedFixture();
    const reserved: PoolClient[] = [];
    try {
      // Reserve all but one slot. Authentication can reuse the remaining slot;
      // once the mutation starts, its scope reads must use that same connection.
      for (let i = 1; i < (pool.options.max ?? 10); i++) reserved.push(await pool.connect());
      const response = await patch(admin, f.pic.id, { userId: f.replacement.userId });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.userId, f.replacement.userId);
    } finally {
      for (const client of reserved) client.release();
    }
  });

  it('rolls back binding, primary-contact changes and history when identity audit insertion fails', async () => {
    const f = await fixture();
    await tenantPicService.createTenantPic({ tenantCompanyId: f.company.id, picName: 'Other primary', isPrimary: true }, admin.userId);
    // A real database failure after the PIC write; do not mock a pooled
    // client's query method (Pool.query also relies on its callback overload).
    await pool.query(`CREATE FUNCTION part03_reject_identity_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.entity_id = '${f.pic.id}'::uuid AND NEW.event_type = 'tenant_pic.identity_link_changed' THEN
          RAISE EXCEPTION 'intentional PIC identity audit failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER part03_identity_audit_failure BEFORE INSERT ON operational_events
        FOR EACH ROW EXECUTE FUNCTION part03_reject_identity_audit()`);
    try {
      await denied(() => patch(admin, f.pic.id, { userId: f.replacement.userId, isPrimary: true, picName: 'Should roll back' }),
        'INTERNAL_SERVER_ERROR', 500);
    } finally {
      await pool.query(`DROP TRIGGER part03_identity_audit_failure ON operational_events;
        DROP FUNCTION part03_reject_identity_audit()`);
    }
  });
});
