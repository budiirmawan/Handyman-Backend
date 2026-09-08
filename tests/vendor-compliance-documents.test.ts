import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import {
  isValidDocumentType,
  normalizeDocumentType,
} from '../src/modules/vendor-compliance-documents';
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
    'TRUNCATE users, roles, clients, vendors, vendor_compliance_documents CASCADE',
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
    name: 'Compliance Test Client',
  });
  const response = await api()
    .post(`/api/v1/clients/${client.id}/vendors`)
    .set(authHeaders())
    .send({
      vendorCode: `VND_${randomUUID().slice(0, 8).toUpperCase()}`,
      vendorName: 'Compliance Test Vendor',
    });
  assert.equal(response.status, 201);
  return response.body.data as { id: string; clientId: string };
}

function documentPayload(overrides: Record<string, unknown> = {}) {
  return {
    documentType: 'BUSINESS_LICENSE',
    documentNumber: `NIB-${randomUUID().slice(0, 8).toUpperCase()}`,
    documentName: 'Nomor Induk Berusaha',
    issueDate: '2025-01-15T00:00:00.000Z',
    expiryDate: FUTURE,
    fileReference: 'storage://compliance/nib-2025.pdf',
    notes: 'Issued by OSS.',
    ...overrides,
  };
}

async function createDocumentVia(
  vendorId: string,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/compliance-documents`)
    .set(authHeaders())
    .send(documentPayload(overrides));
}

const PUBLIC_DOCUMENT_KEYS = [
  'documentName',
  'documentNumber',
  'documentType',
  'expiryDate',
  'fileReference',
  'id',
  'issueDate',
  'notes',
  'status',
  'vendorId',
];

describe('document type normalization', () => {
  it('trims and uppercases document types', () => {
    assert.equal(normalizeDocumentType('  business_license '), 'BUSINESS_LICENSE');
  });

  it('validates document type shape', () => {
    assert.equal(isValidDocumentType('TAX_CLEARANCE'), true);
    assert.equal(isValidDocumentType('T'), false);
    assert.equal(isValidDocumentType('1TAX'), false);
    assert.equal(isValidDocumentType('TAX CLEARANCE'), false);
  });
});

describe('POST /api/v1/vendors/:vendorId/compliance-documents', () => {
  it('creates a compliance document with metadata and file reference', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createDocumentVia(vendor.id, {
      documentType: 'business_license',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.documentType, 'BUSINESS_LICENSE');
    assert.equal(response.body.data.documentName, 'Nomor Induk Berusaha');
    assert.equal(
      response.body.data.fileReference,
      'storage://compliance/nib-2025.pdf',
    );
    assert.equal(response.body.data.notes, 'Issued by OSS.');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.issueDate);
    assert.ok(response.body.data.expiryDate);
    assert.ok(response.body.data.id);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_DOCUMENT_KEYS,
    );
  });

  it('creates a minimal document without dates or file reference', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await api()
      .post(`/api/v1/vendors/${vendor.id}/compliance-documents`)
      .set(authHeaders())
      .send({
        documentType: 'TAX_CLEARANCE',
        documentNumber: 'SKF-001',
        documentName: 'Surat Keterangan Fiskal',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.issueDate, null);
    assert.equal(response.body.data.expiryDate, null);
    assert.equal(response.body.data.fileReference, null);
    assert.equal(response.body.data.notes, null);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createDocumentVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects an invalid date range', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createDocumentVia(vendor.id, {
      issueDate: '2026-06-01T00:00:00.000Z',
      expiryDate: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an ACTIVE document with a past expiry date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createDocumentVia(vendor.id, {
      issueDate: '2019-01-01T00:00:00.000Z',
      expiryDate: PAST,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_STATUS_DATE_MISMATCH',
    );
  });

  it('accepts an EXPIRED document with a past expiry date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createDocumentVia(vendor.id, {
      issueDate: '2019-01-01T00:00:00.000Z',
      expiryDate: PAST,
      status: 'EXPIRED',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.status, 'EXPIRED');
  });

  it('rejects an EXPIRED document without a past expiry date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createDocumentVia(vendor.id, {
      status: 'EXPIRED',
      expiryDate: FUTURE,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_STATUS_DATE_MISMATCH',
    );
  });

  it('rejects a conflicting active document (same type and number)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const first = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-SAME',
    });
    assert.equal(first.status, 201);

    const duplicate = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-SAME',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_ALREADY_ACTIVE',
    );
  });

  it('allows historical rows for the same type and number', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const expired = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-HIST',
      issueDate: '2019-01-01T00:00:00.000Z',
      expiryDate: PAST,
      status: 'EXPIRED',
    });
    assert.equal(expired.status, 201);

    // The renewal (same type/number) can be ACTIVE alongside the history.
    const renewal = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-HIST',
    });
    assert.equal(renewal.status, 201);

    const list = await api()
      .get(`/api/v1/vendors/${vendor.id}/compliance-documents`)
      .set(authHeaders());
    assert.equal(
      list.body.data.filter(
        (d: { documentNumber: string }) => d.documentNumber === 'NIB-HIST',
      ).length,
      2,
    );
  });

  it('rejects missing required document data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await api()
      .post(`/api/v1/vendors/${vendor.id}/compliance-documents`)
      .set(authHeaders())
      .send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('documentType'));
    assert.ok(fields.includes('documentNumber'));
    assert.ok(fields.includes('documentName'));
  });
});

describe('GET /api/v1/vendor-compliance-documents/:id', () => {
  it('returns a document by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createDocumentVia(vendor.id);

    const response = await api()
      .get(`/api/v1/vendor-compliance-documents/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.vendorId, vendor.id);
  });

  it('returns 404 for an unknown document', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendor-compliance-documents/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_NOT_FOUND',
    );
  });
});

describe('GET /api/v1/vendors/:vendorId/compliance-documents', () => {
  it('lists only the documents of the requested vendor (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Two vendors under two different clients.
    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();

    await createDocumentVia(vendorA.id, { documentNumber: 'DOC-A1' });
    await createDocumentVia(vendorA.id, { documentNumber: 'DOC-A2' });
    await createDocumentVia(vendorB.id, { documentNumber: 'DOC-B1' });

    const response = await api()
      .get(`/api/v1/vendors/${vendorA.id}/compliance-documents`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const numbers = response.body.data.map(
      (d: { documentNumber: string }) => d.documentNumber,
    );
    assert.deepEqual(numbers, ['DOC-A1', 'DOC-A2']);
    for (const document of response.body.data) {
      assert.equal(document.vendorId, vendorA.id);
    }
  });

  it('returns 404 for an unknown vendor rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendors/${randomUUID()}/compliance-documents`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });
});

describe('PATCH /api/v1/vendor-compliance-documents/:id', () => {
  it('updates document metadata', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createDocumentVia(vendor.id);

    const response = await api()
      .patch(`/api/v1/vendor-compliance-documents/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        documentName: 'NIB (Renewed)',
        fileReference: 'storage://compliance/nib-renewed.pdf',
        notes: null,
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.documentName, 'NIB (Renewed)');
    assert.equal(
      response.body.data.fileReference,
      'storage://compliance/nib-renewed.pdf',
    );
    assert.equal(response.body.data.notes, null);
    assert.equal(
      response.body.data.documentNumber,
      created.body.data.documentNumber,
    );
  });

  it('marks an ACTIVE document EXPIRED once dates justify it', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createDocumentVia(vendor.id);

    const response = await api()
      .patch(`/api/v1/vendor-compliance-documents/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'EXPIRED', expiryDate: PAST, issueDate: '2019-01-01T00:00:00.000Z' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'EXPIRED');
  });

  it('rejects EXPIRED status while the expiry date is still in the future', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createDocumentVia(vendor.id);

    const response = await api()
      .patch(`/api/v1/vendor-compliance-documents/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'EXPIRED' });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_STATUS_DATE_MISMATCH',
    );
  });

  it('rejects a partial update that breaks the stored date range', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createDocumentVia(vendor.id, {
      issueDate: '2026-06-01T00:00:00.000Z',
      expiryDate: FUTURE,
    });

    const response = await api()
      .patch(`/api/v1/vendor-compliance-documents/${created.body.data.id}`)
      .set(authHeaders())
      .send({ expiryDate: '2026-01-01T00:00:00.000Z' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('deactivates a document and allows an active replacement', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-REPLACE',
    });

    const deactivated = await api()
      .patch(`/api/v1/vendor-compliance-documents/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const replacement = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-REPLACE',
    });
    assert.equal(replacement.status, 201);
  });

  it('rejects reactivating a document that would conflict with a newer active one', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const original = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-CONFLICT',
    });
    await api()
      .patch(`/api/v1/vendor-compliance-documents/${original.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    const replacement = await createDocumentVia(vendor.id, {
      documentNumber: 'NIB-CONFLICT',
    });
    assert.equal(replacement.status, 201);

    const response = await api()
      .patch(`/api/v1/vendor-compliance-documents/${original.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });

    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_ALREADY_ACTIVE',
    );
  });

  it('rejects updating the immutable vendorId', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createDocumentVia(vendor.id);

    const response = await api()
      .patch(`/api/v1/vendor-compliance-documents/${created.body.data.id}`)
      .set(authHeaders())
      .send({ vendorId: randomUUID() });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown document', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/vendor-compliance-documents/${randomUUID()}`)
      .set(authHeaders())
      .send({ documentName: 'Ghost Document' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_COMPLIANCE_DOCUMENT_NOT_FOUND',
    );
  });
});

describe('BE-06G scope boundary', () => {
  it('stores metadata only and creates no expiry engine or workflow tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // file_reference is TEXT metadata — verify no binary column exists.
    const columns = await pool!.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'vendor_compliance_documents'`,
    );
    const types = new Map(
      columns.rows.map((c) => [c.column_name, c.data_type]),
    );
    assert.equal(types.get('file_reference'), 'text');
    assert.ok(![...types.values()].includes('bytea'));

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);
    assert.ok(names.includes('vendor_compliance_documents'));
    for (const forbidden of [
      'vendor_licenses',
      'vendor_certifications',
      'compliance_approvals',
      'document_renewals',
      // `work_orders` is owned by BE-08B (now present by design).
      'maintenance_tasks',
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
    }
  });
});

describe('vendor compliance document RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/vendor-compliance-documents/${randomUUID()}`,
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
      .get(`/api/v1/vendors/${vendor.id}/compliance-documents`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/vendors/${vendor.id}/compliance-documents`)
      .set(authHeaders(plainToken))
      .send(documentPayload());
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(`/api/v1/vendor-compliance-documents/${randomUUID()}`)
      .set(authHeaders(plainToken))
      .send({ documentName: 'Denied' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});
