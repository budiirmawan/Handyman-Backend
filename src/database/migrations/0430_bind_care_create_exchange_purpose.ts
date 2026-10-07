import type { Migration } from './types';

/** Reuse the handoff exchange store/lifecycle. Existing exchanges remain HANDOFF.
 * New workspace-issued exchanges are create-only and retain their original
 * property/session binding so neither reparenting nor logout widens authority. */
export const migration0430BindCareCreateExchangePurpose: Migration = {
  id: '0430_bind_care_create_exchange_purpose',
  async up(client) {
    await client.query(`
      ALTER TABLE handyman_handoff_exchanges
        ADD COLUMN purpose TEXT NOT NULL DEFAULT 'HANDOFF',
        ADD COLUMN workspace_session_id UUID REFERENCES handyman_care_workspace_sessions(id),
        ADD COLUMN care_property_id UUID REFERENCES properties(id),
        ADD CONSTRAINT handyman_handoff_exchange_purpose_check CHECK (
          (purpose = 'HANDOFF' AND workspace_session_id IS NULL AND care_property_id IS NULL)
          OR (purpose = 'CARE_CREATE' AND workspace_session_id IS NOT NULL AND care_property_id IS NOT NULL
            AND actor_type IS NOT DISTINCT FROM 'CUSTOMER_CARE' AND care_actor_id IS NOT NULL
            AND tenant_pic_id IS NULL AND resolved_user_id IS NULL)
        );
      CREATE FUNCTION handyman_care_create_exchange_binding_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.purpose IS DISTINCT FROM OLD.purpose
          OR NEW.workspace_session_id IS DISTINCT FROM OLD.workspace_session_id
          OR NEW.care_property_id IS DISTINCT FROM OLD.care_property_id THEN
          RAISE EXCEPTION 'Exchange purpose and workspace/property binding are immutable.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER handyman_care_create_exchange_binding_guard
        BEFORE UPDATE ON handyman_handoff_exchanges FOR EACH ROW
        EXECUTE FUNCTION handyman_care_create_exchange_binding_guard();
    `);
  },
  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_care_create_exchange_binding_guard ON handyman_handoff_exchanges;
      DROP FUNCTION IF EXISTS handyman_care_create_exchange_binding_guard();
      ALTER TABLE handyman_handoff_exchanges DROP CONSTRAINT handyman_handoff_exchange_purpose_check,
        DROP COLUMN care_property_id, DROP COLUMN workspace_session_id, DROP COLUMN purpose;
    `);
  },
};
