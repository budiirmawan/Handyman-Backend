import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase } from '../src/database';
import { createHandymanFieldFeedRouter } from '../src/modules/handyman-field-feed/handyman-field-feed.routes';
import { sessionService } from '../src/modules/auth/session.service';
import { userRepository } from '../src/modules/users/user.repository';
import { buildingRepository } from '../src/modules/buildings/building.repository';
import { propertyRepository } from '../src/modules/properties/property.repository';
import { clientRepository } from '../src/modules/clients/client.repository';
import { errorHandler } from '../src/middleware/error-handler';
import { requestIdMiddleware } from '../src/middleware/request-id';

let pg: EmbeddedPostgres;
let pgDir: string;
let pool: Pool;
const origResolveSession = sessionService.resolveSessionContext;
const origFindUser = userRepository.findById;
const origFindBuilding = buildingRepository.findById;
const origFindProperty = propertyRepository.findById;
const origFindClient = clientRepository.findById;

const C1 = '10000000-0000-4000-8000-000000000001';
const C2 = '20000000-0000-4000-8000-000000000002';
const P1 = '10000000-0000-4000-8000-000000000011';
const P2 = '20000000-0000-4000-8000-000000000012';
const B1 = '10000000-0000-4000-8000-000000000021';
const B2 = '20000000-0000-4000-8000-000000000022';
const TC1 = '10000000-0000-4000-8000-000000000031';
const TC2 = '20000000-0000-4000-8000-000000000032';
const SC1 = '10000000-0000-4000-8000-000000000041';
const UOM1 = '10000000-0000-4000-8000-000000000051';
const DISC1 = '10000000-0000-4000-8000-000000000061';

const LEAD_1 = '10000000-0000-4000-8000-000000000101';
const LEAD_OLD = '10000000-0000-4000-8000-000000000102';
const HELPER_1 = '10000000-0000-4000-8000-000000000103';
const LEAD_OTHER_WO = '10000000-0000-4000-8000-000000000104';
const INSP_1 = '10000000-0000-4000-8000-000000000105';
const INSP_PROPOSED = '10000000-0000-4000-8000-000000000106';
const UNASSIGNED_B1 = '10000000-0000-4000-8000-000000000107';
const FOREIGN_USER = '20000000-0000-4000-8000-000000000201';

const REQ_1 = '10000000-0000-4000-8000-000000000301';
const REQ_2 = '10000000-0000-4000-8000-000000000302';
const REQ_FOREIGN = '20000000-0000-4000-8000-000000000303';

const QUOT_1 = '10000000-0000-4000-8000-000000000401';
const QVER_1 = '10000000-0000-4000-8000-000000000411';
const QDEC_1 = '10000000-0000-4000-8000-000000000421';
const QLINE_LABOR = '10000000-0000-4000-8000-000000000431';
const QLINE_MAT = '10000000-0000-4000-8000-000000000432';

const SCOPE_1 = '10000000-0000-4000-8000-000000000501';
const SCOPE_2 = '10000000-0000-4000-8000-000000000502';
const SCOPE_FOREIGN = '20000000-0000-4000-8000-000000000503';

const MAT_LINE_1 = '10000000-0000-4000-8000-000000000601';
const VISIT_EXEC_1 = '10000000-0000-4000-8000-000000000701';
const VISIT_INSP_1 = '10000000-0000-4000-8000-000000000702';

const sessions = new Map<string, string>();
const app = express();
app.use(requestIdMiddleware, express.json());
app.use('/api/v1', createHandymanFieldFeedRouter());
app.use(errorHandler);

before(async () => {
  pgDir = mkdtempSync(join(tmpdir(), 'hm-field-read-auth-'));
  pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    port: 55444,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  pool = await initDatabase({
    host: '127.0.0.1',
    port: 55444,
    name: 'postgres',
    user: 'postgres',
    password: 'password',
    ssl: false,
    maxConnections: 4,
    idleTimeoutMs: 5000,
    connectionTimeoutMs: 5000,
  });

  await pool.query(`
    CREATE TABLE clients(id uuid PRIMARY KEY, code text, name text, status text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE properties(id uuid PRIMARY KEY, client_id uuid, code text, name text, status text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE buildings(
      id uuid PRIMARY KEY, property_id uuid, code text, name text, status text,
      address text, city text, country text, total_floors int,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE users(id uuid PRIMARY KEY, status text);
    CREATE TABLE user_building_assignments(
      id uuid PRIMARY KEY, user_id uuid, building_id uuid, status text,
      assigned_by_user_id uuid, assigned_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE organizations(id uuid PRIMARY KEY, client_id uuid, status text);
    CREATE TABLE vendors(id uuid PRIMARY KEY, client_id uuid, status text);
    CREATE TABLE handyman_provider_contexts(
      id uuid PRIMARY KEY, client_id uuid, vendor_id uuid, status text,
      created_by_user_id uuid, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      provider_type text DEFAULT 'VENDOR'
    );
    CREATE TABLE workforce_profiles(
      id uuid PRIMARY KEY, organization_id uuid, department_id uuid,
      team_id uuid, position_id uuid, user_id uuid,
      employee_code text DEFAULT 'EMP', full_name text DEFAULT 'Worker',
      workforce_type text, status text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE vendor_workforce_bindings(
      id uuid PRIMARY KEY, vendor_id uuid, workforce_profile_id uuid, status text,
      effective_from timestamptz, effective_until timestamptz
    );
    CREATE TABLE workforce_building_assignments(
      id uuid PRIMARY KEY, workforce_profile_id uuid, building_id uuid, status text,
      effective_from timestamptz, effective_until timestamptz
    );
    CREATE TABLE handyman_worker_contexts(
      id uuid PRIMARY KEY, client_id uuid, handyman_provider_context_id uuid,
      workforce_profile_id uuid, status text, created_by_user_id uuid,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_work_crews(
      id uuid PRIMARY KEY, client_id uuid, handyman_provider_context_id uuid,
      code text, name text, status text, created_by_user_id uuid,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_crew_memberships(
      id uuid PRIMARY KEY, client_id uuid, handyman_crew_id uuid,
      handyman_worker_context_id uuid, status text, created_by_user_id uuid,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_crew_leads(
      id uuid PRIMARY KEY, client_id uuid, handyman_crew_id uuid,
      handyman_crew_membership_id uuid, lead_seq int, designated_by_user_id uuid,
      designated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_scheduling_readiness(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid, timezone text,
      preferred_window_start timestamptz, preferred_window_end timestamptz, status text,
      supersedes_readiness_id uuid, change_reason text, created_by_user_id uuid,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_service_requests(
      id uuid PRIMARY KEY, client_id uuid, tenant_company_id uuid,
      building_id uuid, space_id uuid, service_catalog_id uuid,
      service_variant_id uuid, description text, status text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      channel_attribution_id uuid, tenant_pic_id uuid, origin_channel text,
      origin_reference text, created_by_user_id uuid
    );
    CREATE TABLE handyman_request_triage_decisions(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      building_id uuid, triage_disposition text, triage_note text,
      actor_user_id uuid, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_request_inspections(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      building_id uuid, inspection_result text, inspection_notes text,
      inspected_by_user_id uuid, inspected_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_request_diagnoses(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      building_id uuid, handyman_discipline_id uuid, discipline_code text,
      diagnosis text, scope_classification text,
      recommended_service_catalog_id uuid, diagnosed_by_user_id uuid,
      diagnosed_at timestamptz DEFAULT now()
    );
    CREATE TABLE units_of_measure(
      id uuid PRIMARY KEY, client_id uuid, code text, name text, symbol text
    );
    CREATE TABLE handyman_quotations(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      created_by_user_id uuid, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_quotation_versions(
      id uuid PRIMARY KEY, quotation_id uuid, version_number int,
      status text, valid_until timestamptz, created_by_user_id uuid,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_quotation_lines(
      id uuid PRIMARY KEY, quotation_version_id uuid, line_type text,
      description text, quantity numeric, uom_id uuid,
      reference_unit_amount numeric(18,2), final_quoted_unit_amount numeric(18,2),
      line_total numeric(18,2), currency varchar(3), source_item_id uuid,
      created_by_user_id uuid, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_execution_scopes(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      channel_attribution_id uuid, quotation_id uuid,
      approved_quotation_version_id uuid, quotation_decision_id uuid,
      tenant_company_id uuid, tenant_pic_id uuid, building_id uuid,
      floor_id uuid, area_id uuid, room_id uuid, space_id uuid,
      status text, created_by_user_id uuid,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_execution_scope_assignments(
      id uuid PRIMARY KEY, client_id uuid, execution_scope_id uuid,
      handyman_provider_context_id uuid, handyman_crew_id uuid, status text,
      assigned_by_user_id uuid, assigned_at timestamptz DEFAULT now(),
      supersedes_assignment_id uuid, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      -- CR-HM-FIELD-OPS-ACK-01 PART 02 repair: the authorized read path
      -- projects the assignment version (PART 01 contract). Positional
      -- fixtures below stay valid because the column trails with a
      -- DEFAULT.
      version int NOT NULL DEFAULT 1
    );
    CREATE TABLE handyman_assignment_responses(
      id uuid PRIMARY KEY, client_id uuid, building_id uuid,
      assignment_target_type text, assignment_id uuid,
      work_order_id uuid, handyman_request_id uuid,
      execution_scope_id uuid, visit_appointment_id uuid,
      assigned_by_user_id uuid, assigned_at timestamptz DEFAULT now(),
      response_status text, responded_by_user_id uuid,
      responded_by_worker_id uuid, responded_at timestamptz,
      decline_reason text, response_notes text,
      linked_work_order_action_id uuid, idempotency_key text,
      client_idempotency_key text, version int NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_work_sessions(
      id uuid PRIMARY KEY, client_id uuid, assignment_id uuid, status text,
      checked_in_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_dispatch_releases(
      id uuid PRIMARY KEY, client_id uuid, execution_scope_id uuid,
      assignment_id uuid, status text, released_at timestamptz,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_inspector_assignments(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      visit_appointment_id uuid, inspector_user_id uuid, status text,
      assigned_by_user_id uuid, assigned_at timestamptz DEFAULT now(),
      supersedes_assignment_id uuid, reassignment_reason text,
      version int NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_material_execution_lines(
      id uuid PRIMARY KEY, client_id uuid, execution_scope_id uuid,
      quotation_version_id uuid, quotation_line_id uuid, source_item_id uuid,
      status text, acquisition_mode text, estimated_qty numeric(14,3),
      approved_qty numeric(14,3), issued_qty numeric(14,3),
      purchased_qty numeric(14,3), used_qty numeric(14,3),
      returned_qty numeric(14,3), supplier_reference varchar(500),
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE handyman_visit_appointments(
      id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      tenant_company_id uuid, building_id uuid, kind text,
      execution_scope_id uuid, resource_type text, resource_id uuid,
      start_at timestamptz, end_at timestamptz, timezone text, state text,
      version int, created_at timestamptz DEFAULT now()
    );
  `);

  await pool.query(
    `INSERT INTO clients(id,code,name,status) VALUES ($1,'C1','Client 1','ACTIVE'), ($2,'C2','Client 2','ACTIVE')`,
    [C1, C2],
  );
  await pool.query(
    `INSERT INTO properties(id,client_id,code,name,status) VALUES ($1,$2,'P1','Prop 1','ACTIVE'), ($3,$4,'P2','Prop 2','ACTIVE')`,
    [P1, C1, P2, C2],
  );
  await pool.query(
    `INSERT INTO buildings(id,property_id,code,name,status,address,city,country,total_floors) VALUES
      ($1,$2,'B1','Building 1','ACTIVE','Addr 1','Jakarta','ID',10),
      ($3,$4,'B2','Building 2','ACTIVE','Addr 2','Jakarta','ID',10)`,
    [B1, P1, B2, P2],
  );
  await pool.query(
    `INSERT INTO units_of_measure VALUES ($1,$2,'PCS','Pieces','pcs')`,
    [UOM1, C1],
  );

  for (const [uid, bId] of [
    [LEAD_1, B1],
    [LEAD_OLD, B1],
    [HELPER_1, B1],
    [LEAD_OTHER_WO, B1],
    [INSP_1, B1],
    [INSP_PROPOSED, B1],
    [UNASSIGNED_B1, B1],
    [FOREIGN_USER, B2],
  ] as const) {
    await pool.query(`INSERT INTO users VALUES ($1,'ACTIVE')`, [uid]);
    await pool.query(
      `INSERT INTO user_building_assignments(id,user_id,building_id,status) VALUES ($1,$2,$3,'ACTIVE')`,
      [randomUUID(), uid, bId],
    );
    sessions.set(`tok-${uid}`, uid);
  }

  const org1 = randomUUID();
  const v1 = randomUUID();
  const pc1 = randomUUID();
  await pool.query(`INSERT INTO organizations VALUES ($1,$2,'ACTIVE')`, [org1, C1]);
  await pool.query(`INSERT INTO vendors VALUES ($1,$2,'ACTIVE')`, [v1, C1]);
  await pool.query(
    `INSERT INTO handyman_provider_contexts(id,client_id,vendor_id,status,created_by_user_id) VALUES ($1,$2,$3,'ACTIVE',$4)`,
    [pc1, C1, v1, LEAD_1],
  );

  const registerWorker = async (userId: string, buildingId = B1) => {
    const wp = randomUUID();
    const wc = randomUUID();
    await pool.query(
      `INSERT INTO workforce_profiles(id,organization_id,user_id,workforce_type,status) VALUES ($1,$2,$3,'EXTERNAL','ACTIVE')`,
      [wp, org1, userId],
    );
    await pool.query(
      `INSERT INTO vendor_workforce_bindings(id,vendor_id,workforce_profile_id,status) VALUES ($1,$2,$3,'ACTIVE')`,
      [randomUUID(), v1, wp],
    );
    await pool.query(
      `INSERT INTO workforce_building_assignments(id,workforce_profile_id,building_id,status) VALUES ($1,$2,$3,'ACTIVE')`,
      [randomUUID(), wp, buildingId],
    );
    await pool.query(
      `INSERT INTO handyman_worker_contexts(id,client_id,handyman_provider_context_id,workforce_profile_id,status,created_by_user_id) VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
      [wc, C1, pc1, wp, LEAD_1],
    );
    return { wp, wc };
  };

  const wLead1 = await registerWorker(LEAD_1);
  const wLeadOld = await registerWorker(LEAD_OLD);
  const wHelper1 = await registerWorker(HELPER_1);
  const wLeadOther = await registerWorker(LEAD_OTHER_WO);
  await registerWorker(INSP_1);
  await registerWorker(INSP_PROPOSED);

  const crew1 = randomUUID();
  const cmLeadOld = randomUUID();
  const cmLead1 = randomUUID();
  const cmHelper1 = randomUUID();
  await pool.query(
    `INSERT INTO handyman_work_crews VALUES ($1,$2,$3,'CR-01','Alpha Crew','ACTIVE',$4,now(),now())`,
    [crew1, C1, pc1, LEAD_1],
  );
  await pool.query(
    `INSERT INTO handyman_crew_memberships VALUES
      ($1,$2,$3,$4,'ACTIVE',$5,now(),now()),
      ($6,$2,$3,$7,'ACTIVE',$5,now(),now()),
      ($8,$2,$3,$9,'ACTIVE',$5,now(),now())`,
    [cmLeadOld, C1, crew1, wLeadOld.wc, LEAD_1, cmLead1, wLead1.wc, cmHelper1, wHelper1.wc],
  );
  await pool.query(
    `INSERT INTO handyman_crew_leads VALUES
      ($1,$2,$3,$4,1,$5,now()),
      ($6,$2,$3,$7,2,$5,now())`,
    [randomUUID(), C1, crew1, cmLeadOld, LEAD_1, randomUUID(), cmLead1],
  );

  const crew2 = randomUUID();
  const cmOther = randomUUID();
  await pool.query(
    `INSERT INTO handyman_work_crews VALUES ($1,$2,$3,'CR-02','Beta Crew','ACTIVE',$4,now(),now())`,
    [crew2, C1, pc1, LEAD_OTHER_WO],
  );
  await pool.query(
    `INSERT INTO handyman_crew_memberships VALUES ($1,$2,$3,$4,'ACTIVE',$5,now(),now())`,
    [cmOther, C1, crew2, wLeadOther.wc, LEAD_OTHER_WO],
  );
  await pool.query(
    `INSERT INTO handyman_crew_leads VALUES ($1,$2,$3,$4,1,$5,now())`,
    [randomUUID(), C1, crew2, cmOther, LEAD_OTHER_WO],
  );

  await pool.query(
    `INSERT INTO handyman_service_requests VALUES
      ($1,$2,$3,$4,NULL,$5,NULL,'Leaking pipe under sink','READY_FOR_NEXT_STEP',now(),now()),
      ($6,$2,$3,$4,NULL,$5,NULL,'Broken door hinge','READY_FOR_NEXT_STEP',now(),now()),
      ($7,$8,$9,$10,NULL,$5,NULL,'Foreign tenant request','READY_FOR_NEXT_STEP',now(),now())`,
    [REQ_1, C1, TC1, B1, SC1, REQ_2, REQ_FOREIGN, C2, TC2, B2],
  );
  await pool.query(
    `INSERT INTO handyman_request_triage_decisions VALUES
      ($1,$2,$3,$4,'INSPECTION_REQUIRED','Needs plumbing inspection',$5,now())`,
    [randomUUID(), C1, REQ_1, B1, INSP_1],
  );
  await pool.query(
    `INSERT INTO handyman_request_inspections VALUES
      ($1,$2,$3,$4,'INSPECTED','Pipe trap corroded, needs replacement',$5,now())`,
    [randomUUID(), C1, REQ_1, B1, INSP_1],
  );
  await pool.query(
    `INSERT INTO handyman_request_diagnoses VALUES
      ($1,$2,$3,$4,$5,'SIMPLE_PLUMBING','Replace P-trap and seal','GENERAL_HANDYMAN',NULL,$6,now())`,
    [randomUUID(), C1, REQ_1, B1, DISC1, INSP_1],
  );

  await pool.query(
    `INSERT INTO handyman_quotations VALUES ($1,$2,$3,$4,now(),now())`,
    [QUOT_1, C1, REQ_1, LEAD_1],
  );
  await pool.query(
    `INSERT INTO handyman_quotation_versions VALUES ($1,$2,1,'APPROVED',now() + interval '7 days',$3,now(),now())`,
    [QVER_1, QUOT_1, LEAD_1],
  );
  await pool.query(
    `INSERT INTO handyman_quotation_lines VALUES
      ($1,$2,'LABOR','Plumbing replacement labor',2,$3,150000,200000,400000,'IDR',NULL,$4,now(),now()),
      ($5,$2,'MATERIAL','PVC P-Trap and Sealant',3,$3,45000,65000,195000,'IDR',NULL,$4,now(),now())`,
    [QLINE_LABOR, QVER_1, UOM1, LEAD_1, QLINE_MAT],
  );

  await pool.query(
    `INSERT INTO handyman_execution_scopes VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,NULL,NULL,NULL,NULL,'AUTHORIZED',$10,now(),now()),
      ($11,$2,$12,$4,$5,$6,$7,$8,NULL,$9,NULL,NULL,NULL,NULL,'AUTHORIZED',$10,now(),now()),
      ($13,$14,$15,$4,$5,$6,$7,$16,NULL,$17,NULL,NULL,NULL,NULL,'AUTHORIZED',$10,now(),now())`,
    [
      SCOPE_1, C1, REQ_1, randomUUID(), QUOT_1, QVER_1, QDEC_1, TC1, B1, LEAD_1,
      SCOPE_2, REQ_2,
      SCOPE_FOREIGN, C2, REQ_FOREIGN, TC2, B2,
    ],
  );

  await pool.query(
    `INSERT INTO handyman_execution_scope_assignments VALUES
      ($1,$2,$3,$4,$5,'ACTIVE',$6,now(),NULL,now(),now()),
      ($7,$2,$8,$4,$9,'ACTIVE',$6,now(),NULL,now(),now())`,
    [
      randomUUID(), C1, SCOPE_1, pc1, crew1, LEAD_1,
      randomUUID(), SCOPE_2, crew2,
    ],
  );

  await pool.query(
    `INSERT INTO handyman_material_execution_lines VALUES
      ($1,$2,$3,$4,$5,NULL,'USED','ISSUED',3,3,3,0,2,0,'WH-REF-01',now(),now())`,
    [MAT_LINE_1, C1, SCOPE_1, QVER_1, QLINE_MAT],
  );

  await pool.query(
    `INSERT INTO handyman_visit_appointments VALUES
      ($1,$2,$3,$4,$5,'INSPECTION',NULL,'INSPECTOR_USER',$6,'2026-04-20T08:00:00Z','2026-04-20T09:00:00Z','Asia/Jakarta','CONFIRMED',1,now()),
      ($7,$2,$3,$4,$5,'EXECUTION',$8,'CREW',$9,'2026-04-21T09:00:00Z','2026-04-21T11:00:00Z','Asia/Jakarta','CONFIRMED',1,now()),
      ($10,$2,$11,$4,$5,'INSPECTION',NULL,'INSPECTOR_USER',$12,'2026-04-22T08:00:00Z','2026-04-22T09:00:00Z','Asia/Jakarta','PROPOSED',1,now())`,
    [
      VISIT_INSP_1, C1, REQ_1, TC1, B1, INSP_1,
      VISIT_EXEC_1, SCOPE_1, crew1,
      randomUUID(), REQ_2, INSP_PROPOSED,
    ],
  );

  // CR-HM-FIELD-OPS-ACK-01 PART 02 repair: the authorized INSPECTOR lane
  // resolves an ACTIVE inspector assignment row for the visit. Only the
  // CONFIRMED inspection visit carries one — the PROPOSED-visit case in
  // test 3 must keep failing closed.
  await pool.query(
    `INSERT INTO handyman_inspector_assignments
       (id, client_id, handyman_request_id, visit_appointment_id,
        inspector_user_id, status, assigned_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`,
    [randomUUID(), C1, REQ_1, VISIT_INSP_1, INSP_1, LEAD_1],
  );

  await pool.query(`INSERT INTO handyman_scheduling_readiness
      (id,client_id,handyman_request_id,timezone,preferred_window_start,preferred_window_end,status,
       supersedes_readiness_id,change_reason,created_by_user_id)
    VALUES ('10000000-0000-4000-8000-000000000801',$1,$2,'Asia/Jakarta','2031-10-10T01:00:00Z','2031-10-10T02:00:00Z','INACTIVE',NULL,NULL,$3),
           ('10000000-0000-4000-8000-000000000802',$1,$2,'Asia/Jakarta','2031-10-11T01:00:00Z','2031-10-11T02:00:00Z','ACTIVE',
            '10000000-0000-4000-8000-000000000801','Tenant coordinated revised preference',$3)`, [C1,REQ_1,LEAD_1]);

  sessionService.resolveSessionContext = async (token: string) => {
    const userId = sessions.get(token);
    if (!userId) throw new Error('Invalid token');
    return {
      sessionId: userId,
      userId,
      email: `${userId}@test`,
      displayName: userId,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  };
  userRepository.findById = async (id: string) =>
    ({
      id,
      email: `${id}@test`,
      displayName: id,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as never;
  buildingRepository.findById = async (id: string) =>
    (
      await pool.query(
        'SELECT id, property_id AS "propertyId", status FROM buildings WHERE id=$1',
        [id],
      )
    ).rows[0] ?? null;
  propertyRepository.findById = async (id: string) =>
    (
      await pool.query(
        'SELECT id, client_id AS "clientId", status FROM properties WHERE id=$1',
        [id],
      )
    ).rows[0] ?? null;
  clientRepository.findById = async (id: string) =>
    (
      await pool.query('SELECT id, status FROM clients WHERE id=$1', [id])
    ).rows[0] ?? null;
});

after(async () => {
  sessionService.resolveSessionContext = origResolveSession;
  userRepository.findById = origFindUser;
  buildingRepository.findById = origFindBuilding;
  propertyRepository.findById = origFindProperty;
  clientRepository.findById = origFindClient;
  if (pool) await closePool(pool);
  try {
    await pg?.stop();
  } finally {
    rmSync(pgDir, { recursive: true, force: true });
  }
});

describe('CR-HM-FIELD-AUTHORITY-01 P0-A — Assigned Worker Read Authority', () => {
  it('1: assigned PIC Pekerjaan (Crew Lead) can read Work Order, visit, quotation snapshot, materials, and context with zero commercial leakage', async () => {
    for (const endpoint of [
      `/api/v1/handyman/field/work-orders/${SCOPE_1}`,
      `/api/v1/handyman/field/execution-scopes/${SCOPE_1}`,
    ]) {
      const res = await request(app)
        .get(endpoint)
        .set('Authorization', `Bearer tok-${LEAD_1}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = res.body.data;
      assert.equal(data.actorRole, 'PIC_PEKERJAAN');
      assert.equal(data.workOrder.executionScopeId, SCOPE_1);
      assert.equal(data.workOrder.handymanRequestId, REQ_1);
      assert.equal(data.workOrder.description, 'Leaking pipe under sink');
      assert.equal(data.visit.executionVisit.appointmentId, VISIT_EXEC_1);
      assert.equal(data.visit.inspectionVisit.appointmentId, VISIT_INSP_1);
      assert.equal(data.executionScopeSnapshot.id, SCOPE_1);
      assert.equal(data.executionScopeSnapshot.approvedQuotationVersionId, QVER_1);
      assert.equal(data.approvedQuotation.lines.length, 2);
      assert.equal(data.assignmentContext.crewId, data.visit.executionVisit.resourceId);
      assert.equal(data.assignmentContext.leadUserId, LEAD_1);
      assert.equal(data.schedulingReadiness.current.id, '10000000-0000-4000-8000-000000000802');
      assert.equal(data.schedulingReadiness.history[0].preferredWindowStart, '2031-10-10T01:00:00.000Z');
      assert.equal(data.schedulingReadiness.current.supersedesReadinessId, data.schedulingReadiness.history[0].id);
      assert.notEqual(data.visit.executionVisit.startAt, data.schedulingReadiness.current.preferredWindowStart,
        'Requested preference is not silently substituted for confirmed execution');
      assert.equal(data.inspectionContext.inspection.inspectionResult, 'INSPECTED');
      assert.equal(data.inspectionContext.diagnosis.disciplineCode, 'SIMPLE_PLUMBING');

      // Material role scope: PIC Pekerjaan sees both quotation materials & execution lines
      assert.equal(data.materials.actorRole, 'PIC_PEKERJAAN');
      assert.equal(data.materials.quotationMaterials.length, 1);
      assert.equal(data.materials.executionLines.length, 1);
      assert.equal(data.materials.executionLines[0].id, MAT_LINE_1);
      assert.equal(data.materials.executionLines[0].usedQty, 2);

      // Commercial firewall: zero price/cost/margin/total/currency fields anywhere
      const rawJson = JSON.stringify(data);
      for (const forbidden of [
        'referenceUnitAmount',
        'finalQuotedUnitAmount',
        'costBasisUnitAmount',
        'marginPercent',
        'lineTotal',
        'laborSubtotal',
        'materialSubtotal',
        'currency',
        '150000',
        '200000',
        '400000',
        '195000',
      ]) {
        assert.equal(
          rawJson.includes(forbidden),
          false,
          `commercial field/value leaked: ${forbidden}`,
        );
      }
    }

    const snapRes = await request(app)
      .get(`/api/v1/handyman/field/execution-scopes/${SCOPE_1}/quotation-snapshot`)
      .set('Authorization', `Bearer tok-${LEAD_1}`);
    assert.equal(snapRes.status, 200);
    assert.equal(snapRes.body.data.actorRole, 'PIC_PEKERJAAN');
    assert.equal(snapRes.body.data.approvedQuotation.lines.length, 2);

    const matRes = await request(app)
      .get(`/api/v1/handyman/field/execution-scopes/${SCOPE_1}/materials`)
      .set('Authorization', `Bearer tok-${LEAD_1}`);
    assert.equal(matRes.status, 200);
    assert.equal(matRes.body.data.actorRole, 'PIC_PEKERJAAN');
    assert.equal(matRes.body.data.materials.executionLines.length, 1);
  });

  it('2: assigned Inspector can read authorized Request & Execution Scope within Inspector role scope (no Crew Lead execution lines, zero commercial leakage)', async () => {
    const reqRes = await request(app)
      .get(`/api/v1/handyman/field/requests/${REQ_1}`)
      .set('Authorization', `Bearer tok-${INSP_1}`);
    assert.equal(reqRes.status, 200, JSON.stringify(reqRes.body));
    assert.equal(reqRes.body.data.actorRole, 'INSPECTOR');
    assert.equal(reqRes.body.data.request.handymanRequestId, REQ_1);
    assert.equal(reqRes.body.data.visit.inspectionVisit.appointmentId, VISIT_INSP_1);
    assert.equal(reqRes.body.data.inspectionContext.diagnosis.disciplineCode, 'SIMPLE_PLUMBING');
    assert.equal(reqRes.body.data.materials.actorRole, 'INSPECTOR');
    assert.equal(reqRes.body.data.materials.quotationMaterials.length, 1);
    assert.deepEqual(reqRes.body.data.materials.executionLines, []);

    const scopeRes = await request(app)
      .get(`/api/v1/handyman/field/execution-scopes/${SCOPE_1}`)
      .set('Authorization', `Bearer tok-${INSP_1}`);
    assert.equal(scopeRes.status, 200);
    assert.equal(scopeRes.body.data.actorRole, 'INSPECTOR');
    assert.deepEqual(scopeRes.body.data.materials.executionLines, []);
  });

  it('3: denies unrelated tenant/company, unrelated Work Order, unassigned user, helper, historical lead, and proposed-only inspector', async () => {
    // Unauthenticated -> 401
    const unauth = await request(app).get(
      `/api/v1/handyman/field/work-orders/${SCOPE_1}`,
    );
    assert.equal(unauth.status, 401);

    // Cross-tenant / foreign building user -> 403 BUILDING_ACCESS_DENIED
    const foreign = await request(app)
      .get(`/api/v1/handyman/field/work-orders/${SCOPE_1}`)
      .set('Authorization', `Bearer tok-${FOREIGN_USER}`);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Lead 1 trying to read foreign tenant's Work Order -> 403 BUILDING_ACCESS_DENIED
    const crossTenant = await request(app)
      .get(`/api/v1/handyman/field/work-orders/${SCOPE_FOREIGN}`)
      .set('Authorization', `Bearer tok-${LEAD_1}`);
    assert.equal(crossTenant.status, 403);
    assert.equal(crossTenant.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Unrelated Work Order in the SAME building (LEAD_OTHER_WO reading SCOPE_1) -> 403 HANDYMAN_FIELD_READ_FORBIDDEN
    const otherWo = await request(app)
      .get(`/api/v1/handyman/field/work-orders/${SCOPE_1}`)
      .set('Authorization', `Bearer tok-${LEAD_OTHER_WO}`);
    assert.equal(otherWo.status, 403);
    assert.equal(otherWo.body.error.code, 'HANDYMAN_FIELD_READ_FORBIDDEN');

    // Unassigned user in the same building -> 403 HANDYMAN_FIELD_READ_FORBIDDEN
    const unassigned = await request(app)
      .get(`/api/v1/handyman/field/work-orders/${SCOPE_1}`)
      .set('Authorization', `Bearer tok-${UNASSIGNED_B1}`);
    assert.equal(unassigned.status, 403);
    assert.equal(unassigned.body.error.code, 'HANDYMAN_FIELD_READ_FORBIDDEN');

    // Crew helper (member of crew1, not Lead) -> 403 HANDYMAN_FIELD_READ_FORBIDDEN
    const helper = await request(app)
      .get(`/api/v1/handyman/field/work-orders/${SCOPE_1}`)
      .set('Authorization', `Bearer tok-${HELPER_1}`);
    assert.equal(helper.status, 403);
    assert.equal(helper.body.error.code, 'HANDYMAN_FIELD_READ_FORBIDDEN');

    // Historical (superseded) Crew Lead -> 403 HANDYMAN_FIELD_READ_FORBIDDEN
    const oldLead = await request(app)
      .get(`/api/v1/handyman/field/work-orders/${SCOPE_1}`)
      .set('Authorization', `Bearer tok-${LEAD_OLD}`);
    assert.equal(oldLead.status, 403);
    assert.equal(oldLead.body.error.code, 'HANDYMAN_FIELD_READ_FORBIDDEN');

    // Proposed-only Inspector on REQ_2 -> 403 HANDYMAN_FIELD_READ_FORBIDDEN
    const proposedInsp = await request(app)
      .get(`/api/v1/handyman/field/requests/${REQ_2}`)
      .set('Authorization', `Bearer tok-${INSP_PROPOSED}`);
    assert.equal(proposedInsp.status, 403);
    assert.equal(proposedInsp.body.error.code, 'HANDYMAN_FIELD_READ_FORBIDDEN');

    // Unknown UUID -> 404
    const notFound = await request(app)
      .get(`/api/v1/handyman/field/work-orders/${randomUUID()}`)
      .set('Authorization', `Bearer tok-${LEAD_1}`);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');
  });
  it('PART04 correction: another crew historical visit cannot replace the current assignment schedule in Surat Tugas detail', async () => {
    const before = await request(app).get(`/api/v1/handyman/field/work-orders/${SCOPE_1}`)
      .set('Authorization', `Bearer tok-${LEAD_1}`);
    assert.equal(before.status, 200);
    const otherCrew = (await pool.query('SELECT handyman_crew_id FROM handyman_execution_scope_assignments WHERE execution_scope_id=$1', [SCOPE_2])).rows[0].handyman_crew_id;
    const historicalId = randomUUID();
    try {
      await pool.query(`INSERT INTO handyman_visit_appointments
        (id,client_id,handyman_request_id,tenant_company_id,building_id,kind,execution_scope_id,
         resource_type,resource_id,start_at,end_at,timezone,state,version,created_at)
        SELECT $1,client_id,handyman_request_id,tenant_company_id,building_id,kind,execution_scope_id,
          resource_type,$2,start_at + interval '1 day',end_at + interval '1 day',timezone,'COMPLETED',version,NOW()
          FROM handyman_visit_appointments WHERE id=$3`, [historicalId,otherCrew,VISIT_EXEC_1]);
      const after = await request(app).get(`/api/v1/handyman/field/work-orders/${SCOPE_1}`)
        .set('Authorization', `Bearer tok-${LEAD_1}`);
      assert.equal(after.status, 200, JSON.stringify(after.body));
      assert.deepEqual(after.body.data.visit, before.body.data.visit);
      assert.deepEqual(after.body.data.assignmentContext, before.body.data.assignmentContext);
      assert.deepEqual(after.body.data.schedulingReadiness, before.body.data.schedulingReadiness);
      assert.equal((await pool.query('SELECT id FROM handyman_visit_appointments WHERE id=$1', [historicalId])).rows.length, 1,
        'History is retained, not deleted to hide the stale mapping');
    } finally { await pool.query('DELETE FROM handyman_visit_appointments WHERE id=$1', [historicalId]); }
  });

});
