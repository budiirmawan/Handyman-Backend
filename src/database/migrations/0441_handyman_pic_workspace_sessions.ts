import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W03 PART 03C — the bounded, attested Tenant PIC session (A01 §4–§5, rules
 * 1–22, ratified as contract; the session authority over CR-HM-01 D7 is
 * recorded by `docs/e2e/W03_PART03C_PIC_SESSION_SECURE_HANDOFF.md` §8).
 *
 * WHAT THIS IS. A separate credential/replay store for a PIC principal, built
 * on the machinery the care workspace already proved (`0429`): HMAC-attested
 * assertion from BM, hash-only token, absolute ≤900s expiry, one-time
 * assertion tombstone, immutability guard, and revocation at the authority
 * transition.
 *
 * WHAT THIS IS NOT. It is not a care workspace session and not a User session.
 * A2 forbids any `users` row, `user_sessions` row, role, or RBAC grant for a
 * Tenant PIC approver, so this table has NO user id and NO permission snapshot
 * (rule 10). Purpose isolation (`HANDYMAN_PIC_WORKSPACE`) plus a separate
 * table, separate prefix (`hpw_`), and a separate router is what makes rule
 * 19's "no fallback between credential kinds" structural rather than a
 * promise.
 *
 * NARROWER THAN THE CARE WORKSPACE ON PURPOSE (rule 12): one admission = one
 * (integration, tenant, PIC, building[, space]) context, because a PIC's
 * authority is occupancy-derived, not grant-derived. There is no property
 * picker and no per-call context selection: a session never spans tenants or
 * buildings, and a second building requires a second admission.
 *
 * `tenant_pic_id` is NULLABLE (rule 3): an admission without a PIC is a
 * read-capable session that can never underwrite a decision. That is a
 * credential-shape fact, and `0442` makes the ledger enforce it in the DB.
 *
 * FKs are held on every context id (0437 idiom). None of
 * `tenant_pics`/`tenant_companies`/`tenant_building_contexts`/`spaces`/
 * `buildings` has a hard-delete path in this repo, so a referential lock cannot
 * block master-data lifecycle — it can only refuse to forget who was admitted.
 *
 * Capability widening (rule 20) rides here because admission is meaningless
 * without an integration that may attest a PIC. PostgreSQL has no
 * `ALTER CONSTRAINT`, so this is DROP + ADD over a strictly wider list: every
 * existing row is `'NONE'` or `'CUSTOMER_CARE'` and satisfies it, so validation
 * cannot fail and no row is rewritten (A8).
 */
export const migration0441HandymanPicWorkspaceSessions: Migration = {
  id: '0441_handyman_pic_workspace_sessions',
  async up(client: PoolClient): Promise<void> {
    // Rule 20 — 'TENANT_PIC' is an ATTESTATION RIGHT only (rule 21): it grants
    // no care actor, no property grant, and no business permission whatever.
    await client.query(`
      ALTER TABLE handyman_handoff_integrations
        DROP CONSTRAINT handyman_handoff_integrations_actor_capability_check,
        ADD CONSTRAINT handyman_handoff_integrations_actor_capability_check
          CHECK (actor_capability IN ('NONE', 'CUSTOMER_CARE', 'TENANT_PIC'));
    `);

    await client.query(`
      CREATE TABLE handyman_pic_workspace_sessions (
        id                         UUID PRIMARY KEY,
        integration_id             UUID NOT NULL
          REFERENCES handyman_handoff_integrations (id),
        tenant_company_id          UUID NOT NULL REFERENCES tenant_companies (id),
        tenant_pic_id              UUID REFERENCES tenant_pics (id),
        building_id                UUID NOT NULL REFERENCES buildings (id),
        space_id                   UUID REFERENCES spaces (id),
        tenant_building_context_id UUID NOT NULL
          REFERENCES tenant_building_contexts (id),
        assertion_id               TEXT NOT NULL
          CHECK (char_length(assertion_id) BETWEEN 1 AND 128),
        token_hash                 TEXT NOT NULL UNIQUE
          CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        created_at                 TIMESTAMPTZ NOT NULL,
        expires_at                 TIMESTAMPTZ NOT NULL,
        revoked_at                 TIMESTAMPTZ
          CHECK (revoked_at IS NULL OR revoked_at >= created_at),
        CONSTRAINT handyman_pic_workspace_assertion_unique
          UNIQUE (integration_id, assertion_id),
        -- Rule 15: absolute ceiling and one window per admission. Sliding
        -- expiry is not merely unimplemented — it is unrepresentable, because
        -- no column other than revoked_at is writable (guard below).
        CONSTRAINT handyman_pic_workspace_window_check
          CHECK (expires_at > created_at
                 AND expires_at <= created_at + INTERVAL '15 minutes')
      );

      CREATE INDEX handyman_pic_workspace_pic_idx
        ON handyman_pic_workspace_sessions (tenant_pic_id);
      CREATE INDEX handyman_pic_workspace_integration_idx
        ON handyman_pic_workspace_sessions (integration_id);
      CREATE INDEX handyman_pic_workspace_tenant_idx
        ON handyman_pic_workspace_sessions (tenant_company_id);
    `);

    // Guards and revocation triggers are created in the same statement batch
    // as the table, so there is no state in which the store exists
    // unprotected. The migration is one transaction: partial application is
    // not representable.
    await client.query(`
      -- Rule 18 + ADD-A M5: a PIC transition kills live credentials —
      -- non-ACTIVE, tenant re-parent, or a changed user link (the last one
      -- because MC1' is evaluated against exactly that link). Reactivation
      -- never resurrects: the guard forbids writing revoked_at back to NULL.
      CREATE FUNCTION handyman_pic_workspace_invalidate_pic() RETURNS trigger
      LANGUAGE plpgsql AS $handyman_pic_workspace_invalidate_pic$ BEGIN
        IF NEW.status <> 'ACTIVE'
           OR NEW.tenant_company_id <> OLD.tenant_company_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
          UPDATE handyman_pic_workspace_sessions SET revoked_at = clock_timestamp()
            WHERE tenant_pic_id = OLD.id AND revoked_at IS NULL;
        END IF;
        RETURN NEW;
      END $handyman_pic_workspace_invalidate_pic$;
      CREATE TRIGGER handyman_pic_workspace_invalidate_pic
        AFTER UPDATE ON tenant_pics FOR EACH ROW
        EXECUTE FUNCTION handyman_pic_workspace_invalidate_pic();

      -- Tenant suspension is an authority transition for every session of that
      -- tenant, not only for one PIC.
      CREATE FUNCTION handyman_pic_workspace_invalidate_tenant() RETURNS trigger
      LANGUAGE plpgsql AS $handyman_pic_workspace_invalidate_tenant$ BEGIN
        IF NEW.status <> 'ACTIVE' THEN
          UPDATE handyman_pic_workspace_sessions SET revoked_at = clock_timestamp()
            WHERE tenant_company_id = OLD.id AND revoked_at IS NULL;
        END IF;
        RETURN NEW;
      END $handyman_pic_workspace_invalidate_tenant$;
      CREATE TRIGGER handyman_pic_workspace_invalidate_tenant
        AFTER UPDATE ON tenant_companies FOR EACH ROW
        EXECUTE FUNCTION handyman_pic_workspace_invalidate_tenant();

      -- Same posture as 0429 for the attesting side: an integration that goes
      -- INACTIVE, loses the capability, or changes its code stops carrying
      -- weight immediately (T8's mixed-version defence needs no new mechanism).
      CREATE FUNCTION handyman_pic_workspace_invalidate_integration() RETURNS trigger
      LANGUAGE plpgsql AS $handyman_pic_workspace_invalidate_integration$ BEGIN
        IF NEW.status <> 'ACTIVE' OR NEW.actor_capability <> 'TENANT_PIC'
           OR NEW.integration_code <> OLD.integration_code THEN
          UPDATE handyman_pic_workspace_sessions SET revoked_at = clock_timestamp()
            WHERE integration_id = OLD.id AND revoked_at IS NULL;
        END IF;
        RETURN NEW;
      END $handyman_pic_workspace_invalidate_integration$;
      CREATE TRIGGER handyman_pic_workspace_invalidate_integration
        AFTER UPDATE ON handyman_handoff_integrations FOR EACH ROW
        EXECUTE FUNCTION handyman_pic_workspace_invalidate_integration();

      -- R8: identity, expiry and the replay tombstone are immutable. Exactly
      -- one mutation is permitted — the FIRST revocation — and DELETE is
      -- refused, so the admission trail survives every later cleanup and
      -- revocation audits keep their evidence.
      CREATE FUNCTION handyman_pic_workspace_guard() RETURNS trigger
      LANGUAGE plpgsql AS $handyman_pic_workspace_guard$ BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'PIC workspace replay history cannot be deleted.'
            USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - 'revoked_at')
             IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
           OR OLD.revoked_at IS NOT NULL
           OR NEW.revoked_at IS NULL THEN
          RAISE EXCEPTION 'Only PIC workspace revocation is permitted.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $handyman_pic_workspace_guard$;
      CREATE TRIGGER handyman_pic_workspace_guard
        BEFORE UPDATE OR DELETE ON handyman_pic_workspace_sessions FOR EACH ROW
        EXECUTE FUNCTION handyman_pic_workspace_guard();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // R8 makes replay tombstones permanent evidence, so this store is not
    // silently droppable once anything was ever admitted. `0429.down()` drops
    // its session table unconditionally; this PART deliberately does not repeat
    // that (deviation C-D4): rollback stays available only on a database where
    // the mechanism was never used, and the capability widening is restored
    // only when no integration still claims it.
    await client.query(`
      DO $handyman_pic_workspace_sessions_down$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_pic_workspace_sessions) THEN
          RAISE EXCEPTION
            'Rollback refused: handyman_pic_workspace_sessions holds admission and replay history (R8). Forward-fix only.'
            USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM handyman_handoff_integrations
          WHERE actor_capability = 'TENANT_PIC'
        ) THEN
          RAISE EXCEPTION
            'Rollback refused: an integration still holds the TENANT_PIC attestation capability. Remove it first.'
            USING ERRCODE = '23514';
        END IF;
      END;
      $handyman_pic_workspace_sessions_down$;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_pic_workspace_invalidate_pic
        ON tenant_pics;
      DROP TRIGGER IF EXISTS handyman_pic_workspace_invalidate_tenant
        ON tenant_companies;
      DROP TRIGGER IF EXISTS handyman_pic_workspace_invalidate_integration
        ON handyman_handoff_integrations;
      DROP FUNCTION IF EXISTS handyman_pic_workspace_invalidate_pic();
      DROP FUNCTION IF EXISTS handyman_pic_workspace_invalidate_tenant();
      DROP FUNCTION IF EXISTS handyman_pic_workspace_invalidate_integration();
      DROP TRIGGER IF EXISTS handyman_pic_workspace_guard
        ON handyman_pic_workspace_sessions;
      DROP FUNCTION IF EXISTS handyman_pic_workspace_guard();
      DROP TABLE IF EXISTS handyman_pic_workspace_sessions;
      ALTER TABLE handyman_handoff_integrations
        DROP CONSTRAINT handyman_handoff_integrations_actor_capability_check,
        ADD CONSTRAINT handyman_handoff_integrations_actor_capability_check
          CHECK (actor_capability IN ('NONE', 'CUSTOMER_CARE'));
    `);
  },
};
