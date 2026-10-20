import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { credentialService } from '../src/modules/auth';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import {
  tenantCompanyService,
  type PublicTenantCompany,
} from '../src/modules/tenant-companies';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — focused acceptance suite.
 *
 * Covers the CR's test list against disposable embedded PostgreSQL and real
 * authenticated sessions:
 *   - import validation (per-row errors), tenant isolation, RBAC,
 *   - duplication + idempotency, occupant changes, rollback,
 *   - Customer Care compatibility and verification authority.
 * No production mutation.
 */

const V1 = '/api/v1';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let pg: EmbeddedPostgres;
let dir = '';
let pool: Pool;
let adminUserId = '';
let adminSession = '';

type EmptyRealm = {
  client: { id: string };
  building: { id: string };
  unitId: string;
  unitCode: string;
  otherUnitId: string;
  otherUnitCode: string;
  service: { id: string };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-tenant-batch-'));
  const port = 58800 + Math.floor(Math.random() * 150);
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password: 'password',
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  pool = await initDatabase({
    host: '127.0.0.1',
    port,
    name: 'postgres',
    user: 'postgres',
    password: 'password',
    ssl: false,
    poolMin: 1,
    poolMax: 16,
  });
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminSession = admin.token;
});

after(async () => {
  await closePool(getPool()).catch(() => undefined);
  if (pg) await pg.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function ktp(): string {
  return String(Math.floor(Math.random() * 9) + 1) +
    String(Math.floor(Math.random() * 1e15)).padStart(15, '0');
}

async function ensurePermission(code: string, name: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) return existing.id;
  return (await permissionService.createPermission({ code, name })).id;
}

/** Client → Property → Building → two Units, nothing registered yet. */
async function createEmptyRealm(
  label: string,
  assignAdmin = true,
): Promise<EmptyRealm> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `TB_${tag}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `TP_${tag}`,
    name: `${label} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `TBB_${tag}`,
    name: `${label} Tower`,
  });
  if (assignAdmin) {
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
  }
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `TF_${tag}`,
    name: 'Floor',
    levelNumber: 7,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `TA_${tag}`,
    name: 'Residential',
  });
  const roomA = await roomService.createRoom({ areaId: area.id, code: `TRA_${tag}`, name: 'Room A' });
  const roomB = await roomService.createRoom({ areaId: area.id, code: `TRB_${tag}`, name: 'Room B' });
  const unitA = await spaceService.createSpace({
    roomId: roomA.id,
    code: `TU_A_${tag}`,
    name: 'Unit 701',
    areaSqm: 50,
  });
  const unitB = await spaceService.createSpace({
    roomId: roomB.id,
    code: `TU_B_${tag}`,
    name: 'Unit 702',
    areaSqm: 60,
  });
  const service = assignAdmin
    ? await serviceCatalogService.createServiceCatalogEntry(
        {
          clientId: client.id,
          code: `TSV_${tag}`,
          name: `${label} AC service`,
          category: 'AIR_CONDITIONING',
        },
        adminUserId,
      )
    : { id: '' };
  return {
    client,
    building,
    unitId: unitA.id,
    unitCode: unitA.code,
    otherUnitId: unitB.id,
    otherUnitCode: unitB.code,
    service,
  };
}

async function createCareStaff(buildingId: string) {
  const tag = suffix().toLowerCase();
  const email = `care-${tag}@example.test`;
  const password = `Care-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Building Care Staff',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `BATCH_CARE_${tag.toUpperCase()}`,
    name: 'Batch Care',
  });
  await permissionService.assignPermissionToRole(
    role.id,
    await ensurePermission(HANDYMAN_CARE_BUILDING_PERMISSION, 'Building Care'),
  );
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

const importPath = (clientId: string, batchId?: string) =>
  `${V1}/clients/${clientId}/tenant-imports${batchId ? `/${batchId}` : ''}`;

type UploadResult = {
  batch: { id: string; status: string; totalRows: number; validRows: number; invalidRows: number; committedRows: number; skippedRows: number };
  rows: {
    id: string;
    rowNumber: number;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    tenantCompanyId: string | null;
    outcome: { resolution?: { action: string; tenantCode: string }; plan?: unknown[] };
    party: { tenantName: string; identityDocumentNumber: string | null };
  }[];
  replayed: boolean;
};

async function uploadRows(
  token: string,
  clientId: string,
  rows: unknown[],
  opts: { idempotencyKey?: string; sourceName?: string } = {},
) {
  return api()
    .post(importPath(clientId))
    .set(auth(token))
    .send({
      sourceName: opts.sourceName ?? `import-${suffix()}.csv`,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      rows,
    });
}

/** Uploads rows and returns `data` (asserting the upload landed). */
async function uploadData(
  token: string,
  clientId: string,
  rows: unknown[],
  opts: { idempotencyKey?: string; sourceName?: string } = {},
): Promise<UploadResult> {
  const res = await uploadRows(token, clientId, rows, opts);
  assert.ok(res.body && res.body.data, `upload must succeed: ${JSON.stringify(res.body)}`);
  return res.body.data as UploadResult;
}

function individualRow(input: {
  name: string;
  ktp: string;
  tenantCode?: string;
  unitCode?: string;
  buildingId?: string;
  relation?: string;
  replaceExisting?: boolean;
  effectiveFrom?: string;
  pics?: unknown[];
  verificationStatus?: string;
}) {
  return {
    party: {
      ...(input.tenantCode ? { tenantCode: input.tenantCode } : {}),
      tenantName: input.name,
      partyKind: 'INDIVIDUAL',
      identityDocumentType: 'KTP',
      identityDocumentNumber: input.ktp,
      phone: '081234567890',
    },
    ...(input.verificationStatus ? { verificationStatus: input.verificationStatus } : {}),
    ...(input.pics ? { pics: input.pics } : {}),
    ...(input.unitCode && input.buildingId
      ? {
          unitLinks: [
            {
              buildingId: input.buildingId,
              unitCode: input.unitCode,
              relation: input.relation ?? 'TENANCY',
              ...(input.replaceExisting ? { replaceExisting: true } : {}),
              ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
            },
          ],
        }
      : {}),
  };
}

describe('CR-HM-MASTER-TENANT-BATCH-01 tenant/PIC batch import', () => {
  it('1: upload → validate → preview → confirm → commit registers real parties with per-row outcomes and audit', async () => {
    const realm = await createEmptyRealm('Happy');
    const token = adminSession;
    const docA = ktp();
    const rows = [
      individualRow({
        name: 'Budi Santoso',
        ktp: docA,
        unitCode: realm.unitCode,
        buildingId: realm.building.id,
        pics: [{ picName: 'Istri Budi', email: 'istri.budi@example.test', isPrimary: true }],
      }),
      {
        party: {
          tenantCode: `LEG_${suffix()}`,
          tenantName: 'PT Maju Bersama',
          partyKind: 'LEGAL_ENTITY',
          legalName: 'PT Maju Bersama',
          identityDocumentType: 'NPWP',
          identityDocumentNumber: '012345678901234',
        },
        unitLinks: [
          {
            buildingId: realm.building.id,
            unitCode: realm.otherUnitCode,
            relation: 'OWNER',
          },
        ],
      },
      individualRow({ name: 'Siti Aminah', ktp: ktp() }),
    ];

    const upload = await uploadRows(token, realm.client.id, rows);
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const uploaded = upload.body.data as UploadResult;
    assert.equal(uploaded.batch.status, 'UPLOADED');
    assert.equal(uploaded.batch.totalRows, 3);

    const validate = await api()
      .post(`${importPath(realm.client.id, uploaded.batch.id)}/validate`)
      .set(auth(token));
    assert.equal(validate.status, 200, JSON.stringify(validate.body));
    const validated = validate.body.data as UploadResult;
    assert.equal(validated.batch.status, 'VALIDATED');
    assert.equal(validated.batch.validRows, 3);
    assert.equal(validated.batch.invalidRows, 0);
    const first = validated.rows.find((r) => r.rowNumber === 1);
    assert.equal(first?.outcome.resolution?.action, 'CREATE');
    assert.ok(Array.isArray(first?.outcome.plan) && first.outcome.plan.length === 3);

    // Preview masks identity documents — the full number never round-trips.
    const preview = await api()
      .get(importPath(realm.client.id, uploaded.batch.id))
      .set(auth(token));
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const previewRows = preview.body.data.rows as UploadResult['rows'];
    const previewFirst = previewRows.find((r) => r.rowNumber === 1);
    assert.ok(previewFirst?.party.identityDocumentNumber?.startsWith('••••'));
    assert.ok(!JSON.stringify(preview.body).includes(docA));

    const confirm = await api()
      .post(`${importPath(realm.client.id, uploaded.batch.id)}/confirm`)
      .set(auth(token));
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.equal(confirm.body.data.batch.status, 'CONFIRMED');

    const commit = await api()
      .post(`${importPath(realm.client.id, uploaded.batch.id)}/commit`)
      .set(auth(token));
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    const committed = commit.body.data as UploadResult;
    assert.equal(committed.batch.status, 'COMMITTED');
    assert.equal(committed.batch.committedRows, 3);
    assert.equal(committed.batch.skippedRows, 0);

    // Parties really exist: three masters, all PENDING_VERIFICATION (temporary).
    const list = await api()
      .get(`${V1}/clients/${realm.client.id}/tenant-companies`)
      .set(auth(token));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const parties = list.body.data as PublicTenantCompany[];
    assert.equal(parties.length, 3);
    for (const party of parties) {
      assert.equal(party.verificationStatus, 'PENDING_VERIFICATION');
    }

    // Occupancy and Owner role landed on the right Units.
    const occupancies = await pool.query(
      `SELECT status FROM tenant_space_relationships WHERE space_id = $1`,
      [realm.unitId],
    );
    assert.equal(occupancies.rows.length, 1);
    assert.equal(occupancies.rows[0].status, 'ACTIVE');
    const ownerRoles = await pool.query(
      `SELECT count(*)::int AS count FROM unit_party_roles WHERE building_id = $1 AND party_role = 'OWNER'`,
      [realm.building.id],
    );
    assert.equal(ownerRoles.rows[0].count, 1);

    // The batch is its own durable audit trail, plus phase audit events.
    const audit = await pool.query(
      `SELECT event_type FROM authentication_audit_events
        WHERE event_type LIKE 'TENANT_IMPORT_%'`,
    );
    const events = audit.rows.map((r) => r.event_type as string);
    for (const expected of [
      'TENANT_IMPORT_UPLOADED',
      'TENANT_IMPORT_VALIDATED',
      'TENANT_IMPORT_CONFIRMED',
      'TENANT_IMPORT_COMMITTED',
    ]) {
      assert.ok(events.includes(expected), `audit must include ${expected}`);
    }
  });

  it('2: validation reports per-row errors without blocking valid rows and refuses fictitious parties', async () => {
    const realm = await createEmptyRealm('Errors');
    const token = adminSession;
    const sharedKtp = ktp();
    const rows = [
      // VALID
      individualRow({ name: 'Valid Person', ktp: sharedKtp }),
      // bad identity format
      individualRow({ name: 'Bad KTP', ktp: '1234' }),
      // INDIVIDUAL with legalName — fictitious company refusal
      {
        party: {
          tenantName: 'Person As Company',
          partyKind: 'INDIVIDUAL',
          legalName: 'Fictitious PT',
          identityDocumentType: 'KTP',
          identityDocumentNumber: ktp(),
        },
      },
      // no party at all — never invent a Tenant for a Unit
      {
        unitLinks: [
          { buildingId: realm.building.id, unitCode: realm.unitCode, relation: 'TENANCY' },
        ],
      },
      // unknown unit
      individualRow({
        name: 'Ghost Unit',
        ktp: ktp(),
        buildingId: realm.building.id,
        unitCode: 'NO_SUCH_UNIT',
      }),
      // duplicate row (same KTP as the first row)
      individualRow({ name: 'Duplicate Person', ktp: sharedKtp }),
    ];

    const upload = await uploadRows(token, realm.client.id, rows);
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const uploaded = upload.body.data as UploadResult;

    const validate = await api()
      .post(`${importPath(realm.client.id, uploaded.batch.id)}/validate`)
      .set(auth(token));
    assert.equal(validate.status, 200, JSON.stringify(validate.body));
    const validated = validate.body.data as UploadResult;

    const byRow = new Map(validated.rows.map((r) => [r.rowNumber, r]));
    assert.equal(byRow.get(1)?.status, 'VALID');
    assert.equal(byRow.get(2)?.status, 'INVALID');
    assert.equal(byRow.get(2)?.errorCode, 'VALIDATION');
    assert.equal(byRow.get(3)?.status, 'INVALID');
    assert.equal(byRow.get(3)?.errorCode, 'VALIDATION');
    assert.equal(byRow.get(4)?.status, 'INVALID');
    assert.equal(byRow.get(4)?.errorCode, 'PARTY_REQUIRED');
    assert.equal(byRow.get(5)?.status, 'INVALID');
    assert.equal(byRow.get(5)?.errorCode, 'APARTMENT_UNIT_NOT_FOUND');
    assert.equal(byRow.get(6)?.status, 'INVALID');
    assert.equal(byRow.get(6)?.errorCode, 'DUPLICATE_ROW');
    assert.equal(validated.batch.validRows, 1);
    assert.equal(validated.batch.invalidRows, 5);
  });

  it('3: dedup and idempotency — re-import reuses parties, replayed uploads and commits never duplicate', async () => {
    const realm = await createEmptyRealm('Dedup');
    const token = adminSession;
    const doc = ktp();
    const code = `DEDUP_${suffix()}`;
    const rows = [
      individualRow({ name: 'Repeat Person', ktp: doc, tenantCode: code, pics: [{ picName: 'Repeat PIC', email: 'repeat.pic@example.test' }] }),
    ];

    const key = `idem-${suffix()}`;
    const first = await uploadRows(token, realm.client.id, rows, { idempotencyKey: key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstBatch = (first.body.data as UploadResult).batch;
    await api().post(`${importPath(realm.client.id, firstBatch.id)}/validate`).set(auth(token));
    await api().post(`${importPath(realm.client.id, firstBatch.id)}/confirm`).set(auth(token));
    const firstCommit = await api()
      .post(`${importPath(realm.client.id, firstBatch.id)}/commit`)
      .set(auth(token));
    assert.equal(firstCommit.status, 200, JSON.stringify(firstCommit.body));

    // Same idempotencyKey + same content → the SAME batch is replayed.
    const replay = await uploadRows(token, realm.client.id, rows, { idempotencyKey: key });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal((replay.body.data as UploadResult).replayed, true);
    assert.equal((replay.body.data as UploadResult).batch.id, firstBatch.id);

    // Same idempotencyKey + DIFFERENT content → 409.
    const conflict = await uploadRows(
      token,
      realm.client.id,
      [individualRow({ name: 'Someone Else', ktp: ktp() })],
      { idempotencyKey: key },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'TENANT_IMPORT_IDEMPOTENCY_CONFLICT');

    // A brand-new batch with the same rows resolves every step to REUSE/SKIP.
    const second = await uploadRows(token, realm.client.id, rows);
    const secondBatch = (second.body.data as UploadResult).batch;
    const secondValidate = await api()
      .post(`${importPath(realm.client.id, secondBatch.id)}/validate`)
      .set(auth(token));
    const secondRows = (secondValidate.body.data as UploadResult).rows;
    assert.equal(secondRows[0].outcome.resolution?.action, 'REUSE');
    await api().post(`${importPath(realm.client.id, secondBatch.id)}/confirm`).set(auth(token));
    const secondCommit = await api()
      .post(`${importPath(realm.client.id, secondBatch.id)}/commit`)
      .set(auth(token));
    const secondCommitted = secondCommit.body.data as UploadResult;
    assert.equal(secondCommitted.batch.committedRows, 0);
    assert.equal(secondCommitted.batch.skippedRows, 1);

    // One party + one PIC only — nothing was duplicated.
    const parties = await pool.query(
      'SELECT count(*)::int AS count FROM tenant_companies WHERE client_id = $1',
      [realm.client.id],
    );
    assert.equal(parties.rows[0].count, 1);
    const pics = await pool.query(
      `SELECT count(*)::int AS count FROM tenant_pics p
        JOIN tenant_companies c ON c.id = p.tenant_company_id
       WHERE c.client_id = $1`,
      [realm.client.id],
    );
    assert.equal(pics.rows[0].count, 1);

    // Committing the first batch again is a pure replay (no double-apply).
    const replayCommit = await api()
      .post(`${importPath(realm.client.id, firstBatch.id)}/commit`)
      .set(auth(token));
    assert.equal(replayCommit.status, 200, JSON.stringify(replayCommit.body));
    assert.equal((replayCommit.body.data as UploadResult).replayed, true);
    const partiesAfter = await pool.query(
      'SELECT count(*)::int AS count FROM tenant_companies WHERE client_id = $1',
      [realm.client.id],
    );
    assert.equal(partiesAfter.rows[0].count, 1);
  });

  it('4: tenant isolation — foreign sessions cannot stage or read another Client batch', async () => {
    const mine = await createEmptyRealm('Mine');
    const foreign = await createEmptyRealm('Foreign');
    const token = adminSession;

    const upload = await uploadRows(token, mine.client.id, [
      individualRow({ name: 'Isolated Person', ktp: ktp() }),
    ]);
    const batch = (upload.body.data as UploadResult).batch;

    // A second admin assigned ONLY to the foreign Building.
    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: foreign.building.id,
    });

    const foreignUpload = await uploadRows(outsider.token, mine.client.id, [
      individualRow({ name: 'Sneaky', ktp: ktp() }),
    ]);
    assert.equal(foreignUpload.status, 403);
    assert.equal(foreignUpload.body.error.code, 'BUILDING_ACCESS_DENIED');

    const foreignRead = await api()
      .get(importPath(mine.client.id, batch.id))
      .set(auth(outsider.token));
    assert.equal(foreignRead.status, 403);
    assert.equal(foreignRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A batch id from another Client under my own Client path is a 404.
    const foreignUploadOk = await uploadRows(token, foreign.client.id, [
      individualRow({ name: 'Foreign Person', ktp: ktp() }),
    ]);
    const foreignBatch = (foreignUploadOk.body.data as UploadResult).batch;
    const wrongPath = await api()
      .get(importPath(mine.client.id, foreignBatch.id))
      .set(auth(token));
    assert.equal(wrongPath.status, 404);
    assert.equal(wrongPath.body.error.code, 'TENANT_IMPORT_NOT_FOUND');

    // A row referencing another Client's Unit (even with Building reach)
    // collapses into the non-enumerating 404 vocabulary.
    const crossRow = await uploadData(token, mine.client.id, [
      individualRow({
        name: 'Cross Building',
        ktp: ktp(),
        buildingId: foreign.building.id,
        unitCode: 'TU_A',
      }),
    ]);
    const crossValidate = await api()
      .post(`${importPath(mine.client.id, crossRow.batch.id)}/validate`)
      .set(auth(token));
    const crossRows = (crossValidate.body.data as UploadResult).rows;
    assert.equal(crossRows[0].status, 'INVALID');
    assert.equal(crossRows[0].errorCode, 'APARTMENT_UNIT_NOT_FOUND');

    // A Building the session cannot reach is a per-row access denial.
    const unreachable = await createEmptyRealm('Unreachable', false);
    const deniedReach = await uploadData(token, mine.client.id, [
      individualRow({
        name: 'No Reach',
        ktp: ktp(),
        buildingId: unreachable.building.id,
        unitCode: unreachable.unitCode,
      }),
    ]);
    const deniedValidate = await api()
      .post(`${importPath(mine.client.id, deniedReach.batch.id)}/validate`)
      .set(auth(token));
    const deniedRows = (deniedValidate.body.data as UploadResult).rows;
    assert.equal(deniedRows[0].status, 'INVALID');
    assert.equal(deniedRows[0].errorCode, 'BUILDING_ACCESS_DENIED');
  });

  it('5: RBAC — tenant_company.manage is required for every phase write', async () => {
    const realm = await createEmptyRealm('RBAC');
    const reader = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);

    // The reader has the permission but no Building assignment → denied by
    // the same BE-02 reach rule, not by RBAC alone.
    const readNoReach = await api()
      .get(importPath(realm.client.id))
      .set(auth(reader));
    assert.equal(readNoReach.status, 403);
    assert.equal(readNoReach.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const plainWrite = await api()
      .post(importPath(realm.client.id))
      .set(auth(plain))
      .send({ rows: [individualRow({ name: 'Nope', ktp: ktp() })] });
    assert.equal(plainWrite.status, 403);
    assert.equal(plainWrite.body.error.code, 'PERMISSION_DENIED');

    // A read-only role WITH reach can preview but not validate/confirm/commit.
    const readerOnly = await createReadonlyWithReach(realm.building.id);
    const uploadForReader = await uploadRows(adminSession, realm.client.id, [
      individualRow({ name: 'Read Only Batch', ktp: ktp() }),
    ]);
    const batch = (uploadForReader.body.data as UploadResult).batch;
    const readOk = await api()
      .get(importPath(realm.client.id, batch.id))
      .set(auth(readerOnly));
    assert.equal(readOk.status, 200, JSON.stringify(readOk.body));
    for (const phase of ['validate', 'confirm', 'commit', 'abort']) {
      const denied = await api()
        .post(`${importPath(realm.client.id, batch.id)}/${phase}`)
        .set(auth(readerOnly));
      assert.equal(denied.status, 403, `${phase} must be denied: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('6: occupant change is effective-dated and unknown occupants never become fictitious Tenants', async () => {
    const realm = await createEmptyRealm('Occupant');
    const token = adminSession;

    const batch1 = (await uploadData(token, realm.client.id, [
      individualRow({
        name: 'Occupant One',
        ktp: ktp(),
        unitCode: realm.unitCode,
        buildingId: realm.building.id,
      }),
    ])).batch;
    await api().post(`${importPath(realm.client.id, batch1.id)}/validate`).set(auth(token));
    await api().post(`${importPath(realm.client.id, batch1.id)}/confirm`).set(auth(token));
    await api().post(`${importPath(realm.client.id, batch1.id)}/commit`).set(auth(token));

    // A row that names a Unit but no party is refused — the Unit simply stays
    // unassigned instead of gaining a placeholder Tenant.
    const ghost = (await uploadData(token, realm.client.id, [
      {
        unitLinks: [
          { buildingId: realm.building.id, unitCode: realm.otherUnitCode, relation: 'TENANCY' },
        ],
      },
    ])).batch;
    const ghostValidate = await api()
      .post(`${importPath(realm.client.id, ghost.id)}/validate`)
      .set(auth(token));
    const ghostRows = (ghostValidate.body.data as UploadResult).rows;
    assert.equal(ghostRows[0].errorCode, 'PARTY_REQUIRED');

    // Occupant hand-over: party B replaces party A with an effective date.
    const effectiveFrom = new Date(Date.now() + 60_000).toISOString();
    const batch2 = (await uploadData(token, realm.client.id, [
      individualRow({
        name: 'Occupant Two',
        ktp: ktp(),
        unitCode: realm.unitCode,
        buildingId: realm.building.id,
        relation: 'TENANCY',
        replaceExisting: true,
        effectiveFrom,
      }),
    ])).batch;
    const validate2 = await api()
      .post(`${importPath(realm.client.id, batch2.id)}/validate`)
      .set(auth(token));
    const rows2 = (validate2.body.data as UploadResult).rows;
    assert.equal(rows2[0].status, 'VALID');
    const plan = rows2[0].outcome.plan as { step: string; action: string }[];
    const linkStep = plan.find((s) => s.step === 'LINK');
    assert.equal(linkStep?.action, 'REPLACE');
    await api().post(`${importPath(realm.client.id, batch2.id)}/confirm`).set(auth(token));
    const commit2 = await api()
      .post(`${importPath(realm.client.id, batch2.id)}/commit`)
      .set(auth(token));
    assert.equal(commit2.status, 200, JSON.stringify(commit2.body));

    // History survives: both tenancy rows exist, the old one closed at the
    // effective instant, the new one ACTIVE.
    const history = await pool.query(
      `SELECT status, effective_until FROM tenant_space_relationships
        WHERE space_id = $1 ORDER BY created_at ASC`,
      [realm.unitId],
    );
    assert.equal(history.rows.length, 2);
    assert.equal(history.rows[0].status, 'INACTIVE');
    assert.ok(history.rows[0].effective_until);
    assert.equal(history.rows[1].status, 'ACTIVE');
  });

  it('7: rollback — abort discards a staged batch; a commit-time failure stays per-row', async () => {
    const realm = await createEmptyRealm('Rollback');
    const token = adminSession;

    // (a) abort = rollback before commit: nothing is created.
    const staged = (await uploadData(token, realm.client.id, [
      individualRow({ name: 'Never Committed', ktp: ktp() }),
    ])).batch;
    await api().post(`${importPath(realm.client.id, staged.id)}/validate`).set(auth(token));
    await api().post(`${importPath(realm.client.id, staged.id)}/confirm`).set(auth(token));
    const abort = await api()
      .post(`${importPath(realm.client.id, staged.id)}/abort`)
      .set(auth(token));
    assert.equal(abort.status, 200, JSON.stringify(abort.body));
    assert.equal(abort.body.data.batch.status, 'ABORTED');
    const commitAborted = await api()
      .post(`${importPath(realm.client.id, staged.id)}/commit`)
      .set(auth(token));
    assert.equal(commitAborted.status, 409);
    assert.equal(commitAborted.body.error.code, 'TENANT_IMPORT_STATE_CONFLICT');
    const parties = await pool.query(
      'SELECT count(*)::int AS count FROM tenant_companies WHERE client_id = $1',
      [realm.client.id],
    );
    assert.equal(parties.rows[0].count, 0);
    // abort is idempotent
    const abortAgain = await api()
      .post(`${importPath(realm.client.id, staged.id)}/abort`)
      .set(auth(token));
    assert.equal(abortAgain.status, 200);

    // (b) commit-time race: a row whose Unit got occupied after validation
    // fails on its own while its sibling row still commits.
    const rows = [
      individualRow({
        name: 'Row One',
        ktp: ktp(),
        unitCode: realm.unitCode,
        buildingId: realm.building.id,
      }),
      individualRow({
        name: 'Row Two',
        ktp: ktp(),
        unitCode: realm.otherUnitCode,
        buildingId: realm.building.id,
      }),
    ];
    const racing = (await uploadData(token, realm.client.id, rows)).batch;
    await api().post(`${importPath(realm.client.id, racing.id)}/validate`).set(auth(token));
    await api().post(`${importPath(realm.client.id, racing.id)}/confirm`).set(auth(token));

    // Someone else occupies unit B between validate and commit.
    const intruder = await tenantCompanyService.createTenantCompany(
      {
        clientId: realm.client.id,
        tenantCode: `INTRUDER_${suffix()}`,
        tenantName: 'Intruder Tenant',
        partyKind: 'INDIVIDUAL',
        identityDocumentType: 'KTP',
        identityDocumentNumber: ktp(),
      },
      adminUserId,
    );
    await tenantSpaceService.assignSpaceToTenant(
      {
        tenantCompanyId: intruder.id,
        buildingId: realm.building.id,
        spaceId: realm.otherUnitId,
      },
      adminUserId,
    );

    const commit = await api()
      .post(`${importPath(realm.client.id, racing.id)}/commit`)
      .set(auth(token));
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    const committed = commit.body.data as UploadResult;
    const rowOne = committed.rows.find((r) => r.rowNumber === 1);
    const rowTwo = committed.rows.find((r) => r.rowNumber === 2);
    assert.equal(rowOne?.status, 'COMMITTED');
    assert.equal(rowTwo?.status, 'FAILED');
    assert.equal(rowTwo?.errorCode, 'TENANT_SPACE_ALREADY_ASSIGNED');
    assert.equal(committed.batch.committedRows, 1);
  });

  it('8: Customer Care compatibility — unverified parties hold no approval or billing authority', async () => {
    const realm = await createEmptyRealm('CareCompat');
    const token = adminSession;
    const care = await createCareStaff(realm.building.id);

    // Temporary registration via the import defaults to PENDING_VERIFICATION.
    const batch = (await uploadData(token, realm.client.id, [
      individualRow({
        name: 'Pending Tenant',
        ktp: ktp(),
        unitCode: realm.unitCode,
        buildingId: realm.building.id,
        verificationStatus: 'PENDING_VERIFICATION',
      }),
    ])).batch;
    await api().post(`${importPath(realm.client.id, batch.id)}/validate`).set(auth(token));
    await api().post(`${importPath(realm.client.id, batch.id)}/confirm`).set(auth(token));
    const commit = await api()
      .post(`${importPath(realm.client.id, batch.id)}/commit`)
      .set(auth(token));
    const pendingId = (commit.body.data as UploadResult).rows[0].tenantCompanyId;
    assert.ok(pendingId);

    // BE-14D Building context is unchanged by this CR: created explicitly
    // through the existing service, exactly as before.
    await tenantBuildingContextService.createTenantBuildingContext(
      { tenantCompanyId: pendingId, buildingId: realm.building.id },
      adminUserId,
    );

    const requestBody = {
      tenantCompanyId: pendingId,
      spaceId: realm.unitId,
      serviceCatalogId: realm.service.id,
      description: 'AC leaking',
    };

    // Default parties (the unverified tenant itself) must not gain approval
    // or billing authority.
    const denied = await api()
      .post(`${V1}/handyman/care/buildings/${realm.building.id}/requests`)
      .set(auth(care.token))
      .set('Idempotency-Key', `batch-care-${suffix()}`)
      .send(requestBody);
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'TENANT_VERIFICATION_REQUIRED');

    // PATCH cannot smuggle a verification verdict.
    const patch = await api()
      .patch(`${V1}/tenant-companies/${pendingId}`)
      .set(auth(token))
      .send({ verificationStatus: 'VERIFIED' });
    assert.equal(patch.status, 400);

    // The auditable verification action is the only channel.
    const verify = await api()
      .post(`${V1}/tenant-companies/${pendingId}/verification`)
      .set(auth(token))
      .send({ status: 'VERIFIED' });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.equal(verify.body.data.verificationStatus, 'VERIFIED');

    // Existing Care flow works unchanged for a VERIFIED party.
    const allowed = await api()
      .post(`${V1}/handyman/care/buildings/${realm.building.id}/requests`)
      .set(auth(care.token))
      .set('Idempotency-Key', `batch-care-${suffix()}`)
      .send(requestBody);
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.status, 'INTAKE');

    // A designated payer that is still unverified is refused the same way.
    const pendingPayer = await tenantCompanyService.createTenantCompany(
      {
        clientId: realm.client.id,
        tenantCode: `PAYER_${suffix()}`,
        tenantName: 'Pending Payer',
        partyKind: 'INDIVIDUAL',
        identityDocumentType: 'KTP',
        identityDocumentNumber: ktp(),
        verificationStatus: 'PENDING_VERIFICATION',
      },
      adminUserId,
    );
    await api()
      .post(`${V1}/buildings/${realm.building.id}/units/${realm.unitId}/parties`)
      .set(auth(token))
      .send({ tenantCompanyId: pendingPayer.id, partyRole: 'OWNER' });
    const deniedPayer = await api()
      .post(`${V1}/handyman/care/buildings/${realm.building.id}/requests`)
      .set(auth(care.token))
      .set('Idempotency-Key', `batch-care-${suffix()}`)
      .send({ ...requestBody, costResponsibleTenantCompanyId: pendingPayer.id });
    assert.equal(deniedPayer.status, 409, JSON.stringify(deniedPayer.body));
    assert.equal(deniedPayer.body.error.code, 'TENANT_VERIFICATION_REQUIRED');

    // Verification transitions are audited.
    const audit = await pool.query(
      `SELECT count(*)::int AS count FROM authentication_audit_events
        WHERE event_type = 'TENANT_VERIFICATION_UPDATED'`,
    );
    assert.ok(audit.rows[0].count >= 1);
  });

  it('9: existing create callers stay byte-identical (default VERIFIED) and upload rejects empty batches', async () => {
    const realm = await createEmptyRealm('Compat');
    const legacy = await tenantCompanyService.createTenantCompany(
      {
        clientId: realm.client.id,
        tenantCode: `LEGACY_${suffix()}`,
        tenantName: 'Legacy Company',
      },
      adminUserId,
    );
    assert.equal(legacy.verificationStatus, 'VERIFIED');
    assert.equal(legacy.partyKind, 'LEGAL_ENTITY');

    const empty = await api()
      .post(importPath(realm.client.id))
      .set(auth(adminSession))
      .send({ rows: [] });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
  });
});

/** Read-only session WITH an ACTIVE assignment to the given Building. */
async function createReadonlyWithReach(buildingId: string): Promise<string> {
  const tag = suffix().toLowerCase();
  const email = `readonly-${tag}@example.test`;
  const password = `ReadOnly-${tag}!Password1`;
  const user = await userService.createUser({ email, displayName: 'Read Only' });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `READONLY_${tag.toUpperCase()}`,
    name: 'Read Only',
  });
  await permissionService.assignPermissionToRole(
    role.id,
    await ensurePermission('tenant_company.read', 'Read Tenant Companies'),
  );
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}
