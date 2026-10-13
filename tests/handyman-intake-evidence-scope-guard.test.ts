import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { getAppConfig, type DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  canAccessBuildingScopedResource,
  contextAccessService,
} from '../src/modules/context-access';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { handymanIntakeEvidenceService } from '../src/modules/handyman-evidence';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

// Evidence storage for this suite follows the same convention as the
// legacy intake-evidence suite: the effective dir comes from
// EVIDENCE_STORAGE_DIR (set externally for the test run, keeping writes
// out of the repo's default .data dir) or the resolved app config. The
// app import chain resolves the config cache at import time, so the env
// var must be present in the process environment — exactly like
// tests/handyman-request-evidence.test.ts.
const STORAGE_DIR =
  process.env.EVIDENCE_STORAGE_DIR?.trim() || getAppConfig().storage.dir;
const STORAGE_DIR_FROM_ENV = Boolean(process.env.EVIDENCE_STORAGE_DIR?.trim());

/**
 * CR-HM-SEC-02 PART 02 — focused tests for the BE-02G exact-Building
 * authorization guard applied to Handyman REQUEST INTAKE evidence
 * (CR-HM-02 PART 04), two operations:
 *
 *   recordHandymanIntakeEvidence  (POST /handyman/requests/:id/intake-evidence)
 *   listHandymanIntakeEvidence    (GET  /handyman/requests/:id/intake-evidence)
 *
 * Authority (CR-HM-SEC-02 PART 00 audit, finding B-2; frozen in PART 00A
 * decision D2):
 *   - BE-02G (`docs/data-isolation.md`): access = authentication +
 *     permission + explicit ACTIVE `user_building_assignment` to the
 *     EXACT Building. "No same-Client shortcut."
 *   - The parent `handyman_service_requests` row is building-scoped
 *     (`building_id UUID NOT NULL`, migration 0378, server-derived) and
 *     is already loaded by both operations — the authoritative building.
 *   - The previous wall was the client-level `canAccessClient` shortcut:
 *     an actor assigned only to a same-Client SIBLING building could
 *     upload (storage write + evidence row) and list intake evidence
 *     metadata of the request's building.
 *
 * Ordering preserved: request 404 → exact-building authorization →
 * MIME/size validation → storage write → DB insert; LIST authorizes
 * before returning any metadata.
 *
 * Nine focused cases:
 *   A. authorized exact-building actor — allowed (service + HTTP);
 *   B. same-client sibling-building actor — denied 403 (service + HTTP);
 *   C. permission-only actor (read+manage, ZERO assignments) — denied;
 *   D. cross-client actor — denied;
 *   E. denied POST creates no evidence row;
 *   F. denied POST writes no storage object;
 *   G. denied GET returns no evidence metadata;
 *   H. actor explicitly assigned to BOTH client buildings — allowed;
 *   I. regression detection — the OLD client-level wall passes for the
 *      sibling actor while the guard denies, so reverting the guard to
 *      `canAccessClient` fails B/E/F/G (the suite detects the
 *      vulnerability, it does not pass vacuously).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE evidence_submissions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    service_catalog, operational_events, tenant_service_requests,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  await rm(STORAGE_DIR, { recursive: true, force: true }).catch(() => undefined);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
  // Remove the storage dir only when it was redirected via the
  // environment (never touch the repo's default .data dir).
  if (STORAGE_DIR_FROM_ENV) {
    await rm(STORAGE_DIR, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const intakeEvidenceRows = async (requestId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM evidence_submissions
        WHERE execution_type = 'HANDYMAN_REQUEST' AND execution_id = $1`,
      [requestId],
    )
  ).rows[0].n as number;

/** Counts stored evidence files under the suite's hermetic storage dir. */
async function storageFileCount(): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else if (entry.isFile()) count += 1;
    }
  };
  await walk(STORAGE_DIR);
  return count;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

function assertBuildingDenied(error: unknown): boolean {
  assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
  assert.equal(errorStatus(error), 403);
  return true;
}

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * request's building, A2 = the same-client sibling), plus a second
 * client with one building for the cross-client case.
 */
async function realmFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA1 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A1 (request building)',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
  });
  const otherClient = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other Client',
  });
  const otherProperty = await propertyService.createProperty({
    clientId: otherClient.id,
    code: `P_${suffix()}`,
    name: 'Other Property',
  });
  const otherBuilding = await buildingService.createBuilding({
    propertyId: otherProperty.id,
    code: `B_${suffix()}`,
    name: 'Other Building (other client)',
  });
  return {
    client,
    property,
    buildingA1,
    buildingA2,
    otherClient,
    otherProperty,
    otherBuilding,
  };
}

/** Tenant context + immutable attribution + INTAKE request at building A1. */
async function requestFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: realm.buildingA1.id,
  });
  const floor = await floorService.createFloor({
    buildingId: realm.buildingA1.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Tenant Company',
    },
    adminUserId,
  );
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.buildingA1.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant Requester',
      email: 'requester@tenant.example.com',
      userId: linkedUser.id,
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
      spaceId: space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: realm.buildingA1.id,
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM${suffix()}`,
      name: 'Handyman Service',
      category: 'HANDYMAN',
    },
    adminUserId,
  );
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
        description: 'Intake evidence scope-guard fixture.',
      },
      adminUserId,
    );
  return { attribution, service, request };
}

/**
 * Authenticated actor holding exactly `tenant_company.read` +
 * `tenant_company.manage` (the intake-evidence routes' read/manage
 * permissions) plus the given explicit ACTIVE building assignments.
 */
async function createScopedActor(
  buildingIds: readonly string[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `guard-${tag.toLowerCase()}@example.com`,
    displayName: 'Intake Evidence Scope Guard Actor',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `GUARD_${tag}`,
    name: 'Intake Evidence Scope Guard Actor',
  });
  for (const code of ['tenant_company.read', 'tenant_company.manage']) {
    const existing = await permissionRepository.findByCode(code);
    const permission =
      existing ??
      (await permissionService.createPermission({ code, name: code }));
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }

  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

const INTAKE_EVIDENCE = (requestId: string) =>
  `/api/v1/handyman/requests/${requestId}/intake-evidence`;

const RECORD_INPUT = {
  evidenceKind: 'PHOTO' as const,
  fileName: 'leak.jpg',
  mimeType: 'image/jpeg',
  content: JPEG,
};

function uploadRequest(requestId: string, token: string) {
  return api()
    .post(INTAKE_EVIDENCE(requestId))
    .set('Authorization', `Bearer ${token}`)
    .field('evidenceKind', 'PHOTO')
    .attach('file', JPEG, { filename: 'leak.jpg', contentType: 'image/jpeg' });
}

describe('CR-HM-SEC-02 PART 02 — intake evidence exact-building scope guard', () => {
  it('A: authorized exact-building actor — upload + list allowed (service + HTTP)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([realm.buildingA1.id]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );

    // Service layer: upload succeeds with integrity metadata.
    const evidence = await handymanIntakeEvidenceService
      .recordHandymanIntakeEvidence(
        { handymanRequestId: request.id, ...RECORD_INPUT },
        actor.userId,
      );
    assert.ok(evidence.id);
    assert.equal(evidence.handymanRequestId, request.id);
    assert.equal(evidence.clientId, realm.client.id);
    assert.equal(evidence.evidenceKind, 'PHOTO');
    assert.equal(evidence.fileSize, JPEG.length);
    assert.equal(await intakeEvidenceRows(request.id), 1);
    assert.equal(await storageFileCount(), 1);

    // Service layer: list returns the metadata.
    const listed = await handymanIntakeEvidenceService
      .listHandymanIntakeEvidence(request.id, actor.userId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, evidence.id);

    // HTTP layer: POST 201 + GET 200 on a fresh realm.
    const realm2 = await realmFixture();
    const second = await requestFixture(realm2);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: realm2.buildingA1.id,
    });
    const created = await uploadRequest(second.request.id, actor.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.handymanRequestId, second.request.id);
    const listedHttp = await api()
      .get(INTAKE_EVIDENCE(second.request.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(listedHttp.status, 200, JSON.stringify(listedHttp.body));
    assert.equal(listedHttp.body.data.length, 1);
  });

  it('B: same-client sibling building — denied 403 on upload and list (service + HTTP)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    // Assignment ONLY to the sibling building of the SAME client/property:
    // the exact same-client shortcut BE-02G forbids.
    const actor = await createScopedActor([realm.buildingA2.id]);

    // The OLD client-level wall passed here; the guard must not (case I pin).
    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      true,
    );
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
    );

    // Service layer: upload denied.
    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
        { handymanRequestId: request.id, ...RECORD_INPUT },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    // Service layer: list denied.
    await assert.rejects(
      handymanIntakeEvidenceService.listHandymanIntakeEvidence(
        request.id,
        actor.userId,
      ),
      assertBuildingDenied,
    );

    // HTTP layer: both denied with the controlled code.
    const posted = await uploadRequest(request.id, actor.token);
    assert.equal(posted.status, 403, JSON.stringify(posted.body));
    assert.equal(posted.body.error.code, 'BUILDING_ACCESS_DENIED');
    const listed = await api()
      .get(INTAKE_EVIDENCE(request.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(listed.status, 403, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(listed.body.data, undefined);
  });

  it('C: permission-only actor (read+manage, ZERO assignments) — denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([]);

    // Permission is NOT data scope.
    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      false,
    );

    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
        { handymanRequestId: request.id, ...RECORD_INPUT },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanIntakeEvidenceService.listHandymanIntakeEvidence(
        request.id,
        actor.userId,
      ),
      assertBuildingDenied,
    );
    const posted = await uploadRequest(request.id, actor.token);
    assert.equal(posted.status, 403, JSON.stringify(posted.body));
    assert.equal(posted.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('D: cross-client actor — denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([realm.otherBuilding.id]);

    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      false,
    );

    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
        { handymanRequestId: request.id, ...RECORD_INPUT },
        actor.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      handymanIntakeEvidenceService.listHandymanIntakeEvidence(
        request.id,
        actor.userId,
      ),
      assertBuildingDenied,
    );
    const listed = await api()
      .get(INTAKE_EVIDENCE(request.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(listed.status, 403, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('E: denied POST creates no evidence row', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    assert.equal(await intakeEvidenceRows(request.id), 0);
    const totalBefore = (
      await q(
        `SELECT count(*)::int AS n FROM evidence_submissions
          WHERE execution_type = 'HANDYMAN_REQUEST'`,
      )
    ).rows[0].n as number;
    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
        { handymanRequestId: request.id, ...RECORD_INPUT },
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    const posted = await uploadRequest(request.id, sibling.token);
    assert.equal(posted.status, 403, JSON.stringify(posted.body));
    // No evidence row for the request — neither service nor HTTP denial
    // persisted anything (the file shares one DB across cases, so assert
    // the delta, not an absolute zero).
    assert.equal(await intakeEvidenceRows(request.id), 0);
    const totalAfter = (
      await q(
        `SELECT count(*)::int AS n FROM evidence_submissions
          WHERE execution_type = 'HANDYMAN_REQUEST'`,
      )
    ).rows[0].n as number;
    assert.equal(totalAfter, totalBefore);
  });

  it('F: denied POST writes no storage object (control: allowed POST writes one)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    const beforeDenied = await storageFileCount();
    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
        { handymanRequestId: request.id, ...RECORD_INPUT },
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    const posted = await uploadRequest(request.id, sibling.token);
    assert.equal(posted.status, 403, JSON.stringify(posted.body));
    assert.equal(
      await storageFileCount(),
      beforeDenied,
      'denied POST must not write a storage object',
    );

    // Control: the authorized actor's upload DOES write exactly one object,
    // proving the counter is sensitive.
    await handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
      { handymanRequestId: request.id, ...RECORD_INPUT },
      authorized.userId,
    );
    assert.equal(await storageFileCount(), beforeDenied + 1);
  });

  it('G: denied GET returns no evidence metadata', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Baseline: authorized actor uploads one PHOTO.
    await handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
      { handymanRequestId: request.id, ...RECORD_INPUT },
      authorized.userId,
    );
    assert.equal(await intakeEvidenceRows(request.id), 1);

    // Service layer: sibling list denied — no metadata.
    await assert.rejects(
      handymanIntakeEvidenceService.listHandymanIntakeEvidence(
        request.id,
        sibling.userId,
      ),
      assertBuildingDenied,
    );

    // HTTP layer: sibling GET denied — 403, no data payload.
    const listed = await api()
      .get(INTAKE_EVIDENCE(request.id))
      .set('Authorization', `Bearer ${sibling.token}`);
    assert.equal(listed.status, 403, JSON.stringify(listed.body));
    assert.equal(listed.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(listed.body.data, undefined);

    // The authorized actor still sees the row (guard is not over-broad).
    const allowed = await handymanIntakeEvidenceService
      .listHandymanIntakeEvidence(request.id, authorized.userId);
    assert.equal(allowed.length, 1);
  });

  it('H: actor explicitly assigned to BOTH client buildings — allowed (the only policy-supported client-wide reach)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const actor = await createScopedActor([
      realm.buildingA1.id,
      realm.buildingA2.id,
    ]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );
    // A single FOREIGN-building assignment does not satisfy the guard.
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.otherBuilding.id,
      }),
      false,
    );

    const evidence = await handymanIntakeEvidenceService
      .recordHandymanIntakeEvidence(
        { handymanRequestId: request.id, ...RECORD_INPUT },
        actor.userId,
      );
    assert.ok(evidence.id);
    const listed = await handymanIntakeEvidenceService
      .listHandymanIntakeEvidence(request.id, actor.userId);
    assert.equal(listed.length, 1);

    // HTTP layer: the both-buildings actor is authorized (201, not 403);
    // intake evidence has no per-request uniqueness rule, so the upload
    // creates a second bounded row.
    const posted = await uploadRequest(request.id, actor.token);
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(await intakeEvidenceRows(request.id), 2);
  });

  it('I: regression detection — the old client wall passes for the sibling actor, the guard denies', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Vulnerability-detection pin: with the guard reverted to the old
    // client-level `canAccessClient` wall, the sibling actor would be
    // WRONGLY ALLOWED and cases B/E/F/G would fail. The pin proves the
    // suite detects the vulnerability rather than passing vacuously.
    assert.equal(
      await contextAccessService.canAccessClient(
        sibling.userId,
        realm.client.id,
      ),
      true,
      'old client-level wall must pass for the sibling actor (regression pin)',
    );
    assert.equal(
      await canAccessBuildingScopedResource(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
      'BE-02G guard must deny the sibling actor',
    );

    // Both operations deny the sibling at the service layer, and the
    // denied upload leaves neither an evidence row nor a storage object.
    const storageBefore = await storageFileCount();
    // Lazily-created thunks: awaiting each rejection in turn (eagerly
    // created promises would reject unhandled before their turn).
    const denialChecks: Array<() => Promise<unknown>> = [
      () =>
        handymanIntakeEvidenceService.recordHandymanIntakeEvidence(
          { handymanRequestId: request.id, ...RECORD_INPUT },
          sibling.userId,
        ),
      () =>
        handymanIntakeEvidenceService.listHandymanIntakeEvidence(
          request.id,
          sibling.userId,
        ),
    ];
    for (const check of denialChecks) {
      await assert.rejects(check(), assertBuildingDenied);
    }
    assert.equal(await intakeEvidenceRows(request.id), 0);
    assert.equal(await storageFileCount(), storageBefore);
  });
});
