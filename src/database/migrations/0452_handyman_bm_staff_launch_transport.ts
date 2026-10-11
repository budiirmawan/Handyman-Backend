import type { Migration } from './types';

/** Transport receipts only. No User mapping, grant or workspace session authority. */
export const migration0452HandymanBmStaffLaunchTransport: Migration = {
  id: '0452_handyman_bm_staff_launch_transport',
  async up(tx) {
    await tx.query(`
      CREATE TABLE handyman_bm_staff_launch_receipts (
        id UUID PRIMARY KEY,
        integration_id UUID NOT NULL REFERENCES handyman_handoff_integrations(id),
        care_actor_id UUID NOT NULL REFERENCES handyman_handoff_care_actors(id),
        property_grant_id UUID NOT NULL REFERENCES handyman_care_property_grants(id),
        requested_building_id UUID NOT NULL REFERENCES buildings(id),
        assertion_id UUID NOT NULL,
        issuer TEXT NOT NULL,
        audience TEXT NOT NULL CHECK(audience='HANDYMAN_BM_STAFF_SSO'),
        reference_hash TEXT NOT NULL UNIQUE CHECK(reference_hash ~ '^[a-f0-9]{64}$'),
        credential_binding TEXT NOT NULL CHECK(credential_binding ~ '^[a-f0-9]{64}$'),
        issued_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        UNIQUE(integration_id,assertion_id),
        CHECK(expires_at>issued_at AND expires_at<=issued_at+INTERVAL '60 seconds'),
        CHECK(consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at)),
        CHECK(revoked_at IS NULL OR revoked_at>=issued_at)
      );
      CREATE FUNCTION handyman_bm_staff_launch_guard() RETURNS trigger AS $$ BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BM staff transport replay history is append-only.'; END IF;
        IF (to_jsonb(NEW)-'consumed_at'-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at'-'revoked_at')
          OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
          OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
          OR (OLD.revoked_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
          RAISE EXCEPTION 'Only irreversible consumption or revocation is permitted.';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER bm_staff_launch_immutable BEFORE UPDATE OR DELETE ON handyman_bm_staff_launch_receipts
        FOR EACH ROW EXECUTE FUNCTION handyman_bm_staff_launch_guard();
      CREATE FUNCTION handyman_bm_staff_launch_revoke() RETURNS trigger AS $$ BEGIN
        IF TG_TABLE_NAME='handyman_handoff_integrations' THEN
          IF NEW.status<>'ACTIVE' OR NEW.actor_capability<>'CUSTOMER_CARE' THEN
            UPDATE handyman_bm_staff_launch_receipts SET revoked_at=clock_timestamp()
              WHERE integration_id=NEW.id AND revoked_at IS NULL AND consumed_at IS NULL;
          END IF;
        ELSIF NEW.status<>'ACTIVE' THEN
          UPDATE handyman_bm_staff_launch_receipts SET revoked_at=clock_timestamp()
            WHERE care_actor_id=NEW.id AND revoked_at IS NULL AND consumed_at IS NULL;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER bm_staff_launch_integration_revoke AFTER UPDATE ON handyman_handoff_integrations
        FOR EACH ROW EXECUTE FUNCTION handyman_bm_staff_launch_revoke();
      CREATE TRIGGER bm_staff_launch_actor_revoke AFTER UPDATE ON handyman_handoff_care_actors
        FOR EACH ROW EXECUTE FUNCTION handyman_bm_staff_launch_revoke();
    `);
  },
  async down() {
    throw new Error('BM staff transport replay history must be retained; use a corrective migration.');
  },
};
