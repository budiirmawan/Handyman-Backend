import { bmBindingTestFixture, bmClearanceTestFact } from './helpers/handyman-bm-clearance';
import { assessHandymanBmClearance, handymanBmClearanceVerifier, readBmWorkBinding } from '../src/modules/handyman-dispatch/handyman-bm-clearance';
import type { TestContext } from 'node:test';
/**
 * CR-HM-FIELD-AUTHORITY-01 P0-B — Pekerjaan Tambah / Kurang (ADD / REDUCE)
 * Focused Lifecycle, Role Separation, Impersonation & Concurrency Test Suite.
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
import { closePool, getPool, initDatabase, withTransaction } from '../src/database';
import { sessionService } from '../src/modules/auth/session.service';
import { buildingAssignmentRepository } from '../src/modules/building-assignments/building-assignment.repository';
import { buildingRepository } from '../src/modules/buildings/building.repository';
import { propertyRepository } from '../src/modules/properties/property.repository';
import { clientRepository } from '../src/modules/clients/client.repository';
import { userRepository } from '../src/modules/users/user.repository';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { createEvidenceStorage } from '../src/modules/evidence/storage';
import {
  HANDYMAN_BAST_CUSTOMER_CONSENT_METHOD, HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL,
  computeHandymanBastCustomerConsentDigest, type HandymanBastCustomerConsentManifest,
} from '../src/modules/handyman-bast';
import { migration0435CreateHandymanScopeVariations } from '../src/database/migrations/0435_create_handyman_scope_variations';
import { migration0443SeparateHandymanVariationQcAuthority }
  from '../src/database/migrations/0443_separate_handyman_variation_qc_authority';

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
const CARE_USER_A = '10000000-0000-4000-8000-000000000106';

const ORG_A = '10000000-0000-4000-8000-000000000201';
const VENDOR_A = '10000000-0000-4000-8000-000000000202';
const PROVIDER_CTX_A = '10000000-0000-4000-8000-000000000203';
const CREW_A = '10000000-0000-4000-8000-000000000204';

const WF_LEAD_A = '10000000-0000-4000-8000-000000000211';
const WF_INSP_A = '10000000-0000-4000-8000-000000000212';
const WF_HELPER_A = '10000000-0000-4000-8000-000000000213';
const WF_SUPERVISOR_A = '10000000-0000-4000-8000-000000000214';

const WCTX_LEAD_A = '10000000-0000-4000-8000-000000000221';
const WCTX_INSP_A = '10000000-0000-4000-8000-000000000222';
const WCTX_HELPER_A = '10000000-0000-4000-8000-000000000223';

const MEM_LEAD_A = '10000000-0000-4000-8000-000000000231';
const MEM_HELPER_A = '10000000-0000-4000-8000-000000000232';

const REQ_A1 = '10000000-0000-4000-8000-000000000301';
const QUO_A1 = '10000000-0000-4000-8000-000000000401';
const QVER_A1 = '10000000-0000-4000-8000-000000000411';
const QVER_A2_ADD = '10000000-0000-4000-8000-000000000412';
const QVER_A3_REDUCE = '10000000-0000-4000-8000-000000000413';
const QVER_A4_REJECT = '10000000-0000-4000-8000-000000000414';
const QVER_EMPTY = '10000000-0000-4000-8000-000000000415';
const QVER_WRONG_DELTA = '10000000-0000-4000-8000-000000000416';
const QLINE_LABOR_A1 = '10000000-0000-4000-8000-000000000421';
const QLINE_MAT_A1 = '10000000-0000-4000-8000-000000000422';
const SCOPE_A1 = '10000000-0000-4000-8000-000000000501';
const ASSIGN_A1 = '10000000-0000-4000-8000-000000000601';
const QCRUN_OPEN_A1 = '10000000-0000-4000-8000-000000000801';
const QCRUN_PASSED_A1 = '10000000-0000-4000-8000-000000000802';
const QC_CHECKLIST_VERSION_A1 = '10000000-0000-4000-8000-000000000803';
const DEFECT_A1 = '10000000-0000-4000-8000-000000000811';
const WSESS_A1 = '10000000-0000-4000-8000-000000000821';
const BAST_A1 = '10000000-0000-4000-8000-000000000831';
const INVOICE_A1 = '10000000-0000-4000-8000-000000000841';

const UOM_UNIT = '10000000-0000-4000-8000-000000000701';
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
const origListPermissionCodes = permissionRepository.listActivePermissionCodesForUser;


/** Seeds a genuinely VERIFIED managed evidence upload (real bytes + SHA-256
 * in the configured storage dir) and returns its hm-ev:// reference. */
async function verifiedEvidenceRef(
  seed: string,
  purpose = 'VARIATION_FINDING',
): Promise<string> {
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
     VALUES ($1,$2,$3,$4,$5,$6,$7,'VERIFIED','seed.png','image/png',$8,$9,$9,$10,$11,$12,'PIC_PEKERJAAN',$13,NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, CLIENT_A, TENANT_A, BUILDING_A1, REQ_A1, SCOPE_A1, purpose, `evidence/${id}`, bytes.byteLength, sha, `hm-ev://${id}`, LEAD_USER_A, `seed-${id}`],
  );
  return `hm-ev://${id}`;
}

/** Real approved ADD/REDUCE lifecycle, test-only independent BM boundary.
 * The surrounding binding shell is a unit fixture, NOT live BM coverage.
 */
async function assertBmWorkReassessment(t: TestContext,
  before: Awaited<ReturnType<typeof readBmWorkBinding>>,
  after: Awaited<ReturnType<typeof readBmWorkBinding>>,
) {
  assert.notDeepEqual(after, before, 'Approved work revision must change BM coverage input');
  const shell = bmBindingTestFixture();
  const oldBinding = { ...shell, ...before };
  const newBinding = { ...shell, ...after };
  const stale = t.mock.method(handymanBmClearanceVerifier, 'verify', async () => bmClearanceTestFact(oldBinding));
  try {
    assert.equal((await assessHandymanBmClearance(getPool(), newBinding)).state, 'BINDING_MISMATCH');
  } finally { stale.mock.restore(); }
  const renewed = t.mock.method(handymanBmClearanceVerifier, 'verify', async binding => bmClearanceTestFact(binding));
  try {
    assert.equal((await assessHandymanBmClearance(getPool(), newBinding)).state, 'VERIFIED');
  } finally { renewed.mock.restore(); }
}

before(async () => {
  pgDir = mkdtempSync(join(tmpdir(), 'hm-scope-var-'));
  evidenceStorageDir = mkdtempSync(join(tmpdir(), 'hm-evidence-store-'));
  process.env.EVIDENCE_STORAGE_DIR = evidenceStorageDir;
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
    CREATE TABLE tenant_space_relationships(
      id uuid PRIMARY KEY, tenant_company_id uuid NOT NULL,
      building_id uuid NOT NULL, space_id uuid NOT NULL,
      effective_from timestamptz, effective_until timestamptz,
      status text NOT NULL
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
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      -- CR-HM-FIELD-OPS-ACK-01 PART 02 repair: the production provider
      -- context authority projects provider_type (VENDOR | DIRECT); the
      -- stale fixture omitted it, so every case failed with
      -- 'column "provider_type" does not exist' instead of exercising its
      -- own assertion.
      provider_type text NOT NULL DEFAULT 'VENDOR'
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
    CREATE TABLE workforce_reporting_lines(
      id uuid PRIMARY KEY, workforce_profile_id uuid NOT NULL,
      supervisor_workforce_profile_id uuid NOT NULL,
      effective_from timestamptz, effective_until timestamptz,
      status text NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
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
      floor_id uuid, room_id uuid, area_id uuid, space_id uuid,
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
      total_amount numeric(18,2) NOT NULL, valid_until timestamptz, notes text,
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
      line_total numeric(18,2) NOT NULL, currency varchar(3) NOT NULL DEFAULT 'IDR',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_quotation_decisions(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, quotation_version_id uuid NOT NULL,
      decision text NOT NULL, decided_by_actor_type text NOT NULL,
      decided_by_user_id uuid NOT NULL, decision_note text,
      evidence_reference text, decided_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_execution_scopes(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, handyman_request_id uuid NOT NULL,
      channel_attribution_id uuid NOT NULL,
      quotation_id uuid NOT NULL, approved_quotation_version_id uuid NOT NULL,
      approval_decision_id uuid NOT NULL, quotation_decision_id uuid NOT NULL,
      tenant_company_id uuid NOT NULL, tenant_pic_id uuid,
      building_id uuid NOT NULL, floor_id uuid, area_id uuid, room_id uuid, space_id uuid,
      status text NOT NULL DEFAULT 'AUTHORIZED',
      currency text NOT NULL,
      approved_labor_subtotal numeric(18,2) NOT NULL,
      approved_material_subtotal numeric(18,2) NOT NULL,
      approved_discount_amount numeric(18,2) NOT NULL,
      approved_tax_amount numeric(18,2) NOT NULL,
      approved_total_amount numeric(18,2) NOT NULL,
      authorized_by_user_id uuid NOT NULL, created_by_user_id uuid NOT NULL,
      created_by_care_actor_id uuid, -- additive Commercial Bridge provenance (NULL in this direct-PIC fixture)
      authorized_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_execution_scope_assignments(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
      handyman_provider_context_id uuid NOT NULL,
      handyman_crew_id uuid NOT NULL, assignment_seq int NOT NULL DEFAULT 1,
      version int NOT NULL DEFAULT 1,
      status text NOT NULL, assigned_by_user_id uuid NOT NULL,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      supersedes_assignment_id uuid,
      superseded_by_assignment_id uuid, superseded_by_user_id uuid,
      superseded_at timestamptz, notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_qc_runs(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
      checklist_identity text NOT NULL, status text NOT NULL DEFAULT 'OPEN',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_qc_checklist_specs(
      execution_scope_id uuid PRIMARY KEY, client_id uuid NOT NULL,
      checklist_identity text NOT NULL, required_item_keys text[] NOT NULL,
      configured_by_user_id uuid NOT NULL,
      configured_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_qc_checklist_versions(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, code text NOT NULL,
      version_number int NOT NULL, required_item_keys text[] NOT NULL
    );
    CREATE TABLE handyman_qc_scope_checklist_bindings(
      execution_scope_id uuid PRIMARY KEY, checklist_version_id uuid NOT NULL,
      bound_by_user_id uuid NOT NULL, bound_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_qc_run_evidence(
      id uuid PRIMARY KEY, run_id uuid NOT NULL, evidence_upload_id uuid NOT NULL,
      actor_user_id uuid NOT NULL, idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_qc_run_items(
      id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES handyman_qc_runs(id),
      item_key text NOT NULL, outcome text NOT NULL DEFAULT 'PASS', note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_qc_run_events(
      id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES handyman_qc_runs(id),
      client_id uuid NOT NULL, event_type text NOT NULL, idempotency_key text NOT NULL,
      actor_user_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_defect_records(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
      run_id uuid REFERENCES handyman_qc_runs(id), description text NOT NULL,
      status text NOT NULL DEFAULT 'OPENED',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_work_sessions(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'IN_PROGRESS', completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_bast_documents(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, execution_scope_id uuid NOT NULL,
      qc_run_id uuid, rejected_at timestamptz,
      status text NOT NULL DEFAULT 'ISSUED', issued_at timestamptz, accepted_at timestamptz,
      voided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handyman_bast_events(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, bast_id uuid NOT NULL REFERENCES handyman_bast_documents(id),
      execution_scope_id uuid NOT NULL, event_type text NOT NULL, idempotency_key text NOT NULL,
      actor_user_id uuid NOT NULL, actor_care_actor_id uuid, commercial_consent_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE handyman_bast_sign_offs(
      id uuid PRIMARY KEY, client_id uuid NOT NULL, bast_id uuid NOT NULL REFERENCES handyman_bast_documents(id),
      event_id uuid NOT NULL REFERENCES handyman_bast_events(id), evidence_record_id uuid, reject_reason text,
      execution_scope_id uuid NOT NULL, decision text NOT NULL,
      signature_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE tenant_invoices(
      id uuid PRIMARY KEY, client_id uuid NOT NULL,
      handyman_execution_scope_id uuid, status text NOT NULL DEFAULT 'DRAFT',
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


  await pool.query(`
    CREATE TABLE IF NOT EXISTS handyman_field_evidence_uploads (
      id uuid PRIMARY KEY, client_id uuid NOT NULL, tenant_company_id uuid NOT NULL,
      building_id uuid NOT NULL, handyman_request_id uuid NOT NULL, execution_scope_id uuid,
      variation_id uuid, material_purchase_record_id uuid, purpose text NOT NULL,
      upload_status text NOT NULL, original_file_name text NOT NULL, mime_type text NOT NULL,
      storage_key text NOT NULL UNIQUE, declared_byte_size int, verified_byte_size int NOT NULL DEFAULT 0,
      sha256_checksum varchar(64), attachment_reference text UNIQUE, uploaded_by_user_id uuid NOT NULL,
      uploaded_by_role text NOT NULL, notes text, idempotency_key text NOT NULL,
      work_session_id uuid, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const client = await pool.connect();
  try {
    await migration0435CreateHandymanScopeVariations.up(client);
    await migration0443SeparateHandymanVariationQcAuthority.up(client);
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
      ('${HELPER_USER_A}', 'ACTIVE', 'Hendra Helper A', 'helper.a@example.com'),
      ('${CARE_USER_A}', 'ACTIVE', 'Care A', 'care.a@example.com');

    INSERT INTO tenant_pics VALUES (
      '${TENANT_PIC_A}', '${CLIENT_A}', '${TENANT_A}', '${TENANT_USER_A}',
      'Siti Tenant PIC', 'tenant.a@example.com', '+62811111111', 'PIC', true, 'ACTIVE'
    );

    INSERT INTO user_building_assignments (id, user_id, client_id, property_id, building_id, status) VALUES
      ('${randomUUID()}', '${LEAD_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${INSPECTOR_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${OPS_MANAGER_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${TENANT_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${HELPER_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE'),
      ('${randomUUID()}', '${CARE_USER_A}', '${CLIENT_A}', '${PROPERTY_A}', '${BUILDING_A1}', 'ACTIVE');

    INSERT INTO units_of_measure VALUES
      ('${UOM_UNIT}', 'UNIT', 'Unit', 'unit', 'ACTIVE'),
      ('${UOM_PCS}', 'PCS', 'Pieces', 'pcs', 'ACTIVE');

    INSERT INTO organizations (id, client_id, code, name, status) VALUES ('${ORG_A}', '${CLIENT_A}', 'ORG-A', 'Vendor Org A', 'ACTIVE');
    INSERT INTO vendors VALUES ('${VENDOR_A}', '${CLIENT_A}', '${ORG_A}', 'ACTIVE');
    INSERT INTO handyman_provider_contexts (id, client_id, vendor_id, status) VALUES ('${PROVIDER_CTX_A}', '${CLIENT_A}', '${VENDOR_A}', 'ACTIVE');

    INSERT INTO workforce_profiles (id, client_id, organization_id, user_id, employee_code, full_name, workforce_type, status) VALUES
      ('${WF_LEAD_A}', '${CLIENT_A}', '${ORG_A}', '${LEAD_USER_A}', 'EMP-L1', 'Budi Lead A', 'EXTERNAL', 'ACTIVE'),
      ('${WF_INSP_A}', '${CLIENT_A}', '${ORG_A}', '${INSPECTOR_USER_A}', 'EMP-I1', 'Indra Inspector A', 'EXTERNAL', 'ACTIVE'),
      ('${WF_HELPER_A}', '${CLIENT_A}', '${ORG_A}', '${HELPER_USER_A}', 'EMP-H1', 'Hendra Helper A', 'EXTERNAL', 'ACTIVE'),
      ('${WF_SUPERVISOR_A}', '${CLIENT_A}', '${ORG_A}', '${OPS_MANAGER_USER_A}', 'EMP-S1', 'Rina QC Supervisor', 'EXTERNAL', 'ACTIVE');

    INSERT INTO workforce_reporting_lines (
      id, workforce_profile_id, supervisor_workforce_profile_id, status
    ) VALUES (
      '${randomUUID()}', '${WF_LEAD_A}', '${WF_SUPERVISOR_A}', 'ACTIVE'
    );

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
    ) VALUES
      ('${QVER_A1}', '${CLIENT_A}', '${QUO_A1}', 1, 'APPROVED', 'IDR',
       500000.00, 250000.00, 0.00, 82500.00, 832500.00,
       'Original approved scope', '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}', now()),
      ('${QVER_A2_ADD}', '${CLIENT_A}', '${QUO_A1}', 2, 'ISSUED', 'IDR',
       850000.00, 250000.00, 0.00, 121000.00, 1221000.00,
       'Revised scope (+350000.00 ADD labor)', '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}', now()),
      ('${QVER_A3_REDUCE}', '${CLIENT_A}', '${QUO_A1}', 3, 'ISSUED', 'IDR',
       850000.00, 150000.00, 0.00, 110000.00, 1110000.00,
       'Revised scope (-100000.00 REDUCE material)', '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}', now()),
      ('${QVER_A4_REJECT}', '${CLIENT_A}', '${QUO_A1}', 4, 'ISSUED', 'IDR',
       1150000.00, 150000.00, 0.00, 143000.00, 1443000.00,
       'Revised scope (+300000.00 optional repaint)', '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}', now()),
      ('${QVER_EMPTY}', '${CLIENT_A}', '${QUO_A1}', 5, 'ISSUED', 'IDR',
       0.00, 0.00, 0.00, 0.00, 0.00,
       'Empty quotation version with no lines', '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}', now()),
      ('${QVER_WRONG_DELTA}', '${CLIENT_A}', '${QUO_A1}', 6, 'ISSUED', 'IDR',
       500000.00, 250000.00, 0.00, 82500.00, 832500.00,
       'Quotation version with unchanged 750000.00 line total', '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}', now());

    UPDATE handyman_quotation_versions SET valid_until = now() + interval '3 days' WHERE status = 'ISSUED';

    INSERT INTO handyman_quotation_lines (
      id, client_id, quotation_version_id, line_number, line_type, source_item_id,
      description, quantity, uom_id, cost_basis_unit_amount, margin_percent,
      reference_unit_amount, final_quoted_unit_amount, line_total
    ) VALUES
      ('${QLINE_LABOR_A1}', '${CLIENT_A}', '${QVER_A1}', 1, 'LABOR', NULL,
       'Pipe sealing labor', 1.000, '${UOM_UNIT}', 350000.00, 42.8571, 500000.00, 500000.00, 500000.00),
      ('${QLINE_MAT_A1}', '${CLIENT_A}', '${QVER_A1}', 2, 'MATERIAL', NULL,
       'PVC Sealant Pipe 2 inch', 10.000, '${UOM_PCS}', 15000.00, 66.6667, 25000.00, 25000.00, 250000.00),
      -- QVER_A2_ADD lines (total = 750000 + 350000 = 1100000.00)
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_A2_ADD}', 1, 'LABOR', NULL,
       'Pipe sealing labor', 1.000, '${UOM_UNIT}', 350000.00, 42.8571, 500000.00, 500000.00, 500000.00),
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_A2_ADD}', 2, 'MATERIAL', NULL,
       'PVC Sealant Pipe 2 inch', 10.000, '${UOM_PCS}', 15000.00, 66.6667, 25000.00, 25000.00, 250000.00),
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_A2_ADD}', 3, 'LABOR', NULL,
       'Additional waterproofing membrane', 2.000, '${UOM_UNIT}', 120000.00, 45.8333, 175000.00, 175000.00, 350000.00),
      -- QVER_A3_REDUCE lines (total = 1100000 - 100000 = 1000000.00)
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_A3_REDUCE}', 1, 'LABOR', NULL,
       'Pipe sealing labor', 1.000, '${UOM_UNIT}', 350000.00, 42.8571, 500000.00, 500000.00, 500000.00),
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_A3_REDUCE}', 2, 'MATERIAL', NULL,
       'PVC Sealant Pipe 2 inch (reduced to 6 pcs)', 6.000, '${UOM_PCS}', 15000.00, 66.6667, 25000.00, 25000.00, 150000.00),
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_A3_REDUCE}', 3, 'LABOR', NULL,
       'Additional waterproofing membrane', 2.000, '${UOM_UNIT}', 120000.00, 45.8333, 175000.00, 175000.00, 350000.00),
      -- QVER_A4_REJECT lines (total = 1000000 + 300000 = 1300000.00)
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_A4_REJECT}', 1, 'LABOR', NULL,
       'Pipe sealing + membrane + optional repaint', 1.000, '${UOM_UNIT}', 900000.00, 44.4444, 1300000.00, 1300000.00, 1300000.00),
      -- QVER_WRONG_DELTA lines (total = 750000.00, zero delta)
      ('${randomUUID()}', '${CLIENT_A}', '${QVER_WRONG_DELTA}', 1, 'LABOR', NULL,
       'Unchanged line total', 1.000, '${UOM_UNIT}', 500000.00, 50.0000, 750000.00, 750000.00, 750000.00);

    INSERT INTO handyman_qc_checklist_specs (
      execution_scope_id, client_id, checklist_identity, required_item_keys,
      configured_by_user_id, configured_at
    ) VALUES (
      '${SCOPE_A1}', '${CLIENT_A}', 'PLUMBING-QC-V1',
      ARRAY['MEMBRANE_SEAL']::text[], '${OPS_MANAGER_USER_A}',
      now() - interval '10 minutes'
    );
    INSERT INTO handyman_qc_checklist_versions (
      id, client_id, code, version_number, required_item_keys
    ) VALUES (
      '${QC_CHECKLIST_VERSION_A1}', '${CLIENT_A}', 'PLUMBING-QC-V1', 1,
      ARRAY['MEMBRANE_SEAL']::text[]
    );
    INSERT INTO handyman_qc_scope_checklist_bindings (
      execution_scope_id, checklist_version_id, bound_by_user_id, bound_at
    ) VALUES (
      '${SCOPE_A1}', '${QC_CHECKLIST_VERSION_A1}', '${OPS_MANAGER_USER_A}',
      now() - interval '10 minutes'
    );

    INSERT INTO handyman_qc_runs (id, client_id, execution_scope_id, checklist_identity, status) VALUES
      ('${QCRUN_OPEN_A1}', '${CLIENT_A}', '${SCOPE_A1}', 'PLUMBING-QC-V1', 'OPEN'),
      ('${QCRUN_PASSED_A1}', '${CLIENT_A}', '${SCOPE_A1}', 'PLUMBING-QC-V1', 'PASSED');

    INSERT INTO handyman_qc_run_items (id, run_id, item_key, outcome, note) VALUES
      ('${randomUUID()}', '${QCRUN_PASSED_A1}', 'MEMBRANE_SEAL', 'PASS', 'Verified watertight');

    INSERT INTO handyman_qc_run_events (
      id, run_id, client_id, event_type, idempotency_key, actor_user_id, metadata
    ) VALUES (
      '${randomUUID()}', '${QCRUN_PASSED_A1}', '${CLIENT_A}', 'FINISH',
      'idem-qc-finish-1', '${OPS_MANAGER_USER_A}',
      '{"outcome":"PASSED","expectedVersion":1,"templateVersionId":"${QC_CHECKLIST_VERSION_A1}"}'::jsonb
    );

    INSERT INTO handyman_defect_records (id, client_id, execution_scope_id, run_id, description, status) VALUES
      ('${DEFECT_A1}', '${CLIENT_A}', '${SCOPE_A1}', '${QCRUN_PASSED_A1}', 'Minor sealant bead gap', 'OPENED');

    INSERT INTO handyman_work_sessions (id, client_id, execution_scope_id, status) VALUES
      ('${WSESS_A1}', '${CLIENT_A}', '${SCOPE_A1}', 'IN_PROGRESS');

    INSERT INTO handyman_bast_documents (id, client_id, execution_scope_id, status, issued_at) VALUES
      ('${BAST_A1}', '${CLIENT_A}', '${SCOPE_A1}', 'ISSUED', now());

    INSERT INTO tenant_invoices (id, client_id, handyman_execution_scope_id, status) VALUES
      ('${INVOICE_A1}', '${CLIENT_A}', '${SCOPE_A1}', 'FINALIZED');

    INSERT INTO handyman_execution_scopes (
      id, client_id, handyman_request_id, channel_attribution_id,
      quotation_id, approved_quotation_version_id, approval_decision_id,
      quotation_decision_id, tenant_company_id, tenant_pic_id, building_id,
      floor_id, area_id, room_id, space_id, currency,
      approved_labor_subtotal, approved_material_subtotal, approved_discount_amount,
      approved_tax_amount, approved_total_amount, authorized_by_user_id,
      created_by_user_id
    ) VALUES (
      '${SCOPE_A1}', '${CLIENT_A}', '${REQ_A1}', '${randomUUID()}',
      '${QUO_A1}', '${QVER_A1}', '${randomUUID()}', '${randomUUID()}',
      '${TENANT_A}', '${TENANT_PIC_A}', '${BUILDING_A1}',
      NULL, NULL, NULL, NULL, 'IDR',
      500000.00, 250000.00, 0.00, 82500.00, 832500.00,
      '${OPS_MANAGER_USER_A}', '${OPS_MANAGER_USER_A}'
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
  const qcEvidenceReference = await verifiedEvidenceRef(
    'ev://qc/guarded-pass',
    'QC_EVIDENCE',
  );
  await pool.query(
    `INSERT INTO handyman_qc_run_evidence
       (id, run_id, evidence_upload_id, actor_user_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), QCRUN_PASSED_A1,
      qcEvidenceReference.slice('hm-ev://'.length), OPS_MANAGER_USER_A,
      'idem-qc-evidence-guarded-pass'],
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
  // This focused fixture mocks RBAC, while retaining the real customer-side
  // exclusion and the variation service's exact-Building and PIC checks.
  const codesFor = (userId: string): string[] => {
    if (userId === OPS_MANAGER_USER_A) {
      return ['tenant_company.manage', 'tenant_company.read', 'handyman.qc.manage', 'handyman.commercial.manage'];
    }
    if (userId === CARE_USER_A) return ['tenant_company.manage', 'tenant_company.read', 'handyman.care.building'];
    if (userId === TENANT_USER_A) return ['tenant_company.manage', 'handyman.commercial.manage'];
    return [];
  };
  permissionService.resolvePermissionsForUser = async (userId: string) => codesFor(userId);
  permissionRepository.listActivePermissionCodesForUser = async (userId: string) => codesFor(userId);

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
  permissionRepository.listActivePermissionCodesForUser = origListPermissionCodes;

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
  it('1: governs full 9-stage ADD lifecycle (FIELD_FINDING -> PROPOSAL -> OPERATIONS_REVIEW -> REVISED_QUOTATION -> TENANT_DECISION -> AUTHORIZED_SCOPE -> EXECUTION -> QC -> FINAL_CHARGE_ELIGIBILITY) without mutating original scope or auto-invoicing', async (t) => {
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
        quotedUnitAmount: 999999, // ignored: field findings cannot set commercial prices
        evidenceReference: await verifiedEvidenceRef('ev://finding/membrane-001'),
        notes: 'Inspector technical recommendation',
        idempotencyKey: 'idem-add-finding-1',
      },
    );
    assert.equal(s1.status, 201, JSON.stringify(s1.body));
    const varId = s1.body.data.variation.id as string;
    assert.equal(s1.body.data.variation.status, 'FIELD_FINDING');
    assert.equal(s1.body.data.variation.originActorRole, 'INSPECTOR');
    const fieldPrice = await getPool().query('SELECT quoted_unit_amount FROM handyman_scope_variations WHERE id = $1', [varId]);
    assert.equal(fieldPrice.rows[0].quoted_unit_amount, null);
    assert.equal('quotedUnitAmount' in s1.body.data.variation, false);

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
        evidenceReference: await verifiedEvidenceRef('ev://proposal/membrane-002'),
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
    const originalMaterial = readPending.body.data.reconciledAuthorizedScope.reconciledOriginalLines
      .find((line: { quotationLineId: string }) => line.quotationLineId === QLINE_MAT_A1);
    assert.equal(originalMaterial.remainingAuthorizedQuantity, '10.000');
    assert.equal((await getPool().query('SELECT status FROM handyman_work_sessions WHERE id = $1', [WSESS_A1])).rows[0].status, 'IN_PROGRESS');
    const prematureExecution = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/execution`,
      LEAD_USER_A,
      { evidenceReference: await verifiedEvidenceRef('ev://premature'), idempotencyKey: 'idem-premature', expectedVersion: 2 },
    );
    assert.equal(prematureExecution.status, 409);

    // Care's generic tenant management is not Operations pricing authority;
    // even a PIC who also holds that permission cannot review their own thread.
    for (const actor of [CARE_USER_A, TENANT_USER_A]) {
      const attempt = await apiPost(
        `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/operations-review`, actor,
        { idempotencyKey: `idem-forbidden-review-${actor}`, expectedVersion: 2 },
      );
      assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
    }

    // Stage 3: Operations/Manager reviews variation (OPERATIONS_REVIEW)
    const s3 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/operations-review`,
      OPS_MANAGER_USER_A,
      {
        evidenceReference: await verifiedEvidenceRef('ev://ops-review/membrane-003'),
        notes: 'Verified technical need with inspector report',
        idempotencyKey: 'idem-add-ops-review-1',
        expectedVersion: 2,
      },
    );
    assert.equal(s3.status, 200, JSON.stringify(s3.body));
    assert.equal(s3.body.data.variation.status, 'OPERATIONS_REVIEW');
    assert.equal(s3.body.data.variation.version, 3);
    const carePrice = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`, CARE_USER_A,
      { quotedUnitAmount: 175000, currency: 'IDR', revisedQuotationVersionId: QVER_A2_ADD,
        idempotencyKey: 'idem-care-price', expectedVersion: 3 },
    );
    assert.equal(carePrice.status, 403);
    const leadPrice = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`, LEAD_USER_A,
      { quotedUnitAmount: 175000, currency: 'IDR', revisedQuotationVersionId: QVER_A2_ADD,
        idempotencyKey: 'idem-lead-price', expectedVersion: 3 },
    );
    assert.equal(leadPrice.status, 403);

    // CHECK 1 Guard A: Omitting revisedQuotationVersionId fails closed (400 VALIDATION_ERROR)
    const omitQv = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 175000,
        currency: 'IDR',
        evidenceReference: await verifiedEvidenceRef('ev://revised-quo/membrane-omit'),
        idempotencyKey: 'idem-add-rev-quo-omit',
        expectedVersion: 3,
      },
    );
    assert.equal(omitQv.status, 400);

    // CHECK 1 Guard B: Reusing original approved quotation version (QVER_A1) fails closed (409)
    const reuseOrigQv = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 175000,
        currency: 'IDR',
        revisedQuotationVersionId: QVER_A1,
        evidenceReference: await verifiedEvidenceRef('ev://revised-quo/membrane-reuse-orig'),
        idempotencyKey: 'idem-add-rev-quo-reuse-orig',
        expectedVersion: 3,
      },
    );
    assert.equal(reuseOrigQv.status, 409);
    assert.equal(
      reuseOrigQv.body.error.code,
      'HANDYMAN_VARIATION_ILLEGAL_TRANSITION',
    );

    // CHECK 1 Guard C: Revised quotation version with no commercial lines or mismatched delta fails closed (409)
    const emptyQv = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 175000,
        currency: 'IDR',
        revisedQuotationVersionId: QVER_EMPTY,
        evidenceReference: await verifiedEvidenceRef('ev://revised-quo/membrane-empty-qv'),
        idempotencyKey: 'idem-add-rev-quo-empty-qv',
        expectedVersion: 3,
      },
    );
    assert.equal(emptyQv.status, 409);

    const wrongDeltaQv = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 175000,
        currency: 'IDR',
        revisedQuotationVersionId: QVER_WRONG_DELTA,
        evidenceReference: await verifiedEvidenceRef('ev://revised-quo/membrane-wrong-delta'),
        idempotencyKey: 'idem-add-rev-quo-wrong-delta',
        expectedVersion: 3,
      },
    );
    assert.equal(wrongDeltaQv.status, 409);

    // Stage 4: Operations/Manager prepares revised quotation with distinct reconciled QVER_A2_ADD (REVISED_QUOTATION)
    const s4 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`,
      OPS_MANAGER_USER_A,
      {
        quotedUnitAmount: 175000,
        currency: 'IDR',
        revisedQuotationVersionId: QVER_A2_ADD,
        evidenceReference: await verifiedEvidenceRef('ev://revised-quo/membrane-004'),
        notes: 'Revised quotation prepared for tenant approval',
        idempotencyKey: 'idem-add-rev-quo-1',
        expectedVersion: 3,
      },
    );
    assert.equal(s4.status, 200, JSON.stringify(s4.body));
    assert.equal(s4.body.data.variation.status, 'REVISED_QUOTATION');
    assert.equal(s4.body.data.variation.quotedUnitAmount, '175000.00');
    assert.equal(s4.body.data.variation.quotedTotalDelta, '350000.00');
    assert.equal(s4.body.data.variation.revisedQuotationVersionId, QVER_A2_ADD);
    assert.equal(s4.body.data.variation.version, 4);
    const changedReplay = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`, OPS_MANAGER_USER_A,
      { quotedUnitAmount: 1, currency: 'IDR', revisedQuotationVersionId: QVER_A2_ADD,
        idempotencyKey: 'idem-add-rev-quo-1', expectedVersion: 3 },
    );
    assert.equal(changedReplay.status, 409);
    assert.equal(changedReplay.body.error.code, 'HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT');

    // Guard: Operations/Manager CANNOT impersonate Tenant consent!
    const opsImpersonate = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`,
      OPS_MANAGER_USER_A,
      {
        decision: 'APPROVE',
        evidenceReference: await verifiedEvidenceRef('ev://fake-tenant-consent'),
        idempotencyKey: 'idem-ops-impersonate',
      },
    );
    assert.equal(opsImpersonate.status, 403);
    assert.equal(
      opsImpersonate.body.error.code,
      'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN',
    );

    // Guard: PIC Pekerjaan CANNOT record Tenant decision!
    const leadImpersonate = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`,
      LEAD_USER_A,
      {
        decision: 'APPROVE',
        evidenceReference: await verifiedEvidenceRef('ev://fake-lead-consent'),
        idempotencyKey: 'idem-lead-impersonate',
      },
    );
    assert.equal(leadImpersonate.status, 403);

    // Guard: Tenant decision with mismatched or original revisedQuotationVersionId is rejected!
    const mismatchedQvDecision = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`,
      TENANT_USER_A,
      {
        decision: 'APPROVE',
        revisedQuotationVersionId: QVER_A1,
        evidenceReference: await verifiedEvidenceRef('ev://mismatched-qv'),
        idempotencyKey: 'idem-mismatched-qv',
        expectedVersion: 4,
      },
    );
    assert.equal(mismatchedQvDecision.status, 409);
    assert.equal(
      mismatchedQvDecision.body.error.code,
      'HANDYMAN_VARIATION_ILLEGAL_TRANSITION',
    );

    const decisionPath = `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/tenant-decision`;
    const decisionEvidence = await verifiedEvidenceRef('ev://tenant-pinning-guards');
    const decisionBody = { decision: 'APPROVE', revisedQuotationVersionId: QVER_A2_ADD,
      evidenceReference: decisionEvidence, expectedVersion: 4, idempotencyKey: 'idem-decision-guard' };
    assert.equal((await apiPost(decisionPath, CARE_USER_A, decisionBody)).status, 403);
    assert.equal((await apiPost(decisionPath, TENANT_USER_A, { ...decisionBody, revisedQuotationVersionId: undefined })).status, 400);
    assert.equal((await apiPost(decisionPath, TENANT_USER_A, { ...decisionBody, expectedVersion: undefined })).status, 400);
    const staleDecision = await apiPost(decisionPath, TENANT_USER_A, { ...decisionBody, expectedVersion: 3 });
    assert.equal(staleDecision.status, 409);
    assert.equal(staleDecision.body.error.code, 'HANDYMAN_VARIATION_VERSION_CONFLICT');
    await getPool().query(`UPDATE handyman_quotation_versions SET valid_until = now() - interval '1 second' WHERE id = $1`, [QVER_A2_ADD]);
    assert.equal((await apiPost(decisionPath, TENANT_USER_A, decisionBody)).status, 409);
    await getPool().query(`UPDATE handyman_quotation_versions SET valid_until = now() + interval '3 days', status = 'SUPERSEDED' WHERE id = $1`, [QVER_A2_ADD]);
    assert.equal((await apiPost(decisionPath, TENANT_USER_A, decisionBody)).status, 409);
    await getPool().query(`UPDATE handyman_quotation_versions SET status = 'ISSUED' WHERE id = $1`, [QVER_A2_ADD]);

    const bmBeforeAdd = await readBmWorkBinding(getPool(), SCOPE_A1);
    // Stage 5: Authorized Tenant PIC user approves variation bound to QVER_A2_ADD (TENANT_DECISION)
    const approvalBody = {
      decision: 'APPROVE', revisedQuotationVersionId: QVER_A2_ADD,
      evidenceReference: await verifiedEvidenceRef('ev://tenant-consent/membrane-005'),
      notes: 'Approved by Tenant PIC Siti', idempotencyKey: 'idem-add-tenant-approve-1', expectedVersion: 4,
    };
    const s5 = await apiPost(decisionPath, TENANT_USER_A, approvalBody);
    assert.equal(s5.status, 200, JSON.stringify(s5.body));
    assert.equal(s5.body.data.variation.status, 'TENANT_DECISION');
    assert.equal(s5.body.data.variation.tenantDecisionOutcome, 'APPROVED');
    assert.equal(s5.body.data.variation.tenantDecidedByUserId, TENANT_USER_A);
    const consent = s5.body.data.events.find((event: { eventType: string }) => event.eventType === 'TENANT_DECISION');
    assert.equal(consent.metadata.consentSnapshot.version, 4);
    assert.equal(consent.metadata.consentSnapshot.revisedQuotationVersionId, QVER_A2_ADD);
    assert.equal(consent.metadata.consentSnapshot.quantity, '2.000');
    assert.equal(consent.metadata.consentSnapshot.quotedUnitAmount, '175000.00');
    assert.equal((await apiPost(decisionPath, TENANT_USER_A, approvalBody)).body.data.replayed, true);
    const wrongReplay = await apiPost(decisionPath, TENANT_USER_A, { ...approvalBody, revisedQuotationVersionId: QVER_A3_REDUCE });
    assert.equal(wrongReplay.status, 409);
    assert.equal(wrongReplay.body.error.code, 'HANDYMAN_VARIATION_IDEMPOTENCY_CONFLICT');
    const bmApprovedAdd = await readBmWorkBinding(getPool(), SCOPE_A1);
    await assertBmWorkReassessment(t, bmBeforeAdd, bmApprovedAdd);
    const addCoverage = bmApprovedAdd.approvedVariations.find(v => v.id === varId)!;
    assert.equal(addCoverage.variationType, 'ADD');
    assert.equal(addCoverage.revisedQuotationVersionId, QVER_A2_ADD);
    assert.equal(addCoverage.authorized, false);

    const authPath = `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/authorize-scope`;
    const authGuard = { idempotencyKey: 'idem-auth-guard', expectedVersion: 5 };
    assert.equal((await apiPost(authPath, CARE_USER_A, authGuard)).status, 403);
    await getPool().query(`UPDATE handyman_scope_variations SET title = 'Changed after consent' WHERE id = $1`, [varId]);
    assert.equal((await apiPost(authPath, OPS_MANAGER_USER_A, authGuard)).status, 409);
    await getPool().query(`UPDATE handyman_scope_variations SET title = 'Additional waterproofing membrane' WHERE id = $1`, [varId]);
    await getPool().query(`UPDATE handyman_quotation_versions SET status = 'SUPERSEDED' WHERE id = $1`, [QVER_A2_ADD]);
    assert.equal((await apiPost(authPath, OPS_MANAGER_USER_A, authGuard)).status, 409);
    // A timely PIC approval does not disappear merely because the offer later expires.
    await getPool().query(`UPDATE handyman_quotation_versions SET status = 'ISSUED', valid_until = now() - interval '1 second' WHERE id = $1`, [QVER_A2_ADD]);

    // Stage 6: Operations/Manager authorizes scope (AUTHORIZED_SCOPE)
    const s6 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/authorize-scope`,
      OPS_MANAGER_USER_A,
      {
        evidenceReference: await verifiedEvidenceRef('ev://auth-scope/membrane-006'),
        notes: 'Scope authorized after tenant approval',
        idempotencyKey: 'idem-add-auth-scope-1',
        expectedVersion: 5,
      },
    );
    assert.equal(s6.status, 200, JSON.stringify(s6.body));
    assert.equal(s6.body.data.variation.status, 'AUTHORIZED_SCOPE');
    const bmAuthorizedAdd = await readBmWorkBinding(getPool(), SCOPE_A1);
    await assertBmWorkReassessment(t, bmApprovedAdd, bmAuthorizedAdd);
    assert.equal(bmAuthorizedAdd.approvedVariations.find(v => v.id === varId)!.authorized, true);
    assert.equal(
      s6.body.data.reconciledAuthorizedScope.authorizedAddedItems.length,
      1,
    );
    assert.equal(
      s6.body.data.reconciledAuthorizedScope.authorizedAddedItems[0]
        .variationId,
      varId,
    );

    const executionPath = `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/execution`;
    const executionGuard = { evidenceReference: await verifiedEvidenceRef('ev://execution-guard'),
      idempotencyKey: 'idem-execution-guard', expectedVersion: 6 };
    await getPool().query(`UPDATE handyman_quotation_versions SET status = 'REJECTED' WHERE id = $1`, [QVER_A2_ADD]);
    assert.equal((await apiPost(executionPath, LEAD_USER_A, executionGuard)).status, 409);
    await getPool().query(`UPDATE handyman_quotation_versions SET status = 'ISSUED' WHERE id = $1`, [QVER_A2_ADD]);
    await getPool().query(`UPDATE handyman_scope_variations SET quantity = 3 WHERE id = $1`, [varId]);
    assert.equal((await apiPost(executionPath, LEAD_USER_A, executionGuard)).status, 409);
    await getPool().query(`UPDATE handyman_scope_variations SET quantity = 2 WHERE id = $1`, [varId]);

    // Stage 7: Assigned PIC Pekerjaan records execution (EXECUTION)
    const s7 = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${varId}/execution`,
      LEAD_USER_A,
      {
        evidenceReference: await verifiedEvidenceRef('ev://execution/membrane-007'),
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
        qcRunId: QCRUN_PASSED_A1,
        evidenceReference: await verifiedEvidenceRef('ev://self-qc'),
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
        qcRunId: QCRUN_PASSED_A1,
        evidenceReference: await verifiedEvidenceRef('ev://inspector-bypass-qc'),
        idempotencyKey: 'idem-inspector-bypass-qc',
      },
    );
    assert.equal(inspectorBypassQc.status, 403);
    assert.equal(
      inspectorBypassQc.body.error.code,
      'HANDYMAN_VARIATION_ROLE_FORBIDDEN',
    );

    // CHECK 2 Guard A: Variation QC cannot substitute for an authoritative QC artifact without qcRunId (400)
    const qcWithoutRun = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/qc`,
      OPS_MANAGER_USER_A,
      {
        qcOutcome: 'PASSED',
        evidenceReference: await verifiedEvidenceRef('ev://qc/no-run'),
        idempotencyKey: 'idem-qc-no-run',
        expectedVersion: 7,
      },
    );
    assert.equal(qcWithoutRun.status, 400);

    // CHECK 2 Guard B: Variation QC PASSED with an OPEN (unfinished) QC run fails closed (409)
    const qcWithOpenRun = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/qc`,
      OPS_MANAGER_USER_A,
      {
        qcOutcome: 'PASSED',
        qcRunId: QCRUN_OPEN_A1,
        evidenceReference: await verifiedEvidenceRef('ev://qc/open-run'),
        idempotencyKey: 'idem-qc-open-run',
        expectedVersion: 7,
      },
    );
    assert.equal(qcWithOpenRun.status, 409, JSON.stringify(qcWithOpenRun.body));

    // CHECK 2 Guard C: Variation QC PASSED while an unverified defect exists on the scope fails closed (409)
    const qcWithOpenDefect = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/qc`,
      OPS_MANAGER_USER_A,
      {
        qcOutcome: 'PASSED',
        qcRunId: QCRUN_PASSED_A1,
        evidenceReference: await verifiedEvidenceRef('ev://qc/open-defect'),
        idempotencyKey: 'idem-qc-open-defect',
        expectedVersion: 7,
      },
    );
    assert.equal(qcWithOpenDefect.status, 409);

    // Close the defect to VERIFIED and close QCRUN_OPEN_A1 to PASSED
    await getPool().query(
      `UPDATE handyman_defect_records SET status = 'VERIFIED' WHERE id = $1`,
      [DEFECT_A1],
    );
    await getPool().query(
      `UPDATE handyman_qc_runs SET status = 'PASSED' WHERE id = $1`,
      [QCRUN_OPEN_A1],
    );
    // Current QC PASS authority requires completed/check-out Work Sessions.
    await getPool().query(
      `UPDATE handyman_work_sessions
          SET status = 'CHECKED_OUT', completed_at = now()
        WHERE id = $1`,
      [WSESS_A1],
    );

    // Stage 8: Authorized Supervisor / Operations Manager verifies QC linked to QCRUN_PASSED_A1 (QC PASSED)
    const s8 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/qc`,
      OPS_MANAGER_USER_A,
      {
        qcOutcome: 'PASSED',
        qcRunId: QCRUN_PASSED_A1,
        evidenceReference: await verifiedEvidenceRef('ev://qc/membrane-008'),
        notes: 'Moisture test passed after membrane installation',
        idempotencyKey: 'idem-add-qc-1',
        expectedVersion: 7,
      },
    );
    assert.equal(s8.status, 200, JSON.stringify(s8.body));
    assert.equal(s8.body.data.variation.status, 'QC');
    assert.equal(s8.body.data.variation.qcOutcome, 'PASSED');
    assert.equal(s8.body.data.variation.qcRunId, QCRUN_PASSED_A1);

    // CHECK 2 Guard D: FINAL_CHARGE_ELIGIBILITY blocked while an active work session is still IN_PROGRESS (409)
    await getPool().query(
      `UPDATE handyman_work_sessions
          SET status = 'IN_PROGRESS', completed_at = NULL
        WHERE id = $1`,
      [WSESS_A1],
    );
    const fceOpenSession = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/final-charge-eligibility`,
      OPS_MANAGER_USER_A,
      {
        evidenceReference: await verifiedEvidenceRef('ev://final-charge/open-session'),
        idempotencyKey: 'idem-fce-open-session',
        expectedVersion: 8,
      },
    );
    assert.equal(fceOpenSession.status, 409);

    // Complete/check out the work session
    await getPool().query(
      `UPDATE handyman_work_sessions
          SET status = 'CHECKED_OUT', completed_at = now()
        WHERE id = $1`,
      [WSESS_A1],
    );

    // CHECK 2 Guard E: FINAL_CHARGE_ELIGIBILITY blocked before BAST is ACCEPTED with customer sign-off (409)
    const fceUnacceptedBast = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/final-charge-eligibility`,
      OPS_MANAGER_USER_A,
      {
        bastId: BAST_A1,
        evidenceReference: await verifiedEvidenceRef('ev://final-charge/unaccepted-bast'),
        idempotencyKey: 'idem-fce-unaccepted-bast',
        expectedVersion: 8,
      },
    );
    assert.equal(fceUnacceptedBast.status, 409);

    // BAST-consumer PRESTATE for this narrow variation/schema/auth-mocked
    // suite, not an execution of personal consent. PART04's full-migration
    // HTTP suite separately proves that only the real personal PIC can create
    // this backend attestation. Do not substitute an arbitrary digest for it.
    await withTransaction(async (tx) => {
      const head = (await tx.query(`UPDATE handyman_bast_documents
        SET status = 'ACCEPTED', accepted_at = NOW(), qc_run_id = $2 WHERE id = $1 RETURNING *`,
      [BAST_A1, QCRUN_PASSED_A1])).rows[0];
      const issueId = randomUUID();
      const eventId = randomUUID();
      const manifest: HandymanBastCustomerConsentManifest = {
        protocol: HANDYMAN_BAST_CUSTOMER_CONSENT_PROTOCOL, bastId: BAST_A1,
        executionScopeId: SCOPE_A1, approvedQuotationVersionId: QVER_A1, clientId: CLIENT_A,
        handymanRequestId: REQ_A1, tenantCompanyId: TENANT_A, tenantPicId: TENANT_PIC_A,
        buildingId: BUILDING_A1, issuedArtifactRef: `BAST/${BAST_A1}/v2`, issuedArtifactVersion: 2,
        issueEventId: issueId, issuedAt: head.issued_at.toISOString(), qcRunId: QCRUN_PASSED_A1,
        actorUserId: TENANT_USER_A, decision: 'ACCEPT', rejectReason: null, evidence: null,
      };
      const digest = computeHandymanBastCustomerConsentDigest(manifest);
      await tx.query(`INSERT INTO handyman_bast_events
        (id, client_id, bast_id, execution_scope_id, event_type, idempotency_key, actor_user_id, occurred_at)
        VALUES ($1,$2,$3,$4,'ISSUE','prestate-issue',$5,$6)`,
      [issueId, CLIENT_A, BAST_A1, SCOPE_A1, LEAD_USER_A, head.issued_at]);
      await tx.query(`INSERT INTO handyman_bast_events
        (id, client_id, bast_id, execution_scope_id, event_type, idempotency_key, actor_user_id, metadata)
        VALUES ($1,$2,$3,$4,'ACCEPT','prestate-consent',$5,$6::jsonb)`,
      [eventId, CLIENT_A, BAST_A1, SCOPE_A1, TENANT_USER_A, JSON.stringify({ customerConsent: {
        method: HANDYMAN_BAST_CUSTOMER_CONSENT_METHOD, manifest, sha256Digest: digest,
      } })]);
      await tx.query(`INSERT INTO handyman_bast_sign_offs
        (id, client_id, bast_id, event_id, execution_scope_id, decision, signature_digest)
        VALUES ($1,$2,$3,$4,$5,'ACCEPT',$6)`, [randomUUID(), CLIENT_A, BAST_A1, eventId, SCOPE_A1, digest]);
    });

    // CHECK 2 Guard F: FINAL_CHARGE_ELIGIBILITY blocked when a FINALIZED invoice already exists for the scope (duplicate invoice protection, 409)
    const fceFinalizedInvoice = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/final-charge-eligibility`,
      OPS_MANAGER_USER_A,
      {
        bastId: BAST_A1,
        evidenceReference: await verifiedEvidenceRef('ev://final-charge/finalized-inv'),
        idempotencyKey: 'idem-fce-finalized-inv',
        expectedVersion: 8,
      },
    );
    assert.equal(fceFinalizedInvoice.status, 409);

    // Set invoice back to DRAFT so pre-finalization charge admission is legal
    await getPool().query(
      `UPDATE tenant_invoices SET status = 'DRAFT' WHERE id = $1`,
      [INVOICE_A1],
    );

    // Stage 9: Operations/Manager confirms FINAL_CHARGE_ELIGIBILITY (without auto-invoicing)
    const s9 = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/final-charge-eligibility`,
      OPS_MANAGER_USER_A,
      {
        qcRunId: QCRUN_PASSED_A1,
        bastId: BAST_A1,
        evidenceReference: await verifiedEvidenceRef('ev://final-charge/membrane-009'),
        notes: 'Eligible for downstream final charge settlement',
        idempotencyKey: 'idem-add-final-charge-1',
        expectedVersion: 8,
      },
    );
    assert.equal(s9.status, 200, JSON.stringify(s9.body));
    assert.equal(s9.body.data.variation.status, 'FINAL_CHARGE_ELIGIBILITY');
    assert.equal(s9.body.data.variation.finalChargeEligible, true);
    assert.equal(s9.body.data.variation.invoiced, false);
    assert.equal(s9.body.data.variation.qcRunId, QCRUN_PASSED_A1);
    assert.equal(s9.body.data.variation.bastId, BAST_A1);
    assert.equal(s9.body.data.events.length, 9);
    assert.deepEqual(await readBmWorkBinding(getPool(), SCOPE_A1), bmAuthorizedAdd,
      'Execution/QC/BAST/finance progress must not invent a changed work scope');

    // Verify original approved scope row & quotation lines are 100% untouched
    const origScopeRes = await getPool().query(
      'SELECT approved_total_amount::text FROM handyman_execution_scopes WHERE id = $1',
      [SCOPE_A1],
    );
    assert.equal(origScopeRes.rows[0].approved_total_amount, '832500.00');
  });

  it('2: governs REDUCE (Pekerjaan Kurang) lifecycle, reconciles remaining authorized quantity, and blocks over-reduction', async (t) => {
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
        evidenceReference: await verifiedEvidenceRef('ev://reduce/pipe-001'),
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
        revisedQuotationVersionId: QVER_A3_REDUCE,
        idempotencyKey: 'idem-red-quo-1',
      },
    );
    assert.equal(quo.status, 200);
    assert.equal(quo.body.data.variation.quotedTotalDelta, '-100000.00');
    assert.equal(quo.body.data.variation.revisedQuotationVersionId, QVER_A3_REDUCE);
    // Existing commercial reconciliation consumes the signed REDUCE delta;
    // original and revised quotation versions remain separate authority rows.
    const commercialEvent = quo.body.data.events.find((e: { eventType: string }) => e.eventType === 'REVISED_QUOTATION');
    assert.equal(commercialEvent.metadata.quotedTotalDelta, '-100000.00');
    const totals = await getPool().query(`SELECT quotation_version_id, SUM(line_total)::numeric(18,2)::text total
      FROM handyman_quotation_lines WHERE quotation_version_id=ANY($1::uuid[]) GROUP BY quotation_version_id`,
      [[QVER_A1, QVER_A3_REDUCE]]);
    assert.equal(commercialEvent.metadata.originalQuotedTotal, totals.rows.find(r=>r.quotation_version_id===QVER_A1).total);
    assert.equal(commercialEvent.metadata.revisedQuotedTotal, totals.rows.find(r=>r.quotation_version_id===QVER_A3_REDUCE).total);


    const bmBeforeReduce = await readBmWorkBinding(getPool(), SCOPE_A1);
    const ten = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${reduceVarId}/tenant-decision`,
      TENANT_USER_A,
      {
        decision: 'APPROVE',
        revisedQuotationVersionId: QVER_A3_REDUCE,
        evidenceReference: await verifiedEvidenceRef('ev://tenant-approve-reduce'),
        idempotencyKey: 'idem-red-ten-1',
        expectedVersion: 3,
      },
    );
    assert.equal(ten.status, 200);
    const bmApprovedReduce = await readBmWorkBinding(getPool(), SCOPE_A1);
    await assertBmWorkReassessment(t, bmBeforeReduce, bmApprovedReduce);
    const reduceCoverage = bmApprovedReduce.approvedVariations.find(v => v.id === reduceVarId)!;
    assert.equal(reduceCoverage.variationType, 'REDUCE');
    assert.equal(reduceCoverage.targetQuotationLineId, QLINE_MAT_A1);
    assert.equal(reduceCoverage.revisedQuotationVersionId, QVER_A3_REDUCE);

    const auth = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${reduceVarId}/authorize-scope`,
      OPS_MANAGER_USER_A,
      { idempotencyKey: 'idem-red-auth-1' },
    );
    assert.equal(auth.status, 200);
    await assertBmWorkReassessment(t, bmApprovedReduce, await readBmWorkBinding(getPool(), SCOPE_A1));
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
        evidenceReference: await verifiedEvidenceRef('ev://reduce/over-001'),
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
        evidenceReference: await verifiedEvidenceRef('ev://prop/repaint-001'),
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
        evidenceReference: await verifiedEvidenceRef('ev://prop/repaint-001'),
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
        evidenceReference: await verifiedEvidenceRef('ev://prop/repaint-001'),
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
        revisedQuotationVersionId: QVER_A4_REJECT,
        idempotencyKey: 'idem-rej-quo-1',
      },
    );
    const rejDec = await apiPost(
      `/handyman/execution-scopes/${SCOPE_A1}/variations/${rejVarId}/tenant-decision`,
      TENANT_USER_A,
      {
        decision: 'REJECT',
        revisedQuotationVersionId: QVER_A4_REJECT,
        evidenceReference: await verifiedEvidenceRef('ev://tenant-reject/repaint'),
        notes: 'Declined optional repaint',
        idempotencyKey: 'idem-rej-dec-1',
        expectedVersion: 3,
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
    const rejectedExecution = await apiPost(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations/${rejVarId}/execution`, LEAD_USER_A,
      { evidenceReference: await verifiedEvidenceRef('ev://reject-execution'), idempotencyKey: 'idem-reject-execution' },
    );
    assert.equal(rejectedExecution.status, 409);

    // Helper user is denied from field variation reads and proposals
    const helperRead = await apiGet(
      `/handyman/field/execution-scopes/${SCOPE_A1}/variations`,
      HELPER_USER_A,
    );
    assert.equal(helperRead.status, 403);
  });

  it('4: never shares a revised quote between variations, even after rejection or under concurrent preparation', async () => {
    // This suite has a deliberately narrow schema and mocked RBAC/issuance;
    // it exercises variation commands, not the physical Work Session link.
    const version = randomUUID();
    await getPool().query(`INSERT INTO handyman_quotation_versions
      (id, client_id, quotation_id, version_number, status, currency, subtotal_labor,
       subtotal_material, discount_amount, tax_amount, total_amount, valid_until, notes,
       prepared_by_user_id, issued_by_user_id, issued_at)
      SELECT $1, client_id, quotation_id, 7, 'ISSUED', currency, subtotal_labor,
       subtotal_material, discount_amount, tax_amount, total_amount, now() + interval '3 days', notes,
       prepared_by_user_id, issued_by_user_id, now()
      FROM handyman_quotation_versions WHERE id = $2`, [version, QVER_A2_ADD]);
    await getPool().query(`INSERT INTO handyman_quotation_lines
      (id, client_id, quotation_version_id, line_number, line_type, source_item_id, description,
       quantity, uom_id, cost_basis_unit_amount, margin_percent, reference_unit_amount,
       final_quoted_unit_amount, line_total, currency)
      SELECT gen_random_uuid(), client_id, $1, line_number, line_type, source_item_id, description,
       quantity, uom_id, cost_basis_unit_amount, margin_percent, reference_unit_amount,
       final_quoted_unit_amount, line_total, currency
      FROM handyman_quotation_lines WHERE quotation_version_id = $2`, [version, QVER_A2_ADD]);

    const proposalPath = `/handyman/field/execution-scopes/${SCOPE_A1}/variations/proposals`;
    const proposalIds: string[] = [];
    for (const i of [1, 2]) {
      const proposal = await apiPost(proposalPath, LEAD_USER_A, {
        variationType: 'ADD', lineType: 'LABOR', title: 'Additional waterproofing membrane',
        description: 'Apply membrane behind pantry wall panel', technicalFinding: 'Moisture behind wall',
        quantity: 2, uomId: UOM_UNIT, evidenceReference: await verifiedEvidenceRef(`ev://concurrent-${i}`),
        idempotencyKey: `idem-concurrent-proposal-${i}`,
      });
      assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
      const varId = proposal.body.data.variation.id as string;
      proposalIds.push(varId);
      const review = await apiPost(`/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/operations-review`,
        OPS_MANAGER_USER_A, { idempotencyKey: `idem-concurrent-review-${i}`, expectedVersion: 1 });
      assert.equal(review.status, 200, JSON.stringify(review.body));
    }

    const path = (varId: string) => `/handyman/execution-scopes/${SCOPE_A1}/variations/${varId}/revised-quotation`;
    const rejectedReuse = await apiPost(path(proposalIds[0]), OPS_MANAGER_USER_A, {
      quotedUnitAmount: 150000, currency: 'IDR', revisedQuotationVersionId: QVER_A4_REJECT,
      idempotencyKey: 'idem-reuse-rejected-quote', expectedVersion: 2,
    });
    assert.equal(rejectedReuse.status, 409);
    assert.match(rejectedReuse.body.error.message, /already bound/);

    const results = await Promise.all(proposalIds.map((varId, i) => apiPost(path(varId), OPS_MANAGER_USER_A, {
      quotedUnitAmount: 175000, currency: 'IDR', revisedQuotationVersionId: i ? version.toUpperCase() : version,
      idempotencyKey: `idem-concurrent-quote-${i}`, expectedVersion: 2,
    })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const bound = await getPool().query(
      'SELECT id FROM handyman_scope_variations WHERE revised_quotation_version_id = $1', [version],
    );
    assert.equal(bound.rows.length, 1);
    const original = await getPool().query(`SELECT approved_quotation_version_id, approved_total_amount::text
      FROM handyman_execution_scopes WHERE id = $1`, [SCOPE_A1]);
    assert.equal(original.rows[0].approved_quotation_version_id, QVER_A1);
    assert.equal(original.rows[0].approved_total_amount, '832500.00');
  });
});
