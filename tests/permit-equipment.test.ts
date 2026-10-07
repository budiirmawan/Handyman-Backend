import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { assetCertificationService } from '../src/modules/asset-certifications';
import { assetIdentifierService } from '../src/modules/asset-identifiers';
import { assetService } from '../src/modules/assets';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { equipmentProfileService } from '../src/modules/equipment-profiles';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantContractorService } from '../src/modules/tenant-contractors';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const REQUESTED_AT = '2026-09-15T08:00:00+07:00';
const PLANNED_START = '2026-09-20T08:00:00+07:00';
const PLANNED_END = '2026-09-20T17:00:00+07:00';
const WORK_TYPE = 'ELECTRICAL_MAINTENANCE';
const VALID_FROM = '2026-08-15T00:00:00Z';
const VALID_UNTIL = '2026-08-20T00:00:00Z';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE permit_equipment, permit_workers,
    permit_validities, permit_approval_bindings, permit_safety_requirements,
    permit_work_contexts, permit_applications, permits, operational_events,
    reviews, inspection_bindings, asset_certifications, asset_identifiers,
    equipment_profiles, assets, tenant_contractor_relationships,
    tenant_building_contexts, tenant_space_relationships, tenant_companies,
    vendor_building_relationships, vendors, spaces, rooms, areas, floors,
    buildings, properties, users, roles, permissions, clients CASCADE`);
  const manager = await createAdminUser();
  token = manager.token;
  userId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});
function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function hierarchy(options: { client?: PublicClient; assignUserId?: string } = {}) {
  const client = options.client ?? await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(options.assignUserId ?? userId, { buildingId: building.id });
  const floor = await floorService.createFloor({ buildingId: building.id, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  const space = await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Space' });
  return { client, building, area, room, space };
}

async function vendorFixture() {
  const structure = await hierarchy();
  const vendor = await vendorService.createVendor({ clientId: structure.client.id, vendorCode: `V_${suffix()}`, vendorName: 'Vendor Contractor' });
  await vendorBuildingService.assignBuildingToVendor({ vendorId: vendor.id, buildingId: structure.building.id });
  return { ...structure, vendor };
}
async function tenantFixture() {
  const structure = await hierarchy();
  const tenant = await tenantCompanyService.createTenantCompany({ clientId: structure.client.id, tenantCode: `T_${suffix()}`, tenantName: 'Tenant' }, userId);
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: structure.building.id, spaceId: structure.space.id }, userId);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: structure.building.id }, userId);
  const vendor = await vendorService.createVendor({ clientId: structure.client.id, vendorCode: `V_${suffix()}`, vendorName: 'Tenant Contractor Vendor' });
  await vendorBuildingService.assignBuildingToVendor({ vendorId: vendor.id, buildingId: structure.building.id });
  const relationship = await tenantContractorService.createTenantContractorRelationship({
    tenantCompanyId: tenant.id, contractorVendorId: vendor.id,
    buildingId: structure.building.id, spaceId: structure.space.id,
    relationshipType: 'MAINTENANCE', effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  }, userId);
  return { ...structure, tenant, vendor, relationship };
}

type Setup = { fixture: Record<string, any>; permit: Record<string, any>; application: Record<string, any> };
async function setupPermit(tenant = false): Promise<Setup> {
  const fixture = tenant ? await tenantFixture() : await vendorFixture();
  const permit = await api().post('/api/v1/permits').set(auth()).send({
    buildingId: fixture.building.id, permitNumber: `PTW-${suffix()}`,
    permitType: tenant ? 'TENANT_WORK' : 'GENERAL_WORK', title: 'Equipment work',
    workDescription: 'Use controlled equipment.', applicantReference: 'APPLICANT',
    contractorContextType: tenant ? 'TENANT_CONTRACTOR' : 'VENDOR_CONTRACTOR',
    contractorContextId: tenant ? fixture.relationship.id : fixture.vendor.id,
  });
  assert.equal(permit.status, 201, JSON.stringify(permit.body));
  const app = await api().post('/api/v1/permit-applications').set(auth()).send({ permitId: permit.body.data.id, requestedWorkAt: REQUESTED_AT });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  assert.equal((await api().put(`/api/v1/permit-applications/${app.body.data.id}/work-location`).set(auth()).send({ locationType: 'AREA', locationId: fixture.area.id, plannedStartAt: PLANNED_START, plannedEndAt: PLANNED_END })).status, 200);
  assert.equal((await api().put(`/api/v1/permit-applications/${app.body.data.id}/work-type`).set(auth()).send({ workType: WORK_TYPE })).status, 200);
  const safety = await api().post(`/api/v1/permit-applications/${app.body.data.id}/safety-requirements`).set(auth()).send({ buildingId: fixture.building.id, workType: WORK_TYPE, requirementType: `PPE_${suffix()}`, requirementDescription: 'PPE ready', required: true });
  assert.equal(safety.status, 201, JSON.stringify(safety.body));
  assert.equal((await api().patch(`/api/v1/safety-requirements/${safety.body.data.id}/readiness`).set(auth()).send({ readinessStatus: 'READY' })).status, 200);
  const submitted = await api().post(`/api/v1/permit-applications/${app.body.data.id}/submit`).set(auth()).send({});
  assert.equal(submitted.status, 200);
  const approval = await api().post(`/api/v1/permit-applications/${app.body.data.id}/approvals`).set(auth()).send({ approvalStage: 'FINAL_REVIEW', approvalType: 'PERMIT_AUTHORIZATION', approverUserId: userId });
  assert.equal(approval.status, 201);
  assert.equal((await api().post(`/api/v1/permit-approvals/${approval.body.data.id}/approve`).set(auth()).send({})).status, 200);
  const validity = await api().post(`/api/v1/permits/${permit.body.data.id}/validity`).set(auth()).send({ permitApplicationId: app.body.data.id, buildingId: fixture.building.id, validFrom: VALID_FROM, validUntil: VALID_UNTIL });
  assert.equal(validity.status, 201, JSON.stringify(validity.body));
  return { fixture, permit: permit.body.data, application: submitted.body.data };
}

async function createEquipment(setup: Setup, options: { buildingId?: string; assetStatus?: 'ACTIVE'|'INACTIVE'; certificationExpiry?: string } = {}) {
  const asset = await assetService.createAsset({
    buildingId: options.buildingId ?? setup.fixture.building.id,
    assetCode: `AST_${suffix()}`, assetName: 'Portable Test Equipment',
    manufacturer: 'Asentra Tools', model: 'PT-100', serialNumber: `SN-${suffix()}`,
    status: options.assetStatus ?? 'ACTIVE',
  }, userId);
  const profile = await equipmentProfileService.createEquipmentProfile({
    assetId: asset.id, equipmentCode: `EQ_${suffix()}`,
    equipmentName: 'Portable Electrical Tester', status: 'ACTIVE',
  }, userId);
  const identifier = await assetIdentifierService.createAssetIdentifier({
    assetId: asset.id, identifierType: 'TAG', identifierValue: `TAG-${suffix()}`,
  }, userId);
  let certification = null;
  if (options.certificationExpiry !== undefined) {
    certification = await assetCertificationService.createAssetCertification({
      assetId: asset.id, certificationType: 'CALIBRATION',
      certificateNumber: `CERT-${suffix()}`, issuingAuthority: 'Calibration Lab',
      issueDate: '2026-01-01', expiryDate: options.certificationExpiry,
      status: options.certificationExpiry < '2026-08-16' ? 'EXPIRED' : 'ACTIVE',
    }, userId);
  }
  return { asset, profile, identifier, certification };
}

function equipmentBody(setup: Setup, equipment: Awaited<ReturnType<typeof createEquipment>>, extra: Record<string, unknown> = {}) {
  return {
    permitApplicationId: setup.application.id,
    buildingId: setup.fixture.building.id,
    contractorContextType: setup.permit.contractorContextType,
    contractorContextId: setup.permit.contractorContextId,
    assetId: equipment.asset.id,
    equipmentProfileId: equipment.profile.id,
    assetIdentifierId: equipment.identifier.id,
    ...(equipment.certification ? { assetCertificationId: equipment.certification.id } : {}),
    notes: 'Approved equipment entry.',
    ...extra,
  };
}
async function addEquipment(setup: Setup, equipment: Awaited<ReturnType<typeof createEquipment>>, extra: Record<string, unknown> = {}, withToken = token) {
  return api().post(`/api/v1/permits/${setup.permit.id}/equipment`).set(auth(withToken)).send(equipmentBody(setup, equipment, extra));
}

describe('BE-20I Permit Equipment', () => {
  it('adds valid Asset/Equipment with identifier and certification', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const equipment = await createEquipment(setup, { certificationExpiry: '2026-12-31' });
    const created = await addEquipment(setup, equipment);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.assetId, equipment.asset.id);
    assert.equal(created.body.data.equipmentName, equipment.profile.equipmentName);
    assert.equal(created.body.data.identifierReference, equipment.identifier.identifierValue);
    assert.equal(created.body.data.certificationReference, equipment.certification!.certificateNumber);
    assert.equal(created.body.data.certificationCurrentlyValid, true);
    assert.equal(created.body.data.eligibleForActiveWork, true);
    const active = await api().get(`/api/v1/permits/${setup.permit.id}/equipment/active`).set(auth());
    assert.equal(active.status, 200);
    assert.equal(active.body.data.equipmentCount, 1);
  });

  it('supports Tenant Contractor equipment through the same Asset foundation', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit(true);
    const equipment = await createEquipment(setup);
    const created = await addEquipment(setup, equipment);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.contractorContextType, 'TENANT_CONTRACTOR');
  });

  it('rejects invalid equipment references', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const response = await api().post(`/api/v1/permits/${setup.permit.id}/equipment`).set(auth()).send({
      permitApplicationId: setup.application.id, buildingId: setup.fixture.building.id,
      contractorContextType: setup.permit.contractorContextType,
      contractorContextId: setup.permit.contractorContextId,
      assetId: randomUUID(),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_EQUIPMENT_INVALID');
  });

  it('rejects Contractor context mismatch', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const equipment = await createEquipment(setup);
    const response = await addEquipment(setup, equipment, { contractorContextId: randomUUID() });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_EQUIPMENT_CONTRACTOR_MISMATCH');
  });

  it('rejects equipment from another Building', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const other = await hierarchy({ client: setup.fixture.client });
    const equipment = await createEquipment(setup, { buildingId: other.building.id });
    const response = await addEquipment(setup, equipment);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_EQUIPMENT_BUILDING_MISMATCH');
  });

  it('rejects duplicate ACTIVE equipment', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const equipment = await createEquipment(setup);
    assert.equal((await addEquipment(setup, equipment)).status, 201);
    const duplicate = await addEquipment(setup, equipment);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'PERMIT_EQUIPMENT_ALREADY_ACTIVE');
  });

  it('validates Certification and Permit validity periods', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const shortCertification = await createEquipment(setup, { certificationExpiry: '2026-08-17' });
    const certificationInvalid = await addEquipment(setup, shortCertification);
    assert.equal(certificationInvalid.status, 400);
    assert.equal(certificationInvalid.body.error.code, 'PERMIT_EQUIPMENT_CERTIFICATION_INVALID');
    const validEquipment = await createEquipment(setup);
    const outside = await addEquipment(setup, validEquipment, {
      validFrom: '2026-08-14T00:00:00Z', validUntil: '2026-08-19T00:00:00Z',
    });
    assert.equal(outside.status, 400);
    assert.equal(outside.body.error.code, 'PERMIT_EQUIPMENT_INVALID_VALIDITY');
  });

  it('rejects inactive equipment and preserves update/deactivate history', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const inactiveEquipment = await createEquipment(setup, { assetStatus: 'INACTIVE' });
    const inactive = await addEquipment(setup, inactiveEquipment);
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'PERMIT_EQUIPMENT_INACTIVE');
    const equipment = await createEquipment(setup);
    const created = await addEquipment(setup, equipment);
    const updated = await api().patch(`/api/v1/permit-equipment/${created.body.data.id}`).set(auth()).send({ notes: 'Updated equipment note.' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const deactivated = await api().post(`/api/v1/permit-equipment/${created.body.data.id}/deactivate`).set(auth()).send({});
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.eligibleForActiveWork, false);
    const history = await api().get(`/api/v1/permits/${setup.permit.id}/equipment`).set(auth());
    assert.equal(history.body.data.some((item: { id: string; status: string }) => item.id === created.body.data.id && item.status === 'INACTIVE'), true);
  });

  it('enforces Permit RBAC', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const equipment = await createEquipment(setup);
    const plain = await createPlainSession();
    const denied = await addEquipment(setup, equipment, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    assert.equal((await api().get('/api/v1/permit-equipment').set(auth(plain))).status, 403);
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const setup = await setupPermit();
    const equipment = await createEquipment(setup);
    const created = await addEquipment(setup, equipment);
    const other = await createAdminUser();
    await hierarchy({ assignUserId: other.userId });
    const denied = await api().get(`/api/v1/permit-equipment/${created.body.data.id}`).set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const list = await api().get('/api/v1/permit-equipment').set(auth(other.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((item: { id: string }) => item.id === created.body.data.id), false);
  });
});
