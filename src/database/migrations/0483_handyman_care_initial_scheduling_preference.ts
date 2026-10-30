import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Existing preference store only. An attested Care actor is not a local User.
 * Its immutable request -> attribution chain owns the initial preference;
 * never fabricate a User/PIC to satisfy the old NOT NULL creator column.
 */
export const migration0483HandymanCareInitialSchedulingPreference: Migration = {
  id: '0483_handyman_care_initial_scheduling_preference',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_scheduling_readiness
        ALTER COLUMN created_by_user_id DROP NOT NULL;

      CREATE FUNCTION handyman_sched_care_creator_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND
           NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
          RAISE EXCEPTION 'Scheduling preference creator is immutable'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.created_by_user_id IS NULL THEN
          IF NEW.supersedes_readiness_id IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM handyman_service_requests r
            JOIN handyman_channel_attributions a ON a.id = r.channel_attribution_id
            WHERE r.id = NEW.handyman_request_id
              AND r.client_id = NEW.client_id AND a.client_id = r.client_id
              AND a.building_id = r.building_id
              AND r.created_by_user_id IS NULL AND a.created_by_user_id IS NULL
              AND r.origin_channel = 'BM_SUPER_APP' AND a.origin_channel = r.origin_channel
              AND a.actor_type = 'CUSTOMER_CARE' AND a.care_actor_id IS NOT NULL
              AND (TG_OP = 'UPDATE' OR r.status = 'INTAKE')
          ) THEN
            RAISE EXCEPTION 'A nullable scheduling creator requires original attested Care request provenance'
              USING ERRCODE = '23514';
          END IF;
          IF TG_OP = 'INSERT' AND (NEW.status <> 'ACTIVE' OR EXISTS (
            SELECT 1 FROM handyman_scheduling_readiness s
              WHERE s.handyman_request_id = NEW.handyman_request_id
          )) THEN
            RAISE EXCEPTION 'Attested Care may own only the initial scheduling preference'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER handyman_sched_care_creator_guard
        BEFORE INSERT OR UPDATE OF created_by_user_id, client_id,
          handyman_request_id, supersedes_readiness_id
        ON handyman_scheduling_readiness
        FOR EACH ROW EXECUTE FUNCTION handyman_sched_care_creator_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_scheduling_readiness WHERE created_by_user_id IS NULL) THEN
          RAISE EXCEPTION 'Cannot roll back Care scheduling provenance while Care-owned history exists'
            USING ERRCODE = '23514';
        END IF;
      END $$;
      DROP TRIGGER handyman_sched_care_creator_guard ON handyman_scheduling_readiness;
      DROP FUNCTION handyman_sched_care_creator_guard();
      ALTER TABLE handyman_scheduling_readiness ALTER COLUMN created_by_user_id SET NOT NULL;
    `);
  },
};
