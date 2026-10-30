/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — focused document-settings tests.
 *
 * Five contracts, nothing else: one effective configuration per provider/kind/
 * language as an append-only chain that direct SQL cannot rewrite; wording input
 * validated field by field (including text the frozen layout would erase) with
 * nothing written when refused; a vocabulary that contains no number, amount,
 * acceptance, consent, signature or bank column at all - in the API, in the table
 * and in the snapshot; writes only for an explicitly authorized Handyman Manager
 * inside the provider's scope; a frozen digest-bearing snapshot that a later
 * change cannot move; and one prefix per document kind.
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
  resolveHandymanDocumentSettingsSnapshot,
  updateHandymanDocumentSettings,
} from '../src/modules/handyman-documents';
import type { HandymanDocumentSettingsSnapshot } from '../src/modules/handyman-documents';
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
const PORT = 55586;
const DIR = '/tmp/asentra-handyman-document-settings-pg';
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

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ALLOWED';
  } catch (error) {
    return (error as Error).message;
  }
}

async function errorCodeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return 'ALLOWED';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as { errno?: string }).errno;
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
  assert.ok(config, 'Document-settings tests require PostgreSQL');
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
  const email = `ds-${tag.toLowerCase()}@document-settings.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: `DS_${tag}`, name: `Role ${tag}` });
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

type Fixture = Awaited<ReturnType<typeof createRealmFixture>>;

async function createRealmFixture() {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `DSCL_${tag}`,
    name: `Provider ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `DSPR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `DSBL_${tag}`,
    name: `Building ${tag}`,
  });
  const siblingClient = await clientService.createClient({
    code: `DSSC_${tag}`,
    name: `Other Provider ${tag}`,
  });
  const siblingProperty = await propertyService.createProperty({
    clientId: siblingClient.id,
    code: `DSSP_${tag}`,
    name: `Sibling Property ${tag}`,
  });
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: siblingProperty.id,
    code: `DSSB_${tag}`,
    name: `Sibling Building ${tag}`,
  });
  for (const buildingId of [building.id, siblingBuilding.id]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId });
  }

  const manager = await createUser(`Settings Manager ${tag}`, [building.id], [
    'handyman.commercial.manage',
  ]);
  const care = await createUser(`Care Actor ${tag}`, [building.id], ['handyman.care.building']);
  const tenantSide = await createUser(`Tenant PIC ${tag}`, [building.id], [
    'tenant_company.read',
    'tenant_company.manage',
  ]);
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `DSTC_${tag}`, tenantName: `Tenant ${tag}` },
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
  const siblingManager = await createUser(`Sibling Manager ${tag}`, [siblingBuilding.id], [
    'handyman.commercial.manage',
  ]);

  return { tag, client, siblingClient, manager, care, tenantSide, siblingManager };
}

const TERMS_LINE_1 = 'Harga sudah termasuk jasa tukang dan peralatan kerja standar.';
const TERMS_LINE_2 = 'Pembayaran dilakukan setelah pekerjaan selesai dan diperiksa bersama.';

function settings(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: null,
    documentPrefix: 'QT',
    termsLines: [TERMS_LINE_1, TERMS_LINE_2],
    paymentNote: 'Transfer ke rekening perusahaan yang tercantum pada dokumen ini.',
    warrantyNote: 'Pengerjaan bergaransi 30 hari kalender sejak BAST ditandatangani.',
    footerNote: 'Dokumen ini diterbitkan oleh sistem operasional Handyman.',
    contactNote: 'Kontak operasional tersedia pada jam kerja 08.00-17.00 WIB.',
    signatoryName: 'Budi Hartono',
    signatoryTitle: 'Operations Manager',
    ...overrides,
  };
}

const path = (f: Fixture, kind = 'QUOTATION', language = 'id') =>
  `${V1}/handyman/clients/${f.client.id}/document-settings/${kind}/${language}`;

async function putSettings(
  f: Fixture,
  body: Record<string, unknown>,
  token?: string,
  kind = 'QUOTATION',
  language = 'id',
) {
  return api()
    .put(path(f, kind, language))
    .set({ Authorization: `Bearer ${token ?? f.manager.token}` })
    .send(body);
}

async function readSettings(f: Fixture, kind = 'QUOTATION', language = 'id', token?: string) {
  return api()
    .get(path(f, kind, language))
    .set({ Authorization: `Bearer ${token ?? f.manager.token}` });
}

async function activeCounts(clientId: string): Promise<Array<Record<string, string>>> {
  return q<Record<string, string>>(
    `SELECT document_kind AS kind, language, count(*)::text AS n
       FROM handyman_document_issuer_document_settings
      WHERE client_id = $1 AND status = 'ACTIVE'
      GROUP BY document_kind, language
      ORDER BY document_kind, language`,
    [clientId],
  );
}

describe('CR-HM-DOCUMENT-PROFILE-01 PART 01C - document settings', () => {
  it('keeps one effective configuration per kind and language as an append-only chain', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();

    const created = await putSettings(f, settings());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.version, 1);
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.documentKind, 'QUOTATION');
    assert.equal(created.body.data.language, 'id');
    assert.equal(created.body.data.previousVersion, null);
    assert.deepEqual(created.body.data.changedFields, [
      'documentPrefix',
      'termsLines',
      'paymentNote',
      'warrantyNote',
      'footerNote',
      'contactNote',
      'signatoryName',
      'signatoryTitle',
    ]);

    const read = await readSettings(f);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.data.termsLines, [TERMS_LINE_1, TERMS_LINE_2]);
    assert.equal(read.body.data.documentPrefix, 'QT');
    assert.equal(read.body.data.signatoryName, 'Budi Hartono');

    const amended = await putSettings(
      f,
      settings({ expectedVersion: 1, termsLines: [TERMS_LINE_1], footerNote: null }),
    );
    assert.equal(amended.status, 200, JSON.stringify(amended.body));
    assert.equal(amended.body.data.version, 2);
    assert.equal(amended.body.data.previousVersion, 1);
    assert.deepEqual(amended.body.data.changedFields, ['termsLines', 'footerNote']);
    assert.equal(amended.body.data.footerNote, null, 'an explicit null clears a note');

    // The other language of the same kind is its own configuration, and both
    // may share the prefix because they are one numbering namespace.
    const english = await putSettings(f, settings(), undefined, 'QUOTATION', 'en');
    assert.equal(english.status, 201, JSON.stringify(english.body));
    assert.equal(english.body.data.language, 'en');
    assert.equal(english.body.data.version, 1, 'each kind+language has its own chain');
    assert.deepEqual(await activeCounts(f.client.id), [
      { kind: 'QUOTATION', language: 'en', n: '1' },
      { kind: 'QUOTATION', language: 'id', n: '1' },
    ]);

    const history = await api()
      .get(`${path(f)}/history?limit=10`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.data[0].version, 2);
    assert.equal(history.body.data[1].version, 1);
    assert.equal(history.body.data[1].status, 'SUPERSEDED');
    assert.equal(
      history.body.data[1].footerNote,
      'Dokumen ini diterbitkan oleh sistem operasional Handyman.',
    );
    assert.deepEqual(history.body.data[1].termsLines, [TERMS_LINE_1, TERMS_LINE_2]);
    assert.ok(history.body.data[1].supersededAt);

    // Even direct SQL cannot rewrite what a document was issued under.
    const supersededId = (
      await q<{ id: string }>(
        `SELECT id FROM handyman_document_issuer_document_settings
          WHERE client_id = $1 AND version = 1 AND document_kind = 'QUOTATION' AND language = 'id'`,
        [f.client.id],
      )
    )[0]!.id;
    assert.match(
      await messageOf(() =>
        q(
          `UPDATE handyman_document_issuer_document_settings
              SET document_prefix = 'ZZ' WHERE id = $1`,
          [supersededId],
        ),
      ),
      /immutable history/,
    );
    assert.match(
      await messageOf(() =>
        q(`DELETE FROM handyman_document_issuer_document_settings WHERE id = $1`, [supersededId]),
      ),
      /cannot be deleted/,
    );
    assert.match(
      await messageOf(() =>
        q(
          `UPDATE handyman_document_issuer_document_settings
              SET status = 'ACTIVE', superseded_at = NULL WHERE id = $1`,
          [supersededId],
        ),
      ),
      /immutable history|lifecycle/,
    );

    const events = await q<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_DOCUMENT_SETTINGS' AND client_id = $1
          AND metadata->>'documentKind' = 'QUOTATION' AND metadata->>'language' = 'id'
        ORDER BY (metadata->>'version')::int`,
      [f.client.id],
    );
    assert.deepEqual(
      events.map((row) => row.event_type),
      ['HANDYMAN_DOCUMENT_SETTINGS_CREATED', 'HANDYMAN_DOCUMENT_SETTINGS_UPDATED'],
    );
    assert.deepEqual(events[1]?.metadata?.changedFields, ['termsLines', 'footerNote']);
    assert.equal(events[1]?.metadata?.previousVersion, 1);
    assert.match(String(events[1]?.metadata?.payloadChecksum), /^[0-9a-f]{64}$/);
  });

  it('refuses invalid wording input field by field and writes nothing', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ documentPrefix: undefined }, 'documentPrefix'],
      [{ documentPrefix: 'Q' }, 'documentPrefix'],
      [{ documentPrefix: '1QT' }, 'documentPrefix'],
      [{ documentPrefix: 'QT_2026' }, 'documentPrefix'],
      [{ documentPrefix: 'QT-2026/01' }, 'documentPrefix'],
      [{ documentPrefix: 'TOOLONGPREFIXFORANUMBERNAMESPACE' }, 'documentPrefix'],
      [{ signatoryName: '   ' }, 'signatoryName'],
      [{ signatoryTitle: undefined }, 'signatoryTitle'],
      [{ signatoryName: '###' }, 'signatoryName'],
      [{ paymentNote: 'Transfer ke 1234567890123 sebelum jatuh tempo.' }, 'paymentNote'],
      [{ footerNote: 'rusak' + String.fromCharCode(7) + 'data' }, 'footerNote'],
      [{ warrantyNote: 'x'.repeat(601) }, 'warrantyNote'],
      [{ termsLines: 'not-an-array' }, 'termsLines'],
      [{ termsLines: [TERMS_LINE_1, '   '] }, 'termsLines[1]'],
      [{ termsLines: [null] }, 'termsLines[0]'],
      [{ termsLines: ['x'.repeat(601)] }, 'termsLines[0]'],
      [{ termsLines: Array.from({ length: 61 }, (_unused, i) => `Ketum ${i}`) }, 'termsLines'],
      [{ expectedVersion: 'one' }, 'expectedVersion'],
    ];
    for (const [override, field] of cases) {
      const response = await putSettings(f, Object.assign(settings(), override));
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
      assert.ok(
        (response.body.error.details as { field: string }[]).some(
          (detail) => detail.field === field,
        ),
        `${field} must be named in the details`,
      );
    }

    const noVersion = await putSettings(f, { ...settings(), expectedVersion: undefined });
    assert.equal(noVersion.status, 400);
    assert.ok(
      (noVersion.body.error.details as { field: string }[]).some(
        (detail) => detail.field === 'expectedVersion',
      ),
      'a writer must state the version it read',
    );

    // The frozen layout vocabulary is the only accepted one: no alias, no
    // invented kind, no other language.
    const badKind = await putSettings(f, settings(), undefined, 'WARRANTY', 'id');
    assert.equal(badKind.status, 400, JSON.stringify(badKind.body));
    assert.ok(
      (badKind.body.error.details as { field: string }[]).some(
        (detail) => detail.field === 'documentKind',
      ),
      'WARRANTY must be named as the canonical WARRANTY_CERTIFICATE',
    );
    const badLanguage = await readSettings(f, 'QUOTATION', 'id-ID');
    assert.equal(badLanguage.status, 400);
    const badClient = await api()
      .get(`${V1}/handyman/clients/not-a-uuid/document-settings/QUOTATION/id`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(badClient.status, 400);

    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_document_settings
             WHERE client_id = $1`,
          [f.client.id],
        )
      )[0].n,
      '0',
      'a refused write creates no row for this provider',
    );
  });

  it('has no number, money, acceptance, consent, signature or bank vocabulary at all', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();

    // Every attempt to make settings speak over a governed fact is refused by
    // the field allow-list - not by a policy that could be configured away.
    for (const forbidden of [
      'documentNumber',
      'issuedNumber',
      'numberSequence',
      'grandTotal',
      'amount',
      'price',
      'taxRate',
      'dpAmount',
      'acceptedAt',
      'bastAccepted',
      'consentAccepted',
      'warrantyStartsAt',
      'signatureImage',
      'signatureReference',
      'approvedBy',
      'accountNumber',
      'bankName',
      'status',
      'version',
      'clientId',
      'language',
    ]) {
      const response = await putSettings(f, settings({ [forbidden]: 'x' }));
      assert.equal(response.status, 400, `${forbidden}: ${JSON.stringify(response.body)}`);
      assert.ok(
        (response.body.error.details as { field: string }[]).some(
          (detail) => detail.field === forbidden,
        ),
        `${forbidden} must be refused by name`,
      );
    }

    // The storage has nowhere to put such a value either.
    const columns = (
      await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'handyman_document_issuer_document_settings'
          ORDER BY column_name`,
      )
    ).map((row) => row.column_name);
    assert.deepEqual(columns, [
      'client_id',
      'contact_note',
      'created_at',
      'created_by_user_id',
      'document_kind',
      'document_prefix',
      'effective_from',
      'footer_note',
      'id',
      'language',
      'payment_note',
      'signatory_name',
      'signatory_title',
      'status',
      'superseded_at',
      'terms_lines',
      'version',
      'warranty_note',
    ]);

    // And the snapshot a document would pin carries exactly the voice fields.
    const created = await updateHandymanDocumentSettings(
      {
        clientId: f.client.id,
        documentKind: 'QUOTATION',
        language: 'id',
        expectedVersion: null,
        documentPrefix: 'QT',
        termsLines: [TERMS_LINE_1],
        paymentNote: null,
        warrantyNote: null,
        footerNote: null,
        contactNote: null,
        signatoryName: 'Budi Hartono',
        signatoryTitle: 'Operations Manager',
      },
      adminId,
    );
    assert.equal(created.version, 1);
    const snapshot = await resolveHandymanDocumentSettingsSnapshot(f.client.id, 'QUOTATION', 'id');
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'checksumAlgorithm',
      'clientId',
      'contactNote',
      'documentKind',
      'documentPrefix',
      'footerNote',
      'language',
      'payloadChecksum',
      'paymentNote',
      'settingsId',
      'signatoryName',
      'signatoryTitle',
      'termsLines',
      'version',
      'warrantyNote',
    ]);
  });

  it('is a Manager act inside the provider scope, and cannot be self-escalated', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();

    for (const [label, actor] of [
      ['Customer Care', f.care],
      ['Tenant PIC with tenant_company.manage', f.tenantSide],
    ] as const) {
      const write = await putSettings(f, settings(), actor.token);
      assert.equal(write.status, 403, `${label}: ${JSON.stringify(write.body)}`);
      assert.equal(write.body.error.code, 'PERMISSION_DENIED', label);
      const read = await readSettings(f, 'QUOTATION', 'id', actor.token);
      assert.equal(read.status, 403, `${label} read`);
      assert.equal(read.body.error.code, 'PERMISSION_DENIED', label);
      const history = await api()
        .get(`${path(f)}/history`)
        .set({ Authorization: `Bearer ${actor.token}` });
      assert.equal(history.status, 403, `${label} history`);
    }

    // A commercial.manage holder of ANOTHER provider: permission yes, scope no.
    const outOfScope = await putSettings(f, settings(), f.siblingManager.token);
    assert.equal(outOfScope.status, 403, JSON.stringify(outOfScope.body));
    assert.equal(outOfScope.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The same actor IS authorized for their own provider - and only there.
    const own = await api()
      .put(`${V1}/handyman/clients/${f.siblingClient.id}/document-settings/QUOTATION/id`)
      .set({ Authorization: `Bearer ${f.siblingManager.token}` })
      .send(settings({ documentPrefix: 'QT' }));
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.data.clientId, f.siblingClient.id);
    const peek = await readSettings(f, 'QUOTATION', 'id', f.siblingManager.token);
    assert.equal(peek.status, 403, 'no read of another provider wording either');

    // An unknown provider is a 404, before any authorization detail is given.
    const ghost = await api()
      .put(`${V1}/handyman/clients/${randomUUID()}/document-settings/QUOTATION/id`)
      .set({ Authorization: `Bearer ${f.manager.token}` })
      .send(settings());
    assert.equal(ghost.status, 404, JSON.stringify(ghost.body));

    const rows = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM handyman_document_issuer_document_settings
        WHERE client_id = $1`,
      [f.client.id],
    );
    assert.equal(rows[0]?.n, '0', 'every refusal wrote nothing for this provider');
  });

  it('resolves a frozen snapshot that a later change cannot move', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    assert.equal((await putSettings(f, settings())).status, 201);

    const snapshot: HandymanDocumentSettingsSnapshot =
      await resolveHandymanDocumentSettingsSnapshot(f.client.id, 'QUOTATION', 'id');
    assert.equal(snapshot.documentPrefix, 'QT');
    assert.deepEqual([...snapshot.termsLines], [TERMS_LINE_1, TERMS_LINE_2]);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.language, 'id');
    assert.equal(snapshot.checksumAlgorithm, 'SHA-256');
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.termsLines), 'the terms array is frozen too');

    (snapshot as { signatoryName: string }).signatoryName = 'Someone Else';
    assert.equal(snapshot.signatoryName, 'Budi Hartono', 'the pinned value cannot move');

    const canonical = stableJson({
      documentPrefix: snapshot.documentPrefix,
      termsLines: [...snapshot.termsLines],
      paymentNote: snapshot.paymentNote,
      warrantyNote: snapshot.warrantyNote,
      footerNote: snapshot.footerNote,
      contactNote: snapshot.contactNote,
      signatoryName: snapshot.signatoryName,
      signatoryTitle: snapshot.signatoryTitle,
    });
    assert.equal(
      snapshot.payloadChecksum,
      createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex'),
      'a document can prove which settings it printed',
    );

    await putSettings(
      f,
      settings({
        expectedVersion: 1,
        signatoryName: 'Anita Wijaya',
        termsLines: [TERMS_LINE_1],
      }),
    );
    const next = await resolveHandymanDocumentSettingsSnapshot(f.client.id, 'QUOTATION', 'id');
    assert.equal(next.version, 2);
    assert.equal(next.signatoryName, 'Anita Wijaya');
    assert.notEqual(next.payloadChecksum, snapshot.payloadChecksum);
    assert.equal(snapshot.signatoryName, 'Budi Hartono', 'the old snapshot is untouched');
    assert.deepEqual([...snapshot.termsLines], [TERMS_LINE_1, TERMS_LINE_2]);
    assert.notEqual(next.settingsId, snapshot.settingsId);

    // Fail closed on an unconfigured kind: no invented terms or signatory.
    assert.equal(
      await errorCodeOf(() => resolveHandymanDocumentSettingsSnapshot(f.client.id, 'BAST', 'id')),
      'HANDYMAN_DOCUMENT_SETTINGS_NOT_FOUND',
    );
    assert.equal(
      await errorCodeOf(() =>
        resolveHandymanDocumentSettingsSnapshot(f.siblingClient.id, 'QUOTATION', 'en'),
      ),
      'HANDYMAN_DOCUMENT_SETTINGS_NOT_FOUND',
    );
  });

  it('gives one prefix to one document kind and serializes concurrent writers', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    assert.equal((await putSettings(f, settings({ documentPrefix: 'QT' }))).status, 201);

    const collision = await putSettings(
      f,
      settings({ documentPrefix: 'QT' }),
      undefined,
      'INVOICE',
      'id',
    );
    assert.equal(collision.status, 409, JSON.stringify(collision.body));
    assert.equal(collision.body.error.code, 'HANDYMAN_DOCUMENT_SETTINGS_PREFIX_CONFLICT');
    assert.ok(JSON.stringify(collision.body).includes('QUOTATION'), 'names the owner kind');
    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_document_settings
            WHERE client_id = $1 AND document_kind = 'INVOICE'`,
          [f.client.id],
        )
      )[0].n,
      '0',
    );

    // Same kind, other language: one namespace, two renderings - allowed.
    assert.equal((await putSettings(f, settings(), undefined, 'QUOTATION', 'en')).status, 201);

    // Move QUOTATION to its own new prefix, in BOTH languages, and the old one is
    // released for whoever is ACTIVE - a superseded version never keeps a lock.
    const moved = await putSettings(f, settings({ expectedVersion: 1, documentPrefix: 'QTE' }));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const movedEnglish = await putSettings(
      f,
      settings({ expectedVersion: 1, documentPrefix: 'QTE' }),
      undefined,
      'QUOTATION',
      'en',
    );
    assert.equal(movedEnglish.status, 200, JSON.stringify(movedEnglish.body));
    const invoice = await putSettings(
      f,
      settings({ documentPrefix: 'QT', signatoryTitle: 'Finance Manager' }),
      undefined,
      'INVOICE',
      'id',
    );
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));

    // A direct-SQL writer is refused by the trigger, not just by the API.
    assert.match(
      await messageOf(() =>
        q(
          `INSERT INTO handyman_document_issuer_document_settings
             (id, client_id, document_kind, language, document_prefix, signatory_name,
              signatory_title, status, version, created_by_user_id)
           VALUES (gen_random_uuid(), $1, 'BAST', 'id', 'QTE', 'Budi Hartono',
                   'Operations Manager', 'ACTIVE', 1, $2)`,
          [f.client.id, adminId],
        ),
      ),
      /numbering namespace/,
    );

    // Two writers of the same configuration: one appends, one is refused.
    const [first, second] = await Promise.all([
      putSettings(f, settings({ expectedVersion: 2, documentPrefix: 'QTE' })),
      putSettings(f, settings({ expectedVersion: 2, documentPrefix: 'QTE' })),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(
      [first, second].find((response) => response.status === 409)!.body.error.code,
      'HANDYMAN_DOCUMENT_SETTINGS_VERSION_CONFLICT',
    );
    assert.deepEqual(await activeCounts(f.client.id), [
      { kind: 'INVOICE', language: 'id', n: '1' },
      { kind: 'QUOTATION', language: 'en', n: '1' },
      { kind: 'QUOTATION', language: 'id', n: '1' },
    ]);
    const versions = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM handyman_document_issuer_document_settings
        WHERE client_id = $1 AND document_kind = 'QUOTATION' AND language = 'id'`,
      [f.client.id],
    );
    assert.equal(versions[0]?.n, '3', 'v1 superseded, v2 ACTIVE, no row for the loser');
  });
});
