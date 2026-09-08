import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-FX-01 PART 01 — canonical FX Rate Authority and Client FX Policy.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §3, §4, §6, §14.1, §16.
 *
 * CANONICAL CONVENTION (FROZEN — §3)
 *   1 BASE = RATE x QUOTE
 * `rate` is the number of QUOTE units equal to ONE unit of BASE.
 *   base=USD, quote=IDR, rate=16500  ->  1 USD = 16 500 IDR
 * Multiplication is the only conversion primitive. Division exists only on the
 * governed INVERSE path, which PART 01 does not implement.
 *
 * SCOPE — schema and invariants ONLY. This migration deliberately creates no
 * converted-amount storage, no conversion ledger (`0334` is NOT consumed), no
 * provider ingestion, and touches NO existing table:
 *   - no backfill, no monetary-table rewrite, no historical currency rewrite;
 *   - every persisted transaction currency snapshot stays exactly as CUR-01/02
 *     left it, and a NULL (UNKNOWN) currency stays UNKNOWN and non-convertible.
 *
 * Three platform-global / Client-scoped authorities:
 *   1. `fx_rates`          — platform-global rate authority (no client_id: a
 *                            market rate is not a Client opinion, §2/D-2).
 *   2. `fx_rate_events`    — append-only rate audit ledger. Required because
 *                            `operational_events.client_id` is NOT NULL (0080),
 *                            so a platform-global rate has no owning Client and
 *                            cannot be audited there. `operational_events` is
 *                            NOT weakened to make room for it.
 *   3. `client_fx_policies`— Client-scoped FX governance (fail closed).
 */
export const migration0333CreateFxRateAuthorityAndClientFxPolicy: Migration = {
  id: '0333_create_fx_rate_authority_and_client_fx_policy',

  async up(client: PoolClient): Promise<void> {
    // ---------------------------------------------------------------------
    // 1. fx_rates — the canonical, platform-global rate authority.
    // ---------------------------------------------------------------------
    await client.query(`
      CREATE TABLE fx_rates (
        id                      UUID PRIMARY KEY,

        -- Currency legs reference the EXISTING Currency Master (0331). The
        -- master is never duplicated: identity, numeric code and decimal
        -- precision stay the master's business, not FX's.
        base_currency_code      VARCHAR(3) NOT NULL REFERENCES currencies (code),
        quote_currency_code     VARCHAR(3) NOT NULL REFERENCES currencies (code),

        -- FX-01 supports exactly ONE rate type (§5). The column is real, NOT
        -- NULL and CHECK-constrained so a future CR that proves a distinct
        -- selection purpose widens the CHECK additively — no re-keying, no
        -- redefinition of existing rows.
        rate_type               TEXT NOT NULL DEFAULT 'REFERENCE',

        -- A rate is a RATIO, not a monetary amount, so the repository's
        -- NUMERIC(18,2) monetary convention deliberately does not apply.
        -- 12 integer digits cover any historically real rate; 12 decimals keep
        -- a directly-published small rate meaningful.
        rate                    NUMERIC(24, 12) NOT NULL,

        -- Effective window is CLOSED-OPEN: [effective_from, effective_to).
        -- NULL effective_to = currently open.
        effective_from          TIMESTAMPTZ NOT NULL,
        effective_to            TIMESTAMPTZ,

        status                  TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',

        -- Provider seam (§13). FX-01 ships MANUAL_TREASURY only; a provider
        -- may PROPOSE (PENDING_APPROVAL) but may never ACTIVATE.
        source                  TEXT NOT NULL,
        source_reference        TEXT,
        ingested_at             TIMESTAMPTZ,

        -- Correction lineage. A correction is a NEW row, never an in-place edit.
        supersedes_rate_id      UUID REFERENCES fx_rates (id),
        superseded_by_rate_id   UUID REFERENCES fx_rates (id),

        -- Maker.
        created_by_user_id      UUID NOT NULL REFERENCES users (id),

        -- Checker + governance-action attribution.
        approved_by_user_id     UUID REFERENCES users (id),
        approved_at             TIMESTAMPTZ,
        rejected_by_user_id     UUID REFERENCES users (id),
        rejected_at             TIMESTAMPTZ,
        rejected_reason         TEXT,
        superseded_by_user_id   UUID REFERENCES users (id),
        superseded_at           TIMESTAMPTZ,
        deactivated_by_user_id  UUID REFERENCES users (id),
        deactivated_at          TIMESTAMPTZ,
        deactivation_reason     TEXT,

        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- ---- frozen-model invariants -------------------------------------
        CONSTRAINT fx_rates_rate_type_check CHECK (
          rate_type IN ('REFERENCE')
        ),
        CONSTRAINT fx_rates_rate_positive_check CHECK (rate > 0),
        CONSTRAINT fx_rates_pair_distinct_check CHECK (
          base_currency_code <> quote_currency_code
        ),
        CONSTRAINT fx_rates_window_order_check CHECK (
          effective_to IS NULL OR effective_to > effective_from
        ),
        CONSTRAINT fx_rates_status_check CHECK (
          status IN (
            'PENDING_APPROVAL',
            'ACTIVE',
            'REJECTED',
            'SUPERSEDED',
            'INACTIVE'
          )
        ),
        CONSTRAINT fx_rates_source_check CHECK (
          source IN ('MANUAL_TREASURY')
        ),
        CONSTRAINT fx_rates_source_reference_check CHECK (
          source_reference IS NULL
          OR (
            length(source_reference) BETWEEN 1 AND 200
            AND source_reference !~ '[\\r\\n]'
          )
        ),

        -- ---- maker-checker (§15): the approver is never the maker ---------
        CONSTRAINT fx_rates_maker_checker_check CHECK (
          approved_by_user_id IS NULL
          OR approved_by_user_id <> created_by_user_id
        ),

        -- ---- lifecycle shape: metadata is present exactly when required ---
        CONSTRAINT fx_rates_approval_shape_check CHECK (
          (approved_by_user_id IS NULL AND approved_at IS NULL)
          OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
        ),
        CONSTRAINT fx_rates_rejection_shape_check CHECK (
          (rejected_by_user_id IS NULL AND rejected_at IS NULL)
          OR (rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL)
        ),
        CONSTRAINT fx_rates_supersession_shape_check CHECK (
          (superseded_by_user_id IS NULL AND superseded_at IS NULL)
          OR (superseded_by_user_id IS NOT NULL AND superseded_at IS NOT NULL)
        ),
        CONSTRAINT fx_rates_deactivation_shape_check CHECK (
          (deactivated_by_user_id IS NULL AND deactivated_at IS NULL)
          OR (deactivated_by_user_id IS NOT NULL AND deactivated_at IS NOT NULL)
        ),

        -- ---- status <-> governance metadata coherence --------------------
        CONSTRAINT fx_rates_active_requires_approval_check CHECK (
          status <> 'ACTIVE'
          OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
        ),
        CONSTRAINT fx_rates_rejected_requires_rejection_check CHECK (
          status <> 'REJECTED'
          OR (rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL)
        ),
        CONSTRAINT fx_rates_superseded_requires_lineage_check CHECK (
          status <> 'SUPERSEDED'
          OR (
            superseded_by_user_id IS NOT NULL
            AND superseded_at IS NOT NULL
            AND superseded_by_rate_id IS NOT NULL
          )
        ),
        CONSTRAINT fx_rates_inactive_requires_deactivation_check CHECK (
          status <> 'INACTIVE'
          OR (deactivated_by_user_id IS NOT NULL AND deactivated_at IS NOT NULL)
        ),

        -- A pending rate carries no governance outcome yet.
        CONSTRAINT fx_rates_pending_is_ungoverned_check CHECK (
          status <> 'PENDING_APPROVAL'
          OR (
            approved_by_user_id IS NULL
            AND rejected_by_user_id IS NULL
            AND superseded_by_user_id IS NULL
            AND superseded_by_rate_id IS NULL
            AND deactivated_by_user_id IS NULL
          )
        ),

        -- A row can never be its own predecessor or successor.
        CONSTRAINT fx_rates_no_self_lineage_check CHECK (
          (supersedes_rate_id IS NULL OR supersedes_rate_id <> id)
          AND (superseded_by_rate_id IS NULL OR superseded_by_rate_id <> id)
        )
      );
    `);

    // A rate may be superseded at most once, so a replayed or concurrent
    // correction cannot fork history (same intent as
    // price_catalog_entries_successor_unique, 0319).
    await client.query(`
      CREATE UNIQUE INDEX fx_rates_supersedes_unique
        ON fx_rates (supersedes_rate_id)
        WHERE supersedes_rate_id IS NOT NULL;
      CREATE UNIQUE INDEX fx_rates_superseded_by_unique
        ON fx_rates (superseded_by_rate_id)
        WHERE superseded_by_rate_id IS NOT NULL;
    `);

    // Structurally impossible ambiguity (§4 guard 1): at most one ACTIVE rate
    // per (base, quote, rate_type) may cover any instant. Reuses the proven
    // 0278 btree_gist + EXCLUDE USING gist pattern verbatim.
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await client.query(`
      ALTER TABLE fx_rates
        ADD CONSTRAINT fx_rates_active_window_exclusion
        EXCLUDE USING gist (
          base_currency_code WITH =,
          quote_currency_code WITH =,
          rate_type WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
        WHERE (status = 'ACTIVE')
    `);

    // Resolution index for the PART 03 selection query (§4 guard 3), mirroring
    // utility_tariffs_resolution_idx.
    await client.query(`
      CREATE INDEX fx_rates_resolution_idx
        ON fx_rates
          (base_currency_code, quote_currency_code, rate_type, effective_from DESC)
        WHERE status = 'ACTIVE';
      CREATE INDEX fx_rates_status_created_idx
        ON fx_rates (status, created_at DESC, id DESC);
      CREATE INDEX fx_rates_source_idx
        ON fx_rates (source, effective_from DESC);
    `);

    // Business-column immutability + frozen lifecycle transitions (§4 guard 2,
    // §5). Same mechanism as prevent_currency_code_change() (0331). Corrections
    // happen by SUPERSESSION, never by rewriting a rate.
    await client.query(`
      CREATE OR REPLACE FUNCTION fx_rates_enforce_immutability()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fx_rates_immutability$
      BEGIN
        -- (a) Authoritative business fields are frozen for the row's life.
        IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.base_currency_code IS DISTINCT FROM OLD.base_currency_code
          OR NEW.quote_currency_code IS DISTINCT FROM OLD.quote_currency_code
          OR NEW.rate IS DISTINCT FROM OLD.rate
          OR NEW.rate_type IS DISTINCT FROM OLD.rate_type
          OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
          OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
          OR NEW.source IS DISTINCT FROM OLD.source
          OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
          OR NEW.ingested_at IS DISTINCT FROM OLD.ingested_at
          OR NEW.supersedes_rate_id IS DISTINCT FROM OLD.supersedes_rate_id
          OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION 'FX rate business fields are immutable; correct a rate by supersession.'
            USING ERRCODE = '23514';
        END IF;

        -- (b) Frozen lifecycle: PENDING_APPROVAL -> ACTIVE|REJECTED;
        --     ACTIVE -> SUPERSEDED|INACTIVE; REJECTED/SUPERSEDED/INACTIVE terminal.
        IF OLD.status = 'PENDING_APPROVAL'
          AND NEW.status NOT IN ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED')
        THEN
          RAISE EXCEPTION 'Invalid FX rate lifecycle transition from PENDING_APPROVAL.'
            USING ERRCODE = '23514';
        ELSIF OLD.status = 'ACTIVE'
          AND NEW.status NOT IN ('ACTIVE', 'SUPERSEDED', 'INACTIVE')
        THEN
          RAISE EXCEPTION 'Invalid FX rate lifecycle transition from ACTIVE.'
            USING ERRCODE = '23514';
        ELSIF OLD.status IN ('REJECTED', 'SUPERSEDED', 'INACTIVE')
          AND NEW.status <> OLD.status
        THEN
          RAISE EXCEPTION 'FX rate status % is terminal.', OLD.status
            USING ERRCODE = '23514';
        END IF;

        -- (c) A recorded governance outcome can never be re-attributed.
        IF OLD.approved_by_user_id IS NOT NULL
          AND (
            NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
            OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
          )
        THEN
          RAISE EXCEPTION 'FX rate approval attribution is immutable.'
            USING ERRCODE = '23514';
        END IF;
        IF OLD.rejected_by_user_id IS NOT NULL
          AND (
            NEW.rejected_by_user_id IS DISTINCT FROM OLD.rejected_by_user_id
            OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
            OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason
          )
        THEN
          RAISE EXCEPTION 'FX rate rejection attribution is immutable.'
            USING ERRCODE = '23514';
        END IF;
        IF OLD.superseded_by_user_id IS NOT NULL
          AND (
            NEW.superseded_by_user_id IS DISTINCT FROM OLD.superseded_by_user_id
            OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
          )
        THEN
          RAISE EXCEPTION 'FX rate supersession attribution is immutable.'
            USING ERRCODE = '23514';
        END IF;
        IF OLD.deactivated_by_user_id IS NOT NULL
          AND (
            NEW.deactivated_by_user_id IS DISTINCT FROM OLD.deactivated_by_user_id
            OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
            OR NEW.deactivation_reason IS DISTINCT FROM OLD.deactivation_reason
          )
        THEN
          RAISE EXCEPTION 'FX rate deactivation attribution is immutable.'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $fx_rates_immutability$;

      CREATE TRIGGER fx_rates_immutability_trigger
        BEFORE UPDATE ON fx_rates
        FOR EACH ROW
        EXECUTE FUNCTION fx_rates_enforce_immutability();
    `);

    // ---------------------------------------------------------------------
    // 2. fx_rate_events — append-only platform-global rate audit ledger.
    //
    // No client_id by design: `operational_events.client_id` is NOT NULL
    // (0080) and a platform-global rate has no owning Client. Client-scoped
    // FX policy events continue to use `recordOperationalEvent` (§14.2);
    // that table is NOT weakened here.
    // ---------------------------------------------------------------------
    await client.query(`
      CREATE TABLE fx_rate_events (
        id             UUID PRIMARY KEY,
        fx_rate_id     UUID NOT NULL REFERENCES fx_rates (id),
        event_type     TEXT NOT NULL,
        actor_user_id  UUID REFERENCES users (id),
        request_id     TEXT,
        metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT fx_rate_events_event_type_check CHECK (
          event_type IN (
            'FX_RATE_CREATED',
            'FX_RATE_APPROVED',
            'FX_RATE_REJECTED',
            'FX_RATE_SUPERSEDED',
            'FX_RATE_DEACTIVATED'
          )
        ),
        CONSTRAINT fx_rate_events_metadata_object_check CHECK (
          jsonb_typeof(metadata) = 'object'
        )
      );

      CREATE INDEX fx_rate_events_rate_idx
        ON fx_rate_events (fx_rate_id, occurred_at DESC, id DESC);
      CREATE INDEX fx_rate_events_type_idx
        ON fx_rate_events (event_type, occurred_at DESC);
    `);

    // Append-only is enforced structurally, not by convention: an audit row
    // that could be edited or deleted would not be an audit.
    await client.query(`
      CREATE OR REPLACE FUNCTION fx_rate_events_append_only()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fx_rate_events_append_only$
      BEGIN
        RAISE EXCEPTION 'fx_rate_events is append-only; % is not permitted.', TG_OP
          USING ERRCODE = '23514';
      END;
      $fx_rate_events_append_only$;

      CREATE TRIGGER fx_rate_events_no_update
        BEFORE UPDATE ON fx_rate_events
        FOR EACH ROW
        EXECUTE FUNCTION fx_rate_events_append_only();

      CREATE TRIGGER fx_rate_events_no_delete
        BEFORE DELETE ON fx_rate_events
        FOR EACH ROW
        EXECUTE FUNCTION fx_rate_events_append_only();
    `);

    // ---------------------------------------------------------------------
    // 3. client_fx_policies — Client-scoped FX governance. Fail closed.
    // ---------------------------------------------------------------------
    await client.query(`
      CREATE TABLE client_fx_policies (
        client_id                UUID PRIMARY KEY REFERENCES clients (id),

        -- Fail closed by default: no policy row, or fx_enabled = false, means
        -- FX is unavailable for the Client even when a rate exists.
        fx_enabled               BOOLEAN NOT NULL DEFAULT FALSE,

        reporting_currency_code  VARCHAR(3) NOT NULL REFERENCES currencies (code),

        -- Subset of fx_rates.source. An empty array permits nothing.
        permitted_sources        TEXT[] NOT NULL,

        -- Governs the INVERSE path (§11). Default false = fail closed.
        inverse_permitted        BOOLEAN NOT NULL DEFAULT FALSE,

        -- NULL = no staleness bound beyond the effective window.
        max_staleness_days       SMALLINT,

        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        updated_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT client_fx_policies_max_staleness_check CHECK (
          max_staleness_days IS NULL OR max_staleness_days > 0
        ),
        CONSTRAINT client_fx_policies_permitted_sources_known_check CHECK (
          permitted_sources <@ ARRAY['MANUAL_TREASURY']::TEXT[]
        ),
        CONSTRAINT client_fx_policies_permitted_sources_no_null_check CHECK (
          array_position(permitted_sources, NULL) IS NULL
        )
      );
    `);

    // Reuses the exact shape of validate_client_monetary_context (0331):
    // deferred so the allowed-currency set and the policy may be written in
    // one transaction.
    await client.query(`
      CREATE OR REPLACE FUNCTION validate_client_fx_policy()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $client_fx_policy_valid$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM currencies
          WHERE code = NEW.reporting_currency_code AND status = 'ACTIVE'
        ) THEN
          RAISE EXCEPTION 'fx reporting currency must be an active currency';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM client_allowed_transaction_currencies
          WHERE client_id = NEW.client_id
            AND currency_code = NEW.reporting_currency_code
        ) THEN
          RAISE EXCEPTION 'fx reporting currency must be allowed for the client';
        END IF;

        -- FX-01 (§6): the reporting currency MUST equal the Client base
        -- currency. This single check also fails closed when the Client has no
        -- monetary context at all, so no second reporting axis can appear.
        IF NOT EXISTS (
          SELECT 1 FROM client_monetary_contexts
          WHERE client_id = NEW.client_id
            AND base_currency_code = NEW.reporting_currency_code
        ) THEN
          RAISE EXCEPTION 'fx reporting currency must equal the client base currency';
        END IF;

        RETURN NEW;
      END;
      $client_fx_policy_valid$;

      CREATE CONSTRAINT TRIGGER client_fx_policy_valid
        AFTER INSERT OR UPDATE ON client_fx_policies
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION validate_client_fx_policy();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS client_fx_policy_valid ON client_fx_policies;
      DROP FUNCTION IF EXISTS validate_client_fx_policy();
      DROP TABLE IF EXISTS client_fx_policies;

      DROP TRIGGER IF EXISTS fx_rate_events_no_delete ON fx_rate_events;
      DROP TRIGGER IF EXISTS fx_rate_events_no_update ON fx_rate_events;
      DROP FUNCTION IF EXISTS fx_rate_events_append_only();
      DROP TABLE IF EXISTS fx_rate_events;

      DROP TRIGGER IF EXISTS fx_rates_immutability_trigger ON fx_rates;
      DROP FUNCTION IF EXISTS fx_rates_enforce_immutability();
      -- Constraint, unique indexes and the btree_gist extension are dropped
      -- with the table; btree_gist is intentionally left installed because
      -- 0278 also depends on it.
      DROP TABLE IF EXISTS fx_rates;
    `);
  },
};
