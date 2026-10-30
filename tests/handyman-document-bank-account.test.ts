/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — focused issuer bank account tests.
 *
 * Five contracts, nothing else: an account is inert until a named human verifies
 * it and a document never prints payment instructions that were not verified;
 * an amendment appends a version and leaves the live destination untouched until
 * the replacement is authorized; exactly one default per provider and currency,
 * provable even against direct SQL; the account number is masked in every read,
 * error and audit row; and only an explicitly authorized Handyman Manager inside
 * the provider's scope can write - with no field anywhere that lets a caller
 * declare itself verified.
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
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import {
  createHandymanDocumentBankAccount,
  resolveHandymanDocumentBankAccountSnapshot,
} from '../src/modules/handyman-documents';
import { maskHandymanDocumentAccountNumber } from '../src/modules/handyman-documents';
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
const PORT = 55585;
const DIR = '/tmp/asentra-handyman-document-bank-account-pg';
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
  assert.ok(config, 'Bank-account tests require PostgreSQL');
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
  const email = `ba-${tag.toLowerCase()}@bank-account.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({ email, displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: `BA_${tag}`, name: `Role ${tag}` });
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

/** One provider (Client) that may receive IDR, plus the actors that must not. */
async function createRealmFixture() {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `BACL_${tag}`,
    name: `Provider ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `BAPR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BABL_${tag}`,
    name: `Building ${tag}`,
  });
  const siblingClient = await clientService.createClient({
    code: `BASC_${tag}`,
    name: `Other Provider ${tag}`,
  });
  const siblingProperty = await propertyService.createProperty({
    clientId: siblingClient.id,
    code: `BASP_${tag}`,
    name: `Sibling Property ${tag}`,
  });
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: siblingProperty.id,
    code: `BASB_${tag}`,
    name: `Sibling Building ${tag}`,
  });
  for (const buildingId of [building.id, siblingBuilding.id]) {
    await buildingAssignmentService.createAssignment(adminId, { buildingId });
  }
  // The platform's own currency authority for this provider: IDR only, so a
  // receiving account in any other currency is refused by that contract and not
  // by a rule invented here.
  for (const clientId of [client.id, siblingClient.id]) {
    await clientMonetaryContextService.setClientMonetaryContext(
      {
        clientId,
        baseCurrencyCode: 'IDR',
        defaultTransactionCurrencyCode: 'IDR',
        allowedCurrencyCodes: ['IDR'],
      },
      adminId,
    );
  }

  const manager = await createUser(`Bank Manager ${tag}`, [building.id], COMMERCIAL);
  const care = await createUser(`Care Actor ${tag}`, [building.id], ['handyman.care.building']);
  const tenantSide = await createUser(`Tenant PIC ${tag}`, [building.id], [
    'tenant_company.read',
    'tenant_company.manage',
  ]);
  const company = await tenantCompanyService.createTenantCompany(
    { clientId: client.id, tenantCode: `BATC_${tag}`, tenantName: `Tenant ${tag}` },
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

const ACCOUNT = {
  bankCode: 'BMRI',
  bankName: 'PT Bank Rakyat Indonesia (Persero) Tbk',
  accountNumber: '1370-0001-23456',
  accountHolderName: 'PT Asendra Layanan Prima',
  currency: 'IDR',
};

const base = (f: Fixture) => `${V1}/handyman/clients/${f.client.id}/document-bank-accounts`;

async function createAccount(f: Fixture, overrides: Record<string, unknown> = {}, token?: string) {
  return api()
    .post(base(f))
    .set({ Authorization: `Bearer ${token ?? f.manager.token}` })
    .send({ ...ACCOUNT, ...overrides });
}

async function createAccountId(f: Fixture, overrides: Record<string, unknown> = {}) {
  const response = await createAccount(f, overrides);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.bankAccountId as string;
}

async function activate(
  f: Fixture,
  bankAccountId: string,
  body: Record<string, unknown> = {},
  token?: string,
) {
  return api()
    .post(`${base(f)}/${bankAccountId}/activate`)
    .set({ Authorization: `Bearer ${token ?? f.manager.token}` })
    .send({
      expectedVersion: 1,
      confirmAccountNumber: ACCOUNT.accountNumber,
      verificationReference: 'Bank letter ref BA-001, checked by the manager',
      ...body,
    });
}

async function deactivate(
  f: Fixture,
  bankAccountId: string,
  body: Record<string, unknown> = {},
) {
  return api()
    .post(`${base(f)}/${bankAccountId}/deactivate`)
    .set({ Authorization: `Bearer ${f.manager.token}` })
    .send({ expectedVersion: 1, reason: 'Account closed by the bank', ...body });
}

async function readOne(f: Fixture, bankAccountId: string, token?: string) {
  return api()
    .get(`${base(f)}/${bankAccountId}`)
    .set({ Authorization: `Bearer ${token ?? f.manager.token}` });
}

async function defaultCount(clientId: string): Promise<number> {
  const rows = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM handyman_document_issuer_bank_accounts
      WHERE client_id = $1 AND status = 'ACTIVE' AND is_default`,
    [clientId],
  );
  return Number(rows[0]?.n ?? -1);
}

describe('CR-HM-DOCUMENT-PROFILE-01 PART 01B - issuer company bank accounts', () => {
  it('keeps an account inert until a named human verifies it', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();

    const created = await createAccount(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'PENDING_VERIFICATION');
    assert.equal(created.body.data.isDefault, false);
    assert.equal(created.body.data.version, 1);
    assert.equal(created.body.data.bankAccountId, created.body.data.id);
    assert.equal(created.body.data.verifiedAt, null);
    assert.equal('accountNumber' in (created.body.data as object), false);
    assert.equal(
      created.body.data.accountNumberMasked,
      maskHandymanDocumentAccountNumber(ACCOUNT.accountNumber),
    );

    // A destination is not self-declared: the confirmation must match, and a
    // verification act without a reference is not a verification.
    const wrong = await activate(f, created.body.data.bankAccountId as string, {
      confirmAccountNumber: '0000-0000-00000',
    });
    assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
    assert.equal(wrong.body.error.code, 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONFIRMATION_REQUIRED');
    assert.ok(!JSON.stringify(wrong.body).includes(ACCOUNT.accountNumber));
    const noRef = await api()
      .post(`${base(f)}/${created.body.data.bankAccountId}/activate`)
      .set({ Authorization: `Bearer ${f.manager.token}` })
      .send({ expectedVersion: 1, confirmAccountNumber: ACCOUNT.accountNumber });
    assert.equal(noRef.status, 400, JSON.stringify(noRef.body));
    assert.ok(
      (noRef.body.error.details as { field: string }[]).some(
        (detail) => detail.field === 'verificationReference',
      ),
    );
    assert.equal(await defaultCount(f.client.id), 0, 'no destination yet');

    const activated = await activate(f, created.body.data.bankAccountId as string);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.data.status, 'ACTIVE');
    assert.equal(activated.body.data.isDefault, true);
    assert.equal(activated.body.data.verifiedByUserId, f.manager.userId);
    assert.ok(activated.body.data.verifiedAt);
    assert.equal(await defaultCount(f.client.id), 1);

    const snapshot = await resolveHandymanDocumentBankAccountSnapshot(f.client.id, 'IDR');
    assert.equal(snapshot.accountNumber, ACCOUNT.accountNumber);
    assert.equal(snapshot.bankAccountId, created.body.data.bankAccountId);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.checksumAlgorithm, 'SHA-256');
    assert.ok(Object.isFrozen(snapshot));
    assert.equal(
      snapshot.payloadChecksum,
      createHash('sha256')
        .update(
          Buffer.from(
            stableJson({
              bankCode: ACCOUNT.bankCode,
              bankName: ACCOUNT.bankName,
              accountNumber: ACCOUNT.accountNumber,
              accountHolderName: ACCOUNT.accountHolderName,
              currency: ACCOUNT.currency,
            }),
            'utf8',
          ),
        )
        .digest('hex'),
      'the digest is the canonical payment payload a document printed',
    );

    // A verified-but-not-default account is a real receiving account too.
    const secondId = await createAccountId(f, {
      bankCode: 'BBNI',
      bankName: 'PT Bank Negara Indonesia (Persero) Tbk',
      accountNumber: '0100009876543',
    });
    const asSecond = await activate(f, secondId, {
      asDefault: false,
      confirmAccountNumber: '0100009876543',
    });
    assert.equal(asSecond.status, 200, JSON.stringify(asSecond.body));
    assert.equal(asSecond.body.data.isDefault, false);
    assert.equal(await defaultCount(f.client.id), 1, 'still exactly one default');
    const list = await api()
      .get(base(f))
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.length, 2);
    assert.deepEqual(
      list.body.data.map((row: { currency: string; status: string }) =>
        `${row.currency}:${row.status}`),
      ['IDR:ACTIVE', 'IDR:ACTIVE'],
    );
  });

  it('appends a version on amendment and preserves the live destination', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const accountId = await createAccountId(f);
    assert.equal((await activate(f, accountId)).status, 200);
    const originalNumber = ACCOUNT.accountNumber;

    const amended = await api()
      .put(`${base(f)}/${accountId}`)
      .set({ Authorization: `Bearer ${f.manager.token}` })
      .send({
        expectedVersion: 1,
        ...ACCOUNT,
        accountNumber: '1370-0009-88877',
      });
    assert.equal(amended.status, 200, JSON.stringify(amended.body));
    assert.equal(amended.body.data.version, 2);
    assert.equal(amended.body.data.status, 'PENDING_VERIFICATION');
    assert.equal(amended.body.data.isDefault, false);
    assert.equal(amended.body.data.previousVersion, 1);
    assert.deepEqual(amended.body.data.changedFields, ['accountNumber']);
    assert.equal(amended.body.data.requiresVerification, true);

    // The printed destination is the OLD verified account until the new version
    // is verified AND the replacement is authorized.
    const pinned = await resolveHandymanDocumentBankAccountSnapshot(f.client.id, 'IDR');
    assert.equal(pinned.accountNumber, originalNumber);
    assert.equal(pinned.version, 1);

    const rows = await q<{ version: string; status: string; account_number: string }>(
      `SELECT version::text, status, account_number
         FROM handyman_document_issuer_bank_accounts
        WHERE bank_account_id = $1 ORDER BY version`,
      [accountId],
    );
    assert.deepEqual(
      rows.map((row) => [row.version, row.status]),
      [
        ['1', 'ACTIVE'],
        ['2', 'PENDING_VERIFICATION'],
      ],
      'a live account is never retired by an edit',
    );
    assert.equal(rows[0]?.account_number, originalNumber, 'history keeps the old number verbatim');

    // An unconfirmed handover is refused outright, so the printed destination
    // cannot drift because somebody typed the wrong digits.
    const unconfirmed = await activate(f, accountId, { expectedVersion: 2 });
    assert.equal(unconfirmed.status, 409, JSON.stringify(unconfirmed.body));
    assert.equal(unconfirmed.body.error.code, 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONFIRMATION_REQUIRED');
    assert.ok(!JSON.stringify(unconfirmed.body).includes(originalNumber));
    assert.equal((await resolveHandymanDocumentBankAccountSnapshot(f.client.id, 'IDR')).version, 1);

    const authorized = await activate(f, accountId, {
      expectedVersion: 2,
      confirmAccountNumber: '1370-0009-88877',
    });
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
    assert.equal(authorized.body.data.version, 2);
    assert.equal(authorized.body.data.isDefault, true);
    assert.equal(await defaultCount(f.client.id), 1);
    const moved = await resolveHandymanDocumentBankAccountSnapshot(f.client.id, 'IDR');
    assert.equal(moved.accountNumber, '1370-0009-88877');
    assert.notEqual(moved.payloadChecksum, pinned.payloadChecksum);
    assert.equal(pinned.accountNumber, originalNumber, 'the pinned snapshot did not move');

    const history = await api()
      .get(`${base(f)}/${accountId}/history?limit=10`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.data[0].version, 2);
    assert.equal(history.body.data[0].isLatestVersion, true);
    assert.equal(history.body.data[1].version, 1);
    assert.equal(history.body.data[1].status, 'SUPERSEDED');
    assert.ok(history.body.data[1].supersededAt);
    assert.equal('accountNumber' in (history.body.data[1] as object), false);

    // Even SQL cannot rewrite what a document already cited.
    const firstRow = await q<{ id: string }>(
      `SELECT id FROM handyman_document_issuer_bank_accounts
        WHERE bank_account_id = $1 AND version = 1`,
      [accountId],
    );
    const v1 = firstRow[0]!.id;
    assert.match(
      await messageOf(() =>
        q(`UPDATE handyman_document_issuer_bank_accounts SET account_number = '9' WHERE id = $1`, [
          v1,
        ]),
      ),
      /immutable history/,
    );
    assert.match(
      await messageOf(() =>
        q(`UPDATE handyman_document_issuer_bank_accounts SET status = 'ACTIVE' WHERE id = $1`, [v1]),
      ),
      /cannot be reopened/,
    );
    assert.match(
      await messageOf(() => q(`DELETE FROM handyman_document_issuer_bank_accounts WHERE id = $1`, [v1])),
      /cannot be deleted/,
    );
    // An unverified draft cannot stamp its own verification: only the
    // lifecycle projections are permitted.
    const draftId = await createAccountId(f, {
      bankCode: 'BCA',
      bankName: 'PT Bank Central Asia Tbk',
      accountNumber: '1230007777',
    });
    const draftRow = await q<{ id: string }>(
      `SELECT id FROM handyman_document_issuer_bank_accounts WHERE bank_account_id = $1`,
      [draftId],
    );
    assert.match(
      await messageOf(() =>
        q(
          `UPDATE handyman_document_issuer_bank_accounts
              SET verified_at = NOW(), verified_by_user_id = created_by_user_id
            WHERE id = $1`,
          [draftRow[0]!.id],
        ),
      ),
      /lifecycle contract/,
    );
  });

  it('holds exactly one default per provider and currency, in the DB too', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const accountId = await createAccountId(f);
    assert.equal((await activate(f, accountId)).status, 200);

    const otherId = await createAccountId(f, {
      bankCode: 'BNI',
      bankName: 'PT Bank Negara Indonesia (Persero) Tbk',
      accountNumber: '0100001111111',
    });
    const clash = await activate(f, otherId, { confirmAccountNumber: '0100001111111' });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal(clash.body.error.code, 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_DEFAULT_TAKEN');
    assert.equal(await defaultCount(f.client.id), 1);

    // The database itself refuses a second default: the index, not the service,
    // is the last line of defence.
    const indexError = await errorCodeOf(() =>
      q(
        `INSERT INTO handyman_document_issuer_bank_accounts
           (id, client_id, bank_account_id, version, bank_code, bank_name, account_number,
            account_holder_name, currency, status, is_default, verification_reference,
            verified_at, verified_by_user_id, created_by_user_id)
         SELECT gen_random_uuid(), $1, gen_random_uuid(), 1, 'BJTM', 'PT Bank Jago Tbk',
                '9900001111', 'PT Asendra Layanan Prima', 'IDR', 'ACTIVE', TRUE,
                'bypass attempt', NOW(), $2, $2`,
        [f.client.id, adminId],
      ),
    );
    assert.equal(indexError, '23505', 'one default per provider+currency is a DB invariant');

    // A currency this provider may not transact in is refused by the platform's
    // own monetary-context contract.
    const wrongCurrency = await createAccount(f, { currency: 'USD' });
    assert.equal(wrongCurrency.status, 400, JSON.stringify(wrongCurrency.body));
    assert.equal(wrongCurrency.body.error.code, 'CLIENT_CURRENCY_NOT_ALLOWED');

    // Deactivating the default needs its own confirmation, because it leaves the
    // currency with no destination at all.
    const unconfirmed = await deactivate(f, accountId, { expectedVersion: 1 });
    assert.equal(unconfirmed.status, 409, JSON.stringify(unconfirmed.body));
    assert.equal(unconfirmed.body.error.code, 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONFIRMATION_REQUIRED');
    assert.equal(await defaultCount(f.client.id), 1, 'the refusal changed nothing');

    const confirmed = await deactivate(f, accountId, {
      expectedVersion: 1,
      confirmLossOfDefault: true,
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.status, 'SUSPENDED');
    assert.equal(confirmed.body.data.isDefault, false);
    assert.ok(confirmed.body.data.deactivatedAt);
    assert.equal(await defaultCount(f.client.id), 0);

    // Fail closed: an unverified or absent destination is never replaced by an
    // invented payment instruction.
    assert.equal(
      await errorCodeOf(() => resolveHandymanDocumentBankAccountSnapshot(f.client.id, 'IDR')),
      'HANDYMAN_DOCUMENT_BANK_ACCOUNT_NOT_FOUND',
    );
    assert.equal(
      await errorCodeOf(() => resolveHandymanDocumentBankAccountSnapshot(f.siblingClient.id, 'IDR')),
      'HANDYMAN_DOCUMENT_BANK_ACCOUNT_NOT_FOUND',
    );
    // A suspended account can be re-activated with the same confirmation, and
    // it keeps the verification it already had.
    const revived = await activate(f, accountId, { asDefault: true });
    assert.equal(revived.status, 200, JSON.stringify(revived.body));
    assert.equal(revived.body.data.status, 'ACTIVE');
    assert.equal(revived.body.data.isDefault, true);
    assert.equal(await defaultCount(f.client.id), 1);
  });

  it('masks the account number in every read, error and audit row', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const secret = '7781234567890';
    const bodies: string[] = [];
    const capture = (response: { body: unknown }) => {
      bodies.push(JSON.stringify(response.body));
      return response;
    };

    const created = capture(await createAccount(f, { accountNumber: secret }));
    const accountId = created.body.data.bankAccountId as string;
    bodies.push(
      JSON.stringify(capture(await activate(f, accountId, { confirmAccountNumber: secret })).body),
    );
    // a malformed number and a stale version, both refused loudly
    bodies.push(
      JSON.stringify((await createAccount(f, { accountNumber: '!!bad!!number' })).body),
    );
    bodies.push(
      JSON.stringify((await deactivate(f, accountId, { expectedVersion: 999 })).body),
    );
    bodies.push(
      JSON.stringify((await readOne(f, accountId)).body),
    );
    bodies.push(JSON.stringify((await api().get(base(f)).set({ Authorization: `Bearer ${f.manager.token}` })).body));
    bodies.push(
      JSON.stringify(
        (
          await api()
            .get(`${base(f)}/${accountId}/history`)
            .set({ Authorization: `Bearer ${f.manager.token}` })
        ).body,
      ),
    );
    for (const body of bodies) {
      assert.ok(!body.includes(secret), `a response body leaked the account number: ${body}`);
    }
    assert.ok(
      bodies.some((body) => body.includes(maskHandymanDocumentAccountNumber(secret))),
      'reads still identify WHICH account is meant',
    );

    const events = await q<{ event_type: string; summary: string; metadata: string }>(
      `SELECT event_type, summary, metadata::text AS metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_DOCUMENT_BANK_ACCOUNT' AND client_id = $1
        ORDER BY event_type`,
      [f.client.id],
    );
    assert.deepEqual(
      events.map((row) => row.event_type),
      ['HANDYMAN_DOCUMENT_BANK_ACCOUNT_ACTIVATED', 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_CREATED'],
    );
    for (const row of events) {
      assert.ok(!row.metadata.includes(secret), 'the audit metadata never carries the number');
      assert.ok(!row.summary.includes(secret), 'the audit summary never carries the number');
    }
    for (const row of events) {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      assert.equal(metadata.accountNumberMasked, maskHandymanDocumentAccountNumber(secret));
      assert.match(String(metadata.payloadChecksum), /^[0-9a-f]{64}$/);
    }

    // And the stored snapshot of the resolver is the only place the number
    // exists outside the table - never a log line built from a response.
    const snapshot = await resolveHandymanDocumentBankAccountSnapshot(f.client.id, 'IDR');
    assert.equal(snapshot.accountNumber, secret);
    assert.equal(snapshot.accountNumberMasked, maskHandymanDocumentAccountNumber(secret));
  });

  it('is a Manager act inside the provider scope, and cannot be self-escalated', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();

    for (const [label, actor] of [
      ['Customer Care', f.care],
      ['Tenant PIC with tenant_company.manage', f.tenantSide],
    ] as const) {
      const write = await createAccount(f, {}, actor.token);
      assert.equal(write.status, 403, `${label}: ${JSON.stringify(write.body)}`);
      assert.equal(write.body.error.code, 'PERMISSION_DENIED', label);
      const read = await api()
        .get(base(f))
        .set({ Authorization: `Bearer ${actor.token}` });
      assert.equal(read.status, 403, `${label} read`);
      // a tenant cannot even try to redirect what it owes
      const sneak = await api()
        .post(`${base(f)}/${randomUUID()}/activate`)
        .set({ Authorization: `Bearer ${actor.token}` })
        .send({ expectedVersion: 1, confirmAccountNumber: '1', verificationReference: 'x' });
      assert.equal(sneak.status, 403, `${label} activation`);
    }

    const outOfScope = await createAccount(f, {}, f.siblingManager.token);
    assert.equal(outOfScope.status, 403, JSON.stringify(outOfScope.body));
    assert.equal(outOfScope.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The same actor IS authorized for their own provider.
    const own = await api()
      .post(`${V1}/handyman/clients/${f.siblingClient.id}/document-bank-accounts`)
      .set({ Authorization: `Bearer ${f.siblingManager.token}` })
      .send({ ...ACCOUNT, bankCode: 'BNI', accountNumber: '0100002222222' });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.data.clientId, f.siblingClient.id);

    // No body anywhere can declare a verification: the privileged vocabulary is
    // simply not writable.
    for (const privileged of ['status', 'isDefault', 'verifiedAt', 'verifiedByUserId', 'clientId']) {
      const response = await createAccount(f, { [privileged]: 'ACTIVE' });
      assert.equal(response.status, 400, `${privileged}: ${JSON.stringify(response.body)}`);
      assert.ok(
        (response.body.error.details as { field: string }[]).some(
          (detail) => detail.field === privileged,
        ),
        `${privileged} must be named as unsupported`,
      );
    }
    assert.equal(await defaultCount(f.client.id), 0, 'no escalation wrote anything');

    // A foreign account id under a valid provider reads as absent, so no
    // cross-provider existence is leaked.
    const foreign = await readOne(f, (own.body.data.bankAccountId as string));
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(foreign.body.error.code, 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_NOT_FOUND');
  });

  it('serializes concurrent writers on one account', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const accountId = await createAccountId(f);

    const [first, second] = await Promise.all([activate(f, accountId), activate(f, accountId)]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([first.body, second.body]));
    assert.equal(
      [first, second].find((response) => response.status === 409)!.body.error.code,
      'HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATE_CONFLICT',
      'the loser is told the state, not blamed for a bug',
    );
    assert.equal(await defaultCount(f.client.id), 1, 'exactly one default survived the race');

    // Two concurrent amendments of the same version: one appends, one is refused
    // because it never read the version it is overwriting.
    const [putA, putB] = await Promise.all([
      api()
        .put(`${base(f)}/${accountId}`)
        .set({ Authorization: `Bearer ${f.manager.token}` })
        .send({ expectedVersion: 1, ...ACCOUNT, bankName: 'PT Bank Mandiri (Persero) Tbk' }),
      api()
        .put(`${base(f)}/${accountId}`)
        .set({ Authorization: `Bearer ${f.manager.token}` })
        .send({ expectedVersion: 1, ...ACCOUNT, bankName: 'PT Bank Mandiri (Persero) Tbk' }),
    ]);
    assert.deepEqual([putA.status, putB.status].sort(), [200, 409]);
    const versions = await q<{ n: string }>(
      `SELECT count(DISTINCT version)::text AS n FROM handyman_document_issuer_bank_accounts
        WHERE bank_account_id = $1`,
      [accountId],
    );
    assert.equal(versions[0]?.n, '2', 'a refused append created no version');

    // The live destination survived the whole race intact, verified once.
    const snapshot = await resolveHandymanDocumentBankAccountSnapshot(f.client.id, 'IDR');
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.bankAccountId, accountId);
    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_bank_accounts
            WHERE bank_account_id = $1 AND status = 'ACTIVE' AND verified_at IS NOT NULL`,
          [accountId],
        )
      )[0].n,
      '1',
      'one verification record for the one verified destination',
    );
  });

  it('refuses incomplete or impossible account input without writing', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ bankCode: undefined }, 'bankCode'],
      [{ bankCode: 'bad code' }, 'bankCode'],
      [{ bankName: '   ' }, 'bankName'],
      [{ accountNumber: undefined }, 'accountNumber'],
      [{ accountNumber: '12' }, 'accountNumber'],
      [{ accountNumber: 'abcd-efgh' }, 'accountNumber'],
      [{ accountHolderName: '///' }, 'accountHolderName'],
      [{ currency: 'Rupiah' }, 'currency'],
      [{ currency: undefined }, 'currency'],
      [{ bankName: 'x'.repeat(201) }, 'bankName'],
      [{ accountNumber: '9'.repeat(35) }, 'accountNumber'],
    ];
    for (const [override, field] of cases) {
      const response = await createAccount(f, override);
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
      assert.ok(
        (response.body.error.details as { field: string }[]).some(
          (detail) => detail.field === field,
        ),
        `${field} must be named in the details`,
      );
    }
    const noBody = await api()
      .post(base(f))
      .set({ Authorization: `Bearer ${f.manager.token}` })
      .send({});
    assert.equal(noBody.status, 400);
    const badParam = await api()
      .get(`${V1}/handyman/clients/not-a-uuid/document-bank-accounts`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(badParam.status, 400);
    const badQuery = await api()
      .get(`${base(f)}?status=ACTIVE&limit=999`)
      .set({ Authorization: `Bearer ${f.manager.token}` });
    assert.equal(badQuery.status, 400, JSON.stringify(badQuery.body));

    assert.equal(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM handyman_document_issuer_bank_accounts WHERE client_id = $1`,
          [f.client.id],
        )
      )[0].n,
      '0',
      'a refused write creates no row',
    );
  });

  it('records the audit trail and version metadata for every state change', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createRealmFixture();
    const accountId = await createAccountId(f);
    await activate(f, accountId);
    await deactivate(f, accountId, { expectedVersion: 1, confirmLossOfDefault: true });
    await api()
      .put(`${base(f)}/${accountId}`)
      .set({ Authorization: `Bearer ${f.manager.token}` })
      .send({ expectedVersion: 1, ...ACCOUNT, accountHolderName: 'PT Asendra Prima Layanan' });

    const events = await q<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM operational_events
        WHERE entity_type = 'HANDYMAN_DOCUMENT_BANK_ACCOUNT' AND entity_id = $1
        ORDER BY created_at, event_type`,
      [accountId],
    );
    assert.deepEqual(
      events.map((row) => row.event_type).sort(),
      [
        'HANDYMAN_DOCUMENT_BANK_ACCOUNT_ACTIVATED',
        'HANDYMAN_DOCUMENT_BANK_ACCOUNT_CREATED',
        'HANDYMAN_DOCUMENT_BANK_ACCOUNT_DEACTIVATED',
        'HANDYMAN_DOCUMENT_BANK_ACCOUNT_UPDATED',
      ].sort(),
      'every state change is journalled',
    );
    const byType = new Map(events.map((row) => [row.event_type, row]));
    const orderOf = (type: string) =>
      events.findIndex((row) => row.event_type === type);
    assert.ok(
      orderOf('HANDYMAN_DOCUMENT_BANK_ACCOUNT_CREATED')
        < orderOf('HANDYMAN_DOCUMENT_BANK_ACCOUNT_ACTIVATED'),
      'creation is journalled before the verification that followed it',
    );
    const activated = byType.get('HANDYMAN_DOCUMENT_BANK_ACCOUNT_ACTIVATED')!.metadata as Record<string, unknown>;
    assert.equal(activated.version, 1);
    assert.equal(activated.isDefault, true);
    assert.equal(activated.currency, 'IDR');
    assert.equal(activated.confirmation, 'MATCHED');
    assert.equal(activated.replacedBankAccountId, null);
    assert.match(String(activated.accountNumberMasked), /^\*{4}\S{1,4}$/);
    const deactivated = byType.get('HANDYMAN_DOCUMENT_BANK_ACCOUNT_DEACTIVATED')!.metadata as Record<string, unknown>;
    assert.equal(deactivated.wasDefault, true);
    assert.equal(deactivated.reason, 'Account closed by the bank');
    const updated = byType.get('HANDYMAN_DOCUMENT_BANK_ACCOUNT_UPDATED')!.metadata as Record<string, unknown>;
    assert.deepEqual(updated.changedFields, ['accountHolderName']);
    assert.equal(updated.previousVersion, 1);
    assert.equal(updated.requiresVerification, true);

    // The version metadata is real: one chain, two rows, and only the amended
    // column differs between them.
    const chain = await q<{
      version: string;
      holder: string;
      number: string;
      bank_name: string;
      status: string;
    }>(
      `SELECT version::text,
              account_holder_name AS holder,
              account_number AS number,
              bank_name,
              status
         FROM handyman_document_issuer_bank_accounts
        WHERE bank_account_id = $1
        ORDER BY version`,
      [accountId],
    );
    assert.equal(chain.length, 2);
    assert.equal(chain[0]?.holder, 'PT Asendra Layanan Prima', 'v1 keeps what it said');
    assert.equal(chain[1]?.holder, 'PT Asendra Prima Layanan');
    assert.equal(chain[0]?.number, chain[1]?.number, 'nothing else moved');
    assert.equal(chain[0]?.bank_name, chain[1]?.bank_name);
    assert.equal(chain[1]?.status, 'PENDING_VERIFICATION');
  });
});
