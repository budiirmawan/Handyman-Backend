/**
 * CR-HM-FIELD-AUTHORITY-01 P0-C — Material & Purchasing Lifecycle
 * Focused Lifecycle, 4-Way Ledger Separation, Role & Concurrency Test Suite.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { createEvidenceStorage } from '../src/modules/evidence/storage';
import { migration0436CreateHandymanMaterialPurchasing } from '../src/database/migrations/0436_create_handyman_material_purchasing';

const CLIENT_A = '10000000-0000-4000-8000-000000000001';
const PROPERTY_A = '10000000-0000-4000-8000-000000000011';
const BUILDING_A1 = '10000000-0000-4000-8000-000000000021';
const TENANT_A = '10000000-0000-4000-8000-000000000031';

const LEAD_USER_A = '10000000-0000-4000-8000-000000000101';
const INSPECTOR_USER_A = '10000000-0000-4000-8000-000000000102';
const OPS_MANAGER_USER_A = '10000000-0000-4000-8000-000000000103';
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
const SCOPE_A1 = '10000000-0000-4000-8000-000000000501';
const ASSIGN_A1 = '10000000-0000-4000-8000-000000000601';

const UOM_PCS = '10000000-0000-4000-8000-000000000702';

let pg: EmbeddedPostgres | null = null;
let pgDir: string | null = null;
let evidenceStorageDir = '';
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


/** Seeds a genuinely VERIFIED managed evidence upload (real bytes + SHA-256
 * in the configured storage dir) and returns its hm-ev:// reference. */
async function verifiedEvidenceRef(seed: string): Promise<string> {
  const hex = createHash('sha256').update(seed).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(seed),
  ]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await createEvidenceStorage().put(`evidence/${id}`, { buffer: bytes, mimeType: 'image/png' });
  await pool!.query(
    `INSERT INTO handyman_field_evidence_uploads
       (id, client_id, tenant_company_id, building_id, handyman_request_id, execution_scope_id,
        purpose, upload_status, original_file_name, mime_type, storage_key, declared_byte_size,
        verified_byte_size, sha256_checksum, attachment_reference, uploaded_by_user_id,
        uploaded_by_role, idempotency_key, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,'MATERIAL_RECEIPT','VERIFIED','seed.png','image/png',$7,$8,$8,$9,$10,$11,'PIC_PEKERJAAN',$12,NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, CLIENT_A, TENANT_A, BUILDING_A1, REQ_A1, SCOPE_A1, `evidence/${id}`, bytes.byteLength, sha, `hm-ev://${id}`, LEAD_USER_A, `seed-${id}`],
  );
  return `hm-ev://${id}`;
}

before(async () => {
  pgDir = mkdtempSync(join(tmpdir(), 'hm-mat-purch-'));
  evidenceStorageDir = mkdtempSync(join(tmpdir(), 'hm-evidence-store-'));
  process.env.EVIDENCE_STORAGE_DIR = evidenceStorageDir;
  pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    port: 55446,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();

  pool = await initDatabase({
    host: '127.0.0.1',
    port: 55446,
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


  await pool.query(`
    CREATE TABLE IF NOT EXISTS handyman_field_evidence_uploads (
      id uuid PRIMARY KEY, client_id uuid NOT NULL, tenant_company_id uuid NOT NULL,
      building_id uuid NOT NULL, handyman_request_id uuid NOT NULL, execution_scope_id uuid,
      variation_id uuid, material_purchase_record_id uuid, purpose text NOT NULL,
      upload_status text NOT NULL, original_file_name text NOT NULL, mime_type text NOT NULL,
      storage_key text NOT NULL UNIQUE, declared_byte_size int, verified_byte_size int NOT NULL DEFAULT 0,
      sha256_checksum varchar(64), attachment_reference text UNIQUE, uploaded_by_user_id uuid NOT NULL,
      uploaded_by_role text NOT NULL, notes text, idempotency_key text NOT NULL,
      verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const client = await pool.connect();
  try {
    await migration0436CreateHandymanMaterialPurchasing.up(client);
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
      ('${OPS_MANAGER_USER_A}', 'ACTIVE', 'Rina Ops Manager', 'ops.a@example.com'),
      ('${HELPER_USER_A}', 'ACTIVE', 'Hendra Helper A', 'helper.a@example.com');

    INSERT INTO user_building_assignments (id, user_id, client_id, property_id, building_id, status) VALUES
      ('${randomUUID()}', '${LEAD_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${INSPECTOR_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${OPS_MANAGER_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${HELPER_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE');

    INSERT INTO units_of_measure VALUES ('${UOM_PCS}', 'PCS', 'Pieces', 'pcs', 'ACTIVE');

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
      id, client_id, tenant_company_id, property_id, building_id,
      request_code, title, description, priority, status
    ) VALUES (
      '${REQ_A1}', '${CLIENT_A}', '${TENANT_A}', '${PROPERTY_A}', '${BUILDING_A1}',
      'HM-REQ-001', 'Fix ceiling leak', 'Water dripping near pantry', 'HIGH', 'IN_EXECUTION'
    );

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

describe('CR-HM-FIELD-AUTHORITY-01 P0-C — Material & Purchasing Lifecycle', () => {
  it('1: governs full supplier purchase & reimbursement lifecycle (REQUEST -> APPROVAL -> PURCHASED -> USAGE -> RETURN -> RECONCILIATION) and preserves 4-way ledger separation', async () => {
    // 1. REQUEST: PIC Pekerjaan requests 10 pcs Brass Valve via REIMBURSEMENT
    const reqRes = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases/requests`,
      LEAD_USER_A,
      {
        itemName: 'Brass Valve 3/4 inch',
        uomId: UOM_PCS,
        uomCode: 'PCS',
        fundingSource: 'REIMBURSEMENT',
        requestedQuantity: 10,
        supplierName: 'Toko Bangunan Jaya',
        currency: 'IDR',
        evidenceReference: await verifiedEvidenceRef('ev://mat-req/valve-001'),
        notes: 'Urgent valve replacement',
        idempotencyKey: 'idem-mat-req-1',
      },
    );
    assert.equal(reqRes.status, 201, JSON.stringify(reqRes.body));
    const recId = reqRes.body.data.record.id as string;
    assert.equal(reqRes.body.data.record.status, 'REQUEST');

    // Guard: PIC Pekerjaan cannot self-approve
    const selfApp = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/material-purchases/${recId}/approve`,
      LEAD_USER_A,
      {
        approvalReference: 'APR-ILLEGAL',
        idempotencyKey: 'idem-illegal-approve',
      },
    );
    assert.equal(selfApp.status, 403);
    assert.equal(
      selfApp.body.error.code,
      'HANDYMAN_MATERIAL_PURCHASE_FORBIDDEN',
    );

    // 2. APPROVAL: Operations/Manager approves 10 pcs with max unit price 60000
    const appRes = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/material-purchases/${recId}/approve`,
      OPS_MANAGER_USER_A,
      {
        approvedQuantity: 10,
        approvedMaxUnitPrice: 60000,
        currency: 'IDR',
        approvalReference: 'APR-MAT-2026-001',
        expenditureReference: 'EXP-MAT-2026-001',
        evidenceReference: await verifiedEvidenceRef('ev://mat-approve/valve-002'),
        notes: 'Approved for field reimbursement purchase',
        idempotencyKey: 'idem-mat-app-1',
        expectedVersion: 1,
      },
    );
    assert.equal(appRes.status, 200, JSON.stringify(appRes.body));
    assert.equal(appRes.body.data.record.status, 'APPROVAL');
    assert.equal(appRes.body.data.record.approvedQuantity, '10.000');

    // 3. PURCHASED: PIC Pekerjaan purchases 10 pcs @ 55,000 IDR with receipt evidence
    const purRes = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases/${recId}/purchase`,
      LEAD_USER_A,
      {
        purchasedQuantity: 10,
        supplierName: 'Toko Bangunan Jaya',
        supplierReference: 'SUP-TBJ-01',
        purchaseReference: 'INV-TBJ-2026-889',
        actualUnitPrice: 55000,
        currency: 'IDR',
        purchaseDate: '2026-10-14T03:30:00.000Z',
        expenditureReference: 'EXP-MAT-2026-001',
        receiptEvidenceReference: await verifiedEvidenceRef('ev://receipt/tbj-889.jpg'),
        notes: 'Purchased 10 brass valves with store receipt',
        idempotencyKey: 'idem-mat-pur-1',
        expectedVersion: 2,
      },
    );
    assert.equal(purRes.status, 200, JSON.stringify(purRes.body));
    assert.equal(purRes.body.data.record.status, 'PURCHASED');
    assert.equal(purRes.body.data.record.actualUnitPrice, '55000.00');
    assert.equal(purRes.body.data.record.actualTotalExpenseAmount, '550000.00');
    assert.equal(
      purRes.body.data.record.reimbursementPayableAmount,
      '550000.00',
    );
    assert.equal(
      purRes.body.data.record.reimbursementStatus,
      'PENDING_RECONCILIATION',
    );

    // 4. USAGE: PIC Pekerjaan records actual usage of 7 pcs
    const useRes = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases/${recId}/usage`,
      LEAD_USER_A,
      {
        usedQuantity: 7,
        evidenceReference: await verifiedEvidenceRef('ev://usage/valve-installed.jpg'),
        notes: 'Installed 7 valves on riser manifold',
        idempotencyKey: 'idem-mat-use-1',
        expectedVersion: 3,
      },
    );
    assert.equal(useRes.status, 200, JSON.stringify(useRes.body));
    assert.equal(useRes.body.data.record.status, 'USAGE');
    assert.equal(useRes.body.data.record.usedQuantity, '7.000');
    assert.equal(useRes.body.data.record.netUsedExpenseAmount, '385000.00');

    // Guard: Cannot reconcile when 3 pcs are still unaccounted for (7 used + 0 returned != 10 purchased)
    const prematureRec = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/material-purchases/${recId}/reconcile`,
      OPS_MANAGER_USER_A,
      {
        idempotencyKey: 'idem-mat-premature-rec',
      },
    );
    assert.equal(prematureRec.status, 409);
    assert.equal(
      prematureRec.body.error.code,
      'HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION',
    );

    // 5. RETURN: PIC Pekerjaan returns 3 unused pcs to WAREHOUSE
    const retRes = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases/${recId}/return`,
      LEAD_USER_A,
      {
        returnedQuantity: 3,
        returnDestination: 'WAREHOUSE',
        evidenceReference: await verifiedEvidenceRef('ev://return/valve-warehouse.jpg'),
        notes: 'Returned 3 unused valves to building warehouse',
        idempotencyKey: 'idem-mat-ret-1',
        expectedVersion: 4,
      },
    );
    assert.equal(retRes.status, 200, JSON.stringify(retRes.body));
    assert.equal(retRes.body.data.record.status, 'RETURN');
    assert.equal(retRes.body.data.record.returnedQuantity, '3.000');

    // 6. RECONCILIATION: Operations/Manager reconciles movement, expense, reimbursement, and tenant charge eligibility
    const recRes = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/material-purchases/${recId}/reconcile`,
      OPS_MANAGER_USER_A,
      {
        tenantChargeEligible: true,
        evidenceReference: await verifiedEvidenceRef('ev://reconcile/valve-006'),
        notes: 'Reconciled 7 used + 3 warehouse return',
        idempotencyKey: 'idem-mat-rec-1',
        expectedVersion: 5,
      },
    );
    assert.equal(recRes.status, 200, JSON.stringify(recRes.body));
    const reconciled = recRes.body.data.record;
    assert.equal(reconciled.status, 'RECONCILIATION');
    assert.equal(reconciled.reimbursementStatus, 'RECONCILED_PAYABLE');
    assert.equal(reconciled.reimbursementPayableAmount, '550000.00');
    assert.equal(reconciled.tenantChargeEligible, true);
    assert.equal(reconciled.tenantChargeEligibleQty, '7.000'); // Only used qty!
    assert.equal(reconciled.tenantInvoiced, false);

    // Verify 4-way separation summary
    const summary = recRes.body.data.separationSummary;
    assert.equal(
      summary.operationalMaterialMovement.totalPurchasedQuantity,
      '10.000',
    );
    assert.equal(
      summary.operationalMaterialMovement.totalUsedQuantity,
      '7.000',
    );
    assert.equal(
      summary.operationalMaterialMovement.totalReturnedQuantity,
      '3.000',
    );
    assert.equal(
      summary.actualSupplierPurchasingExpense.totalPurchaseExpenseAmount,
      '550000.00',
    );
    assert.equal(
      summary.actualSupplierPurchasingExpense.totalNetUsedExpenseAmount,
      '385000.00',
    );
    assert.equal(
      summary.workerAdvanceReimbursementPayable.totalReimbursementPayableAmount,
      '550000.00',
    );
    assert.equal(
      summary.tenantInvoiceChargeEligibility.totalEligibleUsedQuantity,
      '7.000',
    );
    assert.equal(
      summary.tenantInvoiceChargeEligibility.anyTenantInvoiced,
      false,
    );
  });

  it('2: governs WAREHOUSE_STOCK issue lifecycle and enforces role-scoped field reads + idempotency/concurrency guards', async () => {
    const reqRes = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases/requests`,
      LEAD_USER_A,
      {
        itemName: 'PTFE Thread Seal Tape',
        uomId: UOM_PCS,
        uomCode: 'PCS',
        fundingSource: 'WAREHOUSE_STOCK',
        requestedQuantity: 5,
        evidenceReference: await verifiedEvidenceRef('ev://mat-req/tape-001'),
        idempotencyKey: 'idem-wh-req-1',
      },
    );
    assert.equal(reqRes.status, 201);
    const whRecId = reqRes.body.data.record.id as string;

    // Approve warehouse stock request
    const appRes = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/material-purchases/${whRecId}/approve`,
      OPS_MANAGER_USER_A,
      {
        approvedQuantity: 5,
        approvalReference: 'APR-WH-2026-002',
        idempotencyKey: 'idem-wh-app-1',
      },
    );
    assert.equal(appRes.status, 200);

    // Issue from warehouse
    const issRes = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases/${whRecId}/issue`,
      LEAD_USER_A,
      {
        issuedQuantity: 5,
        warehouseIssueReference: 'WH-ISS-2026-009',
        evidenceReference: await verifiedEvidenceRef('ev://wh-issue/tape-002'),
        idempotencyKey: 'idem-wh-iss-1',
      },
    );
    assert.equal(issRes.status, 200);
    assert.equal(issRes.body.data.record.status, 'ISSUED');
    assert.equal(issRes.body.data.record.issuedQuantity, '5.000');
    assert.equal(issRes.body.data.record.actualTotalExpenseAmount, '0.00');

    // Inspector read on field endpoint strips supplier expense/reimbursement fields
    const inspRead = await apiGet(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases`,
      INSPECTOR_USER_A,
    );
    assert.equal(inspRead.status, 200);
    assert.equal(inspRead.body.data.actorRole, 'INSPECTOR');
    assert.equal(inspRead.body.data.records.length, 2);
    for (const r of inspRead.body.data.records) {
      assert.equal('actualUnitPrice' in r, false);
      assert.equal('actualTotalExpenseAmount' in r, false);
      assert.equal('reimbursementPayableAmount' in r, false);
    }

    // Helper user is denied from field material-purchases read and request creation
    const helperDenied = await apiGet(
      `/handyman/field/execution-scopes/${SCOPE_A1}/material-purchases`,
      HELPER_USER_A,
    );
    assert.equal(helperDenied.status, 403);
  });
});
