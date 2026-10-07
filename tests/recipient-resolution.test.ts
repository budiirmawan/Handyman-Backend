import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  resolveRecipients,
  resolveRecipientsDetailed,
} from '../src/modules/recipient-resolution';
import type { RecipientSpec } from '../src/modules/recipient-resolution';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26C — Recipient resolution (focused tests).
 *
 * Verifies resolution of notification recipients from existing backend
 * context into a deduplicated User list:
 *   - USER, ROLE, PERMISSION, WORKFORCE, TEAM, TENANT_PIC, VENDOR_PIC,
 *   - deduplication across overlapping sources,
 *   - Client / Building data-scope filtering (BE-02F/BE-02G),
 *   - no fabricated recipients (unlinked/inactive records are skipped).
 *
 * No sending, no event subscription, no provider logic.
 */

const DB_PORT = 55454;
const DATA_DIR = '/tmp/asentra-be26c-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

const id = () => randomUUID();
const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function insertRow(
  table: string,
  values: Record<string, unknown>,
  rowId = id(),
): Promise<string> {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 2}`);
  await q(
    `INSERT INTO ${table} (id, ${columns.join(', ')})
     VALUES ($1, ${placeholders.join(', ')})`,
    [rowId, ...Object.values(values)],
  );
  return rowId;
}

// ---- master data ids ----
let clientA = '';
let clientB = '';
let buildingA1 = '';
let buildingB1 = '';
let u1 = '';
let u2 = '';
let u3 = '';
let u4 = '';
let u5 = '';
let roleEngineer = '';
let roleSecurity = '';
let permissionWorkOrderRead = '';
let orgA = '';
let deptA = '';
let teamA = '';
let positionA = '';
let wp1 = '';
let wp2 = '';
let wp3 = '';
let wp4 = '';
let tenantCompanyA = '';
let tenantPic1 = '';
let tenantPic2 = '';
let tenantPic3 = '';
let vendorA = '';
let vendorPic1 = '';

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       vendor_pics, vendors,
       tenant_pics, tenant_companies,
       workforce_profiles, positions, teams, departments, organizations,
       role_permission_assignments, permissions,
       user_role_assignments, roles,
       user_building_assignments, buildings, properties, clients, users
     CASCADE`,
  );

  // Clients + properties + buildings.
  clientA = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });
  clientB = await insertRow('clients', { code: 'CLIENTB', name: 'Client B', status: 'ACTIVE' });
  const propertyA = await insertRow('properties', { client_id: clientA, code: 'PROPA', name: 'Property A', status: 'ACTIVE' });
  const propertyB = await insertRow('properties', { client_id: clientB, code: 'PROPB', name: 'Property B', status: 'ACTIVE' });
  buildingA1 = await insertRow('buildings', { property_id: propertyA, code: 'BLDA1', name: 'Building A1', status: 'ACTIVE' });
  buildingB1 = await insertRow('buildings', { property_id: propertyB, code: 'BLDB1', name: 'Building B1', status: 'ACTIVE' });

  // Users (u4 has no building access; u5 is INACTIVE).
  u1 = await insertRow('users', { email: 'u1@example.com', display_name: 'User One', status: 'ACTIVE' });
  u2 = await insertRow('users', { email: 'u2@example.com', display_name: 'User Two', status: 'ACTIVE' });
  u3 = await insertRow('users', { email: 'u3@example.com', display_name: 'User Three', status: 'ACTIVE' });
  u4 = await insertRow('users', { email: 'u4@example.com', display_name: 'User Four', status: 'ACTIVE' });
  u5 = await insertRow('users', { email: 'u5@example.com', display_name: 'User Five', status: 'INACTIVE' });

  // Building access: u1→A1, u2→A1, u3→B1.
  for (const userId of [u1, u2]) {
    await insertRow('user_building_assignments', { user_id: userId, building_id: buildingA1, status: 'ACTIVE' });
  }
  await insertRow('user_building_assignments', { user_id: u3, building_id: buildingB1, status: 'ACTIVE' });

  // Roles + assignments (u4 → SECURITY, but has no building access).
  roleEngineer = await insertRow('roles', { code: 'ENGINEER', name: 'Engineer', status: 'ACTIVE' });
  roleSecurity = await insertRow('roles', { code: 'SECURITY', name: 'Security', status: 'ACTIVE' });
  for (const userId of [u1, u2]) {
    await insertRow('user_role_assignments', { user_id: userId, role_id: roleEngineer, status: 'ACTIVE' });
  }
  for (const userId of [u3, u4]) {
    await insertRow('user_role_assignments', { user_id: userId, role_id: roleSecurity, status: 'ACTIVE' });
  }

  // Permission shared by both roles.
  permissionWorkOrderRead = await insertRow('permissions', { code: 'work_order.read', name: 'Read Work Orders', status: 'ACTIVE' });
  for (const roleId of [roleEngineer, roleSecurity]) {
    await insertRow('role_permission_assignments', { role_id: roleId, permission_id: permissionWorkOrderRead, status: 'ACTIVE' });
  }

  // Org hierarchy + workforce profiles.
  orgA = await insertRow('organizations', { client_id: clientA, code: 'ORGA', name: 'Org A', status: 'ACTIVE' });
  deptA = await insertRow('departments', { organization_id: orgA, code: 'DEPTA', name: 'Dept A', status: 'ACTIVE' });
  teamA = await insertRow('teams', { department_id: deptA, code: 'TEAMA', name: 'Team A', status: 'ACTIVE' });
  positionA = await insertRow('positions', { organization_id: orgA, code: 'POSA', name: 'Position A', status: 'ACTIVE' });
  wp1 = await insertRow('workforce_profiles', {
    organization_id: orgA, department_id: deptA, team_id: teamA, position_id: positionA,
    user_id: u1, employee_code: 'EMP1', full_name: 'W1', workforce_type: 'INTERNAL', status: 'ACTIVE',
  });
  wp2 = await insertRow('workforce_profiles', {
    organization_id: orgA, department_id: deptA, team_id: teamA, position_id: positionA,
    user_id: u2, employee_code: 'EMP2', full_name: 'W2', workforce_type: 'INTERNAL', status: 'ACTIVE',
  });
  wp3 = await insertRow('workforce_profiles', {
    organization_id: orgA, department_id: deptA, team_id: teamA, position_id: positionA,
    user_id: null, employee_code: 'EMP3', full_name: 'W3', workforce_type: 'INTERNAL', status: 'ACTIVE',
  });
  wp4 = await insertRow('workforce_profiles', {
    organization_id: orgA, department_id: deptA, team_id: teamA, position_id: positionA,
    user_id: u4, employee_code: 'EMP4', full_name: 'W4', workforce_type: 'INTERNAL', status: 'INACTIVE',
  });

  // Tenant company + PICs (tp2 unlinked, tp3 inactive).
  tenantCompanyA = await insertRow('tenant_companies', { client_id: clientA, tenant_code: 'TENA', tenant_name: 'Tenant A', status: 'ACTIVE' });
  tenantPic1 = await insertRow('tenant_pics', { tenant_company_id: tenantCompanyA, user_id: u1, pic_name: 'TP1', is_primary: true, status: 'ACTIVE' });
  tenantPic2 = await insertRow('tenant_pics', { tenant_company_id: tenantCompanyA, user_id: null, pic_name: 'TP2', is_primary: false, status: 'ACTIVE' });
  tenantPic3 = await insertRow('tenant_pics', { tenant_company_id: tenantCompanyA, user_id: u2, pic_name: 'TP3', is_primary: false, status: 'INACTIVE' });

  // Vendor + PIC (contact data only — no user link).
  vendorA = await insertRow('vendors', { client_id: clientA, vendor_code: 'VENDA', vendor_name: 'Vendor A', status: 'ACTIVE' });
  vendorPic1 = await insertRow('vendor_pics', { vendor_id: vendorA, name: 'VP1', is_primary: true, status: 'ACTIVE' });
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

const sorted = (values: string[]) => [...values].sort();

describe('BE-26C recipient resolution — user / role / permission', () => {
  it('resolves an explicit ACTIVE user', async () => {
    assert.deepEqual(await resolveRecipients([{ kind: 'USER', userId: u1 }]), [u1]);
  });

  it('resolves no recipient for an INACTIVE or unknown user', async () => {
    assert.deepEqual(await resolveRecipients([{ kind: 'USER', userId: u5 }]), []);
    assert.deepEqual(await resolveRecipients([{ kind: 'USER', userId: randomUUID() }]), []);
  });

  it('resolves every ACTIVE user holding a role', async () => {
    assert.deepEqual(
      sorted(await resolveRecipients([{ kind: 'ROLE', roleCode: 'engineer' }])),
      sorted([u1, u2]),
    );
  });

  it('resolves every ACTIVE user with an effective permission', async () => {
    assert.deepEqual(
      sorted(await resolveRecipients([{ kind: 'PERMISSION', permissionCode: 'work_order.read' }])),
      sorted([u1, u2, u3, u4]),
    );
  });
});

describe('BE-26C recipient resolution — workforce / team', () => {
  it('resolves the user linked to a workforce profile', async () => {
    assert.deepEqual(await resolveRecipients([{ kind: 'WORKFORCE', workforceProfileId: wp1 }]), [u1]);
  });

  it('resolves nothing for a profile with no linked user', async () => {
    assert.deepEqual(await resolveRecipients([{ kind: 'WORKFORCE', workforceProfileId: wp3 }]), []);
  });

  it('resolves team members with linked users, skipping unlinked/inactive profiles', async () => {
    assert.deepEqual(
      sorted(await resolveRecipients([{ kind: 'TEAM', teamId: teamA }])),
      sorted([u1, u2]),
    );
  });
});

describe('BE-26C recipient resolution — tenant / vendor PIC', () => {
  it('resolves tenant PICs linked to a user (by company)', async () => {
    assert.deepEqual(
      await resolveRecipients([{ kind: 'TENANT_PIC', tenantCompanyId: tenantCompanyA }]),
      [u1],
    );
  });

  it('resolves a single tenant PIC by id', async () => {
    assert.deepEqual(
      await resolveRecipients([{ kind: 'TENANT_PIC', tenantPicId: tenantPic1 }]),
      [u1],
    );
    assert.deepEqual(
      await resolveRecipients([{ kind: 'TENANT_PIC', tenantPicId: tenantPic2 }]),
      [],
    );
    assert.deepEqual(
      await resolveRecipients([{ kind: 'TENANT_PIC', tenantPicId: tenantPic3 }]),
      [],
    );
  });

  it('resolves no user recipient for vendor PICs (contact data, no User link)', async () => {
    assert.deepEqual(
      await resolveRecipients([{ kind: 'VENDOR_PIC', vendorId: vendorA }]),
      [],
    );
  });
});

describe('BE-26C recipient resolution — deduplication', () => {
  it('deduplicates overlapping sources into a unique user list', async () => {
    const specs: RecipientSpec[] = [
      { kind: 'USER', userId: u1 },
      { kind: 'ROLE', roleCode: 'ENGINEER' },
      { kind: 'TEAM', teamId: teamA },
      { kind: 'TENANT_PIC', tenantCompanyId: tenantCompanyA },
    ];
    assert.deepEqual(sorted(await resolveRecipients(specs)), sorted([u1, u2]));
  });

  it('keeps first-seen provenance on deduplication', async () => {
    const specs: RecipientSpec[] = [
      { kind: 'ROLE', roleCode: 'ENGINEER' },
      { kind: 'TENANT_PIC', tenantCompanyId: tenantCompanyA },
    ];
    const detailed = await resolveRecipientsDetailed(specs);
    assert.equal(detailed.length, 2);
    assert.deepEqual(
      sorted(detailed.map((r) => r.userId)),
      sorted([u1, u2]),
    );
    for (const recipient of detailed) {
      assert.equal(recipient.kind, 'ROLE');
      assert.equal(recipient.sourceId, 'ENGINEER');
    }
  });
});

describe('BE-26C recipient resolution — Client / Building scope', () => {
  it('filters by client scope', async () => {
    assert.deepEqual(
      sorted(await resolveRecipients([{ kind: 'ROLE', roleCode: 'ENGINEER' }], { clientId: clientA })),
      sorted([u1, u2]),
    );
    assert.deepEqual(
      await resolveRecipients([{ kind: 'ROLE', roleCode: 'ENGINEER' }], { clientId: clientB }),
      [],
    );
  });

  it('filters by building scope', async () => {
    assert.deepEqual(
      sorted(await resolveRecipients([{ kind: 'PERMISSION', permissionCode: 'work_order.read' }], { buildingIds: [buildingA1] })),
      sorted([u1, u2]),
    );
  });

  it('excludes users with no accessible building from any scope', async () => {
    // u4 holds SECURITY but has no building access → dropped from every scope.
    assert.deepEqual(
      await resolveRecipients([{ kind: 'ROLE', roleCode: 'SECURITY' }], { clientId: clientB }),
      [u3],
    );
    assert.deepEqual(
      await resolveRecipients([{ kind: 'ROLE', roleCode: 'SECURITY' }], { buildingIds: [buildingB1] }),
      [u3],
    );
  });
});

describe('BE-26C recipient resolution — validation', () => {
  it('rejects malformed specs (bad kind, bad id, ambiguous tenant pic)', async () => {
    const cases: unknown[] = [
      [{ kind: 'NOT_A_KIND' }],
      [{ kind: 'USER', userId: 'not-a-uuid' }],
      [{ kind: 'ROLE', roleCode: '' }],
      [{ kind: 'PERMISSION', permissionCode: 'no-dots' }],
      [{ kind: 'TENANT_PIC', tenantCompanyId: tenantCompanyA, tenantPicId: tenantPic1 }],
      [{ kind: 'TENANT_PIC' }],
      [{ kind: 'VENDOR_PIC', vendorId: 'not-a-uuid' }],
    ];
    for (const spec of cases) {
      await assert.rejects(
        () => resolveRecipients([spec as RecipientSpec]),
        (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
      );
    }
  });

  it('rejects a malformed scope', async () => {
    await assert.rejects(
      () => resolveRecipients([{ kind: 'ROLE', roleCode: 'ENGINEER' }], { clientId: 'nope' }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => resolveRecipients([{ kind: 'ROLE', roleCode: 'ENGINEER' }], { buildingIds: [] }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });
});
