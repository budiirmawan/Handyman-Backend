/**
 * CR-HM-FIELD-AUTHORITY-01 P0-B — Pekerjaan Tambah / Kurang (ADD / REDUCE)
 * Focused Lifecycle, Role Separation, Impersonation & Concurrency Test Suite.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

import { createApp } from '../src/app';
import { closePool, getPool, initDatabase } from '../src/database';
import { sessionService } from '../src/modules/auth/session.service';
import { buildingAssignmentRepository } from '../src/modules/building-assignments/building-assignment.repository';
import { buildingRepository } from '../src/modules/buildings/building.repository';
import { propertyRepository } from '../src/modules/properties/property.repository';
import { clientRepository } from '../src/modules/clients/client.repository';
import { userRepository } from '../src/modules/users/user.repository';
import { permissionService } from '../src/modules/permissions';
import { migration0435CreateHandymanScopeVariations } from '../src/database/migrations/0435_create_handyman_scope_variations';

const CLIENT_A = '10000000-0000-4000-8000-000000000001';
const PROPERTY_A = '10000000-0000-4000-8000-000000000011';
const BUILDING_A1 = '10000000-0000-4000-8000-000000000021';
const TENANT_A = '10000000-0000-4000-8000-000000000031';
const TENANT_PIC_A = '10000000-0000-4000-8000-000000000041';

const LEAD_USER_A = '10000000-0000-4000-8000-000000000101';
const INSPECTOR_USER_A = '10000000-0000-4000-8000-000000000102';
const OPS_MANAGER_USER_A = '10000000-0000-4000-8000-000000000103';
const TENANT_USER_A = '10000000-0000-4000-8000-000000000104';
const HELPER_USER_A = '10000000-0000-4000-8000-000000000105';

const ORG_A = '10000000-0000-4000-8000-000000000201';
const VENDOR_A = '10000000-0000-4000-8000-000000000202';
const PROVIDER_CTX_A = '10000000-0000-4000-8000-000000000203';
const CREW_A = '10000000-0000-4000-8000-000000000204';

const WF_LEAD_A = '10000000-0000-4000-8000-000000000211';
const WF_INSP_A = '10000000-0000-4000-8000-000000000212';
const WF_HELPER_A = '10000000-0000-4000-8000-000000000213';

const WCTX_LEAD_A = '10000000-0000-4000-8000-000000000221';
const WCTX_INSP_A = '10000000-0000-4000-8000-000000000222';
const WCTX_HELPER_A = '10000000-0000-4000-8000-000000000223';

const MEM_LEAD_A = '10000000-0000-4000-8000-000000000231';
const MEM_HELPER_A = '10000000-0000-4000-8000-000000000232';

const REQ_A1 = '10000000-0000-4000-8000-000000000301';
const QUO_A1 = '10000000-0000-4000-8000-000000000401';
const QVER_A1 = '10000000-0000-4000-8000-000000000411';
const QLINE_LABOR_A1 = '10000000-0000-4000-8000-000000000421';
const QLINE_MAT_A1 = '10000000-0000-4000-8000-000000000422';
const SCOPE_A1 = '10000000-0000-4000-8000-000000000501';
const ASSIGN_A1 = '10000000-0000-4000-8000-000000000601';

const UOM_UNIT = '10000000-0000-4000-8000-000000000701';
const UOM_PCS = '10000000-0000-4000-8000-000000000702';

let pg: EmbeddedPostgres | null = null;
let pgDir: string | null = null;
let pool: Pool | null = null;
let server: Server;
let baseUrl: string;

const origResolveSession = sessionService.resolveSessionContext;
const origFindUser = userRepository.findById;
const origListActiveByUser = buildingAssignmentRepository.listActiveByUser;
const origFindBuilding = buildingRepository.findById;
const origFindProperty = propertyRepository.findById;
const origFindClient = clientRepository.findById;
const origResolvePermissions = permissionService.resolvePermissionsForUser;

before(async () => {
  pgDir = mkdtempSync(join(tmpdir(), 'hm-scope-var-'));
  pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    port: 55445,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();

  pool = await initDatabase({
    host: '127.0.0.1',
    port: 55445,
    name: 'postgres',
    user: 'postgres',
    password: 'password',
    ssl: false,
    poolMin: 1,
    poolMax: 4,
  });
  await pool.query(`
    CREATE TABLE clients(id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE properties(id uuid PRIMARY KEY, client_id uuid NOT NULL, status text NOT NULL);
    CREATE TABLE buildings(id uuid PRIMARY KEY, client_id uuid NOT NULL, property_id uuid NOT NULL, code text NOT NULL, name text NOT NULL, status text NOT NULL);
    CREATE TABLE users(id uuid PRIMARY KEY, status text NOT NULL, full_name text NOT NULL, email text NOT NULL);
    CREATE TABLE user_building_assignments(
      id uuid PRIMARY KEY, user_id uuid NOT NULL, client_id uuid NOT NULL,
      property_id uuid NOT NULL, building_id uuid NOT NULL,
      assignment_role text NOT NULL DEFAULT 'FIELD',
      status text NOT NULL,
      assigned_by_user_id uuid,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      unassigned_at timestamptz,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE tenant_companies(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, building_id uuid NOT NULL,
      code text NOT NULL, name text NOT NULL, status text NOT NULL,
      UNIQUE (id, client_id)
    );
    CREATE TABLE tenant_pics(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, tenant_company_id uuid NOT NULL,
      user_id uuid, full_name text NOT NULL, email text, phone text,
      role_label text, is_primary boolean NOT NULL DEFAULT true, status text NOT NULL
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
      tenant_pic_id uuid, property_id uuid NOT NULL, building_id uuid NOT NULL,
      floor_id uuid, room_id uuid, area_id uuid,
      location_description text, request_code text NOT NULL,
      title text NOT NULL, description text NOT NULL,
      requested_work_category text, priority text NOT NULL,
      status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, client_id)
    );
    CREATE TABLE handyman_quotations(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
      tenant_company_id uuid NOT NULL, building_id uuid NOT NULL,
      quotation_number text NOT NULL, current_version_number int NOT NULL DEFAULT 1,
      created_by_user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, client_id)
    );
    CREATE TABLE handyman_quotation_versions(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, quotation_id uuid NOT NULL,
      version_number int NOT NULL, status text NOT NULL, currency text NOT NULL,
      subtotal_labor numeric(18,2) NOT NULL, subtotal_material numeric(18,2) NOT NULL,
      discount_amount numeric(18,2) NOT NULL, tax_amount numeric(18,2) NOT NULL,
      total_amount numeric(18,2) NOT NULL, valid_until date, notes text,
      prepared_by_user_id uuid NOT NULL, issued_by_user_id uuid,
      issued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, client_id)
    );
    CREATE TABLE handyman_quotation_lines(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, quotation_version_id uuid NOT NULL,
      line_number int NOT NULL, line_type text NOT NULL, source_item_id uuid,
      description text NOT NULL, quantity numeric(14,3) NOT NULL, uom_id uuid NOT NULL,
      cost_basis_unit_amount numeric(18,2) NOT NULL, margin_percent numeric(7,4) NOT NULL,
      reference_unit_amount numeric(18,2) NOT NULL, final_quoted_unit_amount numeric(18,2) NOT NULL,
      line_total numeric(18,2) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_quotation_decisions(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, quotation_version_id uuid NOT NULL,
      decision text NOT NULL, decided_by_actor_type text NOT NULL,
      decided_by_user_id uuid NOT NULL, decision_note text,
      evidence_reference text, decided_at timestamptz NOT NULL DEFAULT now()
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
      superseded_by_assignment_id uuid, superseded_by_user_id uuid,
      superseded_at timestamptz, notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
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
  } finally {
    client.release();
  }

  await pool.query(`
    INSERT INTO clients VALUES ('${CLIENT_A}', 'ACTIVE');
    INSERT INTO properties VALUES ('${PROPERTY_A}', '${CLIENT_A}', 'ACTIVE');
    INSERT INTO buildings VALUES ('${BUILDING_A1}', '${CLIENT_A}', '${PROPERTY_A}', 'BLD-A1', 'Tower A1', 'ACTIVE');
    INSERT INTO tenant_companies VALUES ('${TENANT_A}', '${CLIENT_A}', '${BUILDING_A1}', 'TC-A', 'PT Tenant Alpha', 'ACTIVE');

    INSERT INTO users VALUES
      ('${LEAD_USER_A}', 'ACTIVE', 'Budi Lead A', 'lead.a@example.com'),
      ('${INSPECTOR_USER_A}', 'ACTIVE', 'Indra Inspector A', 'inspector.a@example.com'),
      ('${OPS_MANAGER_A_ID()}', 'ACTIVE', 'Rina Ops Manager', 'ops.a@example.com'),
      ('${TENANT_USER_A}', 'ACTIVE', 'Siti Tenant PIC', 'tenant.a@example.com'),
      ('${HELPER_USER_A}', 'ACTIVE', 'Hendra Helper A', 'helper.a@example.com');

    INSERT INTO tenant_pics VALUES (
      '${TENANT_PIC_A}', '${CLIENT_A}', '${TENANT_A}', '${TENANT_USER_A}',
      'Siti Tenant PIC', 'tenant.a@example.com', '+62811111111', 'PIC', true, 'ACTIVE'
    );

    INSERT INTO user_building_assignments (id, user_id, client_id, property_id, building_id, status) VALUES
      ('${randomUUID()}', '${LEAD_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${INSPECTOR_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${OPS_MANAGER_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${TENANT_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${HELPER_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE');

    INSERT INTO units_of_measure VALUES
      ('${UOM_UNIT}', 'UNIT', 'Unit', 'unit', 'ACTIVE'),
      ('${UOM_PCS}', 'PCS', 'Pieces', 'pcs', 'ACTIVE');

    INSERT INTO organizations (id, client_id, code, name, status) VALUES ('${ORG_A}', '${CLIENT_A}', 'ORG-A', 'Vendor Org A', 'ACTIVE');
    INSERT INTO vendors VALUES ('${VENDOR_A}', '${CLIENT_A}', '${ORG_A}', 'ACTIVE');
    INSERT INTO handyman_provider_contexts (id, client_id, vendor_id, status) VALUES ('${PROVIDER_CTX_A}', '${CLIENT_A}', '${VENDOR_A}', 'ACTIVE');

    INSERT INTO workforce_profiles (id, client_id, organization_id, user_id, employee_code, full_name, workforce_type, status) VALUES
      ('${WF_LEAD_A}', '${CLIENT_A}', '${ORG_A}', '${LEAD_USER_A}', 'EMP-L1', 'Budi Lead A', 'EXTERNAL', 'ACTIVE'),
      ('${WF_INSP_A}', '${CLIENT_A}', '${ORG_A}', '${INSPECTOR_USER_A}', 'EMP-I1', 'Indra Inspector A', 'EXTERNAL', 'ACTIVE'),
      ('${WF_HELPER_A}', '${CLIENT_A}', '${ORG_A}', '${HELPER_USER_A}', 'EMP-H1', 'Hendra Helper A', 'EXTERNAL', 'ACTIVE');

    INSERT INTO vendor_workforce_bindings (id, client_id, vendor_id, workforce_profile_id, status) VALUES
      ('${randomUUID()}', '${CLIENT_A}', '${VENDOR_A}', '${WF_LEAD_A}', 'ACTIVE'),
      ('${randomUUID()}', '${CLIENT_A}', '${VENDOR_A}', '${WF_INSP_A}', 'ACTIVE'),
      ('${randomUUID()}', '${CLIENT_A}', '${VENDOR_A}', '${WF_HELPER_A}', 'ACTIVE');

    INSERT INTO workforce_building_assignments (id, client_id, workforce_profile_id, property_id, building_id, status) VALUES
      ('${randomUUID()}', '${CLIENT_A}', '${WF_LEAD_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${CLIENT_A}', '${WF_INSP_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${CLIENT_A}', '${WF_HELPER_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE');

    INSERT INTO handyman_worker_contexts (id, client_id, handyman_provider_context_id, workforce_profile_id, status) VALUES
      ('${WCTX_LEAD_A}', '${CLIENT_A}', '${PROVIDER_CTX_A}', '${WF_LEAD_A}', 'ACTIVE'),
      ('${WCTX_INSP_A}', '${CLIENT_A}', '${PROVIDER_CTX_A}', '${WF_INSP_A}', 'ACTIVE'),
      ('${WCTX_HELPER_A}', '${CLIENT_A}', '${PROVIDER_CTX_A}', '${WF_HELPER_A}', 'ACTIVE');

    INSERT INTO handyman_work_crews (id, client_id, handyman_provider_context_id, building_id, code, name, status, created_by_user_id) VALUES
      ('${CREW_A}', '${CLIENT_A}', '${PROVIDER_CTX_A}', '${BUILDING_A1}', 'CRW-A', 'Crew Alpha', 'ACTIVE', '${OPS_MANAGER_USER_A}');

    INSERT INTO handyman_crew_memberships (id, client_id, handyman_crew_id, handyman_worker_context_id, status, created_by_user_id) VALUES
      ('${MEM_LEAD_A}', '${CLIENT_A}', '${CREW_A}', '${WCTX_LEAD_A}', 'ACTIVE', '${OPS_MANAGER_USER_A}'),
      ('${MEM_HELPER_A}', '${CLIENT_A}', '${CREW_A}', '${WCTX_HELPER_A}', 'ACTIVE', '${OPS_MANAGER_USER_A}');

    INSERT INTO handyman_crew_leads (id, client_id, handyman_crew_id, handyman_crew_membership_id, lead_seq, designated_by_user_id) VALUES
      ('${randomUUID()}', '${CLIENT_A}', '${CREW_A}', '${MEM_LEAD_A}', 1, '${OPS_MANAGER_USER_A}');

    INSERT INTO handyman_service_requests (
      id, client_id, tenant_company_id, tenant_pic_id, property_id, building_id,
      location_description, request_code, title, description,
      requested_work_category, priority, status
    ) VALUES (
      '${REQ_A1}', '${CLIENT_A}', '${TENANT_A}', '${TENANT_PIC_A}', '${PROPERTY_A}', '${BUILDING_A1}',
      'Lobby North', 'HM-REQ-001', 'Fix ceiling leak', 'Water dripping near pantry',
      'PLUMBING', 'HIGH', 'IN_EXECUTION'
    );

    INSERT INTO handyman_quotations (
      id, client_id, handyman_request_id, tenant_company_id, building_id,
      quotation_number, current_version_number, created_by_user_id
    ) VALUES (
      '${QUO_A1}', '${CLIENT_A}', '${REQ_A1}', '${TENANT_A}', '${BUILDING_A1}',
      'HM-QUO-001', 1, '${OPS_MANAGER_USER_A}'
    );

    INSERT INTO handyman_quotation_versions (
      id, client_id, quotation_id, version_number, status, currency,
      subtotal_labor, subtotal_material, discount_amount, tax_amount, total_amount,
      notes, prepared_by_user_id, issued_by_user_id, issued_at
    ) VALUES (
      '${QVER_A1}', '${CLIENT_A}', '${QUO_A1}', 1, 'APPROVED', 'IDR',
      500000.00, 250000.00, 0.00, 82500.00, 832500.00,
      'Original approved scope', '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}', now()
    );

    INSERT INTO handyman_quotation_lines (
      id, client_id, quotation_version_id, line_number, line_type, source_item_id,
      description, quantity, uom_id, cost_basis_unit_amount, margin_percent,
      reference_unit_amount, final_quoted_unit_amount, line_total
    ) VALUES
      ('${QLINE_LABOR_A1}', '${CLIENT_A}', '${QVER_A1}', 1, 'LABOR', NULL,
       'Pipe sealing labor', 1.000, '${UOM_UNIT}', 350000.00, 42.8571, 500000.00, 500000.00, 500000.00),
      ('${QLINE_MAT_A1}', '${CLIENT_A}', '${QVER_A1}', 2, 'MATERIAL', NULL,
       'PVC Sealant Pipe 2 inch', 10.000, '${UOM_PCS}', 15000.00, 66.6667, 25000.00, 25000.00, 250000.00);

    INSERT INTO handyman_execution_scopes (
      id, client_id, handyman_request_id, quotation_id, approved_quotation_version_id,
      approval_decision_id, tenant_company_id, building_id, currency,
      approved_labor_subtotal, approved_material_subtotal, approved_discount_amount,
      approved_tax_amount, approved_total_amount, authorized_by_user_id
    ) VALUES (
      '${SCOPE_A1}', '${CLIENT_A}', '${REQ_A1}', '${QUO_A1}', '${QVER_A1}',
      '${randomUUID()}', '${TENANT_A}', '${BUILDING_A1}', 'IDR',
      500000.00, 250000.00, 0.00, 82500.00, 832500.00, '${OPS_MANAGER_USER_A}'
    );

    INSERT INTO handyman_execution_scope_assignments (
      id, client_id, execution_scope_id, handyman_provider_context_id, handyman_crew_id, assignment_seq, status, assigned_by_user_id
    ) VALUES (
      '${ASSIGN_A1}', '${CLIENT_A}', '${SCOPE_A1}', '${PROVIDER_CTX_A}', '${CREW_A}', 1, 'ACTIVE', '${OPS_MANAGER_USER_A}'
    );

    INSERT INTO handyman_visit_appointments VALUES (
      '${randomUUID()}', '${CLIENT_A}', '${BUILDING_A1}', '${TENANT_A}', '${REQ_A1}',
      NULL, 'INSPECTION', 'CONFIRMED', 'INSPECTOR_USER', '${INSPECTOR_USER_A}',
      '2026-10-15T01:00:00Z', '2026-10-15T02:00:00Z'
    );
  `);

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
    if (userId === OPS_MANAGER_USER_A) {
      return ['tenant_company.manage', 'tenant_company.read'];
    }
    return [];
  };

  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

function OPS_MANAGER_A_ID(): string {
  return OPS_MANAGER_USER_A;
}

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
  if (pool) {
    await closePool(pool);
  }
  if (pg) {
    try {
      await pg.stop();
    } catch {
      // ignore
    }
  }
  if (pgDir) {
    rmSync(pgDir, { recursive: true, force: true });
  }
});

async function apiPost(path: string, userId: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userId}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

async function apiGet(path: string, userId: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${userId}`,
    },
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

describe('CR-HM-FIELD-AUTHORITY-01 P0-B — Pekerjaan Tambah / Kurang (ADD / REDUCE)', () => {
  it('1: governs full 9-stage ADD lifecycle (FIELD_FINDING -> PROPOSAL -> OPERATIONS_REVIEW -> REVISED_QUOTATION -> TENANT_DECISION -> AUTHORIZED_SCOPE -> EXECUTION -> QC -> FINAL_CHARGE_ELIGIBILITY) without mutating original scope or auto-invoicing', async () => {
    // Stage 1: Inspector submits technical finding (FIELD_FINDING)
    const s1 = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/findings`,
      INSPECTOR_USER_A,
      {
        variationType: 'ADD',
        lineType: 'LABOR',
        title: 'Additional waterproofing membrane',
        description: 'Apply membrane behind pantry wall panel',
        technicalFinding: 'Hidden moisture seepage found behind drywall',
        quantity: 2,
        uomId: UOM_UNIT,
        evidenceReference: 'ev://finding/membrane-001',
        notes: 'Inspector technical recommendation',
        idempotencyKey: 'idem-add-finding-1',
      },
    );
    assert.equal(s1.status, 201, JSON.stringify(s1.body));
    const varId = s1.body.data.variation.id as string;
    assert.equal(s1.body.data.variation.status, 'FIELD_FINDING');
    assert.equal(s1.body.data.variation.originActorRole, 'INSPECTOR');

    // Inspector CANNOT promote to PROPOSAL (role guard)
    const inspPropose = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/propose`,
      INSPECTOR_USER_A,
      {
        idempotencyKey: 'idem-insp-illegal-propose',
      },
    );
    assert.equal(inspPropose.status, 403);
    assert.equal(
      inspPropose.body.error.code,
      'HANDYMAN_VARIATION_ROLE_FORBIDDEN',
    );

    // Stage 2: PIC Pekerjaan promotes finding to PROPOSAL
    const s2 = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/propose`,
      LEAD_USER_A,
      {
        evidenceReference: 'ev://proposal/membrane-002',
        notes: 'Crew Lead proposes additional waterproofing scope',
        idempotencyKey: 'idem-add-propose-1',
        expectedVersion: 1,
      },
    );
    assert.equal(s2.status, 200, JSON.stringify(s2.body));
    assert.equal(s2.body.data.variation.status, 'PROPOSAL');
    assert.equal(s2.body.data.variation.version, 2);

    // PIC Pekerjaan CANNOT approve / review (role guard)
    const leadReview = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/operations-review`,
      LEAD_USER_A,
      {
        idempotencyKey: 'idem-lead-illegal-review',
      },
    );
    assert.equal(leadReview.status, 403);
    assert.equal(
      leadReview.body.error.code,
      'HANDYMAN_VARIATION_ROLE_FORBIDDEN',
    );

    // Pending variation MUST NOT expand executable scope yet
    const readPending = await apiGet(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations`,
      LEAD_USER_A,
    );
    assert.equal(readPending.status, 200);
    assert.equal(
      readPending.body.data.reconciledAuthorizedScope.authorizedAddedItems
        .length,
      0,
    );
    assert.equal(
      readPending.body.data.reconciledAuthorizedScope.pendingVariationsCount,
      1,
    );

    // Stage 3: Operations/Manager reviews variation (OPERATIONS_REVIEW)
    const s3 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/operations-review`,
      OPS_MANAGER_USER_A,
      {
        evidenceReference: 'ev://ops-review/membrane-003',
        notes: 'Verified technical need with inspector report',
        idempotencyKey: 'idem-add-ops-review-1',
        expectedVersion: 2,
      },
    );
    assert.equal(s3.status, 200, JSON.stringify(s3.body));
    assert.equal(s3.body.data.variation.status, 'OPERATIONS_REVIEW');
    assert.equal(s3.body.data.variation.version, 3);

    // Stage 4: Operations/Manager prepares revised quotation (REVISED_QUOTATION)
    const s4 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 175000,
        currency: 'IDR',
        evidenceReference: 'ev://revised-quo/membrane-004',
        notes: 'Revised quotation prepared for tenant approval',
        idempotencyKey: 'idem-add-rev-quo-1',
        expectedVersion: 3,
      },
    );
    assert.equal(s4.status, 200, JSON.stringify(s4.body));
    assert.equal(s4.body.data.variation.status, 'REVISED_QUOTATION');
    assert.equal(s4.body.data.variation.quotedUnitAmount, '175000.00');
    assert.equal(s4.body.data.variation.quotedTotalDelta, '350000.00');
    assert.equal(s4.body.data.variation.version, 4);

    // Guard: Operations/Manager CANNOT impersonate Tenant consent!
    const opsImpersonate = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`,
      OPS_MANAGER_USER_A,
      {
        decision: 'APPROVE',
        evidenceReference: 'ev://fake-tenant-consent',
        idempotencyKey: 'idem-ops-impersonate',
      },
    );
    assert.equal(opsImpersonate.status, 403);
    assert.equal(
      opsImpersonate.body.error.code,
      'HANDYMAN_VARIATION_TENANT_IMPERSONATION_FORBIDDEN',
    );

    // Guard: PIC Pekerjaan CANNOT record Tenant decision!
    const leadImpersonate = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`,
      LEAD_USER_A,
      {
        decision: 'APPROVE',
        evidenceReference: 'ev://fake-lead-consent',
        idempotencyKey: 'idem-lead-impersonate',
      },
    );
    assert.equal(leadImpersonate.status, 403);

    // Guard: Tenant decision with mismatched revisedQuotationVersionId is rejected!
    const mismatchedQvDecision = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`,
      TENANT_USER_A,
      {
        decision: 'APPROVE',
        revisedQuotationVersionId: randomUUID(),
        evidenceReference: 'ev://mismatched-qv',
        idempotencyKey: 'idem-mismatched-qv',
      },
    );
    assert.equal(mismatchedQvDecision.status, 409);
    assert.equal(
      mismatchedQvDecision.body.error.code,
      'HANDYMAN_VARIATION_ILLEGAL_TRANSITION',
    );

    // Stage 5: Authorized Tenant PIC user approves variation (TENANT_DECISION)
    const s5 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`,
      TENANT_USER_A,
      {
        decision: 'APPROVE',
        revisedQuotationVersionId: QVER_A1,
        evidenceReference: 'ev://tenant-consent/membrane-005',
        notes: 'Approved by Tenant PIC Siti',
        idempotencyKey: 'idem-add-tenant-approve-1',
        expectedVersion: 4,
      },
    );
    assert.equal(s5.status, 200, JSON.stringify(s5.body));
    assert.equal(s5.body.data.variation.status, 'TENANT_DECISION');
    assert.equal(s5.body.data.variation.tenantDecisionOutcome, 'APPROVED');
    assert.equal(s5.body.data.variation.tenantDecidedByUserId, TENANT_USER_A);

    // Stage 6: Operations/Manager authorizes scope (AUTHORIZED_SCOPE)
    const s6 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/authorize-scope`,
      OPS_MANAGER_USER_A,
      {
        evidenceReference: 'ev://auth-scope/membrane-006',
        notes: 'Scope authorized after tenant approval',
        idempotencyKey: 'idem-add-auth-scope-1',
        expectedVersion: 5,
      },
    );
    assert.equal(s6.status, 200, JSON.stringify(s6.body));
    assert.equal(s6.body.data.variation.status, 'AUTHORIZED_SCOPE');
    assert.equal(
      s6.body.data.reconciledAuthorizedScope.authorizedAddedItems.length,
      1,
    );
    assert.equal(
      s6.body.data.reconciledAuthorizedScope.authorizedAddedItems[0]
        .variationId,
      varId,
    );

    // Stage 7: Assigned PIC Pekerjaan records execution (EXECUTION)
    const s7 = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/execution`,
      LEAD_USER_A,
      {
        evidenceReference: 'ev://execution/membrane-007',
        notes: 'Membrane installed and cured',
        idempotencyKey: 'idem-add-exec-1',
        expectedVersion: 6,
      },
    );
    assert.equal(s7.status, 200, JSON.stringify(s7.body));
    assert.equal(s7.body.data.variation.status, 'EXECUTION');

    // Guard: PIC Pekerjaan cannot self-QC their own variation execution
    const leadSelfQc = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/qc`,
      LEAD_USER_A,
      {
        qcOutcome: 'PASSED',
        evidenceReference: 'ev://self-qc',
        idempotencyKey: 'idem-self-qc',
      },
    );
    assert.equal(leadSelfQc.status, 403);

    // Guard: Inspector technical inspection authority CANNOT bypass Supervisor QC authority!
    const inspectorBypassQc = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/qc`,
      INSPECTOR_USER_A,
      {
        qcOutcome: 'PASSED',
        evidenceReference: 'ev://inspector-bypass-qc',
        idempotencyKey: 'idem-inspector-bypass-qc',
      },
    );
    assert.equal(inspectorBypassQc.status, 403);
    assert.equal(
      inspectorBypassQc.body.error.code,
      'HANDYMAN_VARIATION_ROLE_FORBIDDEN',
    );

    // Stage 8: Authorized Supervisor / Operations Manager verifies QC (QC PASSED)
    const s8 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/qc`,
      OPS_MANAGER_USER_A,
      {
        qcOutcome: 'PASSED',
        evidenceReference: 'ev://qc/membrane-008',
        notes: 'Moisture test passed after membrane installation',
        idempotencyKey: 'idem-add-qc-1',
        expectedVersion: 7,
      },
    );
    assert.equal(s8.status, 200, JSON.stringify(s8.body));
    assert.equal(s8.body.data.variation.status, 'QC');
    assert.equal(s8.body.data.variation.qcOutcome, 'PASSED');

    // Stage 9: Operations/Manager confirms FINAL_CHARGE_ELIGIBILITY (without auto-invoicing)
    const s9 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/final-charge-eligibility`,
      OPS_MANAGER_USER_A,
      {
        evidenceReference: 'ev://final-charge/membrane-009',
        notes: 'Eligible for downstream final charge settlement',
        idempotencyKey: 'idem-add-final-charge-1',
        expectedVersion: 8,
      },
    );
    assert.equal(s9.status, 200, JSON.stringify(s9.body));
    assert.equal(s9.body.data.variation.status, 'FINAL_CHARGE_ELIGIBILITY');
    assert.equal(s9.body.data.variation.finalChargeEligible, true);
    assert.equal(s9.body.data.variation.invoiced, false);
    assert.equal(s9.body.data.events.length, 9);

    // Verify original approved scope row & quotation lines are 100% untouched
    const origScopeRes = await getPool().query(
      'SELECT approved_total_amount::text FROM handyman_execution_scopes WHERE id = $1',
      [SCOPE_A1],
    );
    assert.equal(origScopeRes.rows[0].approved_total_amount, '832500.00');
  });

  it('2: governs REDUCE (Pekerjaan Kurang) lifecycle, reconciles remaining authorized quantity, and blocks over-reduction', async () => {
    // PIC Pekerjaan proposes REDUCE of 4.000 pcs on original material line (10.000 pcs)
    const prop = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/proposals`,
      LEAD_USER_A,
      {
        variationType: 'REDUCE',
        lineType: 'MATERIAL',
        targetQuotationLineId: QLINE_MAT_A1,
        title: 'Reduce PVC Sealant Pipe quantity',
        description: 'Shorter pipe run required after rerouting',
        technicalFinding: 'Only 6 pcs needed instead of 10 pcs',
        quantity: 4,
        uomId: UOM_PCS,
        evidenceReference: 'ev://reduce/pipe-001',
        notes: 'Pekerjaan Kurang 4 pcs',
        idempotencyKey: 'idem-reduce-prop-1',
      },
    );
    assert.equal(prop.status, 201, JSON.stringify(prop.body));
    const reduceVarId = prop.body.data.variation.id as string;
    assert.equal(prop.body.data.variation.status, 'PROPOSAL');

    // While pending, reconciled original line still has remainingAuthorizedQuantity = 10.000
    const beforeAuth = await apiGet(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations`,
      LEAD_USER_A,
    );
    const matLineBefore =
      beforeAuth.body.data.reconciledAuthorizedScope.reconciledOriginalLines.find(
        (l: { quotationLineId: string }) => l.quotationLineId === QLINE_MAT_A1,
      );
    assert.equal(matLineBefore.originalQuantity, '10.000');
    assert.equal(matLineBefore.authorizedReducedQuantity, '0.000');
    assert.equal(matLineBefore.remainingAuthorizedQuantity, '10.000');

    // Operations reviews -> Revised quotation -> Tenant approves -> Authorize scope
    const rev = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${reduceVarId}/operations-review`,
      OPS_MANAGER_USER_A,
      { idempotencyKey: 'idem-red-rev-1' },
    );
    assert.equal(rev.status, 200);

    const quo = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${reduceVarId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 25000,
        currency: 'IDR',
        idempotencyKey: 'idem-red-quo-1',
      },
    );
    assert.equal(quo.status, 200);
    assert.equal(quo.body.data.variation.quotedTotalDelta, '-100000.00');

    const ten = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${reduceVarId}/tenant-decision`,
      TENANT_USER_A,
      {
        decision: 'APPROVE',
        evidenceReference: 'ev://tenant-approve-reduce',
        idempotencyKey: 'idem-red-ten-1',
      },
    );
    assert.equal(ten.status, 200);

    const auth = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${reduceVarId}/authorize-scope`,
      OPS_MANAGER_USER_A,
      { idempotencyKey: 'idem-red-auth-1' },
    );
    assert.equal(auth.status, 200);
    const matLineAfter =
      auth.body.data.reconciledAuthorizedScope.reconciledOriginalLines.find(
        (l: { quotationLineId: string }) => l.quotationLineId === QLINE_MAT_A1,
      );
    assert.equal(matLineAfter.originalQuantity, '10.000');
    assert.equal(matLineAfter.authorizedReducedQuantity, '4.000');
    assert.equal(matLineAfter.remainingAuthorizedQuantity, '6.000');

    // Original quotation line in DB is still 10.000 (immutable!)
    const origLineRes = await getPool().query(
      'SELECT quantity::text FROM handyman_quotation_lines WHERE id = $1',
      [QLINE_MAT_A1],
    );
    assert.equal(origLineRes.rows[0].quantity, '10.000');

    // Attempting another REDUCE of 7.000 pcs (exceeding remaining 6.000 pcs) fails with 409
    const overReduce = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/proposals`,
      LEAD_USER_A,
      {
        variationType: 'REDUCE',
        lineType: 'MATERIAL',
        targetQuotationLineId: QLINE_MAT_A1,
        title: 'Over-reduce PVC pipe',
        description: 'Attempt to reduce by 7 when only 6 remain',
        technicalFinding: 'Over reduction test',
        quantity: 7,
        uomId: UOM_PCS,
        evidenceReference: 'ev://reduce/over-001',
        idempotencyKey: 'idem-over-reduce-1',
      },
    );
    assert.equal(overReduce.status, 409);
    assert.equal(
      overReduce.body.error.code,
      'HANDYMAN_VARIATION_REDUCE_EXCEEDS_REMAINING',
    );
  });

  it('3: enforces rejected variation terminal guard, idempotency conflict detection, and optimistic concurrency control', async () => {
    // Propose an ADD variation that the Tenant will reject
    const prop = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/proposals`,
      LEAD_USER_A,
      {
        variationType: 'ADD',
        lineType: 'LABOR',
        title: 'Optional decorative repaint',
        description: 'Repaint adjacent corridor',
        technicalFinding: 'Cosmetic paint wear',
        quantity: 1,
        uomId: UOM_UNIT,
        evidenceReference: 'ev://prop/repaint-001',
        idempotencyKey: 'idem-reject-flow-1',
      },
    );
    assert.equal(prop.status, 201);
    const rejVarId = prop.body.data.variation.id as string;

    // Idempotent replay with same key & payload returns 200 with replayed=true
    const replayOk = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/proposals`,
      LEAD_USER_A,
      {
        variationType: 'ADD',
        lineType: 'LABOR',
        title: 'Optional decorative repaint',
        description: 'Repaint adjacent corridor',
        technicalFinding: 'Cosmetic paint wear',
        quantity: 1,
        uomId: UOM_UNIT,
        evidenceReference: 'ev://prop/repaint-001',
        idempotencyKey: 'idem-reject-flow-1',
      },
    );
    assert.equal(replayOk.status, 200);
    assert.equal(replayOk.body.data.replayed, true);

    // Idempotent replay with different quantity returns 409 HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT
    const replayConflict = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/proposals`,
      LEAD_USER_A,
      {
        variationType: 'ADD',
        lineType: 'LABOR',
        title: 'Optional decorative repaint',
        description: 'Repaint adjacent corridor',
        technicalFinding: 'Cosmetic paint wear',
        quantity: 5,
        uomId: UOM_UNIT,
        evidenceReference: 'ev://prop/repaint-001',
        idempotencyKey: 'idem-reject-flow-1',
      },
    );
    assert.equal(replayConflict.status, 409);
    assert.equal(
      replayConflict.body.error.code,
      'HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT',
    );

    // Stale expectedVersion returns 409 HANDYMAN_VARIATION_VERSION_CONFLICT
    const staleVer = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${rejVarId}/operations-review`,
      OPS_MANAGER_USER_A,
      {
        idempotencyKey: 'idem-stale-ver-1',
        expectedVersion: 99,
      },
    );
    assert.equal(staleVer.status, 409);
    assert.equal(
      staleVer.body.error.code,
      'HANDYMAN_VARIATION_VERSION_CONFLICT',
    );

    // Advance to REVISED_QUOTATION and Tenant REJECTS
    await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${rejVarId}/operations-review`,
      OPS_MANAGER_USER_A,
      { idempotencyKey: 'idem-rej-rev-1' },
    );
    await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${rejVarId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 300000,
        currency: 'IDR',
        idempotencyKey: 'idem-rej-quo-1',
      },
    );
    const rejDec = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${rejVarId}/tenant-decision`,
      TENANT_USER_A,
      {
        decision: 'REJECT',
        evidenceReference: 'ev://tenant-reject/repaint',
        notes: 'Declined optional repaint',
        idempotencyKey: 'idem-rej-dec-1',
      },
    );
    assert.equal(rejDec.status, 200);
    assert.equal(rejDec.body.data.variation.tenantDecisionOutcome, 'REJECTED');

    // Rejected variation CANNOT be authorized into executable scope
    const illegalAuth = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${rejVarId}/authorize-scope`,
      OPS_MANAGER_USER_A,
      { idempotencyKey: 'idem-illegal-auth-rejected' },
    );
    assert.equal(illegalAuth.status, 409);
    assert.equal(
      illegalAuth.body.error.code,
      'HANDYMAN_VARIATION_ILLEGAL_TRANSITION',
    );

    // Helper user is denied from field variation reads and proposals
    const helperRead = await apiGet(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations`,
      HELPER_USER_A,
    );
    assert.equal(helperRead.status, 403);
  });
});
