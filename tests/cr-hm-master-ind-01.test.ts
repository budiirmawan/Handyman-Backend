import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { api } from './helpers/http';
import { createAdminUser } from './helpers/access';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { credentialService } from '../src/modules/auth';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import {
  tenantCompanyService,
  type PublicTenantCompany,
} from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { inventoryItemService } from '../src/modules/inventory-items';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';

/**
 * CR-HM-MASTER-IND-01 — Indonesian apartment master data acceptance suite.
 *
 * Focused HTTP suite against disposable embedded PostgreSQL and real
 * authenticated sessions. Covers the acceptance list:
 *   - individual Tenant linked to one eligible Unit (no fictitious company),
 *   - distinct Owner / Occupant / PIC parties on the same Unit,
 *   - effective-dated occupancy history surviving a Tenant change,
 *   - invalid Building/Tenant/Unit combinations denied,
 *   - active catalogue service readable by Customer Care,
 *   - cross-Building access denied,
 *   - PR #43 intake + approval/cost-responsibility designations preserved.
 * No production mutation.
 */

const V1 = '/api/v1';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let pg: EmbeddedPostgres;
let dir = '';
let pool: Pool;
let adminUserId = '';
let adminSession = '';

type Realm = {
  client: { id: string };
  property: { id: string };
  building: { id: string };
  floorId: string;
  roomId: string;
  unitId: string;
  tenant: PublicTenantCompany;
  owner: PublicTenantCompany;
  picParty: PublicTenantCompany;
  picId: string;
  service: { id: string };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-master-ind-'));
  const port = 58000 + Math.floor(Math.random() * 800);
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password: 'password',
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  pool = await initDatabase({
    host: '127.0.0.1',
    port,
    name: 'postgres',
    user: 'postgres',
    password: 'password',
    ssl: false,
    poolMin: 1,
    poolMax: 16,
  });
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminSession = admin.token;
});

after(async () => {
  await closePool(getPool()).catch(() => undefined);
  if (pg) await pg.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function ensurePermission(code: string, name: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) return existing.id;
  return (await permissionService.createPermission({ code, name })).id;
}

/** Customer Care staff: `handyman.care.building` + one Building assignment. */
async function createCareStaff(buildingId: string) {
  const tag = suffix().toLowerCase();
  const email = `care-${tag}@example.test`;
  const password = `Care-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Building Care Staff',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `MASTER_CARE_${tag.toUpperCase()}`,
    name: 'Master Care',
  });
  await permissionService.assignPermissionToRole(
    role.id,
    await ensurePermission(HANDYMAN_CARE_BUILDING_PERMISSION, 'Building Care'),
  );
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

async function createIndividual(
  clientId: string,
  label: string,
  ktp: string,
): Promise<PublicTenantCompany> {
  return tenantCompanyService.createTenantCompany(
    {
      clientId,
      tenantCode: `IND_${suffix()}`,
      tenantName: label,
      partyKind: 'INDIVIDUAL',
      identityDocumentType: 'KTP',
      identityDocumentNumber: ktp,
      phone: '081234567890',
    },
    adminUserId,
  );
}

async function createLegalEntity(
  clientId: string,
  label: string,
): Promise<PublicTenantCompany> {
  return tenantCompanyService.createTenantCompany(
    {
      clientId,
      tenantCode: `LEG_${suffix()}`,
      tenantName: label,
      partyKind: 'LEGAL_ENTITY',
      legalName: `${label} PT`,
      identityDocumentType: 'NPWP',
      identityDocumentNumber: '012345678901234',
    },
    adminUserId,
  );
}

function ktp(): string {
  return String(Math.floor(Math.random() * 9) + 1) +
    String(Math.floor(Math.random() * 1e15)).padStart(15, '0');
}

async function createRealm(input: {
  label: string;
  assignAdmin?: boolean;
}): Promise<Realm> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `MI_${tag}`,
    name: `${input.label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `MP_${tag}`,
    name: `${input.label} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `MB_${tag}`,
    name: `${input.label} Tower`,
  });
  if (input.assignAdmin !== false) {
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
  }
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `MF_${tag}`,
    name: 'Tower floor',
    levelNumber: 10,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `MA_${tag}`,
    name: 'Residential area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `MR_${tag}`,
    name: 'Unit room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `MU_${tag}`,
    name: 'Unit 10-01',
    areaSqm: 72,
  });

  const tenant = await createIndividual(client.id, `${input.label} Tenant`, ktp());
  const owner = await createLegalEntity(client.id, `${input.label} Owner`);
  const picParty = await createIndividual(
    client.id,
    `${input.label} Unit PIC`,
    ktp(),
  );

  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: tenant.id, buildingId: building.id, spaceId: space.id },
    adminUserId,
  );
  // A Building context requires a resolvable occupancy (BE-14D). Only the
  // occupying Tenant has one; Owner/PIC are Unit party roles, not occupancies.
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: tenant.id, buildingId: building.id },
    adminUserId,
  );

  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: tenant.id,
      picName: `${input.label} Tenant PIC`,
      email: `pic-${tag.toLowerCase()}@example.test`,
    },
    adminUserId,
  );

  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `MSV_${tag}`,
      name: `${input.label} AC service`,
      category: 'AIR_CONDITIONING',
    },
    adminUserId,
  );

  return {
    client,
    property,
    building,
    floorId: floor.id,
    roomId: room.id,
    unitId: space.id,
    tenant,
    owner,
    picParty,
    picId: pic.id,
    service,
  };
}

const unitPath = (buildingId: string, unitId: string) =>
  `${V1}/buildings/${buildingId}/units/${unitId}`;

async function assignParty(
  token: string,
  buildingId: string,
  unitId: string,
  body: unknown,
) {
  return api()
    .post(`${unitPath(buildingId, unitId)}/parties`)
    .set(auth(token))
    .send(body as object);
}

describe('CR-HM-MASTER-IND-01 apartment master data', () => {
  it('1: individual Tenant is master data (no fictitious company) and links to one eligible Unit', async () => {
    const realm = await createRealm({ label: 'Individual' });

    const list = await api()
      .get(`${V1}/clients/${realm.client.id}/tenant-companies`)
      .query({ partyKind: 'INDIVIDUAL' })
      .set(auth(await adminToken()));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const individuals = list.body.data as PublicTenantCompany[];
    const tenant = individuals.find((row) => row.id === realm.tenant.id);
    assert.ok(tenant, 'individual tenant must be listed');
    assert.equal(tenant.partyKind, 'INDIVIDUAL');
    assert.equal(tenant.legalName, null);
    assert.equal(tenant.identityDocumentType, 'KTP');

    // The Unit is the existing Space master, listed through the Building.
    const units = await api()
      .get(`${V1}/buildings/${realm.building.id}/units`)
      .set(auth(await adminToken()));
    assert.equal(units.status, 200, JSON.stringify(units.body));
    assert.equal(units.body.data.length, 1);
    assert.equal(units.body.data[0].id, realm.unitId);
    assert.equal(units.body.data[0].floorId, realm.floorId);
    assert.equal(units.body.meta.total, 1);

    // An individual without an identity document, or with a legal name, is
    // rejected: the master never invents a company identity.
    const missingDocument = await api()
      .post(`${V1}/clients/${realm.client.id}/tenant-companies`)
      .set(auth(await adminToken()))
      .send({
        tenantCode: `BAD_${suffix()}`,
        tenantName: 'Undocumented Person',
        partyKind: 'INDIVIDUAL',
      });
    assert.equal(missingDocument.status, 400);
    assert.equal(missingDocument.body.error.code, 'VALIDATION_ERROR');

    const withLegalName = await api()
      .post(`${V1}/clients/${realm.client.id}/tenant-companies`)
      .set(auth(await adminToken()))
      .send({
        tenantCode: `BAD_${suffix()}`,
        tenantName: 'Person With Company',
        partyKind: 'INDIVIDUAL',
        legalName: 'Fictitious PT',
        identityDocumentType: 'KTP',
        identityDocumentNumber: ktp(),
      });
    assert.equal(withLegalName.status, 400);
  });

  it('2: Owner, Occupant and PIC are distinct parties on the same Unit', async () => {
    const realm = await createRealm({ label: 'Roles' });
    const token = await adminToken();

    const owner = await assignParty(token, realm.building.id, realm.unitId, {
      tenantCompanyId: realm.owner.id,
      partyRole: 'OWNER',
    });
    assert.equal(owner.status, 201, JSON.stringify(owner.body));
    const occupant = await assignParty(token, realm.building.id, realm.unitId, {
      tenantCompanyId: realm.tenant.id,
      partyRole: 'OCCUPANT',
    });
    assert.equal(occupant.status, 201, JSON.stringify(occupant.body));
    const pic = await assignParty(token, realm.building.id, realm.unitId, {
      tenantCompanyId: realm.picParty.id,
      partyRole: 'PIC',
    });
    assert.equal(pic.status, 201, JSON.stringify(pic.body));

    const parties = await api()
      .get(`${unitPath(realm.building.id, realm.unitId)}/parties`)
      .set(auth(token));
    assert.equal(parties.status, 200, JSON.stringify(parties.body));
    const rows = parties.body.data as {
      partyRole: string;
      tenantCompanyId: string;
      tenantName: string;
      status: string;
    }[];
    assert.equal(rows.length, 3);
    const byRole = new Map(rows.map((row) => [row.partyRole, row]));
    assert.equal(byRole.get('OWNER')?.tenantCompanyId, realm.owner.id);
    assert.equal(byRole.get('OCCUPANT')?.tenantCompanyId, realm.tenant.id);
    assert.equal(byRole.get('PIC')?.tenantCompanyId, realm.picParty.id);
    assert.notEqual(byRole.get('OWNER')?.tenantCompanyId, byRole.get('OCCUPANT')?.tenantCompanyId);
    assert.equal(parties.body.meta.total, 3);

    // Duplicate active assignment is refused; ending it preserves the row.
    const duplicate = await assignParty(token, realm.building.id, realm.unitId, {
      tenantCompanyId: realm.owner.id,
      partyRole: 'OWNER',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'UNIT_PARTY_ROLE_ALREADY_ACTIVE');

    const ended = await api()
      .post(`${V1}/unit-party-roles/${owner.body.data.id}/end`)
      .set(auth(token))
      .send({});
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.data.status, 'INACTIVE');
    assert.ok(ended.body.data.effectiveUntil);

    const history = await api()
      .get(`${unitPath(realm.building.id, realm.unitId)}/parties`)
      .query({ role: 'OWNER', status: 'INACTIVE' })
      .set(auth(token));
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].id, owner.body.data.id);
  });

  it('3: historic occupancy survives a Tenant change', async () => {
    const realm = await createRealm({ label: 'History' });
    const token = await adminToken();

    const nextTenant = await createIndividual(
      realm.client.id,
      'Next Tenant',
      ktp(),
    );
    const current = await api()
      .get(`${V1}/buildings/${realm.building.id}/tenant-spaces`)
      .set(auth(token));
    assert.equal(current.status, 200, JSON.stringify(current.body));
    const previous = (current.body.data as { id: string }[]).find(
      (row) => row.id !== undefined,
    );
    assert.ok(previous);

    // Close the existing occupancy, then assign the new Tenant.
    const closed = await api()
      .patch(`${V1}/tenant-space-relationships/${previous.id}`)
      .set(auth(token))
      .send({ status: 'INACTIVE' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    await tenantSpaceService.assignSpaceToTenant(
      {
        tenantCompanyId: nextTenant.id,
        buildingId: realm.building.id,
        spaceId: realm.unitId,
      },
      adminUserId,
    );
    await tenantBuildingContextService.createTenantBuildingContext(
      { tenantCompanyId: nextTenant.id, buildingId: realm.building.id },
      adminUserId,
    );

    const occupancies = await api()
      .get(`${unitPath(realm.building.id, realm.unitId)}/occupancies`)
      .set(auth(token));
    assert.equal(occupancies.status, 200, JSON.stringify(occupancies.body));
    const rows = occupancies.body.data as {
      tenantCompanyId: string;
      status: string;
      current: boolean;
      effectiveUntil: string | null;
    }[];
    assert.equal(rows.length, 2);
    const historic = rows.find((row) => row.tenantCompanyId === realm.tenant.id);
    const active = rows.find((row) => row.tenantCompanyId === nextTenant.id);
    assert.equal(historic?.status, 'INACTIVE');
    assert.equal(historic?.current, false);
    assert.ok(historic?.effectiveUntil);
    assert.equal(active?.status, 'ACTIVE');
    assert.equal(active?.current, true);
    assert.equal(occupancies.body.meta.total, 2);

    const activeOnly = await api()
      .get(`${unitPath(realm.building.id, realm.unitId)}/occupancies`)
      .query({ status: 'ACTIVE' })
      .set(auth(token));
    assert.equal(activeOnly.status, 200);
    assert.equal(activeOnly.body.data.length, 1);
  });

  it('4: invalid Building/Tenant/Unit combinations are denied', async () => {
    const realm = await createRealm({ label: 'InvalidA' });
    const other = await createRealm({ label: 'InvalidB' });
    const token = await adminToken();

    // Unit of another Building addressed through this Building → 404.
    const wrongUnit = await api()
      .get(`${V1}/buildings/${realm.building.id}/units/${other.unitId}`)
      .set(auth(token));
    assert.equal(wrongUnit.status, 404);
    assert.equal(wrongUnit.body.error.code, 'APARTMENT_UNIT_NOT_FOUND');

    // Party of another Client → the same 404 as an unknown party.
    const foreignParty = await assignParty(token, realm.building.id, realm.unitId, {
      tenantCompanyId: other.tenant.id,
      partyRole: 'OCCUPANT',
    });
    assert.equal(foreignParty.status, 404);
    assert.equal(foreignParty.body.error.code, 'TENANT_COMPANY_NOT_FOUND');

    // Floor filter from another Building → 400.
    const wrongFloor = await api()
      .get(`${V1}/buildings/${realm.building.id}/units`)
      .query({ floorId: other.floorId })
      .set(auth(token));
    assert.equal(wrongFloor.status, 400);
    assert.equal(wrongFloor.body.error.code, 'APARTMENT_UNIT_FLOOR_MISMATCH');

    // Role assignment on a Unit of another Building → 404, never an update.
    const wrongUnitAssign = await assignParty(
      token,
      other.building.id,
      realm.unitId,
      { tenantCompanyId: other.tenant.id, partyRole: 'OWNER' },
    );
    assert.equal(wrongUnitAssign.status, 404);
    assert.equal(wrongUnitAssign.body.error.code, 'APARTMENT_UNIT_NOT_FOUND');
  });

  it('5: Customer Care reads only ACTIVE catalogue services of its Building Client', async () => {
    const realm = await createRealm({ label: 'Catalogue' });
    const care = await createCareStaff(realm.building.id);

    const services = await api()
      .get(`${V1}/handyman/care/buildings/${realm.building.id}/catalogue/services`)
      .set(auth(care.token));
    assert.equal(services.status, 200, JSON.stringify(services.body));
    const entries = services.body.data as {
      service: { id: string; code: string; status: string };
      variants: unknown[];
    }[];
    assert.ok(entries.some((entry) => entry.service.id === realm.service.id));

    await serviceCatalogService.deactivateServiceCatalogEntry(
      realm.service.id,
      adminUserId,
    );

    const after = await api()
      .get(`${V1}/handyman/care/buildings/${realm.building.id}/catalogue/services`)
      .set(auth(care.token));
    assert.equal(after.status, 200);
    assert.equal(
      (after.body.data as { service: { id: string } }[]).some(
        (entry) => entry.service.id === realm.service.id,
      ),
      false,
    );
  });

  it('6: cross-Building access is denied for master and Care surfaces', async () => {
    const mine = await createRealm({ label: 'Mine' });
    // The foreign realm is provisioned by the administrator (so the master
    // rows exist), then the assignment is revoked: the same authenticated
    // caller must lose every surface of that Building.
    const foreign = await createRealm({ label: 'Foreign' });
    const token = await adminToken();
    await buildingAssignmentService.deactivateAssignment(
      adminUserId,
      foreign.building.id,
      adminUserId,
    );

    const units = await api()
      .get(`${V1}/buildings/${foreign.building.id}/units`)
      .set(auth(token));
    assert.equal(units.status, 403);
    assert.equal(units.body.error.code, 'BUILDING_ACCESS_DENIED');

    const parties = await api()
      .get(`${unitPath(foreign.building.id, foreign.unitId)}/parties`)
      .set(auth(token));
    assert.equal(parties.status, 403);

    const care = await createCareStaff(mine.building.id);
    const careForeign = await api()
      .get(`${V1}/handyman/care/buildings/${foreign.building.id}/units`)
      .query({ tenantCompanyId: foreign.tenant.id })
      .set(auth(care.token));
    assert.equal(careForeign.status, 403);
    assert.equal(
      careForeign.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );
  });

  it('7: PR #43 intake is preserved and records independent approval / cost-responsibility parties', async () => {
    const realm = await createRealm({ label: 'Gateway' });
    const care = await createCareStaff(realm.building.id);

    // The Owner holds a current Unit role, so it is a legitimate payer.
    const ownerRole = await assignParty(
      await adminToken(),
      realm.building.id,
      realm.unitId,
      { tenantCompanyId: realm.owner.id, partyRole: 'OWNER' },
    );
    assert.equal(ownerRole.status, 201, JSON.stringify(ownerRole.body));

    const body = {
      tenantCompanyId: realm.tenant.id,
      tenantPicId: realm.picId,
      spaceId: realm.unitId,
      serviceCatalogId: realm.service.id,
      description: 'AC leaking in unit 10-01',
      costResponsibleTenantCompanyId: realm.owner.id,
    };
    const created = await api()
      .post(`${V1}/handyman/care/buildings/${realm.building.id}/requests`)
      .set(auth(care.token))
      .set('Idempotency-Key', `master-ind-${suffix()}`)
      .send(body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Canonical PR #43 projection is unchanged (no party fields, INTAKE).
    assert.equal(created.body.data.status, 'INTAKE');
    assert.equal(created.body.data.spaceId, realm.unitId);
    assert.equal(created.body.data.approvalTenantCompanyId, undefined);
    assert.equal(created.body.data.costResponsibleTenantCompanyId, undefined);

    const parties = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${created.body.data.id}/parties`,
      )
      .set(auth(care.token));
    assert.equal(parties.status, 200, JSON.stringify(parties.body));
    assert.equal(parties.body.data.requestId, created.body.data.id);
    const rows = parties.body.data.parties as {
      partyRole: string;
      tenantCompanyId: string;
      partyKind: string;
    }[];
    const approval = rows.find((row) => row.partyRole === 'APPROVAL');
    const cost = rows.find((row) => row.partyRole === 'COST_RESPONSIBILITY');
    assert.equal(approval?.tenantCompanyId, realm.tenant.id);
    assert.equal(cost?.tenantCompanyId, realm.owner.id);
    assert.equal(cost?.partyKind, 'LEGAL_ENTITY');

    // The request remains discoverable through the existing Care read.
    const detail = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${created.body.data.id}`,
      )
      .set(auth(care.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.request.id, created.body.data.id);
  });

  it('8: a cost party with no relationship to the Unit is denied without disclosure', async () => {
    const realm = await createRealm({ label: 'Stranger' });
    const care = await createCareStaff(realm.building.id);
    const stranger = await createIndividual(
      realm.client.id,
      'Unrelated Party',
      ktp(),
    );

    const created = await api()
      .post(`${V1}/handyman/care/buildings/${realm.building.id}/requests`)
      .set(auth(care.token))
      .set('Idempotency-Key', `master-ind-${suffix()}`)
      .send({
        tenantCompanyId: realm.tenant.id,
        spaceId: realm.unitId,
        serviceCatalogId: realm.service.id,
        costResponsibleTenantCompanyId: stranger.id,
      });
    assert.equal(created.status, 403);
    assert.equal(created.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    // Nothing was persisted for the denied submission.
    const rows = await pool.query(
      `SELECT count(*)::int AS count FROM handyman_service_requests r
        JOIN handyman_channel_attributions ca ON ca.id = r.channel_attribution_id
       WHERE ca.building_id = $1`,
      [realm.building.id],
    );
    assert.equal(rows.rows[0].count, 0);
  });

  it('9: catalogue administration exposes categories, variants and material references', async () => {
    const realm = await createRealm({ label: 'Admin' });
    const token = await adminToken();

    const categories = await api()
      .get(`${V1}/service-catalog/categories`)
      .query({ clientId: realm.client.id })
      .set(auth(token));
    assert.equal(categories.status, 200, JSON.stringify(categories.body));
    assert.ok((categories.body.data as string[]).includes('AIR_CONDITIONING'));

    const variant = await api()
      .post(`${V1}/service-catalog/entries/${realm.service.id}/variants`)
      .set(auth(token))
      .send({ code: 'SPLIT_1PK', name: 'Split 1 PK' });
    assert.equal(variant.status, 201, JSON.stringify(variant.body));
    assert.equal(variant.body.data.clientId, realm.client.id);

    const variants = await api()
      .get(`${V1}/service-catalog/entries/${realm.service.id}/variants`)
      .query({ status: 'ACTIVE' })
      .set(auth(token));
    assert.equal(variants.status, 200, JSON.stringify(variants.body));
    assert.equal(variants.body.data.length, 1);
    assert.equal(variants.body.data[0].id, variant.body.data.id);

    const item = await inventoryItemService.createInventoryItem(
      {
        clientId: realm.client.id,
        code: `MAT_${suffix()}`,
        name: 'R32 refrigerant',
        itemType: 'CONSUMABLE',
      },
      adminUserId,
    );

    const material = await api()
      .post(
        `${V1}/service-catalog/entries/${realm.service.id}/material-profiles`,
      )
      .set(auth(token))
      .send({
        inventoryItemId: item.id,
        serviceVariantId: variant.body.data.id,
        typicalQuantity: 1.5,
        commonality: 'COMMON',
        customerMaterialOption: 'PROVIDER_SUPPLIED',
      });
    assert.equal(material.status, 201, JSON.stringify(material.body));
    assert.equal(material.body.data.inventoryItemId, item.id);
    assert.equal(material.body.data.serviceVariantId, variant.body.data.id);

    const materials = await api()
      .get(
        `${V1}/service-catalog/entries/${realm.service.id}/material-profiles`,
      )
      .set(auth(token));
    assert.equal(materials.status, 200, JSON.stringify(materials.body));
    assert.equal(materials.body.data.length, 1);

    // Cross-Client catalogue administration is denied by the existing rule.
    const foreign = await createRealm({ label: 'CatalogueForeign' });
    await buildingAssignmentService.deactivateAssignment(
      adminUserId,
      foreign.building.id,
      adminUserId,
    );
    const denied = await api()
      .get(`${V1}/service-catalog/entries/${foreign.service.id}/variants`)
      .set(auth(token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

/** The suite administrator session created in `before()`. */
function adminToken(): string {
  return adminSession;
}
