import { randomUUID } from 'node:crypto';
import { areaService } from '../../src/modules/areas';
import { buildingAssignmentService } from '../../src/modules/building-assignments';
import { buildingService } from '../../src/modules/buildings';
import { clientService } from '../../src/modules/clients';
import { departmentService } from '../../src/modules/departments';
import { floorService } from '../../src/modules/floors';
import { createChannelAttribution }
  from '../../src/modules/handyman-channel-attributions';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../../src/modules/handyman-providers';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../../src/modules/handyman-quotations';
import { organizationService } from '../../src/modules/organizations';
import { positionService } from '../../src/modules/positions';
import { propertyService } from '../../src/modules/properties';
import { roomService } from '../../src/modules/rooms';
import { serviceCatalogService } from '../../src/modules/service-catalog';
import { spaceService } from '../../src/modules/spaces';
import { tenantBuildingContextService }
  from '../../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../../src/modules/tenant-companies';
import { tenantPicService } from '../../src/modules/tenant-pics';
import { tenantSpaceService } from '../../src/modules/tenant-spaces';
import { userService } from '../../src/modules/users';
import { vendorWorkforceService } from '../../src/modules/vendor-workforce';
import { vendorService } from '../../src/modules/vendors';
import { workforceService } from '../../src/modules/workforce';

/**
 * Shared CR-HM-07 fixture builder (PART 01–04 test suites). A kit is
 * initialized per suite with the seeded admin user + GENERAL_HANDYMAN
 * discipline and the suite's SQL runner; the same bodies previously
 * inlined in the 03B suite. No caching — every call creates fresh
 * rows.
 */

export type HandymanFixtureInit = {
  adminUserId: string;
  disciplineId: string;
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

let adminUserId = '';
let disciplineId = '';
let sql: HandymanFixtureInit['query'];

export function initHandymanFixtures(init: HandymanFixtureInit): void {
  adminUserId = init.adminUserId;
  disciplineId = init.disciplineId;
  sql = init.query;
}

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

export async function realmFixture(label = 'Realm') {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Worker Position',
  });
  return { client, property, building, organization, department,
    position };
}

export async function locationChain(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const floor = await floorService.createFloor({
    buildingId: realm.building.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
  return { floor, area, room, space };
}

export async function crewFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Field Providers',
  });
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `lead-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Lead',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `LEAD_${suffix()}`,
    fullName: 'Lead Worker',
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `CREW_${suffix()}`,
      name: 'Field Crew',
      leadWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  return {
    vendor, providerContext, leadUser: linkedUser,
    workerContext, crew: bundle.crew,
  };
}

export async function scopeFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  chain: Awaited<ReturnType<typeof locationChain>>,
) {
  const company = await tenantCompanyService.createTenantCompany({
    clientId: realm.client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    spaceId: chain.space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: chain.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: realm.client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'FM_HINT_TEXT',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: 'fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id }, adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = randomUUID();
  await sql(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'Hours', quantity: 1, uomId,
    currency: 'IDR', finalQuotedUnitAmount: 100,
  }, adminUserId);
  await issueHandymanQuotationVersion(version.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, adminUserId);
  const decision = await decideHandymanQuotation(version.id, {
    decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
  }, adminUserId);
  return { scope: decision.executionScope };
}

export async function baseFixture() {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  return { realm, chain, scope: f.scope };
}
