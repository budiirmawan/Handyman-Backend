import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  createChannelAttribution,
} from '../src/modules/handyman-channel-attributions';
import {
  handymanIntakeEvidenceService,
  HANDYMAN_INTAKE_MAX_FILE_BYTES,
} from '../src/modules/handyman-evidence';
import type { RecordHandymanIntakeEvidenceInput } from '../src/modules/handyman-evidence';
import {
  handymanServiceRequestRepository,
  handymanServiceRequestService,
} from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-02 PART 04 — focused tests for bounded Handyman REQUEST INTAKE
 * evidence (PHOTO + VIDEO; frozen D1/D2). Service/domain level only; the
 * shared `.data/evidence` storage is redirected via EVIDENCE_STORAGE_DIR
 * and removed afterwards. Each case builds its own attribution → request
 * fixture through the real PART 01/03 services.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const STORAGE_DIR = process.env.EVIDENCE_STORAGE_DIR ?? '';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const sha256Hex = (b: Buffer) =>
  createHash('sha256').update(b).digest('hex');

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
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
  if (STORAGE_DIR) {
    await rm(STORAGE_DIR, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

async function tableCount(name: string): Promise<number> {
  assert.ok(pool);
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${name}`);
  return result.rows[0].n as number;
}

async function requestFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`, name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id, code: `P_${suffix()}`, name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id, code: `B_${suffix()}`, name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const floor = await floorService.createFloor({
    buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id, code: `A_${suffix()}`, name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id, code: `R_${suffix()}`, name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id, code: `S_${suffix()}`, name: 'Tenant Space',
  });
  const company = await tenantCompanyService.createTenantCompany({
    clientId: client.id, tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id, picName: 'Tenant Requester',
    email: 'requester@tenant.example.com', userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id, buildingId: building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id, buildingId: building.id,
    tenantPicId: pic.id, spaceId: space.id, originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: client.id, code: `HM${suffix()}`, name: 'Handyman Service',
    category: 'HANDYMAN',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest({
      channelAttributionId: attribution.id,
      serviceCatalogId: service.id,
      description: 'Intake evidence fixture request.',
    }, adminUserId);
  return { client, building, space, company, pic, attribution, service, request };
}

describe('CR-HM-02 PART 04 — request intake evidence (PHOTO/VIDEO)', () => {
  it('1: PHOTO accepted for a Handyman request with integrity metadata', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const evidence = await handymanIntakeEvidenceService
      .recordHandymanIntakeEvidence({
        handymanRequestId: f.request.id,
        evidenceKind: 'PHOTO',
        fileName: 'leak.jpg',
        mimeType: 'image/jpeg',
        content: JPEG,
      }, adminUserId);
    assert.ok(evidence.id);
    assert.equal(evidence.handymanRequestId, f.request.id);
    assert.equal(evidence.clientId, f.client.id);
    assert.equal(evidence.evidenceKind, 'PHOTO');
    assert.equal(evidence.mimeType, 'image/jpeg');
    assert.equal(evidence.fileSize, JPEG.length);
    assert.equal(evidence.contentSha256, sha256Hex(JPEG));
    assert.equal(evidence.status, 'ACTIVE');
    assert.ok(evidence.capturedAt && !Number.isNaN(Date.parse(evidence.capturedAt)));
    // engine storage metadata persisted on the shared submissions row
    assert.ok(pool);
    const row = await pool.query(
      `SELECT execution_type, evidence_type, file_reference, mime_type,
              file_size, content_sha256, content_hashed_at, hash_algorithm,
              retention_state, evidence_requirement_id
         FROM evidence_submissions WHERE id = $1`,
      [evidence.id],
    );
    assert.equal(row.rows[0].execution_type, 'HANDYMAN_REQUEST');
    assert.equal(row.rows[0].evidence_type, 'PHOTO');
    assert.match(row.rows[0].file_reference, /\S/);
    assert.equal(row.rows[0].content_sha256, sha256Hex(JPEG));
    assert.ok(row.rows[0].content_hashed_at);
    assert.equal(row.rows[0].hash_algorithm, 'SHA-256');
    assert.equal(row.rows[0].retention_state, 'ACTIVE');
    assert.equal(row.rows[0].evidence_requirement_id, null);
  });

  it('2: allowed VIDEO accepted (bounded Handyman intake capability)', async (t) => {
    if (!requireDatabase(t) || !pool) return;
    const f = await requestFixture();
    for (const mimeType of ['video/mp4', 'video/quicktime', 'video/webm'] as const) {
      const evidence = await handymanIntakeEvidenceService
        .recordHandymanIntakeEvidence({
          handymanRequestId: f.request.id,
          evidenceKind: 'VIDEO',
          fileName: 'walkthrough',
          mimeType,
          content: MP4,
        }, adminUserId);
      assert.equal(evidence.evidenceKind, 'VIDEO');
      assert.equal(evidence.mimeType, mimeType);
    }
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM evidence_submissions
        WHERE execution_type = 'HANDYMAN_REQUEST' AND evidence_type = 'VIDEO'`,
    );
    assert.equal(rows.rows[0].n, 3);
  });

  it('3: disallowed video MIME is rejected; photo keep-outs hold', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence({
        handymanRequestId: f.request.id,
        evidenceKind: 'VIDEO',
        fileName: 'clip.avi',
        mimeType: 'video/x-msvideo',
        content: MP4,
      }, adminUserId),
      (error: Error) =>
        /does not accept MIME type/.test(error.message),
    );
    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence({
        handymanRequestId: f.request.id,
        evidenceKind: 'PHOTO',
        fileName: 'anim.gif',
        mimeType: 'image/gif',
        content: JPEG,
      }, adminUserId),
      (error: Error) =>
        /does not accept MIME type/.test(error.message),
    );
    // nothing persisted on rejection
    const listed = await handymanIntakeEvidenceService.listHandymanIntakeEvidence(
      f.request.id, adminUserId,
    );
    assert.equal(listed.length, 0);
  });

  it('4: oversized video is rejected (shared 50 MB storage policy)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const oversized = Buffer.alloc(HANDYMAN_INTAKE_MAX_FILE_BYTES + 1, 0x20);
    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence({
        handymanRequestId: f.request.id,
        evidenceKind: 'VIDEO',
        fileName: 'huge.mp4',
        mimeType: 'video/mp4',
        content: oversized,
      }, adminUserId),
      (error: Error) => /50 MB limit/.test(error.message),
    );
    const listed = await handymanIntakeEvidenceService.listHandymanIntakeEvidence(
      f.request.id, adminUserId,
    );
    assert.equal(listed.length, 0);
  });

  it('5: cross-client/request access is rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const outsider = await userService.createUser({
      email: `outsider-${suffix().toLowerCase()}@example.com`,
      displayName: 'No Access User',
    });
    await assert.rejects(
      handymanIntakeEvidenceService.recordHandymanIntakeEvidence({
        handymanRequestId: f.request.id,
        evidenceKind: 'PHOTO',
        fileName: 'spy.jpg',
        mimeType: 'image/jpeg',
        content: JPEG,
      }, outsider.id),
      (error: unknown) => errorCode(error) === 'BUILDING_ACCESS_DENIED',
    );
    const listed = await handymanIntakeEvidenceService.listHandymanIntakeEvidence(
      f.request.id, adminUserId,
    );
    assert.equal(listed.length, 0);
  });

  it('6: evidence context derives from the request, never the caller', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const other = await requestFixture();
    const evidence = await handymanIntakeEvidenceService
      .recordHandymanIntakeEvidence({
        handymanRequestId: f.request.id,
        evidenceKind: 'PHOTO',
        fileName: 'derived.jpg',
        mimeType: 'image/jpeg',
        content: JPEG,
        // deliberate smuggling attempt: conflicting context keys in input
        clientId: other.client.id,
        tenantCompanyId: other.company.id,
        buildingId: other.building.id,
        executionId: other.request.id,
      } as unknown as RecordHandymanIntakeEvidenceInput, adminUserId);
    assert.equal(evidence.clientId, f.client.id);
    assert.equal(evidence.handymanRequestId, f.request.id);
    const listed = await handymanIntakeEvidenceService.listHandymanIntakeEvidence(
      other.request.id, adminUserId,
    );
    assert.equal(listed.length, 0);
  });

  it('7: evidence intake never mutates request state or context', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const before1 = await handymanServiceRequestRepository.findById(
      undefined, f.request.id,
    );
    assert.ok(before1);
    const recorded = await handymanIntakeEvidenceService
      .recordHandymanIntakeEvidence({
        handymanRequestId: f.request.id,
        evidenceKind: 'VIDEO',
        fileName: 'intake.mp4',
        mimeType: 'video/mp4',
        content: MP4,
      }, adminUserId);
    assert.ok(recorded.id);
    const after1 = await handymanServiceRequestRepository.findById(
      undefined, f.request.id,
    );
    assert.ok(after1);
    assert.deepEqual(after1, before1);
    assert.equal(after1.status, 'INTAKE');
  });

  it('8: catalogue/material media records are unaffected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await requestFixture();
    const catalogBefore = await tableCount('service_catalog');
    const variantsBefore = await tableCount('handyman_service_variants');
    const profilesBefore = await tableCount('handyman_common_material_profiles');
    await handymanIntakeEvidenceService.recordHandymanIntakeEvidence({
      handymanRequestId: f.request.id,
      evidenceKind: 'PHOTO',
      fileName: 'photo.png',
      mimeType: 'image/png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }, adminUserId);
    await handymanIntakeEvidenceService.recordHandymanIntakeEvidence({
      handymanRequestId: f.request.id,
      evidenceKind: 'VIDEO',
      fileName: 'clip.webm',
      mimeType: 'video/webm',
      content: MP4,
    }, adminUserId);
    assert.equal(await tableCount('service_catalog'), catalogBefore);
    assert.equal(await tableCount('handyman_service_variants'), variantsBefore);
    assert.equal(
      await tableCount('handyman_common_material_profiles'),
      profilesBefore,
    );
  });
});
