import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { areaService } from '../src/modules/areas';
import { floorService } from '../src/modules/floors';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { vendorAssignmentService } from '../src/modules/vendor-assignments';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-23H — Vendor / Tenant KPI focused validation.
 *
 * Covers ONLY the BE-23H KPI surface:
 *  - Vendor work completion
 *  - Vendor overdue work
 *  - Vendor performance summary
 *  - Tenant service request count
 *  - Tenant service completed / open
 *  - Tenant service completion rate
 *
 * Plus the access rules the KPI must not break: RBAC, Building access
 * assertion, multi-Building rollup, and Client isolation.
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
       vendor_works, vendor_assignments,
       vendor_building_relationships, vendors,
       tenant_service_requests, tenant_space_relationships,
       tenant_building_contexts, tenant_pics, tenant_companies,
       work_orders, work_requests,
       spaces, rooms, areas, floors,
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
const dayOffset = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const KPI_PATH = '/api/v1/reports/vendor-tenant-kpi';

async function kpi(query: Record<string, string>, token = managerToken) {
  return api().get(KPI_PATH).query(query).set(auth(token));
}

/**
 * Builds a Vendor + Tenant fixture.
 *
 * Vendor work rows are advanced directly in the BE-15B store so the test
 * can pin exact lifecycle states and execution windows, and assignment
 * dates are back-dated so the age-based overdue rule can be asserted —
 * the KPI is a read model over precisely those authoritative columns.
 */
async function seed() {
  // Each test re-seeds and the manager accumulates access to every
  // Building created so far, so clear the operational stores first to
  // keep the multi-Building rollup deterministic.
  await pool!.query(
    `TRUNCATE
       vendor_works, vendor_assignments,
       vendor_building_relationships, vendors,
       tenant_service_requests
     CASCADE`,
  );

  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Vendor tenant KPI client',
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
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  // A separate Client / Building the manager can NOT access.
  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });

  /* ---------------- Vendors (BE-06 / BE-15) ---------------- */

  async function makeVendor(name: string) {
    const vendor = await vendorService.createVendor({
      clientId: clientA.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: name,
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: buildingA.id,
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: buildingB.id,
    });
    return vendor;
  }

  const acme = await makeVendor('Acme Services');
  const globex = await makeVendor('Globex Maintenance');

  /**
   * Creates a Work Order, a vendor assignment and its vendor work, then
   * forces the work into the requested lifecycle state. `assignedDaysAgo`
   * back-dates the assignment so the age-based overdue rule can bite.
   */
  async function makeVendorWork(options: {
    vendorId: string;
    buildingId: string;
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED';
    assignedDaysAgo: number;
    durationHours?: number;
  }) {
    const wo = await workOrderService.createWorkOrder({
      clientId: clientA.id,
      buildingId: options.buildingId,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Vendor work order',
      workType: 'REPAIR',
      createdByUserId: managerUserId,
    });
    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: options.vendorId,
      workOrderId: wo.id,
      assignedByUserId: managerUserId,
    });

    const assignedAt = new Date(
      Date.now() - options.assignedDaysAgo * 86400000,
    );
    await pool!.query(
      'UPDATE vendor_assignments SET assigned_at = $2 WHERE id = $1',
      [assignment.id, assignedAt],
    );

    const workId = randomUUID();
    const startedAt =
      options.status === 'NOT_STARTED' ? null : assignedAt.toISOString();
    const completedAt =
      options.status === 'COMPLETED'
        ? new Date(
            assignedAt.getTime() + (options.durationHours ?? 1) * 3600000,
          ).toISOString()
        : null;

    await pool!.query(
      `INSERT INTO vendor_works
         (id, vendor_assignment_id, vendor_id, work_order_id, building_id,
          status, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        workId,
        assignment.id,
        options.vendorId,
        wo.id,
        options.buildingId,
        options.status,
        startedAt,
        completedAt,
      ],
    );
    return workId;
  }

  // Acme in Building A: 2 completed (2h + 4h), 1 stale IN_PROGRESS (overdue).
  await makeVendorWork({
    vendorId: acme.id,
    buildingId: buildingA.id,
    status: 'COMPLETED',
    assignedDaysAgo: 20,
    durationHours: 2,
  });
  await makeVendorWork({
    vendorId: acme.id,
    buildingId: buildingA.id,
    status: 'COMPLETED',
    assignedDaysAgo: 15,
    durationHours: 4,
  });
  await makeVendorWork({
    vendorId: acme.id,
    buildingId: buildingA.id,
    status: 'IN_PROGRESS',
    assignedDaysAgo: 30,
  });

  // Globex in Building A: 1 fresh NOT_STARTED (not overdue), 1 stale ON_HOLD.
  await makeVendorWork({
    vendorId: globex.id,
    buildingId: buildingA.id,
    status: 'NOT_STARTED',
    assignedDaysAgo: 1,
  });
  await makeVendorWork({
    vendorId: globex.id,
    buildingId: buildingA.id,
    status: 'ON_HOLD',
    assignedDaysAgo: 45,
  });

  // Acme in Building B: 1 completed, for the rollup.
  await makeVendorWork({
    vendorId: acme.id,
    buildingId: buildingB.id,
    status: 'COMPLETED',
    assignedDaysAgo: 10,
    durationHours: 6,
  });

  /* ---------------- Tenant service requests (BE-14E) ---------------- */

  const floor = await floorService.createFloor({
    buildingId: buildingA.id,
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
    name: 'Tenant space',
  });

  const company = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Co' })
  ).body.data;
  const pic = (
    await api()
      .post(`/api/v1/tenant-companies/${company.id}/pics`)
      .set(auth())
      .send({ picName: 'Tenant PIC', email: `pic-${suffix().toLowerCase()}@t.example.com` })
  ).body.data;
  await api()
    .post(`/api/v1/tenant-companies/${company.id}/spaces`)
    .set(auth())
    .send({ buildingId: buildingA.id, spaceId: space.id });
  await api()
    .post(`/api/v1/tenant-companies/${company.id}/building-contexts`)
    .set(auth())
    .send({ buildingId: buildingA.id });

  /**
   * Creates a tenant service request. `workOrderStatus` drives the
   * CONVERTED path: BE-14E's own status has no COMPLETED state, so
   * fulfilment is expressed on the linked BE-08 Work Order.
   */
  async function makeServiceRequest(options: {
    requestType?: string;
    priority?: string;
    cancel?: boolean;
    workOrderStatus?: 'OPEN' | 'COMPLETED' | 'CLOSED';
  }) {
    const created = await api()
      .post(`/api/v1/tenant-companies/${company.id}/service-requests`)
      .set(auth())
      .send({
        tenantPicId: pic.id,
        buildingId: buildingA.id,
        spaceId: space.id,
        requestNumber: `TSR_${suffix()}`,
        requestType: options.requestType ?? 'MAINTENANCE',
        title: 'Tenant service request',
        ...(options.priority ? { priority: options.priority } : {}),
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    if (options.cancel) {
      await pool!.query(
        `UPDATE tenant_service_requests SET status = 'CANCELLED' WHERE id = $1`,
        [requestId],
      );
      return requestId;
    }

    if (options.workOrderStatus) {
      // Convert: create the BE-08 Work Request + Work Order, then set the
      // Work Order's authoritative lifecycle state.
      const wrId = randomUUID();
      await pool!.query(
        `INSERT INTO work_requests
           (id, client_id, building_id, request_number, title, request_type,
            status, requested_by_user_id)
         VALUES ($1,$2,$3,$4,'Tenant work request','REPAIR','CONVERTED',$5)`,
        [wrId, clientA.id, buildingA.id, `WR_${suffix()}`, managerUserId],
      );
      const wo = await workOrderService.createWorkOrder({
        clientId: clientA.id,
        buildingId: buildingA.id,
        workOrderNumber: `WO_${suffix()}`,
        title: 'Tenant work order',
        workType: 'REPAIR',
        createdByUserId: managerUserId,
      });
      if (options.workOrderStatus !== 'OPEN') {
        await pool!.query(
          `UPDATE work_orders
              SET status = $2,
                  started_at = NOW() - interval '2 hours',
                  completed_at = NOW() - interval '1 hour',
                  completed_by_user_id = $3,
                  completion_summary = 'Done'
            WHERE id = $1`,
          [wo.id, options.workOrderStatus, managerUserId],
        );
      }
      await pool!.query(
        `UPDATE tenant_service_requests
            SET status = 'CONVERTED', work_request_id = $2, work_order_id = $3
          WHERE id = $1`,
        [requestId, wrId, wo.id],
      );
    }

    return requestId;
  }

  // 6 requests: 2 OPEN, 2 CONVERTED+COMPLETED, 1 CONVERTED+still OPEN WO,
  // 1 CANCELLED.
  await makeServiceRequest({ priority: 'HIGH' });
  await makeServiceRequest({ priority: 'LOW', requestType: 'CLEANING' });
  await makeServiceRequest({ workOrderStatus: 'COMPLETED' });
  await makeServiceRequest({ workOrderStatus: 'CLOSED', priority: 'CRITICAL' });
  await makeServiceRequest({ workOrderStatus: 'OPEN' });
  await makeServiceRequest({ cancel: true });

  return {
    clientA,
    buildingA,
    buildingB,
    buildingC,
    acme,
    globex,
    company,
  };
}

describe('BE-23H vendor / tenant KPI', () => {
  it('reports vendor work completion for one building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.deepEqual(data.buildingScope, [f.buildingA.id]);

    const vendorWork = data.vendorWork;
    // 5 vendor works in Building A.
    assert.equal(vendorWork.total, 5);
    assert.equal(vendorWork.completed, 2);
    assert.equal(vendorWork.inProgress, 1);
    assert.equal(vendorWork.onHold, 1);
    assert.equal(vendorWork.notStarted, 1);
    assert.equal(vendorWork.outstanding, 3);
    // 2 / 5
    assert.equal(vendorWork.completionRate, 40);
    // (2h + 4h) / 2
    assert.equal(vendorWork.averageCompletionHours, 3);
  });

  it('counts vendor overdue work and honours overdueAfterDays', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Default threshold is 7 days: the 30-day IN_PROGRESS and the
    // 45-day ON_HOLD are overdue; the 1-day NOT_STARTED is not.
    const byDefault = await kpi({ buildingId: f.buildingA.id });
    assert.equal(byDefault.status, 200, JSON.stringify(byDefault.body));
    assert.equal(byDefault.body.data.overdueAfterDays, 7);
    assert.equal(byDefault.body.data.vendorWork.overdue, 2);

    // A very wide threshold means nothing is late yet.
    const lenient = await kpi({
      buildingId: f.buildingA.id,
      overdueAfterDays: '90',
    });
    assert.equal(lenient.body.data.overdueAfterDays, 90);
    assert.equal(lenient.body.data.vendorWork.overdue, 0);

    // Zero tolerance makes every unfinished work overdue.
    const strict = await kpi({
      buildingId: f.buildingA.id,
      overdueAfterDays: '0',
    });
    assert.equal(strict.body.data.vendorWork.overdue, 3);
    // Completed work is never overdue.
    assert.ok(
      strict.body.data.vendorWork.overdue <=
        strict.body.data.vendorWork.outstanding,
      'overdue must never exceed outstanding',
    );
  });

  it('summarises performance per vendor', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const performance = response.body.data.vendorPerformance;

    assert.equal(performance.length, 2);

    const acme = performance.find(
      (v: { vendorId: string }) => v.vendorId === f.acme.id,
    );
    assert.ok(acme, 'expected Acme in the performance summary');
    assert.equal(acme.vendorName, 'Acme Services');
    assert.equal(acme.total, 3);
    assert.equal(acme.completed, 2);
    assert.equal(acme.outstanding, 1);
    assert.equal(acme.overdue, 1);
    // 2 / 3
    assert.equal(acme.completionRate, 66.67);
    assert.equal(acme.averageCompletionHours, 3);

    const globex = performance.find(
      (v: { vendorId: string }) => v.vendorId === f.globex.id,
    );
    assert.ok(globex, 'expected Globex in the performance summary');
    assert.equal(globex.total, 2);
    assert.equal(globex.completed, 0);
    assert.equal(globex.outstanding, 2);
    assert.equal(globex.overdue, 1);
    assert.equal(globex.completionRate, 0);
    // Nothing measurable -> never divide by zero.
    assert.equal(globex.averageCompletionHours, 0);

    // Ordered by completions descending.
    assert.equal(performance[0].vendorId, f.acme.id);
  });

  it('narrows the vendor KPI by vendorId', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({
      buildingId: f.buildingA.id,
      vendorId: f.globex.id,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.vendorWork.total, 2);
    assert.equal(response.body.data.vendorWork.completed, 0);
    assert.equal(response.body.data.vendorPerformance.length, 1);
    assert.equal(response.body.data.vendorPerformance[0].vendorId, f.globex.id);
  });

  it('reports tenant service request counts, open/completed and rate', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const tenant = response.body.data.tenantService;

    assert.equal(tenant.total, 6);
    assert.equal(tenant.open, 2);
    assert.equal(tenant.converted, 3);
    assert.equal(tenant.cancelled, 1);
    // Completion comes from the linked BE-08 Work Order (COMPLETED/CLOSED).
    assert.equal(tenant.completed, 2);
    // 2 OPEN + 1 CONVERTED whose work order is still open.
    assert.equal(tenant.outstanding, 3);
    // 2 completed / 5 actionable (cancelled excluded)
    assert.equal(tenant.completionRate, 40);

    assert.equal(tenant.byPriority.high, 1);
    assert.equal(tenant.byPriority.low, 1);
    assert.equal(tenant.byPriority.critical, 1);
  });

  it('narrows tenant requests by tenant company and request type', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const byCompany = await kpi({
      buildingId: f.buildingA.id,
      tenantCompanyId: f.company.id,
    });
    assert.equal(byCompany.status, 200, JSON.stringify(byCompany.body));
    assert.equal(byCompany.body.data.tenantService.total, 6);

    const byType = await kpi({
      buildingId: f.buildingA.id,
      requestType: 'CLEANING',
    });
    assert.equal(byType.body.data.tenantService.total, 1);
    assert.equal(byType.body.data.tenantService.open, 1);
    assert.equal(byType.body.data.tenantService.completed, 0);
    assert.equal(byType.body.data.tenantService.completionRate, 0);

    // An unrelated company yields nothing.
    const otherCompany = await kpi({
      buildingId: f.buildingA.id,
      tenantCompanyId: randomUUID(),
    });
    assert.equal(otherCompany.body.data.tenantService.total, 0);
  });

  it('filters by date range', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Vendor works are windowed on assignment date; the newest is 1 day
    // old, so a window covering only the last 2 days sees just that one.
    const recent = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(-2),
      dateTo: dayOffset(0),
    });
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    assert.equal(recent.body.data.vendorWork.total, 1);
    assert.equal(recent.body.data.vendorWork.notStarted, 1);
    // Tenant requests were all raised today, so they remain in range.
    assert.equal(recent.body.data.tenantService.total, 6);

    // A window in the future contains nothing at all.
    const future = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(30),
      dateTo: dayOffset(31),
    });
    assert.equal(future.body.data.vendorWork.total, 0);
    assert.equal(future.body.data.tenantService.total, 0);
    assert.deepEqual(future.body.data.vendorPerformance, []);
  });

  it('rolls up across every accessible building when buildingId is omitted', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, null);
    assert.ok(data.buildingScope.includes(f.buildingA.id));
    assert.ok(data.buildingScope.includes(f.buildingB.id));
    // Building C belongs to another Client the manager cannot access.
    assert.ok(!data.buildingScope.includes(f.buildingC.id));

    // Building A's 5 vendor works + Building B's 1.
    assert.equal(data.vendorWork.total, 6);
    assert.equal(data.vendorWork.completed, 3);
    assert.equal(data.vendorWork.completionRate, 50);
    // (2h + 4h + 6h) / 3
    assert.equal(data.vendorWork.averageCompletionHours, 4);

    // Tenant requests all live in Building A.
    assert.equal(data.tenantService.total, 6);
  });

  it('denies access to a building the caller is not assigned to', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingC.id });
    assert.equal(response.status, 403, JSON.stringify(response.body));
  });

  it('requires authentication and the vendor_tenant_kpi.read permission', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const anonymous = await api()
      .get(KPI_PATH)
      .query({ buildingId: f.buildingA.id });
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

    const plainToken = await createPlainSession();
    const forbidden = await kpi({ buildingId: f.buildingA.id }, plainToken);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  });

  it('rejects malformed KPI query parameters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const badBuilding = await kpi({ buildingId: 'not-a-uuid' });
    assert.equal(badBuilding.status, 400, JSON.stringify(badBuilding.body));

    const badVendor = await kpi({
      buildingId: f.buildingA.id,
      vendorId: 'nope',
    });
    assert.equal(badVendor.status, 400, JSON.stringify(badVendor.body));

    const badRange = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(5),
      dateTo: dayOffset(1),
    });
    assert.equal(badRange.status, 400, JSON.stringify(badRange.body));

    const badOverdue = await kpi({
      buildingId: f.buildingA.id,
      overdueAfterDays: '-3',
    });
    assert.equal(badOverdue.status, 400, JSON.stringify(badOverdue.body));

    const badDate = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: 'never',
    });
    assert.equal(badDate.status, 400, JSON.stringify(badDate.body));
  });

  it('returns a zeroed KPI when the window contains nothing', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(60),
      dateTo: dayOffset(61),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.vendorWork.total, 0);
    assert.equal(data.vendorWork.completed, 0);
    assert.equal(data.vendorWork.overdue, 0);
    // Never divide by zero.
    assert.equal(data.vendorWork.completionRate, 0);
    assert.equal(data.vendorWork.averageCompletionHours, 0);
    assert.deepEqual(data.vendorPerformance, []);

    assert.equal(data.tenantService.total, 0);
    assert.equal(data.tenantService.completed, 0);
    assert.equal(data.tenantService.completionRate, 0);
  });
});
