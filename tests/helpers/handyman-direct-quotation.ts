import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../../src/database';
import { sessionService } from '../../src/modules/auth/session.service';
import { areaService } from '../../src/modules/areas';
import { buildingAssignmentService } from '../../src/modules/building-assignments';
import { buildingService } from '../../src/modules/buildings';
import { clientService } from '../../src/modules/clients';
import { floorService } from '../../src/modules/floors';
import { grantCareActorProperty, handymanCareActorService } from '../../src/modules/handyman-care-actors';
import { signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../../src/modules/handyman-care-workspace/care-workspace.service';
import { handymanDisciplineRepository } from '../../src/modules/handyman-disciplines';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../../src/modules/handyman-handoff';
import { signPicWorkspaceAssertion, type PicWorkspaceAssertion } from '../../src/modules/handyman-pic-session';
import { propertyService } from '../../src/modules/properties';
import { roomService } from '../../src/modules/rooms';
import { serviceCatalogService } from '../../src/modules/service-catalog';
import { spaceService } from '../../src/modules/spaces';
import { tenantBuildingContextService } from '../../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../../src/modules/tenant-companies';
import { tenantPicService } from '../../src/modules/tenant-pics';
import { tenantSpaceService } from '../../src/modules/tenant-spaces';
import { createFieldInspectorSession, createSessionWithPermissions } from './access';
import { api } from './http';
import { ensureTestDatabase } from './postgres';

/** Isolated test-only fixtures reused by direct-policy PostgreSQL and E2E tests.
 * Existing scoped RBAC helpers; no Platform Admin or production provisioning.
 * Business requests enter through signed Care HTTP, not raw SQL fixtures.
 */
let PORT = 55509;
const HM = '/api/v1/handyman/requests';
const HQ = '/api/v1/handyman/quotations';
const HV = '/api/v1/handyman/quotation-versions';
const CARE = '/api/v1/handyman/care';
const PIC = '/api/v1/handyman/pic';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const OPS_CODES = [
  'tenant_company.read', 'tenant_company.manage',
  'handyman.operations.request.read', 'handyman.operations.request.triage',
  'handyman.operations.inspection.assign', 'handyman.operations.inspection.report.review',
  'handyman.quotation.approval.binding.manage',
];
type Actor = { token: string; userId: string };
let pg: EmbeddedPostgres | undefined;
let dataDir: string | undefined;
let pool: Pool | undefined;
let ops: Actor;
let otherOps: Actor;
let field: Actor;
let wrongField: Actor;
let otherField: Actor;
let clientId: string;
let propertyId: string;
let buildingId: string;
let spaceId: string;
let tenantCompanyId: string;
let tenantPicId: string;
let catalogId: string;
let disciplineId: string;
let uomId: string;
let careCode: string;
let picCode: string;
let careActorId: string;
let picIntegrationId: string;
const actorReference = `direct-policy-care-${randomUUID()}`;
const secrets = { care: randomBytes(32).toString('hex'), pic: randomBytes(32).toString('hex') };
const envKeys: string[] = [];
const q = (text: string, params: unknown[] = []) => {
  assert.ok(pool, 'isolated database initialized');
  return pool.query(text, params);
};
export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
// Error-only diagnostic: never print admission tokens, signed assertions or secrets.
export function status(response: { status: number; body: any }, expected: number, label: string) {
  assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.body?.error ?? {})}`);
}
export function denied(response: { status: number; body: any }, expected: number, code: string, label: string) {
  status(response, expected, label);
  assert.equal(response.body.error.code, code, label);
}
async function operator(codes: string[], buildings: string[]): Promise<Actor> {
  const token = await createSessionWithPermissions(codes.map(code => ({ code, name: code })));
  const { userId } = await sessionService.resolveSessionContext(token);
  for (const building of buildings) {
    await buildingAssignmentService.createAssignment(userId, { buildingId: building });
  }
  return { userId, token };
}

export async function startDirectQuotationFixture(port: number) {
  PORT = port;
  // Fail, never silently skip or fall back to a pre-existing database.
  assert.equal(process.env.ASENTRA_USE_EMBEDDED_POSTGRES, 'true', 'Use isolated embedded PostgreSQL for Direct policy');
  dataDir = await mkdtemp(join(tmpdir(), 'handyman-direct-policy-'));
  pg = new EmbeddedPostgres({ databaseDir: dataDir, port: PORT, user: 'postgres',
    password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise();
  await pg.start();
  Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
    DB_PASSWORD: '', DB_NAME: `handyman_direct_policy_${suffix().toLowerCase()}`, DB_SSL: 'false' });
  const config = await ensureTestDatabase();
  assert.ok(config, 'Direct policy requires a fresh isolated PostgreSQL database');
  pool = await initDatabase(config);
  await migrateUp(pool);

  const client = await clientService.createClient({ code: `D_${suffix()}`, name: 'Direct policy client' });
  clientId = client.id;
  const property = await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Direct policy property' });
  propertyId = property.id;
  const building = await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Journey building' });
  buildingId = building.id;
  const other = await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Other building, same client' });
  ops = await operator(OPS_CODES, [buildingId]);
  otherOps = await operator(OPS_CODES, [other.id]);
  // Separate fixture master-data grantor; no broad admin or permission-management authority.
  const master = await operator(['property.manage', 'tenant_company.manage', 'uom.manage', 'service_catalog.manage', 'service_catalog.read'], [buildingId]);
  field = await createFieldInspectorSession();
  wrongField = await createFieldInspectorSession();
  otherField = await createFieldInspectorSession();
  for (const actor of [field, wrongField]) {
    await buildingAssignmentService.createAssignment(actor.userId, { buildingId });
  }
  await buildingAssignmentService.createAssignment(otherField.userId, { buildingId: other.id });
  const floor = await floorService.createFloor({ buildingId, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  spaceId = (await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Tenant unit' })).id;
  tenantCompanyId = (await tenantCompanyService.createTenantCompany({ clientId,
    tenantCode: `T_${suffix()}`, tenantName: 'Journey tenant' }, master.userId)).id;
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId, buildingId, spaceId }, master.userId);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId, buildingId }, master.userId);
  // PIC is a represented customer, not a fabricated local staff principal.
  tenantPicId = (await tenantPicService.createTenantPic({ tenantCompanyId, picName: 'Tenant approver',
    email: 'direct-policy-pic@example.com' }, master.userId)).id;
  catalogId = (await serviceCatalogService.createServiceCatalogEntry({ clientId, code: `HM_${suffix()}`,
    name: 'Repair service', category: 'HANDYMAN' }, master.userId)).id;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  disciplineId = discipline.id;
  const uom = await api().post(`/api/v1/clients/${clientId}/uoms`).set(auth(master.token))
    .send({ code: `H_${suffix()}`, name: 'Hour', symbol: 'h', category: 'TIME' });
  status(uom, 201, 'fixture UOM');
  uomId = uom.body.data.id;

  // Channel-level integration fixtures, not tenant-specific provisioning.
  // The existing capability is exclusive, so Care and PIC use separate records.
  careCode = `D_CARE_${suffix()}`;
  picCode = `D_PIC_${suffix()}`;
  const careIntegration = await handoffRuntimeRepository.createIntegration({ integrationCode: careCode, displayName: 'Test-only BM Care channel' });
  const picIntegration = await handoffRuntimeRepository.createIntegration({ integrationCode: picCode, displayName: 'Test-only BM PIC channel' });
  picIntegrationId = picIntegration.id;
  for (const [code, secret] of [[careCode, secrets.care], [picCode, secrets.pic]]) {
    const key = handoffIntegrationSecretEnvName(code);
    assert.equal(process.env[key], undefined, 'unique test integration must not overwrite a secret');
    process.env[key] = secret;
    envKeys.push(key);
  }
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: careIntegration.id, capability: 'CUSTOMER_CARE' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: picIntegration.id, capability: 'TENANT_PIC' });
  careActorId = (await handymanCareActorService.createCareActor({ integrationId: careIntegration.id,
    actorReference, displayName: 'Direct policy Customer Care' })).id;
  await grantCareActorProperty({ careActorId, propertyId, clientId }, master.userId);
  const intake = async (extra: Record<string, unknown> = {}) => {
    const assertion: CareWorkspaceAssertion = {
      purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: careCode, assertionId: randomUUID(),
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
      actor: { type: 'CUSTOMER_CARE', actorReference },
    };
    const session = await api().post(`${CARE}/session`)
      .set('x-hub-signature-256', signCareWorkspaceAssertion(assertion, secrets.care)).send(assertion);
    status(session, 201, 'Care fixture session');
    const exchange = await api().post(`${CARE}/properties/${propertyId}/create-exchanges`)
      .set(auth(session.body.data.workspaceToken)).send({ tenantCompanyId, buildingId, spaceId });
    status(exchange, 201, 'Care fixture exchange');
    return api().post(`${HM}/care`).send({ exchangeToken: exchange.body.data.exchangeToken,
      serviceCatalogId: catalogId, description: 'Explicit direct-scope service request',
      reporter: { name: 'Customer reporter', phone: '+628111222333' }, ...extra });
  };
  return { q, close: closeDirectQuotationFixture, ops, otherOps, field, master, clientId, propertyId, buildingId, spaceId,
    tenantCompanyId, tenantPicId, catalogId, disciplineId, uomId, picCode, picIntegrationId,
    signPic: (assertion: PicWorkspaceAssertion) => signPicWorkspaceAssertion(assertion, secrets.pic),
    intake,
    createRequest: async () => { const r = await intake(); status(r, 201, 'Care intake'); return r.body.data; },
    configure: (inspectionPolicy: string) => api().patch(`/api/v1/service-catalog/entries/${catalogId}`)
      .set(auth(master.token)).send({ inspectionPolicy }),
  };
}


export async function closeDirectQuotationFixture() {
  for (const key of envKeys) delete process.env[key];
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

