import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W03 PART 03F — A01 E1–E3, F7/F8/F9. A prospective INSERT floor, not a
 * reinterpretation of historical USER approvals/scopes (A8/A9). No backfill,
 * permission, new status, binding column, or idempotency tightening (R6/M6).
 *
 * The predicate is shared by the service preflight and the trigger. Historical
 * replay checks immutable provenance, not today's credential/occupancy windows
 * or today's location hierarchy. Creation additionally requires the decision
 * written by this approval transaction and the currently eligible context.
 */
export const migration0443HandymanExecutionScopeApprovalGate: Migration = {
  id: '0443_handyman_execution_scope_approval_gate',
  async up(client: PoolClient): Promise<void> {
    // Close the scan/install race. Match the engine's version -> scope order;
    // let an in-flight approval finish BEFORE inspecting existing scope facts.
    // Plain historical reads remain possible. No actor/session table is locked.
    await client.query(`LOCK TABLE handyman_quotation_versions,
      handyman_execution_scopes IN EXCLUSIVE MODE`);
    await client.query(`
      CREATE FUNCTION handyman_execution_scope_approval_valid(
        candidate handyman_execution_scopes, creating boolean
      ) RETURNS boolean LANGUAGE sql VOLATILE AS $scope_approval$
        SELECT EXISTS (
          SELECT 1
          FROM handyman_quotation_decisions d
          JOIN handyman_quotation_versions v ON v.id = d.quotation_version_id
          JOIN handyman_quotations q ON q.id = v.quotation_id
          JOIN handyman_service_requests r ON r.id = q.handyman_request_id
          JOIN handyman_quotation_approval_bindings b ON b.id = d.approval_binding_id
          JOIN handyman_pic_workspace_sessions s ON s.id = d.decided_by_pic_session_id
          WHERE (candidate).status = 'AUTHORIZED'
            AND (candidate).created_by_actor_type = 'TENANT_PIC'
            AND (candidate).created_by_user_id IS NULL
            AND d.id = (candidate).quotation_decision_id
            AND d.decision = 'APPROVE' AND d.decision_actor_type = 'TENANT_PIC'
            AND d.decided_by_user_id IS NULL
            AND d.decided_by_tenant_pic_id = (candidate).created_by_tenant_pic_id
            AND d.decided_by_pic_session_id = (candidate).created_by_pic_session_id
            AND d.quotation_id = q.id AND q.id = (candidate).quotation_id
            AND v.id = (candidate).approved_quotation_version_id
            AND v.status = 'APPROVED'
            AND v.valid_until > d.decided_at
            AND d.client_id = q.client_id AND q.client_id = r.client_id
            AND r.client_id = (candidate).client_id
            AND r.id = (candidate).handyman_request_id
            AND r.channel_attribution_id = (candidate).channel_attribution_id
            AND r.tenant_company_id = d.tenant_company_id
            AND r.tenant_company_id = (candidate).tenant_company_id
            AND r.tenant_pic_id IS NOT DISTINCT FROM d.tenant_pic_id
            AND r.tenant_pic_id IS NOT DISTINCT FROM (candidate).tenant_pic_id
            AND (r.tenant_pic_id IS NULL OR r.tenant_pic_id = d.decided_by_tenant_pic_id)
            AND r.building_id = (candidate).building_id
            AND r.space_id = (candidate).space_id
            AND b.quotation_id = q.id AND b.handyman_request_id = r.id
            AND b.client_id = r.client_id AND b.tenant_company_id = d.tenant_company_id
            AND b.building_id = r.building_id
            AND b.space_id IS NOT DISTINCT FROM r.space_id
            AND b.tenant_pic_id = d.decided_by_tenant_pic_id AND b.status = 'ACTIVE'
            AND b.effective_from <= d.decided_at
            AND (b.effective_until IS NULL OR b.effective_until > d.decided_at)
            AND s.tenant_pic_id = d.decided_by_tenant_pic_id
            AND s.tenant_company_id = d.tenant_company_id
            AND s.building_id = r.building_id
            AND (s.space_id IS NULL OR s.space_id = r.space_id)
            AND s.created_at <= d.decided_at AND s.expires_at > d.decided_at
            AND (s.revoked_at IS NULL OR s.revoked_at > d.decided_at)
            AND (NOT creating OR (
              -- E1: this is the existing engine's single top-level approval
              -- transaction, never a delayed repair/replay of a committed row.
              d.xmin = pg_current_xact_id()::xid
              AND d.decided_at <= clock_timestamp()
              AND v.valid_until > clock_timestamp()
              AND b.effective_from <= clock_timestamp()
              AND (b.effective_until IS NULL OR b.effective_until > clock_timestamp())
              AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
              AND EXISTS (
                SELECT 1 FROM tenant_pics p
                JOIN tenant_companies tc ON tc.id = p.tenant_company_id
                JOIN clients c ON c.id = tc.client_id
                JOIN handyman_handoff_integrations i ON i.id = s.integration_id
                WHERE p.id = d.decided_by_tenant_pic_id
                  AND p.tenant_company_id = d.tenant_company_id
                  AND tc.client_id = d.client_id
                  AND p.status = 'ACTIVE' AND tc.status = 'ACTIVE' AND c.status = 'ACTIVE'
                  AND i.status = 'ACTIVE' AND i.actor_capability = 'TENANT_PIC'
                  AND (p.user_id IS NULL OR (
                    p.user_id <> q.created_by_user_id
                    AND p.user_id <> v.created_by_user_id
                    AND p.user_id <> b.granted_by_user_id
                  ))
              )
              AND EXISTS (
                SELECT 1 FROM tenant_building_contexts tbc
                WHERE tbc.tenant_company_id = d.tenant_company_id
                  AND tbc.building_id = r.building_id AND tbc.status = 'ACTIVE'
                  AND (tbc.effective_from IS NULL OR tbc.effective_from <= clock_timestamp())
                  AND (tbc.effective_until IS NULL OR tbc.effective_until >= clock_timestamp())
              )
              AND EXISTS (
                SELECT 1 FROM tenant_space_relationships ts
                WHERE ts.tenant_company_id = d.tenant_company_id
                  AND ts.building_id = r.building_id AND ts.space_id = r.space_id
                  AND ts.status = 'ACTIVE'
                  AND (ts.effective_from IS NULL OR ts.effective_from <= clock_timestamp())
                  AND (ts.effective_until IS NULL OR ts.effective_until >= clock_timestamp())
              )
              AND EXISTS (
                SELECT 1 FROM spaces sp
                JOIN rooms rm ON rm.id = sp.room_id
                JOIN areas a ON a.id = rm.area_id
                JOIN floors f ON f.id = a.floor_id
                JOIN buildings building ON building.id = f.building_id
                JOIN properties property ON property.id = building.property_id
                WHERE sp.id = r.space_id AND f.building_id = r.building_id
                  AND property.client_id = d.client_id
                  AND rm.id = (candidate).room_id AND a.id = (candidate).area_id
                  AND f.id = (candidate).floor_id
              )
            ))
        );
      $scope_approval$;
    `);

    // Controlled cutover: do not grandfather a broken PIC provenance chain or
    // silently repair it. USER facts are expressly preserved by A9. This scan
    // neither measures a production population nor renews expired credentials.
    await client.query(`
      DO $scope_cutover$ BEGIN
        IF EXISTS (
          SELECT 1 FROM handyman_execution_scopes s
          WHERE s.created_by_actor_type = 'TENANT_PIC'
            AND NOT handyman_execution_scope_approval_valid(s, false)
        ) THEN
          RAISE EXCEPTION 'Execution scope cutover blocked: invalid existing PIC approval provenance; audited resolution required, no backfill.'
            USING ERRCODE = '23514';
        END IF;
      END $scope_cutover$;

      CREATE FUNCTION handyman_execution_scope_require_approval()
      RETURNS trigger LANGUAGE plpgsql AS $scope_gate$ BEGIN
        -- Re-lock the existing engine's boundaries, never an actor table or a
        -- new credential. R7's integration/tenant -> session seam is unchanged.
        PERFORM 1 FROM handyman_quotation_versions
          WHERE id = NEW.approved_quotation_version_id FOR UPDATE;
        PERFORM 1 FROM handyman_quotation_approval_bindings b
          JOIN handyman_quotation_decisions d ON d.approval_binding_id = b.id
          WHERE d.id = NEW.quotation_decision_id FOR SHARE OF b;
        IF NOT handyman_execution_scope_approval_valid(NEW, true) THEN
          RAISE EXCEPTION 'Execution scope requires this transaction''s authoritative Tenant PIC APPROVE decision and matching context.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $scope_gate$;
      CREATE TRIGGER handyman_execution_scope_approval_gate
        BEFORE INSERT ON handyman_execution_scopes FOR EACH ROW
        EXECUTE FUNCTION handyman_execution_scope_require_approval();
    `);

    // Protect the lifecycle fact on which scope eligibility rests. F2 terminal
    // versions cannot be reopened or re-timed; a fresh decision projection must
    // be supported by this transaction's PIC ledger row (E1 write ordering).
    // The original 0391 identity guard and 0395 immutable scope guard stay put.
    await client.query(`
      CREATE FUNCTION handyman_quotation_decision_projection_guard()
      RETURNS trigger LANGUAGE plpgsql AS $projection_gate$ BEGIN
        IF TG_OP = 'INSERT' THEN
          -- F2/F3: a version starts DRAFT. Otherwise a raw INSERT could skip
          -- the ISSUED -> decided transition whose provenance we protect below.
          IF NEW.status IS DISTINCT FROM 'DRAFT' OR NEW.valid_until IS NOT NULL THEN
            RAISE EXCEPTION 'Quotation versions must start DRAFT without a decision projection.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.status IN ('APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED') THEN
          IF NEW.status IS DISTINCT FROM OLD.status
             OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
            RAISE EXCEPTION 'Terminal quotation authority cannot be reopened or re-timed.'
              USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.status IN ('APPROVED', 'REJECTED') THEN
          IF OLD.status <> 'ISSUED'
             OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
             OR NOT EXISTS (
               SELECT 1 FROM handyman_quotation_decisions d
               WHERE d.quotation_version_id = OLD.id
                 AND d.quotation_id = OLD.quotation_id
                 AND d.decision_actor_type = 'TENANT_PIC'
                 AND d.xmin = pg_current_xact_id()::xid
                 AND d.decision = CASE NEW.status WHEN 'APPROVED' THEN 'APPROVE' ELSE 'REJECT' END
                 AND OLD.valid_until > d.decided_at
             ) THEN
            RAISE EXCEPTION 'Quotation decision projection requires this transaction''s matching Tenant PIC decision.'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $projection_gate$;
      CREATE TRIGGER handyman_quotation_decision_projection_gate
        BEFORE INSERT OR UPDATE ON handyman_quotation_versions FOR EACH ROW
        EXECUTE FUNCTION handyman_quotation_decision_projection_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`LOCK TABLE handyman_quotation_versions,
      handyman_execution_scopes IN EXCLUSIVE MODE`);
    await client.query(`
      DO $scope_gate_down$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_quotation_decisions WHERE decision_actor_type = 'TENANT_PIC')
           OR EXISTS (SELECT 1 FROM handyman_execution_scopes WHERE created_by_actor_type = 'TENANT_PIC') THEN
          RAISE EXCEPTION 'Cannot remove PIC execution scope gates after PIC facts exist; forward-fix only.';
        END IF;
      END $scope_gate_down$;
      DROP TRIGGER IF EXISTS handyman_quotation_decision_projection_gate ON handyman_quotation_versions;
      DROP FUNCTION IF EXISTS handyman_quotation_decision_projection_guard();
      DROP TRIGGER IF EXISTS handyman_execution_scope_approval_gate ON handyman_execution_scopes;
      DROP FUNCTION IF EXISTS handyman_execution_scope_require_approval();
      DROP FUNCTION IF EXISTS handyman_execution_scope_approval_valid(handyman_execution_scopes, boolean);
    `);
  },
};
