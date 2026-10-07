import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-13E — Visitor Photo / OCR Readiness focused validation.
 *
 * Covers:
 *  - visitor photo reference (safe file reference, no binary)
 *  - identity-document image reference + OCR request
 *  - OCR pending / processed / failed metadata
 *  - staged extracted fields never silently touch the visitor master
 *  - explicit review: APPLY routes through BE-13A (duplicate rules
 *    hold), REJECT never applies, single-shot review
 *  - invalid visitor / file metadata rejected
 *  - soft-remove
 *  - RBAC and Client isolation
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       visitor_photos, walk_in_visits, expected_visitors,
       visitor_invitations, visitors,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Photo client A',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });

  const clientB = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Photo client B',
  });
  const propertyB = await propertyService.createProperty({
    clientId: clientB.id,
    code: `P_${suffix()}`,
    name: 'Property B',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyB.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });

  const visitor = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/visitors`)
      .set(auth())
      .send({ fullName: 'Photo Guest' })
  ).body.data;

  const bAdmin = await createAdminUser();
  await buildingAssignmentService.createAssignment(bAdmin.userId, {
    buildingId: buildingB.id,
  });

  return { clientA, clientB, buildingA, buildingB, visitor, bAdmin };
}

function photoBody(overrides: Record<string, unknown> = {}) {
  return {
    photoType: 'VISITOR_PHOTO',
    fileReference: `s3://asentra-evidence/visitors/${randomUUID()}.jpg`,
    originalFileName: 'guest.jpg',
    mimeType: 'image/jpeg',
    fileSize: 245_000,
    ...overrides,
  };
}

async function attachPhoto(
  visitorId: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/visitors/${visitorId}/photos`)
    .set(auth(token))
    .send(body);
}

describe('BE-13E visitor photo / OCR readiness', () => {
  it('attaches a visitor photo reference (no binary, safe reference)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const capturedAt = new Date().toISOString();
    const response = await attachPhoto(
      f.visitor.id,
      photoBody({ capturedAt }),
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.visitorId, f.visitor.id);
    assert.equal(data.photoType, 'VISITOR_PHOTO');
    assert.ok(data.fileReference.startsWith('s3://'));
    assert.equal(data.mimeType, 'image/jpeg');
    assert.equal(data.fileSize, 245_000);
    assert.equal(data.capturedAt, capturedAt);
    assert.equal(data.ocrStatus, 'NOT_REQUESTED');
    assert.equal(data.reviewStatus, 'UNREVIEWED');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.createdByUserId, managerUserId);
  });

  it('attaches an identity-document image with an OCR request', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await attachPhoto(
      f.visitor.id,
      photoBody({
        photoType: 'IDENTITY_DOCUMENT',
        requestOcr: true,
        ocrProvider: 'external-ocr-service',
      }),
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.photoType, 'IDENTITY_DOCUMENT');
    assert.equal(response.body.data.ocrStatus, 'PENDING');
    assert.equal(response.body.data.ocrProvider, 'external-ocr-service');
    assert.equal(response.body.data.ocrProcessedAt, null);
  });

  it('records PROCESSED and FAILED OCR results as metadata only', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // PROCESSED with staged extracted fields.
    const processedPhoto = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;

    const idNumber = `3177${suffix()}`;
    const processed = await api()
      .post(`/api/v1/visitor-photos/${processedPhoto.id}/ocr-result`)
      .set(auth())
      .send({
        ocrStatus: 'PROCESSED',
        ocrProvider: 'external-ocr-service',
        extractedFullName: 'PHOTO GUEST OCR',
        extractedIdentityType: 'NATIONAL_ID',
        extractedIdentityNumber: idNumber,
      });
    assert.equal(processed.status, 200, JSON.stringify(processed.body));
    assert.equal(processed.body.data.ocrStatus, 'PROCESSED');
    assert.ok(processed.body.data.ocrProcessedAt);
    assert.equal(processed.body.data.extractedFullName, 'PHOTO GUEST OCR');
    assert.equal(processed.body.data.extractedIdentityType, 'NATIONAL_ID');
    assert.equal(processed.body.data.extractedIdentityNumber, idNumber);
    assert.equal(processed.body.data.reviewStatus, 'UNREVIEWED');

    // Staged output did NOT touch the authoritative visitor identity.
    const visitorAfter = await api()
      .get(`/api/v1/visitors/${f.visitor.id}`)
      .set(auth());
    assert.equal(visitorAfter.body.data.fullName, 'Photo Guest');
    assert.equal(visitorAfter.body.data.identityNumber, null);

    // FAILED with error metadata.
    const failedPhoto = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;
    const failed = await api()
      .post(`/api/v1/visitor-photos/${failedPhoto.id}/ocr-result`)
      .set(auth())
      .send({ ocrStatus: 'FAILED', ocrError: 'Document too blurry.' });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.data.ocrStatus, 'FAILED');
    assert.equal(failed.body.data.ocrError, 'Document too blurry.');
    assert.ok(failed.body.data.ocrProcessedAt);

    // Recording a result without an OCR request is rejected.
    const noRequest = (
      await attachPhoto(f.visitor.id, photoBody())
    ).body.data;
    const rejected = await api()
      .post(`/api/v1/visitor-photos/${noRequest.id}/ocr-result`)
      .set(auth())
      .send({ ocrStatus: 'PROCESSED', extractedFullName: 'X' });
    assert.equal(rejected.status, 409);
    assert.equal(
      rejected.body.error.code,
      'VISITOR_PHOTO_OCR_NOT_REQUESTED',
    );
  });

  it('applies reviewed OCR output to the visitor through BE-13A', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const photo = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;

    const idNumber = `3178${suffix()}`;
    await api()
      .post(`/api/v1/visitor-photos/${photo.id}/ocr-result`)
      .set(auth())
      .send({
        ocrStatus: 'PROCESSED',
        extractedFullName: 'Photo Guest Verified',
        extractedIdentityType: 'NATIONAL_ID',
        extractedIdentityNumber: idNumber,
      });

    // Explicit APPLY review.
    const applied = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/review`)
      .set(auth())
      .send({ decision: 'APPLY' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.data.reviewStatus, 'APPLIED');
    assert.equal(applied.body.data.reviewedByUserId, managerUserId);
    assert.ok(applied.body.data.reviewedAt);

    // The authoritative identity now carries the reviewed fields.
    const visitorAfter = await api()
      .get(`/api/v1/visitors/${f.visitor.id}`)
      .set(auth());
    assert.equal(visitorAfter.body.data.fullName, 'Photo Guest Verified');
    assert.equal(visitorAfter.body.data.identityType, 'NATIONAL_ID');
    assert.equal(visitorAfter.body.data.identityNumber, idNumber);

    // Review is single-shot.
    const twice = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/review`)
      .set(auth())
      .send({ decision: 'APPLY' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'VISITOR_PHOTO_ALREADY_REVIEWED');
  });

  it('APPLY still enforces BE-13A identity rules (duplicate document)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Another visitor already holds this document.
    const idNumber = `3179${suffix()}`;
    await api()
      .post(`/api/v1/clients/${f.clientA.id}/visitors`)
      .set(auth())
      .send({
        fullName: 'Document Holder',
        identityType: 'NATIONAL_ID',
        identityNumber: idNumber,
      });

    const photo = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;
    await api()
      .post(`/api/v1/visitor-photos/${photo.id}/ocr-result`)
      .set(auth())
      .send({
        ocrStatus: 'PROCESSED',
        extractedIdentityType: 'NATIONAL_ID',
        extractedIdentityNumber: idNumber,
      });

    // APPLY collides with the shared duplicate rule → 409 from BE-13A.
    const applied = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/review`)
      .set(auth())
      .send({ decision: 'APPLY' });
    assert.equal(applied.status, 409, JSON.stringify(applied.body));
    assert.equal(
      applied.body.error.code,
      'VISITOR_IDENTITY_ALREADY_EXISTS',
    );

    // The failed APPLY left the photo UNREVIEWED (retryable) and the
    // visitor untouched.
    const photoAfter = await api()
      .get(`/api/v1/visitor-photos/${photo.id}`)
      .set(auth());
    assert.equal(photoAfter.body.data.reviewStatus, 'UNREVIEWED');
    const visitorAfter = await api()
      .get(`/api/v1/visitors/${f.visitor.id}`)
      .set(auth());
    assert.equal(visitorAfter.body.data.identityNumber, null);
  });

  it('REJECT never applies staged output', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const photo = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;
    await api()
      .post(`/api/v1/visitor-photos/${photo.id}/ocr-result`)
      .set(auth())
      .send({
        ocrStatus: 'PROCESSED',
        extractedFullName: 'Wrong Name From OCR',
      });

    const rejected = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/review`)
      .set(auth())
      .send({ decision: 'REJECT' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.reviewStatus, 'REJECTED');
    assert.equal(rejected.body.data.reviewedByUserId, managerUserId);
    // Staged output preserved for audit.
    assert.equal(rejected.body.data.extractedFullName, 'Wrong Name From OCR');

    const visitorAfter = await api()
      .get(`/api/v1/visitors/${f.visitor.id}`)
      .set(auth());
    assert.equal(visitorAfter.body.data.fullName, 'Photo Guest');

    // Reviewing an unprocessed photo is rejected.
    const pending = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;
    const early = await api()
      .post(`/api/v1/visitor-photos/${pending.id}/review`)
      .set(auth())
      .send({ decision: 'APPLY' });
    assert.equal(early.status, 409);
    assert.equal(
      early.body.error.code,
      'VISITOR_PHOTO_OCR_NOT_PROCESSED',
    );
  });

  it('lists, filters and soft-removes photo references', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const plain = (await attachPhoto(f.visitor.id, photoBody())).body.data;
    const document = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;

    const listAll = await api()
      .get(`/api/v1/visitors/${f.visitor.id}/photos`)
      .set(auth());
    assert.equal(listAll.status, 200);
    assert.equal(listAll.body.data.length, 2);

    const documents = await api()
      .get(`/api/v1/visitors/${f.visitor.id}/photos?photoType=IDENTITY_DOCUMENT`)
      .set(auth());
    assert.equal(documents.status, 200);
    assert.equal(documents.body.data.length, 1);
    assert.equal(documents.body.data[0].id, document.id);

    const pending = await api()
      .get(`/api/v1/visitors/${f.visitor.id}/photos?ocrStatus=PENDING`)
      .set(auth());
    assert.equal(pending.status, 200);
    assert.equal(pending.body.data.length, 1);

    // Soft remove keeps the row (audit) but marks it REMOVED.
    const removed = await api()
      .post(`/api/v1/visitor-photos/${plain.id}/remove`)
      .set(auth());
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.status, 'REMOVED');

    const active = await api()
      .get(`/api/v1/visitors/${f.visitor.id}/photos?status=ACTIVE`)
      .set(auth());
    assert.equal(active.status, 200);
    assert.equal(active.body.data.length, 1);

    // A removed photo is frozen.
    const removeTwice = await api()
      .post(`/api/v1/visitor-photos/${plain.id}/remove`)
      .set(auth());
    assert.equal(removeTwice.status, 409);
    assert.equal(removeTwice.body.error.code, 'VISITOR_PHOTO_REMOVED');
  });

  it('rejects invalid visitor and invalid file metadata', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Unknown visitor.
    const unknown = await attachPhoto(randomUUID(), photoBody());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'VISITOR_NOT_FOUND');

    // Non-image MIME.
    const badMime = await attachPhoto(
      f.visitor.id,
      photoBody({ mimeType: 'application/pdf' }),
    );
    assert.equal(badMime.status, 400);
    assert.equal(badMime.body.error.code, 'VALIDATION_ERROR');

    // Oversized file.
    const tooBig = await attachPhoto(
      f.visitor.id,
      photoBody({ fileSize: 100_000_000 }),
    );
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error.code, 'VALIDATION_ERROR');

    // Bad photo type.
    const badType = await attachPhoto(
      f.visitor.id,
      photoBody({ photoType: 'SELFIE' }),
    );
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'VALIDATION_ERROR');

    // Missing file reference.
    const noRef = await attachPhoto(
      f.visitor.id,
      photoBody({ fileReference: '' }),
    );
    assert.equal(noRef.status, 400);
    assert.equal(noRef.body.error.code, 'VALIDATION_ERROR');

    // Bad OCR result payload.
    const photo = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;
    const badOcr = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/ocr-result`)
      .set(auth())
      .send({ ocrStatus: 'DONE' });
    assert.equal(badOcr.status, 400);
    assert.equal(badOcr.body.error.code, 'VALIDATION_ERROR');

    // Bad review decision.
    const badReview = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/review`)
      .set(auth())
      .send({ decision: 'MAYBE' });
    assert.equal(badReview.status, 400);
    assert.equal(badReview.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const plainToken = await createPlainSession();

    const forbiddenAttach = await attachPhoto(
      f.visitor.id,
      photoBody(),
      plainToken,
    );
    assert.equal(forbiddenAttach.status, 403);
    assert.equal(forbiddenAttach.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get(`/api/v1/visitors/${f.visitor.id}/photos`)
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const photo = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;

    const forbiddenRead = await api()
      .get(`/api/v1/visitor-photos/${photo.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenOcr = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/ocr-result`)
      .set(auth(plainToken))
      .send({ ocrStatus: 'PROCESSED' });
    assert.equal(forbiddenOcr.status, 403);
    assert.equal(forbiddenOcr.body.error.code, 'PERMISSION_DENIED');

    const forbiddenReview = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/review`)
      .set(auth(plainToken))
      .send({ decision: 'REJECT' });
    assert.equal(forbiddenReview.status, 403);
    assert.equal(forbiddenReview.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRemove = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/remove`)
      .set(auth(plainToken));
    assert.equal(forbiddenRemove.status, 403);
    assert.equal(forbiddenRemove.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get(
      `/api/v1/visitors/${f.visitor.id}/photos`,
    );
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const photo = (
      await attachPhoto(
        f.visitor.id,
        photoBody({ photoType: 'IDENTITY_DOCUMENT', requestOcr: true }),
      )
    ).body.data;

    // A client-B user cannot attach, list, read, record OCR, review
    // or remove client-A photo rows.
    const deniedAttach = await attachPhoto(
      f.visitor.id,
      photoBody(),
      f.bAdmin.token,
    );
    assert.equal(deniedAttach.status, 403);
    assert.equal(deniedAttach.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get(`/api/v1/visitors/${f.visitor.id}/photos`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/visitor-photos/${photo.id}`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedOcr = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/ocr-result`)
      .set(auth(f.bAdmin.token))
      .send({ ocrStatus: 'PROCESSED', extractedFullName: 'X' });
    assert.equal(deniedOcr.status, 403);
    assert.equal(deniedOcr.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedReview = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/review`)
      .set(auth(f.bAdmin.token))
      .send({ decision: 'REJECT' });
    assert.equal(deniedReview.status, 403);
    assert.equal(deniedReview.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRemove = await api()
      .post(`/api/v1/visitor-photos/${photo.id}/remove`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedRemove.status, 403);
    assert.equal(deniedRemove.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
