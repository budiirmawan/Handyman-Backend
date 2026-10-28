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
import { addHandymanServiceRequestItem } from '../../src/modules/handyman-parameterized-catalog';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
  setHandymanQuotationLineWarrantyTerms,
} from '../../src/modules/handyman-quotations';
import { updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../../src/modules/handyman-documents';
import { clientMonetaryContextService } from '../../src/modules/client-monetary-contexts';
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
import { assignBuildingToWorkforce }
  from '../../src/modules/workforce-building-assignments';
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
  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: realm.building.id,
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
    vendor, providerContext, leadUser: linkedUser, profile,
    workerContext, crew: bundle.crew,
  };
}

/**
 * CR-HM-FIELD-OPERATIONS-01 PART 04 (G-4 / AC-7) — Lead TRANSFER inside the
 * SAME crew: a second eligible worker is added to the existing crew and
 * designated Lead, so the Execution Scope assignment stays ACTIVE while the
 * authoritative CURRENT Lead changes. This is the only way to still reach
 * the certified `FAILED / ACTOR_ASSIGNMENT_INVALID` verdict once a
 * SUPERSEDED binding is refused earlier (PART 04 G-4), so the certified
 * behaviour keeps its own fixture instead of being inferred.
 */
export async function transferCrewLeadFixture(
  crew: Awaited<ReturnType<typeof crewFixture>>,
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const linkedUser = await userService.createUser({
    email: `lead2-${suffix().toLowerCase()}@example.com`,
    displayName: 'Second Crew Lead',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `LEAD2_${suffix()}`,
    fullName: 'Second Lead Worker',
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: realm.building.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: crew.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP2_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: crew.providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  await handymanWorkCrewService.addHandymanCrewMember(
    {
      handymanCrewId: crew.crew.id,
      handymanWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  await handymanWorkCrewService.designateHandymanCrewLead(
    {
      handymanCrewId: crew.crew.id,
      handymanWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  return { leadUser: linkedUser, profile, workerContext };
}

export async function scopeFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  chain: Awaited<ReturnType<typeof locationChain>>,
  options: { includeStructuredRequestItem?: boolean } = {},
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
  if (options.includeStructuredRequestItem) {
    await addHandymanServiceRequestItem(request.id, {
      serviceCatalogId: service.id, quantity: 1,
      attributeValues: { FIXTURE_SCOPE: 'populated-care-projection' },
      itemDescription: 'Existing persisted structured request item',
    }, adminUserId);
  }
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
  const fixtureLine = await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'Hours', quantity: 1, uomId,
    currency: 'IDR', finalQuotedUnitAmount: 100,
    // Issue gates (0519 price basis, 0522 warranty terms) require both
    // commercial records on every line before the version can issue.
    taxPriceBasis: 'GROSS_INCLUSIVE',
  }, adminUserId);
  await setHandymanQuotationLineWarrantyTerms(
    version.id, fixtureLine.id, { coverage: 'NONE' }, adminUserId,
  );
  // Issued quotation documents (0490–0492) pin an issuer profile, exactly one
  // ACTIVE QUOTATION settings language and an activated issuer bank account.
  // Created once per fixture Client; later per-suite callers that expect
  // "no profile yet" must reuse these rows instead of re-creating them.
  if (!(await sql(`SELECT 1 FROM handyman_document_issuer_profiles
    WHERE client_id=$1 AND status='ACTIVE' LIMIT 1`, [realm.client.id])).rows[0]) {
    await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null,
      legalName: 'PT Handyman Fixture', displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1',
      businessAddress: null, city: 'Jakarta', province: 'Jakarta', postalCode: '10110',
      email: 'issuer@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000',
      website: null, taxId: null, businessRegistrationId: null, logoReference: null }, adminUserId);
  }
  if (!(await sql(`SELECT 1 FROM handyman_document_issuer_document_settings
    WHERE client_id=$1 AND document_kind='QUOTATION' AND status='ACTIVE' LIMIT 1`, [realm.client.id])).rows[0]) {
    await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
      expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'],
      paymentNote: 'Transfer within seven days', warrantyNote: null, contactNote: null, footerNote: null,
      signatoryName: 'Manager', signatoryTitle: 'Operations' }, adminUserId);
  }
  if (!(await sql(`SELECT 1 FROM handyman_document_issuer_bank_accounts
    WHERE client_id=$1 LIMIT 1`, [realm.client.id])).rows[0]) {
    await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id,
      baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, adminUserId);
    const issuerBank = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK',
      bankName: 'Test Bank', accountNumber: '1234567890', accountHolderName: 'PT Issuer', currency: 'IDR' }, adminUserId);
    await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: issuerBank.bankAccountId,
      expectedVersion: issuerBank.version, confirmAccountNumber: '1234567890',
      verificationReference: 'Verified statement', asDefault: true, authorizeReplacement: false }, adminUserId);
  }
  await issueHandymanQuotationVersion(version.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, adminUserId);
  const offerRow=(await sql('SELECT id,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1',
    [version.id])).rows[0];
  const decision = await decideHandymanQuotation(version.id, {
    decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
    offerDocumentId: offerRow.id, offerPdfSha256: offerRow.pdf_sha256,
  }, linkedUser.id);
  return { scope: decision.executionScope };
}

export async function baseFixture(options: { includeStructuredRequestItem?: boolean } = {}) {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain, options);
  return { realm, chain, scope: f.scope };
}
