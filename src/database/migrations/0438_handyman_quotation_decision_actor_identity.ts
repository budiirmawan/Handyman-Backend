import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W03 PART 03B — actor-aware identity on the ONE quotation decision ledger.
 *
 * Contract: `docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md`
 * §6.1 (columns + CHECKs) and §6.2 (guard rewrite, R-1.1) as revised by
 * `CR-HM-06_ADDENDUM_A_*` §5 (R-1) and §7.1 (M2, M3, M6), ratified at `1cdaffe`.
 *
 * ZERO BACKFILL. `ADD COLUMN … NOT NULL DEFAULT 'USER'` is itself the backfill:
 * metadata-only on PostgreSQL >= 11, so every pre-existing row becomes an
 * explicit `USER`-class historical fact without a single UPDATE — which matters
 * because `handyman_quotation_decision_no_write` (0394) would refuse an
 * UPDATE-based backfill outright. Retroactive PIC attribution is forbidden:
 * historical rows are never reinterpreted as tenant consent (A8/A9).
 *
 * ONE LEDGER, NOT TWO (ratified decision 9). `tenant_pic_id` keeps meaning
 * "request lineage PIC", `decided_by_tenant_pic_id` means "who signed",
 * `approval_binding_id` means "under what authority". Three facts, three
 * columns, none repurposed; there is no parallel PIC decision table.
 *
 * THE GUARD MUST BE RE-CREATED, NOT JUST REPLACED. `0394`'s trigger is
 * `BEFORE UPDATE OR DELETE`, so an `INSERT` branch inside the function would
 * never fire (A01 §6.2). Per that section's own instruction the existing object
 * names are kept — trigger `handyman_quotation_decision_no_write` and function
 * `handyman_quotation_decision_block_mutation` (the §6.2 snippet sketches the
 * function as `…_decision_guard`; renaming it would orphan the 0394 object and
 * break anything that names it, so only the timing list grows). The
 * UPDATE/DELETE message is preserved verbatim because existing tests assert it,
 * and its SQLSTATE stays `P0001` for exactly the same reason; `ERRCODE '23514'`
 * is used only on the new INSERT rules (0427/0429/0430 convention).
 *
 * DEVIATION, RECORDED. A01 §6.1 also adds `decided_by_pic_session_id
 *   REFERENCES handyman_pic_workspace_sessions (id)`. That table does not exist
 * at this HEAD: it is created by the frozen session PART (A01 §13 "03B — session
 * foundation"), which this schema-only PART deliberately does not build (no new
 * PIC/session endpoints). Adding the column here would either reference a
 * missing table or invent an unconstrained UUID column — an unlinkable
 * "credential" column is worse than none, because it would look like provenance.
 * The two CHECKs below therefore carry the session clause's absence explicitly
 * (no `decided_by_pic_session_id` term), and the session PART must:
 *   1. `ADD COLUMN decided_by_pic_session_id UUID REFERENCES
 *      handyman_pic_workspace_sessions (id)`,
 *   2. DROP + re-create both CHECKs in their full §6.1 form (the TENANT_PIC
 *      branch gains `AND decided_by_pic_session_id IS NOT NULL`),
 *   3. add the session clause to this guard's INSERT branch.
 * Until then no `TENANT_PIC` decision row can be produced by any service, so the
 * deferral leaves no unattributable path open.
 *
 * PROSPECTIVE CONSEQUENCE (intended, not patched). The INSERT branch refuses
 * every non-`TENANT_PIC` row, so from this migration forward a staff user cannot
 * record a new quotation decision — including REJECT — through
 * `decideHandymanQuotation` (`handyman-quotation-decision.service.ts:189-262`).
 * The staff route is NOT removed by this PART and its replay path keeps working
 * (an already-recorded decision is read, not re-inserted, service:166-183). This
 * is the controlled standstill documented in
 * `docs/e2e/W03_PART03B_QUOTATION_PIC_APPROVAL_SCHEMA.md`; it is left standing on
 * purpose — no fallback, no bypass, no re-grant, and the error arrives as a raw
 * `23514` until 03C/03E give the refusal its proper `HANDYMAN_QUOTATION_
 * DECISION_CONFLICT`-class envelope.
 */
export const migration0438HandymanQuotationDecisionActorIdentity: Migration = {
  id: '0438_handyman_quotation_decision_actor_identity',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_quotation_decisions
        ADD COLUMN IF NOT EXISTS decision_actor_type TEXT NOT NULL DEFAULT 'USER',
        ADD COLUMN IF NOT EXISTS decided_by_tenant_pic_id UUID
          REFERENCES tenant_pics (id),
        ADD COLUMN IF NOT EXISTS approval_binding_id UUID
          REFERENCES handyman_quotation_approval_bindings (id),
        ALTER COLUMN decided_by_user_id DROP NOT NULL;
    `);
    await client.query(`
      DO $handyman_quotation_decisions_actor_checks$
      BEGIN
        -- Exactly-one actor identity, the 0431/0426/0427 disjunction idiom
        -- (PostgreSQL has no NUM_NONNULLS). Legacy rows satisfy the first
        -- disjunct as they stand, which is why no backfill is needed.
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'handyman_quotation_decisions'::regclass
            AND conname = 'handyman_quotation_decisions_actor_identity_check'
        ) THEN
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
        END IF;
        -- R-1.3: a PIC decision is never legal but unlinked to authority.
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'handyman_quotation_decisions'::regclass
            AND conname = 'handyman_quotation_decisions_binding_check'
        ) THEN
          ALTER TABLE handyman_quotation_decisions
            ADD CONSTRAINT handyman_quotation_decisions_binding_check
            CHECK (
              (decision_actor_type = 'USER'
                AND approval_binding_id IS NULL)
              OR (decision_actor_type = 'TENANT_PIC'
                AND approval_binding_id IS NOT NULL)
            );
        END IF;
      END;
      $handyman_quotation_decisions_actor_checks$;
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

      DROP TRIGGER IF EXISTS handyman_quotation_decision_no_write
        ON handyman_quotation_decisions;
      CREATE TRIGGER handyman_quotation_decision_no_write
        BEFORE INSERT OR UPDATE OR DELETE ON handyman_quotation_decisions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_quotation_decision_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    // M3 / forward-fix-only: once a non-legacy row exists, dropping these
    // columns would delete the only record of who consented and under what
    // authority. Unlike `0431.down()` (which drops columns without checking and
    // never restores NOT NULL), this down refuses — and only restores
    // `decided_by_user_id NOT NULL` while the ledger is provably all-legacy, so
    // no historical row is touched either way.
    await client.query(`
      DO $handyman_quotation_decisions_actor_down$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM handyman_quotation_decisions
          WHERE decision_actor_type <> 'USER'
             OR approval_binding_id IS NOT NULL
             OR decided_by_tenant_pic_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'Rollback refused: handyman_quotation_decisions carries PIC-attributed or binding-linked rows (M3). Forward-fix only.'
            USING ERRCODE = '23514';
        END IF;
      END;
      $handyman_quotation_decisions_actor_down$;
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_quotation_decision_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman quotation decisions are immutable authoritative facts.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS handyman_quotation_decision_no_write
        ON handyman_quotation_decisions;
      CREATE TRIGGER handyman_quotation_decision_no_write
        BEFORE UPDATE OR DELETE ON handyman_quotation_decisions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_quotation_decision_block_mutation();
    `);
    await client.query(`
      ALTER TABLE handyman_quotation_decisions
        ALTER COLUMN decided_by_user_id SET NOT NULL,
        DROP CONSTRAINT IF EXISTS handyman_quotation_decisions_binding_check,
        DROP CONSTRAINT IF EXISTS handyman_quotation_decisions_actor_identity_check,
        DROP COLUMN IF EXISTS approval_binding_id,
        DROP COLUMN IF EXISTS decided_by_tenant_pic_id,
        DROP COLUMN IF EXISTS decision_actor_type;
    `);
  },
};
