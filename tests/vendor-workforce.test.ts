import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, clients, organizations, vendors,
      workforce_profiles, vendor_workforce_bindings CASCADE`,
  );
  adminToken = await createAdminSession();
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

/** Client + Vendor + Organization chain for workforce profiles. */
async function createFixture() {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Vendor Workforce Client',
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'Vendor Workforce Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Vendor Workforce Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Vendor Workforce Position',
  });

  const vendorResponse = await api()
    .post(`/api/v1/clients/${client.id}/vendors`)
    .set(authHeaders())
    .send({
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Binding Test Vendor',
    });
  assert.equal(vendorResponse.status, 201);

  return {
    client,
    organization,
    department,
    position,
    vendor: vendorResponse.body.data as { id: string; clientId: string },
  };
}

async function createProfile(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  workforceType: 'EXTERNAL' | 'INTERNAL' = 'EXTERNAL',
) {
  return workforceService.createWorkforceProfile({
    organizationId: fixture.organization.id,
    departmentId: fixture.department.id,
    positionId: fixture.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Vendor Bound Worker',
    workforceType,
  });
}

async function bindVia(
  vendorId: string,
  workforceProfileId: string,
  body: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/workforce`)
    .set(authHeaders())
    .send({
      workforceProfileId,
      vendorPersonnelCode: `VP-${suffix()}`,
      ...body,
    });
}

const PUBLIC_BINDING_KEYS = [
  'effectiveFrom',
  'effectiveUntil',
  'id',
  'status',
  'vendorId',
  'vendorPersonnelCode',
  'workforceProfileId',
];

describe('POST /api/v1/vendors/:vendorId/workforce', () => {
  it('binds an EXTERNAL workforce profile to a vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    const response = await bindVia(fixture.vendor.id, profile.id, {
      vendorPersonnelCode: 'cc-0091',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.vendorId, fixture.vendor.id);
    assert.equal(response.body.data.workforceProfileId, profile.id);
    assert.equal(response.body.data.vendorPersonnelCode, 'CC-0091');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.effectiveFrom);
    assert.equal(response.body.data.effectiveUntil, null);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_BINDING_KEYS);
  });

  it('supports multiple workforce members per vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const first = await createProfile(fixture);
    const second = await createProfile(fixture);

    assert.equal((await bindVia(fixture.vendor.id, first.id)).status, 201);
    assert.equal((await bindVia(fixture.vendor.id, second.id)).status, 201);

    const list = await api()
      .get(`/api/v1/vendors/${fixture.vendor.id}/workforce`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);
    const profileIds = list.body.data.map(
      (b: { workforceProfileId: string }) => b.workforceProfileId,
    );
    assert.ok(profileIds.includes(first.id));
    assert.ok(profileIds.includes(second.id));
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    const response = await bindVia(randomUUID(), profile.id);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects an unknown workforce profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const response = await bindVia(fixture.vendor.id, randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');
  });

  it('rejects an INTERNAL workforce profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const internal = await createProfile(fixture, 'INTERNAL');

    const response = await bindVia(fixture.vendor.id, internal.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORKFORCE_NOT_EXTERNAL');
  });

  it('rejects a duplicate active binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    assert.equal((await bindVia(fixture.vendor.id, profile.id)).status, 201);

    const duplicate = await bindVia(fixture.vendor.id, profile.id);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'VENDOR_WORKFORCE_ALREADY_BOUND');
  });

  it('rejects a duplicate vendor personnel code within the vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const first = await createProfile(fixture);
    const second = await createProfile(fixture);

    assert.equal(
      (
        await bindVia(fixture.vendor.id, first.id, {
          vendorPersonnelCode: 'VP-SAME',
        })
      ).status,
      201,
    );

    const clash = await bindVia(fixture.vendor.id, second.id, {
      vendorPersonnelCode: 'vp-same',
    });
    assert.equal(clash.status, 409);
    assert.equal(
      clash.body.error.code,
      'VENDOR_PERSONNEL_CODE_ALREADY_EXISTS',
    );
  });

  it('rejects invalid effective dates', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    const reversed = await bindVia(fixture.vendor.id, profile.id, {
      effectiveFrom: '2026-12-01T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(reversed.status, 400);
    assert.equal(reversed.body.error.code, 'VALIDATION_ERROR');

    const malformed = await bindVia(fixture.vendor.id, profile.id, {
      effectiveFrom: 'not-a-date',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a cross-client binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const foreignProfile = await createProfile(fixtureB);

    const response = await bindVia(fixtureA.vendor.id, foreignProfile.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORKFORCE_CLIENT_MISMATCH');
  });

  it('rejects a new active binding for an INACTIVE vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    const deactivate = await api()
      .patch(`/api/v1/vendors/${fixture.vendor.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivate.status, 200);

    const response = await bindVia(fixture.vendor.id, profile.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_INACTIVE');
  });

  it('rejects a new active binding for an INACTIVE workforce profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);
    await workforceService.updateWorkforceProfile(profile.id, {
      status: 'INACTIVE',
    });

    const response = await bindVia(fixture.vendor.id, profile.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORKFORCE_PROFILE_INACTIVE');
  });
});

describe('GET /api/v1/vendors/:vendorId/workforce', () => {
  it('returns 404 for an unknown vendor rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendors/${randomUUID()}/workforce`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('lists only the bindings of the requested vendor (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const profileA = await createProfile(fixtureA);
    const profileB = await createProfile(fixtureB);

    await bindVia(fixtureA.vendor.id, profileA.id);
    await bindVia(fixtureB.vendor.id, profileB.id);

    const response = await api()
      .get(`/api/v1/vendors/${fixtureA.vendor.id}/workforce`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].vendorId, fixtureA.vendor.id);
    assert.equal(response.body.data[0].workforceProfileId, profileA.id);
  });
});

describe('GET /api/v1/workforce/:workforceId/vendor-bindings', () => {
  it('lists the vendor bindings of one workforce profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);
    await bindVia(fixture.vendor.id, profile.id);

    const response = await api()
      .get(`/api/v1/workforce/${profile.id}/vendor-bindings`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].vendorId, fixture.vendor.id);
    assert.equal(response.body.data[0].workforceProfileId, profile.id);
  });

  it('returns 404 for an unknown workforce profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/workforce/${randomUUID()}/vendor-bindings`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');
  });
});

describe('PATCH /api/v1/vendors/:vendorId/workforce/:workforceId', () => {
  it('updates the personnel code and effective window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);
    await bindVia(fixture.vendor.id, profile.id);

    const response = await api()
      .patch(`/api/v1/vendors/${fixture.vendor.id}/workforce/${profile.id}`)
      .set(authHeaders())
      .send({
        vendorPersonnelCode: 'vp-renamed',
        effectiveFrom: '2026-03-01T00:00:00.000Z',
        effectiveUntil: '2026-09-30T00:00:00.000Z',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorPersonnelCode, 'VP-RENAMED');
    assert.ok(response.body.data.effectiveFrom.startsWith('2026-03-01'));
    assert.ok(response.body.data.effectiveUntil.startsWith('2026-09-30'));
  });

  it('rejects a partial update that breaks the stored window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);
    await bindVia(fixture.vendor.id, profile.id, {
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });

    const response = await api()
      .patch(`/api/v1/vendors/${fixture.vendor.id}/workforce/${profile.id}`)
      .set(authHeaders())
      .send({ effectiveUntil: '2026-01-01T00:00:00.000Z' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('deactivates a binding and allows rebinding afterwards', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);
    await bindVia(fixture.vendor.id, profile.id, {
      vendorPersonnelCode: 'VP-HIST-1',
    });

    const deactivated = await api()
      .patch(`/api/v1/vendors/${fixture.vendor.id}/workforce/${profile.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // After deactivation the profile can be bound again (new personnel code
    // because the old one stays reserved per vendor).
    const again = await bindVia(fixture.vendor.id, profile.id, {
      vendorPersonnelCode: 'VP-HIST-2',
    });
    assert.equal(again.status, 201);

    // History row remains.
    const list = await api()
      .get(`/api/v1/vendors/${fixture.vendor.id}/workforce`)
      .set(authHeaders());
    assert.equal(list.body.data.length, 2);
    const statuses = list.body.data.map((b: { status: string }) => b.status);
    assert.deepEqual(statuses.sort(), ['ACTIVE', 'INACTIVE']);
  });

  it('returns 404 when no binding exists for the pair', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    const response = await api()
      .patch(`/api/v1/vendors/${fixture.vendor.id}/workforce/${profile.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_WORKFORCE_BINDING_NOT_FOUND',
    );
  });

  it('rejects updates across clients', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const foreignProfile = await createProfile(fixtureB);

    const response = await api()
      .patch(
        `/api/v1/vendors/${fixtureA.vendor.id}/workforce/${foreignProfile.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORKFORCE_CLIENT_MISMATCH');
  });
});

describe('vendor workforce binding separation (mandatory)', () => {
  it('does not modify User, Credential, Role, Permission, Building access, Building assignment, Shift, Skill, or Supervisor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    const snapshot = async () => ({
      users: (await pool!.query(`SELECT id FROM users ORDER BY id`)).rows,
      credentials: (
        await pool!.query(`SELECT id FROM user_credentials ORDER BY id`)
      ).rows,
      roles: (await pool!.query(`SELECT id FROM roles ORDER BY id`)).rows,
      roleAssignments: (
        await pool!.query(`SELECT id FROM user_role_assignments ORDER BY id`)
      ).rows,
      permissions: (
        await pool!.query(`SELECT id FROM permissions ORDER BY id`)
      ).rows,
      userBuildingAccess: (
        await pool!.query(
          `SELECT id FROM user_building_assignments ORDER BY id`,
        )
      ).rows,
      workforceBuildingAssignments: (
        await pool!.query(
          `SELECT id FROM workforce_building_assignments ORDER BY id`,
        )
      ).rows,
      shiftAssignments: (
        await pool!.query(
          `SELECT id FROM workforce_shift_assignments ORDER BY id`,
        )
      ).rows,
      skillAssignments: (
        await pool!.query(
          `SELECT id FROM workforce_skill_assignments ORDER BY id`,
        )
      ).rows,
      reportingLines: (
        await pool!.query(
          `SELECT id FROM workforce_reporting_lines ORDER BY id`,
        )
      ).rows,
      profile: (
        await pool!.query(
          `SELECT organization_id, department_id, team_id, position_id,
                  employee_code, workforce_type, status, user_id
           FROM workforce_profiles WHERE id = $1`,
          [profile.id],
        )
      ).rows,
    });

    const before = await snapshot();

    const bound = await bindVia(fixture.vendor.id, profile.id);
    assert.equal(bound.status, 201);
    const updated = await api()
      .patch(`/api/v1/vendors/${fixture.vendor.id}/workforce/${profile.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(updated.status, 200);

    const after = await snapshot();
    assert.deepEqual(after, before);
  });
});

describe('vendor workforce RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/vendors/${randomUUID()}/workforce`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor/workforce permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const fixture = await createFixture();
    const profile = await createProfile(fixture);

    const read = await api()
      .get(`/api/v1/vendors/${fixture.vendor.id}/workforce`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const readWorkforceSide = await api()
      .get(`/api/v1/workforce/${profile.id}/vendor-bindings`)
      .set(authHeaders(plainToken));
    assert.equal(readWorkforceSide.status, 403);
    assert.equal(readWorkforceSide.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/vendors/${fixture.vendor.id}/workforce`)
      .set(authHeaders(plainToken))
      .send({ workforceProfileId: profile.id, vendorPersonnelCode: 'VP-X' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(`/api/v1/vendors/${fixture.vendor.id}/workforce/${profile.id}`)
      .set(authHeaders(plainToken))
      .send({ status: 'INACTIVE' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});
