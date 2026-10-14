import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { createApp } from '../src/app';
import { closePool, getPool, initDatabase } from '../src/database/connection';
import { sessionService } from '../src/modules/auth/session.service';
import { userRepository } from '../src/modules/users/user.repository';
import { buildingAssignmentRepository } from '../src/modules/building-assignments/building-assignment.repository';
import { buildingRepository } from '../src/modules/buildings/building.repository';
import { propertyRepository } from '../src/modules/properties/property.repository';
import { clientRepository } from '../src/modules/clients/client.repository';
import { permissionService } from '../src/modules/permissions';

describe('CR-HM-FIELD-AUTHORITY-01 P1: Worker Profile Projection', () => {
  let pg: EmbeddedPostgres;
  let dbDir: string;
  let server: Server;
  let baseUrl: string;

  const origResolveSession = sessionService.resolveSessionContext;
  const origFindUser = userRepository.findById;
  const origListActiveByUser = buildingAssignmentRepository.listActiveByUser;
  const origFindBuilding = buildingRepository.findById;
  const origFindProperty = propertyRepository.findById;
  const origFindClient = clientRepository.findById;
  const origResolvePermissions = permissionService.resolvePermissionsForUser;

  const clientId = randomUUID();
  const otherClientId = randomUUID();
  const propertyId = randomUUID();
  const otherPropertyId = randomUUID();
  const buildingId = randomUUID();
  const otherBuildingId = randomUUID();
  const tenantCompanyId = randomUUID();
  const orgId = randomUUID();
  const vendorId = randomUUID();
  const providerCtxId = randomUUID();

  const picUserId = randomUUID();
  const helperUserId = randomUUID();
  const inspectorUserId = randomUUID();
  const opsUserId = randomUUID();
  const otherTenantUserId = randomUUID();

  const picWfId = randomUUID();
  const helperWfId = randomUUID();
  const inspWfId = randomUUID();

  const picWorkerCtxId = randomUUID();
  const helperWorkerCtxId = randomUUID();
  const inspWorkerCtxId = randomUUID();

  const crewId = randomUUID();
  const picMemId = randomUUID();
  const helperMemId = randomUUID();

  const skillPlumbingId = randomUUID();
  const skillElectricalId = randomUUID();
  const licenseId = randomUUID();
  const requestId = randomUUID();
  const scopeId = randomUUID();

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'hm-worker-prof-'));
    const port = 30000 + Math.floor(Math.random() * 2000);
    pg = new EmbeddedPostgres({
      databaseDir: dbDir,
      user: 'postgres',
      password: 'password',
      port,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();

    await initDatabase({
      host: '127.0.0.1',
      port,
      name: 'postgres',
      user: 'postgres',
      password: 'password',
      ssl: false,
      poolMin: 1,
      poolMax: 4,
    });

    const pool = getPool();
    await pool.query(`
      CREATE TABLE clients(id uuid PRIMARY KEY, status text NOT NULL);
      CREATE TABLE properties(id uuid PRIMARY KEY, client_id uuid NOT NULL, status text NOT NULL);
      CREATE TABLE buildings(id uuid PRIMARY KEY, client_id uuid NOT NULL, property_id uuid NOT NULL, code text NOT NULL, name text NOT NULL, status text NOT NULL);
      CREATE TABLE users(id uuid PRIMARY KEY, status text NOT NULL, full_name text NOT NULL, email text NOT NULL);
      CREATE TABLE user_building_assignments(
        id uuid PRIMARY KEY, user_id uuid NOT NULL, client_id uuid NOT NULL,
        property_id uuid NOT NULL, building_id uuid NOT NULL,
        assignment_role text NOT NULL DEFAULT 'FIELD', status text NOT NULL,
        assigned_by_user_id uuid, assigned_at timestamptz NOT NULL DEFAULT now(),
        unassigned_at timestamptz, notes text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE organizations(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, code text NOT NULL, name text NOT NULL,
        organization_type text NOT NULL DEFAULT 'VENDOR', description text,
        status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE vendors(id uuid PRIMARY KEY, client_id uuid NOT NULL, organization_id uuid NOT NULL, status text NOT NULL);
      CREATE TABLE vendor_licenses_certifications(
        id uuid PRIMARY KEY,
        vendor_id uuid NOT NULL,
        record_type text NOT NULL,
        name text NOT NULL,
        number text NOT NULL,
        issuing_authority text,
        issue_date timestamptz,
        expiry_date timestamptz,
        status text NOT NULL DEFAULT 'ACTIVE',
        document_reference text,
        notes text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_provider_contexts(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, vendor_id uuid NOT NULL,
        provider_code text NOT NULL DEFAULT 'PROV', status text NOT NULL,
        notes text, created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE workforce_profiles(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, organization_id uuid NOT NULL,
        department_id uuid, team_id uuid, position_id uuid,
        user_id uuid, employee_code text NOT NULL, full_name text NOT NULL,
        email text, phone text,
        workforce_type text NOT NULL DEFAULT 'EXTERNAL',
        employment_type text NOT NULL DEFAULT 'VENDOR',
        status text NOT NULL, notes text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE vendor_workforce_bindings(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, vendor_id uuid NOT NULL,
        workforce_profile_id uuid NOT NULL, status text NOT NULL,
        effective_from timestamptz, effective_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE workforce_building_assignments(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, workforce_profile_id uuid NOT NULL,
        property_id uuid NOT NULL, building_id uuid NOT NULL,
        assignment_role text NOT NULL DEFAULT 'HANDYMAN', is_primary boolean NOT NULL DEFAULT true,
        status text NOT NULL, assigned_by_user_id uuid,
        effective_from timestamptz, effective_until timestamptz,
        assigned_at timestamptz NOT NULL DEFAULT now(), unassigned_at timestamptz, notes text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE skills(
        id uuid PRIMARY KEY,
        code text NOT NULL,
        name text NOT NULL,
        category text NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE'
      );
      CREATE TABLE workforce_skill_assignments(
        id uuid PRIMARY KEY,
        workforce_profile_id uuid NOT NULL,
        skill_id uuid NOT NULL,
        proficiency_level text NOT NULL,
        valid_from timestamptz,
        valid_until timestamptz,
        status text NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_worker_contexts(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_provider_context_id uuid NOT NULL,
        workforce_profile_id uuid NOT NULL, worker_code text NOT NULL DEFAULT 'WKR',
        status text NOT NULL, notes text, created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_work_crews(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_provider_context_id uuid NOT NULL,
        building_id uuid, code text NOT NULL, name text NOT NULL, status text NOT NULL,
        notes text, created_by_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_crew_memberships(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_crew_id uuid NOT NULL,
        handyman_worker_context_id uuid NOT NULL, status text NOT NULL,
        joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
        created_by_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_crew_leads(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_crew_id uuid NOT NULL,
        handyman_crew_membership_id uuid NOT NULL, lead_seq int NOT NULL,
        designated_by_user_id uuid NOT NULL, designated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_service_requests(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, tenant_company_id uuid NOT NULL,
        property_id uuid NOT NULL, building_id uuid NOT NULL,
        request_code text NOT NULL, title text NOT NULL, description text NOT NULL,
        priority text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (id, client_id)
      );
      CREATE TABLE handyman_execution_scopes(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
        tenant_company_id uuid NOT NULL, building_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'IN_PROGRESS',
        approved_total_amount numeric(18,2) NOT NULL DEFAULT 850000.00
      );
      CREATE TABLE handyman_execution_scope_assignments(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
        handyman_provider_context_id uuid NOT NULL,
        handyman_crew_id uuid NOT NULL, assignment_seq int NOT NULL DEFAULT 1,
        status text NOT NULL, assigned_by_user_id uuid NOT NULL,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        supersedes_assignment_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_work_sessions(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
        lead_user_id uuid NOT NULL, status text NOT NULL
      );
      CREATE TABLE handyman_visit_appointments(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, building_id uuid NOT NULL,
        tenant_company_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
        kind text NOT NULL, state text NOT NULL,
        resource_type text NOT NULL, resource_id uuid NOT NULL
      );
    `);

    await pool.query(
      `INSERT INTO clients VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`,
      [clientId, otherClientId],
    );
    await pool.query(
      `INSERT INTO properties VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE')`,
      [propertyId, clientId, otherPropertyId, otherClientId],
    );
    await pool.query(
      `INSERT INTO buildings VALUES ($1, $2, $3, 'BLD-A', 'Tower Alpha', 'ACTIVE'), ($4, $5, $6, 'BLD-B', 'Tower Beta', 'ACTIVE')`,
      [
        buildingId,
        clientId,
        propertyId,
        otherBuildingId,
        otherClientId,
        otherPropertyId,
      ],
    );
    await pool.query(
      `INSERT INTO users VALUES
        ($1, 'ACTIVE', 'Budi Santoso', 'budi.pic@example.com'),
        ($2, 'ACTIVE', 'Hendra Wijaya', 'hendra.helper@example.com'),
        ($3, 'ACTIVE', 'Indra Pratama', 'indra.insp@example.com'),
        ($4, 'ACTIVE', 'Rina Ops', 'rina.ops@example.com'),
        ($5, 'ACTIVE', 'Other Tenant User', 'other@example.com')`,
      [
        picUserId,
        helperUserId,
        inspectorUserId,
        opsUserId,
        otherTenantUserId,
      ],
    );
    await pool.query(
      `INSERT INTO user_building_assignments (id, user_id, client_id, property_id, building_id, status) VALUES
        ($1, $2, $3, $4, $5, 'ACTIVE'),
        ($6, $7, $3, $4, $5, 'ACTIVE'),
        ($8, $9, $3, $4, $5, 'ACTIVE'),
        ($10, $11, $3, $4, $5, 'ACTIVE'),
        ($12, $13, $14, $15, $16, 'ACTIVE')`,
      [
        randomUUID(),
        picUserId,
        clientId,
        propertyId,
        buildingId,
        randomUUID(),
        helperUserId,
        randomUUID(),
        inspectorUserId,
        randomUUID(),
        opsUserId,
        randomUUID(),
        otherTenantUserId,
        otherClientId,
        otherPropertyId,
        otherBuildingId,
      ],
    );

    await pool.query(
      `INSERT INTO organizations (id, client_id, code, name, status) VALUES ($1, $2, 'ORG-KARYA', 'PT Karya Teknik Mandiri', 'ACTIVE')`,
      [orgId, clientId],
    );
    await pool.query(
      `INSERT INTO vendors VALUES ($1, $2, $3, 'ACTIVE')`,
      [vendorId, clientId, orgId],
    );
    await pool.query(
      `INSERT INTO vendor_licenses_certifications (
        id, vendor_id, record_type, name, number, issuing_authority, issue_date, expiry_date, status
      ) VALUES ($1, $2, 'CERTIFICATION', 'IUJK & K3 Mep Contractor License', 'LIC-K3-2026-009', 'Kemnaker RI', '2025-01-01T00:00:00Z', '2028-01-01T00:00:00Z', 'ACTIVE')`,
      [licenseId, vendorId],
    );
    await pool.query(
      `INSERT INTO handyman_provider_contexts (id, client_id, vendor_id, provider_code, status)
       VALUES ($1, $2, $3, 'PROV-KTM-01', 'ACTIVE')`,
      [providerCtxId, clientId, vendorId],
    );

    await pool.query(
      `INSERT INTO workforce_profiles (
        id, client_id, organization_id, user_id, employee_code, full_name, email, phone, workforce_type, employment_type, status
      ) VALUES
        ($1, $2, $3, $4, 'EMP-PIC-001', 'Budi Santoso', 'budi.pic@example.com', '+628111000111', 'EXTERNAL', 'VENDOR', 'ACTIVE'),
        ($5, $2, $3, $6, 'EMP-HLP-002', 'Hendra Wijaya', 'hendra.helper@example.com', '+628111000222', 'EXTERNAL', 'VENDOR', 'ACTIVE'),
        ($7, $2, $3, $8, 'EMP-INS-003', 'Indra Pratama', 'indra.insp@example.com', '+628111000333', 'EXTERNAL', 'VENDOR', 'ACTIVE')`,
      [
        picWfId,
        clientId,
        orgId,
        picUserId,
        helperWfId,
        helperUserId,
        inspWfId,
        inspectorUserId,
      ],
    );
    await pool.query(
      `INSERT INTO vendor_workforce_bindings (id, client_id, vendor_id, workforce_profile_id, status, effective_from) VALUES
        ($1, $2, $3, $4, 'ACTIVE', '2025-06-01T00:00:00Z'),
        ($5, $2, $3, $6, 'ACTIVE', '2025-06-01T00:00:00Z'),
        ($7, $2, $3, $8, 'ACTIVE', '2025-06-01T00:00:00Z')`,
      [
        randomUUID(),
        clientId,
        vendorId,
        picWfId,
        randomUUID(),
        helperWfId,
        randomUUID(),
        inspWfId,
      ],
    );
    await pool.query(
      `INSERT INTO workforce_building_assignments (id, client_id, workforce_profile_id, property_id, building_id, assignment_role, is_primary, status) VALUES
        ($1, $2, $3, $4, $5, 'HANDYMAN_LEAD', true, 'ACTIVE'),
        ($6, $2, $7, $4, $5, 'HANDYMAN_HELPER', true, 'ACTIVE'),
        ($8, $2, $9, $4, $5, 'HANDYMAN_INSPECTOR', true, 'ACTIVE')`,
      [
        randomUUID(),
        clientId,
        picWfId,
        propertyId,
        buildingId,
        randomUUID(),
        helperWfId,
        randomUUID(),
        inspWfId,
      ],
    );

    await pool.query(
      `INSERT INTO skills (id, code, name, category, status) VALUES
        ($1, 'SKL-PLUMB-01', 'Commercial Plumbing & Piping', 'TECHNICAL', 'ACTIVE'),
        ($2, 'SKL-ELEC-01', 'Low Voltage Electrical Repair', 'TECHNICAL', 'ACTIVE')`,
      [skillPlumbingId, skillElectricalId],
    );
    await pool.query(
      `INSERT INTO workforce_skill_assignments (id, workforce_profile_id, skill_id, proficiency_level, valid_from, valid_until, status) VALUES
        ($1, $2, $3, 'EXPERT', '2025-01-01T00:00:00Z', '2028-12-31T23:59:59Z', 'ACTIVE'),
        ($4, $2, $5, 'ADVANCED', '2025-01-01T00:00:00Z', '2028-12-31T23:59:59Z', 'ACTIVE')`,
      [
        randomUUID(),
        picWfId,
        skillPlumbingId,
        randomUUID(),
        skillElectricalId,
      ],
    );

    await pool.query(
      `INSERT INTO handyman_worker_contexts (id, client_id, handyman_provider_context_id, workforce_profile_id, worker_code, status) VALUES
        ($1, $2, $3, $4, 'WKR-PIC-01', 'ACTIVE'),
        ($5, $2, $3, $6, 'WKR-HLP-02', 'ACTIVE'),
        ($7, $2, $3, $8, 'WKR-INS-03', 'ACTIVE')`,
      [
        picWorkerCtxId,
        clientId,
        providerCtxId,
        picWfId,
        helperWorkerCtxId,
        helperWfId,
        inspWorkerCtxId,
        inspWfId,
      ],
    );

    await pool.query(
      `INSERT INTO handyman_work_crews (id, client_id, handyman_provider_context_id, building_id, code, name, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'CRW-ALPHA', 'Crew Alpha Plumbing & MEP', 'ACTIVE', $5)`,
      [crewId, clientId, providerCtxId, buildingId, opsUserId],
    );
    await pool.query(
      `INSERT INTO handyman_crew_memberships (id, client_id, handyman_crew_id, handyman_worker_context_id, status, created_by_user_id) VALUES
        ($1, $2, $3, $4, 'ACTIVE', $5),
        ($6, $2, $3, $7, 'ACTIVE', $5)`,
      [
        picMemId,
        clientId,
        crewId,
        picWorkerCtxId,
        opsUserId,
        helperMemId,
        helperWorkerCtxId,
      ],
    );
    await pool.query(
      `INSERT INTO handyman_crew_leads (id, client_id, handyman_crew_id, handyman_crew_membership_id, lead_seq, designated_by_user_id)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [randomUUID(), clientId, crewId, picMemId, opsUserId],
    );

    await pool.query(
      `INSERT INTO handyman_service_requests (
        id, client_id, tenant_company_id, property_id, building_id, request_code, title, description, priority, status
      ) VALUES ($1, $2, $3, $4, $5, 'HM-REQ-2026-101', 'Replace pantry pressure valve', 'Leaking valve under sink', 'HIGH', 'IN_EXECUTION')`,
      [requestId, clientId, tenantCompanyId, propertyId, buildingId],
    );
    await pool.query(
      `INSERT INTO handyman_execution_scopes (id, client_id, handyman_request_id, tenant_company_id, building_id, status, approved_total_amount)
       VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', 950000.00)`,
      [scopeId, clientId, requestId, tenantCompanyId, buildingId],
    );
    await pool.query(
      `INSERT INTO handyman_execution_scope_assignments (
        id, client_id, execution_scope_id, handyman_provider_context_id, handyman_crew_id, assignment_seq, status, assigned_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, 1, 'ACTIVE', $6)`,
      [randomUUID(), clientId, scopeId, providerCtxId, crewId, opsUserId],
    );
    await pool.query(
      `INSERT INTO handyman_work_sessions (id, client_id, execution_scope_id, lead_user_id, status) VALUES
        ($1, $2, $3, $4, 'CHECKED_OUT'),
        ($5, $2, $3, $4, 'IN_PROGRESS')`,
      [randomUUID(), clientId, scopeId, picUserId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO handyman_visit_appointments (id, client_id, building_id, tenant_company_id, handyman_request_id, kind, state, resource_type, resource_id)
       VALUES ($1, $2, $3, $4, $5, 'INSPECTION', 'COMPLETED', 'INSPECTOR_USER', $6)`,
      [
        randomUUID(),
        clientId,
        buildingId,
        tenantCompanyId,
        requestId,
        inspectorUserId,
      ],
    );

    sessionService.resolveSessionContext = async (token: string) => ({
      userId: token,
      sessionId: 'sess-test',
      email: `${token}@example.com`,
      displayName: 'Test User',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    userRepository.findById = async (id: string) =>
      ({
        id,
        email: `${id}@example.com`,
        displayName: 'Test User',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never;
    buildingRepository.findById = async (id: string) =>
      (
        await getPool().query(
          'SELECT id, property_id AS "propertyId", status FROM buildings WHERE id = $1',
          [id],
        )
      ).rows[0] ?? null;
    propertyRepository.findById = async (id: string) =>
      (
        await getPool().query(
          'SELECT id, client_id AS "clientId", status FROM properties WHERE id = $1',
          [id],
        )
      ).rows[0] ?? null;
    clientRepository.findById = async (id: string) =>
      (
        await getPool().query(
          'SELECT id, status FROM clients WHERE id = $1',
          [id],
        )
      ).rows[0] ?? null;
    permissionService.resolvePermissionsForUser = async (userId: string) => {
      if (userId === opsUserId) {
        return ['tenant_company.manage', 'tenant_company.read'];
      }
      return [];
    };

    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port: listenPort } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${listenPort}/api/v1`;
  });

  after(async () => {
    sessionService.resolveSessionContext = origResolveSession;
    userRepository.findById = origFindUser;
    buildingAssignmentRepository.listActiveByUser = origListActiveByUser;
    buildingRepository.findById = origFindBuilding;
    propertyRepository.findById = origFindProperty;
    clientRepository.findById = origFindClient;
    permissionService.resolvePermissionsForUser = origResolvePermissions;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const pool = getPool();
    await closePool(pool);
    if (pg) {
      await pg.stop();
    }
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('projects authenticated PIC Pekerjaan worker profile facts accurately without inventing data or leaking commercial fields', async () => {
    const res = await fetch(`${baseUrl}/handyman/field/me/profile`, {
      headers: { Authorization: `Bearer ${picUserId}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: {
        profile: {
          workerIdentity: {
            userId: string;
            workerContextId: string;
            workerCode: string;
            employeeCode: string;
            fullName: string;
          };
          providerAssociation: {
            providerCode: string;
            organizationName: string;
            bindingStatus: string;
          };
          roleAndAssignmentContext: {
            authorizedRoles: string[];
            crewMemberships: Array<{ crewCode: string; isCrewLead: boolean }>;
            buildingAssignments: Array<{ buildingCode: string }>;
          };
          skillsAndCategories: {
            serviceCategories: string[];
            effectiveSkills: Array<{ code: string; proficiencyLevel: string }>;
          };
          certificationsAndExpiry: {
            individualCertificateNumberModeled: boolean;
            skillValidityWindows: Array<{ skillCode: string; isExpired: boolean }>;
            providerLicensesAndCertifications: Array<{ number: string }>;
          };
          workHistorySummary: {
            assignedExecutionScopesCount: number;
            activeWorkSessionsCount: number;
            completedWorkSessionsCount: number;
            recentWorkOrders: Array<Record<string, unknown>>;
          };
        };
      };
    };

    const p = body.data.profile;
    assert.equal(p.workerIdentity.userId, picUserId);
    assert.equal(p.workerIdentity.workerContextId, picWorkerCtxId);
    assert.equal(p.workerIdentity.workerCode, 'WKR-PIC-01');
    assert.equal(p.workerIdentity.employeeCode, 'EMP-PIC-001');
    assert.equal(p.workerIdentity.fullName, 'Budi Santoso');

    assert.equal(p.providerAssociation.providerCode, 'PROV-KTM-01');
    assert.equal(
      p.providerAssociation.organizationName,
      'PT Karya Teknik Mandiri',
    );
    assert.equal(p.providerAssociation.bindingStatus, 'ACTIVE');

    assert.deepEqual(p.roleAndAssignmentContext.authorizedRoles, [
      'PIC_PEKERJAAN',
      'CREW_MEMBER',
    ]);
    assert.equal(p.roleAndAssignmentContext.crewMemberships.length, 1);
    assert.equal(p.roleAndAssignmentContext.crewMemberships[0]?.isCrewLead, true);
    assert.equal(
      p.roleAndAssignmentContext.buildingAssignments[0]?.buildingCode,
      'BLD-A',
    );

    assert.deepEqual(p.skillsAndCategories.serviceCategories, ['TECHNICAL']);
    assert.equal(p.skillsAndCategories.effectiveSkills.length, 2);

    assert.equal(
      p.certificationsAndExpiry.individualCertificateNumberModeled,
      false,
    );
    assert.equal(p.certificationsAndExpiry.skillValidityWindows.length, 2);
    assert.equal(
      p.certificationsAndExpiry.providerLicensesAndCertifications[0]?.number,
      'LIC-K3-2026-009',
    );

    assert.equal(p.workHistorySummary.assignedExecutionScopesCount, 1);
    assert.equal(p.workHistorySummary.activeWorkSessionsCount, 1);
    assert.equal(p.workHistorySummary.completedWorkSessionsCount, 1);
    assert.equal(p.workHistorySummary.recentWorkOrders.length, 1);
    assert.equal(
      p.workHistorySummary.recentWorkOrders[0]?.roleInJob,
      'PIC_PEKERJAAN',
    );
    // Commercial firewall check: no approved_total_amount or invoice fields in recentWorkOrders
    const serialized = JSON.stringify(p.workHistorySummary);
    assert.equal(serialized.includes('950000'), false);
    assert.equal(serialized.includes('approvedTotalAmount'), false);
  });

  it('enforces role and tenant boundaries on GET /handyman/field/workers/:workerContextId/profile', async () => {
    // 1. Crew Lead can read their crew member's profile
    const leadReadsHelper = await fetch(
      `${baseUrl}/handyman/field/workers/${helperWorkerCtxId}/profile`,
      {
        headers: { Authorization: `Bearer ${picUserId}` },
      },
    );
    assert.equal(leadReadsHelper.status, 200);

    // 2. Operations Manager can read Inspector's profile
    const opsReadsInspector = await fetch(
      `${baseUrl}/handyman/field/workers/${inspWorkerCtxId}/profile`,
      {
        headers: { Authorization: `Bearer ${opsUserId}` },
      },
    );
    assert.equal(opsReadsInspector.status, 200);
    const inspBody = (await opsReadsInspector.json()) as {
      data: {
        profile: {
          roleAndAssignmentContext: { authorizedRoles: string[] };
          workHistorySummary: { completedInspectionsCount: number };
        };
      };
    };
    assert.deepEqual(
      inspBody.data.profile.roleAndAssignmentContext.authorizedRoles,
      ['INSPECTOR'],
    );
    assert.equal(
      inspBody.data.profile.workHistorySummary.completedInspectionsCount,
      1,
    );

    // 3. Non-lead Helper cannot read Inspector's or Lead's profile (403 HANDYMAN_WORKER_PROFILE_FORBIDDEN)
    const helperReadsInspector = await fetch(
      `${baseUrl}/handyman/field/workers/${inspWorkerCtxId}/profile`,
      {
        headers: { Authorization: `Bearer ${helperUserId}` },
      },
    );
    assert.equal(helperReadsInspector.status, 403);
    const forbiddenJson = (await helperReadsInspector.json()) as {
      error: { code: string };
    };
    assert.equal(
      forbiddenJson.error.code,
      'HANDYMAN_WORKER_PROFILE_FORBIDDEN',
    );

    // 4. Cross-tenant user is rejected (403 BUILDING_ACCESS_DENIED)
    const crossTenantRes = await fetch(
      `${baseUrl}/handyman/field/workers/${picWorkerCtxId}/profile`,
      {
        headers: { Authorization: `Bearer ${otherTenantUserId}` },
      },
    );
    assert.equal(crossTenantRes.status, 403);
    const crossJson = (await crossTenantRes.json()) as {
      error: { code: string };
    };
    assert.equal(crossJson.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
