import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { resolveExpiryStatus } from '../src/modules/vendor-licenses';
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';

const FUTURE = '2030-12-31T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, clients, vendors, vendor_compliance_documents,
      vendor_licenses_certifications CASCADE`,
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

async function createVendorVia() {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'License Test Client',
  });
  const response = await api()
    .post(`/api/v1/clients/${client.id}/vendors`)
    .set(authHeaders())
    .send({
      vendorCode: `VND_${randomUUID().slice(0, 8).toUpperCase()}`,
      vendorName: 'License Test Vendor',
    });
  assert.equal(response.status, 201);
  return response.body.data as { id: string; clientId: string };
}

async function createComplianceDocumentVia(vendorId: string) {
  const response = await api()
    .post(`/api/v1/vendors/${vendorId}/compliance-documents`)
    .set(authHeaders())
    .send({
      documentType: 'BUSINESS_LICENSE',
      documentNumber: `DOC-${randomUUID().slice(0, 8).toUpperCase()}`,
      documentName: 'Supporting Document',
      fileReference: 'storage://compliance/support.pdf',
    });
  assert.equal(response.status, 201);
  return response.body.data as { id: string; vendorId: string };
}

function licensePayload(overrides: Record<string, unknown> = {}) {
  return {
    recordType: 'LICENSE',
    name: 'Electrical Installation License',
    number: `LIC-${randomUUID().slice(0, 8).toUpperCase()}`,
    issuingAuthority: 'Ministry of Energy',
    issueDate: '2025-01-15T00:00:00.000Z',
    expiryDate: FUTURE,
    notes: 'Renewable every 5 years.',
    ...overrides,
  };
}

async function createRecordVia(
  vendorId: string,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/licenses-certifications`)
    .set(authHeaders())
    .send(licensePayload(overrides));
}

const PUBLIC_RECORD_KEYS = [
  'documentReference',
  'expiryDate',
  'expiryStatus',
  'id',
  'issueDate',
  'issuingAuthority',
  'name',
  'notes',
  'number',
  'recordType',
  'status',
  'vendorId',
];

describe('resolveExpiryStatus', () => {
  it('resolves VALID, EXPIRED, and NOT_APPLICABLE', () => {
    const asOf = new Date('2026-06-01T00:00:00.000Z');
    assert.equal(
      resolveExpiryStatus({ expiryDate: new Date(FUTURE) }, asOf),
      'VALID',
    );
    assert.equal(
      resolveExpiryStatus({ expiryDate: new Date(PAST) }, asOf),
      'EXPIRED',
    );
    assert.equal(resolveExpiryStatus({ expiryDate: null }, asOf), 'NOT_APPLICABLE');
  });
});

describe('POST /api/v1/vendors/:vendorId/licenses-certifications', () => {
  it('creates a LICENSE record', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createRecordVia(vendor.id);

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.recordType, 'LICENSE');
    assert.equal(response.body.data.name, 'Electrical Installation License');
    assert.equal(response.body.data.issuingAuthority, 'Ministry of Energy');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.expiryStatus, 'VALID');
    assert.equal(response.body.data.documentReference, null);
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_RECORD_KEYS);
  });

  it('creates a CERTIFICATION record without an expiry date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createRecordVia(vendor.id, {
      recordType: 'CERTIFICATION',
      name: 'ISO 9001',
      issueDate: undefined,
      expiryDate: undefined,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.recordType, 'CERTIFICATION');
    assert.equal(response.body.data.expiryDate, null);
    assert.equal(response.body.data.expiryStatus, 'NOT_APPLICABLE');
  });

  it('links a record to an existing BE-06G compliance document', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const document = await createComplianceDocumentVia(vendor.id);

    const response = await createRecordVia(vendor.id, {
      documentReference: document.id,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.documentReference, document.id);

    // The reference can be cleared back to null.
    const cleared = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${response.body.data.id}`,
      )
      .set(authHeaders())
      .send({ documentReference: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.documentReference, null);
  });

  it('rejects an unknown compliance document reference', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createRecordVia(vendor.id, {
      documentReference: randomUUID(),
    });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_NOT_FOUND',
    );
  });

  it("rejects another vendor's compliance document (isolation through the reference)", async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();
    const foreignDocument = await createComplianceDocumentVia(vendorB.id);

    const response = await createRecordVia(vendorA.id, {
      documentReference: foreignDocument.id,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_LICENSE_CERTIFICATION_DOCUMENT_MISMATCH',
    );
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createRecordVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects an invalid date range', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createRecordVia(vendor.id, {
      issueDate: '2026-06-01T00:00:00.000Z',
      expiryDate: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an ACTIVE record with a past expiry date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createRecordVia(vendor.id, {
      issueDate: '2019-01-01T00:00:00.000Z',
      expiryDate: PAST,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_LICENSE_CERTIFICATION_STATUS_DATE_MISMATCH',
    );
  });

  it('accepts an EXPIRED historical record with a past expiry date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createRecordVia(vendor.id, {
      issueDate: '2019-01-01T00:00:00.000Z',
      expiryDate: PAST,
      status: 'EXPIRED',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.status, 'EXPIRED');
    assert.equal(response.body.data.expiryStatus, 'EXPIRED');
  });

  it('rejects a duplicate active record (same type and number)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const first = await createRecordVia(vendor.id, { number: 'LIC-SAME' });
    assert.equal(first.status, 201);

    const duplicate = await createRecordVia(vendor.id, { number: 'LIC-SAME' });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'VENDOR_LICENSE_CERTIFICATION_ALREADY_ACTIVE',
    );

    // A CERTIFICATION with the same number does not conflict with a LICENSE.
    const differentType = await createRecordVia(vendor.id, {
      recordType: 'CERTIFICATION',
      number: 'LIC-SAME',
    });
    assert.equal(differentType.status, 201);
  });

  it('rejects missing required record data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await api()
      .post(`/api/v1/vendors/${vendor.id}/licenses-certifications`)
      .set(authHeaders())
      .send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('recordType'));
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('number'));
  });
});

describe('GET /api/v1/vendors/:vendorId/licenses-certifications', () => {
  it('lists only the records of the requested vendor (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Two vendors under two different clients.
    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();

    await createRecordVia(vendorA.id, { number: 'REC-A1' });
    await createRecordVia(vendorA.id, {
      recordType: 'CERTIFICATION',
      number: 'REC-A2',
    });
    await createRecordVia(vendorB.id, { number: 'REC-B1' });

    const response = await api()
      .get(`/api/v1/vendors/${vendorA.id}/licenses-certifications`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const numbers = response.body.data.map((r: { number: string }) => r.number);
    assert.deepEqual(numbers.sort(), ['REC-A1', 'REC-A2']);
    for (const record of response.body.data) {
      assert.equal(record.vendorId, vendorA.id);
    }
  });

  it('returns 404 for an unknown vendor rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendors/${randomUUID()}/licenses-certifications`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });
});

describe('GET /api/v1/vendors/:vendorId/licenses-certifications/current', () => {
  it('returns only effective records (ACTIVE and not past expiry)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();

    // Effective: ACTIVE with future expiry.
    const current = await createRecordVia(vendor.id, { number: 'CUR-1' });
    assert.equal(current.status, 201);
    // Effective: ACTIVE with no expiry.
    const undated = await createRecordVia(vendor.id, {
      recordType: 'CERTIFICATION',
      number: 'CUR-2',
      issueDate: undefined,
      expiryDate: undefined,
    });
    assert.equal(undated.status, 201);
    // Not effective: EXPIRED history.
    const expired = await createRecordVia(vendor.id, {
      number: 'OLD-1',
      issueDate: '2019-01-01T00:00:00.000Z',
      expiryDate: PAST,
      status: 'EXPIRED',
    });
    assert.equal(expired.status, 201);
    // Not effective: INACTIVE (withdrawn).
    const withdrawn = await createRecordVia(vendor.id, { number: 'OLD-2' });
    await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${withdrawn.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    // Not effective: stored ACTIVE but expiry already past (slipped by
    // without a scheduler) — dropped from /current at read time.
    await pool!.query(
      `UPDATE vendor_licenses_certifications
       SET issue_date = $2, expiry_date = $3
       WHERE id = $1`,
      [
        current.body.data.id,
        new Date('2019-06-01T00:00:00.000Z'),
        new Date('2020-06-01T00:00:00.000Z'),
      ],
    );

    const response = await api()
      .get(`/api/v1/vendors/${vendor.id}/licenses-certifications/current`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const numbers = response.body.data.map((r: { number: string }) => r.number);
    assert.deepEqual(numbers, ['CUR-2']);
    assert.equal(response.body.data[0].expiryStatus, 'NOT_APPLICABLE');

    // The full list still shows all four records with resolved statuses.
    const full = await api()
      .get(`/api/v1/vendors/${vendor.id}/licenses-certifications`)
      .set(authHeaders());
    assert.equal(full.body.data.length, 4);
    const slipped = full.body.data.find(
      (r: { number: string }) => r.number === 'CUR-1',
    );
    assert.equal(slipped.status, 'ACTIVE');
    assert.equal(slipped.expiryStatus, 'EXPIRED');
  });
});

describe('PATCH /api/v1/vendors/:vendorId/licenses-certifications/:id', () => {
  it('updates record metadata', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createRecordVia(vendor.id);

    const response = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({
        name: 'Electrical Installation License (Class A)',
        issuingAuthority: null,
        notes: null,
      });

    assert.equal(response.status, 200);
    assert.equal(
      response.body.data.name,
      'Electrical Installation License (Class A)',
    );
    assert.equal(response.body.data.issuingAuthority, null);
    assert.equal(response.body.data.notes, null);
    assert.equal(response.body.data.number, created.body.data.number);
  });

  it('marks a record EXPIRED once dates justify it; the row remains historical', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createRecordVia(vendor.id);

    const response = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({
        status: 'EXPIRED',
        issueDate: '2019-01-01T00:00:00.000Z',
        expiryDate: PAST,
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'EXPIRED');
    assert.equal(response.body.data.expiryStatus, 'EXPIRED');

    // Still present in the historical list.
    const list = await api()
      .get(`/api/v1/vendors/${vendor.id}/licenses-certifications`)
      .set(authHeaders());
    assert.equal(list.body.data.length, 1);
  });

  it('rejects EXPIRED status while the expiry date is still in the future', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createRecordVia(vendor.id);

    const response = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'EXPIRED' });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_LICENSE_CERTIFICATION_STATUS_DATE_MISMATCH',
    );
  });

  it('deactivates a record and allows an active replacement', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createRecordVia(vendor.id, { number: 'LIC-REPLACE' });

    const deactivated = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const replacement = await createRecordVia(vendor.id, {
      number: 'LIC-REPLACE',
    });
    assert.equal(replacement.status, 201);

    // Reactivating the old row now conflicts with the replacement.
    const reactivate = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivate.status, 409);
    assert.equal(
      reactivate.body.error.code,
      'VENDOR_LICENSE_CERTIFICATION_ALREADY_ACTIVE',
    );
  });

  it('rejects updating immutable vendorId / recordType', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createRecordVia(vendor.id);

    const typeChange = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ recordType: 'CERTIFICATION' });
    assert.equal(typeChange.status, 400);
    assert.equal(typeChange.body.error.code, 'VALIDATION_ERROR');

    const vendorChange = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ vendorId: randomUUID() });
    assert.equal(vendorChange.status, 400);
    assert.equal(vendorChange.body.error.code, 'VALIDATION_ERROR');
  });

  it("404s when the record belongs to a different vendor (no owner leak)", async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();
    const recordB = await createRecordVia(vendorB.id);

    const response = await api()
      .patch(
        `/api/v1/vendors/${vendorA.id}/licenses-certifications/${recordB.body.data.id}`,
      )
      .set(authHeaders())
      .send({ name: 'Hijacked' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_LICENSE_CERTIFICATION_NOT_FOUND',
    );
  });

  it('returns 404 for an unknown record', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${randomUUID()}`,
      )
      .set(authHeaders())
      .send({ name: 'Ghost Record' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_LICENSE_CERTIFICATION_NOT_FOUND',
    );
  });
});

describe('BE-06H scope boundary', () => {
  it('references BE-06G documents without duplicating storage and adds no workflow tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // document_reference is a UUID FK to vendor_compliance_documents — no
    // file columns of its own, and no binary columns anywhere.
    const columns = await pool!.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'vendor_licenses_certifications'`,
    );
    const names = columns.rows.map((c) => c.column_name);
    assert.ok(names.includes('document_reference'));
    assert.ok(!names.includes('file_reference'));
    assert.ok(!columns.rows.some((c) => c.data_type === 'bytea'));

    const fk = await pool!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'vendor_licenses_certifications_document_reference_fkey'
       ) AS exists`,
    );
    assert.equal(fk.rows[0]?.exists, true);

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tableNames = tables.rows.map((row) => row.tablename);
    assert.ok(tableNames.includes('vendor_licenses_certifications'));
    for (const forbidden of [
      'license_renewals',
      'expiry_notifications',
      'compliance_approvals',
      'procurements',
      'invoices',
      'vendor_portal_sessions',
      // `work_orders` is owned by BE-08B (now present by design).
      'maintenance_tasks',
    ]) {
      assert.ok(!tableNames.includes(forbidden), `${forbidden} must not exist`);
    }
  });
});

describe('vendor license RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/vendors/${randomUUID()}/licenses-certifications`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const vendor = await createVendorVia();

    const read = await api()
      .get(`/api/v1/vendors/${vendor.id}/licenses-certifications`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const current = await api()
      .get(`/api/v1/vendors/${vendor.id}/licenses-certifications/current`)
      .set(authHeaders(plainToken));
    assert.equal(current.status, 403);
    assert.equal(current.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/vendors/${vendor.id}/licenses-certifications`)
      .set(authHeaders(plainToken))
      .send(licensePayload());
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/licenses-certifications/${randomUUID()}`,
      )
      .set(authHeaders(plainToken))
      .send({ name: 'Denied' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});
