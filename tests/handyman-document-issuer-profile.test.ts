/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — focused issuer-profile tests.
 *
 * Four contracts, nothing else: the version chain is append-only and the
 * history is immutable even to direct SQL; identity input is validated field by
 * field and refused without writing; only an explicitly authorized Handyman
 * Manager may write (Customer Care and the Tenant PIC are refused, and a
 * same-permission manager of another provider is refused by scope); and the
 * read-only snapshot a document pins cannot be rewritten by a later change.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import {
  updateHandymanDocumentIssuerProfile,
  resolveHandymanDocumentIssuerSnapshot,
} from '../src/modules/handyman-documents';
import type {
  HandymanDocumentIssuerSnapshot,
  UpdateHandymanDocumentIssuerProfileInput,
} from '../src/modules/handyman-documents';
import { renderHandymanDocumentPdf } from '../src/modules/handyman-documents';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { stableJson } from '../src/shared/stable-json';

const V1 = '/api/v1';
const PORT = 55584;
const DIR = '/tmp/asentra-handyman-document-issuer-profile-pg';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';

function db(): Pool {
  if (!pool) throw new Error('Test database pool not initialized');
  return pool;
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db().query<T>(sql, params);
  return result.rows;
}

function requireDatabase(t: TestContext): boolean {
  if (!pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function errorCodeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return 'ALLOWED';
  } catch (error) {
    return (error as { code?: string; errno?: string }).code
      ?? (error as { errno?: string }).errno;
  }
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ALLOWED';
  } catch (error) {
    return (error as Error).message;
  }
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1',
      DB_PORT: String(PORT),
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'asentra_test',
      DB_SSL: 'false',
    });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const adminClient = postgres.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Issuer-profile tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

/** A user with the given permissions, Building access, and a live session. */
async function createUser(
  displayName: string,
  buildingIds: string[],
  permissionCodes: string[],
) {
  const tag = suffix();
  const email = `ip-${tag.toLowerCase()}@issuer-profile.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: `IP_${tag}`, name: `Role ${tag}` });
  for (const code of permissionCodes) {
    let perm = await permissionRepository.findByCode(code);
    if (!perm) perm = await permissionService.createPermission({ code, name: code });
    await permissionService.assignPermissionToRole(role.id, perm.id);
  }
  if (permissionCodes.length > 0) await roleService.assignRoleToUser(user.id, role.id);
  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

const COMMERCIAL = ['handyman.commercial.manage'];

type Fixture = Awaited<ReturnType<typeof createRealmFixture>>;

/** One Handyman service provider (Client) plus the actors that must not own it. */
async function createRealmFixture() {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `IPCL_${tag}`,
    name: `Provider ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `IPPR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `IPBL_${tag}`,
    name: `Building ${tag}`,
  });
  const siblingClient = await clientService.createClient({
    code: `IPSC_${tag}`,
    name: `Other Provider ${tag}`,
  });
  const siblingProperty = await propertyService.createProperty({
    clientId: siblingClient.id,
    code: `IPSP_${tag}`,
    name: `Sibling Property ${tag}`,
  });
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: siblingProperty.id,
    code: `IPSB_${tag}`,
    name: `Sibling Building ${tag}`,
  });
  for (const buildingId of [building.id, siblingBuilding.id]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId });
  }

  const manager = await createUser(`Issuer Manager ${tag}`, [building.id], COMMERCIAL);
  // The two refusals named by the CR: Care (mediation bridge) and the Tenant PIC.
  const care = await createUser(`Care Actor ${tag}`, [building.id], ['handyman.care.building']);
  const tenantSide = await createUser(`Tenant PIC ${tag}`, [building.id], [
    'tenant_company.read',
    'tenant_company.manage',
  ]);
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `IPTC_${tag}`, tenantName: `Tenant ${tag}` },
    adminId,
  );
  await q(`UPDATE tenant_companies SET verification_status = 'VERIFIED' WHERE id = $1`, [
    company.id,
  ]);
  await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: `PIC ${tag}`,
      email: `pic-${tag.toLowerCase()}@tenant.test`,
      userId: tenantSide.userId,
      isPrimary: true,
    },
    adminId,
  );
  // A real Handyman Manager of a DIFFERENT provider: same permission, no scope.
  const siblingManager = await createUser(
    `Sibling Manager ${tag}`,
    [siblingBuilding.id],
    COMMERCIAL,
  );

  return {
    tag,
    client,
    building,
    siblingClient,
    siblingBuilding,
    manager,
    care,
    tenantSide,
    company,
    siblingManager,
  };
}

function profileContent(overrides: Partial<UpdateHandymanDocumentIssuerProfileInput> = {}) {
  return {
    legalName: 'PT Asendra Layanan Prima',
    displayName: 'Asendra Handyman',
    registeredAddress: 'Jl. Kenanga No. 88, Kebayoran Baru',
    businessAddress: 'Jl. Kenanga No. 88 Blok C, Jakarta Selatan 12550',
    city: 'Jakarta Selatan',
    province: 'DKI Jakarta',
    postalCode: '12550',
    email: 'Documents@Asentra.Test',
    phone: '+62 21 5000 1111',
    whatsapp: '+62 811 2000 3000',
    website: 'https://asentra.test',
    taxId: '01.234.567.8-901.000',
    businessRegistrationId: '9140001234567',
    logoReference: 'branding/asendra-logo.png',
    ...overrides,
  };
}

function profileBody(overrides: Record<string, unknown> = {}) {
  return { expectedVersion: null, ...profileContent(), ...overrides };
}

async function putProfile(f: Fixture, token: string, body: Record<string, unknown>) {
  return api()
    .put(`${V1}/handyman/clients/${f.client.id}/document-issuer-profile`)
    .set({ Authorization: `Bearer ${token}` })
    .send(body);
}

async function writeV1(f: Fixture): Promise<string> {
  const response = await putProfile(f, f.manager.token, profileBody());
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.id as string;
}

describe('CR-HM-DOCUMENT-PROFILE-01 PART 01A - issuer company profile', () => {
  it('keeps an append-only version chain, audit history and immutable rows', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const v1Id = await writeV1(f);

    const read = await api()
      .get(`${V1}/handyman/clients/${f.client.id}/document-issuer-profile`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(
      {
        legalName: read.body.data.legalName,
        displayName: read.body.data.displayName,
        registeredAddress: read.body.data.registeredAddress,
        businessAddress: read.body.data.businessAddress,
        city: read.body.data.city,
        province: read.body.data.province,
        postalCode: read.body.data.postalCode,
        email: read.body.data.email,
        phone: read.body.data.phone,
        whatsapp: read.body.data.whatsapp,
        website: read.body.data.website,
        taxId: read.body.data.taxId,
        businessRegistrationId: read.body.data.businessRegistrationId,
        logoReference: read.body.data.logoReference,
      },
      {
        ...profileContent(),
        // normalization only, never invention: whitespace collapses, email lowercases
        email: 'documents@asentra.test',
      },
    );
    assert.equal(read.body.data.version, 1);
    assert.equal(read.body.data.status, 'ACTIVE');
    assert.equal(read.body.data.clientId, f.client.id);

    const second = await putProfile(
      f,
      f.manager.token,
      profileBody({ expectedVersion: 1, city: 'Jakarta Pusat', logoReference: null }),
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.version, 2);
    assert.equal(second.body.data.previousVersion, 1);
    assert.deepEqual(second.body.data.changedFields, ['city', 'logoReference']);

    const history = await api()
      .get(`${V1}/handyman/clients/${f.client.id}/document-issuer-profile/history?limit=5`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.data[0].version, 2);
    assert.equal(history.body.data[0].status, 'ACTIVE');
    assert.equal(history.body.data[1].version, 1);
    assert.equal(history.body.data[1].id, v1Id);
    assert.equal(history.body.data[1].status, 'SUPERSEDED');
    assert.equal(
      history.body.data[1].city,
      'Jakarta Selatan',
      'the retired version keeps exactly what it said',
    );
    assert.equal(history.body.data[1].supersededAt !== null, true);
    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_profiles
             WHERE client_id = $1 AND status = 'ACTIVE'`,
          [f.client.id],
        )
      )[0].n,
      '1',
      'exactly one ACTIVE profile per provider',
    );

    // Even direct SQL cannot rewrite history (or the ACTIVE row in place).
    const historyMessage = await messageOf(() =>
      q(`UPDATE handyman_document_issuer_profiles SET legal_name = 'Rewritten' WHERE id = $1`, [
        v1Id,
      ]),
    );
    assert.match(historyMessage, /immutable history/);
    const deleteMessage = await messageOf(() =>
      q(`DELETE FROM handyman_document_issuer_profiles WHERE id = $1`, [v1Id]),
    );
    assert.match(deleteMessage, /cannot be deleted/);
    const activeMessage = await messageOf(() =>
      q(`UPDATE handyman_document_issuer_profiles SET city = 'Elsewhere' WHERE id = $1`, [
        second.body.data.id,
      ]),
    );
    assert.match(activeMessage, /immutable history/);

    // Audit-only journal: the table stays the authority, the events explain it.
    const events = await q<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_DOCUMENT_ISSUER_PROFILE' AND entity_id = ANY($1::uuid[])
        ORDER BY (metadata->>'version')::int`,
      [[v1Id, second.body.data.id]],
    );
    assert.deepEqual(
      events.map((row) => row.event_type),
      [
        'HANDYMAN_DOCUMENT_ISSUER_PROFILE_CREATED',
        'HANDYMAN_DOCUMENT_ISSUER_PROFILE_UPDATED',
      ],
    );
    assert.deepEqual(events[1]?.metadata?.changedFields, ['city', 'logoReference']);
    assert.equal(events[1]?.metadata?.previousVersion, 1);
  });

  it('refuses invalid identity input field by field and writes nothing', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ legalName: undefined }, 'legalName'],
      [{ registeredAddress: '   ' }, 'registeredAddress'],
      [{ email: 'not-an-email' }, 'email'],
      [{ phone: 'call us' }, 'phone'],
      [{ whatsapp: 'wa' }, 'whatsapp'],
      [{ postalCode: '!!' }, 'postalCode'],
      [{ website: 'asentra . test' }, 'website'],
      [{ logoReference: '/etc/passwd' }, 'logoReference'],
      [{ logoReference: 'a/../b' }, 'logoReference'],
      [{ businessRegistrationId: 'nib!*' }, 'businessRegistrationId'],
      [{ registeredAddress: 'x'.repeat(501) }, 'registeredAddress'],
      [{ bankAccount: 'BCA 123' }, 'bankAccount'],
      [{ whatsapp: undefined }, 'whatsapp'],
    ];
    for (const [override, field] of cases) {
      const body = Object.assign(profileBody(), override);
      const response = await putProfile(f, f.manager.token, body);
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(
        (response.body.error.details as { field: string }[]).some(
          (detail) => detail.field === field,
        ),
        `${field} must be named in the details`,
      );
    }

    const noVersion = await putProfile(f, f.manager.token, { ...profileContent() });
    assert.equal(noVersion.status, 400);
    assert.ok(
      (noVersion.body.error.details as { field: string }[]).some(
        (detail) => detail.field === 'expectedVersion',
      ),
      'a writer must state the version it read',
    );

    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_profiles
             WHERE client_id = $1`,
          [f.client.id],
        )
      )[0].n,
      '0',
      'a refused write creates no row',
    );
  });

  it('is writable only by an explicitly authorized Handyman Manager', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();

    for (const [label, actor] of [
      ['Customer Care', f.care],
      ['Tenant PIC with tenant_company.manage', f.tenantSide],
    ] as const) {
      const write = await putProfile(f, actor.token, profileBody());
      assert.equal(write.status, 403, `${label}: ${JSON.stringify(write.body)}`);
      assert.equal(write.body.error.code, 'PERMISSION_DENIED', label);
      const read = await api()
        .get(`${V1}/handyman/clients/${f.client.id}/document-issuer-profile`)
        .set({ Authorization: `Bearer ${actor.token}` });
      assert.equal(read.status, 403, `${label} read`);
      assert.equal(read.body.error.code, 'PERMISSION_DENIED', label);
    }

    // A real commercial.manage holder of ANOTHER provider: permission yes,
    // scope no - the accessible-Client wall answers, not RBAC.
    const outOfScope = await putProfile(f, f.siblingManager.token, profileBody());
    assert.equal(outOfScope.status, 403, JSON.stringify(outOfScope.body));
    assert.equal(outOfScope.body.error.code, 'BUILDING_ACCESS_DENIED');

    // ...and that same actor is legitimately authorized for their OWN provider.
    const scoped = await api()
      .put(`${V1}/handyman/clients/${f.siblingClient.id}/document-issuer-profile`)
      .set({ Authorization: `Bearer ${f.siblingManager.token}` })
      .send(profileBody({ legalName: 'PT Lain Provider' }));
    assert.equal(scoped.status, 201, JSON.stringify(scoped.body));
    assert.equal(scoped.body.data.clientId, f.siblingClient.id);

    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_profiles WHERE client_id = $1`,
          [f.client.id],
        )
      )[0].n,
      '0',
      'no refusal wrote a row',
    );
  });

  it('resolves an immutable snapshot that history can never rewrite', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const created = await updateHandymanDocumentIssuerProfile(
      {
        clientId: f.client.id,
        expectedVersion: null,
        // already normalized, exactly as the HTTP validation layer would store it
        ...profileContent({ email: 'documents@asentra.test' }),
      },
      adminId,
    );

    const snapshot: HandymanDocumentIssuerSnapshot =
      await resolveHandymanDocumentIssuerSnapshot(f.client.id);
    assert.equal(snapshot.profileId, created.id);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.displayName, 'Asendra Handyman');
    assert.equal(snapshot.email, 'documents@asentra.test');
    assert.equal(snapshot.checksumAlgorithm, 'SHA-256');
    assert.ok(Object.isFrozen(snapshot), 'the snapshot handed to a renderer is frozen');
    // A frozen object refuses edits; whether that throws depends on strict mode,
    // so the contract asserted here is the observable one: the value cannot move.
    (snapshot as { city: string }).city = 'Hacked';
    assert.equal(snapshot.city, 'Jakarta Selatan');

    const canonical = stableJson({
      legalName: snapshot.legalName,
      displayName: snapshot.displayName,
      registeredAddress: snapshot.registeredAddress,
      businessAddress: snapshot.businessAddress,
      city: snapshot.city,
      province: snapshot.province,
      postalCode: snapshot.postalCode,
      email: snapshot.email,
      phone: snapshot.phone,
      whatsapp: snapshot.whatsapp,
      website: snapshot.website,
      taxId: snapshot.taxId,
      businessRegistrationId: snapshot.businessRegistrationId,
      logoReference: snapshot.logoReference,
    });
    assert.equal(
      snapshot.payloadChecksum,
      createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex'),
      'the digest is the canonical profile payload, so a document can prove what it printed',
    );

    // A later change produces a NEW snapshot; the pinned one is untouched.
    await updateHandymanDocumentIssuerProfile(
      {
        clientId: f.client.id,
        expectedVersion: 1,
        ...profileContent({
          city: 'Bandung',
          legalName: 'PT Lain Sekali',
          email: 'documents@asentra.test',
        }),
      },
      adminId,
    );
    const next = await resolveHandymanDocumentIssuerSnapshot(f.client.id);
    assert.equal(next.version, 2);
    assert.equal(next.city, 'Bandung');
    assert.notEqual(next.payloadChecksum, snapshot.payloadChecksum);
    assert.equal(snapshot.city, 'Jakarta Selatan', 'a re-resolve cannot mutate the old snapshot');
    assert.equal(snapshot.legalName, 'PT Asendra Layanan Prima');
    assert.notEqual(snapshot.profileId, next.profileId);

    // Fail closed for a provider that has never been configured.
    assert.equal(
      await errorCodeOf(() => resolveHandymanDocumentIssuerSnapshot(f.siblingClient.id)),
      'HANDYMAN_DOCUMENT_ISSUER_PROFILE_NOT_FOUND',
    );

    // The snapshot is directly consumable by the PART 01 renderer (no change there).
    const rendered = await renderHandymanDocumentPdf({
      locale: 'id',
      document: { kind: 'QUOTATION', number: 'QT-2026-0001', issueDate: '2026-10-26T02:45:00.000Z' },
      issuer: {
        name: snapshot.displayName,
        addressLines: [snapshot.registeredAddress, `${snapshot.city} ${snapshot.postalCode}`],
        taxId: snapshot.taxId,
        phone: snapshot.phone,
        email: snapshot.email,
        references: [
          { label: 'Nama badan hukum', value: snapshot.legalName },
          { label: 'Logo', value: snapshot.logoReference },
        ],
      },
      recipient: { name: 'Budi Hartono' },
    });
    assert.equal(rendered.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(rendered.pageCount, 1);
  });

  it('refuses a stale writer instead of overwriting the current version', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    await writeV1(f);
    await putProfile(
      f,
      f.manager.token,
      profileBody({ expectedVersion: 1, phone: '+62 21 7000 8000' }),
    );

    const stale = await putProfile(f, f.manager.token, profileBody({ expectedVersion: 1 }));
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, 'HANDYMAN_DOCUMENT_ISSUER_PROFILE_VERSION_CONFLICT');
    assert.deepEqual(stale.body.error.details, ['The current issuer profile version is 2.']);

    const asFirst = await putProfile(f, f.manager.token, profileBody({ expectedVersion: null }));
    assert.equal(asFirst.status, 409);
    assert.equal(asFirst.body.error.code, 'HANDYMAN_DOCUMENT_ISSUER_PROFILE_VERSION_CONFLICT');

    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_profiles WHERE client_id = $1`,
          [f.client.id],
        )
      )[0].n,
      '2',
      'a refused overwrite adds no version',
    );
    const current = await api()
      .get(`${V1}/handyman/clients/${f.client.id}/document-issuer-profile`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(current.body.data.phone, '+62 21 7000 8000', 'the winner is untouched');
  });
});
