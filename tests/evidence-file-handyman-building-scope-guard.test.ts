import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Response } from 'supertest';
import { getAppConfig, type DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  assertBuildingScopedResourceAccess,
  canAccessBuildingScopedResource,
  contextAccessService,
} from '../src/modules/context-access';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
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
// legacy evidence suites: the effective dir comes from EVIDENCE_STORAGE_DIR
// (set externally for the test run, keeping writes out of the repo's
// default .data dir) or the resolved app config. The app import chain
// resolves the config cache at import time, so the env var must be present
// in the process environment — exactly like tests/evidence-file-api.test.ts.
const STORAGE_DIR =
  process.env.EVIDENCE_STORAGE_DIR?.trim() || getAppConfig().storage.dir;
const STORAGE_DIR_FROM_ENV = Boolean(process.env.EVIDENCE_STORAGE_DIR?.trim());

/**
 * CR-HM-SEC-02 PART 03 — focused tests for the BE-02G exact-Building
 * authorization branch applied to HANDYMAN_REQUEST evidence inside the
 * shared `loadEvidence` seam of the generic evidence-file router
 * (`src/modules/evidence/evidence-file.routes.ts`), protecting ALL SIX
 * mounted operations:
 *
 *   POST   /evidence/:evidenceId/file                    upload
 *   GET    /evidence/:evidenceId/file                    metadata
 *   GET    /evidence/:evidenceId/file/content            byte download
 *   POST   /evidence/:evidenceId/retention-hold          retention hold set
 *   DELETE /evidence/:evidenceId/retention-hold          retention hold clear
 *   POST   /evidence/:evidenceId/integrity-verification  integrity check
 *
 * Authority (CR-HM-SEC-02 PART 00 audit, finding D; frozen in PART 00A
 * decision D7):
 *   - BE-02G (`docs/data-isolation.md`): access = authentication +
 *     permission + explicit ACTIVE `user_building_assignment` to the
 *     EXACT Building. "No same-Client shortcut."
 *   - `evidence_submissions` rows with `execution_type = 'HANDYMAN_REQUEST'`
 *     are written by the Handyman intake-evidence flow
 *     (`handyman-intake-evidence.repository.ts`) with `execution_id` = the
 *     parent `handyman_service_requests.id`; that parent is building-scoped
 *     (`building_id UUID NOT NULL`, migration 0378) and is the authoritative
 *     building for the evidence row.
 *   - The previous posture was the client-level `getAccessibleClientIds`
 *     check ALONE for this parent type: an actor assigned only to a
 *     same-Client SIBLING building could download the intake photo bytes,
 *     read metadata, toggle retention holds and run integrity verification
 *     through the generic evidence-file routes.
 *
 * The D7 branch resolves the parent request, fails closed (404 'Evidence
 * not found.', no parent details) when the parent is missing or owned by a
 * different Client, and otherwise requires
 * `assertBuildingScopedResourceAccess(userId, { clientId, buildingId })`
 * BEFORE any storage.get/put, metadata mutation, retention mutation or
 * integrity-verification storage read. All other execution_type behavior
 * (FINDING-family dispatch, client-scoped-only parents) is preserved.
 *
 * Fourteen focused cases:
 *   A. authorized exact-building actor — all six operations allowed;
 *   B. same-client sibling-building actor — all six denied 403;
 *   C. permission-only actor (read+manage, ZERO assignments) — denied;
 *   D. cross-client actor — denied;
 *   E. missing parent request — fails closed 404 'Evidence not found.';
 *   F. evidence-parent client mismatch — fails closed 404;
 *   G. denied download returns zero file bytes (authorized control);
 *   H. denied upload performs zero storage writes (authorized control);
 *   I. denied integrity verification performs zero storage reads
 *      (authorized control);
 *   J. denied retention-hold performs zero mutations (authorized control);
 *   K. actor explicitly assigned to BOTH client buildings — allowed;
 *   L. existing FINDING-family dispatch preserved (its own building rule);
 *   M. other parent types unchanged (client-scoped-only stays client-wide);
 *   N. regression detection — the OLD client-level wall passes for the
 *      sibling actor while the guard denies, so reverting the branch to
 *      the client-only check fails B and N (the suite detects the
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
    findings, users, roles, permissions, clients CASCADE`);
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

function assertDenied403(res: Response, label: string): void {
  assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, 'BUILDING_ACCESS_DENIED', label);
  assert.equal(res.body?.data, undefined, label);
}

function assertEvidenceNotFound404(res: Response, label: string): void {
  assert.equal(res.status, 404, `${label}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, 'NOT_FOUND', label);
  assert.equal(res.body?.error?.message, 'Evidence not found.', label);
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

/**
 * Tenant context + immutable attribution + INTAKE request at the given
 * site (client + building). The full floor/area/room/space chain plus
 * `assignSpaceToTenant` is REQUIRED — `createTenantBuildingContext`
 * throws TENANT_BUILDING_SPACE_RELATIONSHIP_REQUIRED without it.
 */
async function requestFixtureAt(site: { clientId: string; buildingId: string }) {
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: site.buildingId,
  });
  const floor = await floorService.createFloor({
    buildingId: site.buildingId,
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
      clientId: site.clientId,
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
    buildingId: site.buildingId,
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
      buildingId: site.buildingId,
      spaceId: space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: site.buildingId,
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: site.buildingId,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: site.clientId,
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
        description: 'Evidence file scope-guard fixture.',
      },
      adminUserId,
    );
  return { attribution, service, request };
}

/** INTAKE request at the realm's building A1. */
function requestFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  return requestFixtureAt({
    clientId: realm.client.id,
    buildingId: realm.buildingA1.id,
  });
}

/**
 * Authenticated actor holding exactly `evidence.read` + `evidence.manage`
 * (the evidence-file routes' read/manage permissions) plus the given
 * explicit ACTIVE building assignments.
 */
async function createScopedActor(
  buildingIds: readonly string[],
): Promise<{ token: string; userId: string }> {
  const tag = suffix();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `guard-${tag.toLowerCase()}@example.com`,
    displayName: 'Evidence File Scope Guard Actor',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `GUARD_${tag}`,
    name: 'Evidence File Scope Guard Actor',
  });
  for (const code of ['evidence.read', 'evidence.manage']) {
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

/**
 * Directly inserts an `evidence_submissions` row (the same minimal column
 * set the legacy evidence-file suite uses). `file_reference` is NOT NULL,
 * so a row that has not received an upload carries a deterministic
 * non-storage placeholder (`external-ref-<id>`) — exactly how the metadata
 * contract represents "no backend file".
 */
async function insertEvidenceRow(values: {
  clientId: string;
  executionType: string;
  executionId: string;
}): Promise<string> {
  const evidenceId = randomUUID();
  await q(
    `INSERT INTO evidence_submissions
       (id, client_id, execution_type, execution_id, evidence_type,
        file_reference, original_file_name, mime_type, file_size)
     VALUES ($1, $2, $3, $4, 'PHOTO', $5, 'intake.jpg', 'image/jpeg', 0)`,
    [
      evidenceId,
      values.clientId,
      values.executionType,
      values.executionId,
      `external-ref-${evidenceId}`,
    ],
  );
  return evidenceId;
}

const evidenceRow = async (evidenceId: string) =>
  (
    await q('SELECT * FROM evidence_submissions WHERE id = $1', [evidenceId])
  ).rows[0] as Record<string, unknown>;

const operationalEventCount = async (eventTypePattern: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE event_type LIKE $1`,
      [eventTypePattern],
    )
  ).rows[0].n as number;

const fileUrl = (evidenceId: string) => `/api/v1/evidence/${evidenceId}/file`;
const contentUrl = (evidenceId: string) =>
  `/api/v1/evidence/${evidenceId}/file/content`;
const holdUrl = (evidenceId: string) =>
  `/api/v1/evidence/${evidenceId}/retention-hold`;
const verifyUrl = (evidenceId: string) =>
  `/api/v1/evidence/${evidenceId}/integrity-verification`;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const uploadFile = (evidenceId: string, token: string, bytes: Buffer) =>
  api()
    .post(fileUrl(evidenceId))
    .set(bearer(token))
    .attach('file', bytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });

/** Fires ALL SIX evidence-file operations, in route order, sequentially. */
async function attemptAllSix(
  token: string,
  evidenceId: string,
): Promise<{
  upload: Response;
  metadata: Response;
  content: Response;
  holdSet: Response;
  holdClear: Response;
  verify: Response;
}> {
  const upload = await uploadFile(evidenceId, token, JPEG);
  const metadata = await api().get(fileUrl(evidenceId)).set(bearer(token));
  const content = await api().get(contentUrl(evidenceId)).set(bearer(token));
  const holdSet = await api()
    .post(holdUrl(evidenceId))
    .set(bearer(token))
    .send({ reason: 'CR-HM-SEC-02 PART 03 scope probe' });
  const holdClear = await api()
    .delete(holdUrl(evidenceId))
    .set(bearer(token));
  const verify = await api()
    .post(verifyUrl(evidenceId))
    .set(bearer(token));
  return { upload, metadata, content, holdSet, holdClear, verify };
}

function assertAllSixDenied403(ops: Awaited<ReturnType<typeof attemptAllSix>>): void {
  assertDenied403(ops.upload, 'upload');
  assertDenied403(ops.metadata, 'metadata');
  assertDenied403(ops.content, 'content');
  assertDenied403(ops.holdSet, 'retention-hold set');
  assertDenied403(ops.holdClear, 'retention-hold clear');
  assertDenied403(ops.verify, 'integrity-verification');
}

function assertAllSixNotFound404(ops: Awaited<ReturnType<typeof attemptAllSix>>): void {
  assertEvidenceNotFound404(ops.upload, 'upload');
  assertEvidenceNotFound404(ops.metadata, 'metadata');
  assertEvidenceNotFound404(ops.content, 'content');
  assertEvidenceNotFound404(ops.holdSet, 'retention-hold set');
  assertEvidenceNotFound404(ops.holdClear, 'retention-hold clear');
  assertEvidenceNotFound404(ops.verify, 'integrity-verification');
}

describe('CR-HM-SEC-02 PART 03 — HANDYMAN_REQUEST evidence file exact-building scope guard', () => {
  it('A: authorized exact-building actor — all six operations allowed', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    // Fixture pin: the parent request really lives at building A1.
    assert.equal(request.clientId, realm.client.id);
    assert.equal(request.buildingId, realm.buildingA1.id);

    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const actor = await createScopedActor([realm.buildingA1.id]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );

    const storageBefore = await storageFileCount();
    const bytes = Buffer.from('case-a-handyman-evidence-bytes');

    // 1. POST upload — 201, storage write + integrity hash persisted.
    const upload = await uploadFile(evidenceId, actor.token, bytes);
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.data.id, evidenceId);
    assert.equal(upload.body.data.fileReference, `evidence/${evidenceId}`);
    const rowAfterUpload = await evidenceRow(evidenceId);
    assert.equal(rowAfterUpload.file_reference, `evidence/${evidenceId}`);
    assert.ok(rowAfterUpload.content_sha256, 'upload must record the hash');
    assert.equal(await storageFileCount(), storageBefore + 1);

    // 2. GET metadata — 200.
    const metadata = await api()
      .get(fileUrl(evidenceId))
      .set(bearer(actor.token));
    assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
    assert.equal(metadata.body.data.id, evidenceId);

    // 3. GET content — 200 with the exact stored bytes.
    const content = await api()
      .get(contentUrl(evidenceId))
      .set(bearer(actor.token));
    assert.equal(content.status, 200, JSON.stringify(content.body));
    assert.deepEqual(content.body, bytes);

    // 4. POST integrity-verification — 200 VERIFIED (hash matches).
    const verify = await api()
      .post(verifyUrl(evidenceId))
      .set(bearer(actor.token));
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.equal(verify.body.data.outcome, 'VERIFIED');
    assert.equal(
      (await evidenceRow(evidenceId)).last_integrity_status,
      'VERIFIED',
    );

    // 5. POST retention-hold — 200, mutation persisted.
    const holdSet = await api()
      .post(holdUrl(evidenceId))
      .set(bearer(actor.token))
      .send({ reason: 'CR-HM-SEC-02 PART 03 case A' });
    assert.equal(holdSet.status, 200, JSON.stringify(holdSet.body));
    assert.equal((await evidenceRow(evidenceId)).retention_hold, true);

    // 6. DELETE retention-hold — 200, mutation reverted.
    const holdClear = await api()
      .delete(holdUrl(evidenceId))
      .set(bearer(actor.token));
    assert.equal(holdClear.status, 200, JSON.stringify(holdClear.body));
    assert.equal((await evidenceRow(evidenceId)).retention_hold, false);
  });

  it('B: same-client sibling building — all six operations denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    // Authorized upload so the content/integrity targets are real.
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const uploaded = await uploadFile(evidenceId, authorized.token, JPEG);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

    // Assignment ONLY to the sibling building of the SAME client: the
    // exact same-client shortcut BE-02G forbids.
    const sibling = await createScopedActor([realm.buildingA2.id]);
    assert.equal(
      await contextAccessService.canAccessClient(sibling.userId, realm.client.id),
      true,
    );

    const ops = await attemptAllSix(sibling.token, evidenceId);
    assertAllSixDenied403(ops);

    // The denied calls left the row untouched (no retention mutation, no
    // integrity outcome — those are pinned in J and I).
    const row = await evidenceRow(evidenceId);
    assert.notEqual(row.retention_hold, true);
    assert.equal(row.last_integrity_status, null);
    assert.equal(row.file_reference, `evidence/${evidenceId}`);
  });

  it('C: permission-only actor (read+manage, ZERO assignments) — all six denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const actor = await createScopedActor([]);

    // Permission is NOT data scope: no reachable Client at all.
    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      false,
    );

    const ops = await attemptAllSix(actor.token, evidenceId);
    assertAllSixDenied403(ops);
  });

  it('D: cross-client actor — all six denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const actor = await createScopedActor([realm.otherBuilding.id]);

    assert.equal(
      await contextAccessService.canAccessClient(actor.userId, realm.client.id),
      false,
    );

    const ops = await attemptAllSix(actor.token, evidenceId);
    assertAllSixDenied403(ops);
  });

  it('E: missing parent request — fails closed 404 "Evidence not found." on all six', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    // HANDYMAN_REQUEST evidence whose execution_id has NO parent row.
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: randomUUID(),
    });
    // Actor at A1 passes the client-level check — the D7 branch must
    // still fail closed without exposing parent details.
    const actor = await createScopedActor([realm.buildingA1.id]);

    const storageBefore = await storageFileCount();
    const ops = await attemptAllSix(actor.token, evidenceId);
    assertAllSixNotFound404(ops);

    // Fail-closed: no mutation, no storage object.
    const row = await evidenceRow(evidenceId);
    assert.equal(row.file_reference, `external-ref-${evidenceId}`);
    assert.equal(row.content_sha256, null);
    assert.notEqual(row.retention_hold, true);
    assert.equal(row.last_integrity_status, null);
    assert.equal(await storageFileCount(), storageBefore);
  });

  it('F: evidence-parent client mismatch — fails closed 404 "Evidence not found."', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    // A request owned by the OTHER client (at the other building).
    const other = await requestFixtureAt({
      clientId: realm.otherClient.id,
      buildingId: realm.otherBuilding.id,
    });
    assert.equal(other.request.clientId, realm.otherClient.id);
    assert.equal(other.request.buildingId, realm.otherBuilding.id);
    // The evidence row claims the MAIN client but points at the OTHER
    // client's request — inconsistent parent ownership.
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: other.request.id,
    });
    // Actor at A1 (main client) passes the client-level check.
    const actor = await createScopedActor([realm.buildingA1.id]);

    const ops = await attemptAllSix(actor.token, evidenceId);
    assertAllSixNotFound404(ops);

    // Fail-closed: the row is untouched.
    const row = await evidenceRow(evidenceId);
    assert.equal(row.file_reference, `external-ref-${evidenceId}`);
    assert.equal(row.content_sha256, null);
  });

  it('G: denied download returns zero file bytes (authorized control returns them)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const sentinel = Buffer.from('SENTINEL-HANDYMAN-EVIDENCE-BYTES-0123456789');
    const uploaded = await uploadFile(evidenceId, authorized.token, sentinel);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

    const sibling = await createScopedActor([realm.buildingA2.id]);
    const denied = await api()
      .get(contentUrl(evidenceId))
      .set(bearer(sibling.token));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body?.error?.code, 'BUILDING_ACCESS_DENIED');
    // ZERO file bytes: the sentinel never appears in the response and
    // the response is the JSON error, not the stored image.
    assert.ok(
      !denied.text.includes('SENTINEL-HANDYMAN-EVIDENCE-BYTES'),
      'denied download must not contain the stored file bytes',
    );
    assert.notEqual(denied.headers['content-type'], 'image/jpeg');

    // Control: the authorized actor DOES receive the exact sentinel bytes,
    // proving the file exists and the denial is the only reason for G.
    const allowed = await api()
      .get(contentUrl(evidenceId))
      .set(bearer(authorized.token));
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, sentinel);
  });

  it('H: denied upload performs zero storage writes (authorized control writes one)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const sibling = await createScopedActor([realm.buildingA2.id]);

    const storageBefore = await storageFileCount();
    const denied = await uploadFile(evidenceId, sibling.token, JPEG);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body?.error?.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(
      await storageFileCount(),
      storageBefore,
      'denied upload must not write a storage object',
    );
    // No metadata mutation either: the placeholder reference and the
    // missing hash prove authorization completed BEFORE storage.put.
    const row = await evidenceRow(evidenceId);
    assert.equal(row.file_reference, `external-ref-${evidenceId}`);
    assert.equal(row.content_sha256, null);

    // Control: the authorized actor's upload writes exactly one object and
    // persists the storage key + hash, proving the counter is sensitive.
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const uploaded = await uploadFile(evidenceId, authorized.token, JPEG);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(await storageFileCount(), storageBefore + 1);
    const rowAfter = await evidenceRow(evidenceId);
    assert.equal(rowAfter.file_reference, `evidence/${evidenceId}`);
    assert.ok(rowAfter.content_sha256);
  });

  it('I: denied integrity verification performs zero storage reads (authorized control reads)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const uploaded = await uploadFile(evidenceId, authorized.token, JPEG);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

    const sibling = await createScopedActor([realm.buildingA2.id]);
    const eventsBefore = await operationalEventCount('EVIDENCE_INTEGRITY%');
    const denied = await api()
      .post(verifyUrl(evidenceId))
      .set(bearer(sibling.token));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body?.error?.code, 'BUILDING_ACCESS_DENIED');
    // ZERO storage reads: verification persists its outcome ONLY after a
    // storage read, so untouched last-integrity fields + no audit event
    // prove the storage read never happened.
    const row = await evidenceRow(evidenceId);
    assert.equal(
      row.last_integrity_status,
      null,
      'denied verification must not persist an outcome (no storage read)',
    );
    assert.equal(row.last_integrity_checked_at, null);
    assert.equal(
      await operationalEventCount('EVIDENCE_INTEGRITY%'),
      eventsBefore,
      'denied verification must not record an audit event',
    );

    // Control: the authorized actor's verification reads storage and
    // persists VERIFIED.
    const allowed = await api()
      .post(verifyUrl(evidenceId))
      .set(bearer(authorized.token));
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.outcome, 'VERIFIED');
    assert.equal(
      (await evidenceRow(evidenceId)).last_integrity_status,
      'VERIFIED',
    );
  });

  it('J: denied retention-hold performs zero mutations (authorized control mutates)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const authorized = await createScopedActor([realm.buildingA1.id]);
    const sibling = await createScopedActor([realm.buildingA2.id]);

    const eventsBefore = await operationalEventCount('EVIDENCE_RETENTION_HOLD%');
    const deniedSet = await api()
      .post(holdUrl(evidenceId))
      .set(bearer(sibling.token))
      .send({ reason: 'CR-HM-SEC-02 PART 03 case J probe' });
    assert.equal(deniedSet.status, 403, JSON.stringify(deniedSet.body));
    assert.equal(deniedSet.body?.error?.code, 'BUILDING_ACCESS_DENIED');
    const deniedClear = await api()
      .delete(holdUrl(evidenceId))
      .set(bearer(sibling.token));
    assert.equal(deniedClear.status, 403, JSON.stringify(deniedClear.body));
    assert.equal(deniedClear.body?.error?.code, 'BUILDING_ACCESS_DENIED');

    // ZERO mutations: no retention state, no reason, no audit events.
    const row = await evidenceRow(evidenceId);
    assert.notEqual(row.retention_hold, true, 'denied hold must not mutate');
    assert.equal(row.retention_hold_reason, null);
    assert.equal(row.retention_hold_set_by_user_id, null);
    assert.equal(
      await operationalEventCount('EVIDENCE_RETENTION_HOLD%'),
      eventsBefore,
      'denied hold must not record audit events',
    );

    // Control: the authorized actor's set/clear mutates the row.
    const allowedSet = await api()
      .post(holdUrl(evidenceId))
      .set(bearer(authorized.token))
      .send({ reason: 'CR-HM-SEC-02 PART 03 case J control' });
    assert.equal(allowedSet.status, 200, JSON.stringify(allowedSet.body));
    assert.equal((await evidenceRow(evidenceId)).retention_hold, true);
    const allowedClear = await api()
      .delete(holdUrl(evidenceId))
      .set(bearer(authorized.token));
    assert.equal(allowedClear.status, 200, JSON.stringify(allowedClear.body));
    assert.equal((await evidenceRow(evidenceId)).retention_hold, false);
  });

  it('K: actor explicitly assigned to BOTH client buildings — allowed (the only policy-supported client-wide reach)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
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

    const bytes = Buffer.from('case-k-both-buildings-bytes');
    const upload = await uploadFile(evidenceId, actor.token, bytes);
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const metadata = await api()
      .get(fileUrl(evidenceId))
      .set(bearer(actor.token));
    assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
    const content = await api()
      .get(contentUrl(evidenceId))
      .set(bearer(actor.token));
    assert.equal(content.status, 200, JSON.stringify(content.body));
    assert.deepEqual(content.body, bytes);
    const verify = await api()
      .post(verifyUrl(evidenceId))
      .set(bearer(actor.token));
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.equal(verify.body.data.outcome, 'VERIFIED');
  });

  it('L: existing FINDING-family dispatch preserved (its own building rule still applies)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    // A Finding at the SIBLING building A2 (same client).
    const findingId = randomUUID();
    await q(
      `INSERT INTO findings
         (id, client_id, building_id, finding_number, title,
          source_type, source_id, status, reported_by_user_id,
          reported_at, created_at)
       VALUES ($1, $2, $3, $4, 'Scope guard finding',
               'CHECKLIST_EXECUTION', $5, 'OPEN', $6, NOW(), NOW())`,
      [findingId, realm.client.id, realm.buildingA2.id, `FND_${suffix()}`, randomUUID(), adminUserId],
    );
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'FINDING',
      executionId: findingId,
    });

    // Actor assigned ONLY to A1: the client-level check passes, and the
    // PRESERVED FINDING dispatch enforces the finding's own building (A2)
    // — 403 from `loadEvidenceExecution`, exactly as before D7.
    const a1Only = await createScopedActor([realm.buildingA1.id]);
    const denied = await api()
      .get(fileUrl(evidenceId))
      .set(bearer(a1Only.token));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body?.error?.code, 'BUILDING_ACCESS_DENIED');

    // Actor assigned to both buildings: the FINDING path allows — the
    // dispatch behavior is preserved, not broken by the D7 branch.
    const both = await createScopedActor([
      realm.buildingA1.id,
      realm.buildingA2.id,
    ]);
    const allowed = await api()
      .get(fileUrl(evidenceId))
      .set(bearer(both.token));
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.id, evidenceId);
  });

  it('M: other parent types remain unchanged (client-scoped-only parents stay client-wide)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    // A CHECKLIST_EXECUTION evidence row — a client-scoped-only parent
    // type that decision D6 keeps at client-level authorization.
    const ceEvidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'CHECKLIST_EXECUTION',
      executionId: randomUUID(),
    });
    // A HANDYMAN_REQUEST evidence row at A1 for the contrast pin.
    const hrEvidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // UNCHANGED: the D7 branch is narrowly scoped to HANDYMAN_REQUEST —
    // the same sibling actor is still allowed on CHECKLIST_EXECUTION
    // evidence (client-level scope only, exactly as before).
    const ceMetadata = await api()
      .get(fileUrl(ceEvidenceId))
      .set(bearer(sibling.token));
    assert.equal(
      ceMetadata.status,
      200,
      `non-HANDYMAN_REQUEST parent types keep client-level authorization: ${JSON.stringify(ceMetadata.body)}`,
    );

    // The carve-out itself: HANDYMAN_REQUEST denies the same actor.
    const hrMetadata = await api()
      .get(fileUrl(hrEvidenceId))
      .set(bearer(sibling.token));
    assert.equal(hrMetadata.status, 403, JSON.stringify(hrMetadata.body));
    assert.equal(hrMetadata.body?.error?.code, 'BUILDING_ACCESS_DENIED');
  });

  it('N: regression detection — the old client-only wall would pass the sibling, the guard denies', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { request } = await requestFixture(realm);
    const evidenceId = await insertEvidenceRow({
      clientId: realm.client.id,
      executionType: 'HANDYMAN_REQUEST',
      executionId: request.id,
    });
    const sibling = await createScopedActor([realm.buildingA2.id]);

    // Vulnerability-detection pin: with the branch reverted to the OLD
    // client-level wall (the pre-D7 posture), the sibling actor would be
    // WRONGLY ALLOWED and cases B/G/H/I/J would fail. The pin proves the
    // suite detects the vulnerability rather than passing vacuously.
    assert.equal(
      await contextAccessService.canAccessClient(
        sibling.userId,
        realm.client.id,
      ),
      true,
      'old client-level wall must pass for the sibling actor (regression pin)',
    );
    // Service-level pin of the production mechanism: the branch's guard
    // itself rejects the sibling for the parent building.
    await assert.rejects(
      assertBuildingScopedResourceAccess(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      assertBuildingDenied,
    );
    assert.equal(
      await canAccessBuildingScopedResource(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
      'BE-02G guard must deny the sibling actor',
    );

    // HTTP: all six operations deny the sibling.
    const ops = await attemptAllSix(sibling.token, evidenceId);
    assertAllSixDenied403(ops);
  });
});
