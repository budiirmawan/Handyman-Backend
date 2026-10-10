import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 05 — payment permission provisioning.
 *
 * 1. Catalogue: `handyman.payment.report` and `handyman.payment.verify` are
 *    registered in the existing `permissions` catalogue. NO role and NO
 *    default assignment is created here: nobody (Customer Care, Dispatcher,
 *    Lead Worker, or any other role) receives verify by default.
 *
 * 2. Care actor grants: a Customer Care actor is not a User and cannot hold a
 *    role. Its permission grants reference the catalogue by code. The CHECK
 *    below is the structural allowlist: a care actor can only ever be granted
 *    REPORT. Verify is unrepresentable for a care actor (maker-checker and
 *    the Finance/Authorized Manager boundary stay User-only).
 *
 * Grants are history: ACTIVE -> REVOKED is the only permitted mutation.
 */
export const migration0432HandymanCareActorPaymentPermission: Migration = {
  id: '0432_handyman_care_actor_payment_permission',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      INSERT INTO permissions (id, code, name, status)
      VALUES
        (gen_random_uuid(), 'handyman.payment.report', 'Report Handyman Customer Payments', 'ACTIVE'),
        (gen_random_uuid(), 'handyman.payment.verify', 'Verify Handyman Customer Payments', 'ACTIVE')
      ON CONFLICT (code) DO NOTHING;

      CREATE TABLE handyman_care_actor_permission_grants (
        id                 UUID PRIMARY KEY,
        care_actor_id      UUID NOT NULL REFERENCES handyman_handoff_care_actors (id),
        permission_code    TEXT NOT NULL REFERENCES permissions (code),
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        granted_by_user_id UUID NOT NULL REFERENCES users (id),
        granted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_by_user_id UUID REFERENCES users (id),
        revoked_at         TIMESTAMPTZ,
        CONSTRAINT handyman_care_actor_perm_grants_status_check
          CHECK (status IN ('ACTIVE', 'REVOKED')),
        CONSTRAINT handyman_care_actor_perm_grants_code_check
          CHECK (permission_code IN ('handyman.payment.report')),
        CONSTRAINT handyman_care_actor_perm_grants_revoke_check
          CHECK ((status = 'ACTIVE' AND revoked_by_user_id IS NULL AND revoked_at IS NULL)
              OR (status = 'REVOKED' AND revoked_by_user_id IS NOT NULL
                  AND revoked_at IS NOT NULL AND revoked_at >= granted_at))
      );
      CREATE UNIQUE INDEX handyman_care_actor_perm_grants_active_unique
        ON handyman_care_actor_permission_grants (care_actor_id, permission_code)
        WHERE status = 'ACTIVE';

      CREATE FUNCTION handyman_care_actor_perm_grant_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Care actor permission grants are history: never deleted.';
        END IF;
        IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED'
           OR NEW.care_actor_id IS DISTINCT FROM OLD.care_actor_id
           OR NEW.permission_code IS DISTINCT FROM OLD.permission_code
           OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
           OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
          RAISE EXCEPTION 'Care actor permission grants allow only ACTIVE -> REVOKED.';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER handyman_care_actor_perm_grant_guard
        BEFORE UPDATE OR DELETE ON handyman_care_actor_permission_grants
        FOR EACH ROW EXECUTE FUNCTION handyman_care_actor_perm_grant_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS handyman_care_actor_permission_grants;
      DROP FUNCTION IF EXISTS handyman_care_actor_perm_grant_guard();
      DELETE FROM permissions
       WHERE code IN ('handyman.payment.report', 'handyman.payment.verify')
         AND NOT EXISTS (SELECT 1 FROM role_permission_assignments r WHERE r.permission_id = permissions.id);
    `);
  },
};
