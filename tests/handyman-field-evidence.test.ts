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
import { computeEvidenceSha256 } from '../src/modules/evidence/evidence-integrity';
import { createEvidenceStorage } from '../src/modules/evidence/storage';
import { migration0435CreateHandymanScopeVariations } from '../src/database/migrations/0435_create_handyman_scope_variations';
import { migration0436CreateHandymanMaterialPurchasing } from '../src/database/migrations/0436_create_handyman_material_purchasing';
import { migration0437CreateHandymanFieldEvidenceUploads } from '../src/database/migrations/0437_create_handyman_field_evidence_uploads';

const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const VALID_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
]);

describe('CR-HM-FIELD-AUTHORITY-01 P0-D: Genuine Binary Field Evidence Upload', () => {
  let pg: EmbeddedPostgres;
  let dbDir: string;
  let storageDir: string;
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
  const otherTenantCompanyId = randomUUID();
  const requestId = randomUUID();
  const otherRequestId = randomUUID();
  const scopeId = randomUUID();
  const variationId = randomUUID();
  const materialLineId = randomUUID();
  const purchaseRecordId = randomUUID();
  const uomId = randomUUID();

  const picUserId = randomUUID();
  const inspectorUserId = randomUUID();
  const unassignedUserId = randomUUID();
  const otherTenantUserId = randomUUID();
  const opsUserId = randomUUID();

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'hm-evidence-pg-'));
    storageDir = mkdtempSync(join(tmpdir(), 'hm-evidence-files-'));
    process.env.EVIDENCE_STORAGE_ROOT = storageDir;

    const port = 28000 + Math.floor(Math.random() * 2000);
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
      CREATE TABLE tenant_companies(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, building_id uuid NOT NULL,
        code text NOT NULL, name text NOT NULL, status text NOT NULL,
        UNIQUE (id, client_id)
      );
      CREATE TABLE units_of_measure(
        id uuid PRIMARY KEY, code text NOT NULL, name text NOT NULL, symbol text, status text NOT NULL DEFAULT 'ACTIVE'
      );
      CREATE TABLE organizations(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, code text NOT NULL, name text NOT NULL,
        organization_type text NOT NULL DEFAULT 'VENDOR', description text,
        status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE vendors(id uuid PRIMARY KEY, client_id uuid NOT NULL, organization_id uuid NOT NULL, status text NOT NULL);
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
      CREATE TABLE handyman_quotations(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
        tenant_company_id uuid NOT NULL, building_id uuid NOT NULL
      );
      CREATE TABLE handyman_quotation_versions(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, quotation_id uuid NOT NULL
      );
      CREATE TABLE handyman_quotation_lines(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, quotation_version_id uuid NOT NULL
      );
      CREATE TABLE handyman_execution_scopes(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
        quotation_id uuid NOT NULL, approved_quotation_version_id uuid NOT NULL,
        approval_decision_id uuid NOT NULL, tenant_company_id uuid NOT NULL,
        building_id uuid NOT NULL, status text NOT NULL DEFAULT 'AUTHORIZED',
        currency text NOT NULL,
        approved_labor_subtotal numeric(18,2) NOT NULL,
        approved_material_subtotal numeric(18,2) NOT NULL,
        approved_discount_amount numeric(18,2) NOT NULL,
        approved_tax_amount numeric(18,2) NOT NULL,
        approved_total_amount numeric(18,2) NOT NULL,
        authorized_by_user_id uuid NOT NULL,
        authorized_at timestamptz NOT NULL DEFAULT now()
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
      CREATE TABLE handyman_material_execution_lines(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'ESTIMATED'
      );
      CREATE TABLE handyman_qc_runs(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
        checklist_identity text NOT NULL DEFAULT 'DEFAULT', status text NOT NULL DEFAULT 'PASSED',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_bast_documents(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'ACCEPTED', accepted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_visit_appointments(
        id uuid PRIMARY KEY, client_id uuid NOT NULL, building_id uuid NOT NULL,
        tenant_company_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
        execution_scope_id uuid, kind text NOT NULL, state text NOT NULL,
        resource_type text NOT NULL, resource_id uuid NOT NULL,
        scheduled_start timestamptz NOT NULL, scheduled_end timestamptz NOT NULL
      );
      CREATE TABLE operational_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id uuid, building_id uuid, actor_user_id uuid,
        event_type text NOT NULL, entity_type text NOT NULL, entity_id uuid,
        vendor_work_id uuid, request_id text, source text, summary text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const client = await pool.connect();
    try {
      await migration0435CreateHandymanScopeVariations.up(client);
      await migration0436CreateHandymanMaterialPurchasing.up(client);
      await migration0437CreateHandymanFieldEvidenceUploads.up(client);
    } finally {
      client.release();
    }

    const orgId = randomUUID();
    const vendorId = randomUUID();
    const providerCtxId = randomUUID();
    const picWfId = randomUUID();
    const picWorkerCtxId = randomUUID();
    const inspWfId = randomUUID();
    const inspWorkerCtxId = randomUUID();
    const crewId = randomUUID();
    const membershipId = randomUUID();
    const quotationId = randomUUID();
    const versionId = randomUUID();

    await pool.query(
      `INSERT INTO clients VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`,
      [clientId, otherClientId],
    );
    await pool.query(
      `INSERT INTO properties VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE')`,
      [propertyId, clientId, otherPropertyId, otherClientId],
    );
    await pool.query(
      `INSERT INTO buildings VALUES ($1, $2, $3, 'BLD-1', 'Tower 1', 'ACTIVE'), ($4, $5, $6, 'BLD-2', 'Tower 2', 'ACTIVE')`,
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
      `INSERT INTO tenant_companies VALUES ($1, $2, $3, 'TC-1', 'Tenant 1', 'ACTIVE'), ($4, $5, $6, 'TC-2', 'Tenant 2', 'ACTIVE')`,
      [
        tenantCompanyId,
        clientId,
        buildingId,
        otherTenantCompanyId,
        otherClientId,
        otherBuildingId,
      ],
    );
    await pool.query(
      `INSERT INTO users VALUES
        ($1, 'ACTIVE', 'PIC Lead', 'pic@example.com'),
        ($2, 'ACTIVE', 'Inspector', 'insp@example.com'),
        ($3, 'ACTIVE', 'Unassigned', 'unassigned@example.com'),
        ($4, 'ACTIVE', 'Other Tenant', 'other@example.com'),
        ($5, 'ACTIVE', 'Ops Manager', 'ops@example.com')`,
      [
        picUserId,
        inspectorUserId,
        unassignedUserId,
        otherTenantUserId,
        opsUserId,
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
        inspectorUserId,
        randomUUID(),
        unassignedUserId,
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
      `INSERT INTO units_of_measure VALUES ($1, 'PCS', 'Pieces', 'pcs', 'ACTIVE')`,
      [uomId],
    );
    await pool.query(
      `INSERT INTO organizations (id, client_id, code, name, status) VALUES ($1, $2, 'ORG-1', 'Vendor Org', 'ACTIVE')`,
      [orgId, clientId],
    );
    await pool.query(
      `INSERT INTO vendors VALUES ($1, $2, $3, 'ACTIVE')`,
      [vendorId, clientId, orgId],
    );
    await pool.query(
      `INSERT INTO handyman_provider_contexts (id, client_id, vendor_id, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [providerCtxId, clientId, vendorId],
    );
    await pool.query(
      `INSERT INTO workforce_profiles (id, client_id, organization_id, user_id, employee_code, full_name, workforce_type, status) VALUES
        ($1, $2, $3, $4, 'EMP-PIC', 'PIC Lead', 'EXTERNAL', 'ACTIVE'),
        ($5, $2, $3, $6, 'EMP-INSP', 'Inspector', 'EXTERNAL', 'ACTIVE')`,
      [picWfId, clientId, orgId, picUserId, inspWfId, inspectorUserId],
    );
    await pool.query(
      `INSERT INTO vendor_workforce_bindings (id, client_id, vendor_id, workforce_profile_id, status) VALUES
        ($1, $2, $3, $4, 'ACTIVE'),
        ($5, $2, $3, $6, 'ACTIVE')`,
      [randomUUID(), clientId, vendorId, picWfId, randomUUID(), inspWfId],
    );
    await pool.query(
      `INSERT INTO workforce_building_assignments (id, client_id, workforce_profile_id, property_id, building_id, status) VALUES
        ($1, $2, $3, $4, $5, 'ACTIVE'),
        ($6, $2, $7, $4, $5, 'ACTIVE')`,
      [
        randomUUID(),
        clientId,
        picWfId,
        propertyId,
        buildingId,
        randomUUID(),
        inspWfId,
      ],
    );
    await pool.query(
      `INSERT INTO handyman_worker_contexts (id, client_id, handyman_provider_context_id, workforce_profile_id, status) VALUES
        ($1, $2, $3, $4, 'ACTIVE'),
        ($5, $2, $3, $6, 'ACTIVE')`,
      [
        picWorkerCtxId,
        clientId,
        providerCtxId,
        picWfId,
        inspWorkerCtxId,
        inspWfId,
      ],
    );
    await pool.query(
      `INSERT INTO handyman_work_crews (id, client_id, handyman_provider_context_id, building_id, code, name, status, created_by_user_id) VALUES
        ($1, $2, $3, $4, 'CRW-1', 'Crew 1', 'ACTIVE', $5)`,
      [crewId, clientId, providerCtxId, buildingId, opsUserId],
    );
    await pool.query(
      `INSERT INTO handyman_crew_memberships (id, client_id, handyman_crew_id, handyman_worker_context_id, status, created_by_user_id) VALUES
        ($1, $2, $3, $4, 'ACTIVE', $5)`,
      [membershipId, clientId, crewId, picWorkerCtxId, opsUserId],
    );
    await pool.query(
      `INSERT INTO handyman_crew_leads (id, client_id, handyman_crew_id, handyman_crew_membership_id, lead_seq, designated_by_user_id) VALUES
        ($1, $2, $3, $4, 1, $5)`,
      [randomUUID(), clientId, crewId, membershipId, opsUserId],
    );

    await pool.query(
      `INSERT INTO handyman_service_requests (
        id, client_id, tenant_company_id, property_id, building_id,
        request_code, title, description, priority, status
      ) VALUES
        ($1, $2, $3, $4, $5, 'HM-REQ-1', 'Fix ceiling leak', 'Water dripping', 'HIGH', 'IN_EXECUTION'),
        ($6, $7, $8, $9, $10, 'HM-REQ-2', 'Other req', 'Other', 'LOW', 'IN_EXECUTION')`,
      [
        requestId,
        clientId,
        tenantCompanyId,
        propertyId,
        buildingId,
        otherRequestId,
        otherClientId,
        otherTenantCompanyId,
        otherPropertyId,
        otherBuildingId,
      ],
    );
    await pool.query(
      `INSERT INTO handyman_quotations VALUES ($1, $2, $3, $4, $5)`,
      [quotationId, clientId, requestId, tenantCompanyId, buildingId],
    );
    await pool.query(
      `INSERT INTO handyman_quotation_versions VALUES ($1, $2, $3)`,
      [versionId, clientId, quotationId],
    );
    await pool.query(
      `INSERT INTO handyman_execution_scopes (
        id, client_id, handyman_request_id, quotation_id, approved_quotation_version_id,
        approval_decision_id, tenant_company_id, building_id, currency,
        approved_labor_subtotal, approved_material_subtotal, approved_discount_amount,
        approved_tax_amount, approved_total_amount, authorized_by_user_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'IDR',
        500000.00, 250000.00, 0.00, 82500.00, 832500.00, $9
      )`,
      [
        scopeId,
        clientId,
        requestId,
        quotationId,
        versionId,
        randomUUID(),
        tenantCompanyId,
        buildingId,
        opsUserId,
      ],
    );
    await pool.query(
      `INSERT INTO handyman_execution_scope_assignments (
        id, client_id, execution_scope_id, handyman_provider_context_id, handyman_crew_id, assignment_seq, status, assigned_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, 1, 'ACTIVE', $6)`,
      [randomUUID(), clientId, scopeId, providerCtxId, crewId, opsUserId],
    );
    await pool.query(
      `INSERT INTO handyman_visit_appointments VALUES (
        $1, $2, $3, $4, $5, NULL, 'INSPECTION', 'CONFIRMED', 'INSPECTOR_USER', $6,
        '2026-10-15T01:00:00Z', '2026-10-15T02:00:00Z'
      )`,
      [
        randomUUID(),
        clientId,
        buildingId,
        tenantCompanyId,
        requestId,
        inspectorUserId,
      ],
    );

    // Seed variation & material purchase record for domain binding tests
    await pool.query(
      `INSERT INTO handyman_scope_variations (
        id, client_id, execution_scope_id, handyman_request_id, tenant_company_id, building_id,
        variation_type, line_type, title, description, technical_finding,
        quantity, uom_id, status, origin_actor_user_id, origin_actor_role,
        latest_evidence_reference, create_idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, 'ADD', 'MATERIAL', 'Leak photo test', 'Need pipe clamp', 'Hairline crack', 2, $7, 'PROPOSAL', $8, 'PIC_PEKERJAAN', 'ev-init', 'var-seed-1')`,
      [
        variationId,
        clientId,
        scopeId,
        requestId,
        tenantCompanyId,
        buildingId,
        uomId,
        picUserId,
      ],
    );
    await pool.query(
      `INSERT INTO handyman_material_execution_lines (id, client_id, execution_scope_id, status)
       VALUES ($1, $2, $3, 'ESTIMATED')`,
      [materialLineId, clientId, scopeId],
    );
    await pool.query(
      `INSERT INTO handyman_material_purchase_records (
        id, client_id, execution_scope_id, handyman_request_id, tenant_company_id, building_id,
        material_execution_line_id, item_name, uom_id, uom_code, funding_source,
        status, requested_quantity, latest_evidence_reference, requested_by_user_id, create_idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Copper Elbow', $8, 'PCS', 'REIMBURSEMENT', 'REQUEST', 4, 'ev-mat-init', $9, 'mat-seed-1')`,
      [
        purchaseRecordId,
        clientId,
        scopeId,
        requestId,
        tenantCompanyId,
        buildingId,
        materialLineId,
        uomId,
        picUserId,
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
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('rejects metadata-only upload attempts (missing file bytes) and magic-byte spoofing', async () => {
    // 1. Metadata-only JSON / form without binary file
    const metaOnlyRes = await fetch(
      `${baseUrl}/handyman/field/execution-scopes/${scopeId}/evidence/upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${picUserId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          purpose: 'VARIATION_FINDING',
          mimeType: 'image/png',
          originalFileName: 'fake-metadata-only.png',
          idempotencyKey: 'ev-meta-only-1',
        }),
      },
    );
    assert.equal(metaOnlyRes.status, 400);
    const metaOnlyJson = (await metaOnlyRes.json()) as {
      error: { code: string };
    };
    assert.equal(
      metaOnlyJson.error.code,
      'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED',
    );

    // 2. Spoofed file content (plain text claiming to be image/png)
    const spoofForm = new FormData();
    spoofForm.set('purpose', 'VARIATION_FINDING');
    spoofForm.set('mimeType', 'image/png');
    spoofForm.set('idempotencyKey', 'ev-spoof-1');
    spoofForm.set(
      'file',
      new Blob([Buffer.from('not-a-real-png-binary')], { type: 'image/png' }),
      'spoof.png',
    );
    const spoofRes = await fetch(
      `${baseUrl}/handyman/field/execution-scopes/${scopeId}/evidence/upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${picUserId}` },
        body: spoofForm,
      },
    );
    assert.equal(spoofRes.status, 400);
  });

  it('prevents unuploaded presigned metadata records from being confirmed until genuine bytes are uploaded and verified', async () => {
    // 1. Create presigned upload intent (PENDING_BYTES)
    const presignRes = await fetch(`${baseUrl}/handyman/field/evidence/presign`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${inspectorUserId}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        executionScopeId: scopeId,
        variationId,
        purpose: 'VARIATION_FINDING',
        originalFileName: 'inspector-finding.png',
        mimeType: 'image/png',
        declaredByteSize: VALID_PNG_BYTES.byteLength,
        notes: 'Crack on ceiling conduit',
        idempotencyKey: 'ev-presign-1',
      }),
    });
    assert.equal(presignRes.status, 201);
    const presignBody = (await presignRes.json()) as {
      data: {
        evidence: {
          id: string;
          uploadStatus: string;
          uploadCompleted: boolean;
          attachmentReference: string | null;
        };
      };
    };
    const evidenceId = presignBody.data.evidence.id;
    assert.equal(presignBody.data.evidence.uploadStatus, 'PENDING_BYTES');
    assert.equal(presignBody.data.evidence.uploadCompleted, false);
    assert.equal(presignBody.data.evidence.attachmentReference, null);

    // 2. Attempting to confirm BEFORE uploading bytes must fail (409 HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED)
    const prematureConfirmRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${evidenceId}/confirm`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${inspectorUserId}` },
      },
    );
    assert.equal(prematureConfirmRes.status, 409);
    const prematureBody = (await prematureConfirmRes.json()) as {
      error: { code: string };
    };
    assert.equal(
      prematureBody.error.code,
      'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED',
    );

    // 3. Attempting to download unverified content must fail (409)
    const prematureDownloadRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${evidenceId}/content`,
      {
        headers: { Authorization: `Bearer ${inspectorUserId}` },
      },
    );
    assert.equal(prematureDownloadRes.status, 409);

    // 3b. Attempting to bind unverified hm-ev://<id> reference to a variation proposal must fail (409 HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED)
    const prematureBindRes = await fetch(
      `${baseUrl}/handyman/field/execution-scopes/${scopeId}/variations/proposals`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${picUserId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          variationType: 'ADD',
          lineType: 'MATERIAL',
          title: 'Unverified evidence attempt',
          description: 'Trying to bind unverified presigned ID',
          technicalFinding: 'Unverified bytes',
          quantity: 1,
          uomId,
          evidenceReference: `hm-ev://${evidenceId}`,
          idempotencyKey: 'var-premature-ev-1',
        }),
      },
    );
    assert.equal(prematureBindRes.status, 409);
    const prematureBindBody = (await prematureBindRes.json()) as {
      error: { code: string };
    };
    assert.equal(
      prematureBindBody.error.code,
      'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED',
    );

    // 4. Upload real binary PNG bytes via PUT /handyman/field/evidence/:evidenceId/bytes
    const putBytesRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${evidenceId}/bytes`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${inspectorUserId}`,
          'Content-Type': 'image/png',
        },
        body: VALID_PNG_BYTES,
      },
    );
    assert.equal(putBytesRes.status, 200);
    const putBytesBody = (await putBytesRes.json()) as {
      data: {
        evidence: {
          uploadStatus: string;
          verifiedByteSize: number;
          sha256Checksum: string;
        };
      };
    };
    assert.equal(putBytesBody.data.evidence.uploadStatus, 'STAGED_BYTES');
    assert.equal(
      putBytesBody.data.evidence.verifiedByteSize,
      VALID_PNG_BYTES.byteLength,
    );
    assert.equal(
      putBytesBody.data.evidence.sha256Checksum,
      computeEvidenceSha256(VALID_PNG_BYTES),
    );

    // 5. Confirm upload after storage verification
    const confirmRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${evidenceId}/confirm`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${inspectorUserId}` },
      },
    );
    assert.equal(confirmRes.status, 200);
    const confirmBody = (await confirmRes.json()) as {
      data: {
        evidence: {
          uploadStatus: string;
          uploadCompleted: boolean;
          attachmentReference: string;
          downloadPath: string | null;
        };
      };
    };
    assert.equal(confirmBody.data.evidence.uploadStatus, 'VERIFIED');
    assert.equal(confirmBody.data.evidence.uploadCompleted, true);
    assert.equal(
      confirmBody.data.evidence.attachmentReference,
      `hm-ev://${evidenceId}`,
    );
    assert.ok(confirmBody.data.evidence.downloadPath);

    // Verify variation record received the verified attachmentReference
    const varRow = await getPool().query<{
      latest_evidence_reference: string | null;
    }>(
      `SELECT latest_evidence_reference FROM handyman_scope_variations WHERE id = $1`,
      [variationId],
    );
    assert.equal(
      varRow.rows[0]?.latest_evidence_reference,
      `hm-ev://${evidenceId}`,
    );

    // 6. Stream verified binary bytes back and verify exact byte-for-byte match
    const downloadRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${evidenceId}/content`,
      {
        headers: { Authorization: `Bearer ${picUserId}` },
      },
    );
    assert.equal(downloadRes.status, 200);
    const downloadedBuf = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepEqual(downloadedBuf, VALID_PNG_BYTES);
  });

  it('supports direct multipart binary upload for material receipts with idempotency and rejects cross-tenant or unassigned actors', async () => {
    const form = new FormData();
    form.set('purpose', 'MATERIAL_RECEIPT');
    form.set('materialPurchaseRecordId', purchaseRecordId);
    form.set('mimeType', 'image/jpeg');
    form.set('originalFileName', 'supplier-receipt.jpg');
    form.set('notes', 'Receipt from Toko Besi Sentosa');
    form.set('idempotencyKey', 'ev-multipart-receipt-1');
    form.set(
      'file',
      new Blob([VALID_JPEG_BYTES], { type: 'image/jpeg' }),
      'supplier-receipt.jpg',
    );

    const uploadRes = await fetch(
      `${baseUrl}/handyman/field/execution-scopes/${scopeId}/evidence/upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${picUserId}` },
        body: form,
      },
    );
    assert.equal(uploadRes.status, 201);
    const uploadBody = (await uploadRes.json()) as {
      data: {
        replayed: boolean;
        evidence: {
          id: string;
          uploadStatus: string;
          uploadCompleted: boolean;
          verifiedByteSize: number;
          sha256Checksum: string;
          attachmentReference: string;
        };
      };
    };
    assert.equal(uploadBody.data.replayed, false);
    assert.equal(uploadBody.data.evidence.uploadStatus, 'VERIFIED');
    assert.equal(uploadBody.data.evidence.uploadCompleted, true);
    assert.equal(
      uploadBody.data.evidence.verifiedByteSize,
      VALID_JPEG_BYTES.byteLength,
    );
    assert.equal(
      uploadBody.data.evidence.sha256Checksum,
      computeEvidenceSha256(VALID_JPEG_BYTES),
    );
    const receiptRef = uploadBody.data.evidence.attachmentReference;

    // Verify material purchase record has receipt_evidence_reference bound
    const matRow = await getPool().query<{
      receipt_evidence_reference: string | null;
    }>(
      `SELECT receipt_evidence_reference FROM handyman_material_purchase_records WHERE id = $1`,
      [purchaseRecordId],
    );
    assert.equal(matRow.rows[0]?.receipt_evidence_reference, receiptRef);

    // Idempotent replay with same key & bytes returns 200 replayed: true
    const replayRes = await fetch(
      `${baseUrl}/handyman/field/execution-scopes/${scopeId}/evidence/upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${picUserId}` },
        body: form,
      },
    );
    assert.equal(replayRes.status, 200);
    const replayBody = (await replayRes.json()) as {
      data: { replayed: boolean; evidence: { id: string } };
    };
    assert.equal(replayBody.data.replayed, true);
    assert.equal(replayBody.data.evidence.id, uploadBody.data.evidence.id);

    // Unassigned user in same building is rejected (403 HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN)
    const unassignedRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${uploadBody.data.evidence.id}`,
      {
        headers: { Authorization: `Bearer ${unassignedUserId}` },
      },
    );
    assert.equal(unassignedRes.status, 403);

    // Cross-tenant user is rejected (403 BUILDING_ACCESS_DENIED)
    const crossTenantRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${uploadBody.data.evidence.id}/content`,
      {
        headers: { Authorization: `Bearer ${otherTenantUserId}` },
      },
    );
    assert.equal(crossTenantRes.status, 403);
  });

  it('P0-A/B/C: rejects unmanaged, cross-tenant and byte-missing references; VERIFIED bytes are immutable; binding is versioned and audited', async () => {
    const propose = async (evidenceReference: string, key: string) =>
      fetch(
        `${baseUrl}/handyman/field/execution-scopes/${scopeId}/variations/proposals`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${picUserId}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            variationType: 'ADD',
            lineType: 'MATERIAL',
            title: 'Evidence hardening probe',
            description: 'probe',
            technicalFinding: 'probe',
            quantity: 1,
            uomId,
            evidenceReference,
            idempotencyKey: key,
          }),
        },
      );

    // Arbitrary / legacy references cannot bypass verification by omitting hm-ev://
    for (const [ref, key] of [
      ['receipt-photo.jpg', 'var-hard-arb-1'],
      ['ev://legacy/finding-001', 'var-hard-legacy-1'],
      ['https://example.invalid/photo.jpg', 'var-hard-url-1'],
    ] as const) {
      const res = await propose(ref, key);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'HANDYMAN_EVIDENCE_REFERENCE_UNVERIFIED');
    }

    // Cross-tenant VERIFIED upload (real bytes, wrong client/building/request) is denied
    const crossId = randomUUID();
    await createEvidenceStorage().put(`evidence/${crossId}`, {
      buffer: VALID_PNG_BYTES,
      mimeType: 'image/png',
    });
    await getPool().query(
      `INSERT INTO handyman_field_evidence_uploads
         (id, client_id, tenant_company_id, building_id, handyman_request_id, execution_scope_id,
          purpose, upload_status, original_file_name, mime_type, storage_key, declared_byte_size,
          verified_byte_size, sha256_checksum, attachment_reference, uploaded_by_user_id,
          uploaded_by_role, idempotency_key, verified_at)
       VALUES ($1,$2,$3,$4,$5,NULL,'VARIATION_FINDING','VERIFIED','x.png','image/png',$6,$7,$7,$8,$9,$10,'PIC_PEKERJAAN',$11,NOW())`,
      [
        crossId, otherClientId, otherTenantCompanyId, otherBuildingId, otherRequestId,
        `evidence/${crossId}`, VALID_PNG_BYTES.byteLength,
        computeEvidenceSha256(VALID_PNG_BYTES), `hm-ev://${crossId}`, picUserId, `cross-${crossId}`,
      ],
    );
    const crossRes = await propose(`hm-ev://${crossId}`, 'var-hard-cross-1');
    assert.equal(crossRes.status, 403);

    // VERIFIED row whose stored bytes are missing fails integrity verification
    const missingId = randomUUID();
    await getPool().query(
      `INSERT INTO handyman_field_evidence_uploads
         (id, client_id, tenant_company_id, building_id, handyman_request_id, execution_scope_id,
          purpose, upload_status, original_file_name, mime_type, storage_key, declared_byte_size,
          verified_byte_size, sha256_checksum, attachment_reference, uploaded_by_user_id,
          uploaded_by_role, idempotency_key, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,'VARIATION_FINDING','VERIFIED','x.png','image/png',$7,$8,$8,$9,$10,$11,'PIC_PEKERJAAN',$12,NOW())`,
      [
        missingId, clientId, tenantCompanyId, buildingId, requestId, scopeId,
        `evidence/${missingId}`, VALID_PNG_BYTES.byteLength,
        computeEvidenceSha256(VALID_PNG_BYTES), `hm-ev://${missingId}`, picUserId, `missing-${missingId}`,
      ],
    );
    const missingRes = await propose(`hm-ev://${missingId}`, 'var-hard-missing-1');
    assert.equal(missingRes.status, 409);
    const missingBody = (await missingRes.json()) as { error: { code: string } };
    assert.equal(missingBody.error.code, 'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED');

    // Immutability: presign -> put -> confirm, then exact retry is safe and conflicting retry is 409
    const presignRes = await fetch(`${baseUrl}/handyman/field/evidence/presign`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${picUserId}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        executionScopeId: scopeId,
        variationId,
        purpose: 'VARIATION_FINDING',
        originalFileName: 'immutable.png',
        mimeType: 'image/png',
        declaredByteSize: VALID_PNG_BYTES.byteLength,
        idempotencyKey: 'ev-immutable-1',
      }),
    });
    assert.equal(presignRes.status, 201);
    const presignBody = (await presignRes.json()) as {
      data: { evidence: { id: string } };
    };
    const immId = presignBody.data.evidence.id;
    const put = async (bytes: Buffer) =>
      fetch(`${baseUrl}/handyman/field/evidence/${immId}/bytes`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${picUserId}`,
          'Content-Type': 'image/png',
        },
        body: bytes,
      });
    assert.equal((await put(VALID_PNG_BYTES)).status, 200);

    const versionBefore = await getPool().query<{ version: number }>(
      `SELECT version FROM handyman_scope_variations WHERE id = $1`,
      [variationId],
    );
    const confirmRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${immId}/confirm`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${picUserId}` },
      },
    );
    assert.equal(confirmRes.status, 200);

    // Binding bumped the variation aggregate version and wrote an audit event
    const versionAfter = await getPool().query<{ version: number }>(
      `SELECT version FROM handyman_scope_variations WHERE id = $1`,
      [variationId],
    );
    assert.equal(
      Number(versionAfter.rows[0].version),
      Number(versionBefore.rows[0].version) + 1,
    );
    const bindEvents = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM operational_events
        WHERE event_type = 'handyman_field_evidence.bound_to_variation'
          AND entity_id = $1`,
      [variationId],
    );
    assert.ok(Number(bindEvents.rows[0].count) >= 1);

    // Exact retry: safe no-op
    const retryRes = await put(VALID_PNG_BYTES);
    assert.equal(retryRes.status, 200);
    // Conflicting retry: typed 409, verified bytes preserved
    const conflictBytes = Buffer.concat([VALID_PNG_BYTES, Buffer.from([0x00])]);
    const conflictRes = await put(conflictBytes);
    assert.equal(conflictRes.status, 409);
    const conflictBody = (await conflictRes.json()) as {
      error: { code: string };
    };
    assert.equal(conflictBody.error.code, 'HANDYMAN_EVIDENCE_UPLOAD_IMMUTABLE');
    const contentRes = await fetch(
      `${baseUrl}/handyman/field/evidence/${immId}/content`,
      { headers: { Authorization: `Bearer ${picUserId}` } },
    );
    assert.equal(contentRes.status, 200);
    assert.deepEqual(
      Buffer.from(await contentRes.arrayBuffer()),
      VALID_PNG_BYTES,
    );
  });
});

