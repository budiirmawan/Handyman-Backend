import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W03 PART 03B — thread-level PIC approval binding table (schema foundation).
 *
 * Contract: `docs/handyman/CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md`
 * §3.1 (shape), §3.2 (B1–B7 eligibility), §3.3 (B8–B11), §3.4 (B12–B17),
 * §4 (B18–B20), §5 (R-1.2), §6 (MC1'/MC0), §7.1 (M1, M3, M6) — ratified at
 * `1cdaffe` together with CR-HM-06/A01 v1.1.
 *
 * WHAT THIS MIGRATION IS. One new append-only table anchored on the quotation
 * THREAD (`handyman_quotations.id`, ADD-A B0: neither the request nor a version
 * row), modelled on the repo's own grant-history idiom (`0432`
 * `handyman_care_actor_permission_grants`) — never on a mutable column. The
 * thread anchor is legitimate because `handyman_quotations_request_unique`
 * (`0391`) makes the thread 1:1 with its request, and `0393`'s one-ISSUED index
 * already makes "presented right now" a cheap existence test.
 *
 * WHY A TABLE AND NOT A COLUMN. `handyman_quotations` and
 * `handyman_quotation_versions` are guarded by column-list immutability triggers
 * (`0391:86-122`): an unlisted column is silently mutable, and a per-revision
 * copy of "who is entitled to consent" would let authority drift per revision.
 * A separate append-only ledger gives immutable attribution, an explicit
 * supersede chain, and a revocation history a column cannot carry (M1).
 *
 * ADDITIVE ONLY. No UPDATE/DELETE of any existing row, no backfill, no rewrite
 * of `0378`/`0391`/`0394`/`0395`, no permission code, no role, no seed (M6:
 * nothing unrelated rides along). M1: this table's guard exists from birth, so
 * it never needed the trigger-timing widening the two ledgers require.
 *
 * NOT ENABLED HERE. This PART ships the schema floor only. The B12
 * "bind-before-present" refusal at `issueHandymanQuotationVersion` (C17), the
 * B16 live re-evaluation inside the decision path (C19), the staff bind/revoke
 * write routes (C21/C22) and the `approvalBindingId` projection (C20) are
 * 03B2/03C work. Nothing in `src/**` writes to this table yet, so no tenant
 * behaviour changes: the binding rows that will exist after this migration are
 * exactly the rows a later service is allowed to create.
 *
 * LIFECYCLE ENFORCED BY THE GUARD (ratified subset that is structural, not
 * service logic):
 *   B1/B2/B5  PIC must exist, be ACTIVE, belong to the attributed tenant, and
 *             the tenant company + client must be ACTIVE.
 *   B3/B4     `occupancy_authority_id` / `space_authority_id` must name the
 *             ACTIVE, effective `tenant_building_contexts` /
 *             `tenant_space_relationships` row for exactly
 *             (tenant, building[, space]) — predicate shape reused from
 *             `handyman-service-request.repository.ts:209-227`. The space row is
 *             required whenever the request carries a space (B4) and is
 *             unrepresentable otherwise (CHECK).
 *   B7        NO request-status precondition is invented: `0378:71-73` allows
 *             `INTAKE` only, so request status can never gate a binding. The
 *             gate is thread state (B12/B13/B18), and B12 is not enabled yet.
 *   B13 (DB floor) re-binding (a row that supersedes) is refused while any
 *             version of the thread is ISSUED and undecided — the presented
 *             commercial facts were presented *to* a person. Revoke stays always
 *             allowed (B15); the service-level refusal with a clean error code
 *             is 03B2.
 *   B18/B20   any decision row for the thread freezes it: no INSERT and no
 *             revoke afterwards, enforced in the DB so a writer that forgets the
 *             check cannot rewrite an authorized-consent context.
 *   B14       reassignment is INSERT(max_version + 1) + revoke of the prior row
 *             in one transaction — never an UPDATE in place; the partial unique
 *             `…_one_active` index makes the opposite order impossible, which is
 *             why the prior row must already be REVOKED.
 *   R-1.2     a binding may never contradict the BM-attested lineage PIC
 *             (`handyman_service_requests.tenant_pic_id` when NOT NULL).
 *   MC1'/MC0  the granter may not name a PIC linked to themselves (the maker
 *             set includes the granter; a NULL PIC link stays legitimate — MC4').
 *
 * HISTORY, NOT CREDENTIAL (B17/M5): `occupancy_authority_id` and
 * `space_authority_id` are audit evidence of what justified the binding at the
 * moment it was made. They are never read as authority at decision time — B16
 * re-evaluation is what kills a binding's effect, and a revocation cascade that
 * silently UPDATEs live bindings would falsify history.
 */
export const migration0437HandymanQuotationApprovalBindings: Migration = {
  id: '0437_handyman_quotation_approval_bindings',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS handyman_quotation_approval_bindings (
        id                      UUID PRIMARY KEY,
        quotation_id            UUID NOT NULL
          REFERENCES handyman_quotations (id),
        handyman_request_id     UUID NOT NULL,
        client_id               UUID NOT NULL REFERENCES clients (id),
        tenant_company_id       UUID NOT NULL REFERENCES tenant_companies (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        space_id                UUID REFERENCES spaces (id),
        tenant_pic_id           UUID NOT NULL REFERENCES tenant_pics (id),
        binding_version         INTEGER NOT NULL,
        supersedes_binding_id   UUID,
        status                  TEXT NOT NULL DEFAULT 'ACTIVE',
        effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_until         TIMESTAMPTZ,
        occupancy_authority_id  UUID NOT NULL
          REFERENCES tenant_building_contexts (id),
        space_authority_id      UUID
          REFERENCES tenant_space_relationships (id),
        granted_by_user_id      UUID NOT NULL REFERENCES users (id),
        granted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_by_user_id      UUID REFERENCES users (id),
        revoked_at              TIMESTAMPTZ,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_quotation_approval_bindings_status_check
          CHECK (status IN ('ACTIVE', 'REVOKED')),
        CONSTRAINT handyman_quotation_approval_bindings_version_check
          CHECK (binding_version >= 1),
        CONSTRAINT handyman_quotation_approval_bindings_window_check
          CHECK (effective_until IS NULL OR effective_until > effective_from),
        CONSTRAINT handyman_quotation_approval_bindings_revoke_check
          CHECK ((status = 'ACTIVE'
                    AND revoked_by_user_id IS NULL
                    AND revoked_at IS NULL)
                 OR (status = 'REVOKED'
                    AND revoked_by_user_id IS NOT NULL
                    AND revoked_at IS NOT NULL
                    AND revoked_at >= granted_at)),
        CONSTRAINT handyman_quotation_approval_bindings_space_check
          CHECK ((space_id IS NULL AND space_authority_id IS NULL)
                 OR (space_id IS NOT NULL AND space_authority_id IS NOT NULL)),
        CONSTRAINT handyman_quotation_approval_bindings_self_check
          CHECK (supersedes_binding_id IS NULL
                 OR supersedes_binding_id <> id),
        -- thread anchor: (id, quotation_id) is what the supersedes self-FK and
        -- the decision ledger's approval_binding_id point at.
        CONSTRAINT handyman_quotation_approval_bindings_thread_anchor_unique
          UNIQUE (id, quotation_id),
        -- a supersede edge may only point inside the same thread
        CONSTRAINT handyman_quotation_approval_bindings_supersedes_fk
          FOREIGN KEY (supersedes_binding_id, quotation_id)
            REFERENCES handyman_quotation_approval_bindings (id, quotation_id),
        -- composite FK = the same cross-tenant isolation idiom as 0391/0395
        CONSTRAINT handyman_quotation_approval_bindings_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS
        handyman_quotation_approval_bindings_one_per_version
        ON handyman_quotation_approval_bindings (quotation_id, binding_version);
      -- exactly one live binding per thread (0432 / 0147 idiom)
      CREATE UNIQUE INDEX IF NOT EXISTS
        handyman_quotation_approval_bindings_one_active
        ON handyman_quotation_approval_bindings (quotation_id)
        WHERE status = 'ACTIVE';
      -- P1-B4 lesson (W03 PART 01): PIC -> bindings is read by the portal read,
      -- the revoke flow and MC1', so the index exists from birth.
      CREATE INDEX IF NOT EXISTS handyman_quotation_approval_bindings_pic_idx
        ON handyman_quotation_approval_bindings (tenant_pic_id, status);

      CREATE OR REPLACE FUNCTION handyman_quotation_approval_binding_guard()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $handyman_quotation_approval_binding_guard$
      DECLARE
        thread_request   UUID;
        req_client       UUID;
        req_tenant       UUID;
        req_building     UUID;
        req_space        UUID;
        req_pic          UUID;
        pic_tenant       UUID;
        pic_status       TEXT;
        pic_user         UUID;
        tenant_status    TEXT;
        tenant_client    UUID;
        client_status    TEXT;
        top_version      INTEGER;
        prev_status      TEXT;
        prev_version     INTEGER;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman quotation approval bindings are history: never deleted.'
            USING ERRCODE = '23514';
        END IF;

        IF TG_OP = 'UPDATE' THEN
          -- B18: any decision freezes the authorization context forever.
          IF EXISTS (
            SELECT 1 FROM handyman_quotation_decisions d
            WHERE d.quotation_id = OLD.quotation_id
          ) THEN
            RAISE EXCEPTION
              'Handyman quotation approval bindings freeze once the thread has a decision (B18).'
              USING ERRCODE = '23514';
          END IF;
          -- B14/B15: ACTIVE -> REVOKED is the only permitted mutation, and only
          -- as a whole: no snapshot, authority, or attribution column moves.
          IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED'
             OR (to_jsonb(NEW)
                   - 'status' - 'revoked_by_user_id' - 'revoked_at' - 'updated_at')
                IS DISTINCT FROM
                (to_jsonb(OLD)
                   - 'status' - 'revoked_by_user_id' - 'revoked_at' - 'updated_at')
          THEN
            RAISE EXCEPTION
              'Handyman quotation approval bindings allow only ACTIVE -> REVOKED.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        -- INSERT. B18 first: a decided thread is frozen, so no eligibility
        -- argument can be made about a binding that can no longer be written.
        IF EXISTS (
          SELECT 1 FROM handyman_quotation_decisions d
          WHERE d.quotation_id = NEW.quotation_id
        ) THEN
          RAISE EXCEPTION
            'Handyman quotation approval bindings freeze once the thread has a decision (B18).'
            USING ERRCODE = '23514';
        END IF;
        -- Snapshot columns are server-derived audit copies: each one is
        -- cross-checked against the request row, so a caller cannot smuggle a
        -- friendlier tenant/building/space alongside a real quotation id (B11).
        SELECT handyman_request_id INTO thread_request
          FROM handyman_quotations
          WHERE id = NEW.quotation_id;
        IF thread_request IS NULL OR thread_request <> NEW.handyman_request_id THEN
          RAISE EXCEPTION
            'A quotation approval binding must name its own thread and that thread''s request.'
            USING ERRCODE = '23514';
        END IF;

        SELECT client_id, tenant_company_id, building_id, space_id, tenant_pic_id
          INTO req_client, req_tenant, req_building, req_space, req_pic
          FROM handyman_service_requests
          WHERE id = NEW.handyman_request_id;
        IF req_client IS NULL THEN
          RAISE EXCEPTION
            'A quotation approval binding must reference an existing service request.'
            USING ERRCODE = '23514';
        END IF;
        IF req_client <> NEW.client_id
           OR req_tenant <> NEW.tenant_company_id
           OR req_building <> NEW.building_id
           OR req_space IS DISTINCT FROM NEW.space_id
        THEN
          RAISE EXCEPTION
            'A quotation approval binding snapshot must equal the request lineage it is bound on.'
            USING ERRCODE = '23514';
        END IF;

        -- R-1.2: an attested approver may never be swapped by a later binding.
        IF req_pic IS NOT NULL AND req_pic <> NEW.tenant_pic_id THEN
          RAISE EXCEPTION
            'A binding may not contradict the PIC already attested on the request (R-1.2).'
            USING ERRCODE = '23514';
        END IF;

        -- B1/B2 + MC0 (the granter may not bind themselves through a PIC link).
        SELECT tenant_company_id, status, user_id
          INTO pic_tenant, pic_status, pic_user
          FROM tenant_pics
          WHERE id = NEW.tenant_pic_id;
        IF pic_tenant IS NULL OR pic_status <> 'ACTIVE' THEN
          RAISE EXCEPTION
            'A quotation approval binding requires an ACTIVE Tenant PIC (B1).'
            USING ERRCODE = '23514';
        END IF;
        IF pic_tenant <> NEW.tenant_company_id THEN
          RAISE EXCEPTION
            'A quotation approval binding may only confer a PIC of the thread''s own tenant (B2).'
            USING ERRCODE = '23514';
        END IF;
        IF pic_user IS NOT NULL AND pic_user = NEW.granted_by_user_id THEN
          RAISE EXCEPTION
            'The user who confers a binding may not name a PIC linked to themselves (MC1).'
            USING ERRCODE = '23514';
        END IF;

        -- B5: tenant company and client must both be ACTIVE.
        SELECT status, client_id INTO tenant_status, tenant_client
          FROM tenant_companies
          WHERE id = NEW.tenant_company_id;
        SELECT status INTO client_status
          FROM clients
          WHERE id = NEW.client_id;
        IF tenant_status <> 'ACTIVE' OR client_status <> 'ACTIVE'
           OR tenant_client <> NEW.client_id
        THEN
          RAISE EXCEPTION
            'A quotation approval binding requires an ACTIVE tenant company and client (B5).'
            USING ERRCODE = '23514';
        END IF;

        -- B3: occupancy must be the live, effective context row for this
        -- tenant+building. Snapshotted as evidence, re-evaluated later (B16).
        IF NOT EXISTS (
          SELECT 1 FROM tenant_building_contexts tbc
          WHERE tbc.id = NEW.occupancy_authority_id
            AND tbc.tenant_company_id = NEW.tenant_company_id
            AND tbc.building_id = NEW.building_id
            AND tbc.status = 'ACTIVE'
            AND (tbc.effective_from IS NULL OR tbc.effective_from <= NEW.effective_from)
            AND (tbc.effective_until IS NULL OR tbc.effective_until >= NEW.effective_from)
        ) THEN
          RAISE EXCEPTION
            'A quotation approval binding requires current occupancy authority for the thread''s Building (B3).'
            USING ERRCODE = '23514';
        END IF;

        -- B4: a request that carries a space needs the matching space row.
        IF NEW.space_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM tenant_space_relationships tsr
          WHERE tsr.id = NEW.space_authority_id
            AND tsr.tenant_company_id = NEW.tenant_company_id
            AND tsr.building_id = NEW.building_id
            AND tsr.space_id = NEW.space_id
            AND tsr.status = 'ACTIVE'
            AND (tsr.effective_from IS NULL OR tsr.effective_from <= NEW.effective_from)
            AND (tsr.effective_until IS NULL OR tsr.effective_until >= NEW.effective_from)
        ) THEN
          RAISE EXCEPTION
            'A quotation approval binding on a spaced request requires current space authority (B4).'
            USING ERRCODE = '23514';
        END IF;

        -- Monotonic version + explicit supersede chain (B14: never an overwrite).
        SELECT max(binding_version) INTO top_version
          FROM handyman_quotation_approval_bindings
          WHERE quotation_id = NEW.quotation_id;
        IF NEW.binding_version <> COALESCE(top_version, 0) + 1 THEN
          RAISE EXCEPTION
            'A quotation approval binding version must be one greater than the thread''s highest (B14).'
            USING ERRCODE = '23514';
        END IF;
        IF top_version IS NULL THEN
          IF NEW.supersedes_binding_id IS NOT NULL THEN
            RAISE EXCEPTION
              'The first binding of a quotation thread supersedes nothing.'
              USING ERRCODE = '23514';
          END IF;
        ELSE
          IF NEW.supersedes_binding_id IS NULL THEN
            RAISE EXCEPTION
              'A re-binding must name the binding row it replaces (B14).'
              USING ERRCODE = '23514';
          END IF;
          SELECT status, binding_version INTO prev_status, prev_version
            FROM handyman_quotation_approval_bindings
            WHERE id = NEW.supersedes_binding_id;
          IF prev_status <> 'REVOKED'
             OR prev_version IS DISTINCT FROM NEW.binding_version - 1 THEN
            RAISE EXCEPTION
              'A re-binding supersedes exactly the thread''s highest binding, and only after it is revoked (B14/B15).'
              USING ERRCODE = '23514';
          END IF;
          -- B13 DB floor: never swap the entitled approver under a live
          -- presentation. B18 above already covers the decided case.
          IF EXISTS (
            SELECT 1 FROM handyman_quotation_versions v
            WHERE v.quotation_id = NEW.quotation_id
              AND v.status = 'ISSUED'
              AND NOT EXISTS (
                SELECT 1 FROM handyman_quotation_decisions d
                WHERE d.quotation_version_id = v.id
              )
          ) THEN
            RAISE EXCEPTION
              'A binding is pinned while a quotation version is presented (B13); revoke or supersede the presentation first.'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $handyman_quotation_approval_binding_guard$;

      DROP TRIGGER IF EXISTS handyman_quotation_approval_binding_guard
        ON handyman_quotation_approval_bindings;
      CREATE TRIGGER handyman_quotation_approval_binding_guard
        BEFORE INSERT OR UPDATE OR DELETE ON handyman_quotation_approval_bindings
        FOR EACH ROW
        EXECUTE FUNCTION handyman_quotation_approval_binding_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    // M3: a populated binding ledger is history and cannot be un-made. The
    // rollback path is therefore forward-fix-only once any row exists; the
    // decision-ledger half of M3 lives in 0438.down(), which runs first (LIFO)
    // and protects this table from being dropped under a referencing ledger.
    await client.query(`
      DO $handyman_quotation_approval_bindings_down$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_quotation_approval_bindings) THEN
          RAISE EXCEPTION
            'Rollback refused: handyman_quotation_approval_bindings is populated and is history (M3). Forward-fix only.'
            USING ERRCODE = '23514';
        END IF;
      END;
      $handyman_quotation_approval_bindings_down$;

      DROP TRIGGER IF EXISTS handyman_quotation_approval_binding_guard
        ON handyman_quotation_approval_bindings;
      DROP FUNCTION IF EXISTS handyman_quotation_approval_binding_guard();
      DROP TABLE IF EXISTS handyman_quotation_approval_bindings;
    `);
  },
};
