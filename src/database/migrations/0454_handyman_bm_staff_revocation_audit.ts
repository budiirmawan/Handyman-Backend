import type { Migration } from './types';

/** Covers automatic authority transitions, not just explicit logout endpoints. */
export const migration0454HandymanBmStaffRevocationAudit: Migration = {
  id:'0454_handyman_bm_staff_revocation_audit',
  async up(tx) {
    await tx.query(`
      CREATE INDEX bm_staff_binding_user ON handyman_bm_staff_bindings(user_id);
      CREATE INDEX bm_staff_scope_assignment ON handyman_bm_staff_scope_grants(building_assignment_id);
      CREATE FUNCTION handyman_bm_staff_revocation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO operational_events(id,client_id,building_id,entity_type,entity_id,event_type,source,summary,metadata)
          SELECT gen_random_uuid(),p.client_id,g.building_id,'HANDYMAN_BM_STAFF_SESSION',NEW.id,
            'HANDYMAN_BM_STAFF_SESSION_INVALIDATED','SYSTEM','Bounded staff session permanently invalidated.',
            jsonb_build_object('userId',d.user_id,'bindingId',d.id,'scopeGrantId',g.id,'launchId',ss.launch_id)
          FROM handyman_bm_staff_sessions ss
          JOIN handyman_bm_staff_scope_grants g ON g.id=ss.scope_grant_id
          JOIN handyman_bm_staff_bindings d ON d.id=g.binding_id
          JOIN buildings b ON b.id=g.building_id JOIN properties p ON p.id=b.property_id
          WHERE ss.session_id=NEW.id;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bm_staff_revocation_audit AFTER UPDATE OF revoked_at ON handyman_care_workspace_sessions
        FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
        EXECUTE FUNCTION handyman_bm_staff_revocation_audit();
    `);
  },
  async down(){throw new Error('Retain staff revocation audit; use a corrective migration.');},
};
