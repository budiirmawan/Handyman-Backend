import { randomUUID } from 'node:crypto';
import type { Migration } from './types';

/** Explicit User authority alongside, never replacing, legacy non-User Care. */
export const migration0453HandymanBmStaffAuthority: Migration = {
  id: '0453_handyman_bm_staff_authority',
  async up(tx) {
    const permissionId=randomUUID(), roleId=randomUUID();
    // Catalogue only. Deliberately no User assignment or privileged bootstrap.
    // A conflicting pre-existing role/code fails migration, never gains privileges silently.
    await tx.query(`INSERT INTO permissions(id,code,name) VALUES ($1,'handyman.care.staff.access','Customer Care staff workspace')`,[permissionId]);
    await tx.query(`INSERT INTO roles(id,code,name) VALUES ($1,'HANDYMAN_CUSTOMER_CARE','Handyman Customer Care staff')`,[roleId]);
    await tx.query(`INSERT INTO role_permission_assignments(id,role_id,permission_id) VALUES ($1,$2,$3)`,[randomUUID(),roleId,permissionId]);
    await tx.query(`
      CREATE TABLE handyman_bm_staff_bindings (
        id uuid PRIMARY KEY,
        integration_id uuid NOT NULL REFERENCES handyman_handoff_integrations(id),
        subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 128 AND subject=btrim(subject)),
        care_actor_id uuid NOT NULL REFERENCES handyman_handoff_care_actors(id),
        user_id uuid NOT NULL REFERENCES users(id),
        provisioned_by_user_id uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        revoked_at timestamptz,
        revoked_by_user_id uuid REFERENCES users(id),
        CHECK ((revoked_at IS NULL)=(revoked_by_user_id IS NULL))
      );
      CREATE UNIQUE INDEX bm_staff_binding_subject_active ON handyman_bm_staff_bindings(integration_id,subject) WHERE revoked_at IS NULL;
      CREATE TABLE handyman_bm_staff_scope_grants (
        id uuid PRIMARY KEY,
        binding_id uuid NOT NULL REFERENCES handyman_bm_staff_bindings(id),
        tenant_company_id uuid NOT NULL REFERENCES tenant_companies(id),
        building_id uuid NOT NULL REFERENCES buildings(id),
        building_assignment_id uuid NOT NULL REFERENCES user_building_assignments(id),
        granted_by_user_id uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        revoked_at timestamptz,
        revoked_by_user_id uuid REFERENCES users(id),
        CHECK ((revoked_at IS NULL)=(revoked_by_user_id IS NULL))
      );
      CREATE UNIQUE INDEX bm_staff_scope_active ON handyman_bm_staff_scope_grants(binding_id,tenant_company_id,building_id) WHERE revoked_at IS NULL;
      CREATE TABLE handyman_bm_staff_sessions (
        session_id uuid PRIMARY KEY REFERENCES handyman_care_workspace_sessions(id),
        launch_id uuid NOT NULL UNIQUE REFERENCES handyman_bm_staff_launch_receipts(id),
        scope_grant_id uuid NOT NULL REFERENCES handyman_bm_staff_scope_grants(id)
      );
      CREATE INDEX bm_staff_session_scope ON handyman_bm_staff_sessions(scope_grant_id);
      CREATE FUNCTION handyman_bm_staff_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Staff authority history is append-only.'; END IF;
        IF TG_TABLE_NAME='handyman_bm_staff_sessions' OR
          (to_jsonb(NEW)-'revoked_at'-'revoked_by_user_id') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by_user_id') OR
          OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
          RAISE EXCEPTION 'Staff authority permits irreversible revocation only.';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bm_staff_binding_guard BEFORE UPDATE OR DELETE ON handyman_bm_staff_bindings FOR EACH ROW EXECUTE FUNCTION handyman_bm_staff_authority_guard();
      CREATE TRIGGER bm_staff_scope_guard BEFORE UPDATE OR DELETE ON handyman_bm_staff_scope_grants FOR EACH ROW EXECUTE FUNCTION handyman_bm_staff_authority_guard();
      CREATE TRIGGER bm_staff_session_guard BEFORE UPDATE OR DELETE ON handyman_bm_staff_sessions FOR EACH ROW EXECUTE FUNCTION handyman_bm_staff_authority_guard();

      CREATE VIEW handyman_bm_staff_live_authority AS
        SELECT g.id AS grant_id, d.id AS binding_id, d.integration_id, d.subject, d.care_actor_id,d.user_id,
          g.tenant_company_id,g.building_id,p.id AS property_id,p.client_id,g.building_assignment_id,
          i.integration_code
        FROM handyman_bm_staff_scope_grants g
        JOIN handyman_bm_staff_bindings d ON d.id=g.binding_id AND d.revoked_at IS NULL
        JOIN users u ON u.id=d.user_id AND u.status='ACTIVE'
        JOIN handyman_handoff_integrations i ON i.id=d.integration_id AND i.status='ACTIVE' AND i.actor_capability='CUSTOMER_CARE'
        JOIN handyman_handoff_care_actors a ON a.id=d.care_actor_id AND a.integration_id=i.id AND a.actor_reference=d.subject AND a.status='ACTIVE'
        JOIN user_building_assignments ba ON ba.id=g.building_assignment_id AND ba.user_id=u.id AND ba.building_id=g.building_id AND ba.status='ACTIVE'
        JOIN buildings b ON b.id=g.building_id AND b.status='ACTIVE'
        JOIN properties p ON p.id=b.property_id AND p.status='ACTIVE'
        JOIN clients c ON c.id=p.client_id AND c.status='ACTIVE'
        JOIN tenant_companies t ON t.id=g.tenant_company_id AND t.client_id=c.id AND t.status='ACTIVE'
        WHERE g.revoked_at IS NULL
          AND EXISTS(SELECT 1 FROM tenant_building_contexts bc WHERE bc.tenant_company_id=t.id AND bc.building_id=b.id AND bc.status='ACTIVE'
            AND (bc.effective_from IS NULL OR bc.effective_from<=clock_timestamp()) AND (bc.effective_until IS NULL OR bc.effective_until>=clock_timestamp()))
          AND EXISTS(SELECT 1 FROM user_role_assignments ur JOIN roles r ON r.id=ur.role_id AND r.status='ACTIVE'
            JOIN role_permission_assignments rp ON rp.role_id=r.id AND rp.status='ACTIVE'
            JOIN permissions pe ON pe.id=rp.permission_id AND pe.status='ACTIVE'
            WHERE ur.user_id=u.id AND ur.status='ACTIVE' AND pe.code='handyman.care.staff.access');

      -- Mandatory read-time boundary. NULL selections mean discovery within the
      -- admitted scope, never all grants of the User. Legacy sessions are unchanged.
      CREATE FUNCTION handyman_bm_staff_scope(sid uuid,bid uuid DEFAULT NULL,tid uuid DEFAULT NULL,pid uuid DEFAULT NULL)
      RETURNS boolean LANGUAGE sql VOLATILE AS $$
        SELECT NOT EXISTS(SELECT 1 FROM handyman_bm_staff_sessions WHERE session_id=sid) OR EXISTS(
          SELECT 1 FROM handyman_bm_staff_sessions ss
          JOIN handyman_care_workspace_sessions s ON s.id=ss.session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          JOIN handyman_bm_staff_live_authority v ON v.grant_id=ss.scope_grant_id AND v.integration_id=s.integration_id AND v.care_actor_id=s.care_actor_id
          JOIN handyman_bm_staff_launch_receipts l ON l.id=ss.launch_id AND l.integration_id=v.integration_id
            AND l.care_actor_id=v.care_actor_id AND l.requested_building_id=v.building_id AND l.issuer=v.integration_code
          JOIN handyman_care_property_grants pg ON pg.id=l.property_grant_id AND pg.status='ACTIVE'
            AND pg.care_actor_id=v.care_actor_id AND pg.property_id=v.property_id
          WHERE ss.session_id=sid AND (bid IS NULL OR v.building_id=bid)
            AND (tid IS NULL OR v.tenant_company_id=tid) AND (pid IS NULL OR v.property_id=pid)
        )
      $$;
      CREATE FUNCTION handyman_bm_staff_space(sid uuid,space uuid,bid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
        SELECT NOT EXISTS(SELECT 1 FROM handyman_bm_staff_sessions WHERE session_id=sid) OR EXISTS(
          SELECT 1 FROM tenant_space_relationships ts WHERE ts.space_id=space AND ts.building_id=bid AND ts.status='ACTIVE'
            AND (ts.effective_from IS NULL OR ts.effective_from<=clock_timestamp()) AND (ts.effective_until IS NULL OR ts.effective_until>=clock_timestamp())
            AND handyman_bm_staff_scope(sid,bid,ts.tenant_company_id))
      $$;
      -- Withdrawal is durable, even when restored between requests. No legacy
      -- session is touched. Live checks remain mandatory, including time windows.
      CREATE FUNCTION handyman_bm_staff_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        UPDATE handyman_care_workspace_sessions s SET revoked_at=clock_timestamp()
          WHERE s.revoked_at IS NULL AND EXISTS(SELECT 1 FROM handyman_bm_staff_sessions ss WHERE ss.session_id=s.id)
            AND NOT handyman_bm_staff_scope(s.id);
        UPDATE handyman_bm_staff_launch_receipts l SET revoked_at=clock_timestamp()
          WHERE l.revoked_at IS NULL AND l.consumed_at IS NULL
            AND EXISTS(SELECT 1 FROM handyman_bm_staff_bindings d WHERE d.integration_id=l.integration_id AND d.care_actor_id=l.care_actor_id)
            AND NOT EXISTS(SELECT 1 FROM handyman_bm_staff_live_authority v WHERE v.integration_id=l.integration_id
              AND v.care_actor_id=l.care_actor_id AND v.building_id=l.requested_building_id);
        RETURN NULL;
      END $$;
    `);
    for(const table of ['handyman_bm_staff_bindings','handyman_bm_staff_scope_grants','users','user_building_assignments',
      'user_role_assignments','roles','role_permission_assignments','permissions','tenant_companies','tenant_building_contexts',
      'buildings','properties','clients','handyman_care_property_grants']) {
      await tx.query(`CREATE TRIGGER bm_staff_invalidate AFTER UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION handyman_bm_staff_invalidate()`);
    }
  },
  async down() { throw new Error('Staff identity/session history must be retained; use a corrective migration.'); },
};
