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

/**
 * CR-HM-FIELD-AUTHORITY-01 P1 — Worker Profile Projection.
 *
 * CR-HM-WORKER-PROFILE-FIX-01: the fixture schema below is now a
 * column-faithful subset of the canonical migration registry (see the
 * migrations cited on each table). It previously declared columns that
 * production never had (worker_code, provider_code, workforce_profiles
 * .client_id/email/phone/employment_type, vendor_workforce_bindings
 * .client_id, workforce_building_assignments.client_id/property_id/...,
 * handyman_service_requests.request_code/title), which is exactly why the
 * column drift escaped review. Keeping the fixture aligned means future
 * drift fails HERE as well as in the migration-backed regression suite
 * (handyman-worker-profile-schema-regression.test.ts).
 */
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
      -- 0001/0012/0017/0018 — master chain: client → property → building
      CREATE TABLE clients(id uuid PRIMARY KEY, status text NOT NULL);
      CREATE TABLE properties(id uuid PRIMARY KEY, client_id uuid NOT NULL, status text NOT NULL);
      CREATE TABLE buildings(id uuid PRIMARY KEY, property_id uuid NOT NULL, code text NOT NULL, name text NOT NULL, status text NOT NULL);
      -- 0002 + 0301 — users own the login identity AND the only modeled phone
      CREATE TABLE users(
        id uuid PRIMARY KEY, email text NOT NULL, display_name text NOT NULL,
        status text NOT NULL, whatsapp_phone text
      );
      -- 0019 — access is derived through building → property → client
      CREATE TABLE user_building_assignments(
        id uuid PRIMARY KEY, user_id uuid NOT NULL, building_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE',
        assigned_by_user_id uuid, assigned_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0020
      CREATE TABLE organizations(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, code text NOT NULL, name text NOT NULL,
        description text, status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0054 — vendor_code is the only provider code authority
      CREATE TABLE vendors(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, vendor_code text NOT NULL,
        vendor_name text NOT NULL, status text NOT NULL
      );
      -- 0062
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
        document_reference uuid,
        notes text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0384 — no provider_code column exists
      CREATE TABLE handyman_provider_contexts(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, vendor_id uuid NOT NULL,
        status text NOT NULL, created_by_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0024/0031 — no client_id, email, phone or employment_type column
      CREATE TABLE workforce_profiles(
        id uuid PRIMARY KEY, organization_id uuid NOT NULL,
        department_id uuid, team_id uuid, position_id uuid,
        user_id uuid, employee_code text NOT NULL, full_name text NOT NULL,
        workforce_type text NOT NULL DEFAULT 'INTERNAL',
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0060 — no client_id column; personnel code carries the worker code
      CREATE TABLE vendor_workforce_bindings(
        id uuid PRIMARY KEY, vendor_id uuid NOT NULL,
        workforce_profile_id uuid NOT NULL, vendor_personnel_code text NOT NULL,
        status text NOT NULL,
        effective_from timestamptz, effective_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0030 — no client_id/property_id/assignment_role/is_primary/assigned_at
      CREATE TABLE workforce_building_assignments(
        id uuid PRIMARY KEY, workforce_profile_id uuid NOT NULL,
        building_id uuid NOT NULL,
        status text NOT NULL,
        effective_from timestamptz, effective_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0025/0026 — the skill master is client-scoped
      CREATE TABLE skills(
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL,
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
      -- 0385 — no worker_code column exists
      CREATE TABLE handyman_worker_contexts(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_provider_context_id uuid NOT NULL,
        workforce_profile_id uuid NOT NULL,
        status text NOT NULL, created_by_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0386 — no building_id column; memberships have no joined_at
      CREATE TABLE handyman_work_crews(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_provider_context_id uuid NOT NULL,
        code text NOT NULL, name text NOT NULL, status text NOT NULL,
        created_by_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_crew_memberships(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_crew_id uuid NOT NULL,
        handyman_worker_context_id uuid NOT NULL, status text NOT NULL,
        created_by_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_crew_leads(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_crew_id uuid NOT NULL,
        handyman_crew_membership_id uuid NOT NULL, lead_seq bigserial NOT NULL,
        designated_by_user_id uuid NOT NULL, designated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0378 — no request_code/title/property_id/priority column exists
      CREATE TABLE handyman_service_requests(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, tenant_company_id uuid NOT NULL,
        building_id uuid NOT NULL,
        origin_channel text NOT NULL, origin_reference text, description text,
        status text NOT NULL, created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (id, client_id)
      );
      -- 0395 — commercial amounts are NOT part of the scope row here
      CREATE TABLE handyman_execution_scopes(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
        tenant_company_id uuid NOT NULL, building_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'AUTHORIZED'
      );
      -- 0396 — no assignment_seq column
      CREATE TABLE handyman_execution_scope_assignments(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
        handyman_provider_context_id uuid NOT NULL,
        handyman_crew_id uuid NOT NULL,
        status text NOT NULL, assigned_by_user_id uuid NOT NULL,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        supersedes_assignment_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0401 — bounded status vocabulary (CHECKED_IN … CHECKED_OUT)
      CREATE TABLE handyman_work_sessions(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
        assignment_id uuid, lead_worker_id uuid,
        lead_user_id uuid NOT NULL, status text NOT NULL
      );
      -- 0431
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
      `INSERT INTO buildings VALUES ($1, $2, 'BLD-A', 'Tower Alpha', 'ACTIVE'), ($3, $4, 'BLD-B', 'Tower Beta', 'ACTIVE')`,
      [buildingId, propertyId, otherBuildingId, otherPropertyId],
    );
    await pool.query(
      `INSERT INTO users (id, status, display_name, email, whatsapp_phone) VALUES
        ($1, 'ACTIVE', 'Budi Santoso', 'budi.pic@example.com', '+628111000111'),
        ($2, 'ACTIVE', 'Hendra Wijaya', 'hendra.helper@example.com', '+628111000222'),
        ($3, 'ACTIVE', 'Indra Pratama', 'indra.insp@example.com', '+628111000333'),
        ($4, 'ACTIVE', 'Rina Ops', 'rina.ops@example.com', '+628111000444'),
        ($5, 'ACTIVE', 'Other Tenant User', 'other@example.com', '+628111000555')`,
      [
        picUserId,
        helperUserId,
        inspectorUserId,
        opsUserId,
        otherTenantUserId,
      ],
    );
    await pool.query(
      `INSERT INTO user_building_assignments (id, user_id, building_id, status) VALUES
        ($1, $2, $5, 'ACTIVE'),
        ($3, $4, $5, 'ACTIVE'),
        ($6, $7, $5, 'ACTIVE'),
        ($8, $9, $5, 'ACTIVE'),
        ($10, $11, $12, 'ACTIVE')`,
      [
        randomUUID(),
        picUserId,
        randomUUID(),
        helperUserId,
        buildingId,
        randomUUID(),
        inspectorUserId,
        randomUUID(),
        opsUserId,
        randomUUID(),
        otherTenantUserId,
        otherBuildingId,
      ],
    );

    await pool.query(
      `INSERT INTO organizations (id, client_id, code, name, status) VALUES ($1, $2, 'ORG-KARYA', 'PT Karya Teknik Mandiri', 'ACTIVE')`,
      [orgId, clientId],
    );
    await pool.query(
      `INSERT INTO vendors (id, client_id, vendor_code, vendor_name, status)
       VALUES ($1, $2, 'PROV-KTM-01', 'PT Karya Teknik Mandiri', 'ACTIVE')`,
      [vendorId, clientId],
    );
    await pool.query(
      `INSERT INTO vendor_licenses_certifications (
        id, vendor_id, record_type, name, number, issuing_authority, issue_date, expiry_date, status
      ) VALUES ($1, $2, 'CERTIFICATION', 'IUJK & K3 Mep Contractor License', 'LIC-K3-2026-009', 'Kemnaker RI', '2025-01-01T00:00:00Z', '2028-01-01T00:00:00Z', 'ACTIVE')`,
      [licenseId, vendorId],
    );
    await pool.query(
      `INSERT INTO handyman_provider_contexts (id, client_id, vendor_id, status, created_by_user_id)
       VALUES ($1, $2, $3, 'ACTIVE', $4)`,
      [providerCtxId, clientId, vendorId, opsUserId],
    );

    await pool.query(
      `INSERT INTO workforce_profiles (
        id, organization_id, user_id, employee_code, full_name, workforce_type, status
      ) VALUES
        ($1, $2, $3, 'EMP-PIC-001', 'Budi Santoso', 'EXTERNAL', 'ACTIVE'),
        ($4, $2, $5, 'EMP-HLP-002', 'Hendra Wijaya', 'EXTERNAL', 'ACTIVE'),
        ($6, $2, $7, 'EMP-INS-003', 'Indra Pratama', 'EXTERNAL', 'ACTIVE')`,
      [
        picWfId,
        orgId,
        picUserId,
        helperWfId,
        helperUserId,
        inspWfId,
        inspectorUserId,
      ],
    );
    await pool.query(
      `INSERT INTO vendor_workforce_bindings (
        id, vendor_id, workforce_profile_id, vendor_personnel_code, status, effective_from
      ) VALUES
        ($1, $2, $3, 'WKR-PIC-01', 'ACTIVE', '2025-06-01T00:00:00Z'),
        ($4, $2, $5, 'WKR-HLP-02', 'ACTIVE', '2025-06-01T00:00:00Z'),
        ($6, $2, $7, 'WKR-INS-03', 'ACTIVE', '2025-06-01T00:00:00Z')`,
      [
        randomUUID(),
        vendorId,
        picWfId,
        randomUUID(),
        helperWfId,
        randomUUID(),
        inspWfId,
      ],
    );
    await pool.query(
      `INSERT INTO workforce_building_assignments (id, workforce_profile_id, building_id, status) VALUES
        ($1, $2, $3, 'ACTIVE'),
        ($4, $5, $3, 'ACTIVE'),
        ($6, $7, $3, 'ACTIVE')`,
      [
        randomUUID(),
        picWfId,
        buildingId,
        randomUUID(),
        helperWfId,
        randomUUID(),
        inspWfId,
      ],
    );

    await pool.query(
      `INSERT INTO skills (id, client_id, code, name, category, status) VALUES
        ($1, $3, 'SKL-PLUMB-01', 'Commercial Plumbing & Piping', 'TECHNICAL', 'ACTIVE'),
        ($2, $3, 'SKL-ELEC-01', 'Low Voltage Electrical Repair', 'TECHNICAL', 'ACTIVE')`,
      [skillPlumbingId, skillElectricalId, clientId],
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
      `INSERT INTO handyman_worker_contexts (id, client_id, handyman_provider_context_id, workforce_profile_id, status, created_by_user_id) VALUES
        ($1, $2, $3, $4, 'ACTIVE', $9),
        ($5, $2, $3, $6, 'ACTIVE', $9),
        ($7, $2, $3, $8, 'ACTIVE', $9)`,
      [
        picWorkerCtxId,
        clientId,
        providerCtxId,
        picWfId,
        helperWorkerCtxId,
        helperWfId,
        inspWorkerCtxId,
        inspWfId,
        opsUserId,
      ],
    );

    await pool.query(
      `INSERT INTO handyman_work_crews (id, client_id, handyman_provider_context_id, code, name, status, created_by_user_id)
       VALUES ($1, $2, $3, 'CRW-ALPHA', 'Crew Alpha Plumbing & MEP', 'ACTIVE', $4)`,
      [crewId, clientId, providerCtxId, opsUserId],
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
      `INSERT INTO handyman_crew_leads (id, client_id, handyman_crew_id, handyman_crew_membership_id, designated_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), clientId, crewId, picMemId, opsUserId],
    );

    await pool.query(
      `INSERT INTO handyman_service_requests (
        id, client_id, tenant_company_id, building_id, origin_channel, origin_reference, description, status
      ) VALUES ($1, $2, $3, $4, 'BM_SUPER_APP', 'HM-REQ-2026-101', 'Replace pantry pressure valve', 'DIAGNOSIS')`,
      [requestId, clientId, tenantCompanyId, buildingId],
    );
    await pool.query(
      `INSERT INTO handyman_execution_scopes (id, client_id, handyman_request_id, tenant_company_id, building_id, status)
       VALUES ($1, $2, $3, $4, $5, 'AUTHORIZED')`,
      [scopeId, clientId, requestId, tenantCompanyId, buildingId],
    );
    await pool.query(
      `INSERT INTO handyman_execution_scope_assignments (
        id, client_id, execution_scope_id, handyman_provider_context_id, handyman_crew_id, status, assigned_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)`,
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
            email: string | null;
            phone: string | null;
            workforceType: string;
            employmentType: string;
          };
          providerAssociation: {
            providerCode: string;
            providerStatus: string;
            organizationName: string;
            bindingStatus: string;
          };
          roleAndAssignmentContext: {
            authorizedRoles: string[];
            crewMemberships: Array<{
              crewCode: string;
              crewName: string;
              buildingId: string | null;
              isCrewLead: boolean;
              joinedAt: string;
            }>;
            buildingAssignments: Array<{
              buildingCode: string;
              propertyId: string;
              assignmentRole: string;
              isPrimary: boolean;
            }>;
          };
          skillsAndCategories: {
            serviceCategories: string[];
            effectiveSkills: Array<{ code: string; proficiencyLevel: string }>;
          };
          certificationsAndExpiry: {
            individualCertificateNumberModeled: boolean;
            individualCertifications: Array<{
              certificateNumber: string;
              isValid: boolean;
              documentAvailable: boolean;
            }>;
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
    // workerCode is the vendor personnel code (0054/0060 authority).
    assert.equal(p.workerIdentity.workerCode, 'WKR-PIC-01');
    assert.equal(p.workerIdentity.employeeCode, 'EMP-PIC-001');
    assert.equal(p.workerIdentity.fullName, 'Budi Santoso');
    // Contact identity comes from the user identity master (0002/0301).
    assert.equal(p.workerIdentity.email, 'budi.pic@example.com');
    assert.equal(p.workerIdentity.phone, '+628111000111');
    assert.equal(p.workerIdentity.workforceType, 'EXTERNAL');
    // Derived from workforce_type (no employment_type column exists).
    assert.equal(p.workerIdentity.employmentType, 'VENDOR');

    // providerCode is the vendor registry code (0054).
    assert.equal(p.providerAssociation.providerCode, 'PROV-KTM-01');
    assert.equal(p.providerAssociation.providerStatus, 'ACTIVE');
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
    assert.equal(
      p.roleAndAssignmentContext.crewMemberships[0]?.crewCode,
      'CRW-ALPHA',
    );
    // Crews are not building-scoped (0386): never invented.
    assert.equal(p.roleAndAssignmentContext.crewMemberships[0]?.buildingId, null);
    assert.equal(p.roleAndAssignmentContext.crewMemberships[0]?.isCrewLead, true);
    assert.equal(
      p.roleAndAssignmentContext.buildingAssignments[0]?.buildingCode,
      'BLD-A',
    );
    assert.equal(
      p.roleAndAssignmentContext.buildingAssignments[0]?.propertyId,
      propertyId,
    );
    assert.equal(
      p.roleAndAssignmentContext.buildingAssignments[0]?.assignmentRole,
      'HANDYMAN',
    );
    assert.equal(
      p.roleAndAssignmentContext.buildingAssignments[0]?.isPrimary,
      true,
    );

    assert.deepEqual(p.skillsAndCategories.serviceCategories, ['TECHNICAL']);
    assert.equal(p.skillsAndCategories.effectiveSkills.length, 2);

    // PART 02 — individual certificate numbers are modeled now, and this
    // fixture has no workforce_certifications rows (the fixture schema predates
    // 0461), so the list must degrade to empty instead of failing the profile.
    assert.equal(
      p.certificationsAndExpiry.individualCertificateNumberModeled,
      true,
    );
    assert.deepEqual(p.certificationsAndExpiry.individualCertifications, []);
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
    // Display handle comes from the modeled origin_reference; the title from
    // the modeled description.
    assert.equal(
      p.workHistorySummary.recentWorkOrders[0]?.requestCode,
      'HM-REQ-2026-101',
    );
    assert.equal(
      p.workHistorySummary.recentWorkOrders[0]?.title,
      'Replace pantry pressure valve',
    );
    // Commercial firewall check: no amount or invoice fields in recentWorkOrders
    const serialized = JSON.stringify(p.workHistorySummary);
    assert.equal(serialized.includes('950000'), false);
    assert.equal(serialized.includes('approvedTotalAmount'), false);
  });

  it('returns a valid profile for a worker without skills or certifications', async () => {
    const res = await fetch(`${baseUrl}/handyman/field/me/profile`, {
      headers: { Authorization: `Bearer ${helperUserId}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: {
        profile: {
          skillsAndCategories: { effectiveSkills: unknown[] };
          certificationsAndExpiry: { skillValidityWindows: unknown[] };
          roleAndAssignmentContext: { authorizedRoles: string[] };
        };
      };
    };
    const p = body.data.profile;
    assert.deepEqual(p.skillsAndCategories.effectiveSkills, []);
    assert.deepEqual(p.certificationsAndExpiry.skillValidityWindows, []);
    assert.deepEqual(p.roleAndAssignmentContext.authorizedRoles, [
      'CREW_MEMBER',
    ]);
  });

  it('returns a controlled 404 (never 500) for an actor without a worker context', async () => {
    const res = await fetch(`${baseUrl}/handyman/field/me/profile`, {
      headers: { Authorization: `Bearer ${opsUserId}` },
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'HANDYMAN_WORKER_PROFILE_NOT_FOUND');
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
