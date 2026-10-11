import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W03 PART 03C — closes the ONE deferral `0438`/`0439` left open (deviation D1
 * of `docs/e2e/W03_PART03B_QUOTATION_PIC_APPROVAL_SCHEMA.md`): the ledger
 * columns that bind a decision to the credential that carried it.
 *
 * A01 §6.1/§7.1 specify these columns; they could not land in 0438 because
 * `handyman_pic_workspace_sessions` did not exist yet, and an unconstrained
 * UUID "credential" column would look like provenance while proving nothing.
 * `0441` created the table, so the real FK can.
 *
 * Exactly the three obligations D1 recorded:
 *   1. `ADD COLUMN … REFERENCES handyman_pic_workspace_sessions (id)`;
 *   2. DROP + re-create the actor-identity CHECKs in their full §6.1/§7.1 form
 *      (the `TENANT_PIC` branch gains `…_pic_session_id IS NOT NULL`);
 *   3. add the session clause to the decision guard's INSERT branch.
 *
 * NOT in this migration, by design:
 * - `handyman_quotation_decisions_binding_check` is left alone — §6.1's binding
 *   CHECK carries no session term, so re-creating it would be churn on an
 *   immutable-table constraint.
 * - no scope-side INSERT guard clause: E1–E3 eligibility is `03F`'s ratified
 *   row, and §7.1 asks only for the CHECK here.
 * - no service behavior at all: no decision path exists for a PIC principal
 *   until `03E`, so no row in either table can change shape as a side effect
 *   of this PART. `up` contains no UPDATE (R2), which also means it cannot
 *   trip the ledger's own `no_write` triggers; the guard is re-created, not
 *   replaced by a new object name (0438's naming decision stands).
 *
 * Every historical row satisfies both re-created CHECKs as it stands (all have
 * a non-null user id and NULL session id), so `ADD CONSTRAINT` validation
 * cannot fail — and if one did, the whole migration rolls back (R5), leaving no
 * partial schema. `down()` refuses once any non-legacy row exists (R3/M3),
 * restores the pre-0442 CHECK and function text verbatim, and never touches a
 * row.
 */
export const migration0442HandymanQuotationPicSessionLedgerLink: Migration = {
  id: '0442_handyman_quotation_pic_session_ledger_link',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_quotation_decisions
        ADD COLUMN IF NOT EXISTS decided_by_pic_session_id UUID
          REFERENCES handyman_pic_workspace_sessions (id);
    `);
    await client.query(`
      DO $handyman_quotation_decisions_session_check$
      BEGIN
        -- §6.1 full form. Re-created rather than added: the 0438 version is
        -- the same rule minus the session term, and a second overlapping CHECK
        -- would leave two authorities for one fact.
        ALTER TABLE handyman_quotation_decisions
          DROP CONSTRAINT IF EXISTS handyman_quotation_decisions_actor_identity_check;
        ALTER TABLE handyman_quotation_decisions
          ADD CONSTRAINT handyman_quotation_decisions_actor_identity_check
          CHECK (
            (decision_actor_type = 'USER'
              AND decided_by_user_id IS NOT NULL
              AND decided_by_tenant_pic_id IS NULL
              AND decided_by_pic_session_id IS NULL)
            OR (decision_actor_type = 'TENANT_PIC'
              AND decided_by_user_id IS NULL
              AND decided_by_tenant_pic_id IS NOT NULL
              AND decided_by_pic_session_id IS NOT NULL)
          );
      END;
      $handyman_quotation_decisions_session_check$;
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_quotation_decision_block_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $handyman_quotation_decision_block_mutation$
      DECLARE
        binding_pic      UUID;
        binding_thread   UUID;
        binding_tenant   UUID;
        binding_granter  UUID;
        request_row      UUID;
        req_building     UUID;
        req_tenant       UUID;
        req_client       UUID;
        req_pic          UUID;
        thread_client    UUID;
        version_row      UUID;
        version_creator  UUID;
        root_creator     UUID;
        pic_tenant       UUID;
        pic_status       TEXT;
        pic_user         UUID;
        session_pic      UUID;
        session_tenant   UUID;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          -- Prospective-only staff ban (A5 + decision 7). Historical USER rows
          -- are untouched; only new writes are governed, which is what makes
          -- this prospective-only structurally rather than by policy.
          IF NEW.decision_actor_type <> 'TENANT_PIC' THEN
            RAISE EXCEPTION
              'Only an attested Tenant PIC may decide a Handyman quotation.'
              USING ERRCODE = '23514';
          END IF;
          -- R-1.1 + B16: the approver must be exactly the PIC the referenced
          -- binding confers, and that binding must be live at this instant —
          -- a revoked or expired binding never authorizes anything.
          SELECT b.tenant_pic_id, b.quotation_id, b.tenant_company_id,
                 b.granted_by_user_id
            INTO binding_pic, binding_thread, binding_tenant, binding_granter
            FROM handyman_quotation_approval_bindings b
            WHERE b.id = NEW.approval_binding_id
              AND b.status = 'ACTIVE'
              AND b.effective_from <= NEW.decided_at
              AND (b.effective_until IS NULL OR b.effective_until > NEW.decided_at);
          IF binding_pic IS NOT NULL
             AND binding_thread IS DISTINCT FROM NEW.quotation_id THEN
            RAISE EXCEPTION
              'A PIC decision may not borrow a binding from another quotation thread.'
              USING ERRCODE = '23514';
          END IF;
          IF binding_pic IS NULL OR binding_pic <> NEW.decided_by_tenant_pic_id THEN
            RAISE EXCEPTION
              'A PIC decision must name the PIC its approval binding confers.'
              USING ERRCODE = '23514';
          END IF;
          -- liveness and tenant membership are not inferable from a snapshot
          SELECT p.tenant_company_id, p.status, p.user_id
            INTO pic_tenant, pic_status, pic_user
            FROM tenant_pics p
            WHERE p.id = NEW.decided_by_tenant_pic_id;
          IF pic_tenant IS NULL OR pic_tenant <> NEW.tenant_company_id
             OR pic_status <> 'ACTIVE' THEN
            RAISE EXCEPTION
              'The deciding Tenant PIC must be ACTIVE and belong to the attributed tenant.'
              USING ERRCODE = '23514';
          END IF;
          IF binding_tenant <> NEW.tenant_company_id THEN
            RAISE EXCEPTION
              'The approval binding and the decision must attribute the same tenant.'
              USING ERRCODE = '23514';
          END IF;

          -- ledger coherence against the authoritative lineage (no second
          -- source of truth: request + quotation + version are read, never set)
          SELECT v.quotation_id INTO version_row
            FROM handyman_quotation_versions v
            WHERE v.id = NEW.quotation_version_id;
          SELECT q.handyman_request_id, q.client_id INTO request_row, thread_client
            FROM handyman_quotations q
            WHERE q.id = NEW.quotation_id;
          SELECT r.building_id, r.tenant_company_id, r.client_id, r.tenant_pic_id
            INTO req_building, req_tenant, req_client, req_pic
            FROM handyman_service_requests r
            WHERE r.id = request_row;
          IF version_row IS DISTINCT FROM NEW.quotation_id
             OR request_row IS NULL OR req_client IS DISTINCT FROM NEW.client_id
             OR thread_client IS DISTINCT FROM NEW.client_id
          THEN
            RAISE EXCEPTION
              'A PIC decision must bind this thread''s own version and lineage client.'
              USING ERRCODE = '23514';
          END IF;
          IF req_tenant <> NEW.tenant_company_id THEN
            RAISE EXCEPTION
              'A PIC decision must attribute the tenant its request belongs to.'
              USING ERRCODE = '23514';
          END IF;
          IF NEW.tenant_pic_id IS NOT NULL
             AND NEW.tenant_pic_id IS DISTINCT FROM NEW.decided_by_tenant_pic_id THEN
            RAISE EXCEPTION
              'tenant_pic_id keeps its lineage meaning: it may not disagree with the signing PIC.'
              USING ERRCODE = '23514';
          END IF;
          IF req_pic IS NOT NULL
             AND req_pic IS DISTINCT FROM NEW.decided_by_tenant_pic_id THEN
            RAISE EXCEPTION
              'A decision may not replace the PIC attested on the request (R-1.2).'
              USING ERRCODE = '23514';
          END IF;
          -- B3 re-evaluated live at decision time (B16, fail-closed MC4'): a
          -- decision cannot land on a thread whose occupancy authority lapsed.
          IF NOT EXISTS (
            SELECT 1 FROM tenant_building_contexts tbc
            WHERE tbc.tenant_company_id = NEW.tenant_company_id
              AND tbc.building_id = req_building
              AND tbc.status = 'ACTIVE'
              AND (tbc.effective_from IS NULL OR tbc.effective_from <= NEW.decided_at)
              AND (tbc.effective_until IS NULL OR tbc.effective_until >= NEW.decided_at)
          ) THEN
            RAISE EXCEPTION
              'A PIC decision requires current occupancy authority for the thread''s Building (B16).'
              USING ERRCODE = '23514';
          END IF;
          -- MC1': M = root author + version author + the user who chose the
          -- signer; C = the signing PIC and its linked user. pic_user may be
          -- NULL, which is the legitimate unlinked-PIC state (decision 2), not
          -- a licence to skip the check. The two id namespaces are never
          -- compared to each other directly (the 0431 rule): M and C meet only
          -- through tenant_pics.user_id.
          SELECT created_by_user_id INTO version_creator
            FROM handyman_quotation_versions
            WHERE id = NEW.quotation_version_id;
          SELECT created_by_user_id INTO root_creator
            FROM handyman_quotations
            WHERE id = NEW.quotation_id;
          IF pic_user IS NOT NULL
             AND (pic_user = version_creator OR pic_user = root_creator
                  OR pic_user = binding_granter) THEN
            RAISE EXCEPTION
              'A Tenant PIC linked to the authoring or binding user may not self-approve.'
              USING ERRCODE = '23514';
          END IF;
          -- 0442 (D1 closure, A01 §6.1) is the LAST gate of the PIC branch:
          -- every pre-existing 0437/0438 refusal keeps its precedence, and
          -- the credential is consulted only once the row is otherwise
          -- coherent. The decision must be traceable to the exact session
          -- that admitted its signer, and that session must be THAT PIC's own
          -- for THAT tenant; a read-capable admission (rule 3: no tenant_pic_id)
          -- is structurally unable to underwrite a decision. Liveness
          -- (expiry/revocation) is deliberately NOT re-evaluated here: this
          -- ledger is immutable history, and a revocation landing after a
          -- decision must not retroactively falsify who was authorized at the
          -- time — rule 17 puts liveness on every call, in the service path.
          SELECT s.tenant_pic_id, s.tenant_company_id
            INTO session_pic, session_tenant
            FROM handyman_pic_workspace_sessions s
            WHERE s.id = NEW.decided_by_pic_session_id;
          IF NEW.decided_by_pic_session_id IS NULL THEN
            RAISE EXCEPTION
              'A PIC decision must name the PIC session that admitted the signer.'
              USING ERRCODE = '23514';
          END IF;
          IF session_pic IS NULL
             OR session_pic IS DISTINCT FROM NEW.decided_by_tenant_pic_id
             OR session_tenant IS DISTINCT FROM NEW.tenant_company_id THEN
            RAISE EXCEPTION
              'A PIC decision must be carried by that PIC''s own session for this tenant.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman quotation decisions are immutable authoritative facts.';
      END;
            $handyman_quotation_decision_block_mutation$;
    `);
    await client.query(`
      ALTER TABLE handyman_execution_scopes
        ADD COLUMN IF NOT EXISTS created_by_pic_session_id UUID
          REFERENCES handyman_pic_workspace_sessions (id);
    `);
    await client.query(`
      DO $handyman_execution_scopes_session_check$
      BEGIN
        ALTER TABLE handyman_execution_scopes
          DROP CONSTRAINT IF EXISTS handyman_execution_scopes_actor_identity_check;
        ALTER TABLE handyman_execution_scopes
          ADD CONSTRAINT handyman_execution_scopes_actor_identity_check
          CHECK (
            (created_by_actor_type = 'USER'
              AND created_by_user_id IS NOT NULL
              AND created_by_tenant_pic_id IS NULL
              AND created_by_pic_session_id IS NULL)
            OR (created_by_actor_type = 'TENANT_PIC'
              AND created_by_user_id IS NULL
              AND created_by_tenant_pic_id IS NOT NULL
              AND created_by_pic_session_id IS NOT NULL)
          );
      END;
      $handyman_execution_scopes_session_check$;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $handyman_quotation_pic_session_down$
      BEGIN
        -- Same M3 refusal as 0438/0439, widened to the columns this migration
        -- owns: a session-linked decision or scope is history and dropping the
        -- pointer would orphan it.
        IF EXISTS (
          SELECT 1 FROM handyman_quotation_decisions
          WHERE decision_actor_type <> 'USER'
             OR approval_binding_id IS NOT NULL
             OR decided_by_tenant_pic_id IS NOT NULL
             OR decided_by_pic_session_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'Rollback refused: handyman_quotation_decisions carries PIC-attributed or session-linked rows (M3). Forward-fix only.'
            USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM handyman_execution_scopes
          WHERE created_by_actor_type <> 'USER'
             OR created_by_tenant_pic_id IS NOT NULL
             OR created_by_pic_session_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'Rollback refused: handyman_execution_scopes carries PIC-attributed or session-linked rows (M3). Forward-fix only.'
            USING ERRCODE = '23514';
        END IF;
      END;
      $handyman_quotation_pic_session_down$;
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_quotation_decision_block_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $handyman_quotation_decision_block_mutation$
      DECLARE
        binding_pic      UUID;
        binding_thread   UUID;
        binding_tenant   UUID;
        binding_granter  UUID;
        request_row      UUID;
        req_building     UUID;
        req_tenant       UUID;
        req_client       UUID;
        req_pic          UUID;
        thread_client    UUID;
        version_row      UUID;
        version_creator  UUID;
        root_creator     UUID;
        pic_tenant       UUID;
        pic_status       TEXT;
        pic_user         UUID;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          -- Prospective-only staff ban (A5 + decision 7). Historical USER rows
          -- are untouched; only new writes are governed, which is what makes
          -- this prospective-only structurally rather than by policy.
          IF NEW.decision_actor_type <> 'TENANT_PIC' THEN
            RAISE EXCEPTION
              'Only an attested Tenant PIC may decide a Handyman quotation.'
              USING ERRCODE = '23514';
          END IF;
          -- R-1.1 + B16: the approver must be exactly the PIC the referenced
          -- binding confers, and that binding must be live at this instant —
          -- a revoked or expired binding never authorizes anything.
          SELECT b.tenant_pic_id, b.quotation_id, b.tenant_company_id,
                 b.granted_by_user_id
            INTO binding_pic, binding_thread, binding_tenant, binding_granter
            FROM handyman_quotation_approval_bindings b
            WHERE b.id = NEW.approval_binding_id
              AND b.status = 'ACTIVE'
              AND b.effective_from <= NEW.decided_at
              AND (b.effective_until IS NULL OR b.effective_until > NEW.decided_at);
          IF binding_pic IS NOT NULL
             AND binding_thread IS DISTINCT FROM NEW.quotation_id THEN
            RAISE EXCEPTION
              'A PIC decision may not borrow a binding from another quotation thread.'
              USING ERRCODE = '23514';
          END IF;
          IF binding_pic IS NULL OR binding_pic <> NEW.decided_by_tenant_pic_id THEN
            RAISE EXCEPTION
              'A PIC decision must name the PIC its approval binding confers.'
              USING ERRCODE = '23514';
          END IF;
          -- liveness and tenant membership are not inferable from a snapshot
          SELECT p.tenant_company_id, p.status, p.user_id
            INTO pic_tenant, pic_status, pic_user
            FROM tenant_pics p
            WHERE p.id = NEW.decided_by_tenant_pic_id;
          IF pic_tenant IS NULL OR pic_tenant <> NEW.tenant_company_id
             OR pic_status <> 'ACTIVE' THEN
            RAISE EXCEPTION
              'The deciding Tenant PIC must be ACTIVE and belong to the attributed tenant.'
              USING ERRCODE = '23514';
          END IF;
          IF binding_tenant <> NEW.tenant_company_id THEN
            RAISE EXCEPTION
              'The approval binding and the decision must attribute the same tenant.'
              USING ERRCODE = '23514';
          END IF;
          -- ledger coherence against the authoritative lineage (no second
          -- source of truth: request + quotation + version are read, never set)
          SELECT v.quotation_id INTO version_row
            FROM handyman_quotation_versions v
            WHERE v.id = NEW.quotation_version_id;
          SELECT q.handyman_request_id, q.client_id INTO request_row, thread_client
            FROM handyman_quotations q
            WHERE q.id = NEW.quotation_id;
          SELECT r.building_id, r.tenant_company_id, r.client_id, r.tenant_pic_id
            INTO req_building, req_tenant, req_client, req_pic
            FROM handyman_service_requests r
            WHERE r.id = request_row;
          IF version_row IS DISTINCT FROM NEW.quotation_id
             OR request_row IS NULL OR req_client IS DISTINCT FROM NEW.client_id
             OR thread_client IS DISTINCT FROM NEW.client_id
          THEN
            RAISE EXCEPTION
              'A PIC decision must bind this thread''s own version and lineage client.'
              USING ERRCODE = '23514';
          END IF;
          IF req_tenant <> NEW.tenant_company_id THEN
            RAISE EXCEPTION
              'A PIC decision must attribute the tenant its request belongs to.'
              USING ERRCODE = '23514';
          END IF;
          IF NEW.tenant_pic_id IS NOT NULL
             AND NEW.tenant_pic_id IS DISTINCT FROM NEW.decided_by_tenant_pic_id THEN
            RAISE EXCEPTION
              'tenant_pic_id keeps its lineage meaning: it may not disagree with the signing PIC.'
              USING ERRCODE = '23514';
          END IF;
          IF req_pic IS NOT NULL
             AND req_pic IS DISTINCT FROM NEW.decided_by_tenant_pic_id THEN
            RAISE EXCEPTION
              'A decision may not replace the PIC attested on the request (R-1.2).'
              USING ERRCODE = '23514';
          END IF;
          -- B3 re-evaluated live at decision time (B16, fail-closed MC4'): a
          -- decision cannot land on a thread whose occupancy authority lapsed.
          IF NOT EXISTS (
            SELECT 1 FROM tenant_building_contexts tbc
            WHERE tbc.tenant_company_id = NEW.tenant_company_id
              AND tbc.building_id = req_building
              AND tbc.status = 'ACTIVE'
              AND (tbc.effective_from IS NULL OR tbc.effective_from <= NEW.decided_at)
              AND (tbc.effective_until IS NULL OR tbc.effective_until >= NEW.decided_at)
          ) THEN
            RAISE EXCEPTION
              'A PIC decision requires current occupancy authority for the thread''s Building (B16).'
              USING ERRCODE = '23514';
          END IF;
          -- MC1': M = root author + version author + the user who chose the
          -- signer; C = the signing PIC and its linked user. pic_user may be
          -- NULL, which is the legitimate unlinked-PIC state (decision 2), not
          -- a licence to skip the check. The two id namespaces are never
          -- compared to each other directly (the 0431 rule): M and C meet only
          -- through tenant_pics.user_id.
          SELECT created_by_user_id INTO version_creator
            FROM handyman_quotation_versions
            WHERE id = NEW.quotation_version_id;
          SELECT created_by_user_id INTO root_creator
            FROM handyman_quotations
            WHERE id = NEW.quotation_id;
          IF pic_user IS NOT NULL
             AND (pic_user = version_creator OR pic_user = root_creator
                  OR pic_user = binding_granter) THEN
            RAISE EXCEPTION
              'A Tenant PIC linked to the authoring or binding user may not self-approve.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman quotation decisions are immutable authoritative facts.';
      END;
            $handyman_quotation_decision_block_mutation$;
    `);
    await client.query(`
      DO $handyman_quotation_pic_session_down_checks$
      BEGIN
        ALTER TABLE handyman_execution_scopes
          DROP CONSTRAINT IF EXISTS handyman_execution_scopes_actor_identity_check;
        ALTER TABLE handyman_execution_scopes
          ADD CONSTRAINT handyman_execution_scopes_actor_identity_check
          CHECK (
            (created_by_actor_type = 'USER'
              AND created_by_user_id IS NOT NULL
              AND created_by_tenant_pic_id IS NULL)
            OR (created_by_actor_type = 'TENANT_PIC'
              AND created_by_user_id IS NULL
              AND created_by_tenant_pic_id IS NOT NULL)
          );
        ALTER TABLE handyman_quotation_decisions
          DROP CONSTRAINT IF EXISTS handyman_quotation_decisions_actor_identity_check;
        ALTER TABLE handyman_quotation_decisions
          ADD CONSTRAINT handyman_quotation_decisions_actor_identity_check
          CHECK (
            (decision_actor_type = 'USER'
              AND decided_by_user_id IS NOT NULL
              AND decided_by_tenant_pic_id IS NULL)
            OR (decision_actor_type = 'TENANT_PIC'
              AND decided_by_user_id IS NULL
              AND decided_by_tenant_pic_id IS NOT NULL)
          );
      END;
      $handyman_quotation_pic_session_down_checks$;
    `);
    await client.query(`
      ALTER TABLE handyman_execution_scopes
        DROP COLUMN IF EXISTS created_by_pic_session_id;
      ALTER TABLE handyman_quotation_decisions
        DROP COLUMN IF EXISTS decided_by_pic_session_id;
    `);
  },
};
